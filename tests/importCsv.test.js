const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCsv, csvRowToMessage } = require("../src/importCsv");

test("parses quoted CSV fields for manual import", () => {
  const rows = parseCsv('name,email,message\n"Tom Davies",tom@example.com,"Door stuck, please help"\n');
  assert.deepEqual(rows[0], ["name", "email", "message"]);
  assert.deepEqual(rows[1], ["Tom Davies", "tom@example.com", "Door stuck, please help"]);
});

test("converts CSV row to a mailbox-style message", () => {
  const message = csvRowToMessage({ name: "Tom", email: "tom@example.com", postcode: "WF1 2AB", message: "Door repair" }, 1);
  assert.equal(message.id, "manual-csv:1");
  assert.match(message.body, /Postcode: WF1 2AB/);
});
