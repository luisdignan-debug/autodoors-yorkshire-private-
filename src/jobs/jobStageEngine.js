const CLOSED_STATUSES = new Set(["Archived", "Duplicate", "Lost", "Closed"]);
const { calculateJobFinancials } = require("../financialCalculations");

const JOB_FIELD_DEFAULTS = {
  workflow_type: "",
  job_stage: "",
  quote_status: "",
  quote_sent_at: "",
  quote_amount: "",
  quote_reference: "",
  quote_accepted_at: "",
  deposit_required: "",
  deposit_status: "",
  deposit_amount: "",
  deposit_requested_at: "",
  deposit_received_at: "",
  deposit_payment_method: "",
  deposit_payment_reference: "",
  deposit_payment_notes: "",
  supplier_order_required: "",
  supplier_order_status: "",
  supplier_name: "",
  supplier_order_reference: "",
  supplier_order_placed_at: "",
  supplier_order_product_details: "",
  supplier_order_door_type: "",
  supplier_order_colour_finish: "",
  supplier_order_size_notes: "",
  supplier_order_notes: "",
  supplier_confirmation_received_at: "",
  supplier_confirmation_details: "",
  supplier_confirmation_email_linked: "",
  supplier_estimated_delivery_start: "",
  supplier_estimated_delivery_end: "",
  supplier_estimated_delivery_date: "",
  supplier_lead_time_text: "",
  supplier_actual_delivery_date: "",
  supplier_delivery_status: "",
  supplier_delivery_confidence: "",
  supplier_invoice_status: "",
  installation_booking_status: "",
  installation_scheduled_at: "",
  installation_time_window: "",
  installation_assigned_to: "",
  installation_access_notes: "",
  installation_customer_confirmation_status: "",
  installation_completed_at: "",
  balance_amount: "",
  balance_requested_at: "",
  balance_paid_at: "",
  balance_payment_method: "",
  balance_payment_reference: "",
  balance_payment_notes: "",
  agreed_final_amount: "",
  customer_payment_status: "",
  customer_payment_notes: "",
  review_requested_at: "",
  closed_at: "",
  customer_update_due: "",
  next_best_action: "",
  operational_risk_level: "green"
};

function ensureJobFields(lead, now = new Date()) {
  for (const [key, value] of Object.entries(JOB_FIELD_DEFAULTS)) {
    if (lead[key] === undefined || lead[key] === null) lead[key] = value;
  }
  if (!lead.workflow_type) lead.workflow_type = inferWorkflowType(lead);
  if (!lead.quote_status) lead.quote_status = lead.status === "Quoted" || lead.quote_sent_at ? "sent" : "";
  if (!lead.supplier_order_required) lead.supplier_order_required = supplierOrderUsuallyRequired(lead) ? "yes" : "no";
  if (!lead.deposit_required && supplierOrderUsuallyRequired(lead)) lead.deposit_required = "yes";
  applyDerivedStatusFields(lead, now);
  const workflow = evaluateWorkflow(lead, now, { prepared: true });
  lead.job_stage = workflow.currentStage;
  lead.next_best_action = workflow.nextBestAction;
  lead.nextAction = lead.next_best_action || lead.nextAction || "";
  lead.customer_update_due = customerUpdateDue(lead, now) ? "yes" : lead.customer_update_due === "yes" ? "yes" : "";
  lead.operational_risk_level = workflow.riskLevel || calculateOperationalRisk(lead, now);
  return lead;
}

function inferWorkflowType(lead) {
  const text = leadText(lead);
  if (/\b(commercial|industrial|shutter|roller shutter|steel security|security door|shop front)\b/i.test(text)) return "commercial";
  if (/\b(upgrade|convert|automation|automate|motor|electric operator|remote)\b/i.test(text) && !/\bnew|replace|replacement\b/i.test(text)) return "upgrade";
  if (/\b(replace|replacement|remove existing|old door|swap)\b/i.test(text)) return "replacement_door";
  if (/\b(new door|new garage door|install|installation|supply and fit|sectional|roller door|up and over)\b/i.test(text)) return "new_door";
  if (/\b(repair|broken|fault|stuck|spring|cable|service|maintenance|insecure|not working|jammed|door dropped)\b/i.test(text)) return "repair";
  return "unknown";
}

function supplierOrderUsuallyRequired(lead) {
  return ["new_door", "replacement_door", "commercial"].includes(lead.workflow_type || inferWorkflowType(lead));
}

function calculateNextBestAction(lead, now = new Date()) {
  return evaluateWorkflow(lead, now).nextBestAction;
}

function evaluateWorkflow(lead, now = new Date(), options = {}) {
  if (!options.prepared) ensureJobFields(lead, now);
  const workflowType = lead.workflow_type || inferWorkflowType(lead);
  const isRepair = workflowType === "repair" || workflowType === "upgrade";
  const supplierRequired = isYes(lead.supplier_order_required);
  const depositRequired = isYes(lead.deposit_required);
  const finance = calculateJobFinancials(lead, options.financeState || {}, now);
  const primary = [];
  const secondary = [];
  const hidden = completedActions(lead);
  let currentStage = "New enquiry";
  let nextBestAction = "Review job";
  let reason = "Review the lead and choose the next customer journey step.";

  if (CLOSED_STATUSES.has(lead.status) || lead.closed_at) {
    currentStage = lead.closed_at ? "Closed" : lead.status || "Closed";
    nextBestAction = "No action needed";
    reason = "This lead is closed, archived, duplicate, or lost.";
    return workflowResult(lead, currentStage, nextBestAction, primary, secondary, hidden, "green", reason, now);
  }

  if (!lead.draftReply && !lead.quote_sent_at && !lead.quote_accepted_at) {
    currentStage = "Reply needed";
    nextBestAction = "Review enquiry and draft reply";
    primary.push("mark_quote_sent", "mark_quote_accepted");
    reason = "The enquiry has not yet moved into the quote workflow.";
    return workflowResult(lead, currentStage, nextBestAction, primary, secondary, hidden, calculateOperationalRisk(lead, now), reason, now);
  }

  if (!lead.quote_sent_at && !lead.quote_accepted_at) {
    currentStage = isRepair ? "Quote or visit needed" : "Site survey or quote needed";
    nextBestAction = isRepair ? "Send repair quote or book visit" : "Send quote or book site survey";
    primary.push("mark_quote_sent", "mark_quote_accepted");
    reason = "No quote has been sent or accepted yet.";
    return workflowResult(lead, currentStage, nextBestAction, primary, secondary, hidden, calculateOperationalRisk(lead, now), reason, now);
  }

  if (lead.quote_sent_at && !lead.quote_accepted_at) {
    currentStage = "Quote sent";
    nextBestAction = quoteFollowUpDue(lead, now) ? "Chase quote decision" : "Wait for customer quote decision";
    primary.push("mark_quote_accepted");
    reason = quoteFollowUpDue(lead, now) ? "The quote is old enough to chase." : "The customer has not accepted the quote yet.";
    return workflowResult(lead, currentStage, nextBestAction, primary, secondary, hidden, calculateOperationalRisk(lead, now), reason, now);
  }

  if (lead.quote_accepted_at && depositRequired && !lead.deposit_requested_at && !lead.deposit_received_at) {
    currentStage = "Quote accepted";
    nextBestAction = "Request deposit";
    primary.push("request_deposit", "mark_deposit_received");
    reason = "Quote accepted, deposit required, and no deposit has been requested or received.";
    return workflowResult(lead, currentStage, nextBestAction, primary, secondary, hidden, "amber", reason, now);
  }

  if (depositRequired && lead.deposit_requested_at && !lead.deposit_received_at) {
    currentStage = "Deposit requested";
    nextBestAction = "Record deposit when received";
    primary.push("mark_deposit_received");
    reason = "Deposit has been requested but not recorded as received.";
    return workflowResult(lead, currentStage, nextBestAction, primary, secondary, hidden, calculateOperationalRisk(lead, now), reason, now);
  }

  if (lead.quote_accepted_at && !depositRequired && supplierRequired && !lead.supplier_order_placed_at) {
    currentStage = "Quote accepted";
    nextBestAction = "Place supplier order";
    primary.push("mark_supplier_order_placed");
    reason = "No deposit is required and a supplier order is required but not placed.";
    return workflowResult(lead, currentStage, nextBestAction, primary, secondary, hidden, "amber", reason, now);
  }

  if ((lead.deposit_received_at || !depositRequired) && supplierRequired && !lead.supplier_order_placed_at) {
    currentStage = lead.deposit_received_at ? "Deposit received" : "Quote accepted";
    nextBestAction = "Place supplier order";
    primary.push("mark_supplier_order_placed");
    reason = "Deposit has been received and a supplier order is required but has not been placed.";
    return workflowResult(lead, currentStage, nextBestAction, primary, secondary, hidden, "amber", reason, now);
  }

  if (lead.supplier_order_placed_at && !lead.supplier_confirmation_received_at) {
    currentStage = "Supplier order placed";
    nextBestAction = "Await or link supplier confirmation";
    primary.push("mark_supplier_confirmation_received");
    secondary.push("update_expected_delivery", "record_supplier_invoice");
    reason = "The supplier order exists but confirmation has not been recorded.";
    return workflowResult(lead, currentStage, nextBestAction, primary, secondary, hidden, calculateOperationalRisk(lead, now), reason, now);
  }

  if (lead.supplier_confirmation_received_at && !lead.supplier_actual_delivery_date) {
    currentStage = "Awaiting delivery";
    nextBestAction = deliveryDueSoon(lead, now) ? "Check delivery and update customer" : "Monitor supplier delivery";
    primary.push("update_expected_delivery", "mark_delivered");
    secondary.push("generate_customer_update", "record_supplier_invoice");
    reason = "Supplier confirmation is recorded and the item has not been marked delivered.";
    return workflowResult(lead, currentStage, nextBestAction, primary, secondary, hidden, calculateOperationalRisk(lead, now), reason, now);
  }

  if ((lead.supplier_actual_delivery_date || (!supplierRequired && lead.quote_accepted_at && (!depositRequired || lead.deposit_received_at))) && !lead.installation_scheduled_at) {
    currentStage = supplierRequired ? "Delivered / ready for install" : isRepair ? "Visit or repair booking needed" : "Installation booking needed";
    nextBestAction = isRepair ? "Book repair visit" : "Book installation";
    primary.push("book_installation");
    reason = supplierRequired ? "The ordered item is ready and the installation is not booked." : "Supplier order is not required, so the next step is booking the work.";
    return workflowResult(lead, currentStage, nextBestAction, primary, secondary, hidden, calculateOperationalRisk(lead, now), reason, now);
  }

  if (lead.installation_scheduled_at && !lead.installation_completed_at) {
    currentStage = isRepair ? "Repair booked" : "Installation booked";
    nextBestAction = isRepair ? "Mark repair completed" : "Mark installation completed";
    primary.push("mark_installation_completed");
    secondary.push("generate_customer_update");
    reason = "The job is booked but not completed.";
    return workflowResult(lead, currentStage, nextBestAction, primary, secondary, hidden, calculateOperationalRisk(lead, now), reason, now);
  }

  if ((lead.installation_completed_at || isRepairCompleted(lead)) && finance.customer_amount_outstanding > 0) {
    currentStage = isRepair ? "Repair completed" : "Installation completed";
    nextBestAction = lead.balance_requested_at ? "Record or chase balance payment" : "Request balance";
    if (!lead.balance_requested_at) primary.push("request_balance");
    primary.push("mark_balance_paid");
    reason = `The work is complete and the calculated customer balance is outstanding.`;
    return workflowResult(lead, currentStage, nextBestAction, primary, secondary, hidden, calculateOperationalRisk(lead, now), reason, now);
  }

  if ((lead.installation_completed_at || lead.balance_paid_at || isRepairCompleted(lead)) && finance.customer_amount_outstanding <= 0 && !lead.review_requested_at) {
    currentStage = lead.balance_paid_at ? "Balance paid" : "Payment complete";
    nextBestAction = "Generate review request";
    primary.push("request_review");
    reason = "The calculated customer balance is clear and the review request has not been logged.";
    return workflowResult(lead, currentStage, nextBestAction, primary, secondary, hidden, "green", reason, now);
  }

  if (lead.review_requested_at && !lead.closed_at) {
    currentStage = "Review requested";
    nextBestAction = "Close job when finished";
    primary.push("close_job");
    reason = "The review request is complete and the job can be closed when appropriate.";
    return workflowResult(lead, currentStage, nextBestAction, primary, secondary, hidden, "green", reason, now);
  }

  return workflowResult(lead, currentStage, nextBestAction, primary, secondary, hidden, calculateOperationalRisk(lead, now), reason, now);
}

function workflowResult(lead, currentStage, nextBestAction, primary, secondary, hidden, riskLevel, reason) {
  const visiblePrimaryActions = unique(primary).filter((action) => !hidden.includes(action));
  const visibleSecondaryActions = unique(secondary).filter((action) => !hidden.includes(action) && !visiblePrimaryActions.includes(action));
  return {
    currentStage,
    nextBestAction,
    visiblePrimaryActions,
    visibleSecondaryActions,
    hiddenCompletedActions: hidden,
    riskLevel,
    reason
  };
}

function applyDerivedStatusFields(lead) {
  const depositRequired = isYes(lead.deposit_required);
  const supplierRequired = isYes(lead.supplier_order_required);
  lead.deposit_status = !depositRequired
    ? "not_required"
    : lead.deposit_received_at
      ? "received"
      : lead.deposit_requested_at
        ? "requested"
        : "required_not_requested";
  lead.supplier_order_status = !supplierRequired
    ? "not_required"
    : lead.supplier_actual_delivery_date
      ? "delivered_ready_for_install"
      : lead.supplier_confirmation_received_at
        ? "confirmed_awaiting_delivery"
        : lead.supplier_order_placed_at
          ? "placed_waiting_confirmation"
          : "required_not_placed";
  if (!lead.supplier_invoice_status) lead.supplier_invoice_status = supplierRequired ? "not_received" : "not_required";
  lead.customer_payment_status = customerPaymentStatus(lead);
}

function customerPaymentStatus(lead) {
  if (!lead.quote_sent_at && !lead.quote_accepted_at) return "no_quote_yet";
  if (lead.balance_paid_at) return "paid_in_full";
  if (lead.balance_requested_at) return "balance_due";
  if (lead.deposit_received_at) return "deposit_paid";
  if (lead.deposit_requested_at) return "deposit_requested";
  if (lead.quote_accepted_at) return "quote_accepted";
  if (lead.quote_sent_at) return "quote_sent";
  return "no_quote_yet";
}

function completedActions(lead) {
  const completed = [];
  if (lead.quote_sent_at) completed.push("mark_quote_sent");
  if (lead.quote_accepted_at) completed.push("mark_quote_accepted");
  if (lead.deposit_requested_at || lead.deposit_received_at || lead.deposit_required !== "yes") completed.push("request_deposit");
  if (lead.deposit_received_at || lead.deposit_required !== "yes") completed.push("mark_deposit_received");
  if (lead.supplier_order_placed_at || lead.supplier_order_required !== "yes") completed.push("mark_supplier_order_placed");
  if (lead.supplier_confirmation_received_at || lead.supplier_order_required !== "yes") completed.push("mark_supplier_confirmation_received");
  if (lead.supplier_actual_delivery_date || lead.supplier_order_required !== "yes") completed.push("update_expected_delivery", "mark_delivered");
  if (lead.installation_scheduled_at) completed.push("book_installation");
  if (lead.installation_completed_at) completed.push("mark_installation_completed");
  if (lead.balance_requested_at || lead.balance_paid_at) completed.push("request_balance");
  if (lead.balance_paid_at) completed.push("mark_balance_paid");
  if (lead.review_requested_at) completed.push("request_review");
  if (lead.closed_at) completed.push("close_job");
  return unique(completed);
}

function isYes(value) {
  return ["yes", "true", true].includes(String(value).toLowerCase());
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function legacyNextBestAction(lead, now = new Date()) {
  if (CLOSED_STATUSES.has(lead.status) || lead.closed_at) return "No action needed";
  const workflowType = lead.workflow_type || inferWorkflowType(lead);
  const isRepair = workflowType === "repair" || workflowType === "upgrade";

  if (!lead.draftReply && !lead.quote_sent_at && !lead.quote_accepted_at) return "Review enquiry and draft reply";
  if (!lead.quote_sent_at && !lead.quote_accepted_at) return isRepair ? "Send repair quote or book visit" : "Send quote or book site survey";
  if (lead.quote_sent_at && !lead.quote_accepted_at) return quoteFollowUpDue(lead, now) ? "Chase quote decision" : "Wait for customer quote decision";
  if (lead.quote_accepted_at && lead.deposit_required === "yes" && !lead.deposit_requested_at) return "Request deposit";
  if (lead.deposit_requested_at && lead.deposit_required === "yes" && !lead.deposit_received_at) return "Wait for deposit";
  if (lead.quote_accepted_at && !lead.deposit_received_at && lead.deposit_required !== "yes") return isRepair ? "Book repair visit" : "Book installation or place supplier order";
  if (lead.deposit_received_at && lead.supplier_order_required === "yes" && !lead.supplier_order_placed_at) return "Place supplier order";
  if (lead.supplier_order_placed_at && !lead.supplier_confirmation_received_at) return "Check supplier confirmation";
  if (lead.supplier_confirmation_received_at && !lead.supplier_actual_delivery_date) {
    if (deliveryDueSoon(lead, now)) return "Check delivery and update customer";
    return "Monitor supplier delivery";
  }
  if (lead.supplier_actual_delivery_date && !lead.installation_scheduled_at) return "Book installation";
  if (lead.installation_scheduled_at && !lead.installation_completed_at) return "Complete installation";
  if ((lead.installation_completed_at || isRepairCompleted(lead)) && !lead.balance_requested_at) return "Request balance/payment";
  if (lead.balance_requested_at && !lead.balance_paid_at) return "Chase balance/payment";
  if (lead.balance_paid_at && !lead.review_requested_at) return "Ask for review";
  if (lead.review_requested_at && !lead.closed_at) return "Close job when finished";
  return lead.nextAction || "Review job";
}

function calculateOperationalRisk(lead, now = new Date()) {
  if (CLOSED_STATUSES.has(lead.status) || lead.closed_at || lead.balance_paid_at) return "green";
  if (lead.urgency === "Urgent" || lead.priorityLabel === "High") {
    if (!lead.quote_sent_at && !lead.quote_accepted_at) return "red";
  }
  if (customerUpdateDue(lead, now)) return "red";
  if (deliveryOverdue(lead, now)) return "red";
  if (lead.balance_requested_at && ageInDays(lead.balance_requested_at, now) > 7 && !lead.balance_paid_at) return "red";
  if (quoteFollowUpDue(lead, now)) return "amber";
  if (deliveryDueSoon(lead, now)) return "amber";
  if (lead.supplier_order_placed_at && !lead.supplier_confirmation_received_at && ageInDays(lead.supplier_order_placed_at, now) > 3) return "amber";
  return "green";
}

function queueCounts(leads, supplierEmails = [], now = new Date()) {
  const prepared = leads.map((lead) => ensureJobFields(lead, now));
  return {
    newEnquiries: prepared.filter((lead) => !closed(lead) && ["New", "Awaiting approval", "Awaiting photos", "Needs call"].includes(lead.status)).length,
    quotesToSend: prepared.filter((lead) => !closed(lead) && !lead.quote_sent_at && !lead.quote_accepted_at).length,
    quotesAwaitingDecision: prepared.filter((lead) => !closed(lead) && lead.quote_sent_at && !lead.quote_accepted_at).length,
    acceptedNeedDeposit: prepared.filter((lead) => !closed(lead) && lead.quote_accepted_at && lead.deposit_required === "yes" && !lead.deposit_requested_at).length,
    depositsOrderSupplier: prepared.filter((lead) => !closed(lead) && lead.deposit_received_at && lead.supplier_order_required === "yes" && !lead.supplier_order_placed_at).length,
    supplierAwaitingConfirmation: prepared.filter((lead) => !closed(lead) && lead.supplier_order_placed_at && !lead.supplier_confirmation_received_at).length,
    awaitingDelivery: prepared.filter((lead) => !closed(lead) && lead.supplier_confirmation_received_at && !lead.supplier_actual_delivery_date).length,
    deliveryDueSoon: prepared.filter((lead) => !closed(lead) && deliveryDueSoon(lead, now)).length,
    deliveredBookInstall: prepared.filter((lead) => !closed(lead) && lead.supplier_actual_delivery_date && !lead.installation_scheduled_at).length,
    installationsThisWeek: prepared.filter((lead) => !closed(lead) && isThisWeek(lead.installation_scheduled_at, now)).length,
    balanceDue: prepared.filter((lead) => !closed(lead) && lead.balance_requested_at && !lead.balance_paid_at).length,
    overdueCustomerUpdates: prepared.filter((lead) => !closed(lead) && customerUpdateDue(lead, now)).length,
    highPriorityRepairs: prepared.filter((lead) => !closed(lead) && lead.workflow_type === "repair" && (lead.priorityLabel === "High" || lead.urgency === "Urgent")).length,
    supplierEmailsNeedingReview: supplierEmails.filter((email) => email.reviewStatus !== "Linked").length
  };
}

function todaysActions(leads, now = new Date()) {
  return leads
    .map((lead) => ensureJobFields(lead, now))
    .filter((lead) => !closed(lead) && lead.next_best_action && lead.next_best_action !== "No action needed")
    .sort((a, b) => riskWeight(b.operational_risk_level) - riskWeight(a.operational_risk_level) || String(a.customer_update_due).localeCompare(String(b.customer_update_due)))
    .slice(0, 15);
}

function relevantActions(lead) {
  return evaluateWorkflow(lead).visiblePrimaryActions;
}

function applyJobAction(lead, action, form = {}, now = new Date()) {
  ensureJobFields(lead, now);
  const today = now.toISOString().slice(0, 10);
  const dateValue = (key) => form[key] || today;
  const textValue = (key) => String(form[key] || "").trim();
  if (form.workflow_type) lead.workflow_type = form.workflow_type;

  if (action === "mark_quote_sent") {
    lead.quote_status = "sent";
    lead.quote_sent_at = dateValue("quote_sent_at");
    lead.quote_amount = textValue("quote_amount") || lead.quote_amount;
    lead.quote_reference = textValue("quote_reference") || lead.quote_reference;
    lead.status = "Quoted";
  }
  if (action === "mark_quote_accepted") {
    lead.quote_status = "accepted";
    lead.quote_accepted_at = dateValue("quote_accepted_at");
    lead.quote_amount = textValue("quote_amount") || lead.quote_amount;
    lead.quote_reference = textValue("quote_reference") || lead.quote_reference;
    lead.deposit_required = textValue("deposit_required") || lead.deposit_required || (supplierOrderUsuallyRequired(lead) ? "yes" : "no");
    lead.deposit_amount = textValue("deposit_amount") || lead.deposit_amount;
    lead.supplier_order_required = textValue("supplier_order_required") || lead.supplier_order_required || (supplierOrderUsuallyRequired(lead) ? "yes" : "no");
    lead.customer_payment_notes = textValue("customer_payment_notes") || lead.customer_payment_notes;
    lead.status = "Won";
  }
  if (action === "request_deposit") {
    lead.deposit_requested_at = dateValue("deposit_requested_at");
    lead.deposit_amount = textValue("deposit_amount") || lead.deposit_amount;
  }
  if (action === "mark_deposit_received") {
    lead.deposit_received_at = dateValue("deposit_received_at");
    lead.deposit_amount = textValue("deposit_amount") || lead.deposit_amount;
    lead.deposit_payment_method = textValue("deposit_payment_method") || lead.deposit_payment_method;
    lead.deposit_payment_reference = textValue("deposit_payment_reference") || lead.deposit_payment_reference;
    lead.deposit_payment_notes = textValue("deposit_payment_notes") || lead.deposit_payment_notes;
  }
  if (action === "mark_supplier_order_placed") {
    lead.supplier_order_placed_at = dateValue("supplier_order_placed_at");
    lead.supplier_name = textValue("supplier_name") || lead.supplier_name;
    lead.supplier_order_reference = textValue("supplier_order_reference") || lead.supplier_order_reference;
    lead.supplier_order_product_details = textValue("supplier_order_product_details") || lead.supplier_order_product_details;
    lead.supplier_order_door_type = textValue("supplier_order_door_type") || lead.supplier_order_door_type || lead.garageDoorType;
    lead.supplier_order_colour_finish = textValue("supplier_order_colour_finish") || lead.supplier_order_colour_finish;
    lead.supplier_order_size_notes = textValue("supplier_order_size_notes") || lead.supplier_order_size_notes;
    lead.supplier_order_notes = textValue("supplier_order_notes") || lead.supplier_order_notes;
    lead.supplier_estimated_delivery_date = textValue("supplier_estimated_delivery_date") || lead.supplier_estimated_delivery_date;
    lead.supplier_estimated_delivery_start = textValue("supplier_estimated_delivery_start") || lead.supplier_estimated_delivery_start;
    lead.supplier_estimated_delivery_end = textValue("supplier_estimated_delivery_end") || lead.supplier_estimated_delivery_end;
    lead.supplier_lead_time_text = textValue("supplier_lead_time_text") || lead.supplier_lead_time_text;
    lead.supplier_delivery_status = "Order placed";
    lead.supplier_order_status = "placed_waiting_confirmation";
  }
  if (action === "mark_supplier_confirmation_received") {
    lead.supplier_confirmation_received_at = dateValue("supplier_confirmation_received_at");
    lead.supplier_confirmation_details = textValue("supplier_confirmation_details") || lead.supplier_confirmation_details;
    lead.supplier_confirmation_email_linked = textValue("supplier_confirmation_email_linked") || lead.supplier_confirmation_email_linked;
    lead.supplier_delivery_status = "Confirmed";
    lead.supplier_estimated_delivery_date = textValue("supplier_estimated_delivery_date") || lead.supplier_estimated_delivery_date;
    lead.supplier_estimated_delivery_start = textValue("supplier_estimated_delivery_start") || lead.supplier_estimated_delivery_start;
    lead.supplier_estimated_delivery_end = textValue("supplier_estimated_delivery_end") || lead.supplier_estimated_delivery_end;
    lead.supplier_lead_time_text = textValue("supplier_lead_time_text") || lead.supplier_lead_time_text;
  }
  if (action === "update_expected_delivery") {
    lead.supplier_estimated_delivery_date = textValue("supplier_estimated_delivery_date") || lead.supplier_estimated_delivery_date;
    lead.supplier_estimated_delivery_start = textValue("supplier_estimated_delivery_start") || lead.supplier_estimated_delivery_start;
    lead.supplier_estimated_delivery_end = textValue("supplier_estimated_delivery_end") || lead.supplier_estimated_delivery_end;
    lead.supplier_lead_time_text = textValue("supplier_lead_time_text") || lead.supplier_lead_time_text;
  }
  if (action === "mark_delivered") {
    lead.supplier_actual_delivery_date = dateValue("supplier_actual_delivery_date");
    lead.supplier_delivery_status = "Delivered";
  }
  if (action === "book_installation") {
    lead.installation_booking_status = "Booked";
    lead.installation_scheduled_at = textValue("installation_scheduled_at") || today;
    lead.installation_time_window = textValue("installation_time_window") || lead.installation_time_window;
    lead.installation_assigned_to = textValue("installation_assigned_to") || lead.installation_assigned_to;
    lead.installation_access_notes = textValue("installation_access_notes") || lead.installation_access_notes;
    lead.installation_customer_confirmation_status = textValue("installation_customer_confirmation_status") || "Needs confirmation";
  }
  if (action === "mark_installation_completed") {
    lead.installation_completed_at = dateValue("installation_completed_at");
    lead.installation_booking_status = "Completed";
    lead.status = "Installation completed";
  }
  if (action === "request_balance") {
    lead.balance_requested_at = dateValue("balance_requested_at");
    lead.balance_amount = textValue("balance_amount") || lead.balance_amount;
  }
  if (action === "mark_balance_paid") {
    lead.balance_paid_at = dateValue("balance_paid_at");
    lead.balance_amount = textValue("balance_amount") || lead.balance_amount;
    lead.balance_payment_method = textValue("balance_payment_method") || lead.balance_payment_method;
    lead.balance_payment_reference = textValue("balance_payment_reference") || lead.balance_payment_reference;
    lead.balance_payment_notes = textValue("balance_payment_notes") || lead.balance_payment_notes;
    lead.status = "Paid";
  }
  if (action === "request_review") {
    lead.review_requested_at = dateValue("review_requested_at");
    lead.status = "Review requested";
  }
  if (action === "close_job") {
    lead.closed_at = dateValue("closed_at");
    lead.status = "Closed";
  }
  lead.updatedAt = new Date().toISOString();
  ensureJobFields(lead, now);
  return lead;
}

function suggestedDraftType(lead) {
  ensureJobFields(lead);
  if (lead.quote_sent_at && !lead.quote_accepted_at) return "quote_follow_up";
  if (lead.quote_accepted_at && lead.deposit_required === "yes" && !lead.deposit_received_at) return "deposit_request";
  if (lead.deposit_received_at && !lead.supplier_confirmation_received_at) return "deposit_received_order_placed";
  if (lead.supplier_confirmation_received_at && !lead.supplier_actual_delivery_date) return lead.supplier_delivery_status === "Delayed" ? "delivery_delay" : "supplier_confirmation";
  if (lead.supplier_actual_delivery_date && !lead.installation_scheduled_at) return "ready_to_book_installation";
  if (lead.installation_scheduled_at && !lead.installation_completed_at) return "installation_booked";
  if (lead.installation_completed_at && !lead.balance_paid_at) return "balance_request";
  if (lead.balance_paid_at && !lead.review_requested_at) return "review_request";
  return "quote_follow_up";
}

function leadText(lead) {
  return `${lead.jobType || ""} ${lead.jobDescription || ""} ${lead.garageDoorType || ""} ${lead.garageDoorIssue || ""} ${lead.mechanism || ""} ${lead.category || ""}`;
}

function closed(lead) {
  return CLOSED_STATUSES.has(lead.status) || Boolean(lead.closed_at);
}

function isRepairCompleted(lead) {
  return lead.workflow_type === "repair" && /completed/i.test(String(lead.status || ""));
}

function quoteFollowUpDue(lead, now) {
  return lead.quote_sent_at && !lead.quote_accepted_at && ageInDays(lead.quote_sent_at, now) >= 3;
}

function deliveryDueSoon(lead, now) {
  const target = lead.supplier_estimated_delivery_date || lead.supplier_estimated_delivery_end;
  if (!target || lead.supplier_actual_delivery_date) return false;
  const days = daysUntil(target, now);
  return days >= 0 && days <= 7;
}

function deliveryOverdue(lead, now) {
  const target = lead.supplier_estimated_delivery_end || lead.supplier_estimated_delivery_date;
  if (!target || lead.supplier_actual_delivery_date) return false;
  return daysUntil(target, now) < 0;
}

function customerUpdateDue(lead, now) {
  if (lead.customer_update_due === "yes") return true;
  if (!lead.supplier_order_placed_at || lead.supplier_actual_delivery_date || closed(lead)) return false;
  return ageInDays(lead.updatedAt || lead.supplier_order_placed_at, now) >= 7;
}

function isThisWeek(value, now) {
  if (!value) return false;
  const date = parseDate(value);
  if (!date) return false;
  const day = now.getDay() || 7;
  const start = new Date(now);
  start.setDate(now.getDate() - day + 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  return date >= start && date < end;
}

function riskWeight(value) {
  return value === "red" ? 3 : value === "amber" ? 2 : 1;
}

function ageInDays(value, now = new Date()) {
  const date = parseDate(value);
  if (!date) return 0;
  return Math.floor((now - date) / (24 * 60 * 60 * 1000));
}

function daysUntil(value, now = new Date()) {
  const date = parseDate(value);
  if (!date) return 999;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return Math.round((date - today) / (24 * 60 * 60 * 1000));
}

function parseDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

module.exports = {
  JOB_FIELD_DEFAULTS,
  ensureJobFields,
  inferWorkflowType,
  supplierOrderUsuallyRequired,
  calculateNextBestAction,
  evaluateWorkflow,
  calculateOperationalRisk,
  queueCounts,
  todaysActions,
  relevantActions,
  applyJobAction,
  suggestedDraftType,
  deliveryDueSoon,
  deliveryOverdue
};
