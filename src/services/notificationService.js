const sendMessage = require("../whatsapp/sender");

// Self-chat on WhatsApp multi-device uses a special @lid JID, not your
// normal phone-number JID. Baileys exposes it as sock.user.lid once
// connected, but it can carry a device suffix (e.g. "123:12@lid") that
// needs stripping to match the plain "123@lid" format remoteJid uses.
// Falls back to sock.user.id only if lid isn't available (older Baileys).
function getSelfChatJid(sock) {
    const raw = sock.user.lid || sock.user.id;
    const [idPart, domain] = raw.split("@");
    return `${idPart.split(":")[0]}@${domain}`;
}

async function notifyLead(sock, lead) {

    const self = getSelfChatJid(sock);

    const message = `🚨 *NEW LEAD ALERT*

👤 Name: ${lead.customerName || "Unknown"}

🏢 Business: ${lead.businessName || "Not provided"}

💼 Service: ${lead.interestedService || "General Inquiry"}

🔥 Lead Score: ${lead.leadScore}

📍 Location: ${lead.location || "Unknown"}

📝 Summary:
${lead.summary || "No summary available"}

Reply to the customer directly from your WhatsApp if human assistance is required.`;

    await sendMessage(sock, self, message);

    console.log("✅ Lead notification sent to self-chat.");
}

async function notifyHandoff(sock, lead) {

    const self = getSelfChatJid(sock);

    const message = `🆘 *HUMAN HANDOFF NEEDED*

👤 Name: ${lead.customerName || "Unknown"}

🏢 Business: ${lead.businessName || "Not provided"}

📞 Customer number: ${lead.sender ? lead.sender.split("@")[0] : "Unknown"}

💼 Reason/Service: ${lead.interestedService || lead.summary || "Not specified"}

📝 Summary:
${lead.summary || "No summary available"}

Aria couldn't fully handle this one — jump into the chat with the customer above when you get a chance.`;

    await sendMessage(sock, self, message);

    console.log("🆘 Handoff notification sent to self-chat.");
}

async function notifyAppointment(sock, lead) {

    const self = getSelfChatJid(sock);

    const message = `📅 *APPOINTMENT REQUESTED*

👤 Name: ${lead.customerName || "Unknown"}

🏢 Business: ${lead.businessName || "Not provided"}

📞 Customer number: ${lead.sender ? lead.sender.split("@")[0] : "Unknown"}

💼 Service: ${lead.interestedService || "General Inquiry"}

📝 Summary:
${lead.summary || "No summary available"}

Reach out to confirm a date/time.`;

    await sendMessage(sock, self, message);

    console.log("📅 Appointment notification sent to self-chat.");
}

module.exports = {
    notifyLead,
    notifyHandoff,
    notifyAppointment
};