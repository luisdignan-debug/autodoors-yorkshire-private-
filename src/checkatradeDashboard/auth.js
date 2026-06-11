const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");

function loadPlaywright() {
  try {
    return require("playwright");
  } catch (error) {
    throw new Error(`Playwright is not installed. Run npm install, then npx playwright install chromium. (${error.message})`);
  }
}

function assertLoginConfig(config) {
  const dashboard = config.checkatradeDashboard;
  if (!dashboard.loginUrl) throw new Error("CHECKATRADE_LOGIN_URL must be set before running Checkatrade login.");
}

async function authenticateCheckatrade(config, logger = console) {
  assertLoginConfig(config);
  const { chromium } = loadPlaywright();
  const dashboard = config.checkatradeDashboard;
  fs.mkdirSync(path.dirname(dashboard.sessionStatePath), { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  try {
    await page.goto(dashboard.loginUrl, { waitUntil: "domcontentloaded" });
    if (dashboard.username) {
      await fillFirst(
        page,
        ['input[name="email"]', 'input[type="email"]', 'input[name="username"]', 'input[id*="email" i]', 'input[id*="user" i]'],
        dashboard.username
      ).catch(() => logger.warn("Could not pre-fill Checkatrade username; enter it manually in the browser."));
    }

    if (dashboard.password) {
      await fillFirst(page, ['input[name="password"]', 'input[type="password"]', 'input[id*="password" i]'], dashboard.password);
      await clickFirst(page, [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Log in")',
        'button:has-text("Sign in")',
        'button:has-text("Continue")'
      ]);
      await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    }

    if (!dashboard.password || (await looksLikeManualVerification(page))) {
      logger.warn("Complete the Checkatrade login in the browser, including password and any email verification code. Then press Enter here.");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      await rl.question("Press Enter after the Checkatrade dashboard is fully logged in...");
      rl.close();
      await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    }

    await page.context().storageState({ path: dashboard.sessionStatePath });
    logger.info("Saved authorised Checkatrade session state", { sessionStatePath: dashboard.sessionStatePath });
    return { sessionStatePath: dashboard.sessionStatePath };
  } finally {
    await browser.close();
  }
}

async function newAuthenticatedPage(config) {
  const { chromium } = loadPlaywright();
  const dashboard = config.checkatradeDashboard;
  if (!fs.existsSync(dashboard.sessionStatePath)) {
    throw new Error("No Checkatrade session state found. Run npm run checkatrade:login locally first.");
  }
  const browser = await chromium.launch({ headless: dashboard.headless });
  const context = await browser.newContext({ storageState: dashboard.sessionStatePath });
  const page = await context.newPage();
  return { browser, context, page };
}

async function fillFirst(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) {
      await locator.fill(value);
      return selector;
    }
  }
  throw new Error(`Could not find a login field for selectors: ${selectors.join(", ")}`);
}

async function clickFirst(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) {
      await locator.click();
      return selector;
    }
  }
  throw new Error(`Could not find a login submit button for selectors: ${selectors.join(", ")}`);
}

async function looksLikeManualVerification(page) {
  const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  return /\b(two[-\s]?factor|2fa|verification|verify|security code|authenticator|captcha|one[-\s]?time)\b/i.test(text);
}

module.exports = {
  authenticateCheckatrade,
  newAuthenticatedPage,
  looksLikeManualVerification,
  loadPlaywright
};
