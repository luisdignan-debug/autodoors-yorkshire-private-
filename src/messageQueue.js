const MESSAGE_QUEUE_STATUSES = ["draft", "awaiting_approval", "queued", "sent", "failed", "cancelled", "disabled"];
const CHANNELS = ["email", "sms", "whatsapp"];

function ensureMessageQueue(state) {
  if (state && !Array.isArray(state.messageQueue)) state.messageQueue = [];
  return state.messageQueue;
}

function enqueueMessage(state, {
  relatedType = "",
  relatedId = "",
  recipientType = "",
  recipientName = "",
  recipientEmail = "",
  recipientPhone = "",
  channel = "",
  subject = "",
  body = "",
  templateType = "",
  status = "draft",
  approvedBy = ""
} = {}) {
  const queue = ensureMessageQueue(state);
  const now = new Date().toISOString();
  const entry = {
    id: `message-queue:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    related_type: relatedType,
    related_id: relatedId,
    recipient_type: recipientType,
    recipient_name: recipientName,
    recipient_email: recipientEmail,
    recipient_phone: recipientPhone,
    channel,
    subject,
    body,
    template_type: templateType,
    status: MESSAGE_QUEUE_STATUSES.includes(status) ? status : "draft",
    provider: "",
    provider_message_id: "",
    error: "",
    approved_by: approvedBy,
    sent_at: "",
    created_at: now,
    updated_at: now
  };
  queue.push(entry);
  return entry;
}

const TECHNICIAN_TEMPLATES = {
  new_assignment: ({ workOrder, secureLink }) => ({
    subject: `New job assigned: ${safeCustomerName(workOrder)}`,
    body: `New job assigned: ${dateTimeLabel(workOrder.scheduled_start)}, ${safeCustomerName(workOrder)}, ${workOrder.postcode || ""}. View details: ${secureLink || ""}`
  }),
  reminder: ({ workOrder, secureLink }) => ({
    subject: `Reminder: installation today for ${safeCustomerName(workOrder)}`,
    body: `Reminder: installation today at ${timeLabel(workOrder.scheduled_start)} for ${safeCustomerName(workOrder)}, ${workOrder.postcode || ""}. View details: ${secureLink || ""}`
  }),
  reschedule: ({ workOrder, secureLink }) => ({
    subject: `Schedule changed: ${safeCustomerName(workOrder)}`,
    body: `Schedule changed: ${safeCustomerName(workOrder)} is now booked for ${dateTimeLabel(workOrder.scheduled_start)}. View details: ${secureLink || ""}`
  }),
  cancellation: ({ workOrder }) => ({
    subject: `Job cancelled/removed: ${safeCustomerName(workOrder)}`,
    body: `Job cancelled/removed: ${safeCustomerName(workOrder)}, ${dateTimeLabel(workOrder.scheduled_start)}. Check dashboard for details.`
  }),
  urgent_issue: ({ workOrder, secureLink }) => ({
    subject: `Urgent update needed for ${safeCustomerName(workOrder)}`,
    body: `Urgent update needed for ${safeCustomerName(workOrder)}, ${workOrder.postcode || ""}. Open job: ${secureLink || ""}`
  })
};

function queueTechnicianNotification(state, config = {}, { workOrder = {}, technician = {}, templateKey = "new_assignment", secureLink = "" } = {}) {
  ensureMessageQueue(state);
  const template = TECHNICIAN_TEMPLATES[templateKey];
  if (!template) throw new Error(`Unknown technician notification template: ${templateKey}`);

  const baseMessage = template({ workOrder, technician, secureLink });
  const techNotify = config.techNotify || {};
  const enabledByChannel = {
    email: Boolean(techNotify.emailEnabled),
    sms: Boolean(techNotify.smsEnabled),
    whatsapp: Boolean(techNotify.whatsappEnabled)
  };

  return CHANNELS.map((channel) => {
    const enabled = enabledByChannel[channel];
    return enqueueMessage(state, {
      relatedType: "work_order",
      relatedId: workOrder.id || "",
      recipientType: "technician",
      recipientName: technician.name || "",
      recipientEmail: technician.email || "",
      recipientPhone: channel === "whatsapp" ? technician.whatsapp_number || technician.whatsappNumber || technician.mobile_number || technician.mobileNumber || "" : technician.mobile_number || technician.mobileNumber || "",
      channel,
      subject: baseMessage.subject,
      body: channel === "email" ? emailBody(baseMessage.body, workOrder, secureLink) : baseMessage.body,
      templateType: templateKey,
      status: enabled ? "queued" : "disabled"
    });
  });
}

function markQueueEntry(state, id, { status, providerMessageId, error, approvedBy } = {}) {
  const queue = ensureMessageQueue(state);
  const entry = queue.find((item) => item.id === id);
  if (!entry) return null;
  if (status !== undefined) entry.status = MESSAGE_QUEUE_STATUSES.includes(status) ? status : entry.status;
  if (providerMessageId !== undefined) entry.provider_message_id = providerMessageId;
  if (error !== undefined) entry.error = error;
  if (approvedBy !== undefined) entry.approved_by = approvedBy;
  entry.updated_at = new Date().toISOString();
  if (entry.status === "sent") entry.sent_at = entry.updated_at;
  return entry;
}

function emailBody(baseBody, workOrder = {}, secureLink = "") {
  return [
    baseBody,
    "",
    workOrder.time_window ? `Time window: ${workOrder.time_window}` : "",
    workOrder.job_summary ? `Job summary: ${workOrder.job_summary}` : "",
    secureLink ? `Dashboard link: ${secureLink}` : ""
  ].filter((line) => line !== "").join("\n");
}

function safeCustomerName(workOrder = {}) {
  const parts = String(workOrder.customer_name || "Customer").trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : parts[0] || "Customer";
}

function dateTimeLabel(value) {
  return value ? String(value).replace("T", " ").slice(0, 16) : "unscheduled";
}

function timeLabel(value) {
  const label = dateTimeLabel(value);
  return label.includes(" ") ? label.slice(11, 16) : label;
}

module.exports = {
  MESSAGE_QUEUE_STATUSES,
  ensureMessageQueue,
  enqueueMessage,
  TECHNICIAN_TEMPLATES,
  queueTechnicianNotification,
  markQueueEntry
};
