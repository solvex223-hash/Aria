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

// The customer's phone number for alerts. Chats that WhatsApp addresses with a hidden ID show that
// ID instead of a number, so we say so plainly (and give the ID, which /off also understands).
function customerNumberText(lead) {
    const raw = lead.senderNumber || (lead.sender ? String(lead.sender).split("@")[0].split(":")[0] : "");
    const known = lead.numberKnown === undefined ? !String(lead.sender || "").endsWith("@lid") : lead.numberKnown;
    if (!raw) return "Unknown";
    if (known) return `+${raw}`;
    return `hidden by WhatsApp - open the chat with ${lead.customerName || "this person"} to reply (WhatsApp ID: ${raw})`;
}

async function notifyLead(sock, lead) {

    const self = getSelfChatJid(sock);

    const message = `🚨 *NEW LEAD ALERT*

👤 Name: ${lead.customerName || "Unknown"}

🏢 Business: ${lead.businessName || "Not provided"}

📞 Customer number: ${customerNumberText(lead)}

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

📞 Customer number: ${customerNumberText(lead)}

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

📞 Customer number: ${customerNumberText(lead)}

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