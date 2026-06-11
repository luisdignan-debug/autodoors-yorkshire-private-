const test = require("node:test");
const assert = require("node:assert/strict");
const { scoreLead } = require("../src/leadScoring");
const { loadConfig } = require("../src/config");

test("scores emergency security issue as high priority", () => {
  const config = loadConfig({ SERVICE_COVERAGE: "uk_wide", LOCAL_PRIORITY_POSTCODES: "HD", REGIONAL_PRIORITY_POSTCODES: "YO,LS", DRY_RUN: "true" });
  const result = scoreLead(
    {
      status: "New",
      category: "emergency",
      urgency: "Urgent",
      jobDescription: "Door is stuck open and insecure",
      customerEmail: "a@example.com",
      customerPhone: "07700900123",
      customerPostcode: "LS178HH"
    },
    config
  );

  assert.equal(result.priorityLabel, "High");
  assert.ok(result.priorityScore >= 70);
  assert.equal(result.postcodePriorityBand, "Regional");
});

test("does not reject wider UK leads when coverage is UK-wide", () => {
  const config = loadConfig({ SERVICE_COVERAGE: "uk_wide", LOCAL_PRIORITY_POSTCODES: "HD", REGIONAL_PRIORITY_POSTCODES: "HX,WF,BD,LS", DRY_RUN: "true" });
  const result = scoreLead(
    {
      status: "New",
      category: "repair",
      urgency: "Normal",
      jobDescription: "Door needs repair",
      customerEmail: "a@example.com",
      customerPhone: "07700900123",
      customerPostcode: "NE11AA"
    },
    config
  );

  assert.equal(result.inServiceArea, true);
  assert.equal(result.postcodePriorityBand, "UK-wide");
  assert.match(result.suggestedNextAction, /Valid UK-wide/);
});

test("penalises out-of-area leads only in postcode-only mode", () => {
  const config = loadConfig({ SERVICE_COVERAGE: "postcode_only", SERVICE_POSTCODES: "YO", LOCAL_PRIORITY_POSTCODES: "", REGIONAL_PRIORITY_POSTCODES: "", DRY_RUN: "true" });
  const result = scoreLead(
    {
      status: "New",
      category: "repair",
      urgency: "Normal",
      jobDescription: "Door needs repair",
      customerEmail: "a@example.com",
      customerPhone: "07700900123",
      customerPostcode: "NE11AA"
    },
    config
  );

  assert.equal(result.inServiceArea, false);
  assert.equal(result.priorityLabel, "Low");
});
