function calculateSupplierInvoice(invoice = {}, payments = [], now = new Date()) {
  const netAmount = money(invoice.netAmount ?? invoice.net_amount);
  const vatAmount = money(invoice.vatAmount ?? invoice.vat_amount);
  const enteredGross = invoice.grossAmount ?? invoice.gross_amount;
  const grossAmount = money(enteredGross) || money(netAmount + vatAmount);
  const activePayments = (payments || []).filter((payment) => !payment.archivedAt && !payment.deletedAt);
  const totalPaid = activePayments.length
    ? activePayments.reduce((total, payment) => total + money(payment.amount), 0)
    : money(invoice.amountPaid ?? invoice.amount_paid);
  const rawOutstanding = grossAmount - totalPaid;
  const outstanding = Math.max(rawOutstanding, 0);
  const overpaidAmount = rawOutstanding < 0 ? Math.abs(rawOutstanding) : 0;
  const overdue = isOverdue(invoice.dueDate ?? invoice.due_date, now);
  const status = paymentStatus({ invoice, grossAmount, totalPaid, outstanding, overdue });
  const warnings = warningsForInvoice({ invoice, netAmount, vatAmount, enteredGross, grossAmount, totalPaid, outstanding, overpaidAmount, overdue });

  return {
    netAmount,
    vatAmount,
    grossAmount,
    totalPaid,
    amountPaid: totalPaid,
    outstanding,
    amountOutstanding: outstanding,
    overpaidAmount,
    paymentStatus: status,
    isOverdue: overdue,
    warnings
  };
}

function paymentStatus({ invoice, grossAmount, totalPaid, outstanding, overdue }) {
  if (invoice.paymentStatus === "Disputed" || invoice.paymentStatus === "Archived") return invoice.paymentStatus;
  if (!grossAmount) return "Not invoiced";
  if (outstanding <= 0) return "Paid";
  if (totalPaid > 0) return "Part paid";
  if (overdue) return "Overdue";
  return invoice.dueDate || invoice.due_date ? "Payment due" : "Invoice received";
}

function warningsForInvoice({ invoice, netAmount, vatAmount, enteredGross, grossAmount, totalPaid, outstanding, overpaidAmount, overdue }) {
  const warnings = [];
  const reference = invoice.invoiceReference || invoice.invoice_reference || invoice.id || "supplier invoice";
  if (!grossAmount) warnings.push("Gross amount missing");
  if ((netAmount || vatAmount) && money(enteredGross) && money(netAmount + vatAmount) !== grossAmount) {
    warnings.push("VAT entered but gross amount does not match net + VAT");
  }
  if (overpaidAmount > 0) warnings.push(`Overpaid by ${formatMoney(overpaidAmount)}`);
  if (invoice.paymentStatus === "Paid" && outstanding > 0) warnings.push(`Marked paid but ${formatMoney(outstanding)} appears outstanding`);
  if (grossAmount > 0 && !(invoice.dueDate || invoice.due_date)) warnings.push("Due date missing");
  if (overdue && outstanding > 0) warnings.push("Invoice overdue");
  if (totalPaid > grossAmount && grossAmount > 0) warnings.push(`${reference} has payments above the gross invoice total`);
  return warnings;
}

function isOverdue(value, now = new Date()) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return date < today;
}

function formatMoney(value) {
  return `\u00a3${money(value).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function money(value) {
  const parsed = Number.parseFloat(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

module.exports = {
  calculateSupplierInvoice
};
