const fs = require("node:fs");
const path = require("node:path");

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function redact(value) {
  if (value === null || value === undefined) return value;
  return String(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(\+44|0)\s?\d(?:[\s-]?\d){8,10}/g, "[phone]");
}

class Logger {
  constructor({ level = "info", databasePath }) {
    this.level = LEVELS[level] ?? LEVELS.info;
    this.logFile = path.resolve(path.dirname(databasePath), "processing.log");
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
  }

  write(level, message, meta = {}) {
    if ((LEVELS[level] ?? LEVELS.info) > this.level) return;
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message: redact(message),
      meta: Object.fromEntries(Object.entries(meta).map(([key, value]) => [key, redact(value)]))
    };
    fs.appendFileSync(this.logFile, `${JSON.stringify(entry)}\n`);
    if (level === "error" || level === "warn") {
      console.error(`${entry.level.toUpperCase()}: ${entry.message}`);
    } else if (this.level >= LEVELS.debug) {
      console.log(`${entry.level.toUpperCase()}: ${entry.message}`);
    }
    return entry;
  }

  error(message, meta) {
    return this.write("error", message, meta);
  }

  warn(message, meta) {
    return this.write("warn", message, meta);
  }

  info(message, meta) {
    return this.write("info", message, meta);
  }

  debug(message, meta) {
    return this.write("debug", message, meta);
  }
}

module.exports = { Logger, redact };
