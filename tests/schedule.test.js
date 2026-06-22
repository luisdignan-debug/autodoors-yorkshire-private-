const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("../src/config");
const {
  createTechnician,
  createWorkOrder,
  digestForTechnician,
  workOrderCalendarPayload,
  generateIcs,
  scheduleSummary,
  appendEventLog,
  dispatchState,
  installationTodayBuckets,
  calendarReadiness
} = require("../src/schedule");
const { messagingStatus, sendSms, sendWhatsApp } = require("../src/messageProvider");

test("technician daily and weekly digest generation lists scheduled work", () => {
  const technician = createTechnician({ name: "Luis", mobile_number: "07895698239" });
  const order = createWorkOrder({
    technician_id: technician.id,
    scheduled_start: "2026-06-06T09:00",
    scheduled_end: "2026-06-06T11:00",
    customer_name: "Jane Smith",
    postcode: "HD1 2AB",
    customer_phone: "07700 900555",
    job_summary: "Repair garage door",
    access_notes: "Side gate"
  });
  const state = { technicians: [technician], workOrders: [order] };

  const daily = digestForTechnician(state, technician.id, new Date("2026-06-06T08:00:00Z"), 1);
  const weekly = digestForTechnician(state, technician.id, new Date("2026-06-06T08:00:00Z"), 7);

  assert.match(daily.body, /Jane Smith/);
  assert.match(daily.body, /HD1 2AB/);
  assert.match(weekly.title, /Weekly schedule/);
});

test("work order calendar event payload and .ics export are generated", () => {
  const order = createWorkOrder({
    id: "WO-1",
    scheduled_start: "2026-06-06T09:00",
    scheduled_end: "2026-06-06T10:30",
    customer_name: "Jane Smith",
    postcode: "HD1 2AB",
    address: "12 Market Street",
    job_summary: "Install new garage door"
  });

  const payload = workOrderCalendarPayload(order, "https://example.com");
  const ics = generateIcs(order, "https://example.com");

  assert.match(payload.title, /Auto Doors Yorkshire/);
  assert.match(payload.location, /12 Market Street/);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /SUMMARY:Auto Doors Yorkshire/);
});

test("SMS and WhatsApp providers are disabled by default", async () => {
  const config = loadConfig({});
  const state = { messageLogs: [] };
  const status = messagingStatus(config);
  const sms = await sendSms("07895698239", "Digest", { config, state });
  const whatsapp = await sendWhatsApp("07895698239", "Digest", "", {}, { config, state });

  assert.equal(status.sms.enabled, false);
  assert.equal(status.whatsapp.enabled, false);
  assert.equal(sms.status, "disabled");
  assert.equal(whatsapp.status, "disabled");
  assert.equal(state.messageLogs.length, 2);
});

test("calendar sync defaults to safe .ics mode", () => {
  const config = loadConfig({});
  const order = createWorkOrder({ scheduled_start: "2026-06-06T09:00" });
  const state = { workOrders: [order] };
  const summary = scheduleSummary(state, new Date("2026-06-06T08:00:00Z"));
  const readiness = calendarReadiness(config);

  assert.equal(summary.today, 1);
  assert.equal(readiness.status, "disabled");
  assert.match(readiness.warning, /\.ics/);
});

test("work order creation includes dispatch defaults", () => {
  const order = createWorkOrder(
    { id: "WO-DEFAULTS", internal_notes: "Mind the side gate" },
    { id: "lead-defaults", customerEmail: "customer@example.test" }
  );

  assert.equal(order.customer_email, "customer@example.test");
  assert.equal(order.technician_status, "not_notified");
  assert.equal(order.customer_confirmation_status, "not_sent");
  assert.equal(order.risk_level, "grey");
  assert.equal(order.internal_notes, "Mind the side gate");
  assert.equal(order.calendar_uid, "WO-DEFAULTS@autodoorsyorkshire.com");
  assert.equal(order.calendar_sequence, 0);
  assert.deepEqual(order.logs, []);
});

test("dispatch state reports booking, balance, and technician confirmation states", () => {
  assert.deepEqual(dispatchState({ status: "unscheduled", scheduled_start: "" }), {
    key: "needs_booking",
    label: "Needs booking",
    tone: "amber"
  });
  assert.deepEqual(dispatchState({ status: "completed" }, { balanceOutstanding: 120 }), {
    key: "balance_due",
    label: "Completed – balance due",
    tone: "red"
  });
  assert.deepEqual(dispatchState({ status: "scheduled", technician_status: "confirmed", scheduled_start: "2026-06-06T09:00" }), {
    key: "technician_confirmed",
    label: "Technician confirmed",
    tone: "green"
  });
});

test("appendEventLog appends an event and updates timestamp", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-06-06T12:00:00.000Z") });
  const order = createWorkOrder({ id: "WO-LOG" });
  order.updated_at = "2026-06-01T00:00:00.000Z";

  appendEventLog(order, "assigned", "Assigned to Luis", "office");

  assert.equal(order.logs.length, 1);
  assert.equal(order.logs[0].event_type, "assigned");
  assert.equal(order.logs[0].note, "Assigned to Luis");
  assert.equal(order.logs[0].created_by, "office");
  assert.equal(order.logs[0].created_at, "2026-06-06T12:00:00.000Z");
  assert.equal(order.updated_at, "2026-06-06T12:00:00.000Z");
});

test("installationTodayBuckets groups dispatch work and booking gaps", () => {
  const leads = [
    { id: "lead-balance", quote_accepted_at: "2026-06-01", supplier_order_required: "no" },
    { id: "lead-delivered", quote_accepted_at: "2026-06-01", supplier_order_required: "yes", supplier_actual_delivery_date: "2026-06-05" },
    { id: "lead-booked", quote_accepted_at: "2026-06-01", supplier_order_required: "yes", supplier_actual_delivery_date: "2026-06-05" },
    { id: "lead-needs", quote_accepted_at: "2026-06-01", supplier_order_required: "no" }
  ];
  const state = {
    workOrders: [
      createWorkOrder({ id: "WO-COMPLETE", lead_id: "lead-balance", status: "completed", scheduled_start: "2026-06-03T09:00" }),
      createWorkOrder({ id: "WO-ACTIVE", lead_id: "lead-booked", scheduled_start: "2026-06-06T09:00", technician_id: "tech-1" }),
      createWorkOrder({ id: "WO-NOTIFIED", lead_id: "lead-notified", scheduled_start: "2026-06-07T09:00", technician_id: "tech-1", technician_status: "notified" })
    ]
  };
  state.workOrders[0].status = "completed";
  state.workOrders[2].technician_status = "notified";

  const buckets = installationTodayBuckets(
    state,
    leads,
    (lead) => (lead.id === "lead-balance" ? 45 : 0),
    new Date("2026-06-06T08:00:00.000Z")
  );

  assert.deepEqual(buckets.completedBalanceDue.map((order) => order.id), ["WO-COMPLETE"]);
  assert.deepEqual(buckets.deliveryReadyNotBooked.map((lead) => lead.id), ["lead-delivered"]);
  assert.ok(!buckets.needsBooking.some((lead) => lead.id === "lead-booked"));
  assert.ok(buckets.needsBooking.some((lead) => lead.id === "lead-needs"));
  assert.deepEqual(buckets.technicianNotNotified.map((order) => order.id), ["WO-ACTIVE"]);
  assert.deepEqual(buckets.technicianNotConfirmed.map((order) => order.id), ["WO-NOTIFIED"]);
});
