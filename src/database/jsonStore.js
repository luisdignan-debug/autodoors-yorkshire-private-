const fs = require("node:fs");
const path = require("node:path");

const EMPTY_STATE = {
  leads: [],
  jobEvents: [],
  supplierEmails: [],
  supplierInvoices: [],
  customerInvoices: [],
  customerPayments: [],
  supplierPayments: [],
  technicians: [],
  workOrders: [],
  messageLogs: [],
  companySettings: {},
  systemBackups: [],
  processedMessageIds: [],
  logs: []
};

class JsonStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.providerName = "json";
    this.isDurable = false;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.state = this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) return structuredClone(EMPTY_STATE);
    try {
      return { ...structuredClone(EMPTY_STATE), ...JSON.parse(fs.readFileSync(this.filePath, "utf8")) };
    } catch (error) {
      throw new Error(`Could not read local tracker database: ${error.message}`);
    }
  }

  save() {
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  hasProcessed(messageId) {
    return this.state.processedMessageIds.includes(messageId);
  }

  markProcessed(messageId) {
    if (!this.hasProcessed(messageId)) this.state.processedMessageIds.push(messageId);
  }

  addLead(lead) {
    this.state.leads.push(lead);
  }

  addJobEvent(event) {
    this.state.jobEvents.push({
      id: event.id || `event:${Date.now()}:${this.state.jobEvents.length + 1}`,
      createdAt: event.createdAt || new Date().toISOString(),
      createdBy: event.createdBy || "system",
      ...event
    });
  }

  addSupplierEmail(email) {
    this.state.supplierEmails.push({
      id: email.id || `supplier-email:${Date.now()}:${this.state.supplierEmails.length + 1}`,
      createdAt: email.createdAt || new Date().toISOString(),
      reviewStatus: email.reviewStatus || "Needs review",
      ...email
    });
  }

  updateLead(id, patch) {
    const lead = this.state.leads.find((item) => item.id === id);
    if (!lead) return null;
    Object.assign(lead, patch, { updatedAt: new Date().toISOString() });
    return lead;
  }

  addLog(level, message, details = {}) {
    this.state.logs.push({
      timestamp: new Date().toISOString(),
      level,
      message,
      details
    });
  }
}

module.exports = { JsonStore, EMPTY_STATE };
