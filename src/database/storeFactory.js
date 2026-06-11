const { JsonStore } = require("./jsonStore");
const { PostgresJsonStore } = require("./postgresJsonStore");

async function createStore(config) {
  if (config.databaseProvider === "postgres") {
    if (!config.databaseUrl) {
      console.warn("DATABASE_PROVIDER=postgres but DATABASE_URL is not set; using local JSON storage until the database is attached.");
      return fallbackJsonStore(config, "DATABASE_URL is not set");
    }
    try {
      return await PostgresJsonStore.create(config.databaseUrl);
    } catch (error) {
      console.warn(`Postgres storage is not available (${error.message}); using local JSON storage for this run.`);
      return fallbackJsonStore(config, error.message);
    }
  }
  return new JsonStore(config.databasePath);
}

function fallbackJsonStore(config, reason) {
  const store = new JsonStore(config.databasePath);
  store.providerName = "json-fallback";
  store.fallbackReason = reason;
  return store;
}

module.exports = { createStore };
