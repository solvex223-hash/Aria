const askGroq = require("../ai/groq");
const SYSTEM_PROMPT = require("../ai/prompt");
const validate = require("../ai/responseValidator");
const sendMessage = require("../whatsapp/sender");
const memory = require("../services/memoryService");
const notification = require("../services/notificationService");
const { isBotEnabled } = require("../utils/botState");

async function handleCustomer(sock, sender, text) {
    try {

        // If admin has turned Aria off, don't reply to customers at all
        if (!isBotEnabled()) {
            console.log("⛔ Bot is OFF — ignoring message from", sender);
            return;
        }

        // Save customer's message
        await memory.saveMessage(sender, "user", text);

        // Load conversation history
        const history = await memory.getConversation(sender);

        const messages = history.map(item => ({
            role: item.role,
            content: item.message
        }));

        // Ask Groq
        const raw = await askGroq(
            SYSTEM_PROMPT,
            messages
        );

        // Validate AI response
        const ai = validate(raw);

        // Attach sender so notification messages can tell you who to
        // reply to and reference the right chat
        ai.sender = sender;

        console.log("🤖 Intent:", ai.intent);
        console.log("🔥 Lead Score:", ai.leadScore);

        // ===============================
        // NOTIFICATIONS
        // ===============================

        // Notify on Hot Lead
        if (ai.leadScore >= 80) {
            await notification.notifyLead(sock, ai);
        }

        // Notify when AI requests human assistance
        if (ai.needsHuman) {
            await notification.notifyHandoff(sock, ai);
        }

        // Notify when customer wants an appointment
        if (ai.appointmentRequested) {
            await notification.notifyAppointment(sock, ai);
        }

        // Save AI reply
        await memory.saveMessage(
            sender,
            "assistant",
            ai.reply
        );

        // Reply to customer
        await sendMessage(
            sock,
            sender,
            ai.reply
        );

    } catch (err) {
        console.error("❌ Customer Handler Error:", err);
    }
}

module.exports = {
    handleCustomer
};