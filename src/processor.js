const { getEmailProvider } = require("./emailProvider");
const { parseEnquiryEmail } = require("./parser");
const { scoreLead } = require("./leadScoring");
const { findDuplicate } = require("./dedupe");
const { generateDraftReply } = require("./draftGenerator");
const { ensureJobFields } = require("./jobs/jobStageEngine");
const { isLikelySupplierEmail, processSupplierMessage } = require("./jobs/supplierEmailParser");
const { writeTrackerWorkbook } = require("./sheetProvider/excel");
const { classifyEmailMessage } = require("./emailClassifier");

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result.toISOString().slice(0, 10);
}

async function processMessages({ config, store, logger, messages, provider }) {
  const emailProvider = provider || getEmailProvider(config.emailProvider);
  const sourceMessages = messages || (await emailProvider.listMessages(config));
  const summary = { scanned: sourceMessages.length, added: 0, duplicates: 0, skipped: 0, supplierEmails: 0, supplierReviews: 0, recruitment: 0, spam: 0, admin: 0, nonEnquiries: 0, errors: 0 };

  for (const message of sourceMessages) {
    try {
      if (store.hasProcessed(message.id)) {
        summary.skipped += 1;
        continue;
      }
      const classification = classifyEmailMessage(message, config);
      if (classification.type === "supplier" || isLikelySupplierEmail(message)) {
        const supplierRecord = processSupplierMessage(message, { store });
        store.markProcessed(message.id);
        store.addLog("info", "Supplier email detected", {
          messageId: message.id,
          matchedLeadId: supplierRecord.matchedLeadId || "",
          reviewStatus: supplierRecord.reviewStatus
        });
        if (!config.dryRun) await emailProvider.markProcessed(message, config);
        summary.supplierEmails += 1;
        if (supplierRecord.reviewStatus !== "Linked") summary.supplierReviews += 1;
        continue;
      }
      if (classification.type !== "enquiry") {
        incrementSkippedCategory(summary, classification.type);
        store.addLog("info", "Skipped non-lead email", { messageId: message.id, subject: message.subject, classification: classification.type, reason: classification.reason });
        store.markProcessed(message.id);
        summary.skipped += 1;
        continue;
      }

      const lead = parseEnquiryEmail(message, config);
      const duplicate = findDuplicate(lead, store.state.leads);
      if (duplicate) {
        const duplicateScored = scoreLead(lead, config);
        lead.status = "Duplicate";
        lead.notes = `Possible duplicate of ${duplicate.existing.id}: ${duplicate.reason}`;
        lead.nextAction = "Review existing active lead; no second active lead created";
        lead.priorityScore = 0;
        lead.priorityLabel = "Low";
        lead.postcodePriorityBand = duplicateScored.postcodePriorityBand;
        ensureJobFields(lead);
        store.addLead(lead);
        store.markProcessed(message.id);
        store.addLog("warn", "Duplicate enquiry detected", { messageId: message.id, existingLeadId: duplicate.existing.id, reason: duplicate.reason });
        summary.duplicates += 1;
        continue;
      }

      const scored = scoreLead(lead, config);
      Object.assign(lead, scored);
      lead.nextAction = scored.suggestedNextAction;
      lead.followUpDate = addDays(lead.receivedAt, config.followUpDelayDays);

      if (lead.customerPostcode && scored.inServiceArea === false) {
        lead.status = "Out of area";
        lead.notes = "Out of configured service area; review before sending polite decline draft.";
      } else {
        lead.status = "Awaiting approval";
      }

      const draft = generateDraftReply(lead, config);
      lead.draftSubject = draft.subject;
      lead.draftReply = draft.body;
      lead.draftReplyCreated = "yes";
      lead.draftEmailIdLink = "Stored in tracker for review";

      if (config.createProviderDrafts && !config.dryRun) {
        const draftResult = await emailProvider.createDraft(message, draft, config);
        lead.draftEmailIdLink = draftResult.link || draftResult.id;
      }

      ensureJobFields(lead);
      store.addLead(lead);
      store.markProcessed(message.id);
      store.addLog("info", "Lead processed and draft created", { leadId: lead.id, messageId: message.id, status: lead.status });
      if (!config.dryRun) await emailProvider.markProcessed(message, config);
      summary.added += 1;
    } catch (error) {
      summary.errors += 1;
      logger.error("Could not process message", { messageId: message.id, error: error.message });
      store.addLog("error", "Could not process message", { messageId: message.id, error: error.message });
    }
  }

  await store.save();
  writeTrackerWorkbook(config.trackerXlsxPath, store.state, config);
  return summary;
}

function incrementSkippedCategory(summary, type) {
  if (type === "recruitment") summary.recruitment += 1;
  else if (type === "spam") summary.spam += 1;
  else if (type === "admin") summary.admin += 1;
  else summary.nonEnquiries += 1;
}

module.exports = { processMessages, addDays };
