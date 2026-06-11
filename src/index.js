#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("./config");
const { Logger } = require("./logger");
const { createStore } = require("./database/storeFactory");
const { getEmailProvider } = require("./emailProvider");
const { classifyEmailMessage } = require("./emailClassifier");
const { processMessages } = require("./processor");
const { importCsvLeads } = require("./importCsv");
const { writeTrackerWorkbook } = require("./sheetProvider/excel");
const { startWebhookServer, handleWebhookPayload } = require("./checkatradeWebhook/server");
const { runCheckatradeLogin, runCheckatradeCollection, runScheduledCheckatrade } = require("./checkatradeDashboard/runner");
const { startManualReviewServer } = require("./checkatradeDashboard/manualReview");
const { startAppServer } = require("./admin/appServer");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--dry-run") args.dryRun = true;
    else if (value === "--live") args.dryRun = false;
    else if (value === "--csv") {
      args.csv = argv[i + 1];
      i += 1;
    } else if (value === "--payload") {
      args.payload = argv[i + 1];
      i += 1;
    } else if (value === "--provider") {
      args.provider = argv[i + 1];
      i += 1;
    } else if (value === "--selector-debug") {
      args.selectorDebug = true;
    } else if (value === "--watch") {
      args.watch = true;
    } else args._.push(value);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const command = args._[0] || "test-mode";
  const overrides = {};
  if (args.dryRun !== undefined) overrides.DRY_RUN = String(args.dryRun);
  if (args.provider) overrides.EMAIL_PROVIDER = args.provider;
  if (args.selectorDebug) overrides.CHECKATRADE_SELECTOR_DEBUG = "true";
  const config = loadConfig(overrides);
  const logger = new Logger({ level: config.logLevel, databasePath: config.databasePath });
  const store = await createStore(config);

  if (command === "test-mode") {
    if (config.emailProvider === "siteground" && config.dryRun) {
      await printImapCandidateCheck(config);
      return;
    }
    const summary = await processMessages({ config, store, logger });
    console.log(`Test mode complete: scanned ${summary.scanned}, added ${summary.added}, duplicates ${summary.duplicates}, skipped ${summary.skipped}, errors ${summary.errors}.`);
    console.log(`Tracker workbook: ${config.trackerXlsxPath}`);
    return;
  }

  if (command === "import-csv") {
    const csvPath = args.csv ? path.resolve(args.csv) : null;
    if (!csvPath) throw new Error("Please provide a CSV file path with --csv path/to/leads.csv");
    const summary = await importCsvLeads(csvPath, { config, store, logger });
    writeTrackerWorkbook(config.trackerXlsxPath, store.state, config);
    console.log(`CSV import complete: imported ${summary.imported}, duplicates ${summary.duplicates}.`);
    console.log(`Tracker workbook: ${config.trackerXlsxPath}`);
    return;
  }

  if (command === "imap-check") {
    await printImapCandidateCheck(config);
    return;
  }

  if (command === "webhook") {
    startWebhookServer({ config, store, logger });
    return;
  }

  if (command === "app" || command === "dashboard") {
    startAppServer({ config, store, logger });
    return;
  }

  if (command === "db-migrate") {
    await store.save();
    console.log(`Local tracker database ready: ${config.databasePath}`);
    return;
  }

  if (command === "sync-email") {
    const summary = await processMessages({ config, store, logger });
    console.log(`Email sync complete: scanned ${summary.scanned}, added ${summary.added}, duplicates ${summary.duplicates}, skipped ${summary.skipped}, errors ${summary.errors}.`);
    if (config.dryRun) console.log("Dry run only: no live mailbox changes were made.");
    return;
  }

  if (command === "checkatrade-login") {
    await runCheckatradeLogin({ config, logger });
    console.log("Authorised Checkatrade session saved. Keep the session file private and out of Git.");
    return;
  }

  if (command === "checkatrade") {
    const result = args.watch
      ? await runScheduledCheckatrade({ config, store, logger, once: false })
      : await runCheckatradeCollection({ config, store, logger });
    console.log(`Checkatrade dashboard run complete: scanned ${result.summary.scanned}, added ${result.summary.added}, duplicates ${result.summary.duplicates}.`);
    if (config.dryRun) {
      console.log("Dry run only: tracker was not written and no dashboard data was changed.");
      printLeadPreview(result.leads);
    } else {
      console.log(`Tracker workbook: ${config.trackerXlsxPath}`);
    }
    return;
  }

  if (command === "manual-review") {
    startManualReviewServer({ config, store });
    return;
  }

  if (command === "test-webhook-local") {
    const payloadPath = path.resolve(args.payload || "fixtures/sample-webhook.json");
    const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
    const lead = await handleWebhookPayload(payload, { config, store });
    console.log(`Local webhook payload processed: ${lead.id} (${lead.status}).`);
    console.log(`Tracker workbook: ${config.trackerXlsxPath}`);
    return;
  }

  if (command === "export-tracker") {
    writeTrackerWorkbook(config.trackerXlsxPath, store.state, config);
    console.log(`Tracker workbook exported: ${config.trackerXlsxPath}`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function printImapCandidateCheck(config) {
  const provider = getEmailProvider(config.emailProvider === "mock" ? "siteground" : config.emailProvider);
  const messages =
    typeof provider.listCandidateMessages === "function"
      ? await provider.listCandidateMessages(config, (message) => classifyEmailMessage(message, config).type === "enquiry")
      : (await provider.listMessages(config)).filter((message) => classifyEmailMessage(message, config).type === "enquiry");
  console.log(`Dry run only: found ${messages.length} candidate enquiry email(s). No messages were marked, no tracker rows were written, and no emails were sent.`);
  for (const message of messages) {
    console.log(`- ${message.receivedAt || "unknown date"} | ${message.subject || "(no subject)"} | ${redactSender(message.from)}`);
  }
}

function redactSender(sender) {
  return String(sender || "").replace(/([A-Z0-9._%+-]{2})[A-Z0-9._%+-]*(@[A-Z0-9.-]+\.[A-Z]{2,})/gi, "$1***$2");
}

function printLeadPreview(leads) {
  for (const lead of leads) {
    console.log(`- ${lead.receivedAt || "unknown date"} | ${lead.customerPostcode || "no postcode"} | ${redactSender(lead.customerEmail || "")} | ${lead.status || "New"}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
