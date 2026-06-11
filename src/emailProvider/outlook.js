async function listMessages() {
  throw new Error(
    "Outlook live ingestion is not enabled in this dependency-free MVP. Use EMAIL_PROVIDER=mock for test mode, or add authorised Microsoft Graph read/draft scopes before live use."
  );
}

async function markProcessed() {
  throw new Error("Outlook mark-processed requires authorised Microsoft Graph access. Do not use mailbox passwords.");
}

async function createDraft() {
  throw new Error("Outlook draft creation requires authorised Microsoft Graph access and is disabled until credentials are configured.");
}

module.exports = { listMessages, markProcessed, createDraft };
