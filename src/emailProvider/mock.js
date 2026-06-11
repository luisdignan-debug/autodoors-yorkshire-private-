const fs = require("node:fs");
const path = require("node:path");

function parseFixture(text, fileName) {
  const [headerPart, ...bodyParts] = text.split(/\r?\n\r?\n/);
  const headers = {};
  for (const line of headerPart.split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) headers[match[1].toLowerCase()] = match[2];
  }
  return {
    id: headers["message-id"] || `fixture:${fileName}`,
    from: headers.from || "",
    subject: headers.subject || "",
    receivedAt: headers.date ? new Date(headers.date).toISOString() : new Date().toISOString(),
    body: bodyParts.join("\n\n").trim()
  };
}

async function listMessages(config) {
  if (!fs.existsSync(config.mockEmailDir)) return [];
  return fs
    .readdirSync(config.mockEmailDir)
    .filter((file) => file.endsWith(".txt"))
    .sort()
    .map((file) => parseFixture(fs.readFileSync(path.join(config.mockEmailDir, file), "utf8"), file));
}

async function markProcessed() {
  return true;
}

async function createDraft(message, draft) {
  return {
    id: `mock-draft:${message.id}`,
    link: `Draft written to tracker only (${draft.subject})`
  };
}

module.exports = { listMessages, markProcessed, createDraft };
