const path = require("node:path");
const siteground = require("./siteground");

async function listMessages(config) {
  const fixtureDir = path.resolve(config.sitegroundFixtureDir || "fixtures/siteground-emails");
  return siteground.listFixtureMessages(fixtureDir);
}

async function listCandidateMessages(config, filterFn) {
  const messages = await listMessages(config);
  return filterFn ? messages.filter(filterFn) : messages;
}

async function markProcessed() {
  return true;
}

async function createDraft(message, draft) {
  return {
    id: `fixture-draft:${message.id}`,
    link: `Draft stored in tracker only (${draft.subject})`
  };
}

module.exports = { listMessages, listCandidateMessages, markProcessed, createDraft };
