const { POSTCODE_RE, normalisePostcode } = require("../parser");
const { ensureJobFields, applyJobAction } = require("./jobStageEngine");

const SUPPLIER_KEYWORDS = [
  "order confirmation",
  "sales order",
  "purchase order",
  "pro forma",
  "invoice",
  "estimated delivery",
  "lead time",
  "delivery date",
  "dispatch",
  "manufactured",
  "ready for delivery",
  "ready to deliver",
  "out for delivery",
  "delivered",
  "delayed",
  "back order"
];

function isLikelySupplierEmail(message) {
  const text = messageText(message).toLowerCase();
  return SUPPLIER_KEYWORDS.some((keyword) => text.includes(keyword));
}

function parseSupplierEmail(message, now = new Date()) {
  const text = messageText(message);
  const leadTime = parseLeadTime(text, now);
  const exactDelivery = extractDeliveryDate(text, now);
  const orderReference = extractOrderReference(text);
  const supplierEmail = extractEmail(message.from) || extractEmail(text);
  const supplierName = extractSupplierName(message.from) || extractLabelledValue(text, ["Supplier", "From"]) || "";
  const deliveryStatus = detectDeliveryStatus(text);
  const postcode = normalisePostcode((text.match(POSTCODE_RE) || [""])[0]);
  const attachments = (message.attachments || []).map((attachment) => attachment.filename || attachment.name).filter(Boolean);
  const expectedDate = exactDelivery || leadTime.end || "";

  return {
    emailMessageId: message.id,
    supplierName,
    supplierEmail,
    subject: message.subject || "",
    receivedAt: message.receivedAt || new Date().toISOString(),
    extractedOrderReference: orderReference,
    extractedLeadTime: leadTime.text,
    extractedDeliveryDate: exactDelivery,
    extractedDeliveryStart: leadTime.start,
    extractedDeliveryEnd: leadTime.end,
    extractedPostcode: postcode,
    productDoorType: extractDoorType(text),
    colourFinish: extractColour(text),
    deliveryStatus,
    delayReason: deliveryStatus === "Delayed" ? sentenceContaining(text, /delayed|back order|backorder/i) : "",
    attachmentFilenames: attachments,
    confidenceScore: supplierConfidence({ orderReference, exactDelivery, leadTime, deliveryStatus }),
    rawSummary: buildSummary({ text, orderReference, exactDelivery, leadTime, deliveryStatus, attachments, supplierName }),
    supplier_delivery_confidence: exactDelivery ? "exact" : leadTime.text ? "estimated" : ""
  };
}

function matchSupplierEmailToLead(parsed, leads) {
  let best = { lead: null, confidence: 0, reason: "" };
  for (const lead of leads || []) {
    ensureJobFields(lead);
    let score = 0;
    const reasons = [];
    if (parsed.extractedOrderReference && lead.supplier_order_reference && sameRef(parsed.extractedOrderReference, lead.supplier_order_reference)) {
      score += 70;
      reasons.push("order reference");
    }
    const surname = String(lead.customerName || "").trim().split(/\s+/).slice(-1)[0];
    if (surname && new RegExp(`\\b${escapeRegex(surname)}\\b`, "i").test(parsed.rawSummary || parsed.subject || "")) {
      score += 20;
      reasons.push("customer surname");
    }
    if (parsed.extractedPostcode && lead.customerPostcode && parsed.extractedPostcode === normalisePostcode(lead.customerPostcode)) {
      score += 20;
      reasons.push("postcode");
    }
    if (parsed.productDoorType && String(lead.garageDoorType || lead.jobDescription || "").toLowerCase().includes(parsed.productDoorType)) {
      score += 10;
      reasons.push("door type");
    }
    if (lead.quote_reference && parsed.rawSummary && parsed.rawSummary.includes(lead.quote_reference)) {
      score += 20;
      reasons.push("quote reference");
    }
    if (lead.supplier_order_placed_at && !lead.supplier_confirmation_received_at) {
      score += 10;
      reasons.push("recent supplier order");
    }
    if (score > best.confidence) best = { lead, confidence: Math.min(score, 100), reason: reasons.join(", ") };
  }
  return {
    lead: best.lead,
    confidence: best.confidence,
    reason: best.reason,
    reviewStatus: best.confidence >= 70 ? "Linked" : "Needs review"
  };
}

function processSupplierMessage(message, { store, now = new Date() }) {
  const parsed = parseSupplierEmail(message, now);
  const match = matchSupplierEmailToLead(parsed, store.state.leads || []);
  const record = {
    ...parsed,
    matchedLeadId: match.lead ? match.lead.id : "",
    matchConfidence: match.confidence,
    matchReason: match.reason,
    reviewStatus: match.reviewStatus
  };

  if (match.lead && match.confidence >= 70) {
    const patch = {
      supplier_confirmation_received_at: parsed.receivedAt.slice(0, 10),
      supplier_name: parsed.supplierName || match.lead.supplier_name,
      supplier_order_reference: parsed.extractedOrderReference || match.lead.supplier_order_reference,
      supplier_estimated_delivery_date: parsed.extractedDeliveryDate || match.lead.supplier_estimated_delivery_date,
      supplier_estimated_delivery_start: parsed.extractedDeliveryStart || match.lead.supplier_estimated_delivery_start,
      supplier_estimated_delivery_end: parsed.extractedDeliveryEnd || match.lead.supplier_estimated_delivery_end,
      supplier_lead_time_text: parsed.extractedLeadTime || match.lead.supplier_lead_time_text,
      supplier_delivery_status: parsed.deliveryStatus || "Confirmed",
      supplier_delivery_confidence: parsed.supplier_delivery_confidence || match.lead.supplier_delivery_confidence
    };
    Object.assign(match.lead, patch);
    if (parsed.deliveryStatus === "Delivered") {
      applyJobAction(match.lead, "mark_delivered", { supplier_actual_delivery_date: parsed.extractedDeliveryDate || parsed.receivedAt.slice(0, 10) }, now);
    } else {
      ensureJobFields(match.lead, now);
    }
    store.addJobEvent({
      leadId: match.lead.id,
      eventType: "supplier_email_linked",
      eventNote: `Supplier email linked: ${parsed.subject}`,
      sourceEmailId: message.id
    });
  }

  store.addSupplierEmail(record);
  return record;
}

function parseLeadTime(text, now = new Date()) {
  const range = text.match(/\b(?:approx(?:imately)?\.?\s*)?(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s*(working\s+days?|weeks?)\b/i);
  if (range) {
    const min = Number.parseInt(range[1], 10);
    const max = Number.parseInt(range[2], 10);
    const unit = range[3].toLowerCase();
    return {
      text: range[0],
      start: addTime(now, min, unit),
      end: addTime(now, max, unit)
    };
  }
  const single = text.match(/\b(?:approx(?:imately)?\.?\s*)?(\d{1,2})\s*(working\s+days?|weeks?)\b/i);
  if (single) {
    const amount = Number.parseInt(single[1], 10);
    const unit = single[2].toLowerCase();
    return { text: single[0], start: addTime(now, amount, unit), end: addTime(now, amount, unit) };
  }
  const weekCommencing = text.match(/\bweek commencing\s+(\d{1,2}(?:st|nd|rd|th)?\s+[A-Z][a-z]+(?:\s+\d{4})?)/i);
  if (weekCommencing) {
    const start = parseHumanDate(weekCommencing[1], now);
    return { text: weekCommencing[0], start, end: start ? addDays(start, 4) : "" };
  }
  return { text: "", start: "", end: "" };
}

function extractDeliveryDate(text, now = new Date()) {
  const labelled = text.match(/\b(?:delivery|delivered|dispatch|expected|due)(?:\s+\w+){0,4}\s+(?:on|date|by|for)?\s*:?\s*(\d{1,2}(?:st|nd|rd|th)?\s+[A-Z][a-z]+(?:\s+\d{4})?|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i);
  if (labelled) return parseHumanDate(labelled[1], now);
  return "";
}

function extractOrderReference(text) {
  const specific = text.match(/\b(?:SO|PO|INV|ORD|ADY)[-\s]?\d{2,}\b/i);
  if (specific) return specific[0].replace(/\s+/g, "-").toUpperCase();
  const match = text.match(/\b(?:sales\s+order|purchase\s+order|order|po|pro\s*forma|invoice)\s*(?:ref(?:erence)?|no\.?|number|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{2,})\b/i);
  if (!match) return "";
  const value = match[1].toUpperCase();
  return ["CONFIRMATION", "CONFIRMED", "UPDATE", "DELAYED", "DELIVERED"].includes(value) ? "" : value;
}

function detectDeliveryStatus(text) {
  if (/\b(delayed|back order|backorder)\b/i.test(text)) return "Delayed";
  if (/\bout for delivery\b/i.test(text)) return "Out for delivery";
  if (/\b(delivered|arrived)\b/i.test(text)) return "Delivered";
  if (/\bready for delivery|ready to deliver|manufactured|dispatch(?:ed)?\b/i.test(text)) return "Ready for delivery";
  if (/\border confirmation|sales order|purchase order|confirmed\b/i.test(text)) return "Confirmed";
  return "";
}

function supplierConfidence({ orderReference, exactDelivery, leadTime, deliveryStatus }) {
  let score = 30;
  if (orderReference) score += 25;
  if (exactDelivery) score += 20;
  if (leadTime.text) score += 15;
  if (deliveryStatus) score += 10;
  return Math.min(score, 100);
}

function addTime(now, amount, unit) {
  if (unit.includes("week")) return addDays(now, amount * 7);
  if (unit.includes("working")) return addWorkingDays(now, amount);
  return addDays(now, amount);
}

function addDays(date, amount) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result.toISOString().slice(0, 10);
}

function addWorkingDays(date, amount) {
  const result = new Date(date);
  let remaining = amount;
  while (remaining > 0) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return result.toISOString().slice(0, 10);
}

function parseHumanDate(value, now = new Date()) {
  const cleaned = String(value || "").replace(/\b(st|nd|rd|th)\b/gi, "");
  const parts = cleaned.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (parts) {
    const year = parts[3].length === 2 ? `20${parts[3]}` : parts[3];
    return `${year}-${parts[2].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
  }
  const named = cleaned.match(/^(\d{1,2})\s+([A-Z][a-z]+)(?:\s+(\d{4}))?$/i);
  if (named) {
    const monthIndex = monthNumber(named[2]);
    if (monthIndex) {
      const year = named[3] || String(now.getFullYear());
      return `${year}-${String(monthIndex).padStart(2, "0")}-${named[1].padStart(2, "0")}`;
    }
  }
  const date = new Date(cleaned.includes(String(now.getFullYear())) ? cleaned : `${cleaned} ${now.getFullYear()}`);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function monthNumber(value) {
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const lower = String(value || "").toLowerCase();
  const index = months.findIndex((month) => month.startsWith(lower.slice(0, 3)));
  return index === -1 ? 0 : index + 1;
}

function buildSummary({ text, orderReference, exactDelivery, leadTime, deliveryStatus, attachments, supplierName }) {
  return [
    supplierName ? `Supplier: ${supplierName}` : "",
    orderReference ? `Order reference: ${orderReference}` : "",
    exactDelivery ? `Delivery date: ${exactDelivery}` : "",
    leadTime.text ? `Lead time: ${leadTime.text}` : "",
    deliveryStatus ? `Status: ${deliveryStatus}` : "",
    attachments.length ? `Attachments: ${attachments.join(", ")}` : "",
    sentenceContaining(text, /order confirmation|sales order|estimated delivery|lead time|delivered|delayed|back order/i)
  ]
    .filter(Boolean)
    .join(" | ")
    .slice(0, 800);
}

function sentenceContaining(text, regex) {
  return (
    String(text || "")
      .split(/(?<=[.!?])\s+|\r?\n/)
      .find((sentence) => regex.test(sentence)) || ""
  ).trim();
}

function extractLabelledValue(text, labels) {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const regex = new RegExp(`(?:^|\\n)\\s*(?:${escaped})\\s*[:\\-]\\s*(.+)`, "i");
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

function extractDoorType(text) {
  const match = text.match(/\b(roller|sectional|up[\s-]?and[\s-]?over|steel security|shutter|electric)\b/i);
  return match ? match[1].toLowerCase().replace(/\s+/g, " ") : "";
}

function extractColour(text) {
  const match = text.match(/\b(?:colour|color|finish)\s*[:#-]?\s*([A-Za-z0-9 /-]{3,40})/i);
  return match ? match[1].trim() : "";
}

function extractEmail(text) {
  const match = String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : "";
}

function extractSupplierName(from) {
  const cleaned = String(from || "").replace(/<[^>]+>/g, "").replace(/["']/g, "").trim();
  return cleaned.includes("@") ? "" : cleaned;
}

function sameRef(left, right) {
  return String(left || "").replace(/[^A-Z0-9]/gi, "").toUpperCase() === String(right || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function messageText(message) {
  return `${message.subject || ""}\n${message.from || ""}\n${message.body || ""}\n${message.text || ""}\n${message.html || ""}`;
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  SUPPLIER_KEYWORDS,
  isLikelySupplierEmail,
  parseSupplierEmail,
  parseLeadTime,
  matchSupplierEmailToLead,
  processSupplierMessage
};
