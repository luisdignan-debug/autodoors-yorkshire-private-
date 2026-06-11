const fs = require("node:fs");
const path = require("node:path");

function loadEmailPackages() {
  try {
    return {
      ImapFlow: require("imapflow").ImapFlow,
      simpleParser: require("mailparser").simpleParser,
      nodemailer: require("nodemailer"),
      MailComposer: require("nodemailer/lib/mail-composer")
    };
  } catch (error) {
    throw new Error(`SiteGround IMAP/SMTP dependencies are missing. Run npm install first. (${error.message})`);
  }
}

function assertMailboxConfig(config) {
  if (!config.imap.host || !config.imap.username || !config.imap.password) {
    throw new Error("IMAP_HOST, IMAP_USERNAME and IMAP_PASSWORD must be set in .env for SiteGround mailbox access.");
  }
}

function imapClient(config) {
  const { ImapFlow } = loadEmailPackages();
  assertMailboxConfig(config);
  return new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: {
      user: config.imap.username,
      pass: config.imap.password
    },
    logger: false
  });
}

async function parseRawMessage(raw, fallback = {}) {
  const { simpleParser } = loadEmailPackages();
  const parsed = await simpleParser(raw);
  const from = parsed.from && parsed.from.value && parsed.from.value[0] ? parsed.from.value[0] : {};
  const bodyParts = [
    parsed.text || "",
    parsed.html ? stripHtml(parsed.html) : "",
    parsed.attachments && parsed.attachments.length ? `Attachments/photos supplied: ${parsed.attachments.length}` : ""
  ].filter(Boolean);

  return {
    id: parsed.messageId || fallback.id || `imap:${fallback.uid || Date.now()}`,
    uid: fallback.uid,
    from: [from.name, from.address ? `<${from.address}>` : ""].filter(Boolean).join(" ").trim() || fallback.from || "",
    subject: parsed.subject || fallback.subject || "",
    receivedAt: parsed.date ? parsed.date.toISOString() : fallback.receivedAt || new Date().toISOString(),
    body: bodyParts.join("\n\n"),
    htmlBody: parsed.html || "",
    textBody: parsed.text || "",
    hasAttachments: Boolean(parsed.attachments && parsed.attachments.length),
    attachmentCount: parsed.attachments ? parsed.attachments.length : 0,
    sourcePlatform: "SiteGround mailbox"
  };
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function listMessages(config) {
  const client = imapClient(config);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(config.imap.mailbox);
    try {
      const uids = await client.search({ all: true }, { uid: true });
      const newest = uids.slice(-config.imap.maxMessages);
      const messages = [];
      for await (const item of client.fetch(newest, { uid: true, flags: true, source: true, envelope: true, internalDate: true }, { uid: true })) {
        const flags = new Set([...item.flags].map((flag) => String(flag)));
        if (flags.has(config.imap.processedFlag)) continue;
        if (config.imap.seenOnly === false && flags.has("\\Seen")) {
          // Keep seen emails eligible by default; this branch documents the intended behavior.
        }
        messages.push(
          await parseRawMessage(item.source, {
            uid: item.uid,
            id: item.envelope && item.envelope.messageId,
            subject: item.envelope && item.envelope.subject,
            receivedAt: item.internalDate ? item.internalDate.toISOString() : ""
          })
        );
      }
      return messages;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

async function listCandidateMessages(config, filterFn) {
  const messages = await listMessages(config);
  return filterFn ? messages.filter(filterFn) : messages;
}

async function markProcessed(message, config) {
  if (!message.uid) return false;
  const client = imapClient(config);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(config.imap.mailbox);
    try {
      await client.messageFlagsAdd(message.uid, [config.imap.processedFlag], { uid: true });
      return true;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

async function createDraft(message, draft, config) {
  if (!config.imap.createDrafts) {
    return { id: "", link: "IMAP draft creation disabled; draft stored in tracker only" };
  }
  const client = imapClient(config);
  const raw = await buildEmail({
    from: config.businessEmail,
    to: extractAddress(message.from),
    subject: draft.subject,
    text: draft.body
  });
  await client.connect();
  try {
    await client.append(config.imap.draftsMailbox, raw, ["\\Draft"]);
    return { id: `imap-draft:${message.uid || message.id}`, link: `Appended to ${config.imap.draftsMailbox}` };
  } finally {
    await client.logout();
  }
}

async function sendEmail({ to, subject, text }, config) {
  if (!config.autoSend) {
    throw new Error("SMTP send is disabled. Set AUTO_SEND=true only after the send workflow has been deliberately tested.");
  }
  if (!config.smtp.host || !config.smtp.username || !config.smtp.password) {
    throw new Error("SMTP_HOST, SMTP_USERNAME and SMTP_PASSWORD must be set in .env before sending.");
  }
  const { nodemailer } = loadEmailPackages();
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: {
      user: config.smtp.username,
      pass: config.smtp.password
    }
  });
  return transport.sendMail({
    from: config.businessEmail,
    to,
    subject,
    text
  });
}

async function buildEmail({ from, to, subject, text }) {
  const { MailComposer } = loadEmailPackages();
  return new MailComposer({ from, to, subject, text }).compile().build();
}

function extractAddress(value) {
  const match = String(value || "").match(/<([^>]+)>/);
  if (match) return match[1];
  const plain = String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return plain ? plain[0] : "";
}

async function listFixtureMessages(fixtureDir) {
  const files = fs
    .readdirSync(fixtureDir)
    .filter((file) => file.endsWith(".eml") || file.endsWith(".txt"))
    .sort();
  const messages = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(fixtureDir, file));
    messages.push(await parseRawMessage(raw, { id: `fixture:${file}`, uid: file }));
  }
  return messages;
}

module.exports = {
  listMessages,
  listCandidateMessages,
  markProcessed,
  createDraft,
  sendEmail,
  parseRawMessage,
  stripHtml,
  extractAddress,
  listFixtureMessages
};
