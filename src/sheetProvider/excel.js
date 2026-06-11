const { writeWorkbook } = require("./xlsxWriter");
const { JOB_FIELD_DEFAULTS, ensureJobFields } = require("../jobs/jobStageEngine");
const { supplierInvoiceRows, customerPaymentRows, supplierPaymentRows, jobFinancialRows, ensureFinanceState } = require("../finance");
const { ensureOperationsState, invoiceRows } = require("../customerInvoices");

const LEAD_HEADERS = [
  "Lead ID",
  "Date/time received",
  "Source platform",
  "Original email/message ID",
  "Customer name",
  "Customer email",
  "Customer phone",
  "Customer full address",
  "Customer postcode",
  "Address verification status",
  "Royal Mail address check link",
  "Postcode priority band",
  "Customer town/area",
  "Job type",
  "Job description",
  "Garage door type",
  "Garage door issue",
  "Manual/electric/roller/up-and-over/sectional",
  "Repair/install/service/emergency category",
  "Urgency",
  "Preferred start date/timing",
  "Photos/video requested",
  "Quote day",
  "Status",
  "Priority score",
  "Priority label",
  "Next action",
  "Follow-up date",
  "Assigned person",
  "Draft reply created",
  "Draft email ID/link",
  "Draft subject",
  "Draft reply",
  "Notes",
  "Extraction confidence",
  "Missing information checklist"
];

const JOB_HEADERS = Object.keys(JOB_FIELD_DEFAULTS).map((key) => key);

function leadRow(sourceLead) {
  const lead = { ...sourceLead };
  ensureJobFields(lead);
  return [
    lead.id,
    lead.receivedAt,
    lead.sourcePlatform,
    lead.originalMessageId,
    lead.customerName,
    lead.customerEmail,
    lead.customerPhone,
    lead.customerAddress,
    lead.customerPostcode,
    lead.addressVerificationStatus,
    lead.addressVerificationUrl,
    lead.postcodePriorityBand,
    lead.customerTownArea,
    lead.jobType,
    lead.jobDescription,
    lead.garageDoorType,
    lead.garageDoorIssue,
    lead.mechanism,
    lead.category,
    lead.urgency,
    lead.preferredTiming,
    lead.photosVideoRequested,
    lead.quoteDay,
    lead.status,
    lead.priorityScore,
    lead.priorityLabel,
    lead.nextAction,
    lead.followUpDate,
    lead.assignedPerson,
    lead.draftReplyCreated,
    lead.draftEmailIdLink,
    lead.draftSubject,
    lead.draftReply,
    lead.notes,
    lead.extractionConfidence,
    lead.missingInformationChecklist,
    ...JOB_HEADERS.map((key) => lead[key] || "")
  ];
}

function count(leads, predicate) {
  return leads.filter(predicate).length;
}

function dashboardRows(leads, config) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const olderThan24 = (lead) => now - new Date(lead.receivedAt) > 24 * 60 * 60 * 1000;
  const statusCounts = [...new Set(leads.map((lead) => lead.status))].sort().map((status) => [status, count(leads, (lead) => lead.status === status)]);
  const areaCounts = [...new Set(leads.map((lead) => lead.customerPostcode || "Unknown"))]
    .sort()
    .map((area) => [area, count(leads, (lead) => (lead.customerPostcode || "Unknown") === area)]);

  return [
    ["Dashboard metric", "Value"],
    ["New leads today", count(leads, (lead) => String(lead.receivedAt).startsWith(today) && lead.status !== "Duplicate")],
    ["Leads awaiting reply", count(leads, (lead) => ["New", "Draft created", "Awaiting approval"].includes(lead.status))],
    ["Drafts awaiting approval", count(leads, (lead) => lead.draftReplyCreated === "yes" && lead.status === "Awaiting approval")],
    ["Urgent leads", count(leads, (lead) => lead.priorityLabel === "High")],
    [`${config.quoteDay} quote list`, count(leads, (lead) => lead.quoteDay === config.quoteDay && !["Duplicate", "Archived", "Lost"].includes(lead.status))],
    ["Leads older than 24 hours without response", count(leads, (lead) => olderThan24(lead) && !["Reply sent manually", "Duplicate", "Archived", "Lost"].includes(lead.status))],
    [],
    ["Leads by status", "Count"],
    ...statusCounts,
    [],
    ["Leads by area/postcode", "Count"],
    ...areaCounts
  ];
}

function settingsRows(config) {
  return [
    ["Setting", "Value"],
    ["Business name", config.businessName],
    ["Business email", config.businessEmail],
    ["Owner/helper email", config.ownerEmail],
    ["Coverage mode", config.serviceCoverage],
    ["Local priority postcodes", config.localPriorityPostcodes.join(", ")],
    ["Regional priority postcodes", config.regionalPriorityPostcodes.join(", ")],
    ["Combined priority/service postcodes", config.servicePostcodes.join(", ")],
    ["Quote day", config.quoteDay],
    ["Standard working hours", config.workingHours],
    ["Emergency wording", config.emergencyWording.join(", ")],
    ["Sender filters for Checkatrade emails", config.allowedSenders.join(", ")],
    ["Subject filters", config.subjectKeywords.join(", ")],
    ["Body filters", config.bodyKeywords.join(", ")],
    ["Reply template style", "Short, professional UK trades wording. Draft only."],
    ["Retention period", `${config.retentionMonths} months`],
    ["Follow-up delay", `${config.followUpDelayDays} days`],
    ["Automatic sending", "Disabled in this MVP"]
  ];
}

function logsRows(logs) {
  return [
    ["Timestamp", "Level", "Message", "Details"],
    ...logs.map((log) => [log.timestamp, log.level, log.message, JSON.stringify(log.details || {})])
  ];
}

function jobEventRows(events) {
  return [
    ["ID", "Lead ID", "Event type", "Event note", "Created at", "Created by", "Source email ID"],
    ...(events || []).map((event) => [event.id, event.leadId, event.eventType, event.eventNote, event.createdAt, event.createdBy, event.sourceEmailId])
  ];
}

function supplierEmailRows(emails) {
  return [
    [
      "ID",
      "Email message ID",
      "Supplier",
      "Supplier email",
      "Subject",
      "Received at",
      "Order reference",
      "Lead time",
      "Delivery date",
      "Matched lead ID",
      "Match confidence",
      "Review status",
      "Summary"
    ],
    ...(emails || []).map((email) => [
      email.id,
      email.emailMessageId,
      email.supplierName,
      email.supplierEmail,
      email.subject,
      email.receivedAt,
      email.extractedOrderReference,
      email.extractedLeadTime,
      email.extractedDeliveryDate,
      email.matchedLeadId,
      email.matchConfidence,
      email.reviewStatus,
      email.rawSummary
    ])
  ];
}

function technicianRows(technicians) {
  return [
    ["ID", "Name", "Mobile", "WhatsApp", "Email", "Calendar type", "Calendar ID", "Active", "Notes"],
    ...(technicians || []).map((item) => [item.id, item.name, item.mobile_number, item.whatsapp_number, item.email, item.calendar_type, item.calendar_identifier, item.active, item.notes])
  ];
}

function workOrderRows(workOrders) {
  return [
    ["ID", "Lead ID", "Technician ID", "Work type", "Scheduled start", "Scheduled end", "Time window", "Address", "Postcode", "Customer", "Phone", "Summary", "Access notes", "Materials notes", "Supplier ref", "Status", "Calendar event ID"],
    ...(workOrders || []).map((item) => [item.id, item.lead_id, item.technician_id, item.work_type, item.scheduled_start, item.scheduled_end, item.time_window, item.address, item.postcode, item.customer_name, item.customer_phone, item.job_summary, item.access_notes, item.materials_notes, item.supplier_order_reference, item.status, item.calendar_event_id])
  ];
}

function messageLogRows(messageLogs) {
  return [
    ["ID", "Channel", "Recipient", "Template type", "Body preview", "Status", "Provider message ID", "Error", "Sent at", "Created at"],
    ...(messageLogs || []).map((item) => [item.id, item.channel, item.recipient, item.template_type, item.body_preview, item.status, item.provider_message_id, item.error_message, item.sent_at, item.created_at])
  ];
}

function writeTrackerWorkbook(filePath, state, config) {
  ensureFinanceState(state);
  ensureOperationsState(state, config);
  const leads = state.leads || [];
  const sheets = [
    { name: "Leads", rows: [[...LEAD_HEADERS, ...JOB_HEADERS], ...leads.map(leadRow)] },
    { name: "Dashboard", rows: dashboardRows(leads, config) },
    { name: "Job Finance", rows: jobFinancialRows(leads, state) },
    { name: "Customer Payments", rows: customerPaymentRows(state.customerPayments || []) },
    { name: "Customer Invoices", rows: invoiceRows(state.customerInvoices || []) },
    { name: "Supplier Invoices", rows: supplierInvoiceRows(state.supplierInvoices || []) },
    { name: "Supplier Payments", rows: supplierPaymentRows(state.supplierPayments || []) },
    { name: "Technicians", rows: technicianRows(state.technicians || []) },
    { name: "Work Orders", rows: workOrderRows(state.workOrders || []) },
    { name: "Message Logs", rows: messageLogRows(state.messageLogs || []) },
    { name: "Job Events", rows: jobEventRows(state.jobEvents || []) },
    { name: "Supplier Emails", rows: supplierEmailRows(state.supplierEmails || []) },
    { name: "Settings", rows: settingsRows(config) },
    { name: "Logs", rows: logsRows(state.logs || []) }
  ];
  writeWorkbook(filePath, sheets);
}

module.exports = { writeTrackerWorkbook, LEAD_HEADERS, dashboardRows };
