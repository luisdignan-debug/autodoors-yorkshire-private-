const { Client } = require("pg");
const { EMPTY_STATE } = require("./jsonStore");

const DEFAULT_DOCUMENT_ID = "main";

class PostgresJsonStore {
  constructor({ client, documentId = DEFAULT_DOCUMENT_ID, state }) {
    this.client = client;
    this.documentId = documentId;
    this.state = state;
    this.providerName = "postgres";
    this.isDurable = true;
  }

  static async create(connectionString, options = {}) {
    if (!connectionString) throw new Error("DATABASE_URL is required when DATABASE_PROVIDER=postgres.");
    const attempts = options.attempts || 5;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await connectPostgresStore(connectionString, options);
      } catch (error) {
        lastError = error;
        if (attempt === attempts) break;
        await delay(options.retryMs || 3000);
      }
    }
    throw lastError;
  }

  async save() {
    await this.client.query("update app_state set state = $2::jsonb, updated_at = now() where id = $1", [
      this.documentId,
      JSON.stringify(this.state)
    ]);
  }

  async close() {
    await this.client.end();
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

async function connectPostgresStore(connectionString, options = {}) {
  const clientOptions = { connectionString, connectionTimeoutMillis: options.connectionTimeoutMillis || 5000 };
  if (options.ssl !== undefined) {
    clientOptions.ssl = options.ssl === false ? false : { rejectUnauthorized: false };
  } else if (/sslmode=require|ssl=true/i.test(connectionString)) {
    clientOptions.ssl = { rejectUnauthorized: false };
  }
  const client = new Client(clientOptions);
  await client.connect();
  await client.query(`
    create table if not exists app_state (
      id text primary key,
      state jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);
  await client.query(
    `insert into app_state (id, state)
     values ($1, $2::jsonb)
     on conflict (id) do nothing`,
    [DEFAULT_DOCUMENT_ID, JSON.stringify(EMPTY_STATE)]
  );
  const result = await client.query("select state from app_state where id = $1", [DEFAULT_DOCUMENT_ID]);
  return new PostgresJsonStore({
    client,
    documentId: DEFAULT_DOCUMENT_ID,
    state: { ...structuredClone(EMPTY_STATE), ...(result.rows[0]?.state || {}) }
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { PostgresJsonStore };
