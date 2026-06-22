const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("../src/config");
const { createTechnician, createWorkOrder } = require("../src/schedule");
const {
  ensureMessageQueue,
  enqueueMessage,
  queueTechnicianNotification,
  markQueueEntry
} = require("../src/messageQueue");

test("enqueueMessage creates a draft entry with the full queue shape", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-06-06T12:00:00.000Z") });
  const state = {};

  const entry = enqueueMessage(state, {
    relatedType: "work_order",
    relatedId: "WO-1",
    recipientType: "technician",
    recipientName: "Luis",
    recipientEmail: "tech@example.test",
    recipientPhone: "07895698239",
    channel: "sms",
    subject: "Subject",
    body: "Body",
    templateType: "new_assignment"
  });

  assert.equal(state.messageQueue.length, 1);
  assert.equal(entry.status, "draft");
  assert.deepEqual(Object.keys(entry), [
    "id",
    "related_type",
    "related_id",
    "recipient_type",
    "recipient_name",
    "recipient_email",
    "recipient_phone",
    "channel",
    "subject",
    "body",
    "template_type",
    "status",
    "provider",
    "provider_message_id",
    "error",
    "approved_by",
    "sent_at",
    "created_at",
    "updated_at"
  ]);
  assert.equal(entry.related_type, "work_order");
  assert.equal(entry.related_id, "WO-1");
  assert.equal(entry.created_at, "2026-06-06T12:00:00.000Z");
  assert.equal(entry.updated_at, "2026-06-06T12:00:00.000Z");
});

test("queueTechnicianNotification defaults to auditable disabled records and never sends", () => {
  const config = loadConfig({
    TECH_NOTIFY_EMAIL_ENABLED: "false",
    TECH_NOTIFY_SMS_ENABLED: "false",
    TECH_NOTIFY_WHATSAPP_ENABLED: "false",
    TECH_NOTIFY_AUTO_SEND: "false",
    TECH_NOTIFY_DRY_RUN: "true"
  });
  const state = { messageQueue: [] };
  const technician = createTechnician({ name: "Luis", email: "tech@example.test", mobile_number: "07895698239" });
  const workOrder = createWorkOrder({
    id: "WO-QUEUE",
    technician_id: technician.id,
    scheduled_start: "2026-06-06T09:00",
    customer_name: "Jane Smith",
    postcode: "HD1 2AB",
    address: "12 Market Street",
    job_summary: "Install new garage door"
  });

  const entries = queueTechnicianNotification(state, config, {
    workOrder,
    technician,
    templateKey: "new_assignment",
    secureLink: "https://example.test/work-orders/WO-QUEUE"
  });

  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => entry.channel), ["email", "sms", "whatsapp"]);
  assert.ok(entries.every((entry) => ["disabled", "draft", "queued"].includes(entry.status)));
  assert.ok(entries.every((entry) => entry.status !== "sent"));
  assert.ok(entries.every((entry) => entry.provider_message_id === ""));
  assert.ok(entries.filter((entry) => entry.channel !== "email").every((entry) => !entry.body.includes("12 Market Street")));
  assert.match(entries.find((entry) => entry.channel === "sms").body, /New job assigned: 2026-06-06 09:00, Smith, HD1 2AB\. View details: https:\/\/example\.test\/work-orders\/WO-QUEUE/);
});

test("markQueueEntry records a failed status and error", () => {
  const state = { messageQueue: [] };
  const entry = enqueueMessage(state, { channel: "email", status: "queued" });

  const updated = markQueueEntry(state, entry.id, { status: "failed", error: "SMTP unavailable" });

  assert.equal(updated.status, "failed");
  assert.equal(updated.error, "SMTP unavailable");
  assert.equal(state.messageQueue[0].status, "failed");
});

test("ensureMessageQueue initialises missing queue array", () => {
  const state = {};

  const queue = ensureMessageQueue(state);

  assert.deepEqual(queue, []);
  assert.equal(state.messageQueue, queue);
});
