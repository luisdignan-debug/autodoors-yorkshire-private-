const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseEnquiriesFromHtml } = require("../src/checkatradeDashboard/scraper");
const { normaliseDashboardLead } = require("../src/checkatradeDashboard/normalizer");
const { runCheckatradeCollection } = require("../src/checkatradeDashboard/runner");
const { loadConfig } = require("../src/config");
const { JsonStore } = require("../src/database/jsonStore");
const { Logger } = require("../src/logger");

test("extracts Checkatrade dashboard enquiries from fixture HTML", () => {
  const html = fs.readFileSync(path.resolve("fixtures/checkatrade-dashboard/enquiries.html"), "utf8");
  const enquiries = parseEnquiriesFromHtml(html, "https://members.checkatrade.com/trades/dashboard/enquiries");

  assert.equal(enquiries.length, 2);
  assert.equal(enquiries[0].checkatradeId, "ct-lead-1001");
  assert.equal(enquiries[0].customerEmail, "sarah.whitaker@example.com");
  assert.equal(enquiries[0].postcode, "HD3 4AB");
  assert.match(enquiries[0].dashboardUrl, /ct-lead-1001/);
});

test("normalises raw dashboard enquiry into the existing lead schema", () => {
  const config = loadConfig({ DRY_RUN: "true" });
  const lead = normaliseDashboardLead(
    {
      checkatradeId: "ct-lead-1001",
      receivedAt: "2026-06-01T09:30:00.000Z",
      customerName: "Sarah Whitaker",
      customerEmail: "sarah.whitaker@example.com",
      customerPhone: "07700 900123",
      postcode: "HD3 4AB",
      jobDescription: "Electric roller garage door is stuck shut",
      dashboardUrl: "https://members.checkatrade.com/trades/dashboard/enquiries/ct-lead-1001"
    },
    config
  );

  assert.equal(lead.sourcePlatform, "Checkatrade Dashboard");
  assert.equal(lead.originalMessageId, "ct-lead-1001");
  assert.equal(lead.customerPostcode, "HD34AB");
  assert.match(lead.mechanism, /electric/);
});

test("dashboard dry-run creates previews without writing tracker data", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkatrade-dashboard-"));
  const config = loadConfig({
    DRY_RUN: "true",
    DATABASE_PATH: path.join(dir, "db.json"),
    TRACKER_XLSX_PATH: path.join(dir, "tracker.xlsx")
  });
  const store = new JsonStore(config.databasePath);
  const logger = new Logger({ level: "error", databasePath: config.databasePath });
  const rawEnquiries = [
    {
      checkatradeId: "ct-lead-1001",
      receivedAt: "2026-06-01T09:30:00.000Z",
      customerName: "Sarah Whitaker",
      customerEmail: "sarah.whitaker@example.com",
      customerPhone: "07700 900123",
      postcode: "HD3 4AB",
      jobDescription: "Garage door cable repair needed. Door is stuck shut.",
      dashboardUrl: "https://members.checkatrade.com/trades/dashboard/enquiries/ct-lead-1001"
    }
  ];

  const result = await runCheckatradeCollection({ config, store, logger, rawEnquiries });

  assert.equal(result.summary.scanned, 1);
  assert.equal(result.summary.added, 1);
  assert.equal(store.state.leads.length, 0);
  assert.equal(fs.existsSync(config.trackerXlsxPath), false);
  assert.match(result.leads[0].draftReply, /photos/i);
});
