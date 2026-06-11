const test = require("node:test");
const assert = require("node:assert/strict");
const { parseEnquiryEmail, normalisePostcode, detectDoorTypes, royalMailPostcodeFinderUrl } = require("../src/parser");
const { loadConfig } = require("../src/config");

test("extracts core fields from a Checkatrade-style email", () => {
  const config = loadConfig({ DRY_RUN: "true" });
  const lead = parseEnquiryEmail(
    {
      id: "msg-1",
      from: "leads@checkatrade.com",
      subject: "Checkatrade enquiry",
      receivedAt: "2026-06-01T09:00:00.000Z",
      body: [
        "Customer name: Jane Smith",
        "Customer email: jane@example.com",
        "Customer phone: 07700 900555",
        "Customer address: 12 Market Street, Huddersfield, HD1 2AB",
        "Postcode: yo30 5ab",
        "Message: Electric roller door is stuck shut."
      ].join("\n")
    },
    config
  );

  assert.equal(lead.customerName, "Jane Smith");
  assert.equal(lead.customerEmail, "jane@example.com");
  assert.equal(lead.customerPhone, "07700900555");
  assert.equal(lead.customerAddress, "12 Market Street, Huddersfield, HD1 2AB");
  assert.equal(lead.customerPostcode, "YO305AB");
  assert.match(lead.addressVerificationUrl, /royalmail\.com\/find-a-postcode/);
  assert.equal(lead.category, "emergency");
  assert.match(lead.mechanism, /electric/);
});

test("normalises UK postcodes and detects door types", () => {
  assert.equal(normalisePostcode(" ls17 8hh "), "LS178HH");
  assert.deepEqual(detectDoorTypes("manual up and over garage door"), ["up-and-over", "manual"]);
  assert.equal(royalMailPostcodeFinderUrl("HD1 2AB"), "https://www.royalmail.com/find-a-postcode?postcode=HD1%202AB");
});
