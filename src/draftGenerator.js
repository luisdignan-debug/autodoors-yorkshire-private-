function greeting(name) {
  const first = String(name || "").trim().split(/\s+/)[0];
  return first ? `Hi ${first},` : "Hi,";
}

function missingList(lead) {
  const items = [];
  if (!lead.customerPostcode) items.push("your full postcode");
  if (!lead.customerAddress) items.push("the full property address");
  if (!lead.mechanism || !/(manual|electric)/i.test(lead.mechanism)) items.push("whether the door is manual or electric");
  if (!lead.customerPhone) items.push("a contact number");
  items.push("a few photos of the garage door from inside and outside");
  items.push("a short video showing the issue, if possible");
  return items;
}

function bulletList(items) {
  return items.map((item) => `* ${item};`).join("\n").replace(/;$/, ".");
}

function templateFor(lead) {
  if (lead.notes && /out of area/i.test(lead.notes)) return "out_of_area";
  if (/\b(cable|cables|snapped cable|cones|drums|spring|door dropped|forced down|would not close)\b/i.test(`${lead.jobDescription} ${lead.garageDoorIssue}`)) return "cable_repair";
  if (lead.category === "emergency" || /urgent|insecure|stuck/i.test(`${lead.urgency} ${lead.jobDescription}`)) return "emergency_repair";
  if (lead.category === "install") return "new_installation";
  if (lead.category === "service") return "service";
  if (lead.missingInformationChecklist) return "missing_information";
  return "standard_repair";
}

function renderTemplate(template, values) {
  return String(template || "").replace(/\{\{([a-z_]+)\}\}/gi, (_, key) => values[key] ?? "");
}

function generateDraftReply(lead, config) {
  const subject = lead.category === "install" ? "Garage door quote enquiry" : "Garage door enquiry";
  const nameLine = greeting(lead.customerName);
  const signoff = `Kind regards,\n\n${config.businessName}`;
  const missing = bulletList(missingList(lead));
  const template = templateFor(lead);
  const custom = config.replyTemplates && config.replyTemplates[template];
  if (custom && custom.body) {
    const first = String(lead.customerName || "").trim().split(/\s+/)[0] || "";
    return {
      subject: custom.subject || subject,
      body: renderTemplate(custom.body, {
        greeting: greeting(lead.customerName),
        customer_first_name: first,
        business_name: config.businessName,
        quote_day: config.quoteDay,
        missing_items: missing
      }),
      template
    };
  }

  let body;
  if (template === "out_of_area") {
    body = `${nameLine}\n\nThanks for your enquiry.\n\nI am sorry, but it looks like this may be outside our usual service area. If the postcode is different from the one supplied, please let us know and we can double-check.\n\n${signoff}`;
  } else if (template === "cable_repair") {
    body = `${nameLine}\n\nThanks for your enquiry.\n\nFor a cable/spring repair, please send:\n\n* photos from inside and outside;\n* close-ups of the cable/drum area on both sides;\n* whether the door is manual or electric;\n* whether the door is fully closed and secure;\n* the full property address;\n* your postcode;\n* whether you would like a repair visit/quote.\n\nWe usually arrange quotes on ${config.quoteDay}s, but if the door is insecure or stuck open, please let us know as urgent.\n\n${signoff}`;
  } else if (template === "emergency_repair") {
    body = `${nameLine}\n\nThanks for your enquiry.\n\nIf the garage door is insecure, stuck open, or you cannot close it, please reply to confirm it is urgent and include a contact number if you have not already sent one.\n\nTo help us assess it quickly, please send:\n\n${missing}\n\nWe usually arrange quotes on ${config.quoteDay}s, but urgent security issues will be reviewed separately.\n\n${signoff}`;
  } else if (template === "new_installation") {
    body = `${nameLine}\n\nThanks for your enquiry about a garage door.\n\nWe can advise on options once we have a little more detail. Please send:\n\n${missing}\n\nWe usually arrange quotes on ${config.quoteDay}s and will come back to you after reviewing the details.\n\n${signoff}`;
  } else if (template === "service") {
    body = `${nameLine}\n\nThanks for your enquiry.\n\nWe can look at servicing or maintenance. Please send:\n\n${missing}\n\nWe usually arrange quotes on ${config.quoteDay}s, unless there is an urgent security issue.\n\n${signoff}`;
  } else {
    body = `${nameLine}\n\nThanks for your enquiry.\n\nWe should be able to advise on this. To help us assess it properly, please send:\n\n${missing}\n\nWe usually arrange quotes on ${config.quoteDay}s, but if the door is insecure or urgent, please let us know.\n\n${signoff}`;
  }

  return { subject, body, template };
}

function generateFollowUpDraft(lead, config) {
  return {
    subject: "Garage door enquiry follow-up",
    body: `${greeting(lead.customerName)}\n\nJust following up on your garage door enquiry.\n\nIf you would still like us to advise, please send any missing photos, video, full property address, postcode, and whether the door is manual or electric.\n\nKind regards,\n\n${config.businessName}`,
    template: "follow_up"
  };
}

module.exports = { generateDraftReply, generateFollowUpDraft, templateFor };
