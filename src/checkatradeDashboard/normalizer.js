const { parseEnquiryEmail } = require("../parser");

function normaliseDashboardLead(raw, config) {
  const body = [
    `Customer name: ${raw.customerName || ""}`,
    `Customer email: ${raw.customerEmail || ""}`,
    `Customer phone: ${raw.customerPhone || ""}`,
    `Customer address: ${raw.customerAddress || raw.address || ""}`,
    `Postcode: ${raw.postcode || raw.location || ""}`,
    `Town: ${raw.location || ""}`,
    `Message: ${[raw.jobDescription, raw.jobCategory ? `Category: ${raw.jobCategory}` : ""].filter(Boolean).join("\n")}`
  ].join("\n");

  const message = {
    id: raw.checkatradeId || raw.id || `checkatrade-dashboard:${raw.dashboardUrl || Date.now()}`,
    from: "authorised-checkatrade-dashboard",
    subject: "Authorised Checkatrade dashboard enquiry",
    receivedAt: normaliseDate(raw.receivedAt),
    body,
    sourcePlatform: "Checkatrade Dashboard"
  };

  const lead = parseEnquiryEmail(message, config);
  lead.sourcePlatform = "Checkatrade Dashboard";
  lead.originalMessageId = message.id;
  lead.checkatradeEnquiryId = raw.checkatradeId || "";
  lead.dashboardUrl = raw.dashboardUrl || "";
  lead.replyStatus = raw.replyStatus || "";
  if (raw.urgency && /urgent|high|asap|insecure/i.test(raw.urgency)) lead.urgency = "Urgent";
  if (raw.jobCategory && !lead.jobType) lead.jobType = raw.jobCategory;
  return lead;
}

function normaliseDate(value) {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return new Date().toISOString();
}

module.exports = { normaliseDashboardLead, normaliseDate };
