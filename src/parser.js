const crypto = require("node:crypto");

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?:\+44\s?|0)(?:\d[\s-]?){9,10}\d/g;
const POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/gi;
const ADDRESS_LINE_RE = /\b\d{1,5}\s+[A-Z0-9][A-Z0-9\s,'-]{4,}\b/i;

const JOB_PATTERNS = [
  ["emergency", /\b(emergency|urgent|insecure|stuck open|stuck shut|cannot close|can't close|cannot open|can't open)\b/i],
  ["repair", /\b(repair|broken|fault|stuck|spring|springs|cable|cables|snapped cable|cones|drums|forced down|door dropped|remote|motor|track|roller jammed|not working)\b/i],
  ["install", /\b(install|installation|new door|replacement|replace|supply and fit|quote for a new)\b/i],
  ["service", /\b(service|maintenance|annual service|servicing)\b/i]
];

const DOOR_TYPE_PATTERNS = [
  ["roller", /\broller\b/i],
  ["up-and-over", /\b(up[\s-]?and[\s-]?over|up & over)\b/i],
  ["sectional", /\bsectional\b/i],
  ["electric", /\b(electric|remote|motorised|automated|automatic)\b/i],
  ["manual", /\bmanual\b/i]
];

function firstMatch(regex, text) {
  const match = text.match(regex);
  return match ? match[0].trim() : "";
}

function normalisePhone(phone) {
  return String(phone || "").replace(/[^\d+]/g, "");
}

function normalisePostcode(postcode) {
  return String(postcode || "").toUpperCase().replace(/\s+/g, "");
}

function postcodeOutward(postcode) {
  const normalised = normalisePostcode(postcode);
  const match = normalised.match(/^([A-Z]{1,2})/);
  return match ? match[1] : "";
}

function extractLabelledValue(text, labels) {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const regex = new RegExp(`(?:^|\\n)\\s*(?:${escaped})\\s*[:\\-]\\s*(.+)`, "i");
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

function extractAddress(text) {
  const explicit =
    extractLabelledValue(text, ["Customer address", "Full address", "Address", "Property address", "Job address", "Installation address", "Site address"]) ||
    [
      extractLabelledValue(text, ["Address line 1", "Address 1"]),
      extractLabelledValue(text, ["Address line 2", "Address 2"]),
      extractLabelledValue(text, ["Town", "City", "Area", "Location"]),
      extractLabelledValue(text, ["Postcode"])
    ]
      .filter(Boolean)
      .join(", ");
  if (explicit) return explicit;
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const candidate = lines.find((line) => ADDRESS_LINE_RE.test(line) && hasPostcode(line));
  return candidate || "";
}

function royalMailPostcodeFinderUrl(postcode) {
  const query = String(postcode || "").trim();
  return query ? `https://www.royalmail.com/find-a-postcode?postcode=${encodeURIComponent(query)}` : "https://www.royalmail.com/find-a-postcode";
}

function hasPostcode(text) {
  POSTCODE_RE.lastIndex = 0;
  return POSTCODE_RE.test(text);
}

function detectJobCategory(text) {
  for (const [category, regex] of JOB_PATTERNS) {
    if (regex.test(text)) return category;
  }
  return "";
}

function detectDoorTypes(text) {
  return DOOR_TYPE_PATTERNS.filter(([, regex]) => regex.test(text)).map(([type]) => type);
}

function containsPhotoRequestNeed(text) {
  return /\b(photo|photos|picture|video|image)\b/i.test(text);
}

function detectTiming(text) {
  const timing = firstMatch(/\b(today|tomorrow|as soon as possible|asap|this week|next week|Friday|Saturday|morning|afternoon|evening)\b/i, text);
  return timing;
}

function generateLeadId(sourceMessageId, body) {
  const hash = crypto.createHash("sha256").update(`${sourceMessageId}:${body}`).digest("hex").slice(0, 10).toUpperCase();
  return `LEAD-${hash}`;
}

function isLikelyCheckatradeEmail(message, config) {
  const sender = String(message.from || "").toLowerCase();
  const subject = String(message.subject || "").toLowerCase();
  const body = String(message.body || "").toLowerCase();
  const senderOk = !config.allowedSenders.length || config.allowedSenders.includes("*") || config.allowedSenders.some((allowed) => sender.includes(allowed));
  const subjectOk = config.subjectKeywords.some((keyword) => subject.includes(keyword));
  const bodyOk = config.bodyKeywords.some((keyword) => body.includes(keyword));
  return senderOk && (subjectOk || bodyOk);
}

function parseEnquiryEmail(message, config) {
  const body = message.body || "";
  const combined = `${message.subject || ""}\n${body}`;
  const customerEmail = firstMatch(EMAIL_RE, body) || firstMatch(EMAIL_RE, message.from || "");
  const customerPhone = normalisePhone(firstMatch(PHONE_RE, body));
  const labelledPostcode = extractLabelledValue(body, ["Postcode", "Customer postcode"]);
  const postcode = normalisePostcode(labelledPostcode || firstMatch(POSTCODE_RE, body));
  const customerAddress = extractAddress(body);
  const name =
    extractLabelledValue(body, ["Customer name", "Name", "Customer"]) ||
    extractLabelledValue(body, ["From"]).replace(EMAIL_RE, "").trim();
  const jobDescription =
    extractLabelledValue(body, ["Message", "Enquiry", "Description", "Job details", "Details"]) ||
    body.split(/\r?\n/).filter((line) => line.trim()).slice(-3).join(" ").slice(0, 600);
  const doorTypes = detectDoorTypes(combined);
  const category = detectJobCategory(combined);
  const missing = [];
  if (!name) missing.push("customer name");
  if (!customerEmail) missing.push("customer email");
  if (!customerPhone) missing.push("customer phone");
  if (!postcode) missing.push("postcode");
  if (!customerAddress) missing.push("full address");
  if (!doorTypes.length) missing.push("door type/manual or electric");
  if (!jobDescription) missing.push("job description");

  const filled = [name, customerEmail, customerPhone, customerAddress, postcode, jobDescription, category, doorTypes.length ? "yes" : ""].filter(Boolean).length;
  const confidence = Math.round((filled / 8) * 100);
  const receivedAt = message.receivedAt || new Date().toISOString();

  return {
    id: generateLeadId(message.id, body),
    receivedAt,
    sourcePlatform: message.sourcePlatform || "Email enquiry",
    originalMessageId: message.id,
    customerName: name,
    customerEmail,
    customerPhone,
    customerPostcode: postcode,
    customerAddress,
    addressVerificationStatus: customerAddress ? "Needs Royal Mail check" : "Address needed",
    addressVerificationUrl: royalMailPostcodeFinderUrl(postcode || customerAddress),
    customerTownArea: extractLabelledValue(body, ["Town", "Area", "Location"]),
    jobType: category,
    jobDescription,
    garageDoorType: doorTypes.join(", "),
    garageDoorIssue: category || extractLabelledValue(body, ["Issue", "Problem"]),
    mechanism: doorTypes.filter((type) => ["manual", "electric", "roller", "up-and-over", "sectional"].includes(type)).join(", "),
    category,
    urgency: category === "emergency" ? "Urgent" : /urgent|asap|today|insecure|stuck/i.test(combined) ? "High" : "Normal",
    preferredTiming: detectTiming(combined),
    photosVideoRequested: message.hasAttachments || containsPhotoRequestNeed(combined) ? "yes" : "no",
    quoteDay: config.quoteDay,
    status: "New",
    nextAction: "",
    followUpDate: "",
    assignedPerson: config.assignedPerson,
    draftReplyCreated: "no",
    draftEmailIdLink: "",
    draftReply: "",
    notes: "",
    extractionConfidence: confidence,
    missingInformationChecklist: missing.join(", "),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

module.exports = {
  parseEnquiryEmail,
  isLikelyCheckatradeEmail,
  normalisePhone,
  normalisePostcode,
  postcodeOutward,
  extractAddress,
  royalMailPostcodeFinderUrl,
  hasPostcode,
  detectJobCategory,
  detectDoorTypes,
  EMAIL_RE,
  PHONE_RE,
  POSTCODE_RE
};
