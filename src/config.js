const fs = require("node:fs");
const path = require("node:path");

try {
  require("dotenv").config();
} catch {
  // dotenv is optional during no-install fixture tests; loadDotEnv below is the fallback.
}

const DEFAULTS = {
  APP_MODE: "test",
  APP_BASE_URL: "",
  APP_PORT: "3000",
  DEMO_MODE: "false",
  DRY_RUN: "true",
  AUTO_SEND: "false",
  DATABASE_PROVIDER: "json",
  DATABASE_URL: "",
  DATABASE_PATH: "data/enquiry-manager.json",
  TRACKER_XLSX_PATH: "outputs/enquiry-tracker.xlsx",
  TEMPLATES_PATH: "config/reply-templates.json",
  LOG_LEVEL: "info",
  ADMIN_USERNAME: "",
  ADMIN_PASSWORD: "",
  BUSINESS_NAME: "Autodoors Yorkshire",
  BUSINESS_EMAIL: "info@example.co.uk",
  COMPANY_LEGAL_NAME: "YORKSHIRE AUTO DOORS LTD",
  COMPANY_NUMBER: "14637200",
  COMPANY_STATUS: "Active",
  COMPANY_TYPE: "Private limited company",
  REGISTERED_OFFICE_ADDRESS: "Whitby Court Abbey Road, Shepley, Huddersfield, United Kingdom, HD8 8EL",
  TRADING_NAME: "Autodoors Yorkshire",
  BUSINESS_PHONE: "07895 698239",
  BUSINESS_WEBSITE: "https://autodoorsyorkshire.com",
  TRADING_ADDRESS: "",
  BANK_ACCOUNT_NAME: "",
  BANK_SORT_CODE: "",
  BANK_ACCOUNT_NUMBER: "",
  PAYMENT_REFERENCE_FORMAT: "{invoice_number}",
  DEFAULT_VAT_RATE: "20",
  DEFAULT_PAYMENT_TERMS: "7",
  INVOICE_PREFIX: "ADY-",
  NEXT_INVOICE_NUMBER: "1",
  VAT_REGISTRATION_NUMBER: "",
  VAT_REGISTERED: "false",
  NO_VAT_NOTE: "No VAT charged.",
  LOGO_PATH: "",
  INVOICE_PDF_DIR: "outputs/invoices",
  OWNER_EMAIL: "owner@example.co.uk",
  ASSIGNED_PERSON: "Owner",
  SERVICE_COVERAGE: "uk_wide",
  LOCAL_PRIORITY_POSTCODES: "HD",
  REGIONAL_PRIORITY_POSTCODES: "HX,WF,BD,LS,OL,M,S,SK,HG,YO,BB,DN",
  SERVICE_POSTCODES: "HD,HX,WF,BD,LS,OL,M,S,SK,HG,YO,BB,DN",
  QUOTE_DAY: "Friday",
  STANDARD_WORKING_HOURS: "Monday-Thursday 08:30-17:00; Friday quote visits by arrangement",
  FOLLOW_UP_DELAY_DAYS: "3",
  RETENTION_MONTHS: "12",
  EMERGENCY_WORDING: "stuck open,stuck shut,insecure,cannot close,cannot open,broken spring,urgent,emergency",
  CHECKATRADE_ALLOWED_SENDERS: "checkatrade.com",
  CHECKATRADE_SUBJECT_KEYWORDS: "checkatrade,enquiry,lead,customer enquiry",
  CHECKATRADE_BODY_KEYWORDS: "checkatrade,customer,postcode,garage door",
  ENQUIRY_ALLOWED_SENDERS: "*",
  ENQUIRY_SUBJECT_KEYWORDS: "garage,door,repair,service,quote,enquiry,checkatrade",
  ENQUIRY_BODY_KEYWORDS: "garage door,roller,up and over,sectional,electric door,manual door,repair,stuck,insecure,quote,service,postcode",
  EMAIL_RECRUITMENT_KEYWORDS: "cv,curriculum vitae,job application,vacancy,recruitment,candidate,available for work,looking for work,apprenticeship",
  EMAIL_SPAM_KEYWORDS: "seo,search engine optimisation,marketing proposal,crypto,investment opportunity,web design,website redesign,domain renewal,newsletter",
  EMAIL_ADMIN_KEYWORDS: "statement,remittance,receipt,payment confirmation,out of office,auto reply,automatic reply,failed delivery,mail delivery subsystem",
  PROCESSED_LABEL: "Processed-Checkatrade",
  EMAIL_PROVIDER: "mock",
  MOCK_EMAIL_DIR: "fixtures/sample-emails",
  SITEGROUND_FIXTURE_DIR: "fixtures/siteground-emails",
  IMAP_HOST: "gukm1010.siteground.biz",
  IMAP_PORT: "993",
  IMAP_SECURE: "true",
  IMAP_USERNAME: "info@autodoorsyorkshire.com",
  IMAP_USER: "",
  IMAP_PASSWORD: "",
  IMAP_MAILBOX: "INBOX",
  IMAP_SEEN_ONLY: "false",
  IMAP_MAX_MESSAGES: "25",
  IMAP_PROCESSED_FLAG: "$AutoDoorsProcessed",
  IMAP_DRAFTS_MAILBOX: "Drafts",
  CREATE_IMAP_DRAFTS: "false",
  SMTP_HOST: "gukm1010.siteground.biz",
  SMTP_PORT: "465",
  SMTP_SECURE: "true",
  SMTP_USERNAME: "info@autodoorsyorkshire.com",
  SMTP_USER: "",
  SMTP_PASSWORD: "",
  WEBHOOK_PORT: "8787",
  WEBHOOK_SECURITY_MODE: "ip_allowlist",
  WEBHOOK_TRUST_PROXY: "false",
  CHECKATRADE_WEBHOOK_ENVIRONMENT: "development",
  CHECKATRADE_ALLOWED_IPS_DEVELOPMENT: "34.105.162.121,34.89.85.173,35.234.151.94",
  CHECKATRADE_ALLOWED_IPS_PRODUCTION: "35.246.15.126,35.242.187.239,34.39.18.129",
  CHECKATRADE_WEBHOOK_SECRET: "",
  CHECKATRADE_WEBHOOK_SIGNATURE_HEADER: "x-checkatrade-signature",
  CHECKATRADE_ENABLED: "false",
  CHECKATRADE_LOGIN_URL: "",
  CHECKATRADE_DASHBOARD_URL: "",
  CHECKATRADE_ENQUIRIES_URL: "",
  CHECKATRADE_USERNAME: "",
  CHECKATRADE_PASSWORD: "",
  CHECKATRADE_SESSION_STATE_PATH: "./secure/checkatrade-auth.json",
  CHECKATRADE_HEADLESS: "true",
  CHECKATRADE_POLL_INTERVAL_MINUTES: "15",
  CHECKATRADE_SELECTOR_DEBUG: "false",
  CHECKATRADE_SCREENSHOT_DIR: "./secure/checkatrade-screenshots",
  CHECKATRADE_ENQUIRY_LIST_SELECTOR: "",
  CHECKATRADE_ENQUIRY_ITEM_SELECTOR: "",
  CHECKATRADE_NEXT_PAGE_SELECTOR: "",
  CREATE_PROVIDER_DRAFTS: "false",
  WRITE_DRAFT_TO_TRACKER: "true",
  AUTO_SEND_EMAILS: "false",
  SEND_EMAILS_ENABLED: "false",
  SEND_SMS_ENABLED: "false",
  SEND_WHATSAPP_ENABLED: "false",
  TECH_NOTIFY_EMAIL_ENABLED: "false",
  TECH_NOTIFY_SMS_ENABLED: "false",
  TECH_NOTIFY_WHATSAPP_ENABLED: "false",
  TECH_NOTIFY_AUTO_SEND: "false",
  TECH_NOTIFY_DRY_RUN: "true",
  CALENDAR_SYNC_ENABLED: "false",
  TWILIO_ACCOUNT_SID: "",
  TWILIO_AUTH_TOKEN: "",
  TWILIO_MESSAGING_SERVICE_SID: "",
  TWILIO_FROM_NUMBER: "",
  TWILIO_WHATSAPP_FROM: "",
  TECH_DAILY_DIGEST_TEMPLATE: "",
  TECH_WEEKLY_DIGEST_TEMPLATE: "",
  TECH_JOB_ASSIGNMENT_TEMPLATE: "",
  CALDAV_ENABLED: "false",
  CALDAV_SERVER_URL: "",
  CALDAV_USERNAME: "",
  CALDAV_PASSWORD: "",
  CALDAV_CALENDAR_URL: "",
  USE_LLM_EXTRACTION: "false"
};

function loadDotEnv(filePath = ".env") {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) return {};

  const result = {};
  const lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

function csvList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function bool(value) {
  return String(value).toLowerCase() === "true";
}

function loadConfig(overrides = {}) {
  const envFile = loadDotEnv();
  const merged = { ...DEFAULTS, ...envFile, ...process.env, ...overrides };

  if (bool(merged.AUTO_SEND_EMAILS) && !bool(merged.AUTO_SEND)) {
    throw new Error("AUTO_SEND_EMAILS is deprecated. Use AUTO_SEND=true only when a deliberately tested send workflow exists.");
  }

  return {
    appMode: merged.APP_MODE,
    demoMode: bool(merged.DEMO_MODE),
    appBaseUrl: merged.APP_BASE_URL,
    appPort: parsePort(merged.PORT, parsePort(merged.APP_PORT, 3000)),
    dryRun: bool(merged.DRY_RUN),
    autoSend: bool(merged.AUTO_SEND),
    databaseProvider: String(merged.DATABASE_PROVIDER || "json").toLowerCase(),
    databaseUrl: merged.DATABASE_URL,
    databasePath: path.resolve(merged.DATABASE_PATH),
    trackerXlsxPath: path.resolve(merged.TRACKER_XLSX_PATH),
    templatesPath: path.resolve(merged.TEMPLATES_PATH),
    replyTemplates: loadJsonIfExists(path.resolve(merged.TEMPLATES_PATH)),
    logLevel: merged.LOG_LEVEL,
    adminUsername: merged.ADMIN_USERNAME,
    adminPassword: merged.ADMIN_PASSWORD,
    businessName: merged.BUSINESS_NAME,
    businessEmail: merged.BUSINESS_EMAIL,
    company: {
      legalName: merged.COMPANY_LEGAL_NAME,
      tradingName: merged.TRADING_NAME || merged.BUSINESS_NAME,
      companyNumber: merged.COMPANY_NUMBER,
      companyStatus: merged.COMPANY_STATUS,
      companyType: merged.COMPANY_TYPE,
      registeredOfficeAddress: merged.REGISTERED_OFFICE_ADDRESS,
      tradingAddress: merged.TRADING_ADDRESS,
      phone: merged.BUSINESS_PHONE,
      email: merged.BUSINESS_EMAIL,
      website: merged.BUSINESS_WEBSITE,
      bankAccountName: merged.BANK_ACCOUNT_NAME,
      sortCode: merged.BANK_SORT_CODE,
      accountNumber: merged.BANK_ACCOUNT_NUMBER,
      paymentReferenceFormat: merged.PAYMENT_REFERENCE_FORMAT,
      defaultVatRate: merged.DEFAULT_VAT_RATE,
      defaultPaymentTerms: merged.DEFAULT_PAYMENT_TERMS,
      invoicePrefix: merged.INVOICE_PREFIX,
      nextInvoiceNumber: merged.NEXT_INVOICE_NUMBER,
      vatRegistrationNumber: merged.VAT_REGISTRATION_NUMBER,
      vatRegistered: bool(merged.VAT_REGISTERED),
      noVatNote: merged.NO_VAT_NOTE,
      logoPath: merged.LOGO_PATH
    },
    invoicePdfDir: path.resolve(merged.INVOICE_PDF_DIR),
    sendEmailsEnabled: bool(merged.SEND_EMAILS_ENABLED),
    sendSmsEnabled: bool(merged.SEND_SMS_ENABLED),
    sendWhatsappEnabled: bool(merged.SEND_WHATSAPP_ENABLED),
    techNotify: {
      emailEnabled: bool(merged.TECH_NOTIFY_EMAIL_ENABLED),
      smsEnabled: bool(merged.TECH_NOTIFY_SMS_ENABLED),
      whatsappEnabled: bool(merged.TECH_NOTIFY_WHATSAPP_ENABLED),
      autoSend: bool(merged.TECH_NOTIFY_AUTO_SEND),
      dryRun: merged.TECH_NOTIFY_DRY_RUN === undefined ? true : bool(merged.TECH_NOTIFY_DRY_RUN)
    },
    calendarSyncEnabled: bool(merged.CALENDAR_SYNC_ENABLED),
    twilio: {
      accountSid: merged.TWILIO_ACCOUNT_SID,
      authToken: merged.TWILIO_AUTH_TOKEN,
      messagingServiceSid: merged.TWILIO_MESSAGING_SERVICE_SID,
      fromNumber: merged.TWILIO_FROM_NUMBER,
      whatsappFrom: merged.TWILIO_WHATSAPP_FROM
    },
    whatsappTemplates: {
      dailyDigest: merged.TECH_DAILY_DIGEST_TEMPLATE,
      weeklyDigest: merged.TECH_WEEKLY_DIGEST_TEMPLATE,
      jobAssignment: merged.TECH_JOB_ASSIGNMENT_TEMPLATE
    },
    caldav: {
      enabled: bool(merged.CALDAV_ENABLED),
      serverUrl: merged.CALDAV_SERVER_URL,
      username: merged.CALDAV_USERNAME,
      password: merged.CALDAV_PASSWORD,
      calendarUrl: merged.CALDAV_CALENDAR_URL
    },
    ownerEmail: merged.OWNER_EMAIL,
    assignedPerson: merged.ASSIGNED_PERSON,
    serviceCoverage: String(merged.SERVICE_COVERAGE || "uk_wide").toLowerCase(),
    localPriorityPostcodes: csvList(merged.LOCAL_PRIORITY_POSTCODES).map((item) => item.toUpperCase()),
    regionalPriorityPostcodes: csvList(merged.REGIONAL_PRIORITY_POSTCODES).map((item) => item.toUpperCase()),
    servicePostcodes: csvList(merged.SERVICE_POSTCODES).map((item) => item.toUpperCase()),
    quoteDay: merged.QUOTE_DAY,
    workingHours: merged.STANDARD_WORKING_HOURS,
    followUpDelayDays: Number.parseInt(merged.FOLLOW_UP_DELAY_DAYS, 10) || 3,
    retentionMonths: Number.parseInt(merged.RETENTION_MONTHS, 10) || 12,
    emergencyWording: csvList(merged.EMERGENCY_WORDING).map((item) => item.toLowerCase()),
    allowedSenders: csvList(merged.ENQUIRY_ALLOWED_SENDERS || merged.CHECKATRADE_ALLOWED_SENDERS).map((item) => item.toLowerCase()),
    subjectKeywords: csvList(merged.ENQUIRY_SUBJECT_KEYWORDS || merged.CHECKATRADE_SUBJECT_KEYWORDS).map((item) => item.toLowerCase()),
    bodyKeywords: csvList(merged.ENQUIRY_BODY_KEYWORDS || merged.CHECKATRADE_BODY_KEYWORDS).map((item) => item.toLowerCase()),
    recruitmentKeywords: csvList(merged.EMAIL_RECRUITMENT_KEYWORDS).map((item) => item.toLowerCase()),
    spamKeywords: csvList(merged.EMAIL_SPAM_KEYWORDS).map((item) => item.toLowerCase()),
    adminEmailKeywords: csvList(merged.EMAIL_ADMIN_KEYWORDS).map((item) => item.toLowerCase()),
    processedLabel: merged.PROCESSED_LABEL,
    emailProvider: merged.EMAIL_PROVIDER,
    mockEmailDir: path.resolve(merged.MOCK_EMAIL_DIR),
    sitegroundFixtureDir: path.resolve(merged.SITEGROUND_FIXTURE_DIR),
    imap: {
      host: merged.IMAP_HOST,
      port: Number.parseInt(merged.IMAP_PORT, 10) || 993,
      secure: bool(merged.IMAP_SECURE),
      username: merged.IMAP_USER || merged.IMAP_USERNAME,
      password: merged.IMAP_PASSWORD,
      mailbox: merged.IMAP_MAILBOX,
      seenOnly: bool(merged.IMAP_SEEN_ONLY),
      maxMessages: Number.parseInt(merged.IMAP_MAX_MESSAGES, 10) || 25,
      processedFlag: merged.IMAP_PROCESSED_FLAG,
      draftsMailbox: merged.IMAP_DRAFTS_MAILBOX,
      createDrafts: bool(merged.CREATE_IMAP_DRAFTS)
    },
    smtp: {
      host: merged.SMTP_HOST,
      port: Number.parseInt(merged.SMTP_PORT, 10) || 465,
      secure: bool(merged.SMTP_SECURE),
      username: merged.SMTP_USER || merged.SMTP_USERNAME,
      password: merged.SMTP_PASSWORD
    },
    webhookPort: parsePort(merged.PORT, parsePort(merged.WEBHOOK_PORT, 8787)),
    webhookSecurityMode: String(merged.WEBHOOK_SECURITY_MODE || "ip_allowlist").toLowerCase(),
    webhookTrustProxy: bool(merged.WEBHOOK_TRUST_PROXY),
    checkatradeWebhookEnvironment: String(merged.CHECKATRADE_WEBHOOK_ENVIRONMENT || "development").toLowerCase(),
    checkatradeAllowedIpsDevelopment: csvList(merged.CHECKATRADE_ALLOWED_IPS_DEVELOPMENT),
    checkatradeAllowedIpsProduction: csvList(merged.CHECKATRADE_ALLOWED_IPS_PRODUCTION),
    checkatradeAllowedIps: csvList(merged.CHECKATRADE_ALLOWED_IPS),
    webhookSecret: merged.CHECKATRADE_WEBHOOK_SECRET,
    webhookSignatureHeader: merged.CHECKATRADE_WEBHOOK_SIGNATURE_HEADER.toLowerCase(),
    checkatradeEnabled: bool(merged.CHECKATRADE_ENABLED),
    checkatradeDashboard: {
      loginUrl: merged.CHECKATRADE_LOGIN_URL,
      dashboardUrl: merged.CHECKATRADE_DASHBOARD_URL,
      enquiriesUrl: merged.CHECKATRADE_ENQUIRIES_URL || merged.CHECKATRADE_DASHBOARD_URL,
      username: merged.CHECKATRADE_USERNAME,
      password: merged.CHECKATRADE_PASSWORD,
      sessionStatePath: path.resolve(merged.CHECKATRADE_SESSION_STATE_PATH),
      headless: bool(merged.CHECKATRADE_HEADLESS),
      pollIntervalMinutes: Number.parseInt(merged.CHECKATRADE_POLL_INTERVAL_MINUTES, 10) || 15,
      selectorDebug: bool(merged.CHECKATRADE_SELECTOR_DEBUG),
      screenshotDir: path.resolve(merged.CHECKATRADE_SCREENSHOT_DIR),
      enquiryListSelector: merged.CHECKATRADE_ENQUIRY_LIST_SELECTOR,
      enquiryItemSelector: merged.CHECKATRADE_ENQUIRY_ITEM_SELECTOR,
      nextPageSelector: merged.CHECKATRADE_NEXT_PAGE_SELECTOR
    },
    createProviderDrafts: bool(merged.CREATE_PROVIDER_DRAFTS),
    writeDraftToTracker: bool(merged.WRITE_DRAFT_TO_TRACKER),
    useLlmExtraction: bool(merged.USE_LLM_EXTRACTION)
  };
}

function loadJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read template config ${filePath}: ${error.message}`);
  }
}

function parsePort(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

module.exports = { loadConfig, csvList, bool, DEFAULTS };
