const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { loadConfig } = require("../src/config");
const { JsonStore } = require("../src/database/jsonStore");
const { startAppServer } = require("../src/admin/appServer");
const { ensureOperationsState } = require("../src/customerInvoices");

test("admin dashboard serves health and creates manual lead", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-app-"));
  const config = loadConfig({
    APP_PORT: "0",
    DRY_RUN: "false",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "password",
    DATABASE_PATH: path.join(dir, "db.json"),
    TRACKER_XLSX_PATH: path.join(dir, "tracker.xlsx")
  });
  const store = new JsonStore(config.databasePath);
  const logger = { error() {}, warn() {}, info() {} };
  const server = startAppServer({ config, store, logger });
  try {
    const { port } = server.address();
    const health = await request({ port, path: "/health" });
    assert.equal(health.statusCode, 200);

    const sessionCookie = await getSessionCookie(port, "admin", "password");

    const body = new URLSearchParams({
      message: "Customer needs cable repair. Door was forced down and may be insecure.",
      customerName: "Jane Smith",
      customerPhone: "07700 900555",
      customerAddress: "12 Market Street, Huddersfield, HD1 2AB",
      postcode: "HD1 2AB",
      source: "Manual lead"
    }).toString();
    const created = await request({ port, path: "/manual-lead", method: "POST", body, cookie: sessionCookie });
    assert.equal(created.statusCode, 303);
    assert.equal(store.state.leads.length, 1);
    assert.match(store.state.leads[0].draftReply, /cable\/spring repair/i);
    assert.equal(store.state.leads[0].customerAddress, "12 Market Street, Huddersfield, HD1 2AB");

    const dashboard = await request({ port, path: "/dashboard", cookie: sessionCookie });
    assert.equal(dashboard.statusCode, 200);
    assert.match(dashboard.body, /Active queues/);
    assert.match(dashboard.body, /Today&#39;s actions|Today\\'s actions|Today's actions/);
    assert.match(dashboard.body, /Pipeline board/);
    assert.match(dashboard.body, /Active jobs/);
    assert.match(dashboard.body, /System snapshot/);
    assert.match(dashboard.body, /Technician focus/);
    assert.match(dashboard.body, /Financial snapshot/);
    assert.match(dashboard.body, /today-money-strip|today-accordion|mobile-bottom-nav/);

    const leads = await request({ port, path: "/leads", cookie: sessionCookie });
    assert.equal(leads.statusCode, 200);
    assert.match(leads.body, /Bulk action/);
    assert.match(leads.body, /select-all-leads/);

    const status = await request({ port, path: "/status", cookie: sessionCookie });
    assert.equal(status.statusCode, 200);
    assert.match(status.body, /Operating status/);
    assert.match(status.body, /Storage/);
    assert.match(status.body, /Tracker totals/);

    const exported = await request({ port, path: "/export/tracker", cookie: sessionCookie });
    assert.equal(exported.statusCode, 200);
    assert.match(exported.headers["content-type"], /spreadsheetml/);
    assert.ok(exported.body.length > 100);

    const leadId = store.state.leads[0].id;
    const archived = await request({
      port,
      path: "/leads/bulk",
      method: "POST",
      body: new URLSearchParams({ leadId, bulkAction: "archive", targetStatus: "Awaiting approval" }).toString(),
      cookie: sessionCookie
    });
    assert.equal(archived.statusCode, 303);
    assert.equal(store.state.leads[0].status, "Archived");

    const moved = await request({
      port,
      path: "/leads/bulk",
      method: "POST",
      body: new URLSearchParams({ leadId, bulkAction: "set_status", targetStatus: "Needs call" }).toString(),
      cookie: sessionCookie
    });
    assert.equal(moved.statusCode, 303);
    assert.equal(store.state.leads[0].status, "Needs call");
    assert.equal(store.state.leads[0].nextAction, "Call customer");

    const detail = await request({ port, path: `/leads/${encodeURIComponent(leadId)}`, cookie: sessionCookie });
    assert.equal(detail.statusCode, 200);
    assert.match(detail.body, /workflow-rail/);
    assert.match(detail.body, /Check Royal Mail/);
    assert.match(detail.body, /Customer details/);
    assert.match(detail.body, /Installation completed/);
    assert.match(detail.body, /Closed/);
    // ay- design system lead detail chrome present
    assert.match(detail.body, /ay-back-link/);
    assert.match(detail.body, /ay-page-title/);
    assert.match(detail.body, /ay-next-action/);

    const editedLeadDetails = await request({
      port,
      path: `/leads/${encodeURIComponent(leadId)}`,
      method: "POST",
      body: new URLSearchParams({
        customerName: "Jane Taylor",
        customerPhone: "07700 900777",
        customerEmail: "jane@example.test",
        customerAddress: "14 Market Street, Huddersfield",
        customerPostcode: "HD2 1AB",
        customerTownArea: "Huddersfield",
        sourcePlatform: "Phone",
        addressVerificationStatus: "Customer confirmed",
        status: "Awaiting approval",
        followUpDate: "2026-06-10",
        notes: "Corrected customer details"
      }).toString(),
      cookie: sessionCookie
    });
    assert.equal(editedLeadDetails.statusCode, 303);
    assert.equal(store.state.leads[0].customerName, "Jane Taylor");
    assert.equal(store.state.leads[0].customerPhone, "07700 900777");
    assert.equal(store.state.leads[0].customerEmail, "jane@example.test");
    assert.equal(store.state.leads[0].customerAddress, "14 Market Street, Huddersfield");
    assert.equal(store.state.leads[0].customerPostcode, "HD21AB");
    assert.equal(store.state.leads[0].customerTownArea, "Huddersfield");
    assert.equal(store.state.leads[0].sourcePlatform, "Phone");
    assert.equal(store.state.leads[0].addressVerificationStatus, "Customer confirmed");
    assert.match(store.state.leads[0].addressVerificationUrl, /HD21AB/);

    const restored = await request({
      port,
      path: "/leads/bulk",
      method: "POST",
      body: new URLSearchParams({ leadId, bulkAction: "restore", targetStatus: "Awaiting approval" }).toString(),
      cookie: sessionCookie
    });
    assert.equal(restored.statusCode, 303);
    assert.equal(store.state.leads[0].status, "Awaiting approval");

    const quoteSent = await request({
      port,
      path: `/leads/${encodeURIComponent(leadId)}`,
      method: "POST",
      body: new URLSearchParams({ workflowAction: "mark_quote_sent", quote_amount: "240", quote_reference: "Q-100", quote_sent_at: "2026-06-02" }).toString(),
      cookie: sessionCookie
    });
    assert.equal(quoteSent.statusCode, 303);
    assert.equal(store.state.leads[0].status, "Quoted");
    assert.ok(fs.existsSync(config.trackerXlsxPath));

    const depositPaid = await request({
      port,
      path: `/leads/${encodeURIComponent(leadId)}`,
      method: "POST",
      body: new URLSearchParams({ workflowAction: "mark_deposit_received", deposit_amount: "80", deposit_payment_method: "Bank transfer", deposit_received_at: "2026-06-03", deposit_payment_reference: "DEP-1" }).toString(),
      cookie: sessionCookie
    });
    assert.equal(depositPaid.statusCode, 303);
    assert.equal(store.state.customerPayments.length, 1);
    assert.equal(store.state.customerPayments[0].paymentMethod, "Bank transfer");
    const customerPaymentId = store.state.customerPayments[0].id;

    const editedCustomerPayment = await request({
      port,
      path: `/finance/customer-payments/${encodeURIComponent(customerPaymentId)}/edit`,
      method: "POST",
      body: new URLSearchParams({ leadId, payment_type: "deposit", amount: "90", payment_method: "Card", payment_date: "2026-06-03", reference: "DEP-EDIT", notes: "Edited payment" }).toString(),
      cookie: sessionCookie
    });
    assert.equal(editedCustomerPayment.statusCode, 303);
    assert.equal(store.state.customerPayments[0].amount, 90);
    assert.equal(store.state.customerPayments[0].paymentMethod, "Card");

    const supplierInvoice = await request({
      port,
      path: "/finance/supplier-invoices",
      method: "POST",
      body: new URLSearchParams({ leadId, supplier_name: "Door Supplier", invoice_reference: "INV-100", invoice_date: "2026-06-04", due_date: "2026-06-14", net_amount: "100", vat_amount: "20", gross_amount: "120", amount_paid: "40", payment_method: "Card" }).toString(),
      cookie: sessionCookie
    });
    assert.equal(supplierInvoice.statusCode, 303);
    assert.equal(store.state.supplierInvoices.length, 1);
    assert.equal(store.state.supplierInvoices[0].amountOutstanding, 80);

    const invoiceId = store.state.supplierInvoices[0].id;
    const supplierPayment = await request({
      port,
      path: "/finance/supplier-payments",
      method: "POST",
      body: new URLSearchParams({ invoiceId, amount: "40", payment_method: "Bank transfer", paid_at: "2026-06-05", reference: "SUP-1" }).toString(),
      cookie: sessionCookie
    });
    assert.equal(supplierPayment.statusCode, 303);
    assert.equal(store.state.supplierPayments.length, 2);
    assert.equal(store.state.supplierInvoices[0].amountOutstanding, 40);

    const supplierPaymentId = store.state.supplierPayments.at(-1).id;
    const editedSupplierPayment = await request({
      port,
      path: `/finance/supplier-payments/${encodeURIComponent(supplierPaymentId)}/edit`,
      method: "POST",
      body: new URLSearchParams({ invoiceId, amount: "20", payment_method: "Card", paid_at: "2026-06-06", reference: "SUP-EDIT", notes: "Edited supplier payment" }).toString(),
      cookie: sessionCookie
    });
    assert.equal(editedSupplierPayment.statusCode, 303);
    assert.equal(store.state.supplierPayments.at(-1).amount, 20);
    assert.equal(store.state.supplierInvoices[0].amountOutstanding, 60);

    const deletedSupplierPayment = await request({
      port,
      path: `/finance/supplier-payments/${encodeURIComponent(supplierPaymentId)}/delete`,
      method: "POST",
      cookie: sessionCookie
    });
    assert.equal(deletedSupplierPayment.statusCode, 303);
    assert.equal(store.state.supplierPayments.some((payment) => payment.id === supplierPaymentId), false);
    assert.equal(store.state.supplierInvoices[0].amountOutstanding, 80);

    const archivedCustomerPayment = await request({
      port,
      path: `/finance/customer-payments/${encodeURIComponent(customerPaymentId)}/archive`,
      method: "POST",
      cookie: sessionCookie
    });
    assert.equal(archivedCustomerPayment.statusCode, 303);
    assert.ok(store.state.customerPayments[0].archivedAt);

    const deletedCustomerPayment = await request({
      port,
      path: `/finance/customer-payments/${encodeURIComponent(customerPaymentId)}/delete`,
      method: "POST",
      cookie: sessionCookie
    });
    assert.equal(deletedCustomerPayment.statusCode, 303);
    assert.equal(store.state.customerPayments.length, 0);

    const finance = await request({ port, path: "/finance", cookie: sessionCookie });
    assert.equal(finance.statusCode, 200);
    assert.match(finance.body, /Pipeline summary/);
    assert.match(finance.body, /Supplier invoices outstanding/);
    assert.match(finance.body, /Latest customer payments/);
    assert.match(finance.body, /Latest supplier payments/);

    const system = await request({ port, path: "/system", cookie: sessionCookie });
    assert.equal(system.statusCode, 200);
    assert.match(system.body, /Data permanence audit/);
    assert.match(system.body, /Using SQLite/);

    const csv = await request({ port, path: "/export/supplier-invoices.csv", cookie: sessionCookie });
    assert.equal(csv.statusCode, 200);
    assert.match(csv.body, /INV-100/);

    const editedInvoice = await request({
      port,
      path: `/finance/supplier-invoices/${encodeURIComponent(invoiceId)}/edit`,
      method: "POST",
      body: new URLSearchParams({ leadId, supplier_name: "Door Supplier", invoice_reference: "INV-101", invoice_date: "2026-06-04", due_date: "2026-06-20", net_amount: "100", vat_amount: "20", gross_amount: "120", amount_paid: "120", payment_status: "Paid", payment_method: "Bank transfer" }).toString(),
      cookie: sessionCookie
    });
    assert.equal(editedInvoice.statusCode, 303);
    assert.equal(store.state.supplierInvoices[0].invoiceReference, "INV-101");
    assert.equal(store.state.supplierInvoices[0].amountOutstanding, 0);

    const resetSupplierFinance = await request({
      port,
      path: "/system/reset-supplier-finance",
      method: "POST",
      cookie: sessionCookie
    });
    assert.equal(resetSupplierFinance.statusCode, 303);
    assert.ok(store.state.supplierInvoices[0].archivedAt);
    assert.equal(store.state.supplierInvoices[0].paymentStatus, "Archived");
    assert.ok(store.state.supplierPayments.every((payment) => payment.archivedAt));
    assert.equal(store.state.logs.length, 0);
    assert.equal(store.state.jobEvents.length, 0);

    const archivedInvoice = await request({
      port,
      path: `/finance/supplier-invoices/${encodeURIComponent(invoiceId)}/archive`,
      method: "POST",
      cookie: sessionCookie
    });
    assert.equal(archivedInvoice.statusCode, 303);
    assert.equal(store.state.supplierInvoices[0].paymentStatus, "Archived");

    const deletedInvoice = await request({
      port,
      path: `/finance/supplier-invoices/${encodeURIComponent(invoiceId)}/delete`,
      method: "POST",
      cookie: sessionCookie
    });
    assert.equal(deletedInvoice.statusCode, 303);
    assert.equal(store.state.supplierInvoices.length, 0);

    store.addSupplierEmail({
      id: "supplier-email:test",
      emailMessageId: "msg-supplier",
      supplierName: "Door Supplier",
      supplierEmail: "orders@supplier.example",
      subject: "Order confirmation",
      receivedAt: "2026-06-04T09:00:00.000Z",
      extractedOrderReference: "SO-1",
      reviewStatus: "Needs review",
      rawSummary: "Order confirmation for HD1 2AB"
    });
    const supplierList = await request({ port, path: "/supplier-emails", cookie: sessionCookie });
    assert.equal(supplierList.statusCode, 200);
    assert.match(supplierList.body, /Supplier email review items/);

    const supplierDetail = await request({ port, path: "/supplier-emails/supplier-email%3Atest", cookie: sessionCookie });
    assert.equal(supplierDetail.statusCode, 200);
    assert.match(supplierDetail.body, /Link to job/);

    const linkedSupplier = await request({
      port,
      path: "/supplier-emails/supplier-email%3Atest/link-job",
      method: "POST",
      body: new URLSearchParams({ leadId }).toString(),
      cookie: sessionCookie
    });
    assert.equal(linkedSupplier.statusCode, 303);
    assert.equal(store.state.supplierEmails[0].matchedLeadId, leadId);
    assert.equal(store.state.supplierEmails[0].reviewStatus, "Linked");

    const clearActivity = await request({
      port,
      path: "/system/clear-activity",
      method: "POST",
      cookie: sessionCookie
    });
    assert.equal(clearActivity.statusCode, 303);
    assert.equal(store.state.logs.length, 0);
    assert.equal(store.state.jobEvents.length, 0);

    const archivedSupplier = await request({
      port,
      path: "/supplier-emails/supplier-email%3Atest/archive",
      method: "POST",
      cookie: sessionCookie
    });
    assert.equal(archivedSupplier.statusCode, 303);
    assert.equal(store.state.supplierEmails[0].reviewStatus, "Archived");

    const deleted = await request({
      port,
      path: "/leads/bulk",
      method: "POST",
      body: new URLSearchParams({ leadId, bulkAction: "delete", targetStatus: "Awaiting approval" }).toString(),
      cookie: sessionCookie
    });
    assert.equal(deleted.statusCode, 303);
    assert.equal(store.state.leads.length, 0);
    assert.match(store.state.logs.at(-1).message, /deleted/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("ensureOperationsState backfills legacy work order dispatch fields", () => {
  const state = {
    workOrders: [{
      id: "legacy-wo-1",
      technician_status: "confirmed",
      logs: [{ event_type: "legacy" }]
    }]
  };

  ensureOperationsState(state, loadConfig({}));

  assert.equal(state.workOrders[0].customer_email, "");
  assert.equal(state.workOrders[0].technician_status, "confirmed");
  assert.equal(state.workOrders[0].customer_confirmation_status, "not_sent");
  assert.equal(state.workOrders[0].risk_level, "grey");
  assert.equal(state.workOrders[0].internal_notes, "");
  assert.equal(state.workOrders[0].calendar_uid, "legacy-wo-1@autodoorsyorkshire.com");
  assert.equal(state.workOrders[0].calendar_sequence, 0);
  assert.deepEqual(state.workOrders[0].logs, [{ event_type: "legacy" }]);
});

test("work order notify route records dispatch intent without sending messages", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-work-order-"));
  const config = loadConfig({
    APP_PORT: "0",
    DRY_RUN: "false",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "password",
    DATABASE_PATH: path.join(dir, "db.json"),
    TRACKER_XLSX_PATH: path.join(dir, "tracker.xlsx")
  });
  const store = new JsonStore(config.databasePath);
  store.state.leads = [{ id: "lead-route-1", customerName: "Jane Smith" }];
  store.state.technicians = [{ id: "tech-route-1", name: "Luis", active: true }];
  store.state.workOrders = [{
    id: "work-order-route-1",
    lead_id: "lead-route-1",
    job_id: "lead-route-1",
    technician_id: "tech-route-1",
    scheduled_start: "2026-06-06T09:00",
    scheduled_end: "2026-06-06T11:00",
    status: "scheduled"
  }];
  store.state.messageLogs = [];
  const logger = { error() {}, warn() {}, info() {} };
  const server = startAppServer({ config, store, logger });
  try {
    const { port } = server.address();
    const sessionCookie = await getSessionCookie(port, "admin", "password");
    const notified = await request({
      port,
      path: "/work-orders/work-order-route-1/notify-technician",
      method: "POST",
      cookie: sessionCookie
    });

    assert.equal(notified.statusCode, 303);
    assert.equal(notified.headers.location, "/work-orders/work-order-route-1");
    assert.equal(store.state.workOrders[0].technician_status, "notified");
    assert.ok(store.state.workOrders[0].last_digest_sent_at);
    assert.equal(store.state.workOrders[0].logs.at(-1).event_type, "technician_notified");
    assert.equal(store.state.messageLogs.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function request({ port, path, method = "GET", body = "", cookie = "" }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(body ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } : {}),
          ...(cookie ? { cookie } : {})
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve({ statusCode: res.statusCode, body: data, headers: res.headers }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getSessionCookie(port, username, password) {
  const body = new URLSearchParams({ username, password, next: "/today" }).toString();
  const res = await request({ port, path: "/login", method: "POST", body });
  const setCookie = res.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : (setCookie || "");
  return cookieHeader.split(";")[0];
}
