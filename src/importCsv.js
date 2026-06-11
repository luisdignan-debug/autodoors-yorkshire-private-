const fs = require("node:fs");
const { parseEnquiryEmail } = require("./parser");
const { scoreLead } = require("./leadScoring");
const { findDuplicate } = require("./dedupe");
const { generateDraftReply } = require("./draftGenerator");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function rowObjects(rows) {
  const headers = rows[0].map((header) => header.trim().toLowerCase());
  return rows.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] || ""])));
}

function csvRowToMessage(row, index) {
  const body = [
    `Customer name: ${row.name || row["customer name"] || ""}`,
    `Customer email: ${row.email || row["customer email"] || ""}`,
    `Customer phone: ${row.phone || row["customer phone"] || ""}`,
    `Customer address: ${row.address || row["customer address"] || row["full address"] || ""}`,
    `Postcode: ${row.postcode || row["customer postcode"] || ""}`,
    `Town: ${row.town || row.area || ""}`,
    `Message: ${row.message || row.description || row["job description"] || ""}`
  ].join("\n");
  return {
    id: row["message id"] || row["lead id"] || `manual-csv:${index}`,
    from: "manual-import",
    subject: "Manual Checkatrade lead import",
    receivedAt: row.date || row["date/time received"] || new Date().toISOString(),
    body
  };
}

async function importCsvLeads(filePath, { config, store }) {
  const rows = parseCsv(fs.readFileSync(filePath, "utf8"));
  if (rows.length < 2) return { imported: 0, duplicates: 0 };
  let imported = 0;
  let duplicates = 0;
  for (const [index, row] of rowObjects(rows).entries()) {
    const message = csvRowToMessage(row, index + 1);
    const lead = parseEnquiryEmail(message, config);
    const duplicate = findDuplicate(lead, store.state.leads);
    if (duplicate) {
      const duplicateScored = scoreLead(lead, config);
      lead.status = "Duplicate";
      lead.notes = `Manual import duplicate of ${duplicate.existing.id}: ${duplicate.reason}`;
      lead.priorityScore = 0;
      lead.priorityLabel = "Low";
      lead.postcodePriorityBand = duplicateScored.postcodePriorityBand;
      duplicates += 1;
    } else {
      Object.assign(lead, scoreLead(lead, config));
      const draft = generateDraftReply(lead, config);
      lead.status = "Awaiting approval";
      lead.nextAction = "Review draft reply";
      lead.draftReplyCreated = "yes";
      lead.draftEmailIdLink = "Stored in tracker for review";
      lead.draftSubject = draft.subject;
      lead.draftReply = draft.body;
      imported += 1;
    }
    store.addLead(lead);
    store.markProcessed(message.id);
  }
  await store.save();
  return { imported, duplicates };
}

module.exports = { parseCsv, importCsvLeads, csvRowToMessage };
