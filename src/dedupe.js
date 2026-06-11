const crypto = require("node:crypto");
const { normalisePhone, normalisePostcode } = require("./parser");

function fingerprint(text) {
  return crypto
    .createHash("sha1")
    .update(String(text || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim())
    .digest("hex");
}

function similarity(a, b) {
  const wordsA = new Set(String(a || "").toLowerCase().split(/\W+/).filter((word) => word.length > 3));
  const wordsB = new Set(String(b || "").toLowerCase().split(/\W+/).filter((word) => word.length > 3));
  if (!wordsA.size || !wordsB.size) return 0;
  const overlap = [...wordsA].filter((word) => wordsB.has(word)).length;
  return overlap / Math.max(wordsA.size, wordsB.size);
}

function hoursBetween(a, b) {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 36e5;
}

function findDuplicate(lead, existingLeads) {
  for (const existing of existingLeads) {
    if (existing.status === "Archived" || existing.status === "Lost") continue;
    if (lead.originalMessageId && existing.originalMessageId === lead.originalMessageId) {
      return { existing, reason: "same source message ID" };
    }
    if (lead.customerEmail && existing.customerEmail && lead.customerEmail.toLowerCase() === existing.customerEmail.toLowerCase()) {
      if (hoursBetween(lead.receivedAt, existing.receivedAt) <= 72) return { existing, reason: "same email within 72 hours" };
    }
    if (lead.customerPhone && existing.customerPhone && normalisePhone(lead.customerPhone) === normalisePhone(existing.customerPhone)) {
      if (hoursBetween(lead.receivedAt, existing.receivedAt) <= 72) return { existing, reason: "same phone within 72 hours" };
    }
    if (lead.customerPostcode && existing.customerPostcode && normalisePostcode(lead.customerPostcode) === normalisePostcode(existing.customerPostcode)) {
      if (similarity(lead.jobDescription, existing.jobDescription) >= 0.55 && hoursBetween(lead.receivedAt, existing.receivedAt) <= 168) {
        return { existing, reason: "same postcode and similar job description" };
      }
    }
  }
  return null;
}

module.exports = { findDuplicate, similarity, fingerprint };
