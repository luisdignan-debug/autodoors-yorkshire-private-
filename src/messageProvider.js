function messagingStatus(config = {}) {
  const twilio = config.twilio || {};
  return {
    sms: {
      enabled: Boolean(config.sendSmsEnabled),
      configured: Boolean(twilio.accountSid && twilio.authToken && (twilio.messagingServiceSid || twilio.fromNumber)),
      detail: config.sendSmsEnabled ? "SMS sending flag is enabled" : "SMS preview/copy mode"
    },
    whatsapp: {
      enabled: Boolean(config.sendWhatsappEnabled),
      configured: Boolean(twilio.accountSid && twilio.authToken && twilio.whatsappFrom),
      detail: config.sendWhatsappEnabled ? "WhatsApp sending flag is enabled" : "WhatsApp preview/copy mode"
    },
    email: {
      enabled: Boolean(config.sendEmailsEnabled),
      configured: Boolean(config.smtp?.host && config.smtp?.username && config.smtp?.password),
      detail: config.sendEmailsEnabled ? "Invoice email sending flag is enabled" : "Invoice email preview/copy mode"
    }
  };
}

async function sendSms(to, body, { config, state, templateType = "technician_digest" } = {}) {
  if (!config.sendSmsEnabled) return logMessageAttempt(state, { channel: "sms", recipient: to, templateType, body, status: "disabled", errorMessage: "SEND_SMS_ENABLED=false" });
  const status = messagingStatus(config).sms;
  if (!status.configured) return logMessageAttempt(state, { channel: "sms", recipient: to, templateType, body, status: "blocked", errorMessage: "Twilio SMS credentials are incomplete." });
  return logMessageAttempt(state, { channel: "sms", recipient: to, templateType, body, status: "queued", providerMessageId: "twilio-not-called-in-mvp" });
}

async function sendWhatsApp(to, body, templateName = "", variables = {}, { config, state, templateType = "technician_digest" } = {}) {
  if (!config.sendWhatsappEnabled) return logMessageAttempt(state, { channel: "whatsapp", recipient: to, templateType, body, status: "disabled", errorMessage: "SEND_WHATSAPP_ENABLED=false" });
  const status = messagingStatus(config).whatsapp;
  if (!status.configured) return logMessageAttempt(state, { channel: "whatsapp", recipient: to, templateType, body, status: "blocked", errorMessage: "Twilio WhatsApp credentials are incomplete." });
  if (!templateName) return logMessageAttempt(state, { channel: "whatsapp", recipient: to, templateType, body, status: "blocked", errorMessage: "WhatsApp template name is required for controlled outbound messages." });
  return logMessageAttempt(state, { channel: "whatsapp", recipient: to, templateType, body, status: "queued", providerMessageId: "twilio-whatsapp-not-called-in-mvp", variables });
}

function logMessageAttempt(state, { channel, recipient, templateType, body, status, providerMessageId = "", errorMessage = "", variables = {} }) {
  if (state && !Array.isArray(state.messageLogs)) state.messageLogs = [];
  const entry = {
    id: `message:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    channel,
    recipient: recipient || "",
    template_type: templateType || "",
    body_preview: String(body || "").slice(0, 240),
    status,
    provider_message_id: providerMessageId,
    error_message: errorMessage,
    variables,
    sent_at: status === "queued" || status === "sent" ? new Date().toISOString() : "",
    created_at: new Date().toISOString()
  };
  if (state) state.messageLogs.push(entry);
  return entry;
}

function whatsappLink(to, body) {
  const digits = String(to || "").replace(/[^\d+]/g, "");
  if (!digits) return "";
  return `https://wa.me/${encodeURIComponent(digits.replace(/^\+/, ""))}?text=${encodeURIComponent(body || "")}`;
}

module.exports = {
  messagingStatus,
  sendSms,
  sendWhatsApp,
  logMessageAttempt,
  whatsappLink
};
