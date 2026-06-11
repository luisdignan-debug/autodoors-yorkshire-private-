const fs = require("node:fs");
const path = require("node:path");
const { newAuthenticatedPage } = require("./auth");

async function scrapeCheckatradeEnquiries(config, logger = console) {
  const dashboard = config.checkatradeDashboard;
  if (!dashboard.enquiriesUrl) throw new Error("CHECKATRADE_ENQUIRIES_URL or CHECKATRADE_DASHBOARD_URL must be set.");
  const { browser, page } = await newAuthenticatedPage(config);
  try {
    await page.goto(dashboard.enquiriesUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    if (dashboard.selectorDebug) await captureDebug(page, config, logger, "selector-debug");
    const enquiries = await extractFromPage(page, config);
    if (!enquiries.length) {
      await captureDebug(page, config, logger, "no-enquiries-found");
      logger.warn("No Checkatrade enquiries were extracted. Set selector debug on and inspect the saved screenshot/HTML.");
    }
    return enquiries;
  } catch (error) {
    await captureDebug(page, config, logger, "scrape-error").catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

async function extractFromPage(page, config) {
  const dashboard = config.checkatradeDashboard;
  if (dashboard.enquiryItemSelector) {
    return page.locator(dashboard.enquiryItemSelector).evaluateAll((nodes) => nodes.map((node) => node.innerText));
  }
  const html = await page.content();
  return parseEnquiriesFromHtml(html, page.url());
}

function parseEnquiriesFromHtml(html, baseUrl = "") {
  const cards = extractCards(html);
  return cards.map((card, index) => rawFromCard(card, index, baseUrl)).filter(hasUsefulLeadData);
}

function extractCards(html) {
  const blocks = [];
  const cardRegex = /<(article|li|tr|section|div)([^>]*(?:data-enquiry-id|data-lead-id|data-testid=["'][^"']*(?:enquiry|lead)[^"']*["']|data-test=["'][^"']*(?:enquiry|lead)[^"']*["'])[^>]*)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = cardRegex.exec(html))) blocks.push(match[0]);
  if (blocks.length) return blocks;

  const articleRegex = /<(article|li|tr|section|div)([^>]*)>([\s\S]*?)<\/\1>/gi;
  while ((match = articleRegex.exec(html))) {
    const text = htmlToText(match[0]);
    if (/\b(enquiry|lead|customer|postcode|phone|garage|door)\b/i.test(text)) blocks.push(match[0]);
  }
  return blocks.slice(0, 50);
}

function rawFromCard(card, index, baseUrl) {
  const text = htmlToText(card);
  const href = firstMatch(card, /href=["']([^"']+)["']/i);
  const url = href ? absoluteUrl(href, baseUrl) : baseUrl;
  const enquiryId =
    attr(card, "data-enquiry-id") ||
    attr(card, "data-lead-id") ||
    labelled(text, ["Lead ID", "Enquiry ID", "Reference", "Ref"]) ||
    firstMatch(text, /\b(?:lead|enquiry|ref(?:erence)?)\s*#?\s*([A-Z0-9-]{4,})\b/i) ||
    `checkatrade-dashboard:${index + 1}:${hashish(text)}`;

  return {
    checkatradeId: enquiryId,
    receivedAt: labelled(text, ["Date/time received", "Received", "Date", "Created"]) || firstDate(text),
    customerName: labelled(text, ["Customer name", "Name", "Customer"]),
    customerEmail: firstMatch(text, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i),
    customerPhone: firstMatch(text, /(?:\+44\s?|0)(?:\d[\s-]?){9,10}\d/i),
    customerAddress: labelled(text, ["Address", "Customer address", "Job address", "Site address"]),
    postcode: labelled(text, ["Postcode", "Location"]) || firstMatch(text, /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i),
    location: labelled(text, ["Town", "Area", "Location"]),
    jobCategory: labelled(text, ["Job category", "Category", "Trade"]),
    jobDescription: labelled(text, ["Message", "Description", "Job details", "Enquiry"]) || text.slice(0, 800),
    urgency: labelled(text, ["Urgency", "Priority"]) || (/urgent|insecure|stuck open|stuck shut|cannot close/i.test(text) ? "Urgent" : ""),
    replyStatus: labelled(text, ["Reply status", "Status"]) || "",
    dashboardUrl: url,
    sourcePlatform: "Checkatrade Dashboard"
  };
}

async function captureDebug(page, config, logger, label) {
  const dir = config.checkatradeDashboard.screenshotDir;
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = path.join(dir, `${stamp}-${label}.png`);
  const htmlPath = path.join(dir, `${stamp}-${label}.html`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  fs.writeFileSync(htmlPath, await page.content());
  logger.warn("Saved Checkatrade selector debug files in secure folder. Review locally and do not commit them.", { screenshotPath, htmlPath });
}

function labelled(text, labels) {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = text.match(new RegExp(`(?:^|\\n|\\s)(?:${escaped})\\s*[:\\-]\\s*([^\\n]+)`, "i"));
  return match ? match[1].trim() : "";
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|section|article|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function attr(html, name) {
  return firstMatch(html, new RegExp(`${name}=["']([^"']+)["']`, "i"));
}

function firstMatch(text, regex) {
  const match = String(text || "").match(regex);
  return match ? (match[1] || match[0]).trim() : "";
}

function firstDate(text) {
  return firstMatch(text, /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}(?:\s+\d{1,2}:\d{2})?\b/);
}

function absoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl || "https://www.checkatrade.com").toString();
  } catch {
    return href;
  }
}

function hashish(text) {
  let hash = 0;
  for (const char of String(text || "")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(16);
}

function hasUsefulLeadData(lead) {
  return Boolean(lead.customerPhone || lead.customerEmail || lead.postcode || /garage|door|repair|quote|lead|enquiry/i.test(lead.jobDescription || ""));
}

module.exports = {
  scrapeCheckatradeEnquiries,
  parseEnquiriesFromHtml,
  htmlToText,
  rawFromCard
};
