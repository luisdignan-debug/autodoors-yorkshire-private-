const { authenticateCheckatrade } = require("./auth");
const { scrapeCheckatradeEnquiries } = require("./scraper");
const { normaliseDashboardLead } = require("./normalizer");
const { scoreLead } = require("../leadScoring");
const { findDuplicate } = require("../dedupe");
const { generateDraftReply } = require("../draftGenerator");
const { writeTrackerWorkbook } = require("../sheetProvider/excel");
const { addDays } = require("../processor");

async function runCheckatradeLogin({ config, logger }) {
  return authenticateCheckatrade(config, logger);
}

async function runCheckatradeCollection({ config, store, logger, rawEnquiries }) {
  const raw = rawEnquiries || (await scrapeCheckatradeEnquiries(config, logger));
  const summary = { scanned: raw.length, added: 0, duplicates: 0, updated: 0, dryRun: config.dryRun };
  const leads = raw.map((item) => normaliseDashboardLead(item, config));

  for (const lead of leads) {
    const duplicate = findDuplicate(lead, store.state.leads);
    if (duplicate) {
      lead.status = "Duplicate";
      lead.notes = `Dashboard duplicate of ${duplicate.existing.id}: ${duplicate.reason}`;
      lead.priorityScore = 0;
      lead.priorityLabel = "Low";
      summary.duplicates += 1;
      continue;
    }

    Object.assign(lead, scoreLead(lead, config));
    lead.status = nextStatusFor(lead);
    lead.nextAction = lead.status === "Needs call" ? "Call customer before drafting final reply" : "Review draft reply";
    lead.followUpDate = addDays(lead.receivedAt, config.followUpDelayDays);
    const draft = generateDraftReply(lead, config);
    lead.draftSubject = draft.subject;
    lead.draftReply = draft.body;
    lead.draftReplyCreated = "yes";
    lead.draftEmailIdLink = "Stored in tracker for review";
    summary.added += 1;

    if (!config.dryRun) {
      store.addLead(lead);
      store.markProcessed(lead.originalMessageId);
      store.addLog("info", "Checkatrade dashboard lead processed", { leadId: lead.id, status: lead.status });
    }
  }

  if (!config.dryRun) {
    await store.save();
    writeTrackerWorkbook(config.trackerXlsxPath, store.state, config);
  }

  return { summary, leads };
}

async function runScheduledCheckatrade({ config, store, logger, once = true }) {
  const runOnce = async () => {
    const result = await runCheckatradeCollection({ config, store, logger });
    logger.info("Checkatrade dashboard collection complete", result.summary);
    return result;
  };
  const first = await runOnce();
  if (once) return first;
  const intervalMs = config.checkatradeDashboard.pollIntervalMinutes * 60 * 1000;
  setInterval(() => runOnce().catch((error) => logger.error("Scheduled Checkatrade run failed", { error: error.message })), intervalMs);
  return first;
}

function nextStatusFor(lead) {
  if (!lead.customerPhone && !lead.customerEmail) return "Needs call";
  if (/photos|door type|postcode/.test(lead.missingInformationChecklist || "")) return "Awaiting photos";
  return "Awaiting approval";
}

module.exports = {
  runCheckatradeLogin,
  runCheckatradeCollection,
  runScheduledCheckatrade,
  nextStatusFor
};
