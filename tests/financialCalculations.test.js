const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateJobFinancials,
  calculateFinanceDashboard,
  calculateFinancialWarnings,
  calculateSupplierInvoiceBalance
} = require("../src/financialCalculations");

test("quote with deposit paid calculates remaining customer balance", () => {
  const lead = leadFixture({ quote_accepted_at: "2026-06-01", quote_amount: "1500", deposit_required: "yes", deposit_received_at: "2026-06-02" });
  const finance = calculateJobFinancials(lead, { customerPayments: [payment({ paymentType: "deposit", amount: "500" })] });

  assert.equal(finance.customer_amount_outstanding, 1000);
  assert.equal(finance.deposit_amount_received, 500);
});

test("deposit and balance paid clears outstanding balance", () => {
  const lead = leadFixture({ quote_accepted_at: "2026-06-01", quote_amount: "1500", deposit_required: "yes", installation_completed_at: "2026-06-10" });
  const finance = calculateJobFinancials(lead, {
    customerPayments: [payment({ paymentType: "deposit", amount: "500" }), payment({ paymentType: "balance", amount: "1000" })]
  });

  assert.equal(finance.customer_amount_outstanding, 0);
  assert.equal(finance.customer_payment_status, "Paid in full");
});

test("installation completed with outstanding balance requests balance", () => {
  const lead = leadFixture({ quote_accepted_at: "2026-06-01", quote_amount: "1500", installation_completed_at: "2026-06-10" });
  const finance = calculateJobFinancials(lead, { customerPayments: [payment({ amount: "500" })] });

  assert.equal(finance.customer_amount_outstanding, 1000);
  assert.equal(finance.customer_payment_status, "Balance due");
});

test("supplier invoice unpaid calculates supplier outstanding", () => {
  const finance = calculateJobFinancials(leadFixture(), { supplierInvoices: [invoice({ grossAmount: "800" })] }, new Date("2026-06-04T12:00:00Z"));

  assert.equal(finance.supplier_amount_outstanding, 800);
  assert.equal(finance.supplier_payment_status, "Payment due");
});

test("supplier invoice part paid calculates outstanding and part paid status", () => {
  const supplierInvoice = invoice({ id: "INV-1", grossAmount: "800" });
  const finance = calculateJobFinancials(leadFixture(), {
    supplierInvoices: [supplierInvoice],
    supplierPayments: [supplierPayment({ invoiceId: "INV-1", amount: "300" })]
  });

  assert.equal(finance.supplier_amount_outstanding, 500);
  assert.equal(finance.supplier_payment_status, "Part paid");
});

test("supplier invoice fully paid clears supplier outstanding", () => {
  const supplierInvoice = invoice({ id: "INV-1", grossAmount: "800" });
  const finance = calculateJobFinancials(leadFixture(), {
    supplierInvoices: [supplierInvoice],
    supplierPayments: [supplierPayment({ invoiceId: "INV-1", amount: "800" })]
  });

  assert.equal(finance.supplier_amount_outstanding, 0);
  assert.equal(finance.supplier_payment_status, "Paid");
});

test("supplier invoice gross is net plus VAT when gross is blank", () => {
  const calculated = calculateSupplierInvoiceBalance(invoice({ netAmount: "1000", vatAmount: "200", grossAmount: "", dueDate: "2026-06-20" }), {}, new Date("2026-06-04T12:00:00Z"));

  assert.equal(calculated.grossAmount, 1200);
  assert.equal(calculated.amountOutstanding, 1200);
  assert.equal(calculated.paymentStatus, "Payment due");
});

test("supplier invoice net paid leaves VAT outstanding", () => {
  const supplierInvoice = invoice({ id: "INV-1", netAmount: "1000", vatAmount: "200", grossAmount: "", dueDate: "2026-06-20" });
  const calculated = calculateSupplierInvoiceBalance(supplierInvoice, {
    supplierPayments: [supplierPayment({ invoiceId: "INV-1", amount: "1000" })]
  }, new Date("2026-06-04T12:00:00Z"));

  assert.equal(calculated.grossAmount, 1200);
  assert.equal(calculated.amountPaid, 1000);
  assert.equal(calculated.amountOutstanding, 200);
  assert.equal(calculated.paymentStatus, "Part paid");
});

test("supplier invoice gross paid in full has zero outstanding", () => {
  const calculated = calculateSupplierInvoiceBalance(invoice({ id: "INV-1", grossAmount: "1200" }), {
    supplierPayments: [supplierPayment({ invoiceId: "INV-1", amount: "1200" })]
  }, new Date("2026-06-04T12:00:00Z"));

  assert.equal(calculated.amountOutstanding, 0);
  assert.equal(calculated.paymentStatus, "Paid");
});

test("supplier invoice overpayment is surfaced for correction", () => {
  const calculated = calculateSupplierInvoiceBalance(invoice({ id: "INV-1", grossAmount: "1200" }), {
    supplierPayments: [supplierPayment({ invoiceId: "INV-1", amount: "1300" })]
  }, new Date("2026-06-04T12:00:00Z"));

  assert.equal(calculated.amountOutstanding, 0);
  assert.equal(calculated.overpaidAmount, 100);
  assert.ok(calculated.warnings.some((warning) => /Overpaid/.test(warning)));
});

test("supplier invoice due date passed with no payment is overdue", () => {
  const calculated = calculateSupplierInvoiceBalance(invoice({ grossAmount: "1200", dueDate: "2026-05-01" }), {}, new Date("2026-06-04T12:00:00Z"));

  assert.equal(calculated.amountOutstanding, 1200);
  assert.equal(calculated.paymentStatus, "Overdue");
});

test("supplier invoice marked paid but still outstanding warns and remains owed", () => {
  const supplierInvoice = invoice({ grossAmount: "1200", amountPaid: "1000", paymentStatus: "Paid" });
  const warnings = calculateFinancialWarnings(leadFixture(), { supplierInvoices: [supplierInvoice] }, new Date("2026-06-04T12:00:00Z"));
  const summary = calculateFinanceDashboard([leadFixture()], { supplierInvoices: [supplierInvoice] }, new Date("2026-06-04T12:00:00Z"));

  assert.ok(warnings.some((warning) => /Marked paid but \u00a3200.00 appears outstanding/.test(warning.message)));
  assert.equal(summary.supplierOutstanding, 200);
});

test("customer overpayment is shown separately", () => {
  const lead = leadFixture({ quote_accepted_at: "2026-06-01", quote_amount: "1500" });
  const finance = calculateJobFinancials(lead, { customerPayments: [payment({ amount: "1600" })] });

  assert.equal(finance.customer_amount_outstanding, 0);
  assert.equal(finance.customer_overpaid_amount, 100);
  assert.equal(finance.customer_payment_status, "Overpaid");
});

test("supplier cost higher than agreed amount creates negative margin warning", () => {
  const lead = leadFixture({ quote_accepted_at: "2026-06-01", quote_amount: "700" });
  const state = { supplierInvoices: [invoice({ grossAmount: "800" })] };
  const finance = calculateJobFinancials(lead, state);
  const warnings = calculateFinancialWarnings(lead, state);

  assert.equal(finance.estimated_gross_margin, -100);
  assert.ok(warnings.some((warning) => /Supplier costs exceed/.test(warning.message)));
});

test("repair job with no supplier order has no supplier financial prompt", () => {
  const lead = leadFixture({ workflow_type: "repair", supplier_order_required: "no", quote_accepted_at: "2026-06-01", quote_amount: "250" });
  const finance = calculateJobFinancials(lead, {});

  assert.equal(finance.total_supplier_invoice_gross, 0);
  assert.equal(finance.supplier_payment_status, "Not invoiced");
});

test("finance dashboard includes customer and supplier cash positions", () => {
  const lead = leadFixture({ quote_accepted_at: "2026-06-01", quote_amount: "1500" });
  const supplierInvoice = invoice({ id: "INV-1", grossAmount: "800" });
  const summary = calculateFinanceDashboard([lead], {
    customerPayments: [payment({ amount: "500" })],
    supplierInvoices: [supplierInvoice],
    supplierPayments: [supplierPayment({ invoiceId: "INV-1", amount: "300" })]
  });

  assert.equal(summary.acceptedJobsValue, 1500);
  assert.equal(summary.customerOutstanding, 1000);
  assert.equal(summary.supplierOutstanding, 500);
  assert.equal(summary.netCashPosition, 500);
});

test("paid supplier invoice does not appear in supplier outstanding total", () => {
  const supplierInvoice = invoice({ id: "INV-1", grossAmount: "1200" });
  const summary = calculateFinanceDashboard([leadFixture()], {
    supplierInvoices: [supplierInvoice],
    supplierPayments: [supplierPayment({ invoiceId: "INV-1", amount: "1200" })]
  }, new Date("2026-06-04T12:00:00Z"));

  assert.equal(summary.supplierOutstanding, 0);
});

test("part-paid supplier invoice contributes only unpaid balance", () => {
  const supplierInvoice = invoice({ id: "INV-1", grossAmount: "1200" });
  const summary = calculateFinanceDashboard([leadFixture()], {
    supplierInvoices: [supplierInvoice],
    supplierPayments: [supplierPayment({ invoiceId: "INV-1", amount: "1000" })]
  }, new Date("2026-06-04T12:00:00Z"));

  assert.equal(summary.supplierOutstanding, 200);
});

test("supplier outstanding total sums unpaid balances not gross totals", () => {
  const firstInvoice = invoice({ id: "INV-1", grossAmount: "1200" });
  const secondInvoice = invoice({ id: "INV-2", grossAmount: "500" });
  const summary = calculateFinanceDashboard([leadFixture()], {
    supplierInvoices: [firstInvoice, secondInvoice],
    supplierPayments: [
      supplierPayment({ invoiceId: "INV-1", amount: "1000" }),
      supplierPayment({ invoiceId: "INV-2", amount: "500" })
    ]
  }, new Date("2026-06-04T12:00:00Z"));

  assert.equal(summary.supplierInvoicesReceived, 1700);
  assert.equal(summary.totalSupplierPaid, 1500);
  assert.equal(summary.supplierOutstanding, 200);
});

test("finance dashboard and lead financial snapshot use supplier invoice helper consistently", () => {
  const lead = leadFixture();
  const supplierInvoice = invoice({ id: "INV-1", netAmount: "1000", vatAmount: "200", grossAmount: "" });
  const state = {
    supplierInvoices: [supplierInvoice],
    supplierPayments: [supplierPayment({ invoiceId: "INV-1", amount: "1000" })]
  };

  const job = calculateJobFinancials(lead, state, new Date("2026-06-04T12:00:00Z"));
  const summary = calculateFinanceDashboard([lead], state, new Date("2026-06-04T12:00:00Z"));

  assert.equal(job.supplier_amount_outstanding, 200);
  assert.equal(summary.supplierOutstanding, 200);
});

function leadFixture(patch = {}) {
  return {
    id: "LEAD-1",
    status: "Won",
    customerName: "Jane",
    quote_amount: "",
    agreed_final_amount: "",
    deposit_required: "no",
    supplier_order_required: "no",
    ...patch
  };
}

function payment(patch = {}) {
  return { id: `PAY-${Math.random()}`, leadId: "LEAD-1", paymentType: "part_payment", amount: "0", paymentDate: "2026-06-02", ...patch };
}

function invoice(patch = {}) {
  return { id: "INV-1", leadId: "LEAD-1", grossAmount: "0", dueDate: "2026-06-20", ...patch };
}

function supplierPayment(patch = {}) {
  return { id: `SP-${Math.random()}`, invoiceId: "INV-1", leadId: "LEAD-1", amount: "0", paidAt: "2026-06-03", ...patch };
}
