const crypto = require("node:crypto");
const http = require("node:http");
const { parseEnquiryEmail } = require("../parser");
const { scoreLead } = require("../leadScoring");
const { findDuplicate } = require("../dedupe");
const { generateDraftReply } = require("../draftGenerator");
const { writeTrackerWorkbook } = require("../sheetProvider/excel");

function normaliseIp(ip) {
  return String(ip || "")
    .split(",")[0]
    .trim()
    .replace(/^::ffff:/, "");
}

function verifySignature(rawBody, signature, secret) {
  if (!secret) return false;
  const received = String(signature || "").replace(/^sha256=/, "");
  const expectedHex = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBase64 = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  return timingSafeStringEqual(received, expectedHex) || timingSafeStringEqual(received, expectedBase64);
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || "").padEnd(right.length, " ")).subarray(0, right.length);
  const rightBuffer = Buffer.from(right);
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function allowedIpsForConfig(config) {
  if (config.checkatradeAllowedIps && config.checkatradeAllowedIps.length) return config.checkatradeAllowedIps;
  if (config.checkatradeWebhookEnvironment === "production") return config.checkatradeAllowedIpsProduction || [];
  return config.checkatradeAllowedIpsDevelopment || [];
}

function requestIp(req, config) {
  if (config.webhookTrustProxy && req.headers["x-forwarded-for"]) {
    return normaliseIp(req.headers["x-forwarded-for"]);
  }
  return normaliseIp(req.socket.remoteAddress);
}

function verifyIpAllowlist(req, config) {
  const sourceIp = requestIp(req, config);
  const allowedIps = allowedIpsForConfig(config).map(normaliseIp);
  return { ok: allowedIps.includes(sourceIp), sourceIp, allowedIps };
}

function verifyWebhookRequest(req, rawBody, config) {
  if (config.webhookSecurityMode === "hmac") {
    const signature = req.headers[config.webhookSignatureHeader];
    return { ok: verifySignature(rawBody, signature, config.webhookSecret), mode: "hmac" };
  }
  if (config.webhookSecurityMode === "none") {
    return { ok: true, mode: "none" };
  }
  return { ...verifyIpAllowlist(req, config), mode: "ip_allowlist" };
}

function valueAt(source, path) {
  return path.split(".").reduce((current, key) => (current && current[key] !== undefined ? current[key] : undefined), source);
}

function firstValue(payload, paths) {
  for (const path of paths) {
    const value = valueAt(payload, path);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function customerName(payload) {
  const direct = firstValue(payload, ["customer_name", "customerName", "customer.name", "contact.name", "data.customer.name"]);
  if (direct) return direct;
  const first = firstValue(payload, ["firstName", "first_name", "customer.firstName", "customer.first_name", "data.customer.firstName"]);
  const last = firstValue(payload, ["lastName", "last_name", "customer.lastName", "customer.last_name", "data.customer.lastName"]);
  return [first, last].filter(Boolean).join(" ");
}

function payloadToMessage(payload) {
  const description = firstValue(payload, [
    "message",
    "job_description",
    "jobDescription",
    "description",
    "job.description",
    "lead.description",
    "data.description",
    "data.job.description"
  ]);
  const category = firstValue(payload, ["category", "job.category", "data.category", "tradeCategory"]);
  return {
    id: firstValue(payload, ["lead_id", "leadId", "id", "lead.id", "data.lead_id", "data.id"]) || `webhook:${Date.now()}`,
    from: "official-checkatrade-webhook",
    subject: "Authorised Checkatrade webhook lead",
    receivedAt: firstValue(payload, ["received_at", "receivedAt", "created_at", "createdAt", "data.received_at", "data.createdAt"]) || new Date().toISOString(),
    body: [
      `Customer name: ${customerName(payload)}`,
      `Customer email: ${firstValue(payload, ["customer_email", "customerEmail", "email", "customer.email", "contact.email", "data.customer.email"])}`,
      `Customer phone: ${firstValue(payload, ["customer_phone", "customerPhone", "phone", "telephone", "customer.phone", "contact.phone", "data.customer.phone"])}`,
      `Customer address: ${firstValue(payload, ["address", "customer_address", "customerAddress", "fullAddress", "customer.address", "contact.address", "job.address", "location.address", "data.address"])}`,
      `Postcode: ${firstValue(payload, ["postcode", "postCode", "address.postcode", "customer.postcode", "job.postcode", "location.postcode", "data.postcode"])}`,
      `Town: ${firstValue(payload, ["town", "area", "city", "address.city", "customer.town", "location.town", "data.town"])}`,
      `Message: ${[description, category ? `Category: ${category}` : ""].filter(Boolean).join("\n")}`
    ].join("\n")
  };
}

async function handleWebhookPayload(payload, { config, store }) {
  const message = payloadToMessage(payload);
  const lead = parseEnquiryEmail(message, config);
  const duplicate = findDuplicate(lead, store.state.leads);
  if (duplicate) {
    const duplicateScored = scoreLead(lead, config);
    lead.status = "Duplicate";
    lead.notes = `Webhook duplicate of ${duplicate.existing.id}: ${duplicate.reason}`;
    lead.priorityScore = 0;
    lead.priorityLabel = "Low";
    lead.postcodePriorityBand = duplicateScored.postcodePriorityBand;
  } else {
    Object.assign(lead, scoreLead(lead, config));
    const draft = generateDraftReply(lead, config);
    lead.status = "Awaiting approval";
    lead.nextAction = "Review draft reply";
    lead.followUpDate = "";
    lead.draftReplyCreated = "yes";
    lead.draftEmailIdLink = "Stored in tracker for review";
    lead.draftSubject = draft.subject;
    lead.draftReply = draft.body;
  }
  store.addLead(lead);
  store.markProcessed(message.id);
  store.addLog("info", "Authorised webhook lead processed", { leadId: lead.id, status: lead.status });
  await store.save();
  writeTrackerWorkbook(config.trackerXlsxPath, store.state, config);
  return lead;
}

function startWebhookServer({ config, store, logger }) {
  if (config.webhookSecurityMode === "hmac" && !config.webhookSecret) {
    throw new Error("CHECKATRADE_WEBHOOK_SECRET must be set before starting the webhook server.");
  }
  if (config.webhookSecurityMode === "none") {
    logger.warn("Webhook security mode is none. Use this only for local manual testing, never for a live Checkatrade portal webhook.");
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "HEAD") {
        res.end();
      } else {
        res.end(
          JSON.stringify({
            ok: true,
            service: "checkatrade-enquiry-manager",
            securityMode: config.webhookSecurityMode,
            checkatradeWebhookEnvironment: config.checkatradeWebhookEnvironment,
            timestamp: new Date().toISOString()
          })
        );
      }
      return;
    }

    if (req.method !== "POST" || url.pathname !== "/webhooks/checkatrade") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const rawBody = Buffer.concat(chunks);
      const verification = verifyWebhookRequest(req, rawBody, config);
      if (!verification.ok) {
        logger.warn("Rejected Checkatrade webhook request", {
          mode: verification.mode,
          sourceIp: verification.sourceIp || "",
          allowedIps: verification.allowedIps ? verification.allowedIps.join(",") : ""
        });
        res.writeHead(401);
        res.end("Webhook request not authorised");
        return;
      }
      try {
        const payload = JSON.parse(rawBody.toString("utf8"));
        const lead = await handleWebhookPayload(payload, { config, store });
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ accepted: true, leadId: lead.id, status: lead.status }));
      } catch (error) {
        logger.error("Webhook processing failed", { error: error.message });
        res.writeHead(400);
        res.end("Invalid payload");
      }
    });
  });

  const listenHost = config.webhookPort === 0 ? undefined : "0.0.0.0";
  server.listen(config.webhookPort, listenHost, () => {
    console.log(`Authorised Checkatrade webhook endpoint listening on http://localhost:${config.webhookPort}/webhooks/checkatrade`);
  });
  return server;
}

module.exports = {
  startWebhookServer,
  verifySignature,
  timingSafeStringEqual,
  verifyWebhookRequest,
  verifyIpAllowlist,
  allowedIpsForConfig,
  normaliseIp,
  firstValue,
  handleWebhookPayload,
  payloadToMessage
};
