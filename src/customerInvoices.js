const fs = require("node:fs");
const path = require("node:path");
const { money, formatMoney } = require("./finance");

const INVOICE_STATUSES = ["draft", "issued", "sent", "part_paid", "paid", "overdue", "void", "archived"];
const INVOICE_TYPES = ["deposit", "balance", "final", "pro_forma", "credit_note"];

function ensureOperationsState(state, config = {}) {
  if (!Array.isArray(state.customerInvoices)) state.customerInvoices = [];
  if (!Array.isArray(state.technicians)) state.technicians = [];
  if (!Array.isArray(state.workOrders)) state.workOrders = [];
  if (!Array.isArray(state.messageLogs)) state.messageLogs = [];
  if (!state.companySettings || typeof state.companySettings !== "object") state.companySettings = {};
  state.companySettings = mergeCompanySettings(defaultCompanySettings(config), state.companySettings);
  return state;
}

function defaultCompanySettings(config = {}) {
  return {
    companyLegalName: config.company?.legalName || "YORKSHIRE AUTO DOORS LTD",
    tradingName: config.company?.tradingName || "Autodoors Yorkshire",
    companyNumber: config.company?.companyNumber || "14637200",
    companyStatus: config.company?.companyStatus || "Active",
    companyType: config.company?.companyType || "Private limited company",
    vatRegistered: Boolean(config.company?.vatRegistered),
    vatRegistrationNumber: config.company?.vatRegistrationNumber || "",
    registeredOfficeAddress: config.company?.registeredOfficeAddress || "Whitby Court Abbey Road, Shepley, Huddersfield, United Kingdom, HD8 8EL",
    tradingAddress: config.company?.tradingAddress || "",
    phone: config.company?.phone || "07895 698239",
    email: config.company?.email || "info@autodoorsyorkshire.com",
    website: config.company?.website || "https://autodoorsyorkshire.com",
    bankAccountName: config.company?.bankAccountName || "",
    sortCode: config.company?.sortCode || "",
    accountNumber: config.company?.accountNumber || "",
    paymentReferenceFormat: config.company?.paymentReferenceFormat || "{invoice_number}",
    defaultVatRate: money(config.company?.defaultVatRate || 20),
    defaultPaymentTerms: Number.parseInt(config.company?.defaultPaymentTerms || 7, 10) || 7,
    invoicePrefix: config.company?.invoicePrefix || "ADY-",
    nextInvoiceNumber: Number.parseInt(config.company?.nextInvoiceNumber || 1, 10) || 1,
    logoPath: config.company?.logoPath || "",
    noVatNote: config.company?.noVatNote || "No VAT charged."
  };
}

function mergeCompanySettings(defaults, saved) {
  const merged = { ...defaults, ...saved };
  merged.vatRegistered = isTrue(merged.vatRegistered);
  merged.defaultVatRate = money(merged.defaultVatRate);
  merged.defaultPaymentTerms = Number.parseInt(merged.defaultPaymentTerms, 10) || defaults.defaultPaymentTerms;
  merged.nextInvoiceNumber = Math.max(Number.parseInt(merged.nextInvoiceNumber, 10) || defaults.nextInvoiceNumber, 1);
  return merged;
}

function updateCompanySettings(state, form, config = {}) {
  ensureOperationsState(state, config);
  const current = state.companySettings;
  Object.assign(current, {
    companyLegalName: form.companyLegalName || current.companyLegalName,
    tradingName: form.tradingName || "",
    companyNumber: form.companyNumber || "",
    vatRegistered: isTrue(form.vatRegistered),
    vatRegistrationNumber: form.vatRegistrationNumber || "",
    registeredOfficeAddress: form.registeredOfficeAddress || "",
    tradingAddress: form.tradingAddress || "",
    phone: form.phone || "",
    email: form.email || "",
    website: form.website || "",
    bankAccountName: form.bankAccountName || "",
    sortCode: form.sortCode || "",
    accountNumber: form.accountNumber || "",
    paymentReferenceFormat: form.paymentReferenceFormat || "{invoice_number}",
    defaultVatRate: money(form.defaultVatRate),
    defaultPaymentTerms: Number.parseInt(form.defaultPaymentTerms, 10) || 7,
    invoicePrefix: form.invoicePrefix || "ADY-",
    nextInvoiceNumber: Math.max(Number.parseInt(form.nextInvoiceNumber, 10) || current.nextInvoiceNumber || 1, 1),
    logoPath: form.logoPath || "",
    noVatNote: form.noVatNote || ""
  });
  return current;
}

function companySetupWarnings(settings = {}) {
  const warnings = [];
  if (!settings.companyLegalName) warnings.push("Company legal name is missing.");
  if (!settings.companyNumber) warnings.push("Company number is missing.");
  if (!settings.registeredOfficeAddress) warnings.push("Registered office address is missing.");
  if (settings.vatRegistered && !settings.vatRegistrationNumber) warnings.push("VAT mode is enabled but the VAT number is missing.");
  if (!settings.bankAccountName || !settings.sortCode || !settings.accountNumber) warnings.push("Bank payment details are incomplete.");
  if (!settings.invoicePrefix) warnings.push("Invoice prefix is missing.");
  if (!settings.nextInvoiceNumber || settings.nextInvoiceNumber < 1) warnings.push("Next invoice number is missing.");
  return warnings;
}

function createCustomerInvoice(form, lead = {}, state = {}, config = {}) {
  ensureOperationsState(state, config);
  const now = new Date().toISOString();
  const settings = state.companySettings;
  const invoiceType = normaliseInvoiceType(form.invoice_type || form.invoiceType || "final");
  const invoiceDate = form.invoice_date || form.invoiceDate || now.slice(0, 10);
  const dueDate = form.due_date || form.dueDate || addDays(invoiceDate, settings.defaultPaymentTerms);
  const lineItems = parseLineItems(form, settings);
  const totals = calculateInvoiceTotals(lineItems, settings);
  const invoice = {
    invoice_id: `customer-invoice:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    invoice_number: "",
    invoice_type: invoiceType,
    job_id: form.job_id || form.jobId || lead.id || "",
    lead_id: form.lead_id || form.leadId || lead.id || "",
    customer_name: form.customer_name || form.customerName || lead.customerName || "",
    customer_email: form.customer_email || form.customerEmail || lead.customerEmail || "",
    customer_phone: form.customer_phone || form.customerPhone || lead.customerPhone || "",
    customer_billing_address: form.customer_billing_address || form.customerBillingAddress || lead.customerAddress || "",
    customer_postcode: form.customer_postcode || form.customerPostcode || lead.customerPostcode || "",
    invoice_date: invoiceDate,
    supply_date: form.supply_date || form.supplyDate || invoiceDate,
    due_date: dueDate,
    payment_terms: form.payment_terms || form.paymentTerms || `${settings.defaultPaymentTerms} days`,
    status: "draft",
    line_items_json: JSON.stringify(lineItems),
    subtotal_net: totals.subtotalNet,
    vat_rate: settings.vatRegistered ? totals.primaryVatRate : 0,
    vat_amount: totals.vatAmount,
    total_gross: totals.totalGross,
    amount_paid: money(form.amount_paid || form.amountPaid),
    amount_outstanding: Math.max(totals.totalGross - money(form.amount_paid || form.amountPaid), 0),
    payment_instructions: form.payment_instructions || form.paymentInstructions || paymentInstructions(settings),
    notes: form.notes || "",
    pdf_path: "",
    sent_at: "",
    created_at: now,
    updated_at: now,
    archived_at: ""
  };
  state.customerInvoices.push(invoice);
  return invoice;
}

function createInvoiceFromLead(lead, invoiceType, state, config = {}) {
  const finance = config.finance || {};
  const quote = money(lead.agreed_final_amount || lead.quote_amount);
  const deposit = money(lead.deposit_amount);
  const outstanding = money(finance.customerOutstanding ?? finance.customer_amount_outstanding ?? quote);
  const amount =
    invoiceType === "deposit" ? deposit || Math.round(quote * 0.3 * 100) / 100 :
    invoiceType === "balance" ? outstanding :
    quote || outstanding;
  return createCustomerInvoice({
    invoice_type: invoiceType,
    leadId: lead.id,
    description: invoiceDescription(invoiceType, lead),
    quantity: "1",
    unit_price_net: amount,
    notes: defaultInvoiceNotes(invoiceType)
  }, lead, state, config);
}

function issueInvoice(invoice, state, config = {}) {
  ensureOperationsState(state, config);
  if (!invoice) return null;
  if (!invoice.invoice_number) invoice.invoice_number = nextInvoiceNumber(state);
  invoice.status = "issued";
  invoice.updated_at = new Date().toISOString();
  return invoice;
}

function markInvoicePaid(invoice, amount, paidAt = new Date().toISOString().slice(0, 10)) {
  if (!invoice) return null;
  const paid = money(amount || invoice.amount_outstanding || invoice.total_gross);
  invoice.amount_paid = money(invoice.amount_paid) + paid;
  invoice.amount_outstanding = Math.max(money(invoice.total_gross) - money(invoice.amount_paid), 0);
  invoice.status = invoice.amount_outstanding > 0 ? "part_paid" : "paid";
  invoice.paid_at = paidAt;
  invoice.updated_at = new Date().toISOString();
  return invoice;
}

function archiveInvoice(invoice) {
  if (!invoice) return null;
  invoice.status = "archived";
  invoice.archived_at = new Date().toISOString();
  invoice.updated_at = invoice.archived_at;
  return invoice;
}

function voidInvoice(invoice) {
  if (!invoice) return null;
  invoice.status = "void";
  invoice.updated_at = new Date().toISOString();
  return invoice;
}

function calculateInvoiceTotals(lineItems = [], settings = {}) {
  const subtotalNet = sum(lineItems, (item) => item.net_total);
  const vatAmount = settings.vatRegistered ? sum(lineItems, (item) => item.vat_total) : 0;
  const totalGross = subtotalNet + vatAmount;
  return {
    subtotalNet: money(subtotalNet),
    vatAmount: money(vatAmount),
    totalGross: money(totalGross),
    primaryVatRate: lineItems.find((item) => money(item.vat_rate) > 0)?.vat_rate || money(settings.defaultVatRate)
  };
}

function invoiceSummary(state, now = new Date()) {
  const invoices = activeInvoices(state);
  const overdue = invoices.filter((invoice) => ["issued", "sent", "part_paid"].includes(invoice.status) && isPast(invoice.due_date, now) && money(invoice.amount_outstanding) > 0);
  return {
    invoicesToIssue: invoices.filter((invoice) => invoice.status === "draft").length,
    overdueCount: overdue.length,
    overdueAmount: sum(overdue, (invoice) => invoice.amount_outstanding),
    issuedAmount: sum(invoices.filter((invoice) => ["issued", "sent", "part_paid", "paid", "overdue"].includes(invoice.status)), (invoice) => invoice.total_gross),
    paidAmount: sum(invoices, (invoice) => invoice.amount_paid),
    unpaidAmount: sum(invoices.filter((invoice) => !["paid", "void", "archived"].includes(invoice.status)), (invoice) => invoice.amount_outstanding),
    vatOnIssued: sum(invoices.filter((invoice) => ["issued", "sent", "part_paid", "paid", "overdue"].includes(invoice.status)), (invoice) => invoice.vat_amount),
    balanceInvoicesDue: invoices.filter((invoice) => invoice.invoice_type === "balance" && ["draft", "issued", "sent", "part_paid"].includes(invoice.status)).length
  };
}

function activeInvoices(state) {
  return (state.customerInvoices || []).filter((invoice) => !invoice.archived_at && invoice.status !== "archived");
}

function invoicesForLead(state, leadId) {
  return activeInvoices(state).filter((invoice) => invoice.lead_id === leadId || invoice.job_id === leadId);
}

function parseLineItems(form, settings) {
  if (form.line_items_json || form.lineItemsJson) {
    try {
      const parsed = JSON.parse(form.line_items_json || form.lineItemsJson);
      if (Array.isArray(parsed)) return parsed.map((item) => normaliseLineItem(item, settings));
    } catch {
      // Fall through to single-line item fields.
    }
  }
  const descriptions = asArray(form.description || form.line_description || form.lineDescription).filter(Boolean);
  if (descriptions.length > 1) {
    const quantities = asArray(form.quantity);
    const prices = asArray(form.unit_price_net || form.unitPriceNet);
    return descriptions.map((description, index) => normaliseLineItem({
      description,
      quantity: quantities[index] || "1",
      unit_price_net: prices[index] || "0",
      vat_rate: settings.defaultVatRate
    }, settings));
  }
  return [normaliseLineItem({
    description: descriptions[0] || "Garage door works",
    quantity: form.quantity || "1",
    unit_price_net: form.unit_price_net || form.unitPriceNet || form.amount || "0",
    vat_rate: settings.defaultVatRate
  }, settings)];
}

function normaliseLineItem(item, settings) {
  const quantity = money(item.quantity || 1) || 1;
  const unitPriceNet = money(item.unit_price_net ?? item.unitPriceNet);
  const vatRate = settings.vatRegistered ? money(item.vat_rate ?? item.vatRate ?? settings.defaultVatRate) : 0;
  const netTotal = money(quantity * unitPriceNet);
  const vatTotal = money(netTotal * (vatRate / 100));
  return {
    description: item.description || "Garage door works",
    quantity,
    unit_price_net: unitPriceNet,
    vat_rate: vatRate,
    net_total: netTotal,
    vat_total: vatTotal,
    gross_total: money(netTotal + vatTotal)
  };
}

function generateInvoicePdf(invoice, settings, config = {}) {
  const dir = config.invoicePdfDir || path.join(process.cwd(), "outputs", "invoices");
  fs.mkdirSync(dir, { recursive: true });
  if (!invoice.invoice_number) invoice.invoice_number = `DRAFT-${invoice.invoice_id.split(":").at(-1)}`;
  const filename = `${safeFilename(invoice.invoice_number)}.pdf`;
  const target = path.join(dir, filename);
  const textLines = invoicePdfLines(invoice, settings);
  fs.writeFileSync(target, buildSimplePdf(textLines));
  invoice.pdf_path = target;
  invoice.updated_at = new Date().toISOString();
  return target;
}

function invoicePdfLines(invoice, settings) {
  const items = safeParseItems(invoice.line_items_json);
  const vatRegistered = settings.vatRegistered && settings.vatRegistrationNumber;
  return [
    settings.tradingName || settings.companyLegalName,
    settings.companyLegalName && settings.tradingName ? settings.companyLegalName : "",
    `Company number: ${settings.companyNumber || ""}`,
    vatRegistered ? `VAT registration: ${settings.vatRegistrationNumber}` : "",
    settings.registeredOfficeAddress || "",
    `Email: ${settings.email || ""}   Phone: ${settings.phone || ""}`,
    "",
    `${titleCase(invoice.invoice_type)} invoice`,
    `Invoice number: ${invoice.invoice_number || "Draft"}`,
    `Invoice date: ${invoice.invoice_date || ""}`,
    `Supply date / tax point: ${invoice.supply_date || ""}`,
    `Due date: ${invoice.due_date || ""}`,
    `Job reference: ${invoice.job_id || invoice.lead_id || ""}`,
    "",
    "Bill to:",
    invoice.customer_name || "",
    invoice.customer_billing_address || "",
    invoice.customer_postcode || "",
    invoice.customer_email || "",
    "",
    "Items",
    ...items.map((item) => `${item.description} | Qty ${item.quantity} | Net ${formatMoney(item.unit_price_net)} | Line ${formatMoney(item.gross_total)}`),
    "",
    `Subtotal net: ${formatMoney(invoice.subtotal_net)}`,
    vatRegistered ? `VAT: ${formatMoney(invoice.vat_amount)}` : (settings.noVatNote || ""),
    `Total: ${formatMoney(invoice.total_gross)}`,
    `Paid: ${formatMoney(invoice.amount_paid)}`,
    `Outstanding: ${formatMoney(invoice.amount_outstanding)}`,
    "",
    "Payment instructions",
    invoice.payment_instructions || paymentInstructions(settings),
    invoice.notes ? `Notes: ${invoice.notes}` : "",
    "",
    settings.website || ""
  ].filter((line) => line !== "");
}

function buildSimplePdf(lines) {
  const escaped = lines.flatMap((line) => wrapPdfLine(line, 90)).map((line) => `(${pdfEscape(line)}) Tj`).join("\n0 -15 Td\n");
  const stream = `BT\n/F1 10 Tf\n50 790 Td\n${escaped}\nET`;
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
    "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    `5 0 obj << /Length ${Buffer.byteLength(stream)} >> stream\n${stream}\nendstream endobj`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${object}\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

function invoiceEmailDraft(invoice, settings) {
  const type = titleCase(invoice.invoice_type);
  return {
    subject: `${type} invoice ${invoice.invoice_number || ""}`.trim(),
    body: [
      `Hi ${invoice.customer_name || "there"},`,
      "",
      `Please find ${type.toLowerCase()} invoice ${invoice.invoice_number || ""} for the garage door work.`,
      `Amount outstanding: ${formatMoney(invoice.amount_outstanding)}.`,
      `Due date: ${invoice.due_date || "as shown on the invoice"}.`,
      "",
      invoice.payment_instructions || paymentInstructions(settings),
      "",
      "Kind regards,",
      settings.tradingName || settings.companyLegalName
    ].join("\n")
  };
}

function invoiceRows(invoices) {
  return [["ID", "Number", "Type", "Lead ID", "Customer", "Date", "Due", "Status", "Net", "VAT", "Gross", "Paid", "Outstanding"], ...(invoices || []).map((invoice) => [invoice.invoice_id, invoice.invoice_number, invoice.invoice_type, invoice.lead_id, invoice.customer_name, invoice.invoice_date, invoice.due_date, invoice.status, invoice.subtotal_net, invoice.vat_amount, invoice.total_gross, invoice.amount_paid, invoice.amount_outstanding])];
}

function nextInvoiceNumber(state) {
  const settings = state.companySettings;
  const next = Math.max(Number.parseInt(settings.nextInvoiceNumber, 10) || 1, highestIssuedNumber(state, settings.invoicePrefix) + 1);
  const invoiceNumber = `${settings.invoicePrefix || ""}${String(next).padStart(6, "0")}`;
  settings.nextInvoiceNumber = next + 1;
  return invoiceNumber;
}

function highestIssuedNumber(state, prefix = "") {
  return (state.customerInvoices || []).reduce((highest, invoice) => {
    const value = String(invoice.invoice_number || "");
    if (prefix && !value.startsWith(prefix)) return highest;
    const parsed = Number.parseInt(value.slice(prefix.length).replace(/[^\d]/g, ""), 10);
    return Number.isFinite(parsed) ? Math.max(highest, parsed) : highest;
  }, 0);
}

function paymentInstructions(settings) {
  const rows = [];
  if (settings.bankAccountName) rows.push(`Account name: ${settings.bankAccountName}`);
  if (settings.sortCode) rows.push(`Sort code: ${settings.sortCode}`);
  if (settings.accountNumber) rows.push(`Account number: ${settings.accountNumber}`);
  rows.push(`Payment reference: ${settings.paymentReferenceFormat || "Invoice number"}`);
  return rows.join("\n");
}

function addDays(value, days) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  date.setDate(date.getDate() + (Number.parseInt(days, 10) || 0));
  return date.toISOString().slice(0, 10);
}

function invoiceDescription(invoiceType, lead) {
  const base = lead.jobDescription || "Garage door works";
  if (invoiceType === "deposit") return `Deposit for ${base}`;
  if (invoiceType === "balance") return `Balance for ${base}`;
  if (invoiceType === "pro_forma") return `Payment request for ${base}`;
  return base;
}

function defaultInvoiceNotes(invoiceType) {
  if (invoiceType === "deposit") return "Deposit invoice for accepted works.";
  if (invoiceType === "balance") return "Balance due following completed works.";
  if (invoiceType === "final") return "Final invoice for completed works.";
  return "";
}

function normaliseInvoiceType(value) {
  const normalised = String(value || "final").toLowerCase().replace(/[\s-]+/g, "_");
  return INVOICE_TYPES.includes(normalised) ? normalised : "final";
}

function safeParseItems(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function sum(items, fn) {
  return (items || []).reduce((total, item) => money(total + money(fn(item))), 0);
}

function isPast(value, now = new Date()) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return date < today;
}

function isTrue(value) {
  return ["true", "yes", "1", "on", true].includes(String(value).toLowerCase()) || value === true;
}

function titleCase(value) {
  return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function pdfEscape(value) {
  return String(value || "").replace(/[()\\]/g, "\\$&");
}

function wrapPdfLine(value, width) {
  const text = String(value || "");
  if (text.length <= width) return [text];
  const words = text.split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    if (`${current} ${word}`.trim().length > width) {
      lines.push(current);
      current = word;
    } else {
      current = `${current} ${word}`.trim();
    }
  }
  if (current) lines.push(current);
  return lines;
}

function safeFilename(value) {
  return String(value || "invoice").replace(/[^A-Za-z0-9._-]+/g, "-");
}

module.exports = {
  INVOICE_STATUSES,
  INVOICE_TYPES,
  ensureOperationsState,
  defaultCompanySettings,
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
  invoiceRows,
  nextInvoiceNumber
};
