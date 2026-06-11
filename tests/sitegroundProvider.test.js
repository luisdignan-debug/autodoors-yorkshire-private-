const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("../src/config");
const { parseEnquiryEmail, isLikelyCheckatradeEmail } = require("../src/parser");
const siteground = require("../src/emailProvider/siteground");

test("parses SiteGround MIME fixture into a message", async () => {
  const raw = fs.readFileSync(path.resolve("fixtures/siteground-emails/001-direct-enquiry.eml"));
  const message = await siteground.parseRawMessage(raw, { uid: 101 });

  assert.equal(message.id, "<siteground-fixture-001@example.com>");
  assert.match(message.from, /emma\.brown@example\.com/);
  assert.equal(message.subject, "Garage door repair quote");
  assert.match(message.body, /electric roller garage door/);
  assert.equal(message.sourcePlatform, "SiteGround mailbox");
});

test("recognises direct SiteGround customer enquiry with generic filters", async () => {
  const config = loadConfig({
    ENQUIRY_ALLOWED_SENDERS: "*",
    ENQUIRY_SUBJECT_KEYWORDS: "garage,door,quote",
    ENQUIRY_BODY_KEYWORDS: "garage door,postcode,repair",
    DRY_RUN: "true"
  });
  const raw = fs.readFileSync(path.resolve("fixtures/siteground-emails/001-direct-enquiry.eml"));
  const message = await siteground.parseRawMessage(raw, { uid: 101 });
  const lead = parseEnquiryEmail(message, config);

  assert.equal(isLikelyCheckatradeEmail(message, config), true);
  assert.equal(lead.sourcePlatform, "SiteGround mailbox");
  assert.equal(lead.customerEmail, "emma.brown@example.com");
  assert.equal(lead.customerPhone, "07700900555");
  assert.equal(lead.customerPostcode, "HD34AB");
  assert.equal(lead.urgency, "Urgent");
});

test("SMTP send refuses to run unless AUTO_SEND=true", async () => {
  const config = loadConfig({ AUTO_SEND: "false", DRY_RUN: "true" });
  await assert.rejects(
    () => siteground.sendEmail({ to: "customer@example.com", subject: "Test", text: "Hello" }, config),
    /SMTP send is disabled/
  );
});
