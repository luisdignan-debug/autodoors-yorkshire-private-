const { postcodeOutward } = require("./parser");

function postcodeMatches(outward, prefixes) {
  return Boolean(outward) && prefixes.some((prefix) => outward.startsWith(prefix));
}

function postcodePriorityBand(outward, config) {
  if (!outward) return "Unknown";
  if (postcodeMatches(outward, config.localPriorityPostcodes || [])) return "Local";
  if (postcodeMatches(outward, config.regionalPriorityPostcodes || [])) return "Regional";
  if (postcodeMatches(outward, config.servicePostcodes || [])) return "Priority";
  return config.serviceCoverage === "uk_wide" ? "UK-wide" : "Outside configured area";
}

function scoreLead(lead, config) {
  if (lead.status === "Duplicate" || lead.status === "Reply sent manually") {
    return { priorityScore: 0, priorityLabel: "Low", suggestedNextAction: "No action required" };
  }

  let score = 35;
  const text = `${lead.jobType} ${lead.jobDescription} ${lead.urgency}`.toLowerCase();

  if (config.emergencyWording.some((word) => text.includes(word))) score += 30;
  if (/\b(stuck open|stuck shut|insecure|cannot close|can't close|cannot open|can't open)\b/i.test(text)) score += 25;
  if (/\b(cable|cables|snapped cable|cones|drums|spring|door dropped|forced down)\b/i.test(text)) score += 16;
  if (lead.category === "install") score += 18;
  if (lead.category === "repair") score += 12;
  if (lead.customerEmail && lead.customerPhone) score += 10;
  if (!lead.customerEmail || !lead.customerPhone) score -= 20;

  const outward = postcodeOutward(lead.customerPostcode);
  const priorityBand = postcodePriorityBand(outward, config);
  const isUkWide = config.serviceCoverage === "uk_wide";
  const inArea = isUkWide || ["Local", "Regional", "Priority"].includes(priorityBand);

  if (priorityBand === "Local") score += 18;
  else if (priorityBand === "Regional") score += 10;
  else if (priorityBand === "Priority") score += 6;
  else if (lead.customerPostcode && !inArea) score -= 30;

  score = Math.max(0, Math.min(100, score));
  const priorityLabel = score >= 70 ? "High" : score >= 40 ? "Medium" : "Low";
  let suggestedNextAction = "Create draft reply and request photos/postcode if needed";

  if (lead.customerPostcode && !inArea) suggestedNextAction = "Check service area; send polite decline if out of area";
  else if (priorityBand === "UK-wide") suggestedNextAction = "Valid UK-wide lead; review travel and commercial fit before booking";
  else if (priorityLabel === "High") suggestedNextAction = "Review draft quickly; call customer if phone supplied";
  else if (lead.missingInformationChecklist) suggestedNextAction = "Ask for missing details and photos/video";

  return { priorityScore: score, priorityLabel, suggestedNextAction, inServiceArea: Boolean(inArea), postcodePriorityBand: priorityBand };
}

module.exports = { scoreLead, postcodePriorityBand };
