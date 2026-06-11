const CUSTOMER_PAYMENT_METHODS = ["Unknown", "Bank transfer", "Cash", "Cheque", "Card", "Finance", "Other"];
const SUPPLIER_PAYMENT_METHODS = ["Unknown", "Bank transfer", "Card", "Cash", "Cheque", "Direct debit", "Other"];
const CUSTOMER_PAYMENT_STATUSES = ["No quote yet", "Quote sent", "Quote accepted", "Deposit due", "Deposit requested", "Deposit paid", "Part paid", "Balance due", "Paid in full", "Overdue", "Overpaid", "Refunded", "Written off", "Cancelled"];
const SUPPLIER_PAYMENT_STATUSES = ["Not invoiced", "Invoice received", "Payment due", "Part paid", "Paid", "Overdue", "Disputed", "Archived"];

const {
  calculateJobFinancials,
  calculateFinanceDashboard,
  calculateSupplierInvoiceBalance,
  calculateFinancialWarnings,
  supplierInvoiceStatus,
  money,
  formatMoney
} = require("./financialCalculations");

function ensureFinanceState(state) {
  if (!Array.isArray(state.customerPayments)) state.customerPayments = [];
  if (!Array.isArray(state.supplierInvoices)) state.supplierInvoices = [];
  if (!Array.isArray(state.supplierPayments)) state.supplierPayments = [];
  if (!Array.isArray(state.systemBackups)) state.systemBackups = [];
  return state;
}

function createCustomerPayment(form, leadId) {
  const now = new Date().toISOString();
  return {
    id: `customer-payment:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    leadId,
    paymentType: form.payment_type || form.paymentType || "other",
    amount: money(form.amount || form.deposit_amount || form.balance_amount),
    paymentMethod: form.payment_method || form.paymentMethod || form.deposit_payment_method || form.balance_payment_method || "Unknown",
    paymentDate: form.payment_date || form.paymentDate || form.deposit_received_at || form.balance_paid_at || now.slice(0, 10),
    reference: form.reference || form.payment_reference || form.deposit_payment_reference || form.balance_payment_reference || "",
    notes: form.notes || form.payment_notes || form.deposit_payment_notes || form.balance_payment_notes || "",
    createdAt: now,
    updatedAt: now,
    archivedAt: ""
  };
}

function createSupplierInvoice(form, leadId = "") {
  const now = new Date().toISOString();
  const net = money(form.net_amount || form.netAmount);
  const vat = money(form.vat_amount || form.vatAmount);
  const gross = money(form.gross_amount || form.grossAmount || net + vat);
  const paid = money(form.amount_paid || form.amountPaid);
  const invoice = {
    id: form.id || `supplier-invoice:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    leadId: form.leadId || form.lead_id || leadId,
    supplierEmailId: form.supplierEmailId || form.supplier_email_id || "",
    supplierName: form.supplier_name || form.supplierName || "",
    invoiceReference: form.invoice_reference || form.invoiceReference || "",
    invoiceDate: form.invoice_date || form.invoiceDate || "",
    dueDate: form.due_date || form.dueDate || "",
    netAmount: net,
    vatAmount: vat,
    grossAmount: gross,
    amountPaid: paid,
    amountOutstanding: 0,
    paymentStatus: form.payment_status || form.paymentStatus || "Invoice received",
    paymentMethod: form.payment_method || form.paymentMethod || "Unknown",
    paidAt: form.paid_at || form.paidAt || "",
    invoiceEmailMessageId: form.invoice_email_message_id || form.invoiceEmailMessageId || "",
    invoiceAttachmentFilename: form.invoice_attachment_filename || form.invoiceAttachmentFilename || "",
    notes: form.notes || "",
    createdAt: form.createdAt || now,
    updatedAt: now,
    archivedAt: form.archived_at || form.archivedAt || ""
  };
  const calculated = calculateSupplierInvoiceBalance(invoice, { supplierPayments: [] });
  return {
    ...invoice,
    amountPaid: calculated.amountPaid,
    amountOutstanding: calculated.amountOutstanding,
    overpaidAmount: calculated.overpaidAmount,
    paymentStatus: calculated.paymentStatus
  };
}

function createSupplierPayment(form, invoice = {}) {
  const now = new Date().toISOString();
  return {
    id: form.id || `supplier-payment:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    invoiceId: form.invoiceId || form.invoice_id || invoice.id || "",
    leadId: form.leadId || form.lead_id || invoice.leadId || "",
    supplierName: form.supplier_name || form.supplierName || invoice.supplierName || "",
    amount: money(form.amount || form.amount_paid || form.amountPaid),
    paymentMethod: form.payment_method || form.paymentMethod || "Unknown",
    paidAt: form.paid_at || form.paidAt || form.payment_date || now.slice(0, 10),
    reference: form.reference || form.payment_reference || "",
    notes: form.notes || form.payment_notes || "",
    createdAt: form.createdAt || now,
    updatedAt: now,
    archivedAt: form.archived_at || form.archivedAt || ""
  };
}

function updateSupplierInvoice(invoice, form) {
  const replacement = createSupplierInvoice({ ...invoice, ...form, id: invoice.id, createdAt: invoice.createdAt }, invoice.leadId);
  Object.assign(invoice, replacement);
  return invoice;
}

function applySupplierPayment(invoice, state, payment) {
  ensureFinanceState(state);
  if (payment && !state.supplierPayments.find((item) => item.id === payment.id)) state.supplierPayments.push(payment);
  const calculated = calculateSupplierInvoiceBalance(invoice, state);
  Object.assign(invoice, {
    netAmount: calculated.netAmount,
    vatAmount: calculated.vatAmount,
    grossAmount: calculated.grossAmount,
    amountPaid: calculated.amountPaid,
    amountOutstanding: calculated.amountOutstanding,
    overpaidAmount: calculated.overpaidAmount,
    paymentStatus: calculated.paymentStatus,
    paidAt: calculated.amountOutstanding <= 0 ? payment?.paidAt || invoice.paidAt : invoice.paidAt,
    updatedAt: new Date().toISOString()
  });
  return invoice;
}

function jobFinancials(lead, state) {
  ensureFinanceState(state);
  return calculateJobFinancials(lead, state);
}

function financeSummary(leads, state, now = new Date()) {
  ensureFinanceState(state);
  return calculateFinanceDashboard(leads, state, now);
}

function supplierInvoiceRows(invoices) {
  return [["ID", "Lead ID", "Supplier email ID", "Supplier", "Invoice reference", "Invoice date", "Due date", "Net", "VAT", "Gross", "Paid", "Outstanding", "Payment status", "Payment method", "Paid at", "Notes"], ...invoices.map((invoice) => [invoice.id, invoice.leadId, invoice.supplierEmailId, invoice.supplierName, invoice.invoiceReference, invoice.invoiceDate, invoice.dueDate, invoice.netAmount, invoice.vatAmount, invoice.grossAmount, invoice.amountPaid, invoice.amountOutstanding, invoice.paymentStatus, invoice.paymentMethod, invoice.paidAt, invoice.notes])];
}

function customerPaymentRows(payments) {
  return [["ID", "Lead ID", "Type", "Amount", "Method", "Date", "Reference", "Notes"], ...payments.map((payment) => [payment.id, payment.leadId, payment.paymentType, payment.amount, payment.paymentMethod, payment.paymentDate, payment.reference, payment.notes])];
}

function supplierPaymentRows(payments) {
  return [["ID", "Invoice ID", "Lead ID", "Supplier", "Amount", "Method", "Paid at", "Reference", "Notes"], ...payments.map((payment) => [payment.id, payment.invoiceId, payment.leadId, payment.supplierName, payment.amount, payment.paymentMethod, payment.paidAt, payment.reference, payment.notes])];
}

function jobFinancialRows(leads, state) {
  return [["Lead ID", "Customer", "Status", "Customer agreed", "Customer paid", "Customer outstanding", "Supplier costs", "Supplier paid", "Supplier outstanding", "Estimated margin", "Margin %"], ...(leads || []).map((lead) => {
    const finance = jobFinancials(lead, state);
    return [lead.id, lead.customerName, lead.status, finance.customerAgreed, finance.customerPaid, finance.customerOutstanding, finance.supplierGross, finance.supplierPaid, finance.supplierOutstanding, finance.estimatedGrossMargin, finance.estimatedGrossMarginPercent];
  })];
}

function toCsv(rows) {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

module.exports = {
  CUSTOMER_PAYMENT_METHODS,
  SUPPLIER_PAYMENT_METHODS,
  CUSTOMER_PAYMENT_STATUSES,
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
  money,
  formatMoney
};
