const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { loadConfig } = require("../src/config");
const { JsonStore } = require("../src/database/jsonStore");
const { startAppServer } = require("../src/admin/appServer");

const COOKIE_NAME = "ady_session";
const SESSION_EXPIRY_SECONDS = 7 * 24 * 3600;

function sessionSecret(config) {
  return config.adminPassword || "no-auth";
}

function signSession(username, secret) {
  const payload = Buffer.from(JSON.stringify({ u: username, t: Math.floor(Date.now() / 1000) })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function signPayload(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(encoded).digest("hex");
  return `${encoded}.${sig}`;
}

function verifySession(cookieHeader, config) {
  if (!config.adminUsername || !config.adminPassword) return true;
  const cookies = {};
  for (const part of String(cookieHeader || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  const token = cookies[COOKIE_NAME];
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot === -1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = crypto.createHmac("sha256", sessionSecret(config)).update(payload).digest("hex");
  if (sig.length !== expectedSig.length) return false;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expectedSig, "hex"))) return false;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const age = Math.floor(Date.now() / 1000) - (data.t || 0);
    return age >= 0 && age < SESSION_EXPIRY_SECONDS && data.u === config.adminUsername;
  } catch {
    return false;
  }
}

function timingSafeStrEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

test("signSession produces a two-part signed token", () => {
  const token = signSession("admin", "secret");
  const parts = token.split(".");
  assert.equal(parts.length, 2);
  assert.ok(parts[0].length > 0);
  assert.match(parts[1], /^[a-f0-9]{64}$/);
});

test("verifySession accepts a valid fresh session cookie", () => {
  const config = { adminUsername: "admin", adminPassword: "secret" };
  const token = signSession("admin", sessionSecret(config));
  assert.equal(verifySession(`${COOKIE_NAME}=${token}`, config), true);
});

test("verifySession rejects a tampered signature", () => {
  const config = { adminUsername: "admin", adminPassword: "secret" };
  const token = signSession("admin", sessionSecret(config));
  const badToken = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
  assert.equal(verifySession(`${COOKIE_NAME}=${badToken}`, config), false);
});

test("verifySession rejects a tampered payload without a recomputed signature", () => {
  const config = { adminUsername: "admin", adminPassword: "secret" };
  const token = signSession("admin", sessionSecret(config));
  const [, sig] = token.split(".");
  const badPayload = Buffer.from(JSON.stringify({ u: "other", t: Math.floor(Date.now() / 1000) })).toString("base64url");
  assert.equal(verifySession(`${COOKIE_NAME}=${badPayload}.${sig}`, config), false);
});

test("verifySession rejects an expired session cookie", () => {
  const config = { adminUsername: "admin", adminPassword: "secret" };
  const eightDaysAgo = Math.floor(Date.now() / 1000) - (8 * 24 * 3600);
  const token = signPayload({ u: "admin", t: eightDaysAgo }, sessionSecret(config));
  assert.equal(verifySession(`${COOKIE_NAME}=${token}`, config), false);
});

test("verifySession rejects an empty cookie header", () => {
  const config = { adminUsername: "admin", adminPassword: "secret" };
  assert.equal(verifySession("", config), false);
});

test("verifySession rejects a malformed session cookie", () => {
  const config = { adminUsername: "admin", adminPassword: "secret" };
  assert.equal(verifySession(`${COOKIE_NAME}=not-a-signed-token`, config), false);
});

test("verifySession allows open mode when admin credentials are not configured", () => {
  assert.equal(verifySession("", { adminUsername: "", adminPassword: "" }), true);
});

test("verifySession rejects a cookie for a different username", () => {
  const config = { adminUsername: "admin", adminPassword: "secret" };
  const token = signSession("other", sessionSecret(config));
  assert.equal(verifySession(`${COOKIE_NAME}=${token}`, config), false);
});

test("timingSafeStrEqual compares equal, different, and different-length strings", () => {
  assert.equal(timingSafeStrEqual("secret", "secret"), true);
  assert.equal(timingSafeStrEqual("secret", "secres"), false);
  assert.equal(timingSafeStrEqual("secret", "secret-longer"), false);
});

test("GET /login returns the login form", async () => {
  const { server, port } = await startTestServer();
  try {
    const response = await request({ port, path: "/login" });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /<form method="post"/);
  } finally {
    await closeServer(server);
  }
});

test("GET /today without a session cookie redirects to /login", async () => {
  const { server, port } = await startTestServer();
  try {
    const response = await request({ port, path: "/today" });
    assert.equal(response.statusCode, 303);
    assert.match(response.headers.location, /\/login/);
  } finally {
    await closeServer(server);
  }
});

async function startTestServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-app-"));
  const config = loadConfig({
    APP_PORT: "0",
    DRY_RUN: "false",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "secret",
    DATABASE_PATH: path.join(dir, "db.json"),
    TRACKER_XLSX_PATH: path.join(dir, "tracker.xlsx")
  });
  const store = new JsonStore(config.databasePath);
  const logger = { error() {}, warn() {}, info() {} };
  const server = startAppServer({ config, store, logger });
  await new Promise((resolve) => server.listening ? resolve() : server.once("listening", resolve));
  return { server, port: server.address().port };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function request({ port, path: requestPath }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        method: "GET"
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve({ statusCode: res.statusCode, body: data, headers: res.headers }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}
