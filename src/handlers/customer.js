const askGroq = require("../ai/groq");
const SYSTEM_PROMPT = require("../ai/prompt");
const validate = require("../ai/responseValidator");
const sendMessage = require("../whatsapp/sender");
const memory = require("../services/memoryService");
const notification = require("../services/notificationService");
const { isBotEnabled } = require("../utils/botState");

async function handleCustomer(sock, sender, senderNumber, text, options = {}) {
    const { isGroup = false, groupJid = null, quotedMsg = null } = options;
    const conversationKey = isGroup ? groupJid : sender;

    try {

        // If admin has turned Aria off, don't reply to customers at all
        if (!isBotEnabled()) {
            console.log("⛔ Bot is OFF — ignoring message from", sender);
            return;
        }

        // If the transcript/message is genuinely empty, use fallback
        if (!text || !text.trim()) {
            const fallback = "I'm sorry, I didn't catch that. Could you please send it again? 😊";
            if (isGroup && quotedMsg) {
                await sock.sendMessage(conversationKey, { text: fallback, quoted: quotedMsg });
            } else {
                await sendMessage(sock, conversationKey, fallback);
            }
            return;
        }

        // Save customer's message
        await memory.saveMessage(conversationKey, "user", text);

        // Load conversation history (per group or per private chat)
        const history = await memory.getConversation(conversationKey);

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

        // ===============================
        // NOTIFICATIONS (private chats only)
        // ===============================
        if (!isGroup) {
            console.log("🔥 Lead Score:", ai.leadScore);

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
        }

        // Save AI reply
        await memory.saveMessage(
            conversationKey,
            "assistant",
            ai.reply
        );

        // Reply to customer (quote in groups)
        if (isGroup && quotedMsg) {
            await sock.sendMessage(conversationKey, { text: ai.reply, quoted: quotedMsg });
        } else {
            await sendMessage(
                sock,
                conversationKey,
                ai.reply
            );
        }

    } catch (err) {
        // Log the real error with full details (model is logged inside askGroq)
        console.error("❌ Customer Handler Error:", err.message);

        // Only send fallback if we haven't already sent a response
        const fallback = "I'm sorry, something went wrong. Please try again in a moment 😊";
        if (isGroup && quotedMsg) {
            await sock.sendMessage(conversationKey, { text: fallback, quoted: quotedMsg });
        } else {
            await sendMessage(sock, conversationKey, fallback);
        }
    }
}

module.exports = {
    handleCustomer
};