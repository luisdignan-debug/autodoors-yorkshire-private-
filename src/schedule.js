const { formatMoney } = require("./finance");

const WORK_ORDER_STATUSES = ["unscheduled", "scheduled", "sent_to_technician", "confirmed", "completed", "cancelled", "rescheduled"];
const WORK_TYPES = ["survey", "repair", "installation", "follow_up", "service", "other"];
const TECHNICIAN_STATUSES = ["not_notified", "notified", "confirmed", "en_route", "arrived", "completed", "issue", "reschedule_requested"];
const CUSTOMER_CONFIRMATION_STATUSES = ["not_sent", "awaiting", "confirmed", "declined"];
const RISK_LEVELS = ["red", "amber", "green", "grey"];

function createTechnician(form = {}) {
  const now = new Date().toISOString();
  return {
    id: form.id || `technician:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    name: form.name || "Technician",
    mobile_number: form.mobile_number || form.mobileNumber || "",
    whatsapp_number: form.whatsapp_number || form.whatsappNumber || "",
    email: form.email || "",
    calendar_type: form.calendar_type || form.calendarType || "ics",
    calendar_identifier: form.calendar_identifier || form.calendarIdentifier || "",
    active: form.active === undefined ? true : isTrue(form.active),
    notes: form.notes || "",
    created_at: form.created_at || now,
    updated_at: now
  };
}

function updateTechnician(technician, form = {}) {
  Object.assign(technician, {
    name: form.name || technician.name,
    mobile_number: form.mobile_number || form.mobileNumber || technician.mobile_number || "",
    whatsapp_number: form.whatsapp_number || form.whatsappNumber || technician.whatsapp_number || "",
    email: form.email || technician.email || "",
    calendar_type: form.calendar_type || form.calendarType || technician.calendar_type || "ics",
    calendar_identifier: form.calendar_identifier || form.calendarIdentifier || technician.calendar_identifier || "",
    active: form.active === undefined ? technician.active !== false : isTrue(form.active),
    notes: form.notes || "",
    updated_at: new Date().toISOString()
  });
  return technician;
}

function createWorkOrder(form = {}, lead = {}) {
  const now = new Date().toISOString();
  const id = form.id || `work-order:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
  const scheduledStart = form.scheduled_start || form.scheduledStart || lead.installation_scheduled_at || "";
  const scheduledEnd = form.scheduled_end || form.scheduledEnd || defaultEnd(scheduledStart);
  return {
    id,
    job_id: form.job_id || form.jobId || lead.id || "",
    lead_id: form.lead_id || form.leadId || lead.id || "",
    technician_id: form.technician_id || form.technicianId || "",
    work_type: normaliseWorkType(form.work_type || form.workType || inferWorkType(lead)),
    scheduled_start: scheduledStart,
    scheduled_end: scheduledEnd,
    time_window: form.time_window || form.timeWindow || lead.installation_time_window || "",
    address: form.address || lead.customerAddress || "",
    postcode: form.postcode || lead.customerPostcode || "",
    customer_name: form.customer_name || form.customerName || lead.customerName || "",
    customer_email: form.customer_email || form.customerEmail || lead.customerEmail || "",
    customer_phone: form.customer_phone || form.customerPhone || lead.customerPhone || "",
    job_summary: form.job_summary || form.jobSummary || lead.jobDescription || "",
    access_notes: form.access_notes || form.accessNotes || lead.installation_access_notes || "",
    materials_notes: form.materials_notes || form.materialsNotes || lead.supplier_order_product_details || lead.supplier_order_notes || "",
    supplier_order_reference: form.supplier_order_reference || form.supplierOrderReference || lead.supplier_order_reference || "",
    status: scheduledStart ? "scheduled" : "unscheduled",
    technician_status: "not_notified",
    customer_confirmation_status: "not_sent",
    risk_level: "grey",
    internal_notes: form.internal_notes || "",
    calendar_uid: `${id}@autodoorsyorkshire.com`,
    calendar_sequence: 0,
    logs: [],
    technician_notes: form.technician_notes || form.technicianNotes || "",
    calendar_event_id: form.calendar_event_id || form.calendarEventId || "",
    last_digest_sent_at: "",
    created_at: now,
    updated_at: now
  };
}

function updateWorkOrder(workOrder, form = {}, lead = {}) {
  const scheduledStart = form.scheduled_start || form.scheduledStart || workOrder.scheduled_start || "";
  Object.assign(workOrder, {
    technician_id: form.technician_id || form.technicianId || workOrder.technician_id || "",
    work_type: normaliseWorkType(form.work_type || form.workType || workOrder.work_type || inferWorkType(lead)),
    scheduled_start: scheduledStart,
    scheduled_end: form.scheduled_end || form.scheduledEnd || workOrder.scheduled_end || defaultEnd(scheduledStart),
    time_window: form.time_window || form.timeWindow || workOrder.time_window || lead.installation_time_window || "",
    address: form.address || workOrder.address || lead.customerAddress || "",
    postcode: form.postcode || workOrder.postcode || lead.customerPostcode || "",
    customer_name: form.customer_name || form.customerName || workOrder.customer_name || lead.customerName || "",
    customer_email: form.customer_email || form.customerEmail || workOrder.customer_email || lead.customerEmail || "",
    customer_phone: form.customer_phone || form.customerPhone || workOrder.customer_phone || lead.customerPhone || "",
    job_summary: form.job_summary || form.jobSummary || workOrder.job_summary || lead.jobDescription || "",
    access_notes: form.access_notes || form.accessNotes || workOrder.access_notes || lead.installation_access_notes || "",
    materials_notes: form.materials_notes || form.materialsNotes || workOrder.materials_notes || lead.supplier_order_product_details || "",
    supplier_order_reference: form.supplier_order_reference || form.supplierOrderReference || workOrder.supplier_order_reference || lead.supplier_order_reference || "",
    status: form.status || (scheduledStart ? "scheduled" : "unscheduled"),
    technician_status: TECHNICIAN_STATUSES.includes(form.technician_status) ? form.technician_status : workOrder.technician_status || "not_notified",
    customer_confirmation_status: CUSTOMER_CONFIRMATION_STATUSES.includes(form.customer_confirmation_status) ? form.customer_confirmation_status : workOrder.customer_confirmation_status || "not_sent",
    risk_level: RISK_LEVELS.includes(form.risk_level) ? form.risk_level : workOrder.risk_level || "grey",
    internal_notes: form.internal_notes || workOrder.internal_notes || "",
    calendar_uid: workOrder.calendar_uid || `${workOrder.id}@autodoorsyorkshire.com`,
    calendar_sequence: workOrder.calendar_sequence === undefined ? 0 : workOrder.calendar_sequence,
    logs: Array.isArray(workOrder.logs) ? workOrder.logs : [],
    technician_notes: form.technician_notes || form.technicianNotes || workOrder.technician_notes || "",
    updated_at: new Date().toISOString()
  });
  return workOrder;
}

function workOrdersForLead(state, leadId) {
  return (state.workOrders || []).filter((item) => item.lead_id === leadId || item.job_id === leadId);
}

function scheduleSummary(state, now = new Date()) {
  const active = (state.workOrders || []).filter((order) => !["cancelled", "completed"].includes(order.status));
  return {
    today: active.filter((order) => sameDay(order.scheduled_start, now)).length,
    tomorrow: active.filter((order) => sameDay(order.scheduled_start, addDays(now, 1))).length,
    thisWeek: active.filter((order) => inNextDays(order.scheduled_start, 7, now)).length,
    unscheduled: active.filter((order) => !order.scheduled_start || order.status === "unscheduled").length,
    digestNotSent: active.filter((order) => inNextDays(order.scheduled_start, 1, now) && !order.last_digest_sent_at).length
  };
}

function appendEventLog(workOrder, eventType, note, createdBy = "office") {
  if (!Array.isArray(workOrder.logs)) workOrder.logs = [];
  workOrder.logs.push({
    id: `work-order-log:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    event_type: eventType,
    note,
    created_by: createdBy,
    created_at: new Date().toISOString()
  });
  workOrder.updated_at = new Date().toISOString();
  return workOrder;
}

function dispatchState(workOrder = {}, { balanceOutstanding = 0 } = {}) {
  if (workOrder.status === "cancelled") return { key: "cancelled", label: "Cancelled", tone: "grey" };
  if (workOrder.status === "completed" && balanceOutstanding > 0) return { key: "balance_due", label: "Completed – balance due", tone: "red" };
  if (workOrder.status === "completed") return { key: "paid", label: "Completed & paid", tone: "green" };
  if (workOrder.technician_status === "reschedule_requested" || workOrder.status === "rescheduled") return { key: "reschedule_needed", label: "Reschedule requested", tone: "amber" };
  if (workOrder.technician_status === "arrived") return { key: "on_site", label: "On site", tone: "blue" };
  if (workOrder.technician_status === "en_route") return { key: "on_route", label: "On the way", tone: "blue" };
  if (workOrder.technician_status === "confirmed" || workOrder.status === "confirmed") return { key: "technician_confirmed", label: "Technician confirmed", tone: "green" };
  if (workOrder.technician_status === "notified") return { key: "awaiting_confirmation", label: "Awaiting technician confirmation", tone: "amber" };
  if (workOrder.status === "unscheduled" || !workOrder.scheduled_start) return { key: "needs_booking", label: "Needs booking", tone: "amber" };
  return { key: "booked", label: "Booked – notify technician", tone: "blue" };
}

function installationTodayBuckets(state = {}, leads = [], financeFor = () => 0, now = new Date()) {
  const workOrders = state.workOrders || [];
  const active = workOrders.filter((order) => !["cancelled", "completed"].includes(order.status));
  const leadById = new Map((leads || []).map((lead) => [lead.id, lead]));
  const hasActiveWorkOrder = (lead) => active.some((order) => order.lead_id === lead.id || order.job_id === lead.id);
  const leadForOrder = (order) => leadById.get(order.lead_id) || leadById.get(order.job_id);

  return {
    installsToday: active.filter((order) => sameDay(order.scheduled_start, now)),
    installsThisWeek: active.filter((order) => inNextDays(order.scheduled_start, 7, now)),
    needsBooking: (leads || []).filter((lead) =>
      lead.quote_accepted_at &&
      (lead.supplier_order_required !== "yes" || lead.supplier_actual_delivery_date) &&
      !lead.installation_completed_at &&
      !hasActiveWorkOrder(lead)
    ),
    rescheduleRequested: workOrders.filter((order) => order.technician_status === "reschedule_requested" || order.status === "rescheduled"),
    completedBalanceDue: workOrders.filter((order) => {
      const lead = leadForOrder(order);
      return order.status === "completed" && lead && financeFor(lead) > 0;
    }),
    deliveryReadyNotBooked: (leads || []).filter((lead) => lead.supplier_actual_delivery_date && !lead.installation_completed_at && !hasActiveWorkOrder(lead)),
    technicianNotNotified: active.filter((order) => inNextDays(order.scheduled_start, 7, now) && order.technician_id && order.technician_status === "not_notified"),
    technicianNotConfirmed: active.filter((order) => inNextDays(order.scheduled_start, 7, now) && order.technician_status === "notified")
  };
}

function digestForTechnician(state, technicianId = "", startDate = new Date(), days = 1) {
  const technicians = state.technicians || [];
  const technician = technicians.find((item) => item.id === technicianId) || technicians.find((item) => item.active !== false) || { id: "", name: "Technician" };
  const orders = (state.workOrders || [])
    .filter((order) => !technician.id || order.technician_id === technician.id || !order.technician_id)
    .filter((order) => inDateRange(order.scheduled_start, startDate, days))
    .sort((a, b) => String(a.scheduled_start || "").localeCompare(String(b.scheduled_start || "")));
  const title = days > 1 ? `Weekly schedule for ${technician.name}` : `Daily schedule for ${technician.name}`;
  const body = [
    title,
    "",
    ...orders.flatMap((order, index) => [
      `${index + 1}. ${dateTimeLabel(order.scheduled_start)} ${order.time_window ? `(${order.time_window})` : ""}`,
      `${order.customer_name || "Customer"} - ${order.postcode || ""}`,
      order.address ? `Address: ${order.address}` : "",
      order.customer_phone ? `Phone: ${order.customer_phone}` : "",
      `Job: ${titleCase(order.work_type)} - ${order.job_summary || "No summary"}`,
      order.access_notes ? `Access: ${order.access_notes}` : "",
      order.materials_notes ? `Materials: ${order.materials_notes}` : "",
      order.supplier_order_reference ? `Supplier/order ref: ${order.supplier_order_reference}` : "",
      ""
    ])
  ].filter((line) => line !== "").join("\n");
  return { technician, orders, title, body: orders.length ? body : `${title}\n\nNo scheduled work found.` };
}

function workOrderCalendarPayload(workOrder, appBaseUrl = "") {
  const title = `Auto Doors Yorkshire - ${titleCase(workOrder.work_type)} - ${[workOrder.customer_name, workOrder.postcode].filter(Boolean).join(" / ")}`;
  const description = [
    `Customer: ${workOrder.customer_name || ""}`,
    `Phone: ${workOrder.customer_phone || ""}`,
    `Job: ${workOrder.job_summary || ""}`,
    workOrder.access_notes ? `Access: ${workOrder.access_notes}` : "",
    workOrder.materials_notes ? `Materials: ${workOrder.materials_notes}` : "",
    workOrder.supplier_order_reference ? `Supplier/order ref: ${workOrder.supplier_order_reference}` : "",
    appBaseUrl && workOrder.lead_id ? `Dashboard: ${appBaseUrl.replace(/\/$/, "")}/leads/${encodeURIComponent(workOrder.lead_id)}` : ""
  ].filter(Boolean).join("\\n");
  return {
    uid: workOrder.calendar_event_id || `${workOrder.id}@autodoorsyorkshire.com`,
    title,
    location: [workOrder.address, workOrder.postcode].filter(Boolean).join(", "),
    description,
    start: workOrder.scheduled_start,
    end: workOrder.scheduled_end || defaultEnd(workOrder.scheduled_start)
  };
}

function generateIcs(workOrder, appBaseUrl = "", { method = "PUBLISH", sequence } = {}) {
  const event = workOrderCalendarPayload(workOrder, appBaseUrl);
  const calendarMethod = String(method || "PUBLISH").toUpperCase();
  const eventLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Autodoors Yorkshire//Dashboard//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${calendarMethod}`,
    "BEGIN:VEVENT",
    `UID:${icsEscape(workOrder.calendar_uid || `${workOrder.id}@autodoorsyorkshire.com`)}`,
    `SEQUENCE:${sequence != null ? sequence : (workOrder.calendar_sequence || 0)}`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(event.start || new Date())}`,
    `DTEND:${icsDate(event.end || defaultEnd(event.start))}`,
    `SUMMARY:${icsEscape(event.title)}`,
    `LOCATION:${icsEscape(event.location)}`,
    `DESCRIPTION:${icsEscape(event.description)}`
  ];
  if (calendarMethod === "CANCEL") eventLines.push("STATUS:CANCELLED");
  return [
    ...eventLines,
    "END:VEVENT",
    "END:VCALENDAR",
    ""
  ].join("\r\n");
}

function incrementCalendarSequence(workOrder) {
  workOrder.calendar_sequence = (workOrder.calendar_sequence || 0) + 1;
  workOrder.updated_at = new Date().toISOString();
  return workOrder;
}

function markWorkOrderSent(workOrder) {
  workOrder.status = "sent_to_technician";
  workOrder.last_digest_sent_at = new Date().toISOString();
  workOrder.updated_at = workOrder.last_digest_sent_at;
  return workOrder;
}

function markWorkOrderComplete(workOrder) {
  workOrder.status = "completed";
  workOrder.updated_at = new Date().toISOString();
  return workOrder;
}

function calendarReadiness(config = {}) {
  if (!config.calendarSyncEnabled) return { status: "disabled", warning: "Calendar sync is disabled. .ics download is available." };
  const caldav = config.caldav || {};
  if (!caldav.enabled) return { status: "disabled", warning: "CalDAV is disabled. .ics download is available." };
  if (!caldav.serverUrl || !caldav.username || !caldav.password || !caldav.calendarUrl) return { status: "warning", warning: "CalDAV is enabled but credentials are incomplete." };
  return { status: "ready", warning: "" };
}

function formatWorkOrderValue(order) {
  return `${dateTimeLabel(order.scheduled_start)} ${order.customer_name || ""} ${order.postcode || ""}`.trim();
}

function inferWorkType(lead) {
  if (/repair|service/i.test(`${lead.workflow_type || ""} ${lead.jobDescription || ""}`)) return "repair";
  if (/survey|quote/i.test(`${lead.jobDescription || ""}`)) return "survey";
  if (lead.installation_completed_at || lead.installation_scheduled_at || /install/i.test(`${lead.workflow_type || ""} ${lead.jobDescription || ""}`)) return "installation";
  return "other";
}

function normaliseWorkType(value) {
  const normalised = String(value || "other").toLowerCase().replace(/[\s-]+/g, "_");
  return WORK_TYPES.includes(normalised) ? normalised : "other";
}

function defaultEnd(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  date.setHours(date.getHours() + 2);
  return date.toISOString().slice(0, 16);
}

function sameDay(value, target) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString().slice(0, 10) === new Date(target).toISOString().slice(0, 10);
}

function inNextDays(value, days, now = new Date()) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + days + 1);
  return date >= start && date < end;
}

function inDateRange(value, startDate, days) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + days);
  return date >= start && date < end;
}

function addDays(value, days) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function dateTimeLabel(value) {
  if (!value) return "Unscheduled";
  return String(value).replace("T", " ").slice(0, 16);
}

function icsDate(value) {
  const date = new Date(value);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return safe.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function icsEscape(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function titleCase(value) {
  return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function isTrue(value) {
  return ["true", "yes", "1", "on", true].includes(String(value).toLowerCase()) || value === true;
}

module.exports = {
  WORK_ORDER_STATUSES,
  WORK_TYPES,
  TECHNICIAN_STATUSES,
  CUSTOMER_CONFIRMATION_STATUSES,
  RISK_LEVELS,
  createTechnician,
  updateTechnician,
  createWorkOrder,
  updateWorkOrder,
  workOrdersForLead,
  scheduleSummary,
  appendEventLog,
  dispatchState,
  installationTodayBuckets,
  digestForTechnician,
  workOrderCalendarPayload,
  generateIcs,
  incrementCalendarSequence,
  markWorkOrderSent,
  markWorkOrderComplete,
  calendarReadiness,
  formatWorkOrderValue
};
