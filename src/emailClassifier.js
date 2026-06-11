const { isLikelySupplierEmail } = require("./jobs/supplierEmailParser");
const { EMAIL_RE, PHONE_RE, hasPostcode, isLikelyCheckatradeEmail } = require("./parser");

const RECRUITMENT_KEYWORDS = [
  "cv",
  "curriculum vitae",
  "job application",
  "vacancy",
  "recruitment",
  "candidate",
  "available for work",
  "looking for work",
  "apprenticeship"
];

const SPAM_KEYWORDS = [
  "seo",
  "search engine optimisation",
  "marketing proposal",
  "crypto",
  "investment opportunity",
  "web design",
  "website redesign",
  "domain renewal",
  "newsletter"
];

const ADMIN_KEYWORDS = [
  "statement",
  "remittance",
  "receipt",
  "payment confirmation",
  "out of office",
  "auto reply",
  "automatic reply",
  "failed delivery",
  "mail delivery subsystem"
];

const CUSTOMER_LABEL_RE = /\b(customer|name|phone|telephone|mobile|postcode|address|message|enquiry|job details?)\s*[:\-]/i;
const JOB_RE = /\b(garage\s+door|roller\s+door|up\s+and\s+over|sectional|electric\s+door|manual\s+door|repair|spring|cable|stuck|insecure|quote|service|supply\s+and\s+fit|install|replacement)\b/i;

function classifyEmailMessage(message, config) {
  const text = messageText(message);
  const lower = text.toLowerCase();
  const subject = String(message.subject || "").toLowerCase();
  const sender = String(message.from || "").toLowerCase();

  if (isLikelySupplierEmail(message)) return { type: "supplier", reason: "supplier/order wording detected" };
  if (containsAny(lower, config.recruitmentKeywords || RECRUITMENT_KEYWORDS)) return { type: "recruitment", reason: "recruitment wording detected" };
  if (containsAny(lower, config.spamKeywords || SPAM_KEYWORDS)) return { type: "spam", reason: "spam/marketing wording detected" };
  if (containsAny(subject, config.adminEmailKeywords || ADMIN_KEYWORDS)) return { type: "admin", reason: "admin/system email wording detected" };

  const senderOk = !config.allowedSenders.length || config.allowedSenders.includes("*") || config.allowedSenders.some((allowed) => sender.includes(allowed));
  const subjectOk = config.subjectKeywords.some((keyword) => subject.includes(keyword));
  const bodyOk = config.bodyKeywords.some((keyword) => lower.includes(keyword));
  const checkatradeSender = sender.includes("checkatrade");
  const checkatradeHint = checkatradeSender || /\bcheckatrade\b/i.test(text);
  const hasJobEvidence = JOB_RE.test(text);
  const hasContactEvidence = hasRegex(PHONE_RE, text) || hasRegex(EMAIL_RE, String(message.body || "")) || hasPostcode(text) || CUSTOMER_LABEL_RE.test(text);

  if (checkatradeHint && (subjectOk || bodyOk || hasJobEvidence || hasContactEvidence)) {
    return { type: "enquiry", reason: "Checkatrade/customer enquiry evidence detected" };
  }
  if (senderOk && (subjectOk || bodyOk || isLikelyCheckatradeEmail(message, config)) && hasJobEvidence && hasContactEvidence) {
    return { type: "enquiry", reason: "customer enquiry evidence detected" };
  }

  return { type: "non_enquiry", reason: "not enough customer/job evidence" };
}

function messageText(message) {
  return [message.subject, message.from, message.body, message.htmlBody].filter(Boolean).join("\n");
}

function containsAny(text, keywords) {
  return (keywords || []).some((keyword) => keyword && text.includes(String(keyword).toLowerCase()));
}

function hasRegex(regex, text) {
  regex.lastIndex = 0;
  return regex.test(text);
}

module.exports = { classifyEmailMessage, RECRUITMENT_KEYWORDS, SPAM_KEYWORDS, ADMIN_KEYWORDS };
