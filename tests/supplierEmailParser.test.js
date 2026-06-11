const test = require("node:test");
const assert = require("node:assert/strict");
const { JsonStore } = require("../src/database/jsonStore");
const {
  isLikelySupplierEmail,
  parseSupplierEmail,
  parseLeadTime,
  matchSupplierEmailToLead,
  processSupplierMessage
} = require("../src/jobs/supplierEmailParser");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("detects supplier confirmation email with exact delivery date", () => {
  const message = supplierMessage({
    subject: "Sales order confirmation SO-12345",
    body: "Order confirmation SO-12345 for Jane Smith HD1 2AB. Estimated delivery date: 18 July 2026."
  });

  assert.equal(isLikelySupplierEmail(message), true);
  const parsed = parseSupplierEmail(message, new Date("2026-06-02T09:00:00Z"));

  assert.equal(parsed.extractedOrderReference, "SO-12345");
  assert.equal(parsed.extractedDeliveryDate, "2026-07-18");
  assert.equal(parsed.deliveryStatus, "Confirmed");
});

test("parses 4-6 week supplier lead time into a delivery range", () => {
  const result = parseLeadTime("Lead time is approx. 4-6 weeks from order confirmation.", new Date("2026-06-02T09:00:00Z"));

  assert.equal(result.text, "approx. 4-6 weeks");
  assert.equal(result.start, "2026-06-30");
  assert.equal(result.end, "2026-07-14");
});

test("detects supplier delay and delivery arrived wording", () => {
  const delayed = parseSupplierEmail(supplierMessage({ body: "Order SO-777 is delayed due to back order. Revised lead time 10 working days." }), new Date("2026-06-02T09:00:00Z"));
  const delivered = parseSupplierEmail(supplierMessage({ body: "Order SO-888 has been delivered on 12 June 2026 and is ready for installation." }), new Date("2026-06-02T09:00:00Z"));

  assert.equal(delayed.deliveryStatus, "Delayed");
  assert.equal(delayed.extractedDeliveryEnd, "2026-06-16");
  assert.equal(delivered.deliveryStatus, "Delivered");
  assert.equal(delivered.extractedDeliveryDate, "2026-06-12");
});

test("matches high confidence supplier email to job and queues low confidence for review", () => {
  const leads = [
    {
      id: "LEAD-1",
      customerName: "Jane Smith",
      customerPostcode: "HD12AB",
      supplier_order_reference: "SO-12345",
      supplier_order_placed_at: "2026-06-01",
      jobDescription: "Replacement roller door",
      garageDoorType: "roller"
    }
  ];
  const high = parseSupplierEmail(supplierMessage({ body: "Order confirmation SO-12345 for Jane Smith HD1 2AB. Delivery expected 18 July 2026." }));
  const low = parseSupplierEmail(supplierMessage({ body: "Invoice INV-999 for stock order." }));

  assert.equal(matchSupplierEmailToLead(high, leads).reviewStatus, "Linked");
  assert.equal(matchSupplierEmailToLead(low, leads).reviewStatus, "Needs review");
});

test("processSupplierMessage updates a high-confidence matched job", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "supplier-parser-"));
  const store = new JsonStore(path.join(dir, "db.json"));
  store.addLead({
    id: "LEAD-1",
    customerName: "Jane Smith",
    customerPostcode: "HD12AB",
    supplier_order_reference: "SO-12345",
    supplier_order_placed_at: "2026-06-01",
    jobDescription: "Replacement roller door",
    garageDoorType: "roller",
    updatedAt: "2026-06-01T10:00:00Z"
  });

  const record = processSupplierMessage(
    supplierMessage({ body: "Order confirmation SO-12345 for Jane Smith HD1 2AB. Estimated delivery date: 18 July 2026." }),
    { store, now: new Date("2026-06-02T09:00:00Z") }
  );

  assert.equal(record.reviewStatus, "Linked");
  assert.equal(store.state.leads[0].supplier_confirmation_received_at, "2026-06-02");
  assert.equal(store.state.leads[0].supplier_estimated_delivery_date, "2026-07-18");
  assert.equal(store.state.supplierEmails.length, 1);
  assert.equal(store.state.jobEvents.length, 1);
});

function supplierMessage(patch = {}) {
  return {
    id: "<supplier-test@example.com>",
    from: "Door Supplier <orders@supplier.example>",
    subject: "Supplier order update",
    receivedAt: "2026-06-02T09:00:00.000Z",
    body: "",
    attachments: [{ filename: "order-confirmation.pdf" }],
    ...patch
  };
}
