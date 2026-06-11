const test = require("node:test");
const assert = require("node:assert/strict");
const { generateDraftReply } = require("../src/draftGenerator");
const { loadConfig } = require("../src/config");

test("creates a draft reply without sending language or invented pricing", () => {
  const config = loadConfig({ BUSINESS_NAME: "Autodoors Yorkshire", QUOTE_DAY: "Friday", DRY_RUN: "true" });
  const draft = generateDraftReply(
    {
      customerName: "Sarah Whitaker",
      category: "repair",
      urgency: "Normal",
      jobDescription: "Door is stiff",
      customerPostcode: "YO305AB",
      mechanism: "manual",
      customerPhone: "07700900123",
      missingInformationChecklist: ""
    },
    config
  );

  assert.match(draft.body, /Hi Sarah/);
  assert.match(draft.body, /photos/);
  assert.match(draft.body, /Friday/);
  assert.doesNotMatch(draft.body, /£|\bpounds\b/i);
});

test("creates a cable repair draft asking for drum and security details", () => {
  const config = loadConfig({ BUSINESS_NAME: "Autodoors Yorkshire", QUOTE_DAY: "Friday", DRY_RUN: "true" });
  const draft = generateDraftReply(
    {
      customerName: "Jane",
      category: "repair",
      urgency: "High",
      jobDescription: "Cable snapped and the door had to be forced down",
      garageDoorIssue: "snapped cable",
      customerPostcode: "HD12AB",
      mechanism: "",
      customerPhone: "07700900555",
      missingInformationChecklist: "door type/manual or electric"
    },
    config
  );

  assert.match(draft.body, /cable\/spring repair/i);
  assert.match(draft.body, /drum area/i);
  assert.match(draft.body, /fully closed and secure/i);
});
