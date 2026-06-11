const TEMPLATE_LABELS = {
  quote_follow_up: "Quote follow-up",
  deposit_request: "Deposit request",
  deposit_received_order_placed: "Deposit received / order placed",
  supplier_confirmation: "Supplier confirmation / lead time",
  delivery_delay: "Delivery delay",
  ready_to_book_installation: "Ready to book installation",
  installation_booked: "Installation booked",
  installation_reminder: "Installation reminder",
  balance_request: "Balance request",
  review_request: "Review request"
};

function generateCustomerUpdateDraft(lead, type = "quote_follow_up", config = {}) {
  const businessName = config.businessName || "Autodoors Yorkshire";
  const greeting = firstName(lead.customerName) ? `Hi ${firstName(lead.customerName)},` : "Hi,";
  const signoff = `Kind regards,\n\n${businessName}`;
  const leadTime = deliveryText(lead);
  const installation = lead.installation_scheduled_at
    ? `${lead.installation_scheduled_at}${lead.installation_time_window ? ` (${lead.installation_time_window})` : ""}`
    : "[confirm installation date/time]";
  const balance = lead.balance_amount ? ` of ${lead.balance_amount}` : "";

  const bodies = {
    quote_follow_up: `${greeting}\n\nJust following up on the garage door quote. Please let us know if you would like to go ahead or if you have any questions.\n\n${signoff}`,
    deposit_request: `${greeting}\n\nThanks for accepting the quote. The next step is the deposit${lead.deposit_amount ? ` of ${lead.deposit_amount}` : ""} so we can move the job forward.\n\nPlease confirm once this has been sent, and we will update the job record.\n\n${signoff}`,
    deposit_received_order_placed: `${greeting}\n\nThanks, we have received the deposit and placed the order for your garage door. We will update you once the supplier confirms the delivery timescale.\n\n${signoff}`,
    supplier_confirmation: `${greeting}\n\nYour garage door order has been confirmed. The current estimated lead time is ${leadTime}. We will contact you as soon as it is ready so we can arrange installation.\n\n${signoff}`,
    delivery_delay: `${greeting}\n\nWe have had an update from the supplier. Your order is currently delayed and the revised estimate is ${leadTime}. We will keep monitoring this and update you once we have confirmation.\n\n${signoff}`,
    ready_to_book_installation: `${greeting}\n\nYour garage door has now arrived and is ready. We can now arrange the installation date. Please let us know your availability.\n\n${signoff}`,
    installation_booked: `${greeting}\n\nYour installation is booked for ${installation}. Please ensure access to the garage is clear.\n\n${signoff}`,
    installation_reminder: `${greeting}\n\nThis is a quick reminder that your garage door installation is booked for ${installation}. Please ensure access to the garage is clear.\n\n${signoff}`,
    balance_request: `${greeting}\n\nYour garage door work is now complete. The remaining balance${balance} is now due. Please let us know once payment has been made.\n\n${signoff}`,
    review_request: `${greeting}\n\nThanks for choosing Autodoors Yorkshire. Please let us know if you have any questions. We would really appreciate a review if you are happy with the work.\n\n${signoff}`
  };

  return {
    type,
    label: TEMPLATE_LABELS[type] || "Customer update",
    subject: "Garage door job update",
    body: bodies[type] || bodies.quote_follow_up
  };
}

function deliveryText(lead) {
  if (lead.supplier_estimated_delivery_date) return lead.supplier_estimated_delivery_date;
  if (lead.supplier_estimated_delivery_start && lead.supplier_estimated_delivery_end) return `${lead.supplier_estimated_delivery_start} to ${lead.supplier_estimated_delivery_end}`;
  if (lead.supplier_lead_time_text) return lead.supplier_lead_time_text;
  return "[confirm date/lead time]";
}

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

module.exports = { TEMPLATE_LABELS, generateCustomerUpdateDraft, deliveryText };
