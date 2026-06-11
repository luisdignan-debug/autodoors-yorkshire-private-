function getEmailProvider(name) {
  if (name === "siteground") return require("./siteground");
  if (name === "siteground-fixtures") return require("./sitegroundFixtures");
  if (name === "gmail") return require("./gmail");
  if (name === "outlook") return require("./outlook");
  return require("./mock");
}

module.exports = { getEmailProvider };
