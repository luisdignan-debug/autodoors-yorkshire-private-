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
