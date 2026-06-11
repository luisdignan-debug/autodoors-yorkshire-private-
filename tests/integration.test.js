const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConfig } = require("../src/config");
const { JsonStore } = require("../src/database/jsonStore");
const { Logger } = require("../src/logger");
const { processMessages } = require("../src/processor");

test("processes sample mailbox and prevents duplicate active leads", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enquiry-manager-"));
  const config = loadConfig({
    DRY_RUN: "true",
    DATABASE_PATH: path.join(dir, "db.json"),
    TRACKER_XLSX_PATH: path.join(dir, "tracker.xlsx"),
    MOCK_EMAIL_DIR: path.resolve("fixtures/sample-emails")
  });
  const store = new JsonStore(config.databasePath);
  const logger = new Logger({ level: "error", databasePath: config.databasePath });
  const summary = await processMessages({ config, store, logger });

  assert.equal(summary.scanned, 4);
  assert.equal(summary.added, 3);
  assert.equal(summary.duplicates, 1);
  assert.equal(store.state.leads.filter((lead) => lead.status !== "Duplicate").length, 3);
  assert.equal(store.state.leads.filter((lead) => lead.draftReplyCreated === "yes").length, 3);
  assert.ok(fs.existsSync(config.trackerXlsxPath));
});

test("mailbox sync sorts non-leads instead of creating bogus leads", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enquiry-sorter-"));
  const config = loadConfig({
    DRY_RUN: "true",
    ENQUIRY_ALLOWED_SENDERS: "*",
    DATABASE_PATH: path.join(dir, "db.json"),
    TRACKER_XLSX_PATH: path.join(dir, "tracker.xlsx")
  });
  const store = new JsonStore(config.databasePath);
  const logger = new Logger({ level: "error", databasePath: config.databasePath });
  const messages = [
    message("lead-1", "customer@example.com", "Garage door repair quote", [
      "Customer name: Alex Green",
      "Customer email: alex@example.com",
      "Customer phone: 07700 900111",
      "Customer address: 10 Westgate, Huddersfield, HD1 2AB",
      "Postcode: HD1 2AB",
      "Message: Electric garage door is stuck and needs repair."
    ].join("\n")),
    message("supplier-1", "orders@supplier.example", "Order confirmation SO-7788", "Order confirmation SO-7788. Estimated delivery date: 18 July 2026."),
    message("cv-1", "candidate@example.com", "CV for engineer vacancy", "Please find attached my CV. I am looking for work."),
    message("spam-1", "marketing@example.com", "Quote for website redesign", "We can improve your SEO and redesign your website."),
    message("admin-1", "mailer@example.com", "Out of office auto reply", "Automatic reply: I am away.")
  ];

  const summary = await processMessages({ config, store, logger, messages, provider: { listMessages: async () => messages, markProcessed: async () => {} } });

  assert.equal(summary.scanned, 5);
  assert.equal(summary.added, 1);
  assert.equal(summary.supplierEmails, 1);
  assert.equal(summary.recruitment, 1);
  assert.equal(summary.spam, 1);
  assert.equal(summary.admin, 1);
  assert.equal(store.state.leads.length, 1);
  assert.equal(store.state.leads[0].customerAddress, "10 Westgate, Huddersfield, HD1 2AB");
  assert.equal(store.state.supplierEmails.length, 1);
});

function message(id, from, subject, body) {
  return { id, from, subject, body, receivedAt: "2026-06-02T10:00:00.000Z", sourcePlatform: "SiteGround mailbox" };
}
