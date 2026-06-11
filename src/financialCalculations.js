const CLOSED_STATUSES = new Set(["Archived", "Duplicate", "Lost", "Closed"]);
const { calculateSupplierInvoice } = require("./supplierInvoiceCalculations");

function calculateJobFinancials(lead, state = {}, now = new Date()) {
  const customerPayments = active((state.customerPayments || []).filter((payment) => payment.leadId === lead.id));
  const supplierInvoices = active((state.supplierInvoices || []).filter((invoice) => invoice.leadId === lead.id)).map((invoice) => enrichSupplierInvoice(invoice, state, now));
  const quotedAmount = money(lead.quote_amount);
  const agreedFinalAmount = money(lead.agreed_final_amount || (lead.quote_accepted_at ? lead.quote_amount : 0));
  const effectiveAgreed = agreedFinalAmount || quotedAmount;
  const depositRequired = isYes(lead.deposit_required);
  const depositAmountRequired = depositRequired ? money(lead.deposit_amount) : 0;
  const explicitCustomerPaid = sum(customerPayments, (payment) => payment.paymentType === "refund" ? -money(payment.amount) : money(payment.amount));
  const fallbackDeposit = !customerPayments.length && lead.deposit_received_at ? money(lead.deposit_amount) : 0;
  const fallbackBalance = !customerPayments.length && lead.balance_paid_at ? money(lead.balance_amount) : 0;
  const totalCustomerPaymentsReceived = explicitCustomerPaid || fallbackDeposit + fallbackBalance;
  const depositAmountReceived = sum(customerPayments.filter((payment) => payment.paymentType === "deposit"), (payment) => payment.amount) || fallbackDeposit;
  const balancePaid = sum(customerPayments.filter((payment) => payment.paymentType === "balance"), (payment) => payment.amount) || fallbackBalance;
  const rawCustomerOutstanding = effectiveAgreed - totalCustomerPaymentsReceived;
  const overpaidAmount = rawCustomerOutstanding < 0 ? Math.abs(rawCustomerOutstanding) : 0;
  const customerAmountOutstanding = Math.max(rawCustomerOutstanding, 0);
  const supplierGross = sum(supplierInvoices, (invoice) => invoice.grossAmount);
  const supplierPaid = sum(supplierInvoices, (invoice) => invoice.amountPaid);
  const supplierOutstanding = sum(supplierInvoices, (invoice) => invoice.amountOutstanding);
  const estimatedGrossMargin = effectiveAgreed - supplierGross;
  const estimatedGrossMarginPercentage = effectiveAgreed ? Math.round((estimatedGrossMargin / effectiveAgreed) * 1000) / 10 : 0;
  const overdueCustomerAmount = overdueCustomerBalance(lead, customerAmountOutstanding, now);
  const overdueSupplierAmount = sum(supplierInvoices.filter((invoice) => isOverdue(invoice.dueDate, now) && money(invoice.amountOutstanding) > 0), (invoice) => invoice.amountOutstanding);

  return {
    leadId: lead.id,
    quoted_amount: quotedAmount,
    agreed_final_amount: effectiveAgreed,
    total_customer_payments_received: totalCustomerPaymentsReceived,
    deposit_amount_required: depositAmountRequired,
    deposit_amount_received: depositAmountReceived,
    balance_due: customerAmountOutstanding,
    balance_paid: balancePaid,
    customer_amount_outstanding: customerAmountOutstanding,
    customer_overpaid_amount: overpaidAmount,
    customer_payment_status: customerPaymentStatus(lead, {
      agreed: effectiveAgreed,
      paid: totalCustomerPaymentsReceived,
      outstanding: customerAmountOutstanding,
      overpaid: overpaidAmount,
      depositRequired,
      depositAmountReceived
    }, now),
    overdue_customer_amount: overdueCustomerAmount,
    total_supplier_invoice_gross: supplierGross,
    total_supplier_paid: supplierPaid,
    supplier_amount_outstanding: supplierOutstanding,
    supplier_payment_status: supplierPaymentStatus(supplierInvoices, now),
    overdue_supplier_amount: overdueSupplierAmount,
    estimated_gross_revenue: effectiveAgreed,
    estimated_supplier_costs: supplierGross,
    estimated_gross_margin: estimatedGrossMargin,
    estimated_gross_margin_percentage: estimatedGrossMarginPercentage,
    net_cash_position_for_job: customerAmountOutstanding - supplierOutstanding,
    pipeline_cash_to_collect: customerAmountOutstanding,
    supplier_cash_to_pay: supplierOutstanding,
    supplierInvoices,
    customerPayments,

    customerAgreed: effectiveAgreed,
    customerPaid: totalCustomerPaymentsReceived,
    customerOutstanding: customerAmountOutstanding,
    customerOverpaid: overpaidAmount,
    customerPaymentStatus: customerPaymentStatus(lead, {
      agreed: effectiveAgreed,
      paid: totalCustomerPaymentsReceived,
      outstanding: customerAmountOutstanding,
      overpaid: overpaidAmount,
      depositRequired,
      depositAmountReceived
    }, now),
    supplierGross,
    supplierPaid,
    supplierOutstanding,
    supplierPaymentStatus: supplierPaymentStatus(supplierInvoices, now),
    estimatedGrossMargin,
    estimatedGrossMarginPercent: estimatedGrossMarginPercentage
  };
}

function calculateFinanceDashboard(leads = [], state = {}, now = new Date()) {
  const activeLeads = leads.filter((lead) => !CLOSED_STATUSES.has(lead.status) && !lead.closed_at);
  const jobFinancials = activeLeads.map((lead) => ({ lead, finance: calculateJobFinancials(lead, state, now) }));
  const invoices = active(state.supplierInvoices || []).map((invoice) => enrichSupplierInvoice(invoice, state, now));
  const payments = active(state.customerPayments || []);
  const thisWeek = (date) => dateInDays(date, 7, now);
  const thisMonth = (date) => sameMonth(date, now);

  return {
    openPipelineValue: sum(activeLeads, (lead) => money(lead.quote_amount || lead.agreed_final_amount)),
    acceptedJobsValue: sum(activeLeads.filter((lead) => lead.quote_accepted_at || lead.status === "Won"), (lead) => money(lead.agreed_final_amount || lead.quote_amount)),
    totalCustomerPaid: sum(jobFinancials, (item) => item.finance.total_customer_payments_received),
    customerOutstanding: sum(jobFinancials, (item) => item.finance.customer_amount_outstanding),
    overdueCustomerPayments: sum(jobFinancials, (item) => item.finance.overdue_customer_amount),
    balanceDueAfterCompletedInstalls: sum(jobFinancials.filter((item) => item.lead.installation_completed_at), (item) => item.finance.customer_amount_outstanding),
    depositsRequested: sum(activeLeads.filter((lead) => lead.deposit_requested_at), (lead) => money(lead.deposit_amount)),
    depositsReceived: sum(jobFinancials, (item) => item.finance.deposit_amount_received),
    expectedIncomingThisWeek: sum(jobFinancials.filter((item) => thisWeek(item.lead.followUpDate) || thisWeek(item.lead.balance_requested_at)), (item) => item.finance.customer_amount_outstanding),
    expectedIncomingThisMonth: sum(jobFinancials.filter((item) => thisMonth(item.lead.followUpDate) || thisMonth(item.lead.balance_requested_at)), (item) => item.finance.customer_amount_outstanding),
    workWonThisMonth: sum(activeLeads.filter((lead) => thisMonth(lead.quote_accepted_at)), (lead) => money(lead.agreed_final_amount || lead.quote_amount)),
    workClosedThisMonth: sum((leads || []).filter((lead) => thisMonth(lead.closed_at)), (lead) => money(lead.agreed_final_amount || lead.quote_amount)),
    supplierInvoicesReceived: sum(invoices, (invoice) => invoice.grossAmount),
    totalSupplierPaid: sum(invoices, (invoice) => invoice.amountPaid),
    supplierOutstanding: sum(invoices, (invoice) => invoice.amountOutstanding),
    partPaidSupplierInvoices: invoices.filter((invoice) => invoice.paymentStatus === "Part paid").length,
    overpaidSupplierInvoices: sum(invoices, (invoice) => invoice.overpaidAmount),
    supplierDueThisWeek: sum(invoices.filter((invoice) => thisWeek(invoice.dueDate)), (invoice) => invoice.amountOutstanding),
    supplierDueThisMonth: sum(invoices.filter((invoice) => thisMonth(invoice.dueDate)), (invoice) => invoice.amountOutstanding),
    overdueSupplierPayments: sum(invoices.filter((invoice) => isOverdue(invoice.dueDate, now) && invoice.paymentStatus !== "Paid"), (invoice) => invoice.amountOutstanding),
    expectedRevenue: sum(jobFinancials, (item) => item.finance.estimated_gross_revenue),
    expectedSupplierCosts: sum(jobFinancials, (item) => item.finance.estimated_supplier_costs),
    expectedGrossMargin: sum(jobFinancials, (item) => item.finance.estimated_gross_margin),
    cashCollected: sum(jobFinancials, (item) => item.finance.total_customer_payments_received),
    cashStillToCollect: sum(jobFinancials, (item) => item.finance.customer_amount_outstanding),
    cashOwedToSuppliers: sum(jobFinancials, (item) => item.finance.supplier_amount_outstanding),
    netCashPosition: sum(jobFinancials, (item) => item.finance.net_cash_position_for_job),
    supplierLiabilitiesBySupplier: supplierLiabilitiesBySupplier(invoices),
    jobFinancials,
    payments,
    supplierInvoices: invoices
  };
}

function calculateSupplierInvoiceBalance(invoice, state = {}, now = new Date()) {
  return enrichSupplierInvoice(invoice, state, now);
}

function calculateFinancialWarnings(lead, state = {}, now = new Date()) {
  const finance = calculateJobFinancials(lead, state, now);
  const warnings = [];
  if (lead.quote_accepted_at && !finance.agreed_final_amount) warnings.push({ tone: "amber", message: "Quote accepted but agreed amount is missing." });
  if (lead.deposit_received_at && !finance.deposit_amount_received) warnings.push({ tone: "amber", message: "Deposit is marked received but no payment amount is recorded." });
  if (lead.installation_completed_at && finance.customer_amount_outstanding > 0 && !lead.balance_requested_at) warnings.push({ tone: "amber", message: `Installation is complete. Customer balance outstanding is ${formatMoney(finance.customer_amount_outstanding)}.` });
  if (finance.overdue_customer_amount > 0) warnings.push({ tone: "red", message: `Customer balance overdue: ${formatMoney(finance.overdue_customer_amount)}.` });
  for (const invoice of finance.supplierInvoices) {
    for (const message of invoice.warnings || []) {
      warnings.push({ tone: /overdue|exceed|paid but/i.test(message) ? "red" : "amber", message: `Supplier invoice ${invoice.invoiceReference || invoice.id}: ${message}.` });
    }
  }
  if (finance.overdue_supplier_amount > 0) warnings.push({ tone: "red", message: `Supplier payment overdue: ${formatMoney(finance.overdue_supplier_amount)}.` });
  if (finance.estimated_gross_margin < 0) warnings.push({ tone: "red", message: `Supplier costs exceed agreed customer amount by ${formatMoney(Math.abs(finance.estimated_gross_margin))}.` });
  if (finance.customer_overpaid_amount > 0) warnings.push({ tone: "amber", message: `Customer overpaid by ${formatMoney(finance.customer_overpaid_amount)}. Refund/adjustment needed.` });
  return warnings;
}

function enrichSupplierInvoice(invoice, state = {}, now = new Date()) {
  const explicitPayments = active(state.supplierPayments || []).filter((payment) => payment.invoiceId === invoice.id);
  const calculated = calculateSupplierInvoice(invoice, explicitPayments, now);
  return {
    ...invoice,
    netAmount: calculated.netAmount,
    vatAmount: calculated.vatAmount,
    grossAmount: calculated.grossAmount,
    amountPaid: calculated.amountPaid,
    totalPaid: calculated.totalPaid,
    amountOutstanding: calculated.amountOutstanding,
    outstanding: calculated.outstanding,
    overpaidAmount: calculated.overpaidAmount,
    paymentStatus: calculated.paymentStatus,
    isOverdue: calculated.isOverdue,
    warnings: calculated.warnings
  };
}

function supplierInvoiceStatus(invoice, now = new Date()) {
  if (invoice.paymentStatus === "Disputed" || invoice.paymentStatus === "Archived") return invoice.paymentStatus;
  const gross = money(invoice.grossAmount);
  const paid = money(invoice.amountPaid);
  const outstanding = Math.max(gross - paid, 0);
  if (!gross) return "Not invoiced";
  if (outstanding <= 0) return "Paid";
  if (paid > 0) return "Part paid";
  if (isOverdue(invoice.dueDate, now)) return "Overdue";
  return invoice.dueDate ? "Payment due" : "Invoice received";
}

function customerPaymentStatus(lead, values, now = new Date()) {
  if (values.overpaid > 0) return "Overpaid";
  if (!values.agreed && !lead.quote_sent_at) return "No quote yet";
  if (values.outstanding <= 0 && values.agreed) return "Paid in full";
  if (lead.installation_completed_at && values.outstanding > 0) return isOverdue(lead.balance_requested_at, now) ? "Overdue" : "Balance due";
  if (values.depositRequired && !lead.deposit_received_at) return lead.deposit_requested_at ? "Deposit requested" : "Deposit due";
  if (values.paid > 0 && values.outstanding > 0) return "Part paid";
  if (lead.quote_accepted_at) return "Quote accepted";
  if (lead.quote_sent_at) return "Quote sent";
  return "No quote yet";
}

function supplierPaymentStatus(invoices, now = new Date()) {
  if (!invoices.length) return "Not invoiced";
  if (invoices.some((invoice) => supplierInvoiceStatus(invoice, now) === "Overdue")) return "Overdue";
  if (invoices.every((invoice) => money(invoice.amountOutstanding) <= 0)) return "Paid";
  if (invoices.some((invoice) => money(invoice.amountPaid) > 0)) return "Part paid";
  return "Payment due";
}

function overdueCustomerBalance(lead, outstanding, now) {
  if (outstanding <= 0) return 0;
  if (lead.balance_requested_at && isOverdue(lead.balance_requested_at, now)) return outstanding;
  return 0;
}

function supplierLiabilitiesBySupplier(invoices) {
  const totals = new Map();
  for (const invoice of invoices) {
    const name = invoice.supplierName || "Unknown";
    totals.set(name, (totals.get(name) || 0) + money(invoice.amountOutstanding));
  }
  return [...totals.entries()].map(([supplierName, amountOutstanding]) => ({ supplierName, amountOutstanding }));
}

function money(value) {
  const parsed = Number.parseFloat(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function formatMoney(value) {
  return `\u00a3${money(value).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function sum(items, fn) {
  return (items || []).reduce((total, item) => total + money(fn(item)), 0);
}

function active(items) {
  return (items || []).filter((item) => !item.archivedAt && !item.deletedAt && item.paymentStatus !== "Cancelled");
}

function isYes(value) {
  return ["yes", "true", true].includes(String(value).toLowerCase());
}

function isOverdue(value, now = new Date()) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const today = startOfToday(now);
  return date < today;
}

function startOfToday(now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date;
}

function dateInDays(value, days, now) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const start = startOfToday(now);
  const end = new Date(start);
  end.setDate(start.getDate() + days + 1);
  return date >= start && date < end;
}

function sameMonth(value, now) {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
}

module.exports = {
  calculateJobFinancials,
  calculateFinanceDashboard,
  calculateSupplierInvoiceBalance,
  calculateFinancialWarnings,
  supplierInvoiceStatus,
  money,
  formatMoney
};
