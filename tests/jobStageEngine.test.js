const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ensureJobFields,
  applyJobAction,
  evaluateWorkflow,
  queueCounts,
  relevantActions
} = require("../src/jobs/jobStageEngine");
const { generateCustomerUpdateDraft } = require("../src/jobs/customerUpdateTemplates");

test("new door workflow moves from quote accepted to deposit and supplier order", () => {
  const now = new Date("2026-06-02T09:00:00Z");
  const lead = baseLead({
    jobDescription: "Replacement electric roller garage door supply and fit",
    garageDoorType: "roller, electric"
  });

  ensureJobFields(lead, now);
  assert.equal(lead.workflow_type, "replacement_door");
  assert.equal(lead.supplier_order_required, "yes");

  applyJobAction(
    lead,
    "mark_quote_accepted",
    {
      quote_amount: "2400",
      quote_reference: "ADY-101",
      deposit_required: "yes",
      deposit_amount: "600",
      supplier_order_required: "yes"
    },
    now
  );
  assert.equal(lead.next_best_action, "Request deposit");

  applyJobAction(lead, "request_deposit", { deposit_requested_at: "2026-06-02" }, now);
  applyJobAction(lead, "mark_deposit_received", { deposit_received_at: "2026-06-03" }, now);
  assert.equal(lead.next_best_action, "Place supplier order");

  applyJobAction(lead, "mark_supplier_order_placed", { supplier_name: "Door Supplier", supplier_order_reference: "SO-7788" }, now);
  assert.equal(lead.next_best_action, "Await or link supplier confirmation");
});

test("repair workflow skips supplier order and can book a visit", () => {
  const lead = baseLead({
    jobDescription: "Cable repair, door stuck and insecure",
    garageDoorIssue: "cable repair"
  });
  ensureJobFields(lead, new Date("2026-06-02T09:00:00Z"));

  assert.equal(lead.workflow_type, "repair");
  assert.equal(lead.supplier_order_required, "no");

  applyJobAction(
    lead,
    "mark_quote_accepted",
    { deposit_required: "no", supplier_order_required: "no" },
    new Date("2026-06-02T09:00:00Z")
  );

  assert.ok(relevantActions(lead).includes("book_installation"));
  assert.equal(lead.next_best_action, "Book repair visit");
});

test("workflow engine guides new door from quote accepted to deposit", () => {
  const lead = baseLead({
    workflow_type: "new_door",
    quote_accepted_at: "2026-06-02",
    deposit_required: "yes",
    supplier_order_required: "yes"
  });
  const result = evaluateWorkflow(lead, new Date("2026-06-03T09:00:00Z"));

  assert.equal(result.currentStage, "Quote accepted");
  assert.equal(result.nextBestAction, "Request deposit");
  assert.ok(result.visiblePrimaryActions.includes("request_deposit"));
});

test("workflow engine moves deposit received to supplier order placement", () => {
  const lead = baseLead({
    workflow_type: "replacement_door",
    quote_amount: "1500",
    quote_accepted_at: "2026-06-02",
    deposit_required: "yes",
    deposit_received_at: "2026-06-03",
    supplier_order_required: "yes"
  });
  const result = evaluateWorkflow(lead);

  assert.equal(result.currentStage, "Deposit received");
  assert.equal(result.nextBestAction, "Place supplier order");
  assert.deepEqual(result.visiblePrimaryActions, ["mark_supplier_order_placed"]);
  assert.ok(result.hiddenCompletedActions.includes("request_deposit"));
});

test("workflow engine waits for supplier confirmation after order placement", () => {
  const lead = baseLead({
    workflow_type: "new_door",
    quote_accepted_at: "2026-06-02",
    deposit_required: "yes",
    deposit_received_at: "2026-06-03",
    supplier_order_required: "yes",
    supplier_order_placed_at: "2026-06-04"
  });
  const result = evaluateWorkflow(lead);

  assert.equal(result.currentStage, "Supplier order placed");
  assert.equal(result.nextBestAction, "Await or link supplier confirmation");
  assert.deepEqual(result.visiblePrimaryActions, ["mark_supplier_confirmation_received"]);
  assert.ok(result.visibleSecondaryActions.includes("record_supplier_invoice"));
});

test("workflow engine monitors delivery after supplier confirmation", () => {
  const lead = baseLead({
    workflow_type: "new_door",
    quote_accepted_at: "2026-06-02",
    deposit_required: "yes",
    deposit_received_at: "2026-06-03",
    supplier_order_required: "yes",
    supplier_order_placed_at: "2026-06-04",
    supplier_confirmation_received_at: "2026-06-05"
  });
  const result = evaluateWorkflow(lead, new Date("2026-06-06T09:00:00Z"));

  assert.equal(result.currentStage, "Awaiting delivery");
  assert.ok(result.visiblePrimaryActions.includes("mark_delivered"));
  assert.ok(result.visiblePrimaryActions.includes("update_expected_delivery"));
});

test("workflow engine books installation after delivery", () => {
  const lead = baseLead({
    workflow_type: "new_door",
    quote_accepted_at: "2026-06-02",
    deposit_required: "yes",
    deposit_received_at: "2026-06-03",
    supplier_order_required: "yes",
    supplier_order_placed_at: "2026-06-04",
    supplier_confirmation_received_at: "2026-06-05",
    supplier_actual_delivery_date: "2026-06-12"
  });
  const result = evaluateWorkflow(lead);

  assert.equal(result.currentStage, "Delivered / ready for install");
  assert.deepEqual(result.visiblePrimaryActions, ["book_installation"]);
});

test("workflow engine requests or records balance after installation", () => {
  const lead = baseLead({
    workflow_type: "replacement_door",
    quote_amount: "1500",
    quote_accepted_at: "2026-06-02",
    deposit_required: "no",
    supplier_order_required: "no",
    installation_scheduled_at: "2026-06-10T09:00",
    installation_completed_at: "2026-06-10"
  });
  const result = evaluateWorkflow(lead);

  assert.equal(result.currentStage, "Installation completed");
  assert.equal(result.nextBestAction, "Request balance");
  assert.ok(result.visiblePrimaryActions.includes("request_balance"));
  assert.ok(result.visiblePrimaryActions.includes("mark_balance_paid"));
});

test("completed deposit and supplier order actions are hidden from main panel", () => {
  const lead = baseLead({
    workflow_type: "new_door",
    quote_accepted_at: "2026-06-02",
    deposit_required: "yes",
    deposit_requested_at: "2026-06-02",
    deposit_received_at: "2026-06-03",
    supplier_order_required: "yes",
    supplier_order_placed_at: "2026-06-04"
  });
  const result = evaluateWorkflow(lead);

  assert.ok(!result.visiblePrimaryActions.includes("request_deposit"));
  assert.ok(!result.visiblePrimaryActions.includes("mark_supplier_order_placed"));
  assert.ok(result.hiddenCompletedActions.includes("request_deposit"));
  assert.ok(result.hiddenCompletedActions.includes("mark_supplier_order_placed"));
});

test("repair jobs skip supplier order and invoice stages unless required", () => {
  const lead = baseLead({
    workflow_type: "repair",
    quote_accepted_at: "2026-06-02",
    deposit_required: "no",
    supplier_order_required: "no"
  });
  const result = evaluateWorkflow(lead);

  assert.equal(result.currentStage, "Visit or repair booking needed");
  assert.deepEqual(result.visiblePrimaryActions, ["book_installation"]);
  assert.ok(!result.visiblePrimaryActions.includes("mark_supplier_order_placed"));
  assert.ok(!result.visibleSecondaryActions.includes("record_supplier_invoice"));
});

test("supplier invoice option does not replace supplier order placement", () => {
  const lead = baseLead({
    workflow_type: "replacement_door",
    quote_accepted_at: "2026-06-02",
    deposit_required: "yes",
    deposit_received_at: "2026-06-03",
    supplier_order_required: "yes",
    supplier_invoice_status: "received"
  });
  const result = evaluateWorkflow(lead);

  assert.equal(result.nextBestAction, "Place supplier order");
  assert.deepEqual(result.visiblePrimaryActions, ["mark_supplier_order_placed"]);
  assert.ok(!result.visiblePrimaryActions.includes("record_supplier_invoice"));
});

test("dashboard queue counts include supplier and payment work", () => {
  const now = new Date("2026-06-02T09:00:00Z");
  const needsDeposit = baseLead({ id: "LEAD-A", quote_accepted_at: "2026-06-01", deposit_required: "yes" });
  const awaitingDelivery = baseLead({
    id: "LEAD-B",
    workflow_type: "new_door",
    supplier_order_required: "yes",
    supplier_order_placed_at: "2026-05-20",
    supplier_confirmation_received_at: "2026-05-21",
    supplier_estimated_delivery_date: "2026-06-05"
  });
  const paymentDue = baseLead({ id: "LEAD-C", installation_completed_at: "2026-06-01", balance_requested_at: "2026-06-01" });

  const counts = queueCounts([needsDeposit, awaitingDelivery, paymentDue], [{ reviewStatus: "Needs review" }], now);

  assert.equal(counts.acceptedNeedDeposit, 1);
  assert.equal(counts.awaitingDelivery, 1);
  assert.equal(counts.deliveryDueSoon, 1);
  assert.equal(counts.balanceDue, 1);
  assert.equal(counts.supplierEmailsNeedingReview, 1);
});

test("customer update drafts use placeholders instead of inventing dates", () => {
  const lead = baseLead({ customerName: "Jane Smith" });
  const draft = generateCustomerUpdateDraft(lead, "supplier_confirmation", { businessName: "Autodoors Yorkshire" });

  assert.match(draft.body, /Hi Jane/);
  assert.match(draft.body, /\[confirm date\/lead time\]/);
  assert.doesNotMatch(draft.body, /AUTO_SEND/i);
});

function baseLead(patch = {}) {
  return {
    id: "LEAD-TEST",
    status: "Awaiting approval",
    customerName: "Jane Smith",
    customerEmail: "jane@example.com",
    customerPhone: "07700900123",
    customerPostcode: "HD12AB",
    sourcePlatform: "Manual lead",
    jobDescription: "Garage door enquiry",
    garageDoorType: "",
    garageDoorIssue: "",
    priorityLabel: "Medium",
    urgency: "Normal",
    receivedAt: "2026-06-01T10:00:00.000Z",
    draftReply: "Draft reply",
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T10:00:00.000Z",
    ...patch
  };
}
