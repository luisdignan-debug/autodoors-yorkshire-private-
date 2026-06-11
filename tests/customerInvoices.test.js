const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConfig } = require("../src/config");
const {
  ensureOperationsState,
  updateCompanySettings,
  companySetupWarnings,
  createCustomerInvoice,
  createInvoiceFromLead,
  issueInvoice,
  markInvoicePaid,
  calculateInvoiceTotals,
  generateInvoicePdf
} = require("../src/customerInvoices");
const { createCustomerPayment } = require("../src/finance");

test("invoice total calculation supports net, VAT and gross", () => {
  const totals = calculateInvoiceTotals([
    { description: "Door", quantity: 1, unit_price_net: 1000, vat_rate: 20, net_total: 1000, vat_total: 200, gross_total: 1200 },
    { description: "Labour", quantity: 2, unit_price_net: 100, vat_rate: 20, net_total: 200, vat_total: 40, gross_total: 240 }
  ], { vatRegistered: true, defaultVatRate: 20 });

  assert.equal(totals.subtotalNet, 1200);
  assert.equal(totals.vatAmount, 240);
  assert.equal(totals.totalGross, 1440);
});

test("invoice numbering is sequential and numbers are not reused after void", () => {
  const state = {};
  const config = loadConfig({ VAT_REGISTERED: "true", VAT_REGISTRATION_NUMBER: "GB123" });
  ensureOperationsState(state, config);
  updateCompanySettings(state, {
    companyLegalName: "YORKSHIRE AUTO DOORS LTD",
    companyNumber: "14637200",
    registeredOfficeAddress: "Office",
    bankAccountName: "YORKSHIRE AUTO DOORS LTD",
    sortCode: "00-00-00",
    accountNumber: "00000000",
    invoicePrefix: "ADY-",
    nextInvoiceNumber: "7",
    vatRegistered: "true",
    vatRegistrationNumber: "GB123",
    defaultVatRate: "20",
    defaultPaymentTerms: "7"
  }, config);
  const first = createCustomerInvoice({ description: "Deposit", unit_price_net: "100" }, { id: "LEAD-1" }, state, config);
  issueInvoice(first, state, config);
  first.status = "void";
  const second = createCustomerInvoice({ description: "Balance", unit_price_net: "200" }, { id: "LEAD-1" }, state, config);
  issueInvoice(second, state, config);

  assert.equal(first.invoice_number, "ADY-000007");
  assert.equal(second.invoice_number, "ADY-000008");
});

test("deposit, balance and final invoice drafts can be generated from lead data", () => {
  const state = {};
  const config = loadConfig({});
  ensureOperationsState(state, config);
  const lead = { id: "LEAD-1", customerName: "Jane", customerEmail: "jane@example.com", quote_amount: "1200", deposit_amount: "300", jobDescription: "New roller door" };

  const deposit = createInvoiceFromLead(lead, "deposit", state, { ...config, finance: { customerOutstanding: 900 } });
  const balance = createInvoiceFromLead(lead, "balance", state, { ...config, finance: { customerOutstanding: 900 } });
  const final = createInvoiceFromLead(lead, "final", state, { ...config, finance: { customerOutstanding: 900 } });

  assert.equal(deposit.invoice_type, "deposit");
  assert.equal(deposit.total_gross, 300);
  assert.equal(balance.total_gross, 900);
  assert.equal(final.total_gross, 1200);
});

test("mark invoice paid can feed the existing customer payment model", () => {
  const state = {};
  const config = loadConfig({});
  ensureOperationsState(state, config);
  const invoice = createCustomerInvoice({ leadId: "LEAD-1", description: "Balance", unit_price_net: "500" }, { id: "LEAD-1" }, state, config);
  issueInvoice(invoice, state, config);
  markInvoicePaid(invoice, "500", "2026-06-06");
  const payment = createCustomerPayment({ leadId: "LEAD-1", payment_type: "balance", amount: "500", reference: invoice.invoice_number }, "LEAD-1");

  assert.equal(invoice.status, "paid");
  assert.equal(invoice.amount_outstanding, 0);
  assert.equal(payment.paymentType, "balance");
  assert.equal(payment.reference, invoice.invoice_number);
});

test("PDF invoices are generated and missing settings warnings are surfaced", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ady-invoices-"));
  const state = {};
  const config = loadConfig({ INVOICE_PDF_DIR: dir });
  ensureOperationsState(state, config);
  const invoice = createCustomerInvoice({ leadId: "LEAD-1", description: "Final works", unit_price_net: "250" }, { id: "LEAD-1", customerName: "Jane" }, state, config);
  issueInvoice(invoice, state, config);
  const pdfPath = generateInvoicePdf(invoice, state.companySettings, config);

  assert.ok(fs.existsSync(pdfPath));
  assert.ok(fs.statSync(pdfPath).size > 100);
  assert.ok(companySetupWarnings(state.companySettings).some((warning) => /Bank payment/.test(warning)));
});
