const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");

// AY design system — loaded once at startup and injected into the page <style>.
// Tokens must come before component styles (components reference --ay-* vars).
const AY_DESIGN_TOKENS_CSS = fs.readFileSync(path.join(__dirname, "styles", "design-tokens.css"), "utf8");
const AY_COMPONENTS_CSS = fs.readFileSync(path.join(__dirname, "styles", "components.css"), "utf8");
const AY_DESIGN_SYSTEM_CSS = `${AY_DESIGN_TOKENS_CSS}\n${AY_COMPONENTS_CSS}`;
const { parseEnquiryEmail, royalMailPostcodeFinderUrl, normalisePostcode } = require("../parser");
const { scoreLead } = require("../leadScoring");
const { findDuplicate } = require("../dedupe");
const { generateDraftReply } = require("../draftGenerator");
const {
  ensureJobFields,
  queueCounts,
  todaysActions,
  relevantActions,
  evaluateWorkflow,
  applyJobAction,
  suggestedDraftType,
  deliveryOverdue,
  deliveryDueSoon
} = require("../jobs/jobStageEngine");
const { TEMPLATE_LABELS, generateCustomerUpdateDraft, deliveryText } = require("../jobs/customerUpdateTemplates");
const { processMessages } = require("../processor");
const { runCheckatradeCollection } = require("../checkatradeDashboard/runner");
const { handleWebhookPayload, verifyWebhookRequest } = require("../checkatradeWebhook/server");
const { writeTrackerWorkbook } = require("../sheetProvider/excel");
const {
  CUSTOMER_PAYMENT_METHODS,
  SUPPLIER_PAYMENT_METHODS,
  SUPPLIER_PAYMENT_STATUSES,
  ensureFinanceState,
  createCustomerPayment,
  createSupplierInvoice,
  createSupplierPayment,
  updateSupplierInvoice,
  applySupplierPayment,
  jobFinancials,
  financeSummary,
  calculateFinancialWarnings,
  calculateSupplierInvoiceBalance,
  supplierInvoiceRows,
  customerPaymentRows,
  supplierPaymentRows,
  jobFinancialRows,
  toCsv,
  formatMoney,
  money
} = require("../finance");
const {
  INVOICE_STATUSES,
  INVOICE_TYPES,
  ensureOperationsState,
  updateCompanySettings,
  companySetupWarnings,
  createCustomerInvoice,
  createInvoiceFromLead,
  issueInvoice,
  markInvoicePaid,
  archiveInvoice,
  voidInvoice,
  calculateInvoiceTotals,
  invoiceSummary,
  activeInvoices,
  invoicesForLead,
  generateInvoicePdf,
  invoiceEmailDraft,
  invoiceRows
} = require("../customerInvoices");
const {
  WORK_ORDER_STATUSES,
  WORK_TYPES,
  createTechnician,
  updateTechnician,
  createWorkOrder,
  updateWorkOrder,
  appendEventLog,
  workOrdersForLead,
  dispatchState,
  installationTodayBuckets,
  TECHNICIAN_STATUSES,
  scheduleSummary,
  digestForTechnician,
  generateIcs,
  incrementCalendarSequence,
  markWorkOrderSent,
  markWorkOrderComplete,
  calendarReadiness,
  formatWorkOrderValue
} = require("../schedule");
const { messagingStatus, sendSms, sendWhatsApp, whatsappLink } = require("../messageProvider");
const { ensureMessageQueue, queueTechnicianNotification } = require("../messageQueue");

const STATUSES = [
  "New",
  "Draft created",
  "Awaiting approval",
  "Needs call",
  "Awaiting photos",
  "Quote booked",
  "Replied",
  "Follow-up due",
  "Quoted",
  "Won",
  "Installation completed",
  "Paid",
  "Review requested",
  "Closed",
  "Lost",
  "Out of area",
  "Duplicate",
  "Archived"
];

const COOKIE_NAME = "ady_session";
const SESSION_EXPIRY_SECONDS = 7 * 24 * 3600;
const MESSAGE_STATUS_BADGE_TONES = {
  sent: "green",
  failed: "red",
  queued: "blue",
  awaiting_approval: "amber",
  draft: "gray",
  disabled: "gray",
  cancelled: "gray"
};
const MESSAGE_CHANNEL_LABELS = {
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp"
};
const TECH_NOTIFICATION_TEMPLATE_LABELS = {
  new_assignment: "New job assigned",
  reminder: "Reminder",
  reschedule: "Schedule change",
  cancellation: "Cancellation",
  urgent_issue: "Urgent issue"
};

function startAppServer({ config, store, logger }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/health") return json(res, 200, { ok: true, service: "auto-doors-yorkshire-enquiry-manager" });
      if (url.pathname === "/webhooks/checkatrade" && req.method === "POST") {
        return handleWebhook(req, res, { config, store, logger });
      }
      if (url.pathname === "/login" && req.method === "GET") return html(res, loginPage(url.searchParams.get("next") || "/today"));
      if (url.pathname === "/login" && req.method === "POST") return handleLogin(req, res, config);
      if (url.pathname === "/") return redirect(res, "/today");
      if (!authorised(req, config)) return authChallenge(res, url.pathname + url.search);
      if (url.pathname === "/logout" && req.method === "POST") return handleLogout(res);
      ensureFinanceState(store.state);
      ensureOperationsState(store.state, config);

      const activeStore = config.demoMode || url.searchParams.get("demo") === "true" ? demoStore(config) : store;
      if (config.demoMode && req.method !== "GET") {
        return html(res, pageShell("Demo Mode", `${demoBanner()}<p>Demo mode is read-only. Switch DEMO_MODE=false before processing live leads, payments, invoices or supplier emails.</p><p><a class="button" href="/demo">Back to demo</a></p>`));
      }
      if (url.pathname === "/dashboard" && req.method === "GET") return html(res, dashboardPage(activeStore.state.leads || [], config, activeStore.state.supplierEmails || [], activeStore));
      if (url.pathname === "/today" && req.method === "GET") return html(res, todayPage(config, activeStore));
      if (url.pathname === "/demo" && req.method === "GET") return html(res, demoPage(config));
      if (url.pathname === "/setup" && req.method === "GET") return html(res, setupWizardPage(config, store));
      if (url.pathname === "/status" && req.method === "GET") return html(res, statusPage(config, activeStore));
      if (url.pathname === "/system" && req.method === "GET") return html(res, systemPage(config, activeStore));
      if (url.pathname === "/settings" && req.method === "GET") return html(res, settingsPage(config, store));
      if (url.pathname === "/settings/company" && req.method === "POST") return updateSettings(req, res, { config, store, logger });
      if (url.pathname === "/invoices" && req.method === "GET") return html(res, invoicesPage(config, activeStore, url.searchParams));
      if (url.pathname === "/invoices/new" && req.method === "GET") return html(res, newInvoicePage(config, activeStore, url.searchParams));
      if (url.pathname === "/invoices/create" && req.method === "POST") return createCustomerInvoiceFromRequest(req, res, { config, store, logger });
      if (url.pathname.startsWith("/invoices/") && req.method === "GET") return invoiceGet(req, res, { config, store, logger }, url.pathname);
      if (url.pathname.startsWith("/invoices/") && req.method === "POST") return invoicePost(req, res, { config, store, logger }, url.pathname);
      if (url.pathname === "/money" && req.method === "GET") return html(res, moneyPage(config, activeStore));
      if (url.pathname === "/finance" && req.method === "GET") return html(res, financePage(config, activeStore));
      if (url.pathname === "/supplier-invoices" && req.method === "GET") return html(res, supplierInvoicesPage(config, activeStore, url.searchParams));
      if (url.pathname === "/finance/supplier-invoices" && req.method === "POST") return createSupplierInvoiceFromRequest(req, res, { config, store, logger });
      if (url.pathname.startsWith("/finance/supplier-invoices/") && req.method === "POST") return updateSupplierInvoiceFromRequest(req, res, { config, store, logger }, url.pathname);
      if (url.pathname === "/finance/customer-payments" && req.method === "POST") return createCustomerPaymentFromRequest(req, res, { config, store, logger });
      if (url.pathname.startsWith("/finance/customer-payments/") && req.method === "POST") return updateCustomerPaymentFromRequest(req, res, { config, store, logger }, url.pathname);
      if (url.pathname === "/finance/supplier-payments" && req.method === "POST") return createSupplierPaymentFromRequest(req, res, { config, store, logger });
      if (url.pathname.startsWith("/finance/supplier-payments/") && req.method === "POST") return updateSupplierPaymentFromRequest(req, res, { config, store, logger }, url.pathname);
      if (url.pathname === "/system/clear-activity" && req.method === "POST") return clearActivity(req, res, { config, store, logger });
      if (url.pathname === "/system/reset-supplier-finance" && req.method === "POST") return resetSupplierFinance(req, res, { config, store, logger });
      if (url.pathname === "/export/tracker" && req.method === "GET") return exportTracker(res, { config, store: activeStore });
      if (url.pathname === "/export/leads.csv" && req.method === "GET") return exportCsv(res, "leads.csv", leadCsvRows(activeStore.state.leads || []));
      if (url.pathname === "/export/jobs.csv" && req.method === "GET") return exportCsv(res, "jobs.csv", jobFinancialRows(activeStore.state.leads || [], activeStore.state));
      if (url.pathname === "/export/payments.csv" && req.method === "GET") return exportCsv(res, "payments.csv", customerPaymentRows((activeStore.state.customerPayments || []).filter((payment) => !payment.archivedAt)));
      if (url.pathname === "/export/supplier-payments.csv" && req.method === "GET") return exportCsv(res, "supplier-payments.csv", supplierPaymentRows((activeStore.state.supplierPayments || []).filter((payment) => !payment.archivedAt)));
      if (url.pathname === "/export/supplier-invoices.csv" && req.method === "GET") return exportCsv(res, "supplier-invoices.csv", supplierInvoiceRows((activeStore.state.supplierInvoices || []).filter((invoice) => !invoice.archivedAt)));
      if (url.pathname === "/export/customer-invoices.csv" && req.method === "GET") return exportCsv(res, "customer-invoices.csv", invoiceRows(activeInvoices(activeStore.state)));
      if (url.pathname === "/export/supplier-emails.csv" && req.method === "GET") return exportCsv(res, "supplier-emails.csv", supplierEmailRows(activeStore.state.supplierEmails || []));
      if (url.pathname === "/export/all-data.json" && req.method === "GET") return exportJson(res, "auto-doors-yorkshire-data.json", safeExportState(activeStore.state || {}));
      if (url.pathname === "/exports" && req.method === "GET") return html(res, exportsPage(config, activeStore));
      if (url.pathname === "/jobs" && req.method === "GET") return html(res, jobsPage(filterLeads(activeStore.state.leads || [], url.searchParams), url.searchParams, activeStore.state));
      if (url.pathname === "/leads" && req.method === "GET") return html(res, leadsPage(filterLeads(activeStore.state.leads || [], url.searchParams), url.searchParams, activeStore.state));
      if (url.pathname === "/installations" && req.method === "GET") return html(res, installationsPage(activeStore.state.leads || [], activeStore.state, url.searchParams));
      if (url.pathname === "/technician-schedule" && req.method === "GET") return html(res, technicianSchedulePage(config, activeStore, url.searchParams));
      if (url.pathname === "/technician-schedule/daily" && req.method === "GET") return html(res, technicianDigestPage(config, activeStore, 1, url.searchParams));
      if (url.pathname === "/technician-schedule/weekly" && req.method === "GET") return html(res, technicianDigestPage(config, activeStore, 7, url.searchParams));
      if (url.pathname === "/technicians" && req.method === "POST") return saveTechnician(req, res, { config, store, logger });
      if (url.pathname === "/work-orders/create" && req.method === "POST") return saveWorkOrder(req, res, { config, store, logger });
      if (url.pathname.startsWith("/work-orders/") && req.method === "GET") return workOrderGet(req, res, { config, store, logger }, url.pathname);
      if (url.pathname.startsWith("/work-orders/") && req.method === "POST") return workOrderPost(req, res, { config, store, logger }, url.pathname);
      if (url.pathname === "/leads/bulk" && req.method === "POST") return bulkUpdateLeads(req, res, { config, store, logger });
      if (url.pathname.startsWith("/leads/") && req.method === "GET") return html(res, leadDetailPage(findLead(activeStore, url.pathname), config, activeStore.state));
      if (url.pathname.startsWith("/leads/") && req.method === "POST") return updateLead(req, res, { config, store }, url.pathname);
      if (url.pathname === "/supplier-emails" && req.method === "GET") return html(res, supplierEmailsPage(activeStore.state.supplierEmails || [], activeStore.state.leads || [], url.searchParams));
      if (url.pathname.startsWith("/supplier-emails/") && req.method === "GET") return html(res, supplierEmailDetailPage(findSupplierEmail(activeStore, url.pathname), activeStore.state.leads || []));
      if (url.pathname.startsWith("/supplier-emails/") && req.method === "POST") return updateSupplierEmail(req, res, { config, store, logger }, url.pathname);
      if (url.pathname === "/manual-lead" && req.method === "GET") return html(res, manualLeadPage());
      if (url.pathname === "/manual-lead" && req.method === "POST") return createManualLead(req, res, { config, store, logger });
      if (url.pathname === "/sync/email" && req.method === "POST") return syncEmail(res, { config, store, logger });
      if (url.pathname === "/sync/checkatrade" && req.method === "POST") return syncCheckatrade(res, { config, store, logger });
      res.writeHead(404);
      res.end("Not found");
    } catch (error) {
      logger.error("Admin app request failed", { path: url.pathname, error: error.message });
      html(res, pageShell("Error", `<p>${escapeHtml(error.message)}</p><p><a href="/dashboard">Back to dashboard</a></p>`), 500);
    }
  });
  const listenHost = config.appPort === 0 ? undefined : "0.0.0.0";
  server.listen(config.appPort, listenHost, () => {
    console.log(`Auto Doors Yorkshire dashboard listening on http://localhost:${config.appPort}/dashboard`);
  });
  return server;
}

async function handleWebhook(req, res, { config, store, logger }) {
  const rawBody = await readBodyBuffer(req);
  const verification = verifyWebhookRequest(req, rawBody, config);
  if (!verification.ok) {
    logger.warn("Rejected Checkatrade webhook request", { mode: verification.mode, sourceIp: verification.sourceIp || "" });
    res.writeHead(401);
    res.end("Webhook request not authorised");
    return;
  }
  const payload = JSON.parse(rawBody.toString("utf8"));
  const lead = await handleWebhookPayload(payload, { config, store });
  json(res, 200, { accepted: true, leadId: lead.id, status: lead.status });
}

async function createManualLead(req, res, { config, store, logger }) {
  const form = await readForm(req);
  const body = [
    `Customer name: ${form.customerName || ""}`,
    `Customer email: ${form.customerEmail || ""}`,
    `Customer phone: ${form.customerPhone || ""}`,
    `Customer address: ${form.customerAddress || ""}`,
    `Postcode: ${form.postcode || ""}`,
    `Town: ${form.location || ""}`,
    `Message: ${form.message || ""}`
  ].join("\n");
  const message = {
    id: `manual:${Date.now()}`,
    from: "manual-lead",
    subject: "Manual enquiry",
    receivedAt: new Date().toISOString(),
    body,
    sourcePlatform: form.source || "Manual lead"
  };
  const lead = prepareLead(parseEnquiryEmail(message, config), config, store);
  if (form.notes) lead.notes = form.notes;
  if (!config.dryRun) {
    store.addLead(lead);
    store.markProcessed(message.id);
    store.addLog("info", "Manual lead created", { leadId: lead.id, status: lead.status });
    await store.save();
    writeTrackerWorkbook(config.trackerXlsxPath, store.state, config);
  }
  redirect(res, `/leads/${encodeURIComponent(lead.id)}${config.dryRun ? "?dryRun=true" : ""}`);
}

function prepareLead(lead, config, store) {
  const duplicate = findDuplicate(lead, store.state.leads || []);
  if (duplicate) {
    lead.status = "Duplicate";
    lead.notes = `Possible duplicate of ${duplicate.existing.id}: ${duplicate.reason}`;
    lead.priorityScore = 0;
    lead.priorityLabel = "Low";
    ensureJobFields(lead);
    return lead;
  }
  Object.assign(lead, scoreLead(lead, config));
  const draft = generateDraftReply(lead, config);
  lead.status = lead.missingInformationChecklist ? "Awaiting photos" : "Awaiting approval";
  lead.nextAction = lead.missingInformationChecklist ? "Ask for missing details/photos" : "Review draft reply";
  lead.draftSubject = draft.subject;
  lead.draftReply = draft.body;
  lead.draftReplyCreated = "yes";
  lead.draftEmailIdLink = "Stored in tracker for review";
  ensureJobFields(lead);
  return lead;
}

function cleanFormText(value) {
  return String(value || "").trim();
}

function customerDetailsSnapshot(lead = {}) {
  return {
    customerName: lead.customerName || "",
    customerEmail: lead.customerEmail || "",
    customerPhone: lead.customerPhone || "",
    customerAddress: lead.customerAddress || "",
    customerPostcode: lead.customerPostcode || "",
    customerTownArea: lead.customerTownArea || "",
    sourcePlatform: lead.sourcePlatform || "",
    addressVerificationStatus: lead.addressVerificationStatus || ""
  };
}

function customerDetailsChangeNote(before, after) {
  const labels = {
    customerName: "name",
    customerEmail: "email",
    customerPhone: "phone",
    customerAddress: "address",
    customerPostcode: "postcode",
    customerTownArea: "location",
    sourcePlatform: "source",
    addressVerificationStatus: "address check"
  };
  const changed = Object.keys(labels).filter((key) => String(before[key] || "") !== String(after[key] || ""));
  return changed.length ? `Updated ${changed.map((key) => labels[key]).join(", ")}` : "Customer details reviewed";
}

function syncLeadCustomerSnapshots(state, lead) {
  for (const order of state.workOrders || []) {
    if (order.lead_id !== lead.id) continue;
    order.customer_name = lead.customerName || order.customer_name || "";
    order.customer_phone = lead.customerPhone || order.customer_phone || "";
    order.address = lead.customerAddress || order.address || "";
    order.postcode = lead.customerPostcode || order.postcode || "";
    order.updated_at = new Date().toISOString();
  }
  for (const invoice of state.customerInvoices || []) {
    if (invoice.lead_id !== lead.id || invoice.status !== "draft") continue;
    invoice.customer_name = lead.customerName || invoice.customer_name || "";
    invoice.customer_email = lead.customerEmail || invoice.customer_email || "";
    invoice.customer_phone = lead.customerPhone || invoice.customer_phone || "";
    invoice.customer_billing_address = lead.customerAddress || invoice.customer_billing_address || "";
    invoice.customer_postcode = lead.customerPostcode || invoice.customer_postcode || "";
    invoice.updated_at = new Date().toISOString();
  }
}

async function updateLead(req, res, { config, store }, pathname) {
  const lead = findLead(store, pathname);
  const form = await readForm(req);
  if (!lead) return redirect(res, "/leads");
  if (form.workflowAction) {
    applyJobAction(lead, form.workflowAction, form);
    if (form.workflowAction === "mark_deposit_received") {
      addCustomerPaymentIfNew(store, createCustomerPayment({ ...form, payment_type: "deposit", amount: form.deposit_amount }, lead.id));
    }
    if (form.workflowAction === "mark_balance_paid") {
      addCustomerPaymentIfNew(store, createCustomerPayment({ ...form, payment_type: "balance", amount: form.balance_amount }, lead.id));
    }
    store.addJobEvent({
      leadId: lead.id,
      eventType: form.workflowAction,
      eventNote: actionLabel(form.workflowAction),
      createdBy: "dashboard"
    });
    store.addLog("info", "Job action applied from dashboard", { leadId: lead.id, action: form.workflowAction });
  } else {
    const fieldValue = (name, fallback = "") => Object.prototype.hasOwnProperty.call(form, name) ? cleanFormText(form[name]) : cleanFormText(fallback);
    const customerPostcode = normalisePostcode(fieldValue("customerPostcode", lead.customerPostcode));
    const customerAddress = fieldValue("customerAddress", lead.customerAddress);
    const patch = {
      customerName: fieldValue("customerName", lead.customerName),
      customerEmail: fieldValue("customerEmail", lead.customerEmail),
      customerPhone: fieldValue("customerPhone", lead.customerPhone),
      customerAddress,
      customerPostcode,
      postcode: customerPostcode,
      customerTownArea: fieldValue("customerTownArea", lead.customerTownArea),
      sourcePlatform: fieldValue("sourcePlatform", lead.sourcePlatform),
      status: fieldValue("status", lead.status) || lead.status,
      addressVerificationStatus: fieldValue("addressVerificationStatus", lead.addressVerificationStatus),
      addressVerificationUrl: royalMailPostcodeFinderUrl(customerPostcode || customerAddress),
      notes: fieldValue("notes", lead.notes),
      followUpDate: fieldValue("followUpDate", lead.followUpDate),
      updatedAt: new Date().toISOString()
    };
    const previous = customerDetailsSnapshot(lead);
    const updated = store.updateLead(lead.id, patch);
    Object.assign(updated, scoreLead(updated, config));
    ensureJobFields(updated);
    syncLeadCustomerSnapshots(store.state, updated);
    store.addJobEvent({
      leadId: updated.id,
      eventType: "customer_details_updated",
      eventNote: customerDetailsChangeNote(previous, customerDetailsSnapshot(updated)),
      createdBy: "dashboard"
    });
    store.addLog("info", "Lead customer details updated from dashboard", { leadId: updated.id, status: updated.status });
  }
  await store.save();
  writeTrackerWorkbook(config.trackerXlsxPath, store.state, config);
  redirect(res, `/leads/${encodeURIComponent(lead.id)}`);
}

async function bulkUpdateLeads(req, res, { config, store, logger }) {
  const form = await readForm(req);
  const selectedIds = arrayValue(form.leadId).filter(Boolean);
  if (!selectedIds.length) return redirect(res, "/leads");

  const selected = (store.state.leads || []).filter((lead) => selectedIds.includes(lead.id));
  const now = new Date().toISOString();
  const action = form.bulkAction;
  if (action === "delete") {
    const selectedSet = new Set(selectedIds);
    store.state.leads = (store.state.leads || []).filter((lead) => !selectedSet.has(lead.id));
    store.state.jobEvents = (store.state.jobEvents || []).filter((event) => !selectedSet.has(event.leadId));
    for (const email of store.state.supplierEmails || []) {
      if (selectedSet.has(email.matchedLeadId)) {
        email.matchedLeadId = "";
        email.reviewStatus = "Needs review";
        email.matchReason = "Matched lead was deleted";
      }
    }
    store.addLog("warn", "Bulk leads permanently deleted", { leadIds: selectedIds });
  } else if (action === "archive") {
    for (const lead of selected) {
      store.updateLead(lead.id, { status: "Archived", archivedAt: now, nextAction: "Archived", next_best_action: "Archived" });
    }
    store.addLog("info", "Bulk leads archived", { leadIds: selectedIds });
  } else if (action === "restore") {
    for (const lead of selected) {
      const nextAction = lead.draftReply ? "Review draft reply" : "Review lead";
      store.updateLead(lead.id, { status: "Awaiting approval", archivedAt: "", nextAction, next_best_action: nextAction });
    }
    store.addLog("info", "Bulk leads restored", { leadIds: selectedIds });
  } else if (action === "set_status" && STATUSES.includes(form.targetStatus)) {
    for (const lead of selected) {
      const nextAction = nextActionForStatus(form.targetStatus, lead);
      store.updateLead(lead.id, { status: form.targetStatus, nextAction, next_best_action: nextAction });
    }
    store.addLog("info", "Bulk leads moved to status", { leadIds: selectedIds, status: form.targetStatus });
  }

  await store.save();
  writeTrackerWorkbook(config.trackerXlsxPath, store.state, config);
  logger.info("Bulk lead action applied", { action, selected: selectedIds.length });
  redirect(res, "/leads");
}

async function createSupplierInvoiceFromRequest(req, res, { config, store, logger }) {
  const form = await readForm(req);
  ensureFinanceState(store.state);
  const invoice = createSupplierInvoice(form);
  store.state.supplierInvoices.push(invoice);
  if (money(invoice.amountPaid) > 0) {
    const payment = createSupplierPayment({ ...form, invoiceId: invoice.id, amount: invoice.amountPaid, paid_at: invoice.paidAt || form.paid_at }, invoice);
    applySupplierPayment(invoice, store.state, payment);
  }
  store.addJobEvent({ leadId: invoice.leadId, eventType: "supplier_invoice_recorded", eventNote: `Supplier invoice ${invoice.invoiceReference || invoice.id} recorded`, createdBy: "dashboard" });
  store.addLog("info", "Supplier invoice recorded", { invoiceId: invoice.id, leadId: invoice.leadId });
  await store.save();
  writeTrackerWorkbook(config.trackerXlsxPath, store.state, config);
  logger.info("Supplier invoice recorded", { invoiceId: invoice.id });
  redirect(res, invoice.leadId ? `/leads/${encodeURIComponent(invoice.leadId)}` : "/finance");
}

async function createSupplierPaymentFromRequest(req, res, { config, store, logger }) {
  const form = await readForm(req);
  ensureFinanceState(store.state);
  const invoice = (store.state.supplierInvoices || []).find((item) => item.id === (form.invoiceId || form.invoice_id));
  if (!invoice) return redirect(res, "/finance");
  const payment = createSupplierPayment(form, invoice);
  applySupplierPayment(invoice, store.state, payment);
  store.addJobEvent({ leadId: invoice.leadId, eventType: "supplier_payment_recorded", eventNote: `Supplier payment ${formatMoney(payment.amount)} recorded`, createdBy: "dashboard" });
  store.addLog("info", "Supplier payment recorded", { paymentId: payment.id, invoiceId: invoice.id, leadId: invoice.leadId });
  await store.save();
  writeTrackerWorkbook(config.trackerXlsxPath, store.state, config);
  logger.info("Supplier payment recorded", { paymentId: payment.id, invoiceId: invoice.id });
  redirect(res, invoice.leadId ? `/leads/${encodeURIComponent(invoice.leadId)}` : "/finance");
}

async function updateSupplierInvoiceFromRequest(req, res, { config, store, logger }, pathname) {
  const invoice = findSupplierInvoice(store, pathname);
  if (!invoice) return redirect(res, "/finance");
  const form = await readForm(req);
  const action = pathname.split("/").filter(Boolean)[3] || "edit";
  ensureFinanceState(store.state);
  if (action === "delete") {
    store.state.supplierInvoices = (store.state.supplierInvoices || []).filter((item) => item.id !== invoice.id);
    store.addLog("warn", "Supplier invoice deleted", { invoiceId: invoice.id, leadId: invoice.leadId });
  } else if (action === "archive") {
    Object.assign(invoice, { archivedAt: new Date().toISOString(), paymentStatus: "Archived", updatedAt: new Date().toISOString() });
    store.addLog("info", "Supplier invoice archived", { invoiceId: invoice.id, leadId: invoice.leadId });
  } else {
    updateSupplierInvoice(invoice, form);
    if (form.amount_paid !== undefined || form.amountPaid !== undefined) {
      store.state.supplierPayments = (store.state.supplierPayments || []).filter((payment) => payment.invoiceId !== invoice.id);
      const replacementPayment = createSupplierPayment({ ...form, invoiceId: invoice.id, amount: form.amount_paid || form.amountPaid, paid_at: form.paid_at || form.paidAt }, invoice);
      if (money(replacementPayment.amount) > 0) store.state.supplierPayments.push(replacementPayment);
    }
    applySupplierPayment(invoice, store.state);
    store.addLog("info", "Supplier invoice updated", { invoiceId: invoice.id, leadId: invoice.leadId });
  }
  store.addJobEvent({ leadId: invoice.leadId, eventType: `supplier_invoice_${action}`, eventNote: `Supplier invoice ${invoice.invoiceReference || invoice.id} ${action}`, createdBy: "dashboard" });
  await store.save();
  writeTrackerWorkbook(config.trackerXlsxPath, store.state, config);
  logger.info("Supplier invoice action applied", { action, invoiceId: invoice.id });
  redirect(res, invoice.leadId ? `/leads/${encodeURIComponent(invoice.leadId)}` : "/finance");
}

async function createCustomerPaymentFromRequest(req, res, { config, store, logger }) {
  const form = await readForm(req);
  ensureFinanceState(store.state);
  const payment = createCustomerPayment(form, form.leadId || form.lead_id);
  addCustomerPaymentIfNew(store, payment);
  store.addJobEvent({ leadId: payment.leadId, eventType: "customer_payment_recorded", eventNote: `${payment.paymentType} payment recorded`, createdBy: "dashboard" });
  store.addLog("info", "Customer payment recorded", { paymentId: payment.id, leadId: payment.leadId });
  await store.save();
  writeTrackerWorkbook(config.trackerXlsxPath, store.state, config);
  logger.info("Customer payment recorded", { paymentId: payment.id });
  redirect(res, payment.leadId ? `/leads/${encodeURIComponent(payment.leadId)}` : "/finance");
}

async function updateCustomerPaymentFromRequest(req, res, { config, store, logger }, pathname) {
  const payment = findCustomerPayment(store, pathname);
  if (!payment) return redirect(res, "/finance");
  const form = await readForm(req);
  const action = pathname.split("/").filter(Boolean)[3] || "edit";
  ensureFinanceState(store.state);
  if (action === "delete") {
    store.state.customerPayments = (store.state.customerPayments || []).filter((item) => item.id !== payment.id);
    store.addLog("warn", "Customer payment deleted", { paymentId: payment.id, leadId: payment.leadId });
  } else if (action === "archive") {
    Object.assign(payment, { archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    store.addLog("info", "Customer payment archived", { paymentId: payment.id, leadId: payment.leadId });
  } else if (action === "restore") {
    Object.assign(payment, { archivedAt: "", updatedAt: new Date().toISOString() });
    store.addLog("info", "Customer payment restored", { paymentId: payment.id, leadId: payment.leadId });
  } else {
    Object.assign(payment, {
      leadId: form.leadId || form.lead_id || payment.leadId,
      paymentType: form.payment_type || form.paymentType || payment.paymentType,
      amount: money(form.amount),
      paymentMethod: form.payment_method || form.paymentMethod || payment.paymentMethod || "Unknown",
      paymentDate: form.payment_date || form.paymentDate || payment.paymentDate,
      reference: form.reference || payment.reference || "",
      notes: form.notes || "",
      updatedAt: new Date().toISOString()
    });
    store.addLog("info", "Customer payment updated", { paymentId: payment.id, leadId: payment.leadId });
  }
  store.addJobEvent({ leadId: payment.leadId, eventType: `customer_payment_${action}`, eventNote: `Customer payment ${action}`, createdBy: "dashboard" });
  await store.save();
  writeTrackerWorkbook(config.trackerXlsxPath, store.state, config);
  logger.info("Customer payment action applied", { action, paymentId: payment.id });
  redirect(res, payment.leadId ? `/leads/${encodeURIComponent(payment.leadId)}` : "/finance");
}

async function updateSupplierPaymentFromRequest(req, res, { config, store, logger }, pathname) {
  const payment = findSupplierPayment(store, pathname);
  if (!payment) return redirect(res, "/finance");
  const form = await readForm(req);
  const action = pathname.split("/").filter(Boolean)[3] || "edit";
  ensureFinanceState(store.state);
  const originalInvoiceId = payment.invoiceId;
  if (action === "delete") {
    store.state.supplierPayments = (store.state.supplierPayments || []).filter((item) => item.id !== payment.id);
    store.addLog("warn", "Supplier payment deleted", { paymentId: payment.id, invoiceId: payment.invoiceId, leadId: payment.leadId });
  } else if (action === "archive") {
    Object.assign(payment, { archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    store.addLog("info", "Supplier payment archived", { paymentId: payment.id, invoiceId: payment.invoiceId, leadId: payment.leadId });
  } else if (action === "restore") {
    Object.assign(payment, { archivedAt: "", updatedAt: new Date().toISOString() });
    store.addLog("info", "Supplier payment restored", { paymentId: payment.id, invoiceId: payment.invoiceId, leadId: payment.leadId });
  } else {
    const invoice = (store.state.supplierInvoices || []).find((item) => item.id === (form.invoiceId || form.invoice_id || payment.invoiceId)) || {};
    Object.assign(payment, {
      invoiceId: form.invoiceId || form.invoice_id || payment.invoiceId,
      leadId: form.leadId || form.lead_id || invoice.leadId || payment.leadId,
      supplierName: form.supplier_name || form.supplierName || invoice.supplierName || payment.supplierName || "",
      amount: money(form.amount),
      paymentMethod: form.payment_method || form.paymentMethod || payment.paymentMethod || "Unknown",
      paidAt: form.paid_at || form.paidAt || form.payment_date || payment.paidAt,
      reference: form.reference || payment.reference || "",
      notes: form.notes || "",
      updatedAt: new Date().toISOString()
    });
    store.addLog("info", "Supplier payment updated", { paymentId: payment.id, invoiceId: payment.invoiceId, leadId: payment.leadId });
  }
  recalculateSupplierInvoices(store.state, [originalInvoiceId, payment.invoiceId]);
  store.addJobEvent({ leadId: payment.leadId, eventType: `supplier_payment_${action}`, eventNote: `Supplier payment ${action}`, createdBy: "dashboard" });
  await store.save();
  writeTrackerWorkbook(config.trackerXlsxPath, store.state, config);
  logger.info("Supplier payment action applied", { action, paymentId: payment.id });
  redirect(res, payment.leadId ? `/leads/${encodeURIComponent(payment.leadId)}` : "/finance");
}

async function clearActivity(req, res, { config, store, logger }) {
  store.state.logs = [];
  store.state.jobEvents = [];
  await store.save();
  writeTrackerWorkbook(config.trackerXlsxPath, store.state, config);
  logger.info("Dashboard activity feed cleared");
  redirect(res, "/dashboard");
}

async function resetSupplierFinance(req, res, { config, store, logger }) {
  ensureFinanceState(store.state);
  const now = new Date().toISOString();
  for (const invoice of store.state.supplierInvoices || []) {
    if (!invoice.archivedAt) Object.assign(invoice, { archivedAt: now, paymentStatus: "Archived", updatedAt: now });
  }
  for (const payment of store.state.supplierPayments || []) {
    if (!payment.archivedAt) Object.assign(payment, { archivedAt: now, updatedAt: now });
  }
  store.state.logs = [];
  store.state.jobEvents = [];
  await store.save();
  writeTrackerWorkbook(config.trackerXlsxPath, store.state, config);
  logger.info("Supplier finance test data archived and activity cleared");
  redirect(res, "/dashboard");
}

async function updateSettings(req, res, { config, store, logger }) {
  const form = await readForm(req);
  ensureOperationsState(store.state, config);
  updateCompanySettings(store.state, form, config);
  store.addLog("info", "Company invoice settings updated", { section: "settings" });
  await store.save();
  logger.info("Company invoice settings updated");
  redirect(res, "/settings");
}

async function createCustomerInvoiceFromRequest(req, res, { config, store, logger }) {
  const form = await readForm(req);
  ensureOperationsState(store.state, config);
  const lead = (store.state.leads || []).find((item) => item.id === (form.leadId || form.lead_id || form.job_id || form.jobId)) || {};
  const invoice = createCustomerInvoice(form, lead, store.state, config);
  store.addJobEvent({ leadId: invoice.lead_id, eventType: "invoice_created", eventNote: `${invoice.invoice_type} invoice draft created`, createdBy: "dashboard" });
  store.addLog("info", "Customer invoice draft created", { invoiceId: invoice.invoice_id, leadId: invoice.lead_id });
  await store.save();
  logger.info("Customer invoice draft created", { invoiceId: invoice.invoice_id });
  redirect(res, `/invoices/${encodeURIComponent(invoice.invoice_id)}`);
}

function invoiceGet(req, res, { config, store }, pathname) {
  const invoice = findCustomerInvoice(store, pathname);
  if (!invoice) return html(res, pageShell("Invoice not found", `<p>Invoice not found.</p><p><a class="button" href="/invoices">Back to invoices</a></p>`), 404);
  if (pathname.endsWith("/pdf")) {
    const filePath = invoice.pdf_path && fs.existsSync(invoice.pdf_path) ? invoice.pdf_path : generateInvoicePdf(invoice, store.state.companySettings, config);
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "content-type": "application/pdf", "content-disposition": `inline; filename="${escapeHeader(invoice.invoice_number || invoice.invoice_id)}.pdf"` });
    res.end(content);
    return;
  }
  html(res, invoiceDetailPage(invoice, config, store));
}

async function invoicePost(req, res, { config, store, logger }, pathname) {
  const invoice = findCustomerInvoice(store, pathname);
  if (!invoice) return redirect(res, "/invoices");
  const action = pathname.split("/").filter(Boolean)[2] || "edit";
  const form = await readForm(req);
  ensureOperationsState(store.state, config);
  if (action === "issue") {
    issueInvoice(invoice, store.state, config);
    store.addJobEvent({ leadId: invoice.lead_id, eventType: "invoice_issued", eventNote: `Invoice ${invoice.invoice_number} issued`, createdBy: "dashboard" });
  } else if (action === "mark-paid") {
    markInvoicePaid(invoice, form.amount || invoice.amount_outstanding, form.payment_date);
    const payment = createCustomerPayment({
      leadId: invoice.lead_id,
      payment_type: invoice.invoice_type === "deposit" ? "deposit" : invoice.invoice_type === "balance" ? "balance" : "part_payment",
      amount: form.amount || invoice.total_gross,
      payment_method: form.payment_method || "Bank transfer",
      payment_date: form.payment_date || new Date().toISOString().slice(0, 10),
      reference: form.reference || invoice.invoice_number,
      notes: `Payment recorded against invoice ${invoice.invoice_number || invoice.invoice_id}`
    }, invoice.lead_id);
    addCustomerPaymentIfNew(store, payment);
    store.addJobEvent({ leadId: invoice.lead_id, eventType: "invoice_marked_paid", eventNote: `Invoice payment ${formatMoney(payment.amount)} recorded`, createdBy: "dashboard" });
  } else if (action === "archive") {
    archiveInvoice(invoice);
    store.addJobEvent({ leadId: invoice.lead_id, eventType: "invoice_archived", eventNote: `Invoice ${invoice.invoice_number || invoice.invoice_id} archived`, createdBy: "dashboard" });
  } else if (action === "void") {
    voidInvoice(invoice);
    store.addJobEvent({ leadId: invoice.lead_id, eventType: "invoice_voided", eventNote: `Invoice ${invoice.invoice_number || invoice.invoice_id} voided`, createdBy: "dashboard" });
  } else if (action === "generate-pdf") {
    generateInvoicePdf(invoice, store.state.companySettings, config);
    store.addJobEvent({ leadId: invoice.lead_id, eventType: "invoice_pdf_generated", eventNote: `Invoice PDF generated`, createdBy: "dashboard" });
  } else if (action === "send-email") {
    store.addLog("warn", "Invoice email send requested", { invoiceId: invoice.invoice_id, enabled: config.sendEmailsEnabled });
    if (!config.sendEmailsEnabled || !config.autoSend) {
      invoice.status = invoice.status === "draft" ? "draft" : invoice.status;
    } else {
      invoice.status = "sent";
      invoice.sent_at = new Date().toISOString();
    }
  } else {
    updateInvoiceFromForm(invoice, form, store.state.companySettings);
  }
  invoice.updated_at = new Date().toISOString();
  store.addLog("info", "Customer invoice action applied", { action, invoiceId: invoice.invoice_id, leadId: invoice.lead_id });
  await store.save();
  writeTrackerWorkbook(config.trackerXlsxPath, store.state, config);
  logger.info("Customer invoice action applied", { action, invoiceId: invoice.invoice_id });
  redirect(res, `/invoices/${encodeURIComponent(invoice.invoice_id)}`);
}

async function saveTechnician(req, res, { config, store, logger }) {
  const form = await readForm(req);
  ensureOperationsState(store.state, config);
  const existing = form.id ? (store.state.technicians || []).find((item) => item.id === form.id) : null;
  if (existing) updateTechnician(existing, form);
  else store.state.technicians.push(createTechnician(form));
  store.addLog("info", "Technician saved", { technician: form.name || "" });
  await store.save();
  logger.info("Technician saved");
  redirect(res, "/technician-schedule");
}

async function saveWorkOrder(req, res, { config, store, logger }) {
  const form = await readForm(req);
  ensureOperationsState(store.state, config);
  const lead = (store.state.leads || []).find((item) => item.id === (form.leadId || form.lead_id || form.job_id || form.jobId)) || {};
  const existing = form.id ? (store.state.workOrders || []).find((item) => item.id === form.id) : null;
  const order = existing ? updateWorkOrder(existing, form, lead) : createWorkOrder(form, lead);
  if (!existing) store.state.workOrders.push(order);
  if (lead.id) {
    Object.assign(lead, {
      installation_scheduled_at: order.scheduled_start || lead.installation_scheduled_at,
      installation_time_window: order.time_window || lead.installation_time_window,
      installation_assigned_to: technicianName(store.state, order.technician_id) || lead.installation_assigned_to,
      installation_access_notes: order.access_notes || lead.installation_access_notes,
      updatedAt: new Date().toISOString()
    });
  }
  store.addJobEvent({ leadId: order.lead_id, eventType: existing ? "work_order_updated" : "work_order_created", eventNote: formatWorkOrderValue(order), createdBy: "dashboard" });
  store.addLog("info", existing ? "Work order updated" : "Work order created", { workOrderId: order.id, leadId: order.lead_id });
  await store.save();
  writeTrackerWorkbook(config.trackerXlsxPath, store.state, config);
  logger.info("Work order saved", { workOrderId: order.id });
  redirect(res, `/technician-schedule`);
}

function workOrderGet(req, res, { config, store }, pathname) {
  const order = findWorkOrder(store, pathname);
  if (!order) return html(res, pageShell("Work order not found", `<p>Work order not found.</p><p><a class="button" href="/technician-schedule">Back to schedule</a></p>`), 404);
  if (pathname.endsWith("/ics")) {
    const body = generateIcs(order, config.appBaseUrl);
    res.writeHead(200, { "content-type": "text/calendar; charset=utf-8", "content-disposition": `attachment; filename="${escapeHeader(order.id)}.ics"` });
    res.end(body);
    return;
  }
  html(res, workOrderDetailPage(order, config, store));
}

async function workOrderPost(req, res, { config, store, logger }, pathname) {
  ensureOperationsState(store.state, config);
  ensureMessageQueue(store.state);
  const order = findWorkOrder(store, pathname);
  if (!order) return redirect(res, "/technician-schedule");
  const action = pathname.split("/").filter(Boolean)[2] || "edit";
  const form = await readForm(req);
  if (action === "send-to-technician") {
    const technician = (store.state.technicians || []).find((item) => item.id === order.technician_id) || {};
    const digest = digestForTechnician({ ...store.state, workOrders: [order] }, technician.id, order.scheduled_start || new Date(), 1);
    const smsAttempt = await sendSms(technician.mobile_number, digest.body, { config, state: store.state, templateType: "technician_job_assignment" });
    const whatsappAttempt = await sendWhatsApp(technician.whatsapp_number || technician.mobile_number, digest.body, config.whatsappTemplates.jobAssignment, {}, { config, state: store.state, templateType: "technician_job_assignment" });
    if ([smsAttempt.status, whatsappAttempt.status].some((status) => ["queued", "sent"].includes(status))) markWorkOrderSent(order);
  } else if (action === "assign") {
    order.technician_id = form.technician_id || form.technicianId || "";
    appendEventLog(order, "assigned", `Assigned to ${technicianName(store.state, order.technician_id) || order.technician_id || "Unassigned"}`);
  } else if (action === "notify-technician") {
    const matchedTechnician = (store.state.technicians || []).find((item) => item.id === order.technician_id) || {};
    order.technician_status = "notified";
    order.last_digest_sent_at = new Date().toISOString();
    appendEventLog(order, "technician_notified", "Technician notification recorded");
    queueTechnicianNotification(store.state, config, {
      workOrder: order,
      technician: matchedTechnician,
      templateKey: "new_assignment",
      secureLink: `${config.appBaseUrl || ""}/work-orders/${order.id}`
    });
  } else if (action === "confirm-technician") {
    order.technician_status = "confirmed";
    order.status = "confirmed";
    appendEventLog(order, "technician_confirmed", "Technician confirmed the job");
  } else if (action === "en-route") {
    order.technician_status = "en_route";
    appendEventLog(order, "en_route", "Technician is on the way");
  } else if (action === "arrived") {
    order.technician_status = "arrived";
    appendEventLog(order, "arrived", "Technician arrived on site");
  } else if (action === "confirm-customer") {
    order.customer_confirmation_status = "confirmed";
    appendEventLog(order, "customer_confirmed", "Customer confirmed the appointment");
  } else if (action === "reschedule") {
    const oldStart = order.scheduled_start || "unscheduled";
    const oldEnd = order.scheduled_end || "";
    const lead = (store.state.leads || []).find((item) => item.id === order.lead_id || item.id === order.job_id) || {};
    updateWorkOrder(order, { ...form, status: "rescheduled", technician_status: "reschedule_requested" }, lead);
    incrementCalendarSequence(order);
    appendEventLog(order, "rescheduled", `${oldStart}${oldEnd ? ` to ${oldEnd}` : ""} -> ${order.scheduled_start || "unscheduled"}${order.scheduled_end ? ` to ${order.scheduled_end}` : ""}`);
    queueTechnicianNotification(store.state, config, {
      workOrder: order,
      technician: (store.state.technicians || []).find((item) => item.id === order.technician_id) || {},
      templateKey: "reschedule",
      secureLink: `${config.appBaseUrl || ""}/work-orders/${order.id}`
    });
  } else if (action === "add-log") {
    appendEventLog(order, "note", form.note || "", "office");
  } else if (action === "add-to-calendar") {
    order.calendar_event_id = order.calendar_event_id || `${order.id}@autodoorsyorkshire.com`;
    order.updated_at = new Date().toISOString();
    store.addLog("info", "Calendar event prepared", { workOrderId: order.id, syncEnabled: config.calendarSyncEnabled });
  } else if (action === "mark-complete") {
    markWorkOrderComplete(order);
    const lead = (store.state.leads || []).find((item) => item.id === order.lead_id);
    if (lead) {
      lead.installation_completed_at = lead.installation_completed_at || new Date().toISOString().slice(0, 10);
      lead.status = lead.status === "Won" ? "Installation completed" : lead.status;
    }
  } else if (action === "cancel") {
    order.status = "cancelled";
    incrementCalendarSequence(order);
    appendEventLog(order, "cancelled", "Work order cancelled");
    queueTechnicianNotification(store.state, config, {
      workOrder: order,
      technician: (store.state.technicians || []).find((item) => item.id === order.technician_id) || {},
      templateKey: "cancellation",
      secureLink: `${config.appBaseUrl || ""}/work-orders/${order.id}`
    });
  }
  store.addJobEvent({ leadId: order.lead_id, eventType: `work_order_${action}`, eventNote: formatWorkOrderValue(order), createdBy: "dashboard" });
  await store.save();
  writeTrackerWorkbook(config.trackerXlsxPath, store.state, config);
  logger.info("Work order action applied", { action, workOrderId: order.id });
  redirect(res, ["assign", "notify-technician", "confirm-technician", "en-route", "arrived", "confirm-customer", "reschedule", "add-log"].includes(action) ? `/work-orders/${encodeURIComponent(order.id)}` : "/technician-schedule");
}

async function updateSupplierEmail(req, res, { config, store, logger }, pathname) {
  const email = findSupplierEmail(store, pathname);
  if (!email) return redirect(res, "/supplier-emails");
  const form = await readForm(req);
  const action = pathname.split("/").filter(Boolean)[2] || "edit";
  ensureFinanceState(store.state);
  if (action === "delete") {
    store.state.supplierEmails = (store.state.supplierEmails || []).filter((item) => item.id !== email.id);
    store.addLog("warn", "Supplier email deleted", { supplierEmailId: email.id });
  } else if (action === "archive") {
    Object.assign(email, { archivedAt: new Date().toISOString(), reviewStatus: "Archived", updatedAt: new Date().toISOString() });
    store.addLog("info", "Supplier email archived", { supplierEmailId: email.id });
  } else if (action === "link-job") {
    const leadId = form.leadId || "";
    Object.assign(email, {
      matchedLeadId: leadId,
      reviewStatus: leadId ? "Linked" : "Needs review",
      matchReason: leadId ? "Manually linked from dashboard" : "Manually unlinked from dashboard",
      updatedAt: new Date().toISOString()
    });
    store.addJobEvent({ leadId, eventType: leadId ? "supplier_email_linked" : "supplier_email_unlinked", eventNote: `Supplier email ${email.subject || email.id}`, sourceEmailId: email.emailMessageId, createdBy: "dashboard" });
  } else if (action === "mark-reviewed") {
    Object.assign(email, { reviewStatus: form.reviewStatus || "Reviewed", updatedAt: new Date().toISOString() });
    store.addLog("info", "Supplier email review status changed", { supplierEmailId: email.id, reviewStatus: email.reviewStatus });
  } else {
    Object.assign(email, {
      supplierName: form.supplierName || email.supplierName,
      supplierEmail: form.supplierEmail || email.supplierEmail,
      subject: form.subject || email.subject,
      extractedOrderReference: form.extractedOrderReference || email.extractedOrderReference,
      extractedLeadTime: form.extractedLeadTime || email.extractedLeadTime,
      extractedDeliveryDate: form.extractedDeliveryDate || email.extractedDeliveryDate,
      rawSummary: form.rawSummary || email.rawSummary,
      reviewStatus: form.reviewStatus || email.reviewStatus,
      notes: form.notes || email.notes,
      updatedAt: new Date().toISOString()
    });
    store.addLog("info", "Supplier email edited", { supplierEmailId: email.id });
  }
  await store.save();
  writeTrackerWorkbook(config.trackerXlsxPath, store.state, config);
  logger.info("Supplier email action applied", { action, supplierEmailId: email.id });
  redirect(res, action === "delete" ? "/supplier-emails" : `/supplier-emails/${encodeURIComponent(email.id)}`);
}

async function syncEmail(res, { config, store, logger }) {
  const summary = await processMessages({ config, store, logger });
  html(res, pageShell("Email Sync", `<p>Scanned ${summary.scanned}, added ${summary.added}, duplicates ${summary.duplicates}, supplier emails ${summary.supplierEmails || 0}, supplier reviews ${summary.supplierReviews || 0}, skipped ${summary.skipped}.</p><p>Skipped sorting: recruitment ${summary.recruitment || 0}, spam/marketing ${summary.spam || 0}, admin/system ${summary.admin || 0}, other non-leads ${summary.nonEnquiries || 0}.</p><p>${config.dryRun ? "Dry run: no live mailbox changes were made." : "Tracker updated."}</p><p><a href="/dashboard">Back to dashboard</a></p>`));
}

async function syncCheckatrade(res, { config, store, logger }) {
  if (!config.checkatradeEnabled) {
    return html(res, pageShell("Checkatrade Sync", `<p>Checkatrade dashboard connector is disabled. Set CHECKATRADE_ENABLED=true after local login/session setup.</p><p><a href="/dashboard">Back to dashboard</a></p>`));
  }
  const result = await runCheckatradeCollection({ config, store, logger });
  html(res, pageShell("Checkatrade Sync", `<p>Scanned ${result.summary.scanned}, added ${result.summary.added}, duplicates ${result.summary.duplicates}.</p><p>${config.dryRun ? "Dry run: tracker was not written." : "Tracker updated."}</p><p><a href="/dashboard">Back to dashboard</a></p>`));
}

function dashboardPage(leads, config, supplierEmails = [], store = { state: { leads, supplierEmails } }) {
  ensureFinanceState(store.state || {});
  ensureOperationsState(store.state || {}, config);
  const prepared = [...leads].map((lead) => ensureJobFields(lead));
  const latest = prepared.sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt))).slice(0, 20);
  const counts = queueCounts(leads, supplierEmails);
  const finances = financeSummary(prepared, store.state || {});
  const invoices = invoiceSummary(store.state || {});
  const schedule = scheduleSummary(store.state || {});
  const queues = [
    ["New enquiries needing response", counts.newEnquiries, "/leads?quick=new"],
    ["Quotes to send", counts.quotesToSend, "/leads?quick=quotes-to-send"],
    ["Quotes awaiting customer decision", counts.quotesAwaitingDecision, "/leads?quick=quotes"],
    ["Accepted quotes needing deposit", counts.acceptedNeedDeposit, "/leads?quick=deposits"],
    ["Deposits received - order supplier now", counts.depositsOrderSupplier, "/leads?quick=supplier-orders"],
    ["Supplier orders awaiting confirmation", counts.supplierAwaitingConfirmation, "/leads?quick=supplier-orders"],
    ["Orders awaiting delivery", counts.awaitingDelivery, "/leads?quick=awaiting-delivery"],
    ["Delivery due soon", counts.deliveryDueSoon, "/leads?quick=delivery-due"],
    ["Delivered - book installation", counts.deliveredBookInstall, "/leads?quick=installations"],
    ["Installations booked this week", counts.installationsThisWeek, "/leads?quick=installations"],
    ["Balance/payment due", counts.balanceDue, "/leads?quick=payments"],
    ["Overdue customer updates", counts.overdueCustomerUpdates, "/leads?quick=overdue"],
    ["High-priority repairs", counts.highPriorityRepairs, "/leads?quick=repairs"],
    ["Supplier emails needing review", counts.supplierEmailsNeedingReview, "/supplier-emails"]
  ];
  const actionsToday = todaysActions(leads);
  const activeQueues = queues.filter(([, value]) => value > 0);
  const quietQueues = queues.filter(([, value]) => value === 0);
  const recentEvents = latestActivity(store.state || {});
  const todayRows = dashboardTodayRows(counts, invoices, schedule);
  return pageShell(
    "Dashboard",
    `<section class="ay-section"><p class="ay-section-label">Financial snapshot</p><div class="ay-summary-grid">
      ${aySummaryCard({ label: "Money to collect", value: formatMoney(finances.customerOutstanding), href: "/money" })}
      ${aySummaryCard({ label: "Owed to suppliers", value: formatMoney(finances.supplierOutstanding), href: "/finance" })}
      ${aySummaryCard({ label: "Accepted work", value: formatMoney(finances.acceptedJobsValue), href: "/jobs" })}
      ${aySummaryCard({ label: "Net forecast", value: formatMoney(finances.netCashPosition), href: "/finance" })}
      ${aySummaryCard({ label: "Overdue customer", value: formatMoney(finances.overdueCustomerPayments), href: "/money" })}
    </div></section>
    ${pipelineBoard(prepared)}
    ${valueTrackerSection(store.state || {}, prepared, finances)}
    <section class="panel"><div class="panel-heading"><h2>Latest activity</h2><div class="actions"><a class="button secondary compact-button" href="/leads">View all</a><form method="post" action="/system/clear-activity"><button class="button secondary compact-button">Clear activity</button></form></div></div>${recentEvents.length ? activityList(recentEvents.slice(0, 6)) : `<p class="muted">No recent activity yet.</p>`}</section>
    <section class="panel compact-warning-panel"><div class="panel-heading"><h2>Setup / system warning</h2><a class="button secondary compact-button" href="/system">System</a></div>${dashboardWarningSummary(config, store)}</section>
    <details class="drawer today-accordion"><summary>More dashboard detail and action queues</summary><div class="drawer-body">
      <section class="panel calm today"><div class="panel-heading"><h2>Today / Today's actions</h2><a class="button secondary compact-button" href="/today">Open Today</a></div>${todayRows.length ? `<div class="action-list">${todayRows.map(actionRow).join("")}</div>` : `<p class="empty-state">No urgent work is waiting. The board is calm.</p>`}</section>
      ${opsSnapshot(leads, config, supplierEmails, store)}
      ${dashboardHero(prepared, actionsToday, supplierEmails)}
      ${criticalFocus(prepared, actionsToday)}
      <section class="panel"><h2>Active queues</h2>${activeQueues.length ? `<section class="metrics queue-grid">${activeQueues.map(queueCard).join("")}</section>` : `<p class="muted">No active queues. The board is clear.</p>`}${quietQueues.length ? `<details><summary>Quiet queues</summary><section class="metrics compact-queues">${quietQueues.map(queueCard).join("")}</section></details>` : ""}</section>
      <section class="split"><div>${breakdown("Leads by source", leads, (lead) => lead.sourcePlatform || lead.source || "Unknown")}</div><div>${breakdown("Leads by status", leads, (lead) => lead.status || "Unknown")}</div></section>
      <h2>Latest 20 leads</h2>${leadTable(latest, { state: store.state })}
    </div></details>`
  );
}

function todayPage(config, store) {
  ensureFinanceState(store.state || {});
  ensureOperationsState(store.state || {}, config);
  const leads = (store.state.leads || []).map((lead) => ensureJobFields(lead));
  const items = commercialActionItems(store.state || {}, config);
  const summary = financeSummary(leads, store.state);
  const atRisk = items.filter((item) => item.tone === "red").length;
  const groups = [
    ["Overdue & at risk", "risk"],
    ["Customer actions", "customer"],
    ["Money & payments", "payment"],
    ["Supplier actions", "supplier"],
    ["Installations", "install"]
  ];
  const summaryGrid = `<div class="ay-summary-grid">`
    + aySummaryCard({ label: "Jobs to action", value: String(items.length), sub: atRisk ? `${atRisk} at risk` : "All on track", href: "/today" })
    + aySummaryCard({ label: "Money to collect", value: formatMoney(summary.customerOutstanding), href: "/money" })
    + aySummaryCard({ label: "Owed to suppliers", value: formatMoney(summary.supplierOutstanding), href: "/finance" })
    + aySummaryCard({ label: "Jobs at risk", value: String(atRisk), href: "/today" })
    + `</div>`;
  const financeFor = (lead) => {
    const financials = jobFinancials(lead, ensureFinanceState(store.state || {}));
    return financials.customerOutstanding || financials.customer_amount_outstanding || 0;
  };
  const sections = groups.map(([label, group]) => {
    const groupItems = items.filter((item) => item.group === group);
    if (!groupItems.length) return "";
    return `<section class="ay-section"><p class="ay-section-label">${escapeHtml(label)} (${groupItems.length})</p>`
      + `<div style="display:flex;flex-direction:column;gap:var(--ay-space-3)">${groupItems.map(ayTodayItemCard).join("")}</div></section>`;
  }).join("");
  const body = `${store.demo ? demoBanner() : ""}`
    + `<section class="ay-section">${summaryGrid}</section>`
    + todayDispatchSection(store.state || {}, leads, financeFor)
    + (items.length
        ? sections
        : ayAllClear("All caught up", "No customer, supplier, install or payment actions are outstanding right now."))
    + `<hr class="ay-divider"><details><summary class="ay-section-label" style="cursor:pointer;list-style:revert">Weekly and monthly preview reports</summary>`
    + `<div style="margin-top:var(--ay-space-4)">${summaryPreviewReports(store.state || {}, leads)}</div></details>`;
  return pageShell("Today", body);
}

function demoPage(config) {
  const store = demoStore(config);
  const leads = store.state.leads.map((lead) => ensureJobFields(lead));
  const finances = financeSummary(leads, store.state);
  return pageShell(
    "Demo",
    `${demoBanner()}
    <section class="page-intro"><div><h2>Trade operating dashboard demo</h2><p>Safe fake data that shows the commercial value without exposing a real customer or mailbox.</p></div><div class="actions"><a class="button" href="/dashboard?demo=true">Open demo dashboard</a><a class="button secondary" href="/today?demo=true">Open demo Today</a></div></section>
    <section class="cockpit-grid">
      <section class="panel calm"><h2>Five-minute sales story</h2><div class="action-list">${commercialActionItems(store.state, config).slice(0, 8).map((item) => todayItemCard(item)).join("")}</div></section>
      <section class="panel calm"><h2>What the buyer sees immediately</h2><section class="summary-strip">${moneyCockpitCards(finances).join("")}</section></section>
    </section>
    ${valueTrackerSection(store.state, leads, finances)}
    ${pipelineBoard(leads)}
    <section class="panel"><h2>Demo guardrail</h2><p class="muted">Demo mode never writes to the live tracker. It is designed for sales calls, onboarding and training.</p></section>`
  );
}

function setupWizardPage(config, store) {
  const state = ensureOperationsState(store.state || {}, config);
  const readiness = setupChecklist(config, store);
  const complete = readiness.filter((item) => item.done).length;
  const total = readiness.length;
  return pageShell(
    "Setup",
    `<section class="page-intro"><div><h2>Client setup wizard</h2><p>Turn a blank install into a ready-to-use trade dashboard without asking the client to understand server settings.</p></div><a class="button secondary" href="/settings">Detailed settings</a></section>
    <section class="panel calm"><div class="panel-heading"><div><h2>Setup progress</h2><p class="muted">${complete} of ${total} setup steps complete.</p></div><span class="badge ${complete === total ? "green" : "amber"}">${complete}/${total}</span></div><section class="setup-steps">${readiness.map(setupStepCard).join("")}</section></section>
    <section class="split">
      <article><h2>1. Business details</h2><p class="muted">Legal name, trading name, phone, email, address, VAT and logo. These feed invoices and customer documents.</p><a class="button" href="/settings">Open business settings</a></article>
      <article><h2>2. Email setup</h2><p class="muted">IMAP and SMTP are read from secure environment variables. Passwords are never shown or logged.</p>${statusCard({ label: "Inbox", value: config.imap.password ? "Ready" : "Password needed", tone: config.imap.password ? "green" : "amber", detail: `${config.imap.host || ""} / ${config.imap.username || ""}` })}<form method="post" action="/sync/email"><button class="button secondary">Test by syncing inbox</button></form></article>
      <article><h2>3. Invoice setup</h2><p class="muted">Invoice prefix, next number, payment terms, VAT setting and bank details.</p><a class="button" href="/settings">Open invoice setup</a></article>
      <article><h2>4. Workflow setup</h2><p class="muted">Current template: garage doors and shutters. It follows lead, quote, deposit, supplier order, delivery, install, balance and review.</p><a class="button secondary" href="/demo">See workflow demo</a></article>
      <article><h2>5. Technician setup</h2><p class="muted">Name, mobile, WhatsApp, email and calendar export settings.</p><a class="button" href="/technician-schedule">Open technician schedule</a></article>
      <article><h2>6. Backup/export setup</h2><p class="muted">The client owns their data. Use the export area before and after live testing.</p><a class="button" href="/system">Open data export</a></article>
      <article><h2>7. Admin/security</h2><p class="muted">Admin login should be set before giving the dashboard to a client.</p>${statusCard({ label: "Admin login", value: config.adminUsername && config.adminPassword ? "Set" : "Missing", tone: config.adminUsername && config.adminPassword ? "green" : "amber", detail: config.adminUsername ? "Login is enabled" : "Set ADMIN_USERNAME and ADMIN_PASSWORD" })}</article>
    </section>
    <details class="drawer"><summary>Commercial onboarding notes</summary><div class="drawer-body"><p>Use this page during client handover: complete the checklist, add one lead, generate one invoice PDF, export data, and show the Today page on mobile.</p></div></details>`
  );
}

function supplierInvoicesPage(config, store, params = new URLSearchParams()) {
  const state = ensureFinanceState(store.state || {});
  const leads = state.leads || [];
  const filter = params.get("filter") || "due";
  const invoices = (state.supplierInvoices || [])
    .map((invoice) => calculateSupplierInvoiceBalance(invoice, state))
    .filter((invoice) => supplierInvoiceFilter(invoice, filter))
    .sort((a, b) => String(a.dueDate || "").localeCompare(String(b.dueDate || "")));
  const allInvoices = (state.supplierInvoices || []).map((invoice) => calculateSupplierInvoiceBalance(invoice, state));
  return pageShell(
    "Supplier Invoices",
    `<section class="page-intro"><div><h2>Supplier invoice control</h2><p>See what needs paying, what is part-paid, and what is overdue without digging through Finance.</p></div><div class="actions"><a class="button" href="/finance#supplier-invoices">Add supplier invoice</a><a class="button secondary" href="/export/supplier-invoices.csv">Export CSV</a></div></section>
    <section class="ay-section"><div class="ay-summary-grid">
      ${aySummaryCard({ label: "Payment due", value: String(allInvoices.filter((invoice) => money(invoice.amountOutstanding) > 0 && !isPastDate(invoice.dueDate)).length), href: "/supplier-invoices?filter=due" })}
      ${aySummaryCard({ label: "Part paid", value: String(allInvoices.filter((invoice) => invoice.paymentStatus === "Part paid").length), href: "/supplier-invoices?filter=part-paid" })}
      ${aySummaryCard({ label: "Overdue", value: String(allInvoices.filter((invoice) => money(invoice.amountOutstanding) > 0 && isPastDate(invoice.dueDate)).length), href: "/supplier-invoices?filter=overdue" })}
      ${aySummaryCard({ label: "Paid", value: String(allInvoices.filter((invoice) => money(invoice.amountOutstanding) <= 0).length), href: "/supplier-invoices?filter=paid" })}
      ${aySummaryCard({ label: "Owed to supplier", value: formatMoney(allInvoices.reduce((total, invoice) => total + money(invoice.amountOutstanding), 0)), href: "/supplier-invoices" })}
    </div></section>
    ${ayFilterTabs([["Payment due", "due"], ["Part paid", "part-paid"], ["Overdue", "overdue"], ["Paid", "paid"], ["Archived", "archived"], ["All", "all"]].map(([label, value]) => ({ label, href: `/supplier-invoices?filter=${value}`, active: filter === value })), "Supplier invoice filters")}
    <section class="panel"><h2>${escapeHtml(statusLabel(filter))}</h2>${supplierInvoiceTable(invoices, leads)}</section>
    <details class="drawer"><summary>Add or correct supplier invoice</summary><div class="drawer-body"><section class="split"><article><h2>Add supplier invoice</h2>${supplierInvoiceForm(leads)}</article><article><h2>Supplier payments</h2>${supplierPaymentTable((state.supplierPayments || []).filter((payment) => !payment.archivedAt).slice(-15).reverse(), allInvoices)}</article></section></div></details>`
  );
}

function exportsPage(config, store) {
  const checks = permanenceChecks(config, store);
  return pageShell(
    "Exports",
    `<section class="page-intro"><div><h2>Backup and export</h2><p>Download the data. The business should never feel locked in.</p></div><a class="button" href="/export/all-data.json">Download all data</a></section>
    <section class="panel calm"><h2>Export confidence</h2><section class="metrics status-grid">${checks.map(statusCard).join("")}</section></section>
    <section class="panel"><h2>Downloads</h2><div class="export-grid">
      <a class="export-card" href="/export/tracker"><strong>Tracker workbook</strong><span>Excel-style workbook for handover or review.</span></a>
      <a class="export-card" href="/export/all-data.json"><strong>All data JSON</strong><span>Full operational data export.</span></a>
      <a class="export-card" href="/export/leads.csv"><strong>Leads CSV</strong><span>Customer and enquiry list.</span></a>
      <a class="export-card" href="/export/jobs.csv"><strong>Jobs CSV</strong><span>Job finance and margin estimate.</span></a>
      <a class="export-card" href="/export/customer-invoices.csv"><strong>Customer invoices CSV</strong><span>Invoice numbers, totals and status.</span></a>
      <a class="export-card" href="/export/payments.csv"><strong>Customer payments CSV</strong><span>Money received from customers.</span></a>
      <a class="export-card" href="/export/supplier-invoices.csv"><strong>Supplier invoices CSV</strong><span>Supplier bills and balances.</span></a>
      <a class="export-card" href="/export/supplier-payments.csv"><strong>Supplier payments CSV</strong><span>Money paid to suppliers.</span></a>
      <a class="export-card" href="/export/supplier-emails.csv"><strong>Supplier emails CSV</strong><span>Supplier email review history.</span></a>
    </div></section>
    <section class="panel"><h2>Simple rule</h2><p class="muted">Export before major setup changes, after live testing, and at least monthly once the business relies on the dashboard.</p></section>`
  );
}

function statusPage(config, store) {
  const state = store.state || {};
  const leads = state.leads || [];
  const recentLogs = [...(state.logs || [])].slice(-12).reverse();
  const checks = systemChecks(config, store);
  return pageShell(
    "System Status",
    `<section class="page-intro"><div><h2>Operating status</h2><p>Live health, storage and safety switches for the dashboard.</p></div><a class="button secondary" href="/system">Storage audit</a></section>
    <section class="ay-section"><p class="ay-section-label">Operating status</p>${aySystemGrid(checks.map(ayCheckCard))}</section>
    <section class="split">
      <article><h2>Current configuration</h2>
        <p><strong>Business:</strong> ${escapeHtml(config.businessName)}</p>
        <p><strong>Email provider:</strong> ${escapeHtml(config.emailProvider)}</p>
        <p><strong>Mailbox:</strong> ${escapeHtml(config.imap.username || "")}</p>
        <p><strong>Coverage:</strong> ${escapeHtml(config.serviceCoverage)}; priority starts with ${escapeHtml(config.localPriorityPostcodes.join(", ") || "not set")}</p>
        <p><strong>Auto send:</strong> ${escapeHtml(config.autoSend ? "enabled" : "disabled")}</p>
        <p><strong>Dry run:</strong> ${escapeHtml(config.dryRun ? "enabled" : "disabled")}</p>
      </article>
      <article><h2>Tracker totals</h2>
        <p><strong>Leads:</strong> ${leads.length}</p>
        <p><strong>Supplier emails:</strong> ${(state.supplierEmails || []).length}</p>
        <p><strong>Processed messages:</strong> ${(state.processedMessageIds || []).length}</p>
        <p><strong>Job events:</strong> ${(state.jobEvents || []).length}</p>
        <p><a class="button" href="/export/tracker">Download tracker workbook</a></p>
      </article>
    </section>
    <section class="panel"><h2>Recent activity</h2>${recentLogs.length ? logTable(recentLogs) : `<p class="muted">No activity has been logged yet.</p>`}</section>`
  );
}

function systemPage(config, store) {
  const checks = permanenceChecks(config, store);
  const readiness = integrationReadiness(config, store);
  const calendarAndNotifications = calendarNotificationChecks(config, store);
  return pageShell(
    "System",
    `<section class="page-intro"><div><h2>Production safety</h2><p>Storage, exports and configuration checks before using live technician data.</p></div><div class="actions"><a class="button secondary" href="/status">Operating status</a><a class="button" href="/export/tracker">Export workbook</a></div></section>
    <section class="ay-section"><p class="ay-section-label">Health dashboard</p>${aySystemGrid([...checks.slice(0, 3), ...readiness.slice(4, 9)].map(ayCheckCard))}</section>
    <section class="panel calm"><div class="panel-heading"><div><h2>Download my data</h2><p class="muted">Commercial promise: the trader can leave and take their operational data.</p></div><a class="button compact-button" href="/export/all-data.json">All data</a></div><div class="actions">
      <a class="button secondary" href="/export/leads.csv">Leads CSV</a>
      <a class="button secondary" href="/export/jobs.csv">Jobs CSV</a>
      <a class="button secondary" href="/export/customer-invoices.csv">Customer invoices CSV</a>
      <a class="button secondary" href="/export/payments.csv">Customer payments CSV</a>
      <a class="button secondary" href="/export/supplier-invoices.csv">Supplier invoices CSV</a>
      <a class="button secondary" href="/export/supplier-payments.csv">Supplier payments CSV</a>
      <a class="button secondary" href="/export/supplier-emails.csv">Supplier emails CSV</a>
      <a class="button secondary" href="/export/tracker">Workbook</a>
    </div></section>
    <section class="panel"><h2>Plain-English warnings</h2>${supportWarnings(config, store)}</section>
    <section class="panel"><h2>Calendar &amp; notifications</h2><section class="metrics status-grid">${calendarAndNotifications.map(statusCard).join("")}</section></section>
    <details class="drawer"><summary>Show technical details and data permanence audit</summary><div class="drawer-body"><section class="panel"><h2>Data permanence audit</h2><section class="metrics status-grid">${checks.map(statusCard).join("")}</section></section><section class="panel"><h2>Integration readiness</h2><section class="metrics status-grid">${readiness.map(statusCard).join("")}</section></section>
    <section class="split">
      <article><h2>Storage answers</h2>
        <p><strong>Using SQLite?</strong> No. This app uses JSON state backed by either Render Postgres or a local JSON file.</p>
        <p><strong>Local database path:</strong> ${escapeHtml(config.databasePath)}</p>
        <p><strong>Likely persistent on Render?</strong> ${escapeHtml(store.isDurable ? "Yes, Postgres is durable." : "No. Local JSON on Render is unsafe unless a persistent disk is mounted.")}</p>
        <p><strong>DATABASE_URL/Postgres:</strong> ${escapeHtml(config.databaseUrl ? "Configured" : "Not configured")}</p>
        <p><strong>Backups/export:</strong> CSV exports and tracker workbook are available manually.</p>
      </article>
      <article><h2>Minimum safe production setup</h2>
        <p>Use Render Postgres for live data, or a paid Render persistent disk if using file storage. Keep regular exports of leads, jobs, customer payments, supplier invoices and supplier email review items.</p>
        <p><a class="button" href="/export/tracker">Download workbook</a> <a class="button secondary" href="/export/leads.csv">Leads CSV</a></p>
        <p><a class="button secondary" href="/export/payments.csv">Payments CSV</a> <a class="button secondary" href="/export/supplier-invoices.csv">Supplier invoices CSV</a></p>
        <details><summary>Final test cleanup</summary><p class="muted">Archives active supplier invoices and supplier payments, then clears the activity feed. Lead and customer payment data is not deleted.</p><form method="post" action="/system/reset-supplier-finance" onsubmit="return confirm('Archive active supplier invoices and supplier payments for a clean final test?');"><button class="danger-button">Reset supplier finance test data</button></form></details>
      </article>
    </section></div></details>`
  );
}

function settingsPage(config, store) {
  const state = ensureOperationsState(store.state || {}, config);
  const settings = state.companySettings;
  const warnings = companySetupWarnings(settings);
  const readiness = integrationReadiness(config, store);
  return pageShell(
    "Settings",
    `<section class="ay-section"><p class="ay-section-label">Setup checklist</p>${aySystemGrid(readiness.map(ayCheckCard))}${warnings.length ? `<ul class="warning-list" style="margin-top:var(--ay-space-4)">${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>` : `<p class="status-safe" style="margin-top:var(--ay-space-4)">Invoice settings are ready to issue documents.</p>`}</section>
    <section class="panel form-panel"><div class="panel-heading"><div><h2>Company invoice settings</h2><p class="muted">Fill the basics first. Payment and invoice details are kept nearby for issuing customer invoices safely.</p></div><button class="button secondary" type="submit" form="company-settings-form">Save settings</button></div>
      <form id="company-settings-form" method="post" action="/settings/company" class="stacked-form">
        <div class="settings-groups">
          <section class="settings-group">
            <h3>Business details</h3>
            <div class="field-grid">
              ${labeledInput("companyLegalName", "Company legal name", settings.companyLegalName)}
              ${labeledInput("tradingName", "Trading name", settings.tradingName)}
              ${labeledInput("companyNumber", "Company number", settings.companyNumber)}
              ${labeledInput("phone", "Phone", settings.phone)}
              ${labeledInput("email", "Email", settings.email, "email")}
              ${labeledInput("website", "Website", settings.website)}
            </div>
          </section>
          <section class="settings-group">
            <h3>Invoice settings</h3>
            <div class="field-grid">
              ${labeledInput("vatRegistrationNumber", "VAT registration number", settings.vatRegistrationNumber)}
              <label><span>VAT registered?</span><select name="vatRegistered"><option value="false" ${!settings.vatRegistered ? "selected" : ""}>No</option><option value="true" ${settings.vatRegistered ? "selected" : ""}>Yes</option></select></label>
              ${labeledInput("defaultVatRate", "Default VAT rate", settings.defaultVatRate)}
              ${labeledInput("defaultPaymentTerms", "Default payment terms", settings.defaultPaymentTerms, "number")}
              ${labeledInput("invoicePrefix", "Invoice prefix", settings.invoicePrefix)}
              ${labeledInput("nextInvoiceNumber", "Next invoice number", settings.nextInvoiceNumber, "number")}
              ${labeledInput("noVatNote", "Non-VAT note", settings.noVatNote)}
            </div>
          </section>
          <section class="settings-group">
            <h3>Payment details</h3>
            <div class="field-grid">
              ${labeledInput("bankAccountName", "Bank account name", settings.bankAccountName)}
              ${labeledInput("sortCode", "Sort code", settings.sortCode)}
              ${labeledInput("accountNumber", "Account number", settings.accountNumber)}
              ${labeledInput("paymentReferenceFormat", "Payment reference format", settings.paymentReferenceFormat)}
            </div>
          </section>
          <details class="advanced-panel" open><summary>Addresses and branding</summary>
            <label><span>Registered office address</span><textarea name="registeredOfficeAddress">${escapeHtml(settings.registeredOfficeAddress || "")}</textarea></label>
            <label><span>Trading address</span><textarea name="tradingAddress">${escapeHtml(settings.tradingAddress || "")}</textarea></label>
            ${labeledInput("logoPath", "Logo path", settings.logoPath)}
          </details>
        </div>
        <button>Save settings</button>
      </form>
    </section>`
  );
}

function financePage(config, store) {
  const state = ensureFinanceState(store.state || {});
  ensureOperationsState(state, config);
  const leads = state.leads || [];
  const summary = financeSummary(leads, state);
  const invoiceStats = invoiceSummary(state);
  const supplierInvoices = (state.supplierInvoices || []).filter((invoice) => !invoice.archivedAt).map((invoice) => calculateSupplierInvoiceBalance(invoice, state));
  const payments = (state.customerPayments || []).filter((payment) => !payment.archivedAt);
  const supplierPayments = (state.supplierPayments || []).filter((payment) => !payment.archivedAt);
  return pageShell(
    "Finance",
    `<section class="page-intro"><div><h2>Money control</h2><p>Track deposits, balances, supplier invoices and profit forecast without using this as formal accounts.</p></div>
      <div class="actions">
        <a class="button" href="/invoices">Customer invoices</a>
        <a class="button secondary" href="/export/jobs.csv">Export</a>
      </div>
    </section>
    <section class="panel calm"><h2>Pipeline summary / operational forecast</h2><p class="muted">Top-level finance only. Detailed tables are below.</p><section class="summary-strip">
      ${summaryCard("Customer outstanding", summary.customerOutstanding, summary.customerOutstanding ? "amber" : "green", true)}
      ${summaryCard("Supplier outstanding", summary.supplierOutstanding, summary.supplierOutstanding ? "red" : "green", true)}
      ${summaryCard("Net forecast", summary.netCashPosition, summary.netCashPosition < 0 ? "red" : "green", true)}
      ${summaryCard("Overdue customer", summary.overdueCustomerPayments, summary.overdueCustomerPayments ? "red" : "green", true)}
      ${summaryCard("Overdue supplier", summary.overdueSupplierPayments, summary.overdueSupplierPayments ? "red" : "green", true)}
    </section></section>
    <nav class="tab-list"><a href="#customer-balances">Customer balances</a><a href="#supplier-invoices">Supplier invoices</a><a href="#job-margin">Job margin</a><a href="#payments">Payments</a><a href="#exports">Exports</a></nav>
    <section id="customer-balances" class="panel"><h2>Customer payments outstanding</h2>${financeJobTable(summary.jobFinancials.filter((item) => item.finance.customerOutstanding > 0))}</section>
    <section id="supplier-invoices" class="panel"><h2>Supplier invoices outstanding</h2>${supplierInvoiceTable(supplierInvoices.filter((invoice) => money(invoice.amountOutstanding) > 0), leads)}</section>
    <details id="job-margin" class="drawer"><summary>Job profitability</summary><div class="drawer-body">${financeJobTable(summary.jobFinancials)}</div></details>
    <details class="drawer"><summary>Customer invoice control</summary><div class="drawer-body"><section class="metrics">
      ${metricCard("Invoices to issue", invoiceStats.invoicesToIssue, "/invoices?status=draft", invoiceStats.invoicesToIssue ? "amber" : "green")}
      ${metricCard("Unpaid invoices", invoiceStats.unpaidAmount, "/invoices", invoiceStats.unpaidAmount ? "amber" : "green", true)}
      ${metricCard("Overdue invoices", invoiceStats.overdueAmount, "/invoices?status=overdue", invoiceStats.overdueAmount ? "red" : "green", true)}
      ${metricCard("Paid invoices", invoiceStats.paidAmount, "/invoices?status=paid", "green", true)}
      ${metricCard("VAT on issued invoices", invoiceStats.vatOnIssued, "/invoices", invoiceStats.vatOnIssued ? "amber" : "grey", true)}
    </section></div></details>
    <details class="drawer"><summary>Record money movement</summary><div class="drawer-body"><section class="split">
      <article><h2>Add supplier invoice</h2>${supplierInvoiceForm(leads)}</article>
      <article><h2>Record customer payment</h2>${customerPaymentForm(leads, "", state)}</article>
      <article><h2>Record supplier payment</h2>${supplierPaymentForm(supplierInvoices)}</article>
    </section></div></details>
    <details id="payments" class="drawer"><summary>Payments and warnings</summary><div class="drawer-body"><section class="split">
      <article><h2>Overdue payment warnings</h2>${overdueWarnings(summary)}</article>
      <article><h2>Supplier liabilities by supplier</h2>${supplierLiabilityList(summary.supplierLiabilitiesBySupplier)}</article>
      <article><h2>Latest customer payments</h2>${customerPaymentTable(payments.slice(-20).reverse(), leads)}</article>
      <article><h2>Latest supplier payments</h2>${supplierPaymentTable(supplierPayments.slice(-20).reverse(), supplierInvoices)}</article>
    </section></div></details>
    <section id="exports" class="panel"><h2>Exports</h2><div class="actions"><a class="button secondary" href="/export/customer-invoices.csv">Invoice CSV</a><a class="button secondary" href="/export/payments.csv">Payments CSV</a><a class="button secondary" href="/export/supplier-invoices.csv">Supplier invoices CSV</a><a class="button secondary" href="/export/tracker">Workbook</a></div></section>`
  );
}

function moneyPage(config, store) {
  const state = ensureFinanceState(store.state || {});
  ensureOperationsState(state, config);
  const leads = (state.leads || []).map((lead) => ensureJobFields(lead));
  const summary = financeSummary(leads, state);
  const customerBalances = summary.jobFinancials
    .filter((item) => item.finance.customerOutstanding > 0)
    .sort((a, b) => b.finance.customerOutstanding - a.finance.customerOutstanding);
  const supplierBills = (state.supplierInvoices || [])
    .filter((invoice) => !invoice.archivedAt)
    .map((invoice) => calculateSupplierInvoiceBalance(invoice, state))
    .filter((invoice) => money(invoice.amountOutstanding) > 0)
    .sort((a, b) => String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")));
  const invoicesReady = invoiceSummary(state);
  return pageShell(
    "Money",
    `<section class="page-intro"><div><h2>Money to collect and bills to pay</h2><p>Owner-friendly money control. Use Finance when you need the deeper tables and exports.</p></div><div class="actions"><a class="button" href="/finance">Open Finance</a><a class="button secondary" href="/invoices">Customer invoices</a></div></section>
    <section class="ay-section"><div class="ay-summary-grid">
      ${aySummaryCard({ label: "Money to collect", value: formatMoney(summary.customerOutstanding), href: "/money#customer-balances" })}
      ${aySummaryCard({ label: "Overdue customer balances", value: formatMoney(summary.overdueCustomerPayments), href: "/money#customer-balances" })}
      ${aySummaryCard({ label: "Supplier bills due", value: formatMoney(summary.supplierOutstanding), href: "/money#supplier-bills" })}
      ${aySummaryCard({ label: "Net position estimate", value: formatMoney(summary.netCashPosition), href: "/finance#job-margin" })}
    </div></section>
    <section class="cockpit-grid">
      <section id="customer-balances" class="panel calm"><div class="panel-heading"><h2>Customer balances</h2><a class="button secondary compact-button" href="/finance#customer-balances">Detailed view</a></div>${customerBalanceCards(customerBalances)}</section>
      <section id="supplier-bills" class="panel calm"><div class="panel-heading"><h2>Supplier bills</h2><a class="button secondary compact-button" href="/supplier-invoices">Supplier invoices</a></div>${supplierBillCards(supplierBills, leads)}</section>
    </section>
    <section class="panel"><div class="panel-heading"><h2>Payment requests ready</h2><a class="button secondary compact-button" href="/invoices">Invoices</a></div><section class="summary-strip">
      ${summaryCard("Draft invoices", invoicesReady.invoicesToIssue, invoicesReady.invoicesToIssue ? "amber" : "green")}
      ${summaryCard("Unpaid invoices", invoicesReady.unpaidAmount, invoicesReady.unpaidAmount ? "amber" : "green", true)}
      ${summaryCard("Overdue invoices", invoicesReady.overdueAmount, invoicesReady.overdueAmount ? "red" : "green", true)}
      ${summaryCard("Paid invoices", invoicesReady.paidAmount, "green", true)}
    </section></section>
    <details class="drawer"><summary>Record payments and export money data</summary><div class="drawer-body"><section class="split">
      <article><h2>Record customer payment</h2>${customerPaymentForm(leads, "", state)}</article>
      <article><h2>Record supplier payment</h2>${supplierPaymentForm(supplierBills)}</article>
      <article><h2>Exports</h2><div class="actions"><a class="button secondary" href="/export/payments.csv">Customer payments CSV</a><a class="button secondary" href="/export/supplier-payments.csv">Supplier payments CSV</a><a class="button secondary" href="/export/jobs.csv">Job margins CSV</a></div></article>
    </section></div></details>`
  );
}

function customerBalanceCards(items) {
  if (!items.length) return ayEmptyState({ title: "All balances clear", body: "No customer balances need chasing." });
  return `<div style="display:flex;flex-direction:column;gap:var(--ay-space-3)">${items.slice(0, 10).map(({ lead, finance }) => {
    const id = encodeURIComponent(lead.id);
    const meta = [lead.customerPostcode, finance.overdue_customer_amount ? "" : lead.next_best_action].filter(Boolean).map((part) => escapeHtml(String(part))).join(" · ");
    return `<div class="ay-job-card">
      <div class="ay-job-card__main">
        <div class="ay-job-card__top"><span class="ay-job-card__name">${escapeHtml(lead.customerName || lead.customerPostcode || lead.id)}</span>${finance.overdue_customer_amount ? ayBadge({ variant: "red", label: "Payment overdue" }) : ayStageBadge(lead.status)}</div>
        ${meta ? `<p class="ay-job-card__meta">${meta}</p>` : ""}
      </div>
      <div class="ay-job-card__actions"><span class="ay-job-card__value">${escapeHtml(formatMoney(finance.customerOutstanding))}</span>${ayButton({ label: "Open job", href: `/leads/${id}`, variant: "primary", size: "sm" })}${ayButton({ label: "Create invoice", href: `/invoices/new?leadId=${id}&type=balance`, variant: "ghost", size: "sm" })}</div>
    </div>`;
  }).join("")}</div>`;
}

function supplierBillCards(invoices, leads) {
  if (!invoices.length) return ayEmptyState({ title: "No supplier bills", body: "No supplier bills are outstanding." });
  const leadNames = new Map((leads || []).map((lead) => [lead.id, lead.customerName || lead.customerPostcode || lead.id]));
  return `<div style="display:flex;flex-direction:column;gap:var(--ay-space-3)">${invoices.slice(0, 10).map((invoice) => {
    const meta = [invoice.invoiceReference || "No reference", invoice.leadId ? (leadNames.get(invoice.leadId) || invoice.leadId) : "", invoice.dueDate ? `Due ${invoice.dueDate}` : "No due date"].filter(Boolean).map((part) => escapeHtml(String(part))).join(" · ");
    return `<div class="ay-job-card">
      <div class="ay-job-card__main">
        <div class="ay-job-card__top"><span class="ay-job-card__name">${escapeHtml(invoice.supplierName || "Supplier")}</span>${isPastDate(invoice.dueDate) ? ayBadge({ variant: "red", label: "Overdue" }) : ayBadge({ variant: "amber", label: "Due" })}</div>
        <p class="ay-job-card__meta">${meta}</p>
      </div>
      <div class="ay-job-card__actions"><span class="ay-job-card__value">${escapeHtml(formatMoney(invoice.amountOutstanding))}</span>${ayButton({ label: "Review", href: "/supplier-invoices", variant: "primary", size: "sm" })}${ayButton({ label: "Record payment", href: "/finance#payments", variant: "ghost", size: "sm" })}</div>
    </div>`;
  }).join("")}</div>`;
}

function invoicesPage(config, store, params = new URLSearchParams()) {
  const state = ensureOperationsState(store.state || {}, config);
  const leads = state.leads || [];
  const statusFilter = params.get("status") || "";
  const invoices = activeInvoices(state)
    .filter((invoice) => !statusFilter || invoice.status === statusFilter || (statusFilter === "overdue" && invoice.amount_outstanding > 0 && isPastDate(invoice.due_date)))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const summary = invoiceSummary(state);
  return pageShell(
    "Invoices",
    `<section class="page-intro"><div><h2>Customer invoicing</h2><p>Create professional customer invoices, PDFs and approval-only email drafts.</p></div><div class="actions"><a class="button" href="/invoices/new">New invoice</a><a class="button secondary" href="/settings">Invoice settings</a><a class="button secondary" href="/export/customer-invoices.csv">Export CSV</a></div></section>
    <section class="ay-section"><div class="ay-summary-grid">
      ${aySummaryCard({ label: "Draft invoices", value: String(summary.invoicesToIssue), href: "/invoices?status=draft" })}
      ${aySummaryCard({ label: "Unpaid", value: formatMoney(summary.unpaidAmount), href: "/invoices" })}
      ${aySummaryCard({ label: "Overdue", value: formatMoney(summary.overdueAmount), href: "/invoices?status=overdue" })}
      ${aySummaryCard({ label: "Paid", value: formatMoney(summary.paidAmount), href: "/invoices?status=paid" })}
    </div></section>
    ${ayFilterTabs(["", "draft", "issued", "sent", "paid", "overdue", "void"].map((status) => ({ label: status ? statusLabel(status) : "All", href: `/invoices${status ? `?status=${status}` : ""}`, active: statusFilter === status })), "Invoice filters")}
    <section class="panel"><h2>Customer invoices</h2>${invoiceTable(invoices, leads)}</section>`
  );
}

function newInvoicePage(config, store, params = new URLSearchParams()) {
  const state = ensureOperationsState(store.state || {}, config);
  const leadId = params.get("jobId") || params.get("leadId") || "";
  const lead = (state.leads || []).find((item) => item.id === leadId) || {};
  return pageShell(
    "New Invoice",
    `<section class="page-intro"><div><h2>Create customer invoice</h2><p>Draft first. Issue later after checking company, VAT and bank details.</p></div><a class="button secondary" href="/invoices">Back to invoices</a></section>
    <section class="panel form-panel">${customerInvoiceForm(state.leads || [], lead, state.companySettings, params.get("type") || "")}</section>`
  );
}

function invoiceDetailPage(invoice, config, store) {
  const state = ensureOperationsState(store.state || {}, config);
  const settings = state.companySettings;
  const lead = (state.leads || []).find((item) => item.id === invoice.lead_id) || {};
  const warnings = companySetupWarnings(settings);
  const emailDraft = invoiceEmailDraft(invoice, settings);
  const canSend = config.sendEmailsEnabled && config.autoSend && config.smtp?.password;
  return pageShell(
    invoice.invoice_number || "Draft Invoice",
    `<section class="page-intro"><div><h2>${escapeHtml(invoice.invoice_number || "Draft invoice")}</h2><p>${escapeHtml(statusLabel(invoice.invoice_type))} for ${escapeHtml(invoice.customer_name || "customer")}.</p></div><div class="actions"><a class="button secondary" href="/invoices">All invoices</a>${lead.id ? `<a class="button secondary" href="/leads/${encodeURIComponent(lead.id)}">Open job</a>` : ""}<a class="button" href="/invoices/${encodeURIComponent(invoice.invoice_id)}/pdf">Download PDF</a></div></section>
    ${warnings.length && invoice.status === "draft" ? `<section class="panel warning-list amber"><h2>Setup warning before issuing</h2><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></section>` : ""}
    <section class="lead-detail summary-grid">
      <div><strong>Status</strong><br>${badge(invoice.status)}</div>
      <div><strong>Invoice type</strong><br>${escapeHtml(statusLabel(invoice.invoice_type))}</div>
      <div><strong>Invoice date</strong><br>${escapeHtml(invoice.invoice_date || "")}</div>
      <div><strong>Due date</strong><br>${escapeHtml(invoice.due_date || "")}</div>
      <div><strong>Net</strong><br>${escapeHtml(formatMoney(invoice.subtotal_net))}</div>
      <div><strong>VAT</strong><br>${escapeHtml(formatMoney(invoice.vat_amount))}</div>
      <div><strong>Total</strong><br>${escapeHtml(formatMoney(invoice.total_gross))}</div>
      <div><strong>Outstanding</strong><br>${escapeHtml(formatMoney(invoice.amount_outstanding))}</div>
    </section>
    <section class="split">
      <article><h2>Invoice actions</h2>
        <div class="actions">
          <form method="post" action="/invoices/${encodeURIComponent(invoice.invoice_id)}/issue"><button ${warnings.length ? `onclick="return confirm('Some setup details are missing. Issue invoice anyway?')"` : ""}>Issue invoice number</button></form>
          <form method="post" action="/invoices/${encodeURIComponent(invoice.invoice_id)}/generate-pdf"><button class="button secondary">Generate PDF</button></form>
        </div>
        <form method="post" action="/invoices/${encodeURIComponent(invoice.invoice_id)}/mark-paid" class="stacked-form">
          ${labeledInput("amount", "Amount paid", invoice.amount_outstanding)}
          ${selectInput("payment_method", CUSTOMER_PAYMENT_METHODS, "Bank transfer")}
          ${labeledInput("payment_date", "Payment date", new Date().toISOString().slice(0, 10), "date")}
          ${labeledInput("reference", "Payment reference", invoice.invoice_number || "")}
          <button>Mark paid / part-paid</button>
        </form>
        <div class="actions"><form method="post" action="/invoices/${encodeURIComponent(invoice.invoice_id)}/archive"><button class="button secondary">Archive</button></form><form method="post" action="/invoices/${encodeURIComponent(invoice.invoice_id)}/void" onsubmit="return confirm('Void this invoice? The number will not be reused.');"><button class="danger-button">Void</button></form></div>
      </article>
      <article><h2>Email preview</h2>
        <p class="muted">${canSend ? "Email sending is enabled, but still requires this button." : "Safe mode: email sending is disabled. Copy text or download PDF."}</p>
        ${labeledInput("email_subject_preview", "Subject", emailDraft.subject)}
        <textarea id="invoice-email">${escapeHtml(emailDraft.body)}</textarea>
        <button onclick="navigator.clipboard.writeText(document.getElementById('invoice-email').value);return false;">Copy email text</button>
        <form method="post" action="/invoices/${encodeURIComponent(invoice.invoice_id)}/send-email"><button ${canSend ? "" : "disabled"}>${canSend ? "Send invoice email" : "Sending disabled"}</button></form>
      </article>
    </section>
    <section class="panel"><h2>Edit draft details</h2>${invoiceEditForm(invoice, state.companySettings)}</section>`
  );
}

function technicianSchedulePage(config, store, params = new URLSearchParams()) {
  const state = ensureOperationsState(store.state || {}, config);
  const summary = scheduleSummary(state);
  const workOrders = state.workOrders || [];
  const filter = params.get("filter") || "today";
  const filtered = filterWorkOrders(workOrders, filter);
  return pageShell(
    "Technician Schedule",
    `<section class="page-intro"><div><h2>Technician schedule</h2><p>Book work, preview daily/weekly digests, and export iOS-compatible calendar files.</p></div><div class="actions"><a class="button" href="/technician-schedule/daily">Daily preview</a><a class="button secondary" href="/technician-schedule/weekly">Weekly preview</a></div></section>
    <section class="ay-section"><div class="ay-summary-grid">
      ${aySummaryCard({ label: "Today", value: String(summary.today), href: "/technician-schedule?filter=today" })}
      ${aySummaryCard({ label: "Tomorrow", value: String(summary.tomorrow), href: "/technician-schedule?filter=tomorrow" })}
      ${aySummaryCard({ label: "This week", value: String(summary.thisWeek), href: "/technician-schedule?filter=week" })}
      ${aySummaryCard({ label: "Unscheduled", value: String(summary.unscheduled), href: "/technician-schedule?filter=unscheduled" })}
      ${aySummaryCard({ label: "Digest not sent", value: String(summary.digestNotSent), href: "/technician-schedule?filter=today" })}
    </div></section>
    ${ayFilterTabs(["today", "tomorrow", "week", "unscheduled", "completed", "all"].map((item) => ({ label: statusLabel(item), href: `/technician-schedule?filter=${item}`, active: filter === item })), "Schedule filters")}
    <section class="panel"><div class="panel-heading"><h2>Work orders needing technician update</h2><div class="actions"><a class="button compact-button" href="/technician-schedule/daily">Preview daily message</a><a class="button secondary compact-button" href="/technician-schedule/weekly">Preview weekly</a></div></div>${workOrderCards(filtered, state, config)}</section>
    <details class="drawer"><summary>Create work order or edit technician setup</summary><div class="drawer-body"><section class="split">
      <article><h2>Create work order</h2>${workOrderForm(state.leads || [], state.technicians || [])}</article>
      <article><h2>Technician</h2>${technicianForm((state.technicians || [])[0] || {})}</article>
    </section></div></details>`
  );
}

function technicianDigestPage(config, store, days, params = new URLSearchParams()) {
  const state = ensureOperationsState(store.state || {}, config);
  const technicianId = params.get("technicianId") || "";
  const digest = digestForTechnician(state, technicianId, new Date(), days);
  const status = messagingStatus(config);
  const to = digest.technician.mobile_number || "";
  return pageShell(
    days > 1 ? "Weekly Schedule Preview" : "Daily Schedule Preview",
    `<section class="page-intro"><div><h2>${escapeHtml(digest.title)}</h2><p>Preview only. Sending remains disabled unless the feature flag and provider setup are deliberately enabled.</p></div><a class="button secondary" href="/technician-schedule">Back to schedule</a></section>
    <section class="split">
      <article><h2>Message preview</h2><textarea id="digest-message">${escapeHtml(digest.body)}</textarea><button onclick="navigator.clipboard.writeText(document.getElementById('digest-message').value);return false;">Copy digest</button>${whatsappLink(to, digest.body) ? `<a class="button secondary" href="${escapeAttr(whatsappLink(to, digest.body))}" target="_blank" rel="noreferrer">Open WhatsApp manually</a>` : ""}</article>
      <article><h2>Sending status</h2>
        ${statusCard({ label: "SMS", value: status.sms.enabled ? "Enabled" : "Disabled", tone: status.sms.enabled ? "amber" : "green", detail: status.sms.detail })}
        ${statusCard({ label: "WhatsApp", value: status.whatsapp.enabled ? "Enabled" : "Disabled", tone: status.whatsapp.enabled ? "amber" : "green", detail: status.whatsapp.detail })}
        ${statusCard({ label: "Calendar", value: config.calendarSyncEnabled ? "Enabled" : "ICS only", tone: config.calendarSyncEnabled ? "amber" : "green", detail: calendarReadiness(config).warning || "Calendar ready" })}
      </article>
    </section>
    <section class="panel"><h2>Jobs in digest</h2>${workOrderCards(digest.orders, state, config)}</section>`
  );
}

function opsSnapshot(leads, config, supplierEmails, store) {
  const checks = systemChecks(config, { ...store, state: { ...(store.state || {}), leads, supplierEmails } }).slice(0, 4);
  return `<section class="panel ops-snapshot"><h2>System snapshot</h2><section class="metrics status-grid">${checks.map(statusCard).join("")}</section></section>`;
}

function systemChecks(config, store) {
  const state = store.state || {};
  const providerName = store.providerName || (config.databaseProvider === "postgres" ? "postgres" : "json");
  const storageDurable = Boolean(store.isDurable || providerName === "postgres");
  return [
    {
      label: "Storage",
      value: storageDurable ? "Durable" : "Local",
      tone: storageDurable ? "green" : "amber",
      detail: storageDurable ? "Render Postgres is active" : store.fallbackReason ? `Fallback: ${store.fallbackReason}` : "JSON tracker file"
    },
    {
      label: "Mailbox",
      value: config.imap.password ? "Ready" : "Password needed",
      tone: config.imap.password ? "green" : "amber",
      detail: `${config.emailProvider} / ${config.imap.username || "not set"}`
    },
    {
      label: "Sending",
      value: config.autoSend ? "Enabled" : "Disabled",
      tone: config.autoSend ? "red" : "green",
      detail: config.autoSend ? "Automatic sending is switched on" : "Draft-only mode"
    },
    {
      label: "Webhook",
      value: config.webhookSecurityMode === "hmac" && !config.webhookSecret ? "Parked" : "Configured",
      tone: config.webhookSecurityMode === "hmac" && !config.webhookSecret ? "amber" : "green",
      detail: `Mode: ${config.webhookSecurityMode}`
    },
    {
      label: "Active leads",
      value: String((state.leads || []).filter((lead) => !["Archived", "Duplicate", "Lost", "Closed"].includes(lead.status) && !lead.closed_at).length),
      tone: "grey",
      detail: `${(state.leads || []).length} total tracker row(s)`
    },
    {
      label: "Supplier review",
      value: String((state.supplierEmails || []).filter((email) => email.reviewStatus !== "Linked").length),
      tone: "grey",
      detail: "Unmatched supplier emails"
    }
  ];
}

function supportWarnings(config, store) {
  const state = ensureOperationsState(ensureFinanceState(store.state || {}), config);
  const warnings = [];
  for (const warning of companySetupWarnings(state.companySettings || {})) {
    warnings.push({ text: warning, why: "Invoices may look incomplete or payment details may be missing.", fix: "/settings", action: "Fix invoice setup" });
  }
  if (!store.isDurable && (process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL)) {
    warnings.push({ text: "Database may not be persistent on Render.", why: "Local file storage can disappear during redeploys unless Postgres or a persistent disk is used.", fix: "/system", action: "Check storage" });
  }
  if (!config.adminUsername || !config.adminPassword) {
    warnings.push({ text: "Admin login is not set.", why: "A client dashboard should not be left open without login protection.", fix: "/setup", action: "Open setup" });
  }
  if (config.autoSend) {
    warnings.push({ text: "Automatic sending is enabled.", why: "This should stay off until email/SMS/WhatsApp workflows have been deliberately tested.", fix: "/system", action: "Check sending" });
  }
  for (const lead of state.leads || []) {
    ensureJobFields(lead);
    const finance = jobFinancials(lead, state);
    if (lead.deposit_received_at && !money(lead.quote_amount || lead.agreed_final_amount)) warnings.push({ text: `Deposit received but no quote amount is recorded for ${lead.customerName || lead.id}.`, why: "The dashboard cannot calculate the remaining customer balance accurately.", fix: `/leads/${encodeURIComponent(lead.id)}`, action: "Open job" });
    if (lead.supplier_invoice_status && lead.supplier_order_required === "yes" && !lead.supplier_order_placed_at) warnings.push({ text: `Supplier invoice exists before supplier order is recorded for ${lead.customerName || lead.id}.`, why: "Supplier costs may be linked to the wrong workflow stage.", fix: `/leads/${encodeURIComponent(lead.id)}`, action: "Open job" });
    if (lead.installation_completed_at && finance.customerOutstanding > 0 && !lead.balance_requested_at) warnings.push({ text: `Installation completed but no balance request is recorded for ${lead.customerName || lead.id}.`, why: "This is money to collect and should not be left invisible.", fix: `/leads/${encodeURIComponent(lead.id)}`, action: "Request balance" });
  }
  for (const invoice of activeInvoices(state)) {
    if (invoice.status === "paid" && money(invoice.amount_outstanding) > 0) warnings.push({ text: `Invoice ${invoice.invoice_number || invoice.invoice_id} is marked paid but still has an outstanding balance.`, why: "Payment reporting may be misleading.", fix: `/invoices/${encodeURIComponent(invoice.invoice_id)}`, action: "Review invoice" });
  }
  if (!warnings.length) return `<p class="empty-state">No setup or workflow warnings found.</p>`;
  return `<div class="warning-stack">${warnings.slice(0, 12).map((item) => `<article class="warning-card"><h3>${escapeHtml(item.text)}</h3><p>${escapeHtml(item.why)}</p><a class="button compact-button" href="${escapeAttr(item.fix)}">${escapeHtml(item.action)}</a></article>`).join("")}</div>`;
}

function dashboardWarningSummary(config, store) {
  const state = ensureOperationsState(ensureFinanceState(store.state || {}), config);
  const setup = companySetupWarnings(state.companySettings || {});
  const storageRisk = !store.isDurable && (process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL);
  const autoSendRisk = config.autoSend;
  const items = [
    ...setup.slice(0, 2),
    storageRisk ? "Database may not be persistent on Render." : "",
    autoSendRisk ? "Automatic sending is enabled." : ""
  ].filter(Boolean);
  if (!items.length) return `<p class="empty-state">No setup warnings. The operating board looks healthy.</p>`;
  return `<div class="warning-stack compact">${items.map((item) => `<article class="warning-card amber"><h3>${escapeHtml(item)}</h3><p>Open System or Settings to fix this before relying on the dashboard for live work.</p><a class="button compact-button" href="/system">Fix</a></article>`).join("")}</div>`;
}

function supplierInvoiceFilter(invoice, filter) {
  const outstanding = money(invoice.amountOutstanding);
  if (filter === "due") return !invoice.archivedAt && outstanding > 0 && !isPastDate(invoice.dueDate);
  if (filter === "part-paid") return !invoice.archivedAt && invoice.paymentStatus === "Part paid";
  if (filter === "overdue") return !invoice.archivedAt && outstanding > 0 && isPastDate(invoice.dueDate);
  if (filter === "paid") return !invoice.archivedAt && outstanding <= 0;
  if (filter === "archived") return Boolean(invoice.archivedAt);
  return true;
}

function statusCard(check) {
  return `<div class="status-card ${escapeAttr(check.tone)}"><span>${escapeHtml(check.label)}</span><strong>${escapeHtml(check.value)}</strong><small>${escapeHtml(check.detail)}</small></div>`;
}

function calendarNotificationChecks(config, store) {
  const calendar = calendarReadiness(config);
  const notificationStatus = messagingStatus(config);
  const techNotify = config.techNotify || {};
  const failedMessage = (store.state.messageQueue || [])
    .filter((message) => message.status === "failed")
    .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")))[0];
  const calendarValues = {
    ready: { value: "Active", tone: "green" },
    disabled: { value: "ICS download only", tone: "green" },
    warning: { value: "Check CalDAV", tone: "amber" }
  };
  const calendarCard = calendarValues[calendar.status] || calendarValues.warning;

  return [
    { label: "Installation calendar", value: calendarCard.value, tone: calendarCard.tone, detail: calendar.warning || "" },
    { label: "Technician portal", value: "Not set up yet", tone: "amber", detail: "Secure technician access is planned (Phase 3)." },
    notificationChannelCheck("Email notifications", "email", notificationStatus.email, techNotify.emailEnabled),
    notificationChannelCheck("SMS notifications", "SMS", notificationStatus.sms, techNotify.smsEnabled),
    notificationChannelCheck("WhatsApp notifications", "WhatsApp", notificationStatus.whatsapp, techNotify.whatsappEnabled),
    techNotify.autoSend
      ? { label: "Automatic sending", value: "ON", tone: "amber", detail: "Auto-send is enabled — verify before relying on it." }
      : { label: "Automatic sending", value: "Off", tone: "green", detail: "Safe: nothing sends without manual action." },
    techNotify.dryRun
      ? { label: "Dry run", value: "On", tone: "green", detail: "Messages are simulated, not sent." }
      : { label: "Dry run", value: "Off", tone: "amber", detail: "Dry-run disabled." },
    failedMessage
      ? { label: "Last notification error", value: truncateText(failedMessage.error || "No error recorded", 90), tone: "red", detail: dateTimeLabel(failedMessage.updated_at || failedMessage.created_at) }
      : { label: "Last notification error", value: "None", tone: "green", detail: "" },
    { label: "Email classifier", value: "Rule-based", tone: "green", detail: "Deterministic rules; AI classifier disabled." }
  ];
}

function notificationChannelCheck(label, channelName, status = {}, enabled) {
  if (!enabled) {
    return { label, value: "Off (draft only)", tone: "green", detail: `Technician ${channelName} sending is disabled.` };
  }
  if (!status.configured) {
    return { label, value: "Enabled, not configured", tone: "amber", detail: `Technician ${channelName} sending is enabled but provider credentials are incomplete.` };
  }
  return { label, value: "Enabled", tone: "amber", detail: `Technician ${channelName} provider is configured; verify before relying on live sending.` };
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function latestActivity(state) {
  const logs = (state.logs || []).map((log) => ({ at: log.timestamp, title: log.message, detail: JSON.stringify(log.details || {}) }));
  const events = (state.jobEvents || []).map((event) => ({ at: event.createdAt, title: event.eventType || "Job event", detail: [event.leadId, event.eventNote].filter(Boolean).join(" - ") }));
  return [...logs, ...events].filter((item) => item.at).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 10);
}

function activityList(items) {
  return `<div class="card-grid">${items.map((item) => `<article><h3>${escapeHtml(item.title)}</h3><p class="muted">${escapeHtml(shortDate(item.at))}</p><p>${escapeHtml(String(item.detail || "").slice(0, 160))}</p></article>`).join("")}</div>`;
}

function financeCards(summary) {
  return [
    metricCard("Open pipeline", summary.openPipelineValue, "/finance", "green", true),
    metricCard("Accepted jobs", summary.acceptedJobsValue, "/finance", "green", true),
    metricCard("Customer paid", summary.totalCustomerPaid, "/finance", "green", true),
    metricCard("Customer outstanding", summary.customerOutstanding, "/finance", summary.customerOutstanding ? "amber" : "green", true),
    metricCard("Balance due after installs", summary.balanceDueAfterCompletedInstalls, "/finance", summary.balanceDueAfterCompletedInstalls ? "amber" : "green", true),
    metricCard("Supplier invoices", summary.supplierInvoicesReceived, "/finance", summary.supplierInvoicesReceived ? "amber" : "green", true),
    metricCard("Paid to suppliers", summary.totalSupplierPaid, "/finance", "green", true),
    metricCard("Supplier outstanding", summary.supplierOutstanding, "/finance", summary.supplierOutstanding ? "amber" : "green", true),
    metricCard("Part-paid supplier invoices", summary.partPaidSupplierInvoices, "/finance", summary.partPaidSupplierInvoices ? "amber" : "green"),
    metricCard("Net forecast", summary.netCashPosition, "/finance", summary.netCashPosition < 0 ? "red" : "green", true),
    metricCard("Overdue customer payments", summary.overdueCustomerPayments, "/finance", summary.overdueCustomerPayments ? "red" : "green", true),
    metricCard("Overdue supplier payments", summary.overdueSupplierPayments, "/finance", summary.overdueSupplierPayments ? "red" : "green", true),
    metricCard("Supplier due this week", summary.supplierDueThisWeek, "/finance", summary.supplierDueThisWeek ? "amber" : "green", true),
    metricCard("Estimated supplier costs", summary.expectedSupplierCosts, "/finance", summary.expectedSupplierCosts ? "amber" : "green", true),
    metricCard("Expected margin", summary.expectedGrossMargin, "/finance", summary.expectedGrossMargin < 0 ? "red" : "green", true)
  ];
}

function metricCard(label, value, href, tone = "grey", moneyValue = false) {
  return `<a class="metric-card ${escapeAttr(tone)}" href="${escapeAttr(href)}"><strong>${moneyValue ? escapeHtml(formatMoney(value)) : escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></a>`;
}

function actionRow([label, value, href, tone = "grey", detail = "Open"]) {
  return `<a class="action-row ${escapeAttr(tone)}" href="${escapeAttr(href)}"><span class="action-count">${escapeHtml(value)}</span><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></span><span class="button compact-button">Open</span></a>`;
}

function dashboardTodayRows(counts, invoices, schedule) {
  return [
    ["New enquiries needing reply", counts.newEnquiries, "/leads?quick=new", counts.newEnquiries ? "amber" : "green", "Review and approve draft replies"],
    ["Deposits to chase", counts.acceptedNeedDeposit, "/leads?quick=deposits", counts.acceptedNeedDeposit ? "amber" : "green", "Accepted jobs waiting on deposit"],
    ["Supplier orders to place", counts.depositsOrderSupplier, "/leads?quick=supplier-orders", counts.depositsOrderSupplier ? "amber" : "green", "Deposits received, order not placed"],
    ["Supplier emails needing review", counts.supplierEmailsNeedingReview, "/supplier-emails", counts.supplierEmailsNeedingReview ? "amber" : "green", "Inbox items to link or archive"],
    ["Installs to book", counts.deliveredBookInstall, "/leads?quick=installations", counts.deliveredBookInstall ? "amber" : "green", "Ready to install"],
    ["Work scheduled today", schedule.today, "/technician-schedule?filter=today", schedule.today ? "green" : "grey", "Technician work for today"],
    ["Balances to request", counts.balanceDue || invoices.balanceInvoicesDue, "/leads?quick=payments", counts.balanceDue || invoices.balanceInvoicesDue ? "amber" : "green", "Completed work needing payment request"],
    ["Overdue items", counts.overdueCustomerUpdates || invoices.overdueCount, "/leads?quick=overdue", counts.overdueCustomerUpdates || invoices.overdueCount ? "red" : "green", "Needs attention first"]
  ].filter(([, value]) => value > 0).slice(0, 8);
}

function moneyCockpitCards(summary) {
  return [
    summaryCard("Customer balance", summary.customerOutstanding, "amber", true),
    summaryCard("Owed to supplier", summary.supplierOutstanding, summary.supplierOutstanding ? "red" : "green", true),
    summaryCard("Accepted work", summary.acceptedJobsValue, "green", true),
    summaryCard("Net forecast", summary.netCashPosition, summary.netCashPosition < 0 ? "red" : "green", true),
    summaryCard("Overdue customer", summary.overdueCustomerPayments, summary.overdueCustomerPayments ? "red" : "green", true)
  ];
}

function summaryCard(label, value, tone = "grey", moneyValue = false) {
  return `<div class="summary-card ${escapeAttr(tone)}"><strong>${moneyValue ? escapeHtml(formatMoney(value)) : escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`;
}

function commercialActionItems(state, config = {}) {
  ensureFinanceState(state);
  ensureOperationsState(state, config);
  const now = new Date();
  const leads = (state.leads || []).map((lead) => ensureJobFields(lead, now));
  const items = [];
  for (const lead of leads) {
    if (["Archived", "Duplicate", "Lost", "Closed"].includes(lead.status) || lead.closed_at) continue;
    const finance = jobFinancials(lead, state);
    const href = `/leads/${encodeURIComponent(lead.id)}`;
    const customer = lead.customerName || lead.customerPostcode || lead.id;
    const base = { lead, href, customer, postcode: lead.customerPostcode || "", value: finance.customerOutstanding || money(lead.quote_amount || lead.agreed_final_amount), tone: lead.operational_risk_level || "green" };
    if (!lead.draftReply && !lead.quote_sent_at && !lead.quote_accepted_at) items.push({ ...base, group: "customer", reason: "New lead has not been replied to", nextAction: "Review enquiry", tone: "amber" });
    if (lead.status === "Awaiting approval" || lead.draftReply) items.push({ ...base, group: "customer", reason: "Draft reply is waiting for approval", nextAction: "Review reply" });
    if (lead.quote_sent_at && !lead.quote_accepted_at) items.push({ ...base, group: "customer", reason: quoteAgeReason(lead), nextAction: "Chase quote decision", tone: lead.operational_risk_level === "red" ? "red" : "amber" });
    if (lead.quote_accepted_at && lead.deposit_required === "yes" && !lead.deposit_received_at) items.push({ ...base, group: "payment", reason: "Quote accepted but deposit is not recorded", nextAction: "Request or record deposit", tone: "amber", value: money(lead.deposit_amount) || finance.customerOutstanding });
    if ((lead.deposit_received_at || lead.deposit_required !== "yes") && lead.supplier_order_required === "yes" && !lead.supplier_order_placed_at) items.push({ ...base, group: "supplier", reason: "Deposit is in, supplier order has not been placed", nextAction: "Place supplier order", tone: "amber" });
    if (lead.supplier_order_placed_at && !lead.supplier_confirmation_received_at) items.push({ ...base, group: "supplier", reason: "Supplier order is missing confirmation", nextAction: "Link supplier confirmation", tone: "amber" });
    if (deliveryOverdue(lead, now)) items.push({ ...base, group: "risk", reason: "Supplier delivery appears overdue", nextAction: "Check supplier delivery", tone: "red" });
    if (deliveryDueSoon(lead, now) && !deliveryOverdue(lead, now)) items.push({ ...base, group: "supplier", reason: "Supplier delivery is due soon", nextAction: "Check delivery date", tone: "amber" });
    if (lead.supplier_actual_delivery_date && !lead.installation_scheduled_at) items.push({ ...base, group: "install", reason: "Door is ready but install is not booked", nextAction: "Book installation", tone: "amber" });
    if (lead.installation_scheduled_at && !lead.installation_completed_at && isUiNextDays(lead.installation_scheduled_at, 1, now)) items.push({ ...base, group: "install", reason: "Installation is scheduled today or tomorrow", nextAction: "Check technician schedule", tone: "green" });
    if (lead.installation_completed_at && finance.customerOutstanding > 0) items.push({ ...base, group: "payment", reason: "Installation complete with balance outstanding", nextAction: lead.balance_requested_at ? "Chase balance" : "Request balance", tone: isPastDate(lead.balance_requested_at || lead.installation_completed_at) ? "red" : "amber", value: finance.customerOutstanding });
    if (lead.operational_risk_level === "red") items.push({ ...base, group: "risk", reason: lead.next_best_action || "Job is marked high risk", nextAction: "Open job", tone: "red" });
  }
  for (const email of state.supplierEmails || []) {
    const status = String(email.reviewStatus || "Needs review").toLowerCase();
    if (email.archivedAt || ["linked", "archived", "irrelevant", "duplicate"].includes(status)) continue;
    items.push({
      group: "supplier",
      customer: email.supplierName || email.supplierEmail || "Supplier email",
      postcode: email.extractedOrderReference || "",
      reason: email.subject || "Supplier email needs review",
      nextAction: email.matchedLeadId ? "Review match" : "Link or archive email",
      value: 0,
      tone: email.matchedLeadId ? "green" : "amber",
      href: `/supplier-emails/${encodeURIComponent(email.id)}`
    });
  }
  for (const invoice of (state.supplierInvoices || []).filter((item) => !item.archivedAt).map((item) => calculateSupplierInvoiceBalance(item, state))) {
    if (money(invoice.amountOutstanding) <= 0) continue;
    const dueSoon = invoice.dueDate && isUiNextDays(invoice.dueDate, 7, now);
    const overdueInvoice = invoice.dueDate && isPastDate(invoice.dueDate);
    if (dueSoon || overdueInvoice) {
      items.push({
        group: overdueInvoice ? "risk" : "payment",
        customer: invoice.supplierName || "Supplier invoice",
        postcode: invoice.invoiceReference || "",
        reason: overdueInvoice ? "Supplier invoice is overdue" : "Supplier invoice due this week",
        nextAction: "Review or record payment",
        value: money(invoice.amountOutstanding),
        tone: overdueInvoice ? "red" : "amber",
        href: "/finance#supplier-invoices"
      });
    }
  }
  return uniqueActionItems(items).sort((a, b) => riskWeightForUi(b.tone) - riskWeightForUi(a.tone) || money(b.value) - money(a.value)).slice(0, 40);
}

function uniqueActionItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.href}:${item.reason}:${item.nextAction}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function todayItemCards(items) {
  if (!items.length) return `<p class="empty-state">Nothing urgent in this section.</p>`;
  return `<div class="today-command-list">${items.map(todayItemCard).join("")}</div>`;
}

function todayItemCard(item) {
  return `<article class="today-command-card ${escapeAttr(item.tone || "green")}">
    <div>${ragBadge(item.tone || "green")}</div>
    <div><h3>${escapeHtml(item.customer)}</h3><p>${escapeHtml([item.postcode, item.reason].filter(Boolean).join(" - "))}</p>${item.value ? `<p><strong>${escapeHtml(formatMoney(item.value))}</strong></p>` : ""}</div>
    <a class="button compact-button" href="${escapeAttr(item.href)}">${escapeHtml(item.nextAction || "Open")}</a>
  </article>`;
}

function valueTrackerSection(state, leads, summary = financeSummary(leads || [], state || {})) {
  const value = valueMetrics(state || {}, leads || [], summary);
  return `<section class="panel calm"><div class="panel-heading"><div><h2>Value created / Business impact</h2><p class="muted">Careful operational signals. This does not claim accounting profit or money saved.</p></div><a class="button secondary compact-button" href="/today">Open Today</a></div><section class="summary-strip">
    ${summaryCard("Leads captured this month", value.leadsThisMonth, value.leadsThisMonth ? "green" : "grey")}
    ${summaryCard("Quotes sent", value.quotesSent, value.quotesSent ? "green" : "grey")}
    ${summaryCard("Accepted work tracked", value.acceptedWorkValue, "green", true)}
    ${summaryCard("Outstanding balances visible", value.customerOutstanding, value.customerOutstanding ? "amber" : "green", true)}
    ${summaryCard("Potential missed actions caught", value.actionItems, value.actionItems ? "amber" : "green")}
    ${summaryCard("Tracked pipeline", value.pipelineValue, "green", true)}
  </section></section>`;
}

function valueMetrics(state, leads, summary) {
  const month = new Date().toISOString().slice(0, 7);
  const monthLeads = leads.filter((lead) => String(lead.receivedAt || lead.createdAt || "").startsWith(month));
  return {
    leadsThisMonth: monthLeads.length,
    leadsRepliedTo: leads.filter((lead) => lead.draftReply || lead.quote_sent_at || ["Replied", "Quoted", "Won"].includes(lead.status)).length,
    quotesSent: leads.filter((lead) => lead.quote_sent_at || lead.status === "Quoted").length,
    acceptedWorkValue: summary.acceptedJobsValue,
    depositsCollected: (state.customerPayments || []).filter((payment) => /deposit/i.test(payment.paymentType || "")).reduce((total, payment) => total + money(payment.amount), 0),
    customerOutstanding: summary.customerOutstanding,
    actionItems: commercialActionItems(state).length,
    pipelineValue: summary.openPipelineValue,
    invoicesIssued: activeInvoices(state).filter((invoice) => ["issued", "sent", "part_paid", "paid", "overdue"].includes(invoice.status)).length,
    installsBooked: (state.workOrders || []).filter((order) => order.scheduled_start).length
  };
}

function summaryPreviewReports(state, leads) {
  const summary = financeSummary(leads, state);
  const items = commercialActionItems(state);
  const value = valueMetrics(state, leads, summary);
  const weekly = [
    `Weekly business summary`,
    `Jobs requiring action: ${items.length}`,
    `Customer balance visible: ${formatMoney(summary.customerOutstanding)}`,
    `Supplier owed: ${formatMoney(summary.supplierOutstanding)}`,
    `Tracked pipeline: ${formatMoney(value.pipelineValue)}`
  ].join("\n");
  const stuck = items.filter((item) => item.tone === "red" || item.tone === "amber").slice(0, 8).map((item) => `- ${item.customer}: ${item.reason}`).join("\n") || "- No stuck jobs.";
  return `<section class="split"><article><h2>Weekly business summary</h2><textarea>${escapeHtml(weekly)}</textarea></article><article><h2>Jobs stuck report</h2><textarea>${escapeHtml(stuck)}</textarea></article></section>`;
}

function demoBanner() {
  return `<section class="panel demo-banner"><strong>Demo mode</strong><span>Fake trade-business data only. Nothing here is written to the live tracker.</span></section>`;
}

function setupChecklist(config, store) {
  const state = ensureOperationsState(store.state || {}, config);
  const settings = state.companySettings || {};
  const hasLead = (state.leads || []).length > 0;
  const hasQuote = (state.leads || []).some((lead) => lead.quote_sent_at || lead.status === "Quoted");
  return [
    { label: "Business details entered", done: Boolean(settings.companyLegalName && settings.phone && settings.email && settings.registeredOfficeAddress), fix: "/settings", detail: "Needed for invoices and customer confidence." },
    { label: "Invoice settings complete", done: !companySetupWarnings(settings).length, fix: "/settings", detail: "Needed before issuing professional invoices." },
    { label: "Email sync tested", done: Boolean((state.logs || []).some((log) => /email/i.test(log.message || ""))), fix: "/setup", detail: "Run inbox sync once and confirm leads are classified correctly." },
    { label: "Admin login set", done: Boolean(config.adminUsername && config.adminPassword), fix: "/setup", detail: "Protect the dashboard before client use." },
    { label: "First lead added", done: hasLead, fix: "/manual-lead", detail: "Proves the lead workflow." },
    { label: "First quote recorded", done: hasQuote, fix: "/leads", detail: "Proves quote and follow-up tracking." },
    { label: "First invoice generated", done: (state.customerInvoices || []).length > 0, fix: "/invoices", detail: "Proves invoice/PDF workflow." },
    { label: "First backup/export completed", done: Boolean((state.logs || []).some((log) => /export|backup/i.test(log.message || ""))), fix: "/system", detail: "Shows the client they can leave with their data." },
    { label: "Technician/work order added", done: (state.technicians || []).length > 0 || (state.workOrders || []).length > 0, fix: "/technician-schedule", detail: "Needed for installation businesses." }
  ];
}

function setupStepCard(item) {
  return `<a class="setup-step ${item.done ? "green" : "amber"}" href="${escapeAttr(item.fix)}"><span>${item.done ? "Complete" : "Action needed"}</span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></a>`;
}

function quoteAgeReason(lead) {
  const days = ageInDays(lead.quote_sent_at);
  return days > 0 ? `Quote sent ${days} day${days === 1 ? "" : "s"} ago` : "Quote sent, decision not recorded";
}

function ageInDays(value) {
  if (!value) return 0;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
}

function demoStore(config = {}) {
  const today = new Date();
  const iso = (days, hour = 9) => {
    const date = addUiDays(today, days);
    date.setHours(hour, 0, 0, 0);
    return date.toISOString();
  };
  const day = (days) => iso(days).slice(0, 10);
  const leads = [
    demoLead("demo-new", "Priya Shah", "HD1 2AB", "New Checkatrade enquiry for a sectional garage door. Customer wants a quote this week.", { receivedAt: iso(0, 7), status: "Awaiting approval", sourcePlatform: "Checkatrade", customerPhone: "07700 900101", draftReply: "Thanks Priya, we can help with a sectional garage door quote..." }),
    demoLead("demo-quote", "Martin Cole", "HX3 0AA", "Repair enquiry. Garage door cable has snapped and door is stuck open.", { status: "Quoted", quote_sent_at: iso(-4), quote_amount: 240, workflow_type: "repair", priorityLabel: "High", urgency: "Urgent" }),
    demoLead("demo-deposit", "Aisha Khan", "WF14 8HE", "Replacement insulated roller door in anthracite.", { status: "Won", quote_sent_at: iso(-7), quote_accepted_at: iso(-2), quote_amount: 1850, deposit_required: "yes", deposit_amount: 600, supplier_order_required: "yes" }),
    demoLead("demo-order", "David Hughes", "HD8 8EL", "Supply and fit electric roller door.", { status: "Won", quote_sent_at: iso(-10), quote_accepted_at: iso(-8), quote_amount: 2200, deposit_required: "yes", deposit_amount: 700, deposit_received_at: iso(-7), supplier_order_required: "yes" }),
    demoLead("demo-confirm", "Nina Patel", "LS27 9LP", "New up and over garage door.", { status: "Won", quote_sent_at: iso(-15), quote_accepted_at: iso(-12), quote_amount: 1450, deposit_required: "yes", deposit_amount: 450, deposit_received_at: iso(-11), supplier_order_required: "yes", supplier_order_placed_at: iso(-9), supplier_order_reference: "GAR-1041" }),
    demoLead("demo-delivery", "Paul Green", "BD19 3TT", "Replacement sectional door awaiting supplier delivery.", { status: "Won", quote_sent_at: iso(-25), quote_accepted_at: iso(-22), quote_amount: 2750, deposit_required: "yes", deposit_amount: 900, deposit_received_at: iso(-21), supplier_order_required: "yes", supplier_order_placed_at: iso(-20), supplier_confirmation_received_at: iso(-18), supplier_estimated_delivery_date: day(-1), supplier_order_reference: "SEC-7781" }),
    demoLead("demo-install", "Helen Brooks", "HD3 4QQ", "Door delivered and ready to install.", { status: "Won", quote_sent_at: iso(-30), quote_accepted_at: iso(-28), quote_amount: 1995, deposit_required: "yes", deposit_amount: 650, deposit_received_at: iso(-27), supplier_order_required: "yes", supplier_order_placed_at: iso(-26), supplier_confirmation_received_at: iso(-24), supplier_actual_delivery_date: day(-1), supplier_order_reference: "ROL-2220" }),
    demoLead("demo-balance", "Owen Morris", "OL14 5DR", "Installation completed. Balance still outstanding.", { status: "Installation completed", quote_sent_at: iso(-40), quote_accepted_at: iso(-36), quote_amount: 2400, deposit_required: "yes", deposit_amount: 800, deposit_received_at: iso(-35), supplier_order_required: "yes", supplier_order_placed_at: iso(-34), supplier_confirmation_received_at: iso(-30), supplier_actual_delivery_date: day(-6), installation_scheduled_at: iso(-1, 10), installation_completed_at: iso(-1, 15), balance_requested_at: "" })
  ];
  const state = {
    leads,
    supplierEmails: [
      { id: "demo-supplier-email-1", supplierName: "Garage Door Supplies Ltd", supplierEmail: "orders@example-supplier.test", subject: "Order GAR-1041 confirmation", receivedAt: iso(0, 8), reviewStatus: "Needs review", extractedOrderReference: "GAR-1041", matchedLeadId: "demo-confirm", matchConfidence: 94, rawSummary: "Manufacturing confirmation and 4-6 week lead time." },
      { id: "demo-supplier-email-2", supplierName: "Roller Door Trade", supplierEmail: "accounts@example-supplier.test", subject: "Invoice RDT-883 part paid", receivedAt: iso(-1, 13), reviewStatus: "Needs review", invoiceReference: "RDT-883", rawSummary: "Supplier invoice for demo install job. Balance remains due Friday." }
    ],
    customerPayments: [
      { id: "demo-cp-1", leadId: "demo-order", paymentType: "deposit", amount: 700, paymentMethod: "Bank transfer", paymentDate: day(-7), reference: "DEMO-DEP", notes: "", createdAt: iso(-7), updatedAt: iso(-7), archivedAt: "" },
      { id: "demo-cp-2", leadId: "demo-balance", paymentType: "deposit", amount: 800, paymentMethod: "Bank transfer", paymentDate: day(-35), reference: "DEMO-DEP2", notes: "", createdAt: iso(-35), updatedAt: iso(-35), archivedAt: "" }
    ],
    supplierInvoices: [
      createSupplierInvoice({ id: "demo-si-1", leadId: "demo-balance", supplier_name: "Roller Door Trade", invoice_reference: "RDT-883", invoice_date: day(-10), due_date: day(5), net_amount: 1000, vat_amount: 200, gross_amount: 1200, amount_paid: 500, payment_status: "Part paid" }, "demo-balance")
    ],
    supplierPayments: [{ id: "demo-sp-1", invoiceId: "demo-si-1", leadId: "demo-balance", supplierName: "Roller Door Trade", amount: 500, paymentMethod: "Bank transfer", paidAt: day(-5), reference: "PART", notes: "", createdAt: iso(-5), updatedAt: iso(-5), archivedAt: "" }],
    customerInvoices: [
      { invoice_id: "demo-ci-1", invoice_number: "ADY-000123", invoice_type: "balance", job_id: "demo-balance", lead_id: "demo-balance", customer_name: "Owen Morris", customer_email: "owen@example.test", customer_phone: "07700 900108", customer_billing_address: "12 Demo Street, Todmorden", customer_postcode: "OL14 5DR", invoice_date: day(-1), supply_date: day(-1), due_date: day(6), payment_terms: "7 days", status: "issued", line_items_json: "[]", subtotal_net: 1600, vat_rate: 0, vat_amount: 0, total_gross: 1600, amount_paid: 0, amount_outstanding: 1600, payment_instructions: "Demo bank details", notes: "", pdf_path: "", sent_at: "", created_at: iso(-1), updated_at: iso(-1), archived_at: "" }
    ],
    technicians: [{ id: "demo-tech-1", name: "Luis", mobile_number: "07700 900999", whatsapp_number: "07700 900999", email: "tech@example.test", calendar_type: "ics", calendar_identifier: "", active: true, notes: "", created_at: iso(-10), updated_at: iso(-10) }],
    workOrders: [
      createWorkOrder({ id: "demo-wo-1", lead_id: "demo-install", technician_id: "demo-tech-1", scheduled_start: iso(0, 10), scheduled_end: iso(0, 14), time_window: "10:00-14:00", status: "scheduled" }, leads.find((lead) => lead.id === "demo-install")),
      createWorkOrder({ id: "demo-wo-2", lead_id: "demo-balance", technician_id: "demo-tech-1", scheduled_start: iso(-1, 10), scheduled_end: iso(-1, 15), time_window: "10:00-15:00", status: "completed" }, leads.find((lead) => lead.id === "demo-balance"))
    ],
    logs: [{ timestamp: iso(0, 8), message: "Demo mailbox scanned", details: { added: 1, supplierReviews: 2 } }],
    jobEvents: []
  };
  ensureFinanceState(state);
  ensureOperationsState(state, config);
  for (const invoice of state.supplierInvoices) applySupplierPayment(invoice, state);
  return { state, providerName: "demo", isDurable: true, demo: true };
}

function demoLead(id, customerName, postcode, jobDescription, overrides = {}) {
  const lead = {
    id,
    receivedAt: overrides.receivedAt || new Date().toISOString(),
    customerName,
    customerEmail: overrides.customerEmail || `${customerName.toLowerCase().replace(/[^a-z]+/g, ".")}@example.test`,
    customerPhone: overrides.customerPhone || "07700 900000",
    customerAddress: overrides.customerAddress || `${Math.floor(Math.random() * 80) + 1} Demo Road`,
    customerPostcode: postcode,
    customerTownArea: postcode.split(" ")[0],
    status: overrides.status || "New",
    sourcePlatform: overrides.sourcePlatform || "Email",
    jobDescription,
    garageDoorIssue: jobDescription,
    urgency: overrides.urgency || "Normal",
    priorityLabel: overrides.priorityLabel || "Medium",
    draftReply: overrides.draftReply || "",
    operational_risk_level: overrides.operational_risk_level || "amber",
    updatedAt: overrides.updatedAt || overrides.receivedAt || new Date().toISOString(),
    ...overrides
  };
  ensureJobFields(lead);
  return lead;
}

function financeJobTable(items) {
  if (!items.length) return `<p class="muted">No matching jobs.</p>`;
  return `<table><thead><tr><th>Job</th><th>Customer</th><th>Status</th><th>Agreed</th><th>Paid</th><th>Outstanding</th><th>Supplier costs</th><th>Supplier owed</th><th>Margin</th></tr></thead><tbody>${items
    .map(({ lead, finance }) => `<tr><td><a href="/leads/${encodeURIComponent(lead.id)}">${escapeHtml(lead.id)}</a></td><td>${escapeHtml(lead.customerName || lead.customerPostcode || "")}</td><td>${escapeHtml(finance.customerPaymentStatus)}</td><td>${escapeHtml(formatMoney(finance.customerAgreed))}</td><td>${escapeHtml(formatMoney(finance.customerPaid))}</td><td>${escapeHtml(formatMoney(finance.customerOutstanding))}</td><td>${escapeHtml(formatMoney(finance.supplierGross))}</td><td>${escapeHtml(formatMoney(finance.supplierOutstanding))}</td><td>${escapeHtml(formatMoney(finance.estimatedGrossMargin))}<br>${escapeHtml(String(finance.estimatedGrossMarginPercent))}%</td></tr>`)
    .join("")}</tbody></table>`;
}

function supplierInvoiceTable(invoices, leads) {
  if (!invoices.length) return `<p class="muted">No supplier invoices.</p>`;
  const leadNames = new Map((leads || []).map((lead) => [lead.id, lead.customerName || lead.customerPostcode || lead.id]));
  return `<table><thead><tr><th>Supplier</th><th>Invoice</th><th>Job</th><th>Dates</th><th>Net</th><th>VAT</th><th>Gross</th><th>Paid</th><th>Outstanding</th><th>Status</th><th>Linked email</th><th>Actions</th></tr></thead><tbody>${invoices
    .map((invoice) => `<tr><td>${escapeHtml(invoice.supplierName || "Unknown")}</td><td>${escapeHtml(invoice.invoiceReference || invoice.id)}${invoice.warnings?.length ? `<br><span class="status-warning">${escapeHtml(invoice.warnings.join(" | "))}</span>` : ""}</td><td>${invoice.leadId ? `<a href="/leads/${encodeURIComponent(invoice.leadId)}">${escapeHtml(leadNames.get(invoice.leadId) || invoice.leadId)}</a>` : ""}</td><td><span class="muted">Invoice</span><br>${escapeHtml(invoice.invoiceDate || "")}<br><span class="muted">Due</span><br>${escapeHtml(invoice.dueDate || "")}</td><td>${escapeHtml(formatMoney(invoice.netAmount))}</td><td>${escapeHtml(formatMoney(invoice.vatAmount))}</td><td>${escapeHtml(formatMoney(invoice.grossAmount))}</td><td>${escapeHtml(formatMoney(invoice.amountPaid))}</td><td>${invoice.overpaidAmount ? `<span class="status-warning">${escapeHtml(`Overpaid by ${formatMoney(invoice.overpaidAmount)}`)}</span>` : escapeHtml(formatMoney(invoice.amountOutstanding))}</td><td>${badge(invoice.paymentStatus || "Invoice received")}</td><td>${escapeHtml(invoice.supplierEmailId || invoice.invoiceEmailMessageId || "")}</td><td>${supplierInvoiceControls(invoice, leads)}</td></tr>`)
    .join("")}</tbody></table>`;
}

function supplierInvoiceControls(invoice, leads) {
  return `<details>
    <summary>Actions</summary>
    <h3>Record payment</h3>
    ${supplierPaymentForm([invoice])}
    <h3>Edit invoice</h3>
    <form method="post" action="/finance/supplier-invoices/${encodeURIComponent(invoice.id)}/edit" class="stacked-form">
      ${leadSelect(leads, invoice.leadId)}
      ${labeledInput("supplier_name", "Supplier name", invoice.supplierName)}
      ${labeledInput("invoice_reference", "Invoice reference", invoice.invoiceReference)}
      ${labeledInput("invoice_date", "Invoice date", invoice.invoiceDate, "date", "Date shown on supplier invoice")}
      ${labeledInput("due_date", "Payment due date", invoice.dueDate, "date", "When this supplier invoice needs paying")}
      ${labeledInput("net_amount", "Net amount", invoice.netAmount)}
      ${labeledInput("vat_amount", "VAT amount", invoice.vatAmount)}
      ${labeledInput("gross_amount", "Gross invoice total", invoice.grossAmount, "text", "Total amount owed to supplier including VAT")}
      ${labeledInput("supplier_email_id", "Linked supplier email", invoice.supplierEmailId, "text", "Optional supplier email review item ID")}
      ${selectInput("payment_status", SUPPLIER_PAYMENT_STATUSES, invoice.paymentStatus || "Invoice received")}
      <textarea name="notes" placeholder="Invoice notes">${escapeHtml(invoice.notes || "")}</textarea>
      <button class="compact-button">Save</button>
    </form>
    <form method="post" action="/finance/supplier-invoices/${encodeURIComponent(invoice.id)}/archive"><button class="compact-button">Archive</button></form>
    <form method="post" action="/finance/supplier-invoices/${encodeURIComponent(invoice.id)}/delete" onsubmit="return confirm('Delete this supplier invoice permanently? Existing payment records are kept for audit unless separately removed.');"><button class="compact-button danger-button">Delete</button></form>
  </details>`;
}

function customerPaymentTable(payments, leads) {
  if (!payments.length) return `<p class="muted">No customer payments recorded.</p>`;
  const leadNames = new Map((leads || []).map((lead) => [lead.id, lead.customerName || lead.customerPostcode || lead.id]));
  return `<table><thead><tr><th>Date</th><th>Job</th><th>Type</th><th>Amount</th><th>Method</th><th>Reference</th><th>Actions</th></tr></thead><tbody>${payments
    .map((payment) => `<tr><td>${escapeHtml(payment.paymentDate || "")}</td><td>${payment.leadId ? `<a href="/leads/${encodeURIComponent(payment.leadId)}">${escapeHtml(leadNames.get(payment.leadId) || payment.leadId)}</a>` : ""}</td><td>${escapeHtml(payment.paymentType || "")}</td><td>${escapeHtml(formatMoney(payment.amount))}</td><td>${escapeHtml(payment.paymentMethod || "Unknown")}</td><td>${escapeHtml(payment.reference || "")}</td><td>${customerPaymentControls(payment, leads)}</td></tr>`)
    .join("")}</tbody></table>`;
}

function customerPaymentControls(payment, leads) {
  return `<details>
    <summary>Actions</summary>
    <form method="post" action="/finance/customer-payments/${encodeURIComponent(payment.id)}/edit" class="stacked-form">
      ${leadSelect(leads, payment.leadId)}
      ${selectInput("payment_type", ["deposit", "balance", "part_payment", "refund", "other"], payment.paymentType || "part_payment")}
      ${labeledInput("amount", "Payment amount", payment.amount)}
      ${selectInput("payment_method", CUSTOMER_PAYMENT_METHODS, payment.paymentMethod || "Unknown")}
      ${labeledInput("payment_date", "Payment date", payment.paymentDate, "date")}
      ${labeledInput("reference", "Payment reference", payment.reference)}
      <textarea name="notes" placeholder="Payment notes">${escapeHtml(payment.notes || "")}</textarea>
      <button class="compact-button">Save payment</button>
    </form>
    <form method="post" action="/finance/customer-payments/${encodeURIComponent(payment.id)}/archive"><button class="compact-button">Archive</button></form>
    <form method="post" action="/finance/customer-payments/${encodeURIComponent(payment.id)}/delete" onsubmit="return confirm('Delete this customer payment permanently?');"><button class="compact-button danger-button">Delete</button></form>
  </details>`;
}

function supplierPaymentTable(payments, invoices) {
  if (!payments.length) return `<p class="muted">No supplier payments recorded.</p>`;
  const invoiceNames = new Map((invoices || []).map((invoice) => [invoice.id, invoice.invoiceReference || invoice.id]));
  return `<table><thead><tr><th>Date</th><th>Invoice</th><th>Supplier</th><th>Amount</th><th>Method</th><th>Reference</th><th>Actions</th></tr></thead><tbody>${payments
    .map((payment) => `<tr><td>${escapeHtml(payment.paidAt || "")}</td><td>${escapeHtml(invoiceNames.get(payment.invoiceId) || payment.invoiceId || "")}</td><td>${escapeHtml(payment.supplierName || "")}</td><td>${escapeHtml(formatMoney(payment.amount))}</td><td>${escapeHtml(payment.paymentMethod || "Unknown")}</td><td>${escapeHtml(payment.reference || "")}</td><td>${supplierPaymentControls(payment, invoices)}</td></tr>`)
    .join("")}</tbody></table>`;
}

function supplierPaymentControls(payment, invoices) {
  return `<details>
    <summary>Actions</summary>
    <form method="post" action="/finance/supplier-payments/${encodeURIComponent(payment.id)}/edit" class="stacked-form">
      <select name="invoiceId">${(invoices || []).map((invoice) => `<option value="${escapeAttr(invoice.id)}" ${invoice.id === payment.invoiceId ? "selected" : ""}>${escapeHtml([invoice.supplierName || "Supplier", invoice.invoiceReference || invoice.id, `${formatMoney(invoice.amountOutstanding)} outstanding`].join(" - "))}</option>`).join("")}</select>
      ${labeledInput("amount", "Payment amount", payment.amount)}
      ${selectInput("payment_method", SUPPLIER_PAYMENT_METHODS, payment.paymentMethod || "Unknown")}
      ${labeledInput("paid_at", "Payment date", payment.paidAt, "date")}
      ${labeledInput("reference", "Payment reference", payment.reference)}
      <textarea name="notes" placeholder="Payment notes">${escapeHtml(payment.notes || "")}</textarea>
      <button class="compact-button">Save payment</button>
    </form>
    <form method="post" action="/finance/supplier-payments/${encodeURIComponent(payment.id)}/archive"><button class="compact-button">Archive</button></form>
    <form method="post" action="/finance/supplier-payments/${encodeURIComponent(payment.id)}/delete" onsubmit="return confirm('Delete this supplier payment permanently? The linked invoice balance will be recalculated.');"><button class="compact-button danger-button">Delete</button></form>
  </details>`;
}

function supplierLiabilityList(items) {
  if (!items.length) return `<p class="muted">No supplier liabilities.</p>`;
  return `<ul>${items.map((item) => `<li><strong>${escapeHtml(item.supplierName)}</strong>: ${escapeHtml(formatMoney(item.amountOutstanding))}</li>`).join("")}</ul>`;
}

function overdueWarnings(summary) {
  const warnings = [];
  if (summary.overdueCustomerPayments) warnings.push(`Customer payments overdue: ${formatMoney(summary.overdueCustomerPayments)}`);
  if (summary.overdueSupplierPayments) warnings.push(`Supplier payments overdue: ${formatMoney(summary.overdueSupplierPayments)}`);
  return warnings.length ? `<ul>${warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p class="muted">No overdue money warnings.</p>`;
}

function supplierInvoiceForm(leads, leadId = "") {
  return `<form method="post" action="/finance/supplier-invoices" class="stacked-form supplier-invoice-form">
    ${leadSelect(leads, leadId)}
    ${labeledInput("supplier_name", "Supplier name")}
    ${labeledInput("invoice_reference", "Invoice reference")}
    ${labeledInput("invoice_date", "Invoice date", "", "date", "Date shown on supplier invoice")}
    ${labeledInput("due_date", "Payment due date", "", "date", "When this supplier invoice needs paying")}
    ${labeledInput("net_amount", "Net amount")}
    ${labeledInput("vat_amount", "VAT amount")}
    ${labeledInput("gross_amount", "Gross invoice total", "", "text", "Total amount owed to supplier including VAT")}
    ${labeledInput("supplier_email_id", "Linked supplier email", "", "text", "Optional supplier email review item ID")}
    ${selectInput("payment_status", SUPPLIER_PAYMENT_STATUSES, "Invoice received")}
    <textarea name="notes" placeholder="Invoice notes"></textarea>
    <button>Save supplier invoice</button>
  </form>`;
}

function supplierPaymentForm(invoices) {
  if (!invoices.length) return `<p class="muted">No supplier invoices available.</p>`;
  const invoice = calculateSupplierInvoiceBalance(invoices[0], { supplierPayments: [] });
  return `<form method="post" action="/finance/supplier-payments" class="payment-form stacked-form" data-balance-before="${escapeAttr(invoice.amountOutstanding)}">
    <select name="invoiceId">${invoices.map((invoice) => `<option value="${escapeAttr(invoice.id)}">${escapeHtml([invoice.supplierName || "Supplier", invoice.invoiceReference || invoice.id, `${formatMoney(invoice.amountOutstanding)} outstanding`].join(" - "))}</option>`).join("")}</select>
    <section class="calculation-strip">
      <span>Gross invoice total <strong>${escapeHtml(formatMoney(invoice.grossAmount))}</strong></span>
      <span>Already paid <strong>${escapeHtml(formatMoney(invoice.amountPaid))}</strong></span>
      <span>Outstanding before <strong>${escapeHtml(formatMoney(invoice.amountOutstanding))}</strong></span>
      <span>Outstanding after <strong class="balance-after">${escapeHtml(formatMoney(invoice.amountOutstanding))}</strong></span>
    </section>
    ${labeledInput("amount", "Payment amount")}
    ${selectInput("payment_method", SUPPLIER_PAYMENT_METHODS, "Unknown")}
    ${labeledInput("paid_at", "Payment date", new Date().toISOString().slice(0, 10), "date")}
    ${labeledInput("reference", "Payment reference")}
    <textarea name="notes" placeholder="Payment notes"></textarea>
    <button>Record supplier payment</button>
  </form>`;
}

function customerPaymentForm(leads, leadId = "", state = {}) {
  const selectedLead = (leads || []).find((lead) => lead.id === leadId) || (leads || [])[0] || {};
  const finance = selectedLead.id ? jobFinancials(selectedLead, ensureFinanceState(state)) : null;
  const balance = finance ? finance.customer_amount_outstanding : 0;
  return `<form method="post" action="/finance/customer-payments" class="payment-form" data-balance-before="${escapeAttr(balance)}">
    ${leadSelect(leads, leadId)}
    ${finance ? `<section class="calculation-strip">
      <span>Agreed price <strong>${escapeHtml(formatMoney(finance.agreed_final_amount))}</strong></span>
      <span>Already paid <strong>${escapeHtml(formatMoney(finance.total_customer_payments_received))}</strong></span>
      <span>Balance before <strong>${escapeHtml(formatMoney(balance))}</strong></span>
      <span>Balance after <strong class="balance-after">${escapeHtml(formatMoney(balance))}</strong></span>
    </section>` : ""}
    ${selectInput("payment_type", ["deposit", "balance", "part_payment", "refund", "other"], "deposit")}
    <input name="amount" placeholder="Amount">
    ${selectInput("payment_method", CUSTOMER_PAYMENT_METHODS, "Unknown")}
    <input name="payment_date" type="date" value="${new Date().toISOString().slice(0, 10)}">
    <input name="reference" placeholder="Reference">
    <textarea name="notes" placeholder="Payment notes"></textarea>
    <button>Record customer payment</button>
  </form>`;
}

function customerInvoicePanel(lead, finance, state = {}, config = {}) {
  ensureOperationsState(state, config);
  const invoices = invoicesForLead(state, lead.id);
  const paid = invoices.reduce((total, invoice) => total + money(invoice.amount_paid), 0);
  const outstanding = invoices.reduce((total, invoice) => total + money(invoice.amount_outstanding), 0);
  const balanceAction = lead.installation_completed_at && finance.customerOutstanding > 0
    ? `<p class="form-warning">Next action: generate balance invoice / payment request.</p>`
    : "";
  return `<section class="panel"><div class="panel-heading"><h2>Customer invoices</h2><a class="button" href="/invoices/new?jobId=${encodeURIComponent(lead.id)}">Create invoice</a></div>
    ${balanceAction}
    <section class="metrics">
      ${metricCard("Paid customer invoice total", paid, `/leads/${encodeURIComponent(lead.id)}`, paid ? "green" : "grey", true)}
      ${metricCard("Outstanding invoice total", outstanding, `/leads/${encodeURIComponent(lead.id)}`, outstanding ? "amber" : "green", true)}
      ${metricCard("Invoices for job", invoices.length, `/invoices?leadId=${encodeURIComponent(lead.id)}`, invoices.length ? "green" : "grey")}
    </section>
    <div class="actions">
      <a class="button compact-button" href="/invoices/new?jobId=${encodeURIComponent(lead.id)}&type=deposit">Create deposit invoice</a>
      <a class="button compact-button" href="/invoices/new?jobId=${encodeURIComponent(lead.id)}&type=balance">Create balance invoice</a>
      <a class="button compact-button" href="/invoices/new?jobId=${encodeURIComponent(lead.id)}&type=final">Create final invoice</a>
      <a class="button secondary compact-button" href="/invoices">View all invoices</a>
    </div>
    ${invoices.length ? invoiceTable(invoices, [lead]) : `<p class="muted">No customer invoices for this job yet.</p>`}
  </section>`;
}

function jobSnapshotCards(lead, finance, state = {}) {
  const invoices = invoicesForLead(ensureOperationsState(state || {}), lead.id);
  const orders = workOrdersForLead(state || {}, lead.id);
  const latestOrder = orders.sort((a, b) => String(b.scheduled_start || "").localeCompare(String(a.scheduled_start || "")))[0];
  return `<section class="snapshot-grid">
    <article class="snapshot-card"><h2>Customer money</h2><p><strong>${escapeHtml(formatMoney(finance.customerOutstanding))}</strong> customer balance</p><p>${badge(finance.customerPaymentStatus)}</p><p class="muted">${invoices.length} invoice(s) for this job</p><a class="button compact-button" href="/invoices/new?jobId=${encodeURIComponent(lead.id)}">Create invoice</a></article>
    <article class="snapshot-card"><h2>Supplier / order</h2><p><strong>${escapeHtml(statusLabel(lead.supplier_order_status || "Not started"))}</strong></p><p class="muted">${escapeHtml([lead.supplier_name, lead.supplier_order_reference].filter(Boolean).join(" / ") || "No supplier order reference")}</p><p>${badge(statusLabel(lead.supplier_invoice_status || "Not received"))}</p><a class="button secondary compact-button" href="/supplier-emails">Review supplier inbox</a></article>
    <article class="snapshot-card"><h2>Installation</h2><p><strong>${escapeHtml(latestOrder ? dateTimeLabel(latestOrder.scheduled_start) : lead.installation_scheduled_at || "Not booked")}</strong></p><p class="muted">${escapeHtml([lead.installation_time_window, lead.installation_assigned_to].filter(Boolean).join(" / ") || "No technician schedule yet")}</p><p>${badge(lead.installation_completed_at ? "Completed" : lead.installation_scheduled_at ? "Booked" : "Needs booking")}</p><a class="button secondary compact-button" href="/technician-schedule">Open schedule</a></article>
  </section>`;
}

function leadWorkOrderPanel(lead, state = {}, config = {}) {
  ensureOperationsState(state, config);
  const orders = workOrdersForLead(state, lead.id);
  return `<section class="panel"><div class="panel-heading"><h2>Technician work orders</h2><a class="button" href="/technician-schedule">Schedule board</a></div>
    <section class="split"><article><h3>Create/update booking</h3>${workOrderForm([lead], state.technicians || [], lead)}</article><article><h3>Existing work</h3>${orders.length ? workOrderCards(orders, state, config) : `<p class="muted">No work order created yet.</p>`}</article></section>
  </section>`;
}

function financialSummaryPanel(lead, finance) {
  return `<section class="panel"><h2>Financial summary</h2>
    <section class="split">
      <article><h3>Customer financials</h3>
        <p><strong>Agreed price / quote amount:</strong> ${escapeHtml(formatMoney(finance.agreed_final_amount || finance.quoted_amount))}</p>
        <p><strong>Deposit paid:</strong> ${escapeHtml(formatMoney(finance.deposit_amount_received))}</p>
        <p><strong>Other payments received:</strong> ${escapeHtml(formatMoney(Math.max(finance.total_customer_payments_received - finance.deposit_amount_received, 0)))}</p>
        <p><strong>Customer balance outstanding:</strong> ${escapeHtml(finance.customer_overpaid_amount ? `Overpaid by ${formatMoney(finance.customer_overpaid_amount)}` : formatMoney(finance.customer_amount_outstanding))}</p>
        <p><strong>Payment status:</strong> ${badge(finance.customer_payment_status)}</p>
      </article>
      <article><h3>Supplier financials</h3>
        <p><strong>Supplier invoice total:</strong> ${escapeHtml(formatMoney(finance.total_supplier_invoice_gross))}</p>
        <p><strong>Paid to supplier:</strong> ${escapeHtml(formatMoney(finance.total_supplier_paid))}</p>
        <p><strong>Owed to supplier:</strong> ${escapeHtml(formatMoney(finance.supplier_amount_outstanding))}</p>
        <p><strong>Supplier payment status:</strong> ${badge(finance.supplier_payment_status)}</p>
      </article>
      <article><h3>Margin</h3>
        <p><strong>Estimated gross margin:</strong> ${escapeHtml(formatMoney(finance.estimated_gross_margin))}</p>
        <p><strong>Estimated gross margin %:</strong> ${escapeHtml(String(finance.estimated_gross_margin_percentage))}%</p>
        <p><strong>Net cash position for job:</strong> ${escapeHtml(formatMoney(finance.net_cash_position_for_job))}</p>
      </article>
    </section>
  </section>`;
}

function financialWarningsPanel(warnings) {
  if (!warnings.length) return "";
  const tone = warnings.some((warning) => warning.tone === "red") ? "red" : "amber";
  return `<section class="panel warning-list ${escapeAttr(tone)}"><h2>Warnings</h2><ul>${warnings.map((warning) => `<li>${escapeHtml(warning.message)}</li>`).join("")}</ul></section>`;
}

function jobFinancePanel(lead, finance, state = {}) {
  const supplierInvoices = (finance.supplierInvoices || []).filter((invoice) => money(invoice.amountOutstanding) > 0);
  return `<h2>Financial position</h2>
    <section class="metrics">
      ${metricCard("Customer agreed", finance.customerAgreed, `/leads/${encodeURIComponent(lead.id)}`, "green", true)}
      ${metricCard("Customer paid", finance.customerPaid, `/leads/${encodeURIComponent(lead.id)}`, "green", true)}
      ${metricCard("Customer outstanding", finance.customerOutstanding, `/leads/${encodeURIComponent(lead.id)}`, finance.customerOutstanding ? "amber" : "green", true)}
      ${finance.customerOverpaid ? metricCard("Overpaid", finance.customerOverpaid, `/leads/${encodeURIComponent(lead.id)}`, "amber", true) : ""}
      ${metricCard("Supplier costs", finance.supplierGross, `/leads/${encodeURIComponent(lead.id)}`, finance.supplierGross ? "amber" : "grey", true)}
      ${metricCard("Supplier owed", finance.supplierOutstanding, `/leads/${encodeURIComponent(lead.id)}`, finance.supplierOutstanding ? "red" : "green", true)}
      ${metricCard("Estimated margin", finance.estimatedGrossMargin, `/leads/${encodeURIComponent(lead.id)}`, finance.estimatedGrossMargin < 0 ? "red" : "green", true)}
    </section>
    <h3>Record customer payment</h3>${customerPaymentForm([lead], lead.id, state)}
    <h3>Add supplier invoice</h3>${supplierInvoiceForm([lead], lead.id)}
    ${supplierInvoices.length ? `<details><summary>Secondary: record supplier payment</summary>${supplierPaymentForm(supplierInvoices)}</details>` : ""}`;
}

function customerInvoiceForm(leads, lead = {}, settings = {}, selectedType = "") {
  const type = selectedType || "final";
  const amount = lead.id ? money(lead.calculated_balance_due || lead.balance_amount || lead.deposit_amount || lead.quote_amount || lead.agreed_final_amount) : "";
  return `<form method="post" action="/invoices/create" class="stacked-form">
    ${leadSelect(leads, lead.id || "")}
    <div class="field-grid">
      ${selectInput("invoice_type", INVOICE_TYPES, type)}
      ${labeledInput("customer_name", "Customer name", lead.customerName || "")}
      ${labeledInput("customer_email", "Customer email", lead.customerEmail || "", "email")}
      ${labeledInput("customer_phone", "Customer phone", lead.customerPhone || "")}
      ${labeledInput("customer_postcode", "Postcode", lead.customerPostcode || "")}
      ${labeledInput("invoice_date", "Invoice date", new Date().toISOString().slice(0, 10), "date")}
      ${labeledInput("supply_date", "Supply date / tax point", new Date().toISOString().slice(0, 10), "date")}
      ${labeledInput("due_date", "Due date", "", "date")}
      ${labeledInput("description", "Line description", lead.jobDescription || "Garage door works")}
      ${labeledInput("quantity", "Quantity", "1")}
      ${labeledInput("unit_price_net", "Unit price net", amount)}
      ${labeledInput("payment_terms", "Payment terms", `${settings.defaultPaymentTerms || 7} days`)}
    </div>
    <label><span>Billing address</span><textarea name="customer_billing_address">${escapeHtml(lead.customerAddress || "")}</textarea></label>
    <label><span>Notes</span><textarea name="notes"></textarea></label>
    <button>Create draft invoice</button>
  </form>`;
}

function invoiceEditForm(invoice, settings = {}) {
  const item = safeInvoiceItems(invoice)[0] || {};
  return `<form method="post" action="/invoices/${encodeURIComponent(invoice.invoice_id)}/edit" class="stacked-form">
    <div class="field-grid">
      ${selectInput("invoice_type", INVOICE_TYPES, invoice.invoice_type)}
      ${selectInput("status", INVOICE_STATUSES, invoice.status)}
      ${labeledInput("customer_name", "Customer name", invoice.customer_name)}
      ${labeledInput("customer_email", "Customer email", invoice.customer_email, "email")}
      ${labeledInput("customer_phone", "Customer phone", invoice.customer_phone)}
      ${labeledInput("customer_postcode", "Postcode", invoice.customer_postcode)}
      ${labeledInput("invoice_date", "Invoice date", invoice.invoice_date, "date")}
      ${labeledInput("supply_date", "Supply date / tax point", invoice.supply_date, "date")}
      ${labeledInput("due_date", "Due date", invoice.due_date, "date")}
      ${labeledInput("description", "Line description", item.description || "")}
      ${labeledInput("quantity", "Quantity", item.quantity || "1")}
      ${labeledInput("unit_price_net", "Unit price net", item.unit_price_net || "")}
      ${labeledInput("amount_paid", "Amount paid", invoice.amount_paid)}
    </div>
    <label><span>Billing address</span><textarea name="customer_billing_address">${escapeHtml(invoice.customer_billing_address || "")}</textarea></label>
    <label><span>Payment instructions</span><textarea name="payment_instructions">${escapeHtml(invoice.payment_instructions || "")}</textarea></label>
    <label><span>Notes</span><textarea name="notes">${escapeHtml(invoice.notes || "")}</textarea></label>
    <button>Save invoice</button>
  </form>`;
}

function invoiceTable(invoices, leads) {
  if (!invoices.length) return `<p class="muted">No customer invoices yet.</p>`;
  const leadNames = new Map((leads || []).map((lead) => [lead.id, lead.customerName || lead.customerPostcode || lead.id]));
  return `<table class="ay-table"><thead><tr><th>Invoice</th><th>Customer</th><th>Job</th><th>Dates</th><th>Total</th><th>Paid</th><th>Outstanding</th><th>Status</th><th>Actions</th></tr></thead><tbody>${invoices.map((invoice) => `<tr>
    <td data-label="Invoice"><a href="/invoices/${encodeURIComponent(invoice.invoice_id)}">${escapeHtml(invoice.invoice_number || "Draft")}</a><br><span class="muted">${escapeHtml(statusLabel(invoice.invoice_type))}</span></td>
    <td data-label="Customer">${escapeHtml(invoice.customer_name || "")}<br><span class="muted">${escapeHtml(invoice.customer_postcode || "")}</span></td>
    <td data-label="Job">${invoice.lead_id ? `<a href="/leads/${encodeURIComponent(invoice.lead_id)}">${escapeHtml(leadNames.get(invoice.lead_id) || invoice.lead_id)}</a>` : ""}</td>
    <td data-label="Dates"><span class="muted">Invoice</span><br>${escapeHtml(invoice.invoice_date || "")}<br><span class="muted">Due</span><br>${escapeHtml(invoice.due_date || "")}</td>
    <td data-label="Total">${escapeHtml(formatMoney(invoice.total_gross))}</td>
    <td data-label="Paid">${escapeHtml(formatMoney(invoice.amount_paid))}</td>
    <td data-label="Outstanding">${escapeHtml(formatMoney(invoice.amount_outstanding))}</td>
    <td data-label="Status">${badge(invoice.status)}</td>
    <td data-label="Actions"><a class="button compact-button" href="/invoices/${encodeURIComponent(invoice.invoice_id)}">Open</a> <a class="button secondary compact-button" href="/invoices/${encodeURIComponent(invoice.invoice_id)}/pdf">PDF</a></td>
  </tr>`).join("")}</tbody></table>`;
}

function technicianForm(technician = {}) {
  return `<form method="post" action="/technicians" class="stacked-form">
    ${technician.id ? `<input type="hidden" name="id" value="${escapeAttr(technician.id)}">` : ""}
    ${labeledInput("name", "Name", technician.name || "")}
    ${labeledInput("mobile_number", "Mobile number", technician.mobile_number || "")}
    ${labeledInput("whatsapp_number", "WhatsApp number", technician.whatsapp_number || "")}
    ${labeledInput("email", "Email", technician.email || "", "email")}
    ${labeledInput("calendar_identifier", "Calendar identifier", technician.calendar_identifier || "")}
    ${selectInput("calendar_type", ["ics", "caldav", "google", "outlook"], technician.calendar_type || "ics")}
    <label><span>Active?</span><select name="active"><option value="true" ${technician.active !== false ? "selected" : ""}>Yes</option><option value="false" ${technician.active === false ? "selected" : ""}>No</option></select></label>
    <textarea name="notes" placeholder="Technician notes">${escapeHtml(technician.notes || "")}</textarea>
    <button>Save technician</button>
  </form>`;
}

function workOrderForm(leads, technicians, lead = {}, preselectType = "") {
  const workTypeDefault = WORK_TYPES.includes(preselectType) ? preselectType : (lead.workflow_type === "repair" ? "repair" : "installation");
  return `<form method="post" action="/work-orders/create" class="stacked-form">
    ${leadSelect(leads, lead.id || "")}
    <div class="field-grid">
      <label><span>Technician</span><select name="technician_id"><option value="">Unassigned</option>${(technicians || []).filter((item) => item.active !== false).map((item) => `<option value="${escapeAttr(item.id)}">${escapeHtml(item.name)}</option>`).join("")}</select></label>
      <label><span>Visit type</span>${selectInput("work_type", WORK_TYPES, workTypeDefault)}</label>
      ${labeledInput("scheduled_start", "Scheduled start", lead.installation_scheduled_at || "", "datetime-local")}
      ${labeledInput("scheduled_end", "Scheduled end", "", "datetime-local")}
      ${labeledInput("time_window", "Time window", lead.installation_time_window || "")}
      ${labeledInput("customer_name", "Customer", lead.customerName || "")}
      ${labeledInput("customer_phone", "Customer phone", lead.customerPhone || "")}
      ${labeledInput("postcode", "Postcode", lead.customerPostcode || "")}
      ${labeledInput("supplier_order_reference", "Supplier/order reference", lead.supplier_order_reference || "")}
    </div>
    <label><span>Address</span><textarea name="address">${escapeHtml(lead.customerAddress || "")}</textarea></label>
    <label><span>Job summary</span><textarea name="job_summary">${escapeHtml(lead.jobDescription || "")}</textarea></label>
    <label><span>Access notes</span><textarea name="access_notes">${escapeHtml(lead.installation_access_notes || "")}</textarea></label>
    <label><span>Materials / supplier notes</span><textarea name="materials_notes">${escapeHtml(lead.supplier_order_product_details || lead.supplier_order_notes || "")}</textarea></label>
    <button>Create work order</button>
  </form>`;
}

function workOrderCards(workOrders, state = {}, config = {}) {
  if (!workOrders.length) return `<p class="empty-state">No work orders in this view.</p>`;
  const techNames = new Map((state.technicians || []).map((tech) => [tech.id, tech.name]));
  return `<div class="card-grid">${workOrders.map((order) => `<article class="install-card ${order.status === "completed" ? "green" : order.status === "unscheduled" ? "amber" : "grey"}">
    <div class="meta-row">${badge(statusLabel(order.status))} ${badge(statusLabel(order.work_type))}</div>
    <h3>${escapeHtml(order.customer_name || order.postcode || order.id)}</h3>
    <p><strong>${escapeHtml([dateTimeLabel(order.scheduled_start), order.time_window].filter(Boolean).join(" / ") || "Unscheduled")}</strong></p>
    <p>${escapeHtml([order.address, order.postcode].filter(Boolean).join(", "))}</p>
    <p class="muted">${escapeHtml(order.job_summary || "")}</p>
    <p>${escapeHtml(order.customer_phone || "")} ${techNames.get(order.technician_id) ? ` / ${escapeHtml(techNames.get(order.technician_id))}` : ""}</p>
    <p class="muted">${escapeHtml([order.access_notes, order.materials_notes].filter(Boolean).join(" | "))}</p>
    <div class="actions">
      <a class="button compact-button" href="/work-orders/${encodeURIComponent(order.id)}">Open</a>
      <a class="button secondary compact-button" href="/work-orders/${encodeURIComponent(order.id)}/ics">ICS</a>
      <form method="post" action="/work-orders/${encodeURIComponent(order.id)}/send-to-technician"><button class="compact-button">Preview/send</button></form>
      <form method="post" action="/work-orders/${encodeURIComponent(order.id)}/mark-complete"><button class="compact-button">Complete</button></form>
    </div>
  </article>`).join("")}</div>`;
}

function workOrderDetailPage(order, config, store) {
  const state = ensureOperationsState(store.state || {}, config);
  const financeState = ensureFinanceState(state);
  const lead = leadForWorkOrder(order, state.leads || []);
  const balance = lead ? customerOutstandingForLead(lead, financeState) : 0;
  const technician = (state.technicians || []).find((item) => item.id === order.technician_id) || {};
  const digest = digestForTechnician({ ...state, workOrders: [order] }, technician.id, order.scheduled_start || new Date(), 1);
  const dispatch = dispatchState(order, { balanceOutstanding: balance });
  const riskBadge = ["red", "amber"].includes(order.risk_level)
    ? ayBadge({ variant: order.risk_level, label: `${statusLabel(order.risk_level)} risk` })
    : "";
  const subtitle = [
    statusLabel(order.work_type),
    order.postcode || lead?.customerPostcode,
    dateTimeLabel(order.scheduled_start),
    order.time_window
  ].filter(Boolean).join(" · ");
  return pageShell(
    "Work Order",
    `${ayBackLink("/installations", "Back to installations")}
    <section class="ay-section" style="display:flex;justify-content:space-between;align-items:flex-start;gap:var(--ay-space-4);flex-wrap:wrap">
      <div>
        <h2 class="ay-page-title">${escapeHtml(order.customer_name || lead?.customerName || order.postcode || "Work order")}</h2>
        <p class="ay-page-subtitle">${escapeHtml(subtitle || "Appointment details not recorded")}</p>
      </div>
      <div style="display:flex;gap:var(--ay-space-2);align-items:center;flex-wrap:wrap">
        ${dispatchBadge(dispatch)}
        ${riskBadge}
      </div>
    </section>
    ${workOrderAppointmentCard(order, lead, state, balance)}
    ${workOrderPrimaryAction(order, state, balance)}
    <details class="panel">
      <summary>More actions</summary>
      <div class="actions" style="margin-top:var(--ay-space-3)">
        ${workOrderPostButton(order.id, "confirm-customer", "Confirm with customer", "secondary")}
        ${workOrderPostButton(order.id, "mark-complete", "Mark completed", "secondary")}
        ${workOrderPostButton(order.id, "cancel", "Cancel", "danger")}
      </div>
      <details class="advanced-panel" style="margin-top:var(--ay-space-3)">
        <summary>Reschedule</summary>
        <form method="post" action="/work-orders/${encodeURIComponent(order.id)}/reschedule" class="stacked-form" style="margin-top:var(--ay-space-3)">
          <div class="field-grid">
            ${labeledInput("scheduled_start", "Scheduled start", order.scheduled_start || "", "datetime-local")}
            ${labeledInput("scheduled_end", "Scheduled end", order.scheduled_end || "", "datetime-local")}
          </div>
          ${ayButton({ label: "Confirm reschedule", type: "submit", variant: "primary" })}
        </form>
      </details>
    </details>
    <section class="panel">
      <h2>Activity</h2>
      ${workOrderActivityList(order.logs || [])}
      <form method="post" action="/work-orders/${encodeURIComponent(order.id)}/add-log" class="stacked-form" style="margin-top:var(--ay-space-4)">
        <label><span>Add note</span><textarea name="note" placeholder="Internal note"></textarea></label>
        ${ayButton({ label: "Add note", type: "submit", variant: "secondary" })}
      </form>
    </section>
    ${workOrderNotificationsSection(order, config, store)}
    <details class="panel">
      <summary>Advanced</summary>
      <section class="split" style="margin-top:var(--ay-space-4)">
        <article>
          <h2>Technician message preview</h2>
          <textarea id="job-message">${escapeHtml(digest.body)}</textarea>
          <div class="actions">
            <button onclick="navigator.clipboard.writeText(document.getElementById('job-message').value);return false;">Copy message</button>
            ${whatsappLink(technician.whatsapp_number || technician.mobile_number, digest.body) ? `<a class="button secondary" href="${escapeAttr(whatsappLink(technician.whatsapp_number || technician.mobile_number, digest.body))}" target="_blank" rel="noreferrer">Open WhatsApp manually</a>` : ""}
          </div>
        </article>
        <article>
          <h2>Calendar and raw details</h2>
          <div class="actions">
            ${ayButton({ label: "Download .ics", href: `/work-orders/${encodeURIComponent(order.id)}/ics`, variant: "primary" })}
            ${workOrderPostButton(order.id, "add-to-calendar", "Prepare calendar event", "secondary")}
            ${workOrderPostButton(order.id, "send-to-technician", "Send to technician if enabled", "secondary")}
          </div>
          <div class="ay-detail-card" style="margin-top:var(--ay-space-4)">
            <p class="ay-detail-card__title">Internal details</p>
            ${detailRow("Work order ID", order.id)}
            ${detailRow("Calendar UID", order.calendar_uid || order.calendar_event_id || "")}
            ${detailRow("Calendar sequence", String(order.calendar_sequence || 0))}
            ${detailRow("Calendar", calendarReadiness(config).warning || "Ready")}
            ${detailRow("Internal notes", order.internal_notes || "")}
          </div>
        </article>
      </section>
    </details>`
  );
}

function logTable(logs) {
  return `<table class="ay-table"><thead><tr><th>Time</th><th>Level</th><th>Message</th><th>Details</th></tr></thead><tbody>${logs
    .map((log) => `<tr><td data-label="Time">${escapeHtml(shortDate(log.timestamp))}</td><td data-label="Level">${badge(log.level)}</td><td data-label="Message">${escapeHtml(log.message)}</td><td class="job-short" data-label="Details">${escapeHtml(JSON.stringify(log.details || {}))}</td></tr>`)
    .join("")}</tbody></table>`;
}

function exportTracker(res, { config, store }) {
  writeTrackerWorkbook(config.trackerXlsxPath, store.state, config);
  const content = fs.readFileSync(config.trackerXlsxPath);
  res.writeHead(200, {
    "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "content-disposition": 'attachment; filename="auto-doors-yorkshire-tracker.xlsx"'
  });
  res.end(content);
}

function exportCsv(res, filename, rows) {
  const content = toCsv(rows);
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`
  });
  res.end(content);
}

function exportJson(res, filename, data) {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`
  });
  res.end(JSON.stringify(data, null, 2));
}

function leadCsvRows(leads) {
  return [["Lead ID", "Received", "Customer", "Email", "Phone", "Address", "Postcode", "Status", "Quote amount", "Job"], ...(leads || []).map((lead) => [lead.id, lead.receivedAt, lead.customerName, lead.customerEmail, lead.customerPhone, lead.customerAddress, lead.customerPostcode, lead.status, lead.quote_amount, lead.jobDescription])];
}

function supplierEmailRows(emails) {
  return [["ID", "Received", "Supplier", "Supplier email", "Subject", "Order reference", "Invoice reference", "Matched lead", "Confidence", "Review status", "Summary"], ...(emails || []).map((email) => [email.id, email.receivedAt, email.supplierName, email.supplierEmail, email.subject, email.extractedOrderReference, email.invoiceReference, email.matchedLeadId, email.matchConfidence, email.reviewStatus, email.rawSummary])];
}

function safeExportState(state) {
  const clone = JSON.parse(JSON.stringify(state || {}));
  delete clone.adminPassword;
  delete clone.imapPassword;
  delete clone.smtpPassword;
  delete clone.twilioAuthToken;
  return clone;
}

function permanenceChecks(config, store) {
  const providerName = store.providerName || config.databaseProvider;
  const durable = Boolean(store.isDurable || providerName === "postgres");
  const localRenderRisk = !durable && Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL);
  return [
    { label: "Storage engine", value: providerName || "json", tone: durable ? "green" : "amber", detail: durable ? "Durable Postgres-style storage" : "File-backed JSON state" },
    { label: "DATABASE_URL", value: config.databaseUrl ? "Set" : "Missing", tone: config.databaseUrl ? "green" : "amber", detail: config.databaseUrl ? "Postgres can be used" : "Postgres is not attached" },
    { label: "Render file risk", value: localRenderRisk ? "Risk" : durable ? "Low" : "Check", tone: localRenderRisk ? "red" : durable ? "green" : "amber", detail: localRenderRisk ? "Local file storage on Render can be lost" : "Use Postgres or persistent disk for live data" },
    { label: "Backup exports", value: "Available", tone: "green", detail: "Workbook and CSV exports are available manually" },
    { label: "Database path", value: durable ? "Postgres" : "Local file", tone: durable ? "green" : "amber", detail: durable ? "Stored in DATABASE_URL" : config.databasePath }
  ];
}

function jobsPage(leads, params, state = {}) {
  const all = (state.leads || leads || []).map((lead) => ensureJobFields(lead));
  const showClosed = params.get("quick") === "closed";
  const activeJobs = (leads || [])
    .map((lead) => ensureJobFields(lead))
    .filter((lead) => showClosed ? ["Archived", "Duplicate", "Lost", "Closed"].includes(lead.status) || lead.closed_at : !["Archived", "Duplicate", "Lost", "Closed"].includes(lead.status) && !lead.closed_at);
  const finance = financeSummary(all, ensureFinanceState(state));
  const supplierBlockers = activeJobs.filter((lead) => lead.supplier_order_required === "yes" && (lead.deposit_received_at || lead.supplier_order_placed_at) && !lead.supplier_confirmation_received_at);
  const readyToInstall = activeJobs.filter((lead) => lead.supplier_actual_delivery_date && !lead.installation_completed_at);
  const paymentDue = activeJobs.filter((lead) => lead.installation_completed_at && jobFinancials(lead, ensureFinanceState(state)).customerOutstanding > 0);
  const quickFilters = [
    ["Needs action", ""],
    ["Quotes", "quotes"],
    ["Deposits", "deposits"],
    ["Supplier order", "supplier-orders"],
    ["Awaiting delivery", "awaiting-delivery"],
    ["Ready to install", "installations"],
    ["Payment due", "payments"],
    ["At risk", "overdue"],
    ["Closed", "closed"]
  ];
  return pageShell(
    "Jobs",
    `<section class="ay-section"><div class="ay-summary-grid">
      ${aySummaryCard({ label: "Active jobs", value: String(activeJobs.length), href: "/jobs" })}
      ${aySummaryCard({ label: "Supplier blockers", value: String(supplierBlockers.length), href: "/jobs?quick=supplier-orders" })}
      ${aySummaryCard({ label: "Ready to install", value: String(readyToInstall.length), href: "/jobs?quick=installations" })}
      ${aySummaryCard({ label: "Money to collect", value: formatMoney(finance.customerOutstanding), href: "/money" })}
      ${aySummaryCard({ label: "Payment due", value: String(paymentDue.length), href: "/jobs?quick=payments" })}
    </div></section>
    <form method="get" class="filters filter-panel">
      <input name="search" placeholder="Search customer, postcode, phone, supplier ref" value="${escapeAttr(params.get("search") || "")}">
      <button>Search jobs</button>
      <a class="button secondary" href="/jobs">Clear</a>
    </form>
    ${ayFilterTabs(quickFilters.map(([label, value]) => ({ label, href: `/jobs${value ? `?quick=${value}` : ""}`, active: (params.get("quick") || "") === value })), "Job filters")}
    <section class="panel"><div class="panel-heading"><h2>Jobs queue</h2><a class="button secondary compact-button" href="/leads">Lead inbox</a></div>${leadScanCards(activeJobs, state)}</section>
    <details class="drawer"><summary>Advanced table and bulk controls</summary><div class="drawer-body"><form method="post" action="/leads/bulk">${bulkToolbar()}${leadTable(activeJobs, { selectable: true, state })}</form></div></details>`
  );
}

function leadsPage(leads, params, state = {}) {
  const quickFilters = [
    ["New enquiries", "new"],
    ["Awaiting reply", "awaiting-approval"],
    ["Quotes to send", "quotes-to-send"],
    ["Quotes sent", "quotes"],
    ["Deposits due", "deposits"],
    ["Supplier order needed", "supplier-orders"],
    ["Awaiting delivery", "awaiting-delivery"],
    ["Ready to install", "installations"],
    ["Payment due", "payments"],
    ["Urgent", "overdue"],
    ["Repairs", "repairs"]
  ];
  const finance = financeSummary(state.leads || leads || [], ensureFinanceState(state));
  const openCount = (state.leads || leads || []).filter((lead) => !["Archived", "Duplicate", "Lost", "Closed"].includes(lead.status) && !lead.closed_at).length;
  return pageShell(
    "Leads",
    `<section class="ay-section"><div class="ay-summary-grid">
      ${aySummaryCard({ label: "Open active leads", value: String(openCount), href: "/leads" })}
      ${aySummaryCard({ label: "Customer outstanding", value: formatMoney(finance.customerOutstanding), href: "/finance" })}
      ${aySummaryCard({ label: "Balance due after installs", value: formatMoney(finance.balanceDueAfterCompletedInstalls), href: "/finance" })}
      ${aySummaryCard({ label: "Urgent leads", value: String((state.leads || leads || []).filter((lead) => lead.operational_risk_level === "red").length), href: "/leads?quick=overdue" })}
    </div></section>
    <form method="get" class="filters filter-panel">
      <input name="search" placeholder="Search name, phone, postcode, job" value="${escapeAttr(params.get("search") || "")}">
      <input name="status" placeholder="Status" value="${escapeAttr(params.get("status") || "")}">
      <button>Filter</button>
      <a class="button" href="/leads">Clear</a>
    </form>
    ${ayFilterTabs(quickFilters.map(([label, value]) => ({ label, href: `/leads?quick=${value}`, active: params.get("quick") === value })), "Lead filters")}
    <section class="panel"><h2>Lead queue</h2>${leadScanCards(leads, state)}</section>
    <details class="drawer"><summary>Bulk actions and table view</summary><div class="drawer-body"><form method="post" action="/leads/bulk">
      ${bulkToolbar()}
      ${leadTable(leads, { selectable: true, state })}
    </form></div></details>`
  );
}

function installationCards(leads, state, emptyText) {
  if (!leads.length) return ayEmptyState({ title: "Nothing here", body: emptyText });
  return `<div style="display:flex;flex-direction:column;gap:var(--ay-space-3)">${leads.map((lead) => {
    const finance = jobFinancials(lead, ensureFinanceState(state));
    const schedule = [lead.installation_scheduled_at, lead.installation_time_window, lead.installation_assigned_to].filter(Boolean).join(" · ") || "No booking set";
    return ayJobCard({
      customerName: lead.customerName || lead.customerPostcode || lead.id,
      metaParts: [lead.customerPostcode, workflowLabel(lead.workflow_type), schedule],
      status: lead.status,
      isAtRisk: (lead.operational_risk_level || "green") === "red",
      value: finance.customerOutstanding ? formatMoney(finance.customerOutstanding) : "",
      primaryLabel: "Open job",
      primaryHref: `/leads/${encodeURIComponent(lead.id)}`
    });
  }).join("")}</div>`;
}

function isScheduledThisWeek(value) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  const day = now.getDay() || 7;
  const start = new Date(now);
  start.setDate(now.getDate() - day + 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  return date >= start && date < end;
}

function isScheduledToday(value) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
}

function installationsPage(leads, state = {}, params = new URLSearchParams()) {
  const financeState = ensureFinanceState(state);
  const preparedLeads = (leads || []).map((lead) => ensureJobFields(lead));
  const financeFor = (lead) => customerOutstandingForLead(lead, financeState);
  const buckets = installationTodayBuckets(state, preparedLeads, financeFor);
  const view = ["today", "week", "month", "list", "technician"].includes(params.get("view")) ? params.get("view") : "today";
  const bookType = WORK_TYPES.includes(params.get("book")) ? params.get("book") : "";
  const allOrders = (state.workOrders || []).slice();
  const activeOrders = allOrders.filter((order) => !["cancelled", "completed"].includes(order.status));
  const nonCancelledOrders = allOrders.filter((order) => order.status !== "cancelled");
  const baseOrders = dispatchBaseOrders(view, activeOrders, nonCancelledOrders);
  const visibleOrders = applyDispatchFilters(baseOrders, preparedLeads, state, params, financeFor);
  const viewTabs = [
    ["Today", "today"],
    ["Week", "week"],
    ["Month", "month"],
    ["List", "list"],
    ["Technician board", "technician"]
  ];

  return pageShell(
    "Installations",
    `<section class="ay-section" style="display:flex;justify-content:space-between;align-items:flex-start;gap:var(--ay-space-4);flex-wrap:wrap">
      <div>
        <h2 class="ay-page-title">Installations</h2>
        <p class="ay-page-subtitle">Book, assign and track installation work</p>
      </div>
      <div class="actions">
        ${ayButton({ label: "Book installation", href: "/installations?book=installation#book", variant: "primary", size: "sm" })}
        ${ayButton({ label: "Add survey visit", href: "/installations?book=survey#book", variant: "secondary", size: "sm" })}
        ${ayButton({ label: "Add repair visit", href: "/installations?book=repair#book", variant: "secondary", size: "sm" })}
        ${ayButton({ label: "Add follow-up visit", href: "/installations?book=follow_up#book", variant: "secondary", size: "sm" })}
        ${ayButton({ label: "Add service visit", href: "/installations?book=service#book", variant: "secondary", size: "sm" })}
        ${ayButton({ label: "Other visit", href: "/installations?book=other#book", variant: "secondary", size: "sm" })}
        ${ayButton({ label: "Technician view", href: "/installations?view=technician", variant: "ghost", size: "sm" })}
      </div>
    </section>
    <section class="ay-section"><div class="ay-summary-grid">
      ${aySummaryCard({ label: "Today", value: String(buckets.installsToday.length), href: "/installations?view=today" })}
      ${aySummaryCard({ label: "This week", value: String(buckets.installsThisWeek.length), href: "/installations?view=week" })}
      ${aySummaryCard({ label: "Needs booking", value: String(buckets.needsBooking.length), href: "/installations#needs-booking" })}
      ${aySummaryCard({ label: "Reschedule requested", value: String(buckets.rescheduleRequested.length), href: "/installations?state=reschedule_needed" })}
      ${aySummaryCard({ label: "Completed - balance due", value: String(buckets.completedBalanceDue.length), href: "/installations?view=list&balance=due" })}
    </div></section>
    ${ayFilterTabs(viewTabs.map(([label, key]) => ({ label, href: `/installations?view=${key}`, active: view === key })), "Installation views")}
    ${dispatchFilterForm(params, state)}
    ${view === "technician" ? technicianDispatchBoard(visibleOrders, preparedLeads, state) : dispatchGroupedView(view, visibleOrders, preparedLeads, state)}
    ${needsBookingSection(buckets, preparedLeads)}
    <details id="book" class="panel"${bookType ? " open" : ""}>
      <summary>Book a visit</summary>
      <div style="margin-top:var(--ay-space-4)">${workOrderForm(preparedLeads, state.technicians || [], {}, bookType)}</div>
    </details>`
  );
}

function todayDispatchSection(state, leads, financeFor) {
  const buckets = installationTodayBuckets(state, leads, financeFor);
  const cards = [
    buckets.installsToday.length ? aySummaryCard({ label: "Installations today", value: String(buckets.installsToday.length), href: "/installations?view=today" }) : "",
    buckets.rescheduleRequested.length ? aySummaryCard({ label: "Reschedule requested", value: String(buckets.rescheduleRequested.length), href: "/installations?state=reschedule_needed" }) : "",
    buckets.completedBalanceDue.length ? aySummaryCard({ label: "Completed - balance due", value: String(buckets.completedBalanceDue.length), href: "/installations?view=list&balance=due" }) : "",
    buckets.deliveryReadyNotBooked.length ? aySummaryCard({ label: "Delivery ready, not booked", value: String(buckets.deliveryReadyNotBooked.length), href: "/installations#book" }) : "",
    buckets.technicianNotNotified.length ? aySummaryCard({ label: "Technician not notified", value: String(buckets.technicianNotNotified.length), href: "/installations?needs=action" }) : "",
    buckets.technicianNotConfirmed.length ? aySummaryCard({ label: "Technician not confirmed", value: String(buckets.technicianNotConfirmed.length), href: "/installations?needs=action" }) : ""
  ].filter(Boolean);
  return `<section class="ay-section"><p class="ay-section-label">Installations &amp; dispatch</p>`
    + (cards.length ? `<div class="ay-summary-grid">${cards.join("")}</div>` : ayEmptyState({ title: "No dispatch actions", body: "No installation dispatch items need attention right now." }))
    + `</section>`;
}

function customerOutstandingForLead(lead, financeState) {
  const financials = jobFinancials(lead || {}, financeState);
  return money(financials.customerOutstanding || financials.customer_amount_outstanding || 0);
}

function leadForWorkOrder(order, leads = []) {
  return (leads || []).find((lead) => lead.id === order.lead_id || lead.id === order.job_id) || null;
}

function dispatchBadge(dispatch) {
  return ayBadge({ variant: dispatch.tone === "grey" ? "gray" : dispatch.tone, label: dispatch.label });
}

function dispatchBaseOrders(view, activeOrders, nonCancelledOrders) {
  const now = new Date();
  if (view === "today") return activeOrders.filter((order) => sameUiDay(order.scheduled_start, now)).sort(sortByScheduledAsc);
  if (view === "week") return activeOrders.filter((order) => isUiNextDays(order.scheduled_start, 7, now)).sort(sortByScheduledAsc);
  if (view === "month") return activeOrders.filter((order) => isUiNextDays(order.scheduled_start, 31, now)).sort(sortByScheduledAsc);
  if (view === "technician") return activeOrders.slice().sort(sortByScheduledAsc);
  return nonCancelledOrders.slice().sort(sortByScheduledDesc);
}

function applyDispatchFilters(orders, leads, state, params, financeFor) {
  const technician = params.get("technician") || "";
  const dispatchKey = params.get("state") || "";
  const type = params.get("type") || "";
  const risk = params.get("risk") || "";
  const needs = params.get("needs") || "";
  const balance = params.get("balance") || "";
  return (orders || []).filter((order) => {
    const lead = leadForWorkOrder(order, leads);
    const balanceOutstanding = lead ? financeFor(lead) : 0;
    const dispatch = dispatchState(order, { balanceOutstanding });
    if (technician === "unassigned" && order.technician_id) return false;
    if (technician && technician !== "unassigned" && order.technician_id !== technician) return false;
    if (dispatchKey && dispatch.key !== dispatchKey) return false;
    if (type && order.work_type !== type) return false;
    if (risk && order.risk_level !== risk) return false;
    if (needs === "action" && order.technician_id && !["not_notified", "notified", "reschedule_requested"].includes(order.technician_status) && dispatch.key !== "reschedule_needed") return false;
    if (balance === "due" && !(order.status === "completed" && balanceOutstanding > 0)) return false;
    return true;
  });
}

function dispatchFilterForm(params, state) {
  const view = params.get("view") || "today";
  const select = (name, label, options, selected = "") => `<label><span>${escapeHtml(label)}</span><select name="${escapeAttr(name)}"><option value="">Any</option>${options.map(([value, text]) => `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(text)}</option>`).join("")}</select></label>`;
  const technicians = [["unassigned", "Unassigned"], ...(state.technicians || []).filter((tech) => tech.active !== false).map((tech) => [tech.id, tech.name || tech.id])];
  const states = [
    ["needs_booking", "Needs booking"],
    ["booked", "Booked - notify technician"],
    ["awaiting_confirmation", "Awaiting technician confirmation"],
    ["technician_confirmed", "Technician confirmed"],
    ["on_route", "On the way"],
    ["on_site", "On site"],
    ["reschedule_needed", "Reschedule requested"],
    ["balance_due", "Completed - balance due"],
    ["paid", "Completed and paid"]
  ];
  return `<form method="get" class="ay-filter-bar">
    <input type="hidden" name="view" value="${escapeAttr(view)}">
    ${select("technician", "Technician", technicians, params.get("technician") || "")}
    ${select("state", "Status", states, params.get("state") || "")}
    ${select("type", "Job type", WORK_TYPES.map((type) => [type, statusLabel(type)]), params.get("type") || "")}
    ${select("risk", "Risk", [["red", "Red"], ["amber", "Amber"], ["green", "Green"], ["grey", "Grey"]], params.get("risk") || "")}
    ${select("needs", "Needs", [["action", "Office action"]], params.get("needs") || "")}
    ${select("balance", "Balance", [["due", "Due"]], params.get("balance") || "")}
    <button>Apply filters</button>
    <a class="button secondary" href="/installations?view=${escapeAttr(view)}">Clear</a>
  </form>`;
}

function dispatchGroupedView(view, orders, leads, state) {
  if (!orders.length) return `<section class="ay-section">${ayEmptyState({ title: "No work orders", body: "No installation work matches this view." })}</section>`;
  if (view === "list") {
    return `<section class="ay-section"><p class="ay-section-label">Work orders</p><div style="display:flex;flex-direction:column;gap:var(--ay-space-3)">${orders.map((order) => dispatchCard(order, leadForWorkOrder(order, leads), state)).join("")}</div></section>`;
  }
  const heading = view === "today" ? "Today" : view === "week" ? "Next 7 days" : "Next 31 days";
  return `<section class="ay-section"><p class="ay-section-label">${escapeHtml(heading)}</p>${dispatchDayGroups(orders, leads, state)}</section>`;
}

function technicianDispatchBoard(orders, leads, state) {
  if (!orders.length) return `<section class="ay-section">${ayEmptyState({ title: "No technician work", body: "No active installation work matches these filters." })}</section>`;
  const groups = new Map();
  for (const order of orders) {
    const key = order.technician_id || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(order);
  }
  const keys = Array.from(groups.keys()).sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return technicianName(state, a).localeCompare(technicianName(state, b));
  });
  return keys.map((key) => `<section class="ay-section"><p class="ay-section-label">${escapeHtml(key ? technicianName(state, key) || "Technician" : "Unassigned")}</p>${dispatchDayGroups(groups.get(key).sort(sortByScheduledAsc), leads, state)}</section>`).join("");
}

function dispatchDayGroups(orders, leads, state) {
  const groups = new Map();
  for (const order of orders) {
    const key = dispatchDayKey(order.scheduled_start);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(order);
  }
  return Array.from(groups.keys()).sort().map((key) => `<div style="display:flex;flex-direction:column;gap:var(--ay-space-3);margin-bottom:var(--ay-space-5)">
    <h3 style="margin:0;color:var(--ay-text-primary);font-size:16px;font-weight:600">${escapeHtml(dispatchDayLabel(key))}</h3>
    ${groups.get(key).map((order) => dispatchCard(order, leadForWorkOrder(order, leads), state)).join("")}
  </div>`).join("");
}

function dispatchCard(order, lead, state) {
  const financeState = ensureFinanceState(state);
  const balanceOutstanding = lead ? customerOutstandingForLead(lead, financeState) : 0;
  const dispatch = dispatchState(order, { balanceOutstanding });
  const riskBadge = ["red", "amber"].includes(order.risk_level)
    ? ayBadge({ variant: order.risk_level, label: `${statusLabel(order.risk_level)} risk` })
    : "";
  const schedule = order.time_window || dateTimeLabel(order.scheduled_start);
  const technician = technicianName(state, order.technician_id) || "Unassigned";
  return ayJobCard({
    customerName: order.customer_name || lead?.customerName || order.postcode || order.id,
    metaParts: [
      order.postcode || lead?.customerPostcode,
      statusLabel(order.work_type),
      schedule,
      technician,
      nextDispatchAction(order, dispatch, balanceOutstanding)
    ],
    statusBadge: `${dispatchBadge(dispatch)}${riskBadge}`,
    value: balanceOutstanding > 0 && order.status === "completed" ? formatMoney(balanceOutstanding) : "",
    primaryLabel: "Open job",
    primaryHref: `/work-orders/${encodeURIComponent(order.id)}`,
    detailHref: `/work-orders/${encodeURIComponent(order.id)}`
  });
}

function nextDispatchAction(order, dispatch, balanceOutstanding = 0) {
  if (!order.technician_id) return "Next: assign technician";
  if (dispatch.key === "balance_due" || (order.status === "completed" && balanceOutstanding > 0)) return "Next: request balance";
  if (dispatch.key === "reschedule_needed") return "Next: reschedule";
  if (order.technician_status === "not_notified") return "Next: notify technician";
  if (order.technician_status === "notified") return "Next: get technician confirmation";
  if (order.technician_status === "confirmed") return "Next: track en route";
  if (order.technician_status === "en_route") return "Next: mark arrived";
  if (order.technician_status === "arrived") return "Next: mark completed";
  return dispatch.label;
}

function needsBookingSection(buckets, leads) {
  const byLeadId = new Map();
  for (const lead of [...(buckets.needsBooking || []), ...(buckets.deliveryReadyNotBooked || [])]) {
    if (lead?.id && !byLeadId.has(lead.id)) byLeadId.set(lead.id, lead);
  }
  const bookingLeads = Array.from(byLeadId.values());
  return `<section id="needs-booking" class="ay-section"><p class="ay-section-label">Needs booking</p>`
    + (bookingLeads.length
      ? `<div style="display:flex;flex-direction:column;gap:var(--ay-space-3)">${bookingLeads.map((lead) => ayJobCard({
          customerName: lead.customerName || lead.customerPostcode || lead.id,
          metaParts: [lead.customerPostcode, workflowLabel(lead.workflow_type), lead.supplier_actual_delivery_date ? `Delivered ${lead.supplier_actual_delivery_date}` : "Ready to book"],
          statusBadge: ayBadge({ variant: "amber", label: "Ready to book" }),
          value: "Ready to book",
          primaryLabel: "Open job",
          primaryHref: `/leads/${encodeURIComponent(lead.id)}`
        })).join("")}</div>`
      : ayEmptyState({ title: "No jobs need booking", body: "There are no delivery-ready jobs waiting for an appointment." }))
    + `</section>`;
}

function workOrderAppointmentCard(order, lead, state, balance) {
  return `<section class="ay-detail-card">
    <p class="ay-detail-card__title">Appointment</p>
    ${detailRow("Customer", order.customer_name || lead?.customerName || "")}
    ${detailRow("Phone", order.customer_phone || lead?.customerPhone || "")}
    ${detailRow("Email", order.customer_email || lead?.customerEmail || "")}
    ${detailRow("Address / postcode", [order.address || lead?.customerAddress, order.postcode || lead?.customerPostcode].filter(Boolean).join(", "))}
    ${detailRow("Job type", statusLabel(order.work_type))}
    ${detailRow("Technician", technicianName(state, order.technician_id) || "Unassigned")}
    ${detailRow("Time window", order.time_window || dateTimeLabel(order.scheduled_start))}
    ${detailRow("Customer confirmed", plainStatusLabel(order.customer_confirmation_status || "not_sent"))}
    ${detailRow("Technician status", technicianStatusLabel(order.technician_status))}
    ${detailRow("Balance", lead ? formatMoney(balance) : "-")}
  </section>`;
}

function workOrderPrimaryAction(order, state, balance) {
  const technicians = (state.technicians || []).filter((item) => item.active !== false);
  let body = "";
  let title = "";
  if (!order.technician_id) {
    title = "Assign technician";
    body = `<form method="post" action="/work-orders/${encodeURIComponent(order.id)}/assign" class="stacked-form">
      <label><span>Technician</span><select name="technician_id">${technicians.length ? technicians.map((tech) => `<option value="${escapeAttr(tech.id)}">${escapeHtml(tech.name || tech.id)}</option>`).join("") : `<option value="">Add a technician first</option>`}</select></label>
      ${ayButton({ label: "Assign technician", type: "submit", variant: "primary" })}
    </form>`;
  } else if (order.status === "completed" && balance > 0) {
    title = "Request balance";
    body = ayButton({ label: "Open job to request balance", href: `/leads/${encodeURIComponent(order.lead_id || order.job_id || "")}`, variant: "primary" });
  } else if (order.status === "completed") {
    title = "Job completed";
    body = `<p class="ay-action-card__meta">This work order is complete.</p>`;
  } else if (order.technician_status === "not_notified") {
    title = "Notify technician";
    body = workOrderPostButton(order.id, "notify-technician", "Notify technician", "primary");
  } else if (order.technician_status === "notified") {
    title = "Mark technician confirmed";
    body = workOrderPostButton(order.id, "confirm-technician", "Mark technician confirmed", "primary");
  } else if (order.technician_status === "confirmed") {
    title = "Mark en route";
    body = workOrderPostButton(order.id, "en-route", "Mark en route", "primary");
  } else if (order.technician_status === "en_route") {
    title = "Mark arrived";
    body = workOrderPostButton(order.id, "arrived", "Mark arrived", "primary");
  } else if (order.technician_status === "arrived") {
    title = "Mark completed";
    body = workOrderPostButton(order.id, "mark-complete", "Mark completed", "primary");
  } else {
    title = "Check appointment";
    body = `<p class="ay-action-card__meta">Review the appointment details and choose an action below.</p>`;
  }
  return `<section class="ay-next-action">
    <p class="ay-next-action__eyebrow">Next dispatch action</p>
    <h2 class="ay-next-action__title">${escapeHtml(title)}</h2>
    <div class="ay-next-action__buttons">${body}</div>
  </section>`;
}

function workOrderPostButton(orderId, action, label, variant = "primary") {
  return `<form method="post" action="/work-orders/${encodeURIComponent(orderId)}/${escapeAttr(action)}" style="display:inline">${ayButton({ label, type: "submit", variant })}</form>`;
}

function workOrderActivityList(logs = []) {
  if (!logs.length) return `<p class="muted">No activity yet.</p>`;
  return `<ul style="margin:0;padding-left:var(--ay-space-5);color:var(--ay-text-secondary);font-size:13px">${logs.map((log) => `<li>${escapeHtml([dateTimeLabel(log.created_at), plainStatusLabel(log.event_type), log.note].filter(Boolean).join(" - "))}</li>`).join("")}</ul>`;
}

function workOrderNotificationsSection(order, config, store) {
  const techNotify = config.techNotify || {};
  const showDraftOnlyNote = (!techNotify.emailEnabled && !techNotify.smsEnabled && !techNotify.whatsappEnabled) || !techNotify.autoSend;
  const notifications = (store.state.messageQueue || [])
    .filter((message) => message.related_type === "work_order" && message.related_id === order.id)
    .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));

  return `<section class="panel">
    <h2>Notifications</h2>
    ${showDraftOnlyNote ? `<p class="muted">Sending is off by default — these are queued records, not live messages.</p>` : ""}
    ${notifications.length ? `<div style="display:flex;flex-direction:column;gap:var(--ay-space-2)">
      ${notifications.map(workOrderNotificationRow).join("")}
    </div>` : `<p class="muted">No technician notifications yet. Use Notify technician to queue one.</p>`}
  </section>`;
}

function workOrderNotificationRow(message) {
  const channel = MESSAGE_CHANNEL_LABELS[message.channel] || plainStatusLabel(message.channel || "notification");
  const status = message.status || "draft";
  const template = TECH_NOTIFICATION_TEMPLATE_LABELS[message.template_type] || plainStatusLabel(message.template_type || "Notification");
  const when = dateTimeLabel(message.updated_at || message.created_at);
  return `<div class="ay-detail-card__row">
    <span class="ay-detail-card__row-label">${escapeHtml(channel)}</span>
    <span class="ay-detail-card__row-value" style="display:flex;justify-content:flex-end;align-items:center;gap:var(--ay-space-2);flex-wrap:wrap">
      ${ayBadge({ variant: MESSAGE_STATUS_BADGE_TONES[status] || "gray", label: statusLabel(status) })}
      <span>${escapeHtml(template)}</span>
      <span class="muted">${escapeHtml(when)}</span>
      ${message.error ? `<span style="color:var(--ay-red-text)">${escapeHtml(message.error)}</span>` : ""}
    </span>
  </div>`;
}

function detailRow(label, value) {
  const text = String(value || "");
  const valueClass = text ? "ay-detail-card__row-value" : "ay-detail-card__row-value ay-detail-card__row-value--missing";
  return `<div class="ay-detail-card__row"><span class="ay-detail-card__row-label">${escapeHtml(label)}</span><span class="${valueClass}">${escapeHtml(text || "Not recorded")}</span></div>`;
}

function plainStatusLabel(value) {
  return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()).replace(/\w\S*/g, (word, offset) => offset === 0 ? word : word.toLowerCase());
}

function technicianStatusLabel(value) {
  return TECHNICIAN_STATUSES.includes(value) ? plainStatusLabel(value) : plainStatusLabel(value || "not_notified");
}

function sortByScheduledAsc(a, b) {
  return String(a.scheduled_start || "9999").localeCompare(String(b.scheduled_start || "9999"));
}

function sortByScheduledDesc(a, b) {
  return String(b.scheduled_start || "").localeCompare(String(a.scheduled_start || ""));
}

function dispatchDayKey(value) {
  if (!value) return "9999-12-31";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "9999-12-31";
  return date.toISOString().slice(0, 10);
}

function dispatchDayLabel(key) {
  if (key === "9999-12-31") return "Unscheduled";
  const date = new Date(`${key}T00:00:00`);
  if (Number.isNaN(date.getTime())) return key;
  return date.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" });
}

function customerDetailsPanel(lead) {
  const verificationOptions = ["Address needed", "Needs Royal Mail check", "Royal Mail checked", "Customer confirmed", "Unable to verify"];
  return `<details class="panel customer-details-panel" open>
    <summary><span><strong>Customer details</strong><small>Name, contact details, address and location can be corrected here.</small></span></summary>
    <form method="post" class="customer-edit-form">
      <div class="form-grid">
        ${labeledInput("customerName", "Customer name", lead.customerName)}
        ${labeledInput("customerPhone", "Phone", lead.customerPhone, "tel")}
        ${labeledInput("customerEmail", "Email", lead.customerEmail, "email")}
        ${labeledInput("customerPostcode", "Postcode", lead.customerPostcode)}
        ${labeledInput("customerTownArea", "Town / area", lead.customerTownArea)}
        ${labeledInput("sourcePlatform", "Lead source", lead.sourcePlatform || lead.source)}
      </div>
      <label><span>Full address</span><textarea name="customerAddress" placeholder="Customer full address">${escapeHtml(lead.customerAddress || "")}</textarea><small><a href="${escapeAttr(addressCheckUrl(lead))}" target="_blank" rel="noreferrer">Check on Royal Mail</a></small></label>
      <div class="form-grid compact-form-grid">
        <label><span>Address check</span><select name="addressVerificationStatus">${verificationOptions.map((status) => `<option value="${escapeAttr(status)}" ${status === (lead.addressVerificationStatus || "Needs Royal Mail check") ? "selected" : ""}>${escapeHtml(status)}</option>`).join("")}</select></label>
        <label><span>Lead status</span><select name="status">${STATUSES.map((status) => `<option value="${escapeAttr(status)}" ${status === lead.status ? "selected" : ""}>${escapeHtml(status)}</option>`).join("")}</select></label>
        ${labeledInput("followUpDate", "Follow-up date", lead.followUpDate, "date")}
      </div>
      <label><span>Notes</span><textarea name="notes" placeholder="Notes">${escapeHtml(lead.notes || "")}</textarea></label>
      <div class="actions"><button>Save customer details</button><a class="button secondary" href="${escapeAttr(addressCheckUrl(lead))}" target="_blank" rel="noreferrer">Open Royal Mail check</a></div>
    </form>
  </details>`;
}

function jobSummaryCard(lead) {
  const address = lead.customerAddress || [lead.customerPostcode, lead.customerTownArea].filter(Boolean).join(", ");
  const row = (label, value) => {
    const text = String(value || "");
    const valueClass = text ? "ay-detail-card__row-value" : "ay-detail-card__row-value ay-detail-card__row-value--missing";
    return `<div class="ay-detail-card__row"><span class="ay-detail-card__row-label">${escapeHtml(label)}</span><span class="${valueClass}">${escapeHtml(text || "Not recorded")}</span></div>`;
  };
  return `<section class="ay-detail-card">
    <p class="ay-detail-card__title">Job summary</p>
    ${row("Client", lead.customerName)}
    ${row("Job type", workflowLabel(lead.workflow_type))}
    ${row("Address", address)}
    ${row("Phone", lead.customerPhone)}
    ${row("Email", lead.customerEmail)}
  </section>`;
}

function leadDetailPage(lead, config, state = {}) {
  if (lead) ensureJobFields(lead);
  const workflow = lead ? evaluateWorkflow(lead, new Date(), { financeState: state }) : null;
  const draftType = lead ? suggestedDraftType(lead) : "";
  const customerDraft = lead ? generateCustomerUpdateDraft(lead, draftType, config) : null;
  const finance = lead ? jobFinancials(lead, ensureFinanceState(state)) : null;
  const warnings = lead ? calculateFinancialWarnings(lead, ensureFinanceState(state)) : [];
  const primaryActions = workflow ? workflow.visiblePrimaryActions.slice(0, 1) : [];
  const secondaryActions = workflow ? [...workflow.visiblePrimaryActions.slice(1), ...workflow.visibleSecondaryActions] : [];
  if (lead && finance && !lead.balance_amount) lead.calculated_balance_due = String(finance.customer_amount_outstanding || "");
  return pageShell(
    lead ? `Lead ${lead.id}` : "Lead not found",
    !lead
      ? `<p>Lead not found.</p>`
      : `${ayBackLink("/jobs", "Back to jobs")}
        <section class="ay-section" style="display:flex;justify-content:space-between;align-items:flex-start;gap:var(--ay-space-4);flex-wrap:wrap">
          <div>
            <h2 class="ay-page-title">${escapeHtml(lead.customerName || "Unknown")}</h2>
            <p class="ay-page-subtitle">${escapeHtml([workflowLabel(lead.workflow_type), lead.customerPostcode, lead.customerTownArea].filter(Boolean).join(" · ") || "No location recorded")}</p>
          </div>
          <div style="display:flex;gap:var(--ay-space-2);align-items:center;flex-wrap:wrap">
            ${ayStageBadge(lead.status)}
            ${lead.operational_risk_level === "red" ? ayBadge({ variant: "red", label: "At risk" }) : ""}
          </div>
        </section>
        <section class="ay-section" style="display:flex;gap:var(--ay-space-2);flex-wrap:wrap">
          ${lead.customerPhone ? ayButton({ label: `Call ${lead.customerName || "customer"}`, href: `tel:${lead.customerPhone.replace(/\s/g, "")}`, variant: "secondary", size: "sm" }) : ayBadge({ variant: "gray", label: "No phone" })}
          ${lead.customerEmail ? ayButton({ label: "Email", href: `mailto:${lead.customerEmail}`, variant: "secondary", size: "sm" }) : ayBadge({ variant: "gray", label: "No email" })}
          ${lead.customerPostcode ? ayButton({ label: "Check address", href: addressCheckUrl(lead), variant: "ghost", size: "sm", attrs: 'target="_blank" rel="noreferrer"' }) : ""}
        </section>
        ${jobSummaryCard(lead)}
        <section class="ay-next-action">
          <p class="ay-next-action__eyebrow">Next best action</p>
          <h2 class="ay-next-action__title">${escapeHtml(workflow.nextBestAction)}</h2>
          <p class="ay-action-card__meta" style="margin-bottom:var(--ay-space-4)">${escapeHtml(workflow.reason)}</p>
          ${actionForms(lead, primaryActions)}
          ${secondaryActions.length ? `<details class="advanced-panel" style="margin-top:var(--ay-space-3)"><summary>Other safe actions</summary>${actionForms(lead, secondaryActions)}</details>` : ""}
        </section>
        ${financialWarningsPanel(warnings)}
        <section class="panel"><h2>Timeline</h2>${workflowRail(lead)}${eventList(lead, config)}</section>
        <details class="panel">
          <summary>Advanced: details, corrections and history</summary>
          ${customerDetailsPanel(lead)}
          ${jobSnapshotCards(lead, finance, state)}
          <section class="panel"><h2>${escapeHtml(customerDraft.label || "Current draft")}</h2><textarea id="customer-update">${escapeHtml(customerDraft.body || lead.draftReply || "")}</textarea><button onclick="navigator.clipboard.writeText(document.getElementById('customer-update').value)">Copy message</button></section>
          <section class="lead-detail summary-grid">
            <div><strong>Full address</strong><br>${escapeHtml(lead.customerAddress || "Needed")}<br><a href="${escapeAttr(addressCheckUrl(lead))}" target="_blank" rel="noreferrer">Check Royal Mail</a></div>
            <div><strong>Address check</strong><br>${escapeHtml(lead.addressVerificationStatus || "Needs Royal Mail check")}</div>
            <div><strong>Source</strong><br>${escapeHtml(lead.sourcePlatform || "")}</div>
            <div><strong>Priority</strong><br>${badge(lead.priorityLabel)} ${escapeHtml(String(lead.priorityScore || ""))}</div>
          </section>
          <section class="split"><article>
            <h2>Job details</h2>
            <p>${escapeHtml(lead.jobDescription)}</p>
            <p><strong>Door:</strong> ${escapeHtml(lead.garageDoorType || "Not known")}</p>
            <p><strong>Supplier order required:</strong> ${escapeHtml(yesNoLabel(lead.supplier_order_required))} <strong>Deposit:</strong> ${escapeHtml(statusLabel(lead.deposit_status || ""))}</p>
            <p><strong>Issue:</strong> ${escapeHtml(lead.garageDoorIssue || "")}</p>
            <p><strong>Expected delivery:</strong> ${escapeHtml(deliveryText(lead))}</p>
            <p><strong>Missing info:</strong> ${escapeHtml(lead.missingInformationChecklist || "None recorded")}</p>
            ${lead.dashboardUrl ? `<p><a class="button" href="${escapeAttr(lead.dashboardUrl)}" target="_blank" rel="noreferrer">Open Checkatrade source</a></p>` : ""}
          </article><article><h2>Original draft reply</h2><textarea id="draft">${escapeHtml(lead.draftReply || "")}</textarea><button onclick="navigator.clipboard.writeText(document.getElementById('draft').value)">Copy original draft</button></article></section>
          ${financialSummaryPanel(lead, finance)}
          ${customerInvoicePanel(lead, finance, state, config)}
          ${leadWorkOrderPanel(lead, state, config)}
          <section class="split">
            <article><h2>Historical actions</h2>${advancedActionForms(lead, workflow)}</article>
            <article><h2>Financial controls</h2>${jobFinancePanel(lead, finance, state)}</article>
          </section>
          <h2>Status and notes</h2>
          <form method="post">
            <select name="status">${STATUSES.map((status) => `<option ${status === lead.status ? "selected" : ""}>${status}</option>`).join("")}</select>
            <input name="followUpDate" type="date" value="${escapeAttr(lead.followUpDate || "")}">
            <textarea name="notes" placeholder="Notes">${escapeHtml(lead.notes || "")}</textarea>
            <button>Save</button>
          </form>
        </details>`
  );
}

function supplierEmailsPage(emails, leads, params = new URLSearchParams()) {
  const filtered = filterSupplierEmails(emails, leads, params);
  const current = params.get("filter") || "needs-review";
  const unlinkedCount = filterSupplierEmails(emails, leads, new URLSearchParams("filter=unlinked")).length;
  const linkedCount = filterSupplierEmails(emails, leads, new URLSearchParams("filter=linked")).length;
  const invoiceLikeCount = (emails || []).filter((email) => /invoice|statement|proforma|vat|payment|balance/i.test(`${email.subject || ""} ${email.rawSummary || ""}`)).length;
  const deliveryLikeCount = (emails || []).filter((email) => /delivery|dispatch|despatch|delivered|lead time|eta|confirmation/i.test(`${email.subject || ""} ${email.rawSummary || ""}`)).length;
  const filters = [
    ["Needs review", "needs-review"],
    ["Linked", "linked"],
    ["Unlinked", "unlinked"],
    ["Invoice", "invoice"],
    ["Delivery", "delivery"],
    ["Archived", "archived"],
    ["Irrelevant", "irrelevant"],
    ["All", "all"]
  ];
  return pageShell(
    "Supplier Email Review",
    `<section class="page-intro"><div><h2>Supplier email triage</h2><p>Separate supplier paperwork from customer leads, link useful messages to jobs, archive the noise.</p></div><form method="post" action="/sync/email"><button>Sync inbox</button></form></section>
    <section class="ay-section"><div class="ay-summary-grid">
      ${aySummaryCard({ label: "Needs review", value: String(filtered.length), href: "/supplier-emails" })}
      ${aySummaryCard({ label: "Unlinked", value: String(unlinkedCount), href: "/supplier-emails?filter=unlinked" })}
      ${aySummaryCard({ label: "Linked", value: String(linkedCount), href: "/supplier-emails?filter=linked" })}
      ${aySummaryCard({ label: "Invoice-like", value: String(invoiceLikeCount), href: "/supplier-emails?search=invoice" })}
      ${aySummaryCard({ label: "Delivery-like", value: String(deliveryLikeCount), href: "/supplier-emails?search=delivery" })}
    </div></section>
    <form method="get" class="filters filter-panel">
      <input name="search" placeholder="Search supplier, order ref, subject, customer, postcode" value="${escapeAttr(params.get("search") || "")}">
      <input name="supplier" placeholder="Supplier" value="${escapeAttr(params.get("supplier") || "")}">
      <input name="date" type="date" value="${escapeAttr(params.get("date") || "")}">
      <button>Filter</button>
      <a class="button secondary" href="/supplier-emails">Clear</a>
    </form>
    ${ayFilterTabs(filters.map(([label, value]) => ({ label, href: `/supplier-emails?filter=${value}`, active: current === value })), "Supplier email filters")}
    <section class="panel"><h2>Supplier email review items</h2>${supplierEmailCards(filtered, leads)}</section>`
  );
}

function supplierEmailDetailPage(email, leads) {
  if (!email) return pageShell("Supplier Email", `<p>Supplier email not found.</p><p><a class="button" href="/supplier-emails">Back to supplier emails</a></p>`);
  const linkedLead = (leads || []).find((lead) => lead.id === email.matchedLeadId);
  return pageShell(
    "Supplier Email",
    `${ayBackLink("/supplier-emails", "Back to supplier inbox")}
    <div class="ay-detail-summary-grid">
      <div class="ay-detail-card"><p class="ay-detail-card__title">Supplier</p>
        <div class="ay-detail-card__row"><span class="ay-detail-card__row-label">Name</span><span class="ay-detail-card__row-value">${escapeHtml(email.supplierName || "Unknown")}</span></div>
        <div class="ay-detail-card__row"><span class="ay-detail-card__row-label">Sender</span><span class="ay-detail-card__row-value">${escapeHtml(email.supplierEmail || "—")}</span></div>
      </div>
      <div class="ay-detail-card"><p class="ay-detail-card__title">Email</p>
        <div class="ay-detail-card__row"><span class="ay-detail-card__row-label">Subject</span><span class="ay-detail-card__row-value">${escapeHtml(email.subject || "—")}</span></div>
        <div class="ay-detail-card__row"><span class="ay-detail-card__row-label">Order ref</span><span class="ay-detail-card__row-value">${escapeHtml(email.extractedOrderReference || "—")}</span></div>
      </div>
      <div class="ay-detail-card"><p class="ay-detail-card__title">Review</p>
        <div class="ay-detail-card__row"><span class="ay-detail-card__row-label">Status</span><span class="ay-detail-card__row-value">${ayBadge({ variant: email.matchedLeadId ? "green" : "amber", label: email.reviewStatus || "Needs review" })}</span></div>
        <div class="ay-detail-card__row"><span class="ay-detail-card__row-label">Matched job</span><span class="ay-detail-card__row-value">${linkedLead ? `<a href="/leads/${encodeURIComponent(linkedLead.id)}" style="color:var(--ay-text-link)">${escapeHtml(linkedLead.customerName || linkedLead.customerPostcode || linkedLead.id)}</a>` : "Unlinked"}</span></div>
      </div>
    </div>
    <section class="split">
      <article><h2>Edit extracted data</h2>
        <form method="post" action="/supplier-emails/${encodeURIComponent(email.id)}/edit">
          <input name="supplierName" placeholder="Supplier name" value="${escapeAttr(email.supplierName || "")}">
          <input name="supplierEmail" placeholder="Supplier email" value="${escapeAttr(email.supplierEmail || "")}">
          <input name="subject" placeholder="Subject" value="${escapeAttr(email.subject || "")}">
          <input name="extractedOrderReference" placeholder="Order / invoice reference" value="${escapeAttr(email.extractedOrderReference || "")}">
          <input name="extractedLeadTime" placeholder="Lead time" value="${escapeAttr(email.extractedLeadTime || "")}">
          <input name="extractedDeliveryDate" type="date" value="${escapeAttr(email.extractedDeliveryDate || "")}">
          ${selectInput("reviewStatus", ["Needs review", "Reviewed", "Linked", "Duplicate", "Irrelevant", "Archived"], email.reviewStatus || "Needs review")}
          <textarea name="rawSummary" placeholder="Summary">${escapeHtml(email.rawSummary || "")}</textarea>
          <textarea name="notes" placeholder="Review notes">${escapeHtml(email.notes || "")}</textarea>
          <button>Save supplier email</button>
        </form>
      </article>
      <article><h2>Link to job</h2>
        <form method="post" action="/supplier-emails/${encodeURIComponent(email.id)}/link-job">
          ${leadSelect(leads, email.matchedLeadId)}
          <button>Link / unlink</button>
        </form>
        <h2>Review action</h2>
        <form method="post" action="/supplier-emails/${encodeURIComponent(email.id)}/mark-reviewed">
          ${selectInput("reviewStatus", ["Reviewed", "Needs review", "Duplicate", "Irrelevant", "Linked"], email.reviewStatus || "Reviewed")}
          <button>Mark status</button>
        </form>
        <form method="post" action="/supplier-emails/${encodeURIComponent(email.id)}/archive"><button class="button secondary">Archive</button></form>
        <form method="post" action="/supplier-emails/${encodeURIComponent(email.id)}/delete"><button>Delete permanently</button></form>
      </article>
    </section>`
  );
}

function manualLeadPage() {
  return pageShell(
    "Add Manual Lead",
    `<section class="page-intro"><div><h2>Add a lead</h2><p>Paste the enquiry. The app will extract the useful bits and take you straight to the job workflow.</p></div><a class="button secondary" href="/leads">Back to leads</a></section>
    <section class="panel form-panel">
      <form method="post" class="manual">
        <label><span>Customer message</span><textarea name="message" required placeholder="Paste Checkatrade enquiry, phone note or customer message here"></textarea></label>
        <label><span>Source</span><input name="source" placeholder="Source" value="Manual lead"></label>
        <button>Create lead</button>
        <details class="advanced-panel">
          <summary>Add optional customer details</summary>
          <div class="field-grid">
            <label><span>Name</span><input name="customerName" placeholder="Customer name"></label>
            <label><span>Phone</span><input name="customerPhone" placeholder="Phone"></label>
            <label><span>Email</span><input name="customerEmail" placeholder="Email"></label>
            <label><span>Postcode</span><input name="postcode" placeholder="Postcode"></label>
            <label><span>Full address</span><input name="customerAddress" placeholder="Full address"></label>
            <label><span>Location</span><input name="location" placeholder="Location"></label>
          </div>
          <label><span>Notes</span><textarea name="notes" placeholder="Internal notes"></textarea></label>
        </details>
      </form>
    </section>`
  );
}

function pageShell(title, body, status = 200) {
  const meta = pageMeta(title);

  // Resolve the active nav item from the page title (pageShell has no path).
  const titleToHref = {
    "Today": "/today", "Jobs": "/jobs", "Leads": "/leads", "Money": "/money",
    "Finance": "/finance", "Settings": "/settings", "System": "/system",
    "Installations": "/installations", "Supplier Email Review": "/supplier-emails",
    "Exports": "/exports", "Dashboard": "/dashboard", "Invoices": "/invoices",
    "Supplier Invoices": "/supplier-invoices", "Technician Schedule": "/technician-schedule",
    "Setup": "/setup", "Demo": "/demo", "Add Manual Lead": "/manual-lead"
  };
  const activeHref = titleToHref[title] || "";

  const primaryNav = [
    ["Today", "/today", "today"],
    ["Leads", "/leads", "leads"],
    ["Jobs", "/jobs", "jobs"],
    ["Supplier inbox", "/supplier-emails", "supplier"],
    ["Installations", "/installations", "installations"],
    ["Money", "/money", "money"],
    ["Finance", "/finance", "finance"]
  ];
  const adminNav = [
    ["Settings", "/settings", "settings"],
    ["System", "/system", "system"],
    ["Exports", "/exports", "exports"]
  ];
  const moreNav = [
    ["Dashboard", "/dashboard", "finance"],
    ["Add lead", "/manual-lead", "leads"],
    ["Customer invoices", "/invoices", "money"],
    ["Supplier invoices", "/supplier-invoices", "supplier"],
    ["Technician schedule", "/technician-schedule", "installations"],
    ["Setup", "/setup", "settings"],
    ["Demo", "/demo", "system"]
  ];

  const navItem = ([label, href, icon]) => {
    const active = href === activeHref;
    return `<a class="ay-nav-item${active ? " ay-nav-item--active" : ""}" href="${escapeAttr(href)}"${active ? ' aria-current="page"' : ""}>`
      + `<span class="ay-nav-item__icon">${ayIcon(icon)}</span><span class="ay-nav-item__label">${escapeHtml(label)}</span></a>`;
  };
  const navGroup = (label, items) => `<div class="ay-nav-group"><p class="ay-nav-group-label">${escapeHtml(label)}</p>${items.map(navItem).join("")}</div>`;
  const sidebarNav = navGroup("Workspace", primaryNav) + navGroup("Admin", adminNav) + navGroup("More", moreNav);
  const signOut = `<form method="post" action="/logout">${ayButton({ label: "Sign out", variant: "secondary", size: "sm", type: "submit", fullWidth: true })}</form>`;

  const bottomNav = [
    ["Today", "/today", "today"],
    ["Jobs", "/jobs", "jobs"],
    ["Money", "/money", "money"],
    ["Installs", "/installations", "installations"]
  ];
  const bottomItem = ([label, href, icon]) => {
    const active = href === activeHref;
    return `<a class="ay-bottom-nav__item${active ? " ay-bottom-nav__item--active" : ""}" href="${escapeAttr(href)}"${active ? ' aria-current="page"' : ""}>`
      + `<span class="ay-bottom-nav__item__icon">${ayIcon(icon, 24)}</span><span>${escapeHtml(label)}</span></a>`;
  };
  const moreSheetLinks = [...primaryNav, ...adminNav, ...moreNav].map(navItem).join("");

  const header = `<header class="ay-page-header">`
    + `<div><p class="ay-section-label" style="margin:0 0 4px">${escapeHtml(meta.kicker)}</p>`
    + `<h1 class="ay-page-title">${escapeHtml(title)}</h1>`
    + `<p class="ay-page-subtitle">${escapeHtml(meta.subtitle)}</p></div>`
    + `<div class="ay-page-header__actions">`
    + `<form method="get" action="/jobs" role="search" class="ay-page-header__search"><input class="ay-input" name="search" placeholder="Search customer, phone, postcode or job" aria-label="Search" style="min-width:200px"></form>`
    + ayButton({ label: meta.primaryLabel, href: meta.primaryHref, variant: "primary", size: "sm" })
    + `<form method="post" action="/sync/email">${ayButton({ label: "Sync inbox", variant: "secondary", size: "sm", type: "submit" })}</form>`
    + `</div></header>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#15426B"><title>${escapeHtml(title)}</title><style>${appStyles()}</style></head><body>`
    + `<input type="checkbox" id="ay-more-toggle" class="ay-sr-only" aria-hidden="true" tabindex="-1">`
    + `<a class="ay-sr-only" href="#main-content">Skip to main content</a>`
    + `<div class="ay-shell">`
    + `<aside class="ay-sidebar">`
    + `<div class="ay-sidebar__logo">Autodoors Yorkshire<span class="ay-sidebar__logo-sub">Trade dashboard</span></div>`
    + `<nav class="ay-sidebar__nav" aria-label="Primary">${sidebarNav}</nav>`
    + `<div class="ay-sidebar__foot"><div>info@autodoorsyorkshire.com</div><strong>07895 698 239</strong>${signOut}</div>`
    + `</aside>`
    + `<div class="ay-main-content">${header}<main id="main-content">${body}</main></div>`
    + `</div>`
    + `<nav class="ay-bottom-nav" aria-label="Primary mobile"><div class="ay-bottom-nav__items">${bottomNav.map(bottomItem).join("")}<label class="ay-bottom-nav__item" for="ay-more-toggle" role="button" tabindex="0" aria-controls="ay-more-toggle"><span class="ay-bottom-nav__item__icon">${ayIcon("more", 24)}</span><span>More</span></label></div></nav>`
    + `<div class="ay-more-sheet"><label class="ay-more-sheet__backdrop" for="ay-more-toggle" aria-label="Close menu"></label><div class="ay-more-sheet__panel"><div class="ay-sheet__handle"></div><div class="ay-sheet__header"><p class="ay-sheet__title">Menu</p><label class="ay-sheet__close" for="ay-more-toggle" role="button" tabindex="0" aria-label="Close menu">✕</label></div><nav aria-label="All sections" style="padding:var(--ay-space-2)">${moreSheetLinks}</nav><div style="padding:var(--ay-space-3)">${signOut}</div></div></div>`
    + `<div class="ay-toast-region" aria-live="polite" aria-atomic="false"></div>`
    + `<script>${appScript()}</script></body></html>`;
}

function pageMeta(title) {
  const defaults = { kicker: "Autodoors Yorkshire", subtitle: "Trade operating dashboard.", primaryLabel: "Add lead", primaryHref: "/manual-lead" };
  return {
    Dashboard: { kicker: "Management overview", subtitle: "Pipeline, money and recent activity at a glance.", primaryLabel: "Open Today", primaryHref: "/today" },
    Today: { kicker: "Command centre", subtitle: "The work, money and risk items to handle first.", primaryLabel: "Add lead", primaryHref: "/manual-lead" },
    Jobs: { kicker: "Active work", subtitle: "Live jobs from quote through supplier, install, payment and close.", primaryLabel: "Add job", primaryHref: "/manual-lead" },
    Leads: { kicker: "Work queue", subtitle: "Find the customer, see the stage, open the next action.", primaryLabel: "Add lead", primaryHref: "/manual-lead" },
    Money: { kicker: "Owner money view", subtitle: "Money to collect, supplier bills and payment requests.", primaryLabel: "Record payment", primaryHref: "/money#customer-balances" },
    "Add Manual Lead": { kicker: "New enquiry", subtitle: "Paste the message and let the dashboard create the job.", primaryLabel: "View leads", primaryHref: "/leads" },
    Finance: { kicker: "Money control", subtitle: "Customer balances, supplier bills and job margin estimates.", primaryLabel: "Record payment", primaryHref: "/finance#payments" },
    Invoices: { kicker: "Customer invoices", subtitle: "Draft, issue, PDF and track invoices without auto-sending.", primaryLabel: "New invoice", primaryHref: "/invoices/new" },
    "Supplier Invoices": { kicker: "Supplier bills", subtitle: "See what is due, part-paid, overdue or settled.", primaryLabel: "Open finance", primaryHref: "/finance#supplier-invoices" },
    Installations: { kicker: "Schedule", subtitle: "Jobs ready to book, due today, or waiting on balance.", primaryLabel: "Technician schedule", primaryHref: "/technician-schedule" },
    "Technician Schedule": { kicker: "Field work", subtitle: "Preview daily/weekly work and calendar files.", primaryLabel: "Daily preview", primaryHref: "/technician-schedule/daily" },
    "Supplier Email Review": { kicker: "Inbox review", subtitle: "Link supplier emails to jobs or archive the noise.", primaryLabel: "Sync inbox", primaryHref: "/supplier-emails" },
    System: { kicker: "Health and safety", subtitle: "Storage, exports, warnings and integration readiness.", primaryLabel: "Export data", primaryHref: "/exports" },
    Settings: { kicker: "Setup", subtitle: "Business, invoice and payment details for live use.", primaryLabel: "Setup wizard", primaryHref: "/setup" },
    Setup: { kicker: "Client onboarding", subtitle: "The checklist for a ready-to-use trade dashboard.", primaryLabel: "Settings", primaryHref: "/settings" },
    Exports: { kicker: "Data ownership", subtitle: "Download workbook, CSV files or all dashboard data.", primaryLabel: "All data", primaryHref: "/export/all-data.json" },
    Demo: { kicker: "Sales demo", subtitle: "Safe fake data for walkthroughs and training.", primaryLabel: "Demo Today", primaryHref: "/today?demo=true" }
  }[title] || defaults;
}

function appStyles() {
  return `
${AY_DESIGN_SYSTEM_CSS}
.settings-groups{display:grid;gap:14px}.settings-group{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px}.settings-group h3{margin:0 0 12px}
.today-command-list,.warning-stack,.setup-steps{display:grid;gap:10px}.today-command-card,.warning-card,.setup-step{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;background:var(--surface);border:1px solid var(--border);border-left:4px solid var(--neutral);border-radius:8px;padding:13px;text-decoration:none;color:var(--text)}.today-command-card h3,.warning-card h3,.setup-step strong{margin:0}.today-command-card p,.warning-card p,.setup-step small{margin:4px 0;color:var(--muted)}.today-command-card.red,.warning-card.red,.setup-step.red{border-left-color:var(--danger)}.today-command-card.amber,.warning-card.amber,.setup-step.amber{border-left-color:var(--warning)}.today-command-card.green,.warning-card.green,.setup-step.green{border-left-color:var(--success)}.setup-step span{font-size:12px;font-weight:900;text-transform:uppercase;color:var(--muted)}.demo-banner{display:flex;justify-content:space-between;gap:12px;align-items:center;background:var(--ay-brand-soft);border-color:var(--border)}.demo-banner strong{color:var(--primary)}.demo-banner span{color:var(--muted)}@media(max-width:760px){.today-command-card,.warning-card,.setup-step{grid-template-columns:1fr}.today-command-card .button,.warning-card .button{width:100%}}
*{box-sizing:border-box}body{font-family:Inter,Arial,sans-serif;margin:0;background:var(--bg);color:var(--text);line-height:1.45}header{background:var(--primary-strong);color:var(--ay-text-inverse);border-bottom:1px solid var(--border)}header .wrap,main{max-width:1240px;margin:0 auto;padding:18px}.topbar{display:flex;gap:18px;align-items:center;justify-content:space-between}.app-kicker{margin:0 0 4px;color:var(--muted);font-size:12px;text-transform:uppercase;font-weight:800;letter-spacing:.08em}h1{margin:0;font-size:24px;letter-spacing:0}h2{font-size:17px;margin:0 0 12px}h3{font-size:14px;margin:0 0 8px}a{color:var(--ay-text-link)}nav{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}nav a{display:inline-flex;align-items:center;min-height:36px;padding:8px 10px;border-radius:7px;color:var(--ay-text-inverse);text-decoration:none;font-weight:700;font-size:13px}nav a:hover,.quick-filters .active{background:var(--primary-strong);color:var(--ay-text-inverse)}.button,button{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:9px 13px;border:1px solid var(--text);background:var(--primary);border-radius:7px;color:var(--ay-text-inverse);text-decoration:none;cursor:pointer;font-weight:800;font-size:13px}.button:hover,button:hover{background:var(--primary-strong)}.button.secondary{background:var(--surface);color:var(--text)}.button.secondary:hover{background:var(--ay-gray-bg)}.compact-button{min-height:32px;padding:7px 10px;font-size:12px}.danger-button{background:var(--danger);border-color:var(--ay-red-text)}.danger-button:hover{background:var(--ay-red-text)}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}.brand-strip{display:flex;gap:14px;flex-wrap:wrap;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin:0 0 14px}.brand-strip strong{color:var(--text)}.brand-strip span{color:var(--muted)}.overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:14px 0}.overview-tile{background:var(--surface);color:var(--text);border:1px solid var(--border);border-left:5px solid var(--neutral);border-radius:8px;padding:14px;text-decoration:none}.overview-tile strong{display:block;font-size:29px}.overview-tile span{display:block;font-size:12px;color:var(--muted);font-weight:800}.overview-tile.red,.metric-card.red,.action-card.red,.job-mini-card.red{border-left-color:var(--danger)}.overview-tile.amber,.metric-card.amber,.action-card.amber,.job-mini-card.amber{border-left-color:var(--warning)}.overview-tile.green,.metric-card.green,.action-card.green,.job-mini-card.green{border-left-color:var(--success)}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}.compact-queues{grid-template-columns:repeat(auto-fit,minmax(145px,1fr));margin-top:10px}.metric-card,.metrics div,article,.panel{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px;text-decoration:none;color:var(--text)}.active-card{border-left:5px solid var(--warning)}.quiet-card{opacity:.7}.metric-card:hover,.overview-tile:hover,.job-mini-card:hover{border-color:var(--border);box-shadow:var(--shadow)}.metrics strong{display:block;font-size:27px;color:var(--text)}.metrics span{font-size:13px;color:var(--muted)}.status-card{border-left:5px solid var(--border)}.status-card.green{border-left-color:var(--success)}.status-card.amber{border-left-color:var(--warning)}.status-card.red{border-left-color:var(--danger)}.status-card small{display:block;color:var(--muted);margin-top:5px}.ops-snapshot{margin:14px 0}details{margin-top:12px}summary{cursor:pointer;color:var(--text);font-weight:800}.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin:14px 0}.today ul,.timeline{padding-left:18px;margin:0}.today li{margin:8px 0}.focus-list{display:grid;gap:8px}.focus-row{display:grid;grid-template-columns:92px 1fr auto;gap:10px;align-items:center;padding:10px;border:1px solid var(--border);border-radius:8px;text-decoration:none;color:var(--text);background:var(--surface)}.focus-main strong,.focus-main span{display:block}.focus-main span{font-size:13px;color:var(--muted)}.action-card-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.action-card{border-left:5px solid var(--border)}.action-card h3{margin-top:8px}.action-card p{margin:7px 0}.pipeline-board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.pipeline-column{background:var(--surface-soft);border:1px solid var(--border);border-radius:8px;padding:10px}.pipeline-column h3{display:flex;justify-content:space-between;align-items:center}.pipeline-column h3 span{background:var(--ay-gray-bg);border-radius:999px;padding:2px 7px;font-size:12px}.job-mini-card{display:block;background:var(--surface);border:1px solid var(--border);border-left:5px solid var(--success);border-radius:8px;padding:10px;margin:8px 0;text-decoration:none;color:var(--text)}.job-mini-card strong,.job-mini-card span,.job-mini-card small{display:block}.job-mini-card span{font-size:13px;color:var(--muted)}.job-mini-card small{margin-top:4px;color:var(--muted)}table{width:100%;border-collapse:separate;border-spacing:0;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden}th,td{border-bottom:1px solid var(--border);padding:10px;text-align:left;vertical-align:top;font-size:14px}th{background:var(--surface-soft);color:var(--text);font-size:12px;text-transform:uppercase;letter-spacing:.04em}tr:last-child td{border-bottom:0}.select-col{width:44px;text-align:center}.select-col input{margin:0}.badge{display:inline-flex;gap:5px;align-items:center;padding:4px 8px;border-radius:999px;background:var(--ay-gray-bg);font-size:12px;font-weight:800}.High,.red,.rag-red{background:var(--ay-red-bg);color:var(--ay-red-text)}.Medium,.amber,.rag-amber{background:var(--ay-amber-bg);color:var(--ay-amber-text)}.Low,.green,.rag-green{background:var(--ay-green-bg);color:var(--ay-green-text)}.grey{background:var(--ay-gray-bg);color:var(--muted)}textarea{width:100%;min-height:150px;margin:8px 0;padding:10px;border:1px solid var(--ay-border-strong);border-radius:var(--ay-radius-md);background:var(--ay-surface-muted);color:var(--ay-text-primary)}input,select{padding:9px;margin:5px 5px 5px 0;border:1px solid var(--ay-border-strong);border-radius:var(--ay-radius-md);max-width:100%;background:var(--ay-surface-muted);color:var(--ay-text-primary)}input:focus,select:focus,textarea:focus{border-color:var(--ay-border-focus);box-shadow:0 0 0 3px var(--ay-brand-soft);outline:none}input::placeholder,textarea::placeholder{color:var(--ay-text-secondary)}.filters,.bulk-toolbar{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px}.filters input{min-width:190px}.bulk-toolbar{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin:12px 0}.bulk-toolbar label span{display:block;font-size:12px;color:var(--muted);font-weight:800}.bulk-toolbar select{min-width:190px}.quick-filters{margin:12px 0;display:flex;gap:6px;flex-wrap:wrap}.quick-filters a{padding:8px 10px;border-radius:999px;background:var(--surface);color:var(--text);border:1px solid var(--border);text-decoration:none;font-weight:800;font-size:13px}.lead-detail{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}.lead-detail div{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px}.stage-banner{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin:14px 0;padding:14px;border-radius:8px;border:1px solid var(--border)}.stage-banner strong{display:block;font-size:18px}.eyebrow{display:block;text-transform:uppercase;font-size:11px;color:var(--muted);letter-spacing:.04em;font-weight:900}.workflow-rail{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:8px;margin:14px 0}.workflow-step{position:relative;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px;min-height:78px}.workflow-step strong,.workflow-step span{display:block}.workflow-step strong{font-size:12px}.workflow-step span{font-size:12px;color:var(--muted)}.workflow-step.done{border-color:var(--ay-green-border);background:var(--ay-green-bg)}.workflow-step.current{border-color:var(--warning);background:var(--ay-amber-bg);box-shadow:inset 0 0 0 1px var(--warning)}.workflow-step.pending{color:var(--muted)}.inline-actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.inline-actions form{background:var(--surface-soft);border:1px solid var(--border);border-radius:8px;padding:12px}.muted{color:var(--muted)}.customer-line{white-space:nowrap}.job-short{max-width:360px}.risk-dot{display:inline-block;width:9px;height:9px;border-radius:99px;background:currentColor}@media(max-width:920px){.topbar{align-items:flex-start;flex-direction:column}.pipeline-board,.workflow-rail{grid-template-columns:repeat(2,minmax(0,1fr))}nav{justify-content:flex-start}}@media(max-width:760px){header .wrap,main{padding:14px}.overview{grid-template-columns:repeat(2,minmax(0,1fr))}.pipeline-board,.workflow-rail{grid-template-columns:1fr}.focus-row{grid-template-columns:1fr}table,thead,tbody,tr,th,td{display:block}thead{display:none}tr{border-bottom:12px solid var(--surface-soft)}td{border-bottom:1px solid var(--border)}.select-col{width:auto;text-align:left}.customer-line{white-space:normal}.button,button{width:100%;text-align:center}.actions form,.bulk-toolbar label{width:100%}}
.calculation-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;background:var(--surface-soft);border:1px solid var(--border);border-radius:8px;padding:10px;margin:8px 0}.calculation-strip span{font-size:12px;color:var(--muted)}.calculation-strip strong{display:block;color:var(--text);font-size:15px}.warning-list{border-left:5px solid var(--warning);background:var(--ay-amber-bg)}.warning-list.red{border-left-color:var(--danger);background:var(--ay-red-bg)}
body{background:var(--bg);color:var(--text)}.brand-mark{display:flex;gap:10px;align-items:center;padding:0 4px}.brand-mark strong{display:grid;place-items:center;width:38px;height:38px;background:var(--primary);color:var(--ay-text-inverse);border-radius:8px}.brand-mark span{font-weight:900}.app-kicker{color:var(--muted);letter-spacing:.08em}main{max-width:1260px;padding:24px}.panel,article,.metric-card,.overview-tile,.job-mini-card,.filters,.bulk-toolbar{border-color:var(--border);border-radius:var(--radius);box-shadow:var(--ay-shadow-sm)}.panel{margin:0 0 18px}.panel.calm{padding:18px}.panel-heading{display:flex;justify-content:space-between;gap:12px;align-items:center;margin:0 0 12px}.panel-heading h2{margin:0}.button,button{background:var(--primary);border-color:var(--primary);border-radius:var(--radius);font-weight:800}.button:hover,button:hover{background:var(--primary-strong)}.button.secondary{border-color:var(--border);background:var(--surface);color:var(--primary)}.danger-button{background:var(--danger);border-color:var(--danger)}input,select,textarea{background:var(--ay-surface-muted);color:var(--ay-text-primary);border:1px solid var(--ay-border-strong);border-radius:var(--ay-radius-md)}table{box-shadow:none}th{background:var(--surface-soft);color:var(--muted)}.badge{border-radius:999px}.page-intro{display:flex;justify-content:space-between;gap:16px;align-items:flex-end;margin:0 0 18px}.page-intro p{margin:4px 0 0;color:var(--muted);max-width:680px}.section-grid,.field-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.empty-state{background:var(--surface);border:1px dashed var(--border);border-radius:var(--radius);padding:20px;color:var(--muted)}.review-card,.install-card,.lead-card,.scan-card{display:block;background:var(--surface);border:1px solid var(--border);border-left:4px solid var(--neutral);border-radius:var(--radius);padding:15px;text-decoration:none;color:var(--text)}.review-card.green,.install-card.green,.lead-card.green,.scan-card.green{border-left-color:var(--success)}.review-card.amber,.install-card.amber,.lead-card.amber,.scan-card.amber{border-left-color:var(--warning)}.review-card.red,.install-card.red,.lead-card.red,.scan-card.red{border-left-color:var(--danger)}.review-card:hover,.install-card:hover,.lead-card:hover,.scan-card:hover{box-shadow:var(--shadow);border-color:var(--border)}.card-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.meta-row{display:flex;gap:8px;flex-wrap:wrap;color:var(--muted);font-size:13px}.primary-action-panel{border:1px solid var(--border);border-top:4px solid var(--accent);box-shadow:var(--shadow);background:var(--ay-brand-soft)}.primary-action-panel .inline-actions{grid-template-columns:minmax(0,1fr)}.primary-action-panel form{background:var(--surface)}.status-safe{color:var(--success)}.status-warning{color:var(--warning)}.status-danger{color:var(--danger)}.mini-overview{margin-top:0}.filter-panel{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}.form-panel label span,.field-grid label span,.stacked-form label span{display:block;color:var(--muted);font-size:12px;font-weight:900;text-transform:uppercase}.stacked-form label{display:block;margin-bottom:8px}.stacked-form label small{display:block;color:var(--muted);font-size:12px;margin-top:2px}.stacked-form input,.stacked-form textarea,.form-panel input,.form-panel textarea,.field-grid input{width:100%}.form-warning{display:block;color:var(--warning);font-weight:800;margin:4px 0}.manual button{margin-top:10px}.quick-filters a.active{background:var(--primary);color:var(--ay-text-inverse);border-color:var(--primary)}.cockpit-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(300px,.75fr);gap:16px}.action-list{display:grid;gap:9px}.action-row{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px;text-decoration:none;color:var(--text)}.action-count{display:grid;place-items:center;min-width:42px;height:36px;border-radius:8px;background:var(--ay-brand-soft);color:var(--primary);font-weight:900}.action-row.red .action-count{background:var(--ay-red-bg);color:var(--ay-red-text)}.action-row.amber .action-count{background:var(--ay-amber-bg);color:var(--ay-amber-text)}.action-row.green .action-count{background:var(--ay-green-bg);color:var(--ay-green-text)}.summary-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.summary-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px}.summary-card strong{display:block;font-size:24px}.summary-card span{color:var(--muted);font-size:13px}.tab-list{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}.tab-list a{padding:8px 11px;border:1px solid var(--border);border-radius:999px;background:var(--surface);text-decoration:none;font-weight:800}.tab-list a.active{background:var(--primary);border-color:var(--primary);color:var(--ay-text-inverse)}.advanced-panel{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px}.advanced-panel summary{color:var(--text)}.snapshot-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.snapshot-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px}.snapshot-card p{margin:6px 0;color:var(--muted)}.lead-scan-grid{display:grid;gap:10px}.lead-scan-card{display:grid;grid-template-columns:auto 1.4fr 1fr auto;gap:14px;align-items:center}.lead-scan-card h3{margin:0}.lead-scan-card p{margin:4px 0}.drawer{margin-top:12px}.drawer>summary{padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:8px}.drawer[open]>summary{border-bottom-left-radius:0;border-bottom-right-radius:0}.drawer-body{border:1px solid var(--border);border-top:0;border-radius:0 0 8px 8px;background:var(--surface);padding:14px}@media(max-width:980px){main{padding:14px}.page-intro{display:block}.cockpit-grid{grid-template-columns:1fr}.lead-scan-card{grid-template-columns:1fr}}@media(max-width:760px){.card-grid,.section-grid,.field-grid,.snapshot-grid{grid-template-columns:1fr}.filter-panel .button,.filter-panel button{width:auto}.panel-heading{align-items:flex-start;flex-direction:column}.action-row{grid-template-columns:auto 1fr}.action-row .button{grid-column:1 / -1}.overview{grid-template-columns:1fr 1fr}table,thead,tbody,tr,th,td{display:block}}
.page-subtitle{margin:4px 0 0;color:var(--muted);font-size:14px;max-width:680px}.export-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.export-card{display:block;padding:16px;background:var(--surface);border:1px solid var(--border);border-radius:10px;text-decoration:none;color:var(--text)}.export-card strong{display:block;margin-bottom:6px}.export-card span{color:var(--muted);font-size:13px}.compact-warning-panel .warning-stack{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}.warning-stack.compact .warning-card{grid-template-columns:1fr auto}.customer-details-panel{border-top:4px solid var(--primary)}.customer-details-panel>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;list-style:none}.customer-details-panel>summary::-webkit-details-marker{display:none}.customer-details-panel summary strong,.customer-details-panel summary small{display:block}.customer-details-panel summary small{color:var(--muted);font-size:13px;font-weight:500}.customer-edit-form{display:grid;gap:12px;margin-top:14px}.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.compact-form-grid{grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}.customer-edit-form label span{display:block;color:var(--muted);font-size:12px;font-weight:900;text-transform:uppercase;margin-bottom:4px}.customer-edit-form input,.customer-edit-form select,.customer-edit-form textarea{width:100%;margin:0}.customer-edit-form textarea{min-height:86px}.customer-edit-form small{display:block;margin-top:4px;color:var(--muted)}main{display:block}.panel{border-radius:12px}.metric-card,.summary-card,.status-card,.review-card,.install-card,.scan-card,.lead-scan-card,.today-command-card,.warning-card,.setup-step,.export-card{transition:border-color .15s ease,box-shadow .15s ease,transform .15s ease}.metric-card:hover,.summary-card:hover,.status-card:hover,.review-card:hover,.install-card:hover,.scan-card:hover,.lead-scan-card:hover,.today-command-card:hover,.warning-card:hover,.setup-step:hover,.export-card:hover{transform:translateY(-1px);box-shadow:var(--shadow)}.button,button{min-height:40px}.button.secondary,button.secondary{box-shadow:inset 0 0 0 1px var(--border)}.quick-filters{overflow:auto;padding-bottom:3px}.quick-filters a{white-space:nowrap}.today-command-card .button,.action-row .button{white-space:nowrap}details.drawer>summary,details.advanced-panel>summary{list-style:none}details.drawer>summary::-webkit-details-marker,details.advanced-panel>summary::-webkit-details-marker{display:none}details.drawer>summary::after,details.advanced-panel>summary::after{content:"Show";float:right;color:var(--muted);font-size:12px}details[open].drawer>summary::after,details[open].advanced-panel>summary::after{content:"Hide"}.money-card-list{display:grid;gap:12px}.money-card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:start;background:var(--surface);border:1px solid var(--border);border-left:5px solid var(--warning);border-radius:14px;padding:16px}.money-card.red{border-left-color:var(--danger)}.money-card.green{border-left-color:var(--success)}.money-card h3{font-size:16px;margin:2px 0 4px}.money-card p{margin:0 0 8px}.money-card strong{font-size:22px;color:var(--text);white-space:nowrap}.money-card .actions{grid-column:1 / -1;margin:0}.login-screen{min-height:100vh;background:radial-gradient(circle at top left,var(--ay-brand-soft),transparent 34%),var(--bg)}.login-wrap{min-height:100vh;display:grid;place-items:center;padding:24px}.login-card{width:min(440px,100%);background:var(--surface);border:1px solid var(--border);border-radius:22px;padding:28px;box-shadow:var(--shadow)}.login-card .brand-mark{margin-bottom:18px}.login-card h1{font-size:32px;margin:0 0 6px}.login-card .warning-card{display:block;margin:14px 0}@media(max-width:980px){.money-card{grid-template-columns:1fr}.money-card strong{font-size:26px}.money-card .actions{display:grid;grid-template-columns:1fr 1fr}.money-card .actions a{width:100%}.brand-mark{margin-bottom:4px}}@media(max-width:760px){body{font-size:15px}.page-subtitle{font-size:13px}.overview,.summary-strip{grid-template-columns:1fr}.today-command-card,.warning-stack.compact .warning-card,.action-row{grid-template-columns:1fr}.today-command-card .button,.action-row .button,.warning-card .button{width:100%}.split{grid-template-columns:1fr}.lead-detail{grid-template-columns:1fr}.workflow-rail{grid-template-columns:1fr}.workflow-step{min-height:auto}table{border:0;background:transparent}tbody tr{background:var(--surface);border:1px solid var(--border);border-radius:10px;margin:0 0 12px;padding:8px}td{padding:8px 10px}}@media(max-width:520px){.money-card .actions{grid-template-columns:1fr}.login-card{border-radius:18px;padding:22px}.login-card h1{font-size:27px}}
`;
}

function appScript() {
  return `const money=(value)=>Number(String(value||"").replace(/[^0-9.-]/g,""))||0;const fmt=(value)=>new Intl.NumberFormat("en-GB",{style:"currency",currency:"GBP"}).format(value);const selectAll=document.getElementById("select-all-leads");if(selectAll){selectAll.addEventListener("change",()=>document.querySelectorAll(".lead-select").forEach((box)=>{box.checked=selectAll.checked;}));}document.querySelectorAll('form[action="/leads/bulk"]').forEach((form)=>{form.addEventListener("submit",(event)=>{const action=form.querySelector('[name="bulkAction"]')?.value;const selected=form.querySelectorAll(".lead-select:checked").length;if(!selected){event.preventDefault();alert("Select at least one lead first.");return;}if(action==="delete"&&!confirm("Permanently delete selected leads? This cannot be undone.")){event.preventDefault();}});});document.querySelectorAll(".payment-form").forEach((form)=>{const amount=form.querySelector('[name="amount"]');const output=form.querySelector(".balance-after");const type=form.querySelector('[name="payment_type"]');const update=()=>{if(!output)return;const before=money(form.dataset.balanceBefore);const value=money(amount?.value);const sign=type?.value==="refund"?1:-1;output.textContent=fmt(Math.max(before+(value*sign),0));};amount?.addEventListener("input",update);type?.addEventListener("change",update);update();});document.querySelectorAll(".supplier-invoice-form").forEach((form)=>{const net=form.querySelector('[name="net_amount"]');const vat=form.querySelector('[name="vat_amount"]');const gross=form.querySelector('[name="gross_amount"]');const warning=document.createElement("span");warning.className="form-warning";gross?.parentElement?.appendChild(warning);let grossEdited=false;gross?.addEventListener("input",()=>{grossEdited=true;update();});const update=()=>{const calculated=money(net?.value)+money(vat?.value);if(gross&&!grossEdited&&calculated>0)gross.value=calculated.toFixed(2);const entered=money(gross?.value);warning.textContent=entered&&calculated&&Math.abs(entered-calculated)>0.009?"Gross total does not match net + VAT. Check the invoice total.":"";};net?.addEventListener("input",update);vat?.addEventListener("input",update);update();});`;
}

/* ============================================================
   AY DESIGN-SYSTEM COMPONENT HELPERS (Phase 2)
   Server-side HTML builders that emit the ay- prefixed markup
   from styles/components.css. These mirror the plan's React
   components but as string helpers, matching this codebase's
   existing pattern (badge()/leadTable()). All input is escaped.
   ============================================================ */

// Maps the REAL lead status values (see STATUSES) to a plain-English
// label and a badge colour variant. Plan Appendix A, adapted to live data.
const AY_STAGE_BADGE = {
  "New":                    { label: "New enquiry",      variant: "red"   },
  "Draft created":          { label: "Draft ready",      variant: "amber" },
  "Awaiting approval":      { label: "Awaiting approval", variant: "amber" },
  "Needs call":             { label: "Needs call",       variant: "red"   },
  "Awaiting photos":        { label: "Awaiting photos",  variant: "amber" },
  "Quote booked":           { label: "Quote booked",     variant: "blue"  },
  "Replied":                { label: "Replied",          variant: "blue"  },
  "Follow-up due":          { label: "Follow-up due",    variant: "amber" },
  "Quoted":                 { label: "Quoted",           variant: "amber" },
  "Won":                    { label: "Won",              variant: "green" },
  "Installation completed": { label: "Installation done",variant: "green" },
  "Paid":                   { label: "Paid",             variant: "green" },
  "Review requested":       { label: "Review requested", variant: "blue"  },
  "Closed":                 { label: "Closed",           variant: "gray"  },
  "Lost":                   { label: "Lost",             variant: "gray"  },
  "Out of area":            { label: "Out of area",      variant: "gray"  },
  "Duplicate":              { label: "Duplicate",        variant: "gray"  },
  "Archived":               { label: "Archived",         variant: "gray"  }
};

const AY_BADGE_VARIANTS = new Set(["red", "amber", "green", "blue", "gray"]);

// Generic status badge with coloured dot + text (never colour alone).
function ayBadge({ variant = "gray", label = "", noDot = false } = {}) {
  const safeVariant = AY_BADGE_VARIANTS.has(variant) ? variant : "gray";
  return `<span class="ay-badge ay-badge--${safeVariant}${noDot ? " ay-badge--no-dot" : ""}">${escapeHtml(label)}</span>`;
}

// Resolve a lead/job status string to its badge.
function ayStageBadge(status) {
  const mapped = AY_STAGE_BADGE[status];
  if (mapped) return ayBadge({ variant: mapped.variant, label: mapped.label });
  return ayBadge({ variant: "gray", label: status || "Unknown" });
}

// Button or link. Pass href to render an <a>; omit for a <button>.
function ayButton({ label, href, variant = "primary", size = "md", fullWidth = false, type, disabled = false, attrs = "" } = {}) {
  const classes = [
    "ay-btn",
    `ay-btn--${variant}`,
    size && size !== "md" ? `ay-btn--${size}` : "",
    fullWidth ? "ay-btn--full" : ""
  ].filter(Boolean).join(" ");
  const inner = escapeHtml(label || "");
  if (href && !disabled) {
    return `<a class="${classes}" href="${escapeAttr(href)}"${attrs ? " " + attrs : ""}>${inner}</a>`;
  }
  const disabledAttr = disabled ? ' disabled aria-disabled="true"' : "";
  const typeAttr = type ? ` type="${escapeAttr(type)}"` : ' type="button"';
  return `<button class="${classes}"${typeAttr}${disabledAttr}${attrs ? " " + attrs : ""}>${inner}</button>`;
}

// Metric / summary card. Renders as a link when href is supplied.
function aySummaryCard({ label, value, sub, href } = {}) {
  const body = `<p class="ay-summary-card__label">${escapeHtml(label || "")}</p>`
    + `<p class="ay-summary-card__value">${escapeHtml(String(value == null ? "" : value))}</p>`
    + (sub ? `<p class="ay-summary-card__sub">${escapeHtml(sub)}</p>` : "");
  if (href) {
    return `<a class="ay-summary-card ay-card--clickable" href="${escapeAttr(href)}">${body}</a>`;
  }
  return `<div class="ay-summary-card">${body}</div>`;
}

// Action card for the Today page. Returns "" when count is 0 so callers
// can suppress empty sections (plan Phase 4 / 15.3).
function ayActionCard({ variant = "amber", title, count = 0, badgeLabel, meta, actionLabel, actionHref } = {}) {
  if (!count) return "";
  const badgeText = badgeLabel || (count === 1 ? "1 item" : `${count} items`);
  const cardVariant = ["red", "amber", "blue", "green"].includes(variant) ? variant : "amber";
  const action = actionLabel
    ? ayButton({ label: actionLabel, href: actionHref, variant: "primary", size: "sm" })
    : "";
  return `<div class="ay-action-card ay-action-card--${cardVariant}">`
    + `<div class="ay-action-card__header">`
    + `<h3 class="ay-action-card__title">${escapeHtml(title || "")}</h3>`
    + ayBadge({ variant: cardVariant, label: badgeText })
    + `</div>`
    + (meta ? `<p class="ay-action-card__meta">${escapeHtml(meta)}</p>` : "")
    + (action ? `<div class="ay-action-card__footer">${action}</div>` : "")
    + `</div>`;
}

// Job card for list views (mobile-friendly). meta parts joined with middots.
function ayJobCard({ customerName, metaParts = [], status, statusBadge, isAtRisk = false, value, primaryLabel, primaryHref, detailHref } = {}) {
  const meta = metaParts.filter(Boolean).map((part) => escapeHtml(String(part))).join(" · ");
  const badges = statusBadge || (ayStageBadge(status)
    + (isAtRisk ? ayBadge({ variant: "red", label: "Job at risk" }) : ""));
  const actions = [
    value ? `<span class="ay-job-card__value">${escapeHtml(String(value))}</span>` : "",
    primaryLabel ? ayButton({ label: primaryLabel, href: primaryHref, variant: "primary", size: "sm" }) : "",
    detailHref ? ayButton({ label: "View job", href: detailHref, variant: "ghost", size: "sm" }) : ""
  ].filter(Boolean).join("");
  return `<div class="ay-job-card">`
    + `<div class="ay-job-card__main">`
    + `<div class="ay-job-card__top"><span class="ay-job-card__name">${escapeHtml(customerName || "")}</span>${badges}</div>`
    + (meta ? `<p class="ay-job-card__meta">${meta}</p>` : "")
    + `</div>`
    + `<div class="ay-job-card__actions">${actions}</div>`
    + `</div>`;
}

const AY_SYSTEM_STATUS = {
  "safe":           { label: "Safe",           variant: "green" },
  "warning":        { label: "Warning",        variant: "amber" },
  "action-needed":  { label: "Action needed",  variant: "red"   },
  "disabled":       { label: "Disabled",       variant: "gray"  },
  "not-configured": { label: "Not configured", variant: "gray"  }
};

// System status card. details (already-escaped HTML) shown in a <details>.
function aySystemCard({ title, description, status = "safe", lastChecked, details, actionLabel, actionHref } = {}) {
  const meta = AY_SYSTEM_STATUS[status] || AY_SYSTEM_STATUS.safe;
  const action = actionLabel && actionHref
    ? ayButton({ label: actionLabel, href: actionHref, variant: "secondary", size: "sm" })
    : "";
  const detailsBlock = details
    ? `<details style="margin-top:var(--ay-space-4)"><summary class="ay-system-card__last-checked" style="cursor:pointer">Details</summary>`
      + `<div style="margin-top:var(--ay-space-3);padding:var(--ay-space-3);background:var(--ay-surface-subtle);border:1px solid var(--ay-border);border-radius:var(--ay-radius-sm);font-size:13px;color:var(--ay-text-secondary);font-family:var(--ay-font-mono)">${details}</div></details>`
    : "";
  return `<div class="ay-system-card">`
    + `<div class="ay-system-card__header"><h3 class="ay-system-card__title">${escapeHtml(title || "")}</h3>${ayBadge({ variant: meta.variant, label: meta.label, noDot: true })}</div>`
    + `<p class="ay-system-card__desc">${escapeHtml(description || "")}</p>`
    + `<div class="ay-system-card__footer"><div style="display:flex;gap:var(--ay-space-2);align-items:center">${action}</div>`
    + (lastChecked ? `<span class="ay-system-card__last-checked">Last checked: ${escapeHtml(lastChecked)}</span>` : "")
    + `</div>${detailsBlock}</div>`;
}

// Empty state with optional action.
function ayEmptyState({ title, body, actionLabel, actionHref } = {}) {
  const icon = `<div class="ay-empty__icon" aria-hidden="true"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8v8"/></svg></div>`;
  const action = actionLabel && actionHref
    ? ayButton({ label: actionLabel, href: actionHref, variant: "secondary" })
    : "";
  return `<div class="ay-empty" role="status">${icon}`
    + `<h3 class="ay-empty__title">${escapeHtml(title || "")}</h3>`
    + (body ? `<p class="ay-empty__body">${escapeHtml(body)}</p>` : "")
    + action
    + `</div>`;
}

// Server-rendered filter tabs as links. tabs: [{label, href, count, active}].
function ayFilterTabs(tabs = [], ariaLabel = "Filter options") {
  const items = tabs.map((tab) => {
    const count = tab.count !== undefined && tab.count > 0
      ? `<span class="ay-filter-tab__count">${escapeHtml(String(tab.count))}</span>`
      : "";
    return `<a class="ay-filter-tab${tab.active ? " ay-filter-tab--active" : ""}" href="${escapeAttr(tab.href || "#")}"${tab.active ? ' aria-current="page"' : ""}>${escapeHtml(tab.label || "")}${count}</a>`;
  }).join("");
  return `<div class="ay-filter-tabs" role="tablist" aria-label="${escapeAttr(ariaLabel)}">${items}</div>`;
}

// "All caught up" banner for the Today page zero-state.
function ayAllClear(title = "All caught up", body = "Nothing needs your attention right now.") {
  return `<div class="ay-all-clear"><h2 class="ay-all-clear__title">${escapeHtml(title)}</h2><p class="ay-all-clear__body">${escapeHtml(body)}</p></div>`;
}

// Inline line icons (Appendix C). 1.5px stroke, currentColor, rounded.
const AY_ICONS = {
  today:         '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  leads:         '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  jobs:          '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>',
  supplier:      '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  installations: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  money:         '<circle cx="12" cy="12" r="10"/><path d="M9.5 9A2.5 2.5 0 0 1 14.5 9c0 1.5-1 2-2 3s-1.5 1.5-1.5 2.5h5"/>',
  finance:       '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  settings:      '<circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>',
  system:        '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
  exports:       '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  more:          '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
  back:          '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>'
};

function ayIcon(name, size = 18) {
  const paths = AY_ICONS[name];
  if (!paths) return "";
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

// Back-to-X link for detail pages (plan 14.1).
function ayBackLink(href, label) {
  return `<a class="ay-back-link" href="${escapeAttr(href)}"><span class="ay-back-link__icon">${ayIcon("back", 16)}</span>${escapeHtml(label)}</a>`;
}

// Today action item card from a commercialActionItems() entry.
const AY_TONE_BADGE = { red: "At risk", amber: "Action", green: "On track", blue: "In progress" };
function ayTodayItemCard(item) {
  const tone = ["red", "amber", "green", "blue"].includes(item.tone) ? item.tone : "amber";
  const meta = [item.postcode, item.reason].filter(Boolean).map((part) => escapeHtml(String(part))).join(" · ");
  const value = item.value ? `<span class="ay-job-card__value">${escapeHtml(formatMoney(item.value))}</span>` : "";
  const action = ayButton({ label: item.nextAction || "Open", href: item.href, variant: "primary", size: "sm" });
  return `<div class="ay-action-card ay-action-card--${tone}">`
    + `<div class="ay-action-card__header"><h3 class="ay-action-card__title">${escapeHtml(item.customer || "")}</h3>${ayBadge({ variant: tone, label: AY_TONE_BADGE[tone] })}</div>`
    + (meta ? `<p class="ay-action-card__meta">${meta}</p>` : "")
    + `<div class="ay-action-card__footer">${value}${action}</div>`
    + `</div>`;
}

// Adapt a systemChecks()/integrationReadiness() entry {label,value,tone,detail}
// to an ay system status card.
const AY_TONE_TO_STATUS = { green: "safe", amber: "warning", red: "action-needed", grey: "not-configured" };
function ayCheckCard(check) {
  return aySystemCard({
    title: check.label,
    description: [check.value, check.detail].filter(Boolean).join(" — ") || check.label,
    status: AY_TONE_TO_STATUS[check.tone] || "not-configured"
  });
}

// Responsive wrapper for a set of system cards.
function aySystemGrid(cards) {
  return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:var(--ay-space-3)">${cards.join("")}</div>`;
}

function leadTable(leads, options = {}) {
  if (!leads.length) return "<p>No leads yet.</p>";
  const selectable = Boolean(options.selectable);
  const state = ensureFinanceState(options.state || {});
  return `<table class="ay-table"><thead><tr>${selectable ? `<th class="select-col"><input id="select-all-leads" type="checkbox" aria-label="Select all leads"></th>` : ""}<th>Received</th><th>Customer</th><th>Stage</th><th>RAG</th><th>Next action</th><th>Money / supplier</th><th>Job</th></tr></thead><tbody>${leads
    .map(
      (lead) => {
        ensureJobFields(lead);
        const finance = jobFinancials(lead, state);
        return `<tr>${selectable ? `<td class="select-col" data-label="Select"><input class="lead-select" name="leadId" type="checkbox" value="${escapeAttr(lead.id)}" aria-label="Select ${escapeAttr(lead.customerName || lead.id)}"></td>` : ""}<td data-label="Received">${escapeHtml(shortDate(lead.receivedAt))}</td><td data-label="Customer"><a href="/leads/${encodeURIComponent(lead.id)}">${escapeHtml(lead.customerName || "Unknown")}</a><br><span class="customer-line">${escapeHtml(lead.customerPhone || lead.customerEmail || "")}</span><br>${escapeHtml(lead.customerPostcode || "")}</td><td data-label="Stage">${workflowBadge(lead.workflow_type)}<br>${escapeHtml(stageLabel(lead))}</td><td data-label="RAG">${ragBadge(lead.operational_risk_level)}<br>${badge(lead.priorityLabel)}</td><td data-label="Next action">${escapeHtml(lead.next_best_action || lead.nextAction || "")}</td><td data-label="Money / supplier">${finance.customerOutstanding ? `${escapeHtml(formatMoney(finance.customerOutstanding))} due<br>` : ""}${escapeHtml(statusLabel(lead.supplier_order_status || ""))}<br>${escapeHtml(statusLabel(lead.supplier_invoice_status || ""))}</td><td class="job-short" data-label="Job">${escapeHtml(String(lead.jobDescription || "").slice(0, 150))}</td></tr>`;
      }
    )
    .join("")}</tbody></table>`;
}

function leadScanCards(leads, state = {}) {
  if (!leads.length) return ayEmptyState({ title: "No leads here", body: "No leads match this view." });
  const financeState = ensureFinanceState(state || {});
  return `<div style="display:flex;flex-direction:column;gap:var(--ay-space-3)">${leads.map((lead) => {
    ensureJobFields(lead);
    const finance = jobFinancials(lead, financeState);
    return ayJobCard({
      customerName: lead.customerName || lead.customerPostcode || lead.id,
      metaParts: [lead.customerPostcode, workflowLabel(lead.workflow_type), lead.customerPhone || lead.customerEmail || "No contact"],
      status: lead.status,
      isAtRisk: (lead.operational_risk_level || "green") === "red",
      value: finance.customerOutstanding ? formatMoney(finance.customerOutstanding) : "",
      primaryLabel: lead.next_best_action || lead.nextAction || "Open job",
      primaryHref: `/leads/${encodeURIComponent(lead.id)}`,
      detailHref: `/leads/${encodeURIComponent(lead.id)}`
    });
  }).join("")}</div>`;
}

function bulkToolbar() {
  return `<section class="bulk-toolbar">
    <label><span>Bulk action</span><select name="bulkAction">
      <option value="archive">Archive selected</option>
      <option value="restore">Restore selected</option>
      <option value="set_status">Move selected to status</option>
      <option value="delete">Delete selected permanently</option>
    </select></label>
    <label><span>Target status</span><select name="targetStatus">${STATUSES.map((status) => `<option ${status === "Awaiting approval" ? "selected" : ""}>${escapeHtml(status)}</option>`).join("")}</select></label>
    <button>Apply to selected</button>
  </section>`;
}

function filterLeads(leads, params) {
  const search = String(params.get("search") || "").toLowerCase();
  return leads.filter((lead) => {
    ensureJobFields(lead);
    if (params.get("status") && String(lead.status || "").toLowerCase() !== params.get("status").toLowerCase()) return false;
    if (params.get("source") && !String(lead.sourcePlatform || "").toLowerCase().includes(params.get("source").toLowerCase())) return false;
    if (params.get("priority") && String(lead.priorityLabel || "").toLowerCase() !== params.get("priority").toLowerCase()) return false;
    if (params.get("quoteDay") && lead.quoteDay !== params.get("quoteDay")) return false;
    if (params.get("quick") && !matchesQuickFilter(lead, params.get("quick"))) return false;
    if (search) {
      const haystack = `${lead.customerName} ${lead.customerPhone} ${lead.customerEmail} ${lead.customerPostcode} ${lead.jobDescription} ${lead.next_best_action} ${lead.workflow_type}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function breakdown(title, leads, keyFn) {
  const counts = new Map();
  for (const lead of leads) counts.set(keyFn(lead), (counts.get(keyFn(lead)) || 0) + 1);
  return `<article><h2>${escapeHtml(title)}</h2>${[...counts.entries()].map(([key, count]) => `<p>${escapeHtml(key)}: <strong>${count}</strong></p>`).join("") || "<p>No data.</p>"}</article>`;
}

function eventList(lead) {
  const items = [
    ["Enquiry received", lead.receivedAt, lead.sourcePlatform],
    ["Reply/draft created", lead.draftReplyCreated || lead.draftReply ? lead.createdAt || lead.receivedAt : "", lead.draftSubject],
    ["Quote sent", lead.quote_sent_at, [lead.quote_reference, lead.quote_amount && formatMoney(lead.quote_amount)].filter(Boolean).join(" / ")],
    ["Quote accepted", lead.quote_accepted_at, [lead.quote_reference, lead.workflow_type].filter(Boolean).join(" / ")],
    ["Deposit requested", lead.deposit_requested_at, lead.deposit_amount && formatMoney(lead.deposit_amount)],
    ["Deposit received", lead.deposit_received_at, [lead.deposit_payment_method, lead.deposit_payment_reference].filter(Boolean).join(" / ")],
    ["Supplier order placed", lead.supplier_order_placed_at, [lead.supplier_name, lead.supplier_order_reference].filter(Boolean).join(" / ")],
    ["Supplier confirmation received", lead.supplier_confirmation_received_at, lead.supplier_confirmation_details || lead.supplier_lead_time_text],
    ["Delivery expected", lead.supplier_estimated_delivery_date || lead.supplier_estimated_delivery_start || lead.supplier_estimated_delivery_end, deliveryText(lead)],
    ["Delivered", lead.supplier_actual_delivery_date, lead.supplier_delivery_status],
    ["Installation booked", lead.installation_scheduled_at, [lead.installation_time_window, lead.installation_assigned_to].filter(Boolean).join(" / ")],
    ["Installation completed", lead.installation_completed_at, ""],
    ["Balance requested", lead.balance_requested_at, lead.balance_amount && formatMoney(lead.balance_amount)],
    ["Balance paid", lead.balance_paid_at, [lead.balance_payment_method, lead.balance_payment_reference].filter(Boolean).join(" / ")],
    ["Review requested", lead.review_requested_at, ""],
    ["Closed", lead.closed_at, ""]
  ].filter(([, value]) => value);
  return `<ul class="timeline">${items.map(([label, value, note]) => `<li><strong>${escapeHtml(label)}</strong><br><span>${escapeHtml(value || "")}</span>${note ? `<br><span class="muted">${escapeHtml(note)}</span>` : ""}</li>`).join("") || "<li>No timeline events yet.</li>"}</ul>`;
}

function actionForms(lead, actions = relevantActions(lead)) {
  if (!actions.length) return "<p>No immediate workflow action needed.</p>";
  return `<div class="inline-actions">${actions.map((action) => actionForm(lead, action)).join("")}</div>`;
}

function actionForm(lead, action) {
  if (action === "generate_customer_update") return `<article><h3>${escapeHtml(actionLabel(action))}</h3><p class="muted">Use the customer update draft below, then copy it into the customer channel manually.</p></article>`;
  if (action === "record_supplier_invoice") return `<article><h3>${escapeHtml(actionLabel(action))}</h3><p class="muted">Record the supplier invoice. Supplier payments can be recorded from Finance or the secondary control below.</p>${supplierInvoiceForm([lead], lead.id)}</article>`;
  const hidden = `<input type="hidden" name="workflowAction" value="${escapeAttr(action)}">`;
  const today = new Date().toISOString().slice(0, 10);
  const fields = {
    mark_quote_sent: `${moneyInput("quote_amount", lead.quote_amount)}${textInput("quote_reference", "Quote reference", lead.quote_reference)}${dateInput("quote_sent_at", today)}`,
    mark_quote_accepted: `${workflowSelect(lead)}${moneyInput("quote_amount", lead.quote_amount)}${textInput("quote_reference", "Quote reference", lead.quote_reference)}${yesNo("deposit_required", lead.deposit_required || "yes", "Deposit required?")}${moneyInput("deposit_amount", lead.deposit_amount)}${yesNo("supplier_order_required", lead.supplier_order_required || "yes", "Supplier order required?")}${textInput("customer_payment_notes", "Customer payment notes", lead.customer_payment_notes)}${dateInput("quote_accepted_at", today)}`,
    request_deposit: `${moneyInput("deposit_amount", lead.deposit_amount)}${dateInput("deposit_requested_at", today)}`,
    mark_deposit_received: `${moneyInput("deposit_amount", lead.deposit_amount)}${selectInput("deposit_payment_method", CUSTOMER_PAYMENT_METHODS, lead.deposit_payment_method || "Unknown")}${dateInput("deposit_received_at", today)}${textInput("deposit_payment_reference", "Payment reference", lead.deposit_payment_reference)}${textInput("deposit_payment_notes", "Payment notes", lead.deposit_payment_notes)}`,
    mark_supplier_order_placed: `${textInput("supplier_name", "Supplier name", lead.supplier_name)}${textInput("supplier_order_reference", "Order reference", lead.supplier_order_reference)}${textareaInput("supplier_order_product_details", "Product / order details", lead.supplier_order_product_details)}${textInput("supplier_order_door_type", "Door type", lead.supplier_order_door_type || lead.garageDoorType)}${textInput("supplier_order_colour_finish", "Colour / finish", lead.supplier_order_colour_finish)}${textInput("supplier_order_size_notes", "Size / spec notes", lead.supplier_order_size_notes)}${textInput("supplier_lead_time_text", "Expected lead time", lead.supplier_lead_time_text)}${dateInput("supplier_estimated_delivery_date", lead.supplier_estimated_delivery_date)}${dateInput("supplier_estimated_delivery_start", lead.supplier_estimated_delivery_start)}${dateInput("supplier_estimated_delivery_end", lead.supplier_estimated_delivery_end)}${yesNo("supplier_confirmation_email_linked", lead.supplier_confirmation_email_linked || "no", "Confirmation email linked?")}${textareaInput("supplier_order_notes", "Supplier order notes", lead.supplier_order_notes)}${dateInput("supplier_order_placed_at", today)}`,
    mark_supplier_confirmation_received: `${textInput("supplier_lead_time_text", "Lead time", lead.supplier_lead_time_text)}${textareaInput("supplier_confirmation_details", "Confirmation details", lead.supplier_confirmation_details)}${yesNo("supplier_confirmation_email_linked", lead.supplier_confirmation_email_linked || "yes", "Confirmation email linked?")}${dateInput("supplier_estimated_delivery_date", lead.supplier_estimated_delivery_date)}${dateInput("supplier_confirmation_received_at", today)}`,
    update_expected_delivery: `${dateInput("supplier_estimated_delivery_date", lead.supplier_estimated_delivery_date)}${dateInput("supplier_estimated_delivery_start", lead.supplier_estimated_delivery_start)}${dateInput("supplier_estimated_delivery_end", lead.supplier_estimated_delivery_end)}${textInput("supplier_lead_time_text", "Lead time text", lead.supplier_lead_time_text)}`,
    mark_delivered: `${dateInput("supplier_actual_delivery_date", today)}`,
    book_installation: `${datetimeInput("installation_scheduled_at", lead.installation_scheduled_at)}${textInput("installation_time_window", "Time window", lead.installation_time_window)}${textInput("installation_assigned_to", "Installer / technician", lead.installation_assigned_to)}${textInput("installation_customer_confirmation_status", "Customer confirmation status", lead.installation_customer_confirmation_status)}${textInput("installation_access_notes", "Access notes", lead.installation_access_notes)}`,
    mark_installation_completed: `${dateInput("installation_completed_at", today)}`,
    request_balance: `${moneyInput("balance_amount", lead.balance_amount || lead.calculated_balance_due)}${dateInput("balance_requested_at", today)}`,
    mark_balance_paid: `${moneyInput("balance_amount", lead.balance_amount || lead.calculated_balance_due)}${selectInput("balance_payment_method", CUSTOMER_PAYMENT_METHODS, lead.balance_payment_method || "Unknown")}${dateInput("balance_paid_at", today)}${textInput("balance_payment_reference", "Payment reference", lead.balance_payment_reference)}${textInput("balance_payment_notes", "Payment notes", lead.balance_payment_notes)}`,
    request_review: `${dateInput("review_requested_at", today)}`,
    close_job: `${dateInput("closed_at", today)}`
  };
  return `<form method="post"><h3>${escapeHtml(actionLabel(action))}</h3>${hidden}${fields[action] || ""}<button>${escapeHtml(actionLabel(action))}</button></form>`;
}

function advancedActionForms(lead, workflow) {
  const all = [
    "mark_quote_sent",
    "mark_quote_accepted",
    "request_deposit",
    "mark_deposit_received",
    "mark_supplier_order_placed",
    "mark_supplier_confirmation_received",
    "update_expected_delivery",
    "mark_delivered",
    "book_installation",
    "mark_installation_completed",
    "request_balance",
    "mark_balance_paid",
    "request_review",
    "close_job"
  ];
  const visible = new Set([...(workflow.visiblePrimaryActions || []), ...(workflow.visibleSecondaryActions || [])]);
  return actionForms(lead, all.filter((action) => !visible.has(action)));
}

function actionLabel(action) {
  return (
    {
      mark_quote_sent: "Mark quote sent",
      mark_quote_accepted: "Mark quote accepted",
      request_deposit: "Request deposit",
      mark_deposit_received: "Mark deposit received",
      mark_supplier_order_placed: "Mark supplier order placed",
      mark_supplier_confirmation_received: "Mark supplier confirmation received",
      update_expected_delivery: "Update expected delivery",
      mark_delivered: "Mark delivered",
      book_installation: "Book installation",
      mark_installation_completed: "Mark installation completed",
      request_balance: "Request balance",
      mark_balance_paid: "Mark balance paid",
      request_review: "Generate review request",
      close_job: "Close job",
      generate_customer_update: "Generate customer update",
      record_supplier_invoice: "Record supplier invoice"
    }[action] || action
  );
}

function todayActionList(leads) {
  if (!leads.length) return "<p class=\"muted\">Nothing urgent today.</p>";
  return `<ul>${leads.map((lead) => `<li>${ragBadge(lead.operational_risk_level)} <a href="/leads/${encodeURIComponent(lead.id)}">${escapeHtml(lead.customerName || lead.customerPostcode || lead.id)}</a> - ${escapeHtml(lead.next_best_action || "")}</li>`).join("")}</ul>`;
}

function dashboardHero(leads, actionsToday, supplierEmails) {
  const active = leads.filter((lead) => !["Archived", "Duplicate", "Lost", "Closed"].includes(lead.status) && !lead.closed_at);
  const red = active.filter((lead) => lead.operational_risk_level === "red").length;
  const amber = active.filter((lead) => lead.operational_risk_level === "amber").length;
  const awaitingDelivery = active.filter((lead) => lead.supplier_confirmation_received_at && !lead.supplier_actual_delivery_date).length;
  const installs = active.filter((lead) => lead.installation_scheduled_at && !lead.installation_completed_at).length;
  const supplierReviews = supplierEmails.filter((email) => email.reviewStatus !== "Linked").length;
  const tiles = [
    ["Active jobs", active.length, "/leads", "green"],
    ["Do today", actionsToday.length, "#today-actions", actionsToday.length ? "amber" : "green"],
    ["Red / urgent", red, "/leads?quick=overdue", red ? "red" : "green"],
    ["Amber watch", amber, "/leads?quick=delivery-due", amber ? "amber" : "green"],
    ["Awaiting delivery", awaitingDelivery, "/leads?quick=awaiting-delivery", awaitingDelivery ? "amber" : "green"],
    ["Installations booked", installs, "/leads?quick=installations", installs ? "green" : "grey"],
    ["Supplier review", supplierReviews, "/supplier-emails", supplierReviews ? "amber" : "green"]
  ];
  return `<section class="overview">${tiles.map(([label, value, href, tone]) => `<a href="${href}" class="overview-tile ${escapeAttr(tone)}"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></a>`).join("")}</section>`;
}

function criticalFocus(leads, actionsToday) {
  const focus = [...actionsToday]
    .sort((a, b) => riskWeightForUi(b.operational_risk_level) - riskWeightForUi(a.operational_risk_level) || String(a.receivedAt).localeCompare(String(b.receivedAt)))
    .slice(0, 6);
  return `<section class="panel"><h2>Technician focus</h2>${
    focus.length
      ? `<div class="focus-list">${focus.map((lead) => `<a class="focus-row" href="/leads/${encodeURIComponent(lead.id)}"><span>${ragBadge(lead.operational_risk_level)}</span><span class="focus-main"><strong>${escapeHtml(lead.customerName || lead.customerPostcode || lead.id)}</strong><span>${escapeHtml([stageLabel(lead), lead.next_best_action || lead.nextAction || ""].filter(Boolean).join(" - "))}</span></span><span class="badge grey">${escapeHtml(lead.customerPostcode || "No postcode")}</span></a>`).join("")}</div>`
      : `<p class="muted">No urgent technician actions. New enquiries and workflow tasks will appear here.</p>`
  }</section>`;
}

function queueCard([label, value, href]) {
  return `<a class="metric-card ${value > 0 ? "active-card" : "quiet-card"}" href="${href}"><strong>${value}</strong><span>${escapeHtml(label)}</span></a>`;
}

function todayActionCards(leads) {
  if (!leads.length) return "<p class=\"muted\">Nothing urgent today.</p>";
  return `<div id="today-actions" class="action-card-grid">${leads
    .map(
      (lead) =>
        `<article class="action-card ${escapeAttr(lead.operational_risk_level || "green")}">
          <div>${ragBadge(lead.operational_risk_level)} ${workflowBadge(lead.workflow_type)}</div>
          <h3><a href="/leads/${encodeURIComponent(lead.id)}">${escapeHtml(lead.customerName || lead.customerPostcode || lead.id)}</a></h3>
          <p><strong>${escapeHtml(lead.next_best_action || "")}</strong></p>
          <p class="muted">${escapeHtml([lead.customerPostcode, lead.customerPhone || lead.customerEmail].filter(Boolean).join(" | "))}</p>
          <a class="button compact-button" href="/leads/${encodeURIComponent(lead.id)}">Open job</a>
        </article>`
    )
    .join("")}</div>`;
}

function pipelineBoard(leads) {
  const columns = [
    ["Enquiry / quote", (lead) => !lead.quote_accepted_at && !lead.closed_at],
    ["Deposit / order", (lead) => lead.quote_accepted_at && !lead.supplier_confirmation_received_at && !lead.supplier_actual_delivery_date && !lead.closed_at],
    ["Delivery / install", (lead) => (lead.supplier_confirmation_received_at || lead.supplier_actual_delivery_date || lead.installation_scheduled_at) && !lead.installation_completed_at && !lead.closed_at],
    ["Payment / close", (lead) => (lead.installation_completed_at || lead.balance_requested_at || lead.balance_paid_at || lead.review_requested_at) && !lead.closed_at]
  ];
  return `<section class="panel"><h2>Pipeline board</h2><div class="pipeline-board">${columns
    .map(([title, predicate]) => {
      const items = leads.filter(predicate).slice(0, 6);
      return `<section class="pipeline-column"><h3>${escapeHtml(title)} <span>${items.length}</span></h3>${items.length ? items.map(jobMiniCard).join("") : `<p class="muted">Nothing here.</p>`}</section>`;
    })
    .join("")}</div></section>`;
}

function jobMiniCard(lead) {
  return `<a class="job-mini-card ${escapeAttr(lead.operational_risk_level || "green")}" href="/leads/${encodeURIComponent(lead.id)}">
    <strong>${escapeHtml(lead.customerName || lead.customerPostcode || lead.id)}</strong>
    <span>${escapeHtml(stageLabel(lead))}</span>
    <small>${escapeHtml(lead.next_best_action || "")}</small>
  </a>`;
}

function workflowRail(lead) {
  const steps = [
    ["Enquiry", lead.receivedAt || lead.draftReplyCreated],
    ["Quote", lead.quote_sent_at],
    ["Accepted", lead.quote_accepted_at],
    ["Deposit", lead.deposit_required === "yes" ? lead.deposit_received_at : lead.quote_accepted_at],
    ["Supplier", lead.supplier_order_required === "yes" ? lead.supplier_order_placed_at : lead.quote_accepted_at],
    ["Delivery", lead.supplier_order_required === "yes" ? lead.supplier_actual_delivery_date || lead.supplier_confirmation_received_at : lead.quote_accepted_at],
    ["Install", lead.installation_completed_at || lead.installation_scheduled_at],
    ["Close", lead.closed_at || lead.balance_paid_at || lead.review_requested_at]
  ];
  const firstPending = steps.findIndex(([, value]) => !value);
  const currentIndex = firstPending === -1 ? steps.length - 1 : firstPending;
  return `<section class="workflow-rail">${steps
    .map(([label, value], index) => {
      const state = value ? "done" : index === currentIndex ? "current" : "pending";
      const detail = value ? shortDate(value) : index === currentIndex ? "Current" : "Pending";
      return `<div class="workflow-step ${state}"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(detail)}</span></div>`;
    })
    .join("")}</section>`;
}

function addressCheckUrl(lead) {
  return lead.addressVerificationUrl || royalMailPostcodeFinderUrl(lead.customerPostcode || lead.customerAddress);
}

function riskWeightForUi(value) {
  return value === "red" ? 3 : value === "amber" ? 2 : 1;
}

function supplierEmailCards(emails, leads) {
  if (!emails.length) return ayEmptyState({ title: "Inbox clear", body: "No supplier emails match this view." });
  const leadNames = new Map(leads.map((lead) => [lead.id, lead.customerName || lead.customerPostcode || lead.id]));
  return `<div>${emails.map((email) => {
    const text = `${email.subject || ""} ${email.rawSummary || ""}`;
    const category = /invoice|statement|proforma|vat|payment|balance/i.test(text)
      ? "Supplier invoice"
      : /delivery|dispatch|despatch|delivered|lead time|eta|confirmation/i.test(text)
        ? "Delivery update"
        : "Supplier message";
    const catBadge = ayBadge({ variant: category === "Supplier invoice" ? "amber" : category === "Delivery update" ? "blue" : "gray", label: category });
    const statusBadge = ayBadge({ variant: email.matchedLeadId ? "green" : "gray", label: email.reviewStatus || "Needs review" });
    const linked = email.matchedLeadId
      ? `<a href="/leads/${encodeURIComponent(email.matchedLeadId)}" style="color:var(--ay-text-link)">${escapeHtml(leadNames.get(email.matchedLeadId) || email.matchedLeadId)}</a>`
      : `<span style="color:var(--ay-amber-text)">Unlinked</span>`;
    return `<div class="ay-inbox-card">
      <div class="ay-inbox-card__header"><span class="ay-inbox-card__sender">${escapeHtml(email.supplierName || email.supplierEmail || "Unknown supplier")}</span><span class="ay-inbox-card__date">${escapeHtml(shortDate(email.receivedAt))}</span></div>
      <p class="ay-inbox-card__subject">${escapeHtml(email.subject || "")}</p>
      <div class="ay-inbox-card__meta"><span class="ay-inbox-card__meta-item">${catBadge} ${statusBadge}</span><span class="ay-inbox-card__meta-item"><strong>Ref:</strong> ${escapeHtml(email.extractedOrderReference || email.invoiceReference || "None")}</span><span class="ay-inbox-card__meta-item"><strong>Job:</strong> ${linked}</span></div>
      <div class="ay-inbox-card__actions">${ayButton({ label: "Review", href: `/supplier-emails/${encodeURIComponent(email.id)}`, variant: "primary", size: "sm" })}</div>
    </div>`;
  }).join("")}</div>`;
}

function supplierEmailTable(emails, leads) {
  if (!emails.length) return "<p>No supplier email records yet.</p>";
  const leadNames = new Map(leads.map((lead) => [lead.id, lead.customerName || lead.customerPostcode || lead.id]));
  return `<table class="ay-table"><thead><tr><th>Received</th><th>Supplier</th><th>Subject</th><th>Order/ref</th><th>Match</th><th>Status</th><th>Action</th></tr></thead><tbody>${emails
    .map((email) => `<tr><td data-label="Received">${escapeHtml(shortDate(email.receivedAt))}</td><td data-label="Supplier">${escapeHtml(email.supplierName || email.supplierEmail || "Unknown")}</td><td data-label="Subject">${escapeHtml(email.subject || "")}<br><span class="muted">${escapeHtml(String(email.rawSummary || "").slice(0, 140))}</span></td><td data-label="Order/ref">${escapeHtml(email.extractedOrderReference || email.invoiceReference || "")}</td><td data-label="Match">${email.matchedLeadId ? `<a href="/leads/${encodeURIComponent(email.matchedLeadId)}">${escapeHtml(leadNames.get(email.matchedLeadId) || email.matchedLeadId)}</a>` : "Unlinked"}<br>${escapeHtml(String(email.matchConfidence || 0))}% ${escapeHtml(email.matchReason || "")}</td><td data-label="Status">${badge(email.reviewStatus || "Needs review")}</td><td data-label="Action"><a class="button compact-button" href="/supplier-emails/${encodeURIComponent(email.id)}">Open</a></td></tr>`)
    .join("")}</tbody></table>`;
}

function filterSupplierEmails(emails, leads, params) {
  const filter = params.get("filter") || "needs-review";
  const supplier = String(params.get("supplier") || "").toLowerCase();
  const date = params.get("date") || "";
  const search = String(params.get("search") || "").toLowerCase();
  const leadNames = new Map((leads || []).map((lead) => [lead.id, `${lead.customerName || ""} ${lead.customerPostcode || ""}`]));
  return (emails || []).filter((email) => {
    const status = String(email.reviewStatus || "Needs review").toLowerCase();
    if (filter === "needs-review" && (status === "linked" || status === "archived" || status === "irrelevant" || status === "duplicate" || status === "reviewed")) return false;
    if (filter === "linked" && !email.matchedLeadId) return false;
    if (filter === "unlinked" && email.matchedLeadId) return false;
    if (filter === "invoice" && !/invoice|statement|proforma|vat|payment|balance/i.test(`${email.subject || ""} ${email.rawSummary || ""}`)) return false;
    if (filter === "delivery" && !/delivery|dispatch|despatch|delivered|lead time|eta|confirmation/i.test(`${email.subject || ""} ${email.rawSummary || ""}`)) return false;
    if (filter === "archived" && !email.archivedAt && status !== "archived") return false;
    if (filter === "duplicate" && status !== "duplicate") return false;
    if (filter === "irrelevant" && status !== "irrelevant") return false;
    if (filter !== "archived" && filter !== "all" && (email.archivedAt || status === "archived")) return false;
    if (supplier && !String(email.supplierName || email.supplierEmail || "").toLowerCase().includes(supplier)) return false;
    if (date && !String(email.receivedAt || "").startsWith(date)) return false;
    if (search) {
      const haystack = `${email.supplierName || ""} ${email.supplierEmail || ""} ${email.subject || ""} ${email.extractedOrderReference || ""} ${email.rawSummary || ""} ${leadNames.get(email.matchedLeadId) || ""}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function matchesQuickFilter(lead, quick) {
  if (quick === "new") return ["New", "Awaiting approval", "Awaiting photos", "Needs call"].includes(lead.status);
  if (quick === "awaiting-approval") return lead.status === "Awaiting approval";
  if (quick === "quotes") return Boolean(lead.quote_sent_at && !lead.quote_accepted_at);
  if (quick === "quotes-to-send") return !lead.quote_sent_at && !lead.quote_accepted_at;
  if (quick === "deposits") return Boolean(lead.quote_accepted_at && lead.deposit_required === "yes" && !lead.deposit_received_at);
  if (quick === "supplier-orders") return Boolean((lead.deposit_received_at || lead.supplier_order_placed_at) && lead.supplier_order_required === "yes" && !lead.supplier_confirmation_received_at);
  if (quick === "awaiting-delivery") return Boolean(lead.supplier_confirmation_received_at && !lead.supplier_actual_delivery_date);
  if (quick === "delivery-due") return deliveryDueSoon(lead) || deliveryOverdue(lead);
  if (quick === "installations") return Boolean(lead.supplier_actual_delivery_date || lead.installation_scheduled_at);
  if (quick === "payments") return Boolean((lead.installation_completed_at || lead.balance_requested_at) && !lead.balance_paid_at);
  if (quick === "overdue") return lead.operational_risk_level === "red";
  if (quick === "repairs") return lead.workflow_type === "repair";
  if (quick === "closed") return ["Archived", "Duplicate", "Lost", "Closed"].includes(lead.status) || Boolean(lead.closed_at);
  return true;
}

function stageLabel(lead) {
  if (lead.job_stage) return lead.job_stage;
  if (lead.closed_at) return "Closed";
  if (lead.review_requested_at) return "Review requested";
  if (lead.balance_paid_at) return "Balance paid";
  if (lead.balance_requested_at) return "Balance requested";
  if (lead.installation_completed_at) return "Installation completed";
  if (lead.installation_scheduled_at) return "Installation booked";
  if (lead.supplier_actual_delivery_date) return "Delivered / ready for install";
  if (lead.supplier_confirmation_received_at) return deliveryOverdue(lead) ? "Delivery overdue" : deliveryDueSoon(lead) ? "Delivery due soon" : "Awaiting delivery";
  if (lead.supplier_order_placed_at) return "Supplier order placed";
  if (lead.deposit_received_at) return "Supplier order to place";
  if (lead.deposit_requested_at) return "Deposit requested";
  if (lead.quote_accepted_at) return "Quote accepted";
  if (lead.quote_sent_at) return "Quote sent";
  return lead.status || "New enquiry";
}

function workflowBadge(value) {
  return ayBadge({ variant: "gray", label: workflowLabel(value) });
}

function workflowLabel(value) {
  return (
    {
      repair: "Repair",
      new_door: "New door",
      replacement_door: "Replacement door",
      upgrade: "Upgrade",
      commercial: "Commercial",
      unknown: "Unknown"
    }[value] || "Unknown"
  );
}

function ragBadge(value) {
  const label = value === "red" ? "Red" : value === "amber" ? "Amber" : "Green";
  const variant = value === "red" ? "red" : value === "amber" ? "amber" : "green";
  return ayBadge({ variant, label });
}

function dateInput(name, value) {
  return `<input name="${escapeAttr(name)}" type="date" value="${escapeAttr(value || "")}">`;
}

function datetimeInput(name, value) {
  const safe = value && String(value).includes("T") ? String(value).slice(0, 16) : value || "";
  return `<input name="${escapeAttr(name)}" type="datetime-local" value="${escapeAttr(safe)}">`;
}

function textInput(name, placeholder, value) {
  return `<input name="${escapeAttr(name)}" placeholder="${escapeAttr(placeholder)}" value="${escapeAttr(value || "")}">`;
}

function labeledInput(name, label, value = "", type = "text", help = "") {
  return `<label><span>${escapeHtml(label)}</span><input name="${escapeAttr(name)}" type="${escapeAttr(type)}" value="${escapeAttr(value || "")}" placeholder="${escapeAttr(label)}">${help ? `<small>${escapeHtml(help)}</small>` : ""}</label>`;
}

function textareaInput(name, placeholder, value) {
  return `<textarea name="${escapeAttr(name)}" placeholder="${escapeAttr(placeholder)}">${escapeHtml(value || "")}</textarea>`;
}

function moneyInput(name, value) {
  return `<input name="${escapeAttr(name)}" placeholder="Amount" value="${escapeAttr(value || "")}">`;
}

function selectInput(name, options, value) {
  return `<select name="${escapeAttr(name)}">${options.map((option) => `<option value="${escapeAttr(option)}" ${option === value ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}</select>`;
}

function yesNo(name, value, label) {
  return `<label>${escapeHtml(label)} <select name="${escapeAttr(name)}"><option value="yes" ${value === "yes" ? "selected" : ""}>Yes</option><option value="no" ${value === "no" ? "selected" : ""}>No</option></select></label>`;
}

function yesNoLabel(value) {
  if (["yes", "true", true].includes(String(value).toLowerCase())) return "Yes";
  if (["no", "false", false].includes(String(value).toLowerCase())) return "No";
  return "Unknown";
}

function statusLabel(value) {
  return String(value || "unknown")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function leadSelect(leads, selected = "") {
  return `<select name="leadId"><option value="">Unlinked / choose job</option>${(leads || []).map((lead) => `<option value="${escapeAttr(lead.id)}" ${lead.id === selected ? "selected" : ""}>${escapeHtml([lead.customerName || lead.id, lead.customerPostcode, stageLabel(lead)].filter(Boolean).join(" - "))}</option>`).join("")}</select>`;
}

function workflowSelect(lead) {
  const options = ["repair", "new_door", "replacement_door", "upgrade", "commercial", "unknown"];
  return `<select name="workflow_type">${options.map((option) => `<option value="${option}" ${option === lead.workflow_type ? "selected" : ""}>${workflowLabel(option)}</option>`).join("")}</select>`;
}

function buttonForm(action, label) {
  return `<form method="post" action="${action}" style="display:inline"><button>${escapeHtml(label)}</button></form>`;
}

function countStatus(leads, status) {
  return leads.filter((lead) => lead.status === status).length;
}

function overdue(leads) {
  const today = new Date().toISOString().slice(0, 10);
  return leads.filter((lead) => lead.followUpDate && lead.followUpDate < today && !["Replied", "Won", "Lost", "Archived", "Duplicate"].includes(lead.status));
}

function findLead(store, pathname) {
  const id = decodeURIComponent(pathname.split("/").filter(Boolean)[1] || "");
  return (store.state.leads || []).find((lead) => lead.id === id);
}

function findSupplierEmail(store, pathname) {
  const id = decodeURIComponent(pathname.split("/").filter(Boolean)[1] || "");
  return (store.state.supplierEmails || []).find((email) => email.id === id);
}

function findSupplierInvoice(store, pathname) {
  const id = decodeURIComponent(pathname.split("/").filter(Boolean)[2] || "");
  return (store.state.supplierInvoices || []).find((invoice) => invoice.id === id);
}

function findCustomerPayment(store, pathname) {
  const id = decodeURIComponent(pathname.split("/").filter(Boolean)[2] || "");
  return (store.state.customerPayments || []).find((payment) => payment.id === id);
}

function findSupplierPayment(store, pathname) {
  const id = decodeURIComponent(pathname.split("/").filter(Boolean)[2] || "");
  return (store.state.supplierPayments || []).find((payment) => payment.id === id);
}

function findCustomerInvoice(store, pathname) {
  const id = decodeURIComponent(pathname.split("/").filter(Boolean)[1] || "");
  return (store.state.customerInvoices || []).find((invoice) => invoice.invoice_id === id || invoice.invoice_number === id);
}

function findWorkOrder(store, pathname) {
  const id = decodeURIComponent(pathname.split("/").filter(Boolean)[1] || "");
  return (store.state.workOrders || []).find((order) => order.id === id);
}

function recalculateSupplierInvoices(state, invoiceIds = []) {
  ensureFinanceState(state);
  const ids = new Set(invoiceIds.filter(Boolean));
  for (const invoice of state.supplierInvoices || []) {
    if (ids.has(invoice.id)) applySupplierPayment(invoice, state);
  }
}

function updateInvoiceFromForm(invoice, form, settings = {}) {
  Object.assign(invoice, {
    invoice_type: form.invoice_type || invoice.invoice_type,
    customer_name: form.customer_name || invoice.customer_name,
    customer_email: form.customer_email || invoice.customer_email,
    customer_phone: form.customer_phone || invoice.customer_phone,
    customer_billing_address: form.customer_billing_address || invoice.customer_billing_address,
    customer_postcode: form.customer_postcode || invoice.customer_postcode,
    invoice_date: form.invoice_date || invoice.invoice_date,
    supply_date: form.supply_date || invoice.supply_date,
    due_date: form.due_date || invoice.due_date,
    payment_terms: form.payment_terms || invoice.payment_terms,
    status: INVOICE_STATUSES.includes(form.status) ? form.status : invoice.status,
    payment_instructions: form.payment_instructions || invoice.payment_instructions,
    notes: form.notes || "",
    amount_paid: money(form.amount_paid || invoice.amount_paid)
  });
  const lineItems = [{
    description: form.description || safeInvoiceItems(invoice)[0]?.description || "Garage door works",
    quantity: form.quantity || safeInvoiceItems(invoice)[0]?.quantity || 1,
    unit_price_net: form.unit_price_net || safeInvoiceItems(invoice)[0]?.unit_price_net || 0,
    vat_rate: settings.defaultVatRate
  }];
  const normalised = lineItems.map((item) => {
    const quantity = money(item.quantity) || 1;
    const unit = money(item.unit_price_net);
    const vatRate = settings.vatRegistered ? money(item.vat_rate) : 0;
    const net = money(quantity * unit);
    const vat = money(net * (vatRate / 100));
    return { description: item.description, quantity, unit_price_net: unit, vat_rate: vatRate, net_total: net, vat_total: vat, gross_total: money(net + vat) };
  });
  const totals = calculateInvoiceTotals(normalised, settings);
  Object.assign(invoice, {
    line_items_json: JSON.stringify(normalised),
    subtotal_net: totals.subtotalNet,
    vat_rate: settings.vatRegistered ? totals.primaryVatRate : 0,
    vat_amount: totals.vatAmount,
    total_gross: totals.totalGross,
    amount_outstanding: Math.max(totals.totalGross - invoice.amount_paid, 0)
  });
  return invoice;
}

function integrationReadiness(config, store) {
  const state = ensureOperationsState(store.state || {}, config);
  const settings = state.companySettings || {};
  const setupWarnings = companySetupWarnings(settings);
  const messaging = messagingStatus(config);
  const cal = calendarReadiness(config);
  const technician = (state.technicians || []).find((item) => item.active !== false);
  return [
    { label: "Company details", value: setupWarnings.some((item) => /company|office/i.test(item)) ? "Check" : "Ready", tone: setupWarnings.some((item) => /company|office/i.test(item)) ? "amber" : "green", detail: setupWarnings.find((item) => /company|office/i.test(item)) || "Company details complete" },
    { label: "VAT settings", value: settings.vatRegistered ? settings.vatRegistrationNumber ? "Ready" : "Missing VAT" : "Not VAT registered", tone: settings.vatRegistered && !settings.vatRegistrationNumber ? "red" : "green", detail: settings.vatRegistered ? "VAT will show on invoices" : "VAT disabled by default" },
    { label: "Bank details", value: settings.bankAccountName && settings.sortCode && settings.accountNumber ? "Ready" : "Missing", tone: settings.bankAccountName && settings.sortCode && settings.accountNumber ? "green" : "amber", detail: "Required before issuing real invoices" },
    { label: "Invoice numbering", value: settings.invoicePrefix ? "Ready" : "Check", tone: settings.invoicePrefix ? "green" : "amber", detail: `${settings.invoicePrefix || "No prefix"} next ${settings.nextInvoiceNumber || 1}` },
    { label: "Technician", value: technician ? "Added" : "Missing", tone: technician ? "green" : "amber", detail: technician ? technician.name : "Add technician/mobile number" },
    { label: "Email sending", value: messaging.email.enabled ? "Enabled" : "Disabled", tone: messaging.email.enabled ? messaging.email.configured ? "amber" : "red" : "green", detail: messaging.email.enabled ? (messaging.email.configured ? "SMTP configured" : "SMTP password missing") : "Preview/copy only" },
    { label: "SMS", value: messaging.sms.enabled ? "Enabled" : "Disabled", tone: messaging.sms.enabled ? messaging.sms.configured ? "amber" : "red" : "green", detail: messaging.sms.enabled ? (messaging.sms.configured ? "Twilio configured" : "Twilio credentials missing") : "Preview/copy only" },
    { label: "WhatsApp", value: messaging.whatsapp.enabled ? "Enabled" : "Disabled", tone: messaging.whatsapp.enabled ? messaging.whatsapp.configured ? "amber" : "red" : "green", detail: messaging.whatsapp.enabled ? (messaging.whatsapp.configured ? "Check approved templates" : "Twilio WhatsApp missing") : "Manual wa.me fallback" },
    { label: "Calendar", value: cal.status === "ready" ? "Ready" : "ICS", tone: cal.status === "warning" ? "amber" : "green", detail: cal.warning || "CalDAV ready" },
    { label: "Auto send", value: config.autoSend ? "Enabled" : "Disabled", tone: config.autoSend ? "red" : "green", detail: config.autoSend ? "Human-approved send workflows can run" : "No automatic sending" }
  ];
}

function filterWorkOrders(workOrders, filter) {
  const now = new Date();
  return (workOrders || []).filter((order) => {
    if (filter === "today") return sameUiDay(order.scheduled_start, now) && order.status !== "completed";
    if (filter === "tomorrow") return sameUiDay(order.scheduled_start, addUiDays(now, 1)) && order.status !== "completed";
    if (filter === "week") return isUiNextDays(order.scheduled_start, 7, now) && order.status !== "completed";
    if (filter === "unscheduled") return !order.scheduled_start || order.status === "unscheduled";
    if (filter === "completed") return order.status === "completed";
    return true;
  }).sort((a, b) => String(a.scheduled_start || "").localeCompare(String(b.scheduled_start || "")));
}

function technicianName(state, id) {
  return ((state.technicians || []).find((item) => item.id === id) || {}).name || "";
}

function safeInvoiceItems(invoice) {
  try {
    const parsed = JSON.parse(invoice.line_items_json || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function dateTimeLabel(value) {
  return value ? String(value).replace("T", " ").slice(0, 16) : "Unscheduled";
}

function isPastDate(value) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
}

function sameUiDay(value, target) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString().slice(0, 10) === new Date(target).toISOString().slice(0, 10);
}

function isUiNextDays(value, days, now) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + days + 1);
  return date >= start && date < end;
}

function addUiDays(value, days) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function escapeHeader(value) {
  return String(value || "").replace(/["\r\n]/g, "");
}

function addCustomerPaymentIfNew(store, payment) {
  ensureFinanceState(store.state);
  const existing = (store.state.customerPayments || []).find((item) => item.leadId === payment.leadId && item.paymentType === payment.paymentType && item.paymentDate === payment.paymentDate && money(item.amount) === money(payment.amount));
  if (!existing) store.state.customerPayments.push(payment);
}

function nextActionForStatus(status, lead) {
  if (status === "Archived") return "Archived";
  if (status === "Awaiting approval") return lead.draftReply ? "Review draft reply" : "Review lead";
  if (status === "Needs call") return "Call customer";
  if (status === "Awaiting photos") return "Ask for missing details/photos";
  if (status === "Quote booked") return "Prepare quote visit";
  if (status === "Follow-up due") return "Follow up customer";
  if (status === "Won") return "Continue job workflow";
  if (status === "Lost") return "No further action";
  return lead.nextAction || lead.next_best_action || "Review lead";
}

function authorised(req, config) {
  if (!config.adminUsername || !config.adminPassword) return true;
  return verifySession(req.headers.cookie || "", config);
}

function authChallenge(res, next = "/today") {
  redirect(res, `/login?next=${encodeURIComponent(next || "/today")}`);
}

function sessionSecret(config) {
  return config.adminPassword || "no-auth";
}

function signSession(username, secret) {
  const payload = Buffer.from(JSON.stringify({ u: username, t: Math.floor(Date.now() / 1000) })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifySession(cookieHeader, config) {
  if (!config.adminUsername || !config.adminPassword) return true;
  const token = parseCookies(cookieHeader)[COOKIE_NAME];
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot === -1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = crypto.createHmac("sha256", sessionSecret(config)).update(payload).digest("hex");
  if (sig.length !== expectedSig.length) return false;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expectedSig, "hex"))) return false;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const age = Math.floor(Date.now() / 1000) - (data.t || 0);
    return age >= 0 && age < SESSION_EXPIRY_SECONDS && data.u === config.adminUsername;
  } catch {
    return false;
  }
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const part of String(cookieHeader || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies;
}

function timingSafeStrEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function handleLogin(req, res, config) {
  const form = await readForm(req);
  const username = String(form.username || "");
  const password = String(form.password || "");
  const next = safeNextPath(form.next || "/today");
  const valid = timingSafeStrEqual(username, config.adminUsername || "") && timingSafeStrEqual(password, config.adminPassword || "");
  if (!valid) return html(res, loginPage(next, "Login failed. Check the username and password."), 401);
  const token = signSession(config.adminUsername, sessionSecret(config));
  res.writeHead(303, {
    location: next,
    "set-cookie": `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_EXPIRY_SECONDS}`
  });
  res.end();
}

function handleLogout(res) {
  res.writeHead(303, {
    location: "/login",
    "set-cookie": `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
  });
  res.end();
}

function safeNextPath(value) {
  const next = String(value || "/today");
  return next.startsWith("/") && !next.startsWith("//") ? next : "/today";
}

function loginPage(next = "/today", error = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title><style>${appStyles()}</style></head><body class="login-screen"><main class="login-wrap"><section class="login-card"><div class="brand-mark"><strong>ADY</strong><span>Autodoors Yorkshire</span></div><h1>Sign in</h1><p class="page-subtitle">Use the dashboard login details to access live customer and finance data.</p>${error ? `<p class="warning-card red">${escapeHtml(error)}</p>` : ""}<form method="post" action="/login" class="stacked-form"><input type="hidden" name="next" value="${escapeAttr(safeNextPath(next))}"><label><span>Username</span><input name="username" autocomplete="username" required autofocus></label><label><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form></section></main></body></html>`;
}

async function readForm(req) {
  const body = (await readBodyBuffer(req)).toString("utf8");
  const form = {};
  for (const [key, value] of new URLSearchParams(body)) {
    if (form[key] === undefined) form[key] = value;
    else if (Array.isArray(form[key])) form[key].push(value);
    else form[key] = [form[key], value];
  }
  return form;
}

function arrayValue(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function html(res, content, status = 200) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(content);
}

function json(res, status, content) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(content));
}

function redirect(res, location) {
  res.writeHead(303, { location });
  res.end();
}

function badge(value) {
  const safe = escapeHtml(value || "");
  return `<span class="badge ${safe}">${safe}</span>`;
}

function shortDate(value) {
  return value ? String(value).replace("T", " ").slice(0, 16) : "";
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

module.exports = { startAppServer, prepareLead, STATUSES };
