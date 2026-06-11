async function listMessages() {
  throw new Error(
    "Gmail live ingestion is not enabled in this dependency-free MVP. Use EMAIL_PROVIDER=mock for test mode, or add an authorised Gmail API OAuth client with least-privilege read/draft scopes before live use."
  );
}

async function markProcessed() {
  throw new Error("Gmail mark-processed requires authorised Gmail API access. Do not use mailbox passwords.");
}

async function createDraft() {
  throw new Error("Gmail draft creation requires authorised Gmail API access and is disabled until credentials are configured.");
}

module.exports = { listMessages, markProcessed, createDraft };
