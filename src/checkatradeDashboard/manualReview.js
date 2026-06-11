const http = require("node:http");

function startManualReviewServer({ config, store }) {
  const port = config.manualReviewPort || 8790;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderPage(store.state.leads || []));
  });
  server.listen(port, () => {
    console.log(`Manual review page listening on http://localhost:${port}`);
  });
  return server;
}

function renderPage(leads) {
  const pending = leads.filter((lead) => ["New", "Draft created", "Awaiting approval", "Needs call", "Awaiting photos"].includes(lead.status));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Checkatrade Enquiry Review</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; background: #f7f7f5; color: #1f2933; }
    main { max-width: 1180px; margin: 0 auto; }
    h1 { font-size: 24px; margin-bottom: 16px; }
    article { background: white; border: 1px solid #d8dde3; border-radius: 6px; padding: 16px; margin-bottom: 14px; }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; font-size: 14px; }
    textarea { width: 100%; min-height: 180px; margin-top: 12px; font-family: inherit; }
    button, a { display: inline-block; margin-top: 10px; margin-right: 8px; padding: 8px 10px; border: 1px solid #9aa6b2; border-radius: 4px; background: #fff; color: #111827; text-decoration: none; }
  </style>
</head>
<body>
<main>
  <h1>Checkatrade Enquiry Review</h1>
  ${pending.map(renderLead).join("") || "<p>No enquiries awaiting review.</p>"}
</main>
<script>
  function copyReply(id) {
    const text = document.getElementById(id).value;
    navigator.clipboard.writeText(text);
  }
</script>
</body>
</html>`;
}

function renderLead(lead, index) {
  const textareaId = `draft-${index}`;
  return `<article>
  <div class="meta">
    <div><strong>Status</strong><br>${escapeHtml(lead.status)}</div>
    <div><strong>Name</strong><br>${escapeHtml(lead.customerName)}</div>
    <div><strong>Phone</strong><br>${escapeHtml(lead.customerPhone)}</div>
    <div><strong>Postcode</strong><br>${escapeHtml(lead.customerPostcode)}</div>
    <div><strong>Priority</strong><br>${escapeHtml(lead.priorityLabel || "")}</div>
  </div>
  <p>${escapeHtml(lead.jobDescription || "")}</p>
  <textarea id="${textareaId}">${escapeHtml(lead.draftReply || "")}</textarea>
  <button type="button" onclick="copyReply('${textareaId}')">Copy reply</button>
  ${lead.dashboardUrl ? `<a href="${escapeAttr(lead.dashboardUrl)}" target="_blank" rel="noreferrer">Open Checkatrade enquiry</a>` : ""}
</article>`;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

module.exports = { startManualReviewServer, renderPage };
