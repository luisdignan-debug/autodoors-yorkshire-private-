const test = require("node:test");
const assert = require("node:assert/strict");
const { findDuplicate, similarity } = require("../src/dedupe");

test("detects duplicate by email within a short time window", () => {
  const existing = {
    id: "LEAD-1",
    status: "Awaiting approval",
    receivedAt: "2026-06-01T09:00:00.000Z",
    customerEmail: "customer@example.com",
    customerPhone: "07700900123",
    customerPostcode: "YO305AB",
    jobDescription: "Door cable loose and door stiff"
  };
  const duplicate = {
    ...existing,
    id: "LEAD-2",
    originalMessageId: "msg-2",
    receivedAt: "2026-06-01T10:00:00.000Z"
  };
  const result = findDuplicate(duplicate, [existing]);
  assert.equal(result.existing.id, "LEAD-1");
  assert.match(result.reason, /email/);
});

test("compares job descriptions without needing exact text", () => {
  assert.ok(similarity("garage door cable loose and stiff", "stiff garage door with loose cable") > 0.5);
});
