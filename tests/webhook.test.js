const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const {
  startWebhookServer,
  verifySignature,
  verifyWebhookRequest,
  allowedIpsForConfig,
  normaliseIp,
  payloadToMessage
} = require("../src/checkatradeWebhook/server");

test("verifies HMAC webhook signature", () => {
  const body = Buffer.from('{"lead_id":"123"}');
  const secret = "test-secret";
  const hexSignature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const base64Signature = crypto.createHmac("sha256", secret).update(body).digest("base64");
  assert.equal(verifySignature(body, hexSignature, secret), true);
  assert.equal(verifySignature(body, base64Signature, secret), true);
  assert.equal(verifySignature(body, "bad-signature", secret), false);
});

test("converts authorised webhook payload to a message", () => {
  const message = payloadToMessage({
    lead_id: "lead-123",
    customer_name: "Sam",
    customer_email: "sam@example.com",
    postcode: "YO1 1AA",
    job_description: "New roller door"
  });
  assert.equal(message.id, "lead-123");
  assert.match(message.body, /New roller door/);
});

test("converts nested webhook payload fields to a message", () => {
  const message = payloadToMessage({
    lead: { id: "nested-lead-1" },
    customer: { firstName: "Priya", lastName: "Patel", email: "priya@example.com", phone: "07700900444" },
    job: { postcode: "HD1 2AB", description: "Electric roller door will not close", category: "Garage doors" },
    location: { town: "Huddersfield" }
  });
  assert.equal(message.id, "nested-lead-1");
  assert.match(message.body, /Priya Patel/);
  assert.match(message.body, /HD1 2AB/);
  assert.match(message.body, /Electric roller door/);
});

test("normalises IPv4-mapped IPv6 addresses", () => {
  assert.equal(normaliseIp("::ffff:34.105.162.121"), "34.105.162.121");
});

test("uses Checkatrade development allowlist by default", () => {
  const config = {
    checkatradeWebhookEnvironment: "development",
    checkatradeAllowedIps: [],
    checkatradeAllowedIpsDevelopment: ["34.105.162.121"],
    checkatradeAllowedIpsProduction: ["35.246.15.126"]
  };
  assert.deepEqual(allowedIpsForConfig(config), ["34.105.162.121"]);
});

test("verifies webhook source IP when using IP allowlist security", () => {
  const req = {
    headers: {},
    socket: { remoteAddress: "::ffff:34.105.162.121" }
  };
  const result = verifyWebhookRequest(req, Buffer.from("{}"), {
    webhookSecurityMode: "ip_allowlist",
    webhookTrustProxy: false,
    checkatradeWebhookEnvironment: "development",
    checkatradeAllowedIps: [],
    checkatradeAllowedIpsDevelopment: ["34.105.162.121"],
    checkatradeAllowedIpsProduction: []
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "ip_allowlist");
});

test("serves Render health check without webhook auth", async () => {
  const logger = { warn() {}, error() {} };
  const server = startWebhookServer({
    config: {
      webhookPort: 0,
      webhookSecurityMode: "ip_allowlist",
      checkatradeWebhookEnvironment: "development"
    },
    store: { state: { leads: [], logs: [] } },
    logger
  });

  try {
    const { port } = server.address();
    const body = await new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/health`, (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            if (res.statusCode !== 200) reject(new Error(`Unexpected status ${res.statusCode}`));
            else resolve(data);
          });
        })
        .on("error", reject);
    });
    const parsed = JSON.parse(body);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.service, "checkatrade-enquiry-manager");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
