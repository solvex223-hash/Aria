const askGroq = require("../ai/groq");
const SYSTEM_PROMPT = require("../ai/prompt");
const validate = require("../ai/responseValidator");
const sendMessage = require("../whatsapp/sender");
const memory = require("../services/memoryService");
const notification = require("../services/notificationService");
const { isBotEnabled } = require("../utils/botState");
const { typingDelay } = require("../whatsapp/typing");
const { languageProfile, busyMessage } = require("../ai/languageHint");
const { vibeBlock } = require("../services/groupVibe");
const aiHealth = require("../services/aiHealth");

// How many earlier messages go to the AI each time, and how long each one may be. Fewer and shorter
// means fewer tokens per reply, so the daily limit lasts longer. (Settings: HISTORY_MESSAGES, HISTORY_MAX_CHARS)
const HISTORY_MESSAGES = Math.max(4, Number(process.env.HISTORY_MESSAGES) || 14);
const HISTORY_MAX_CHARS = Math.max(200, Number(process.env.HISTORY_MAX_CHARS) || 700);

async function handleCustomer(sock, sender, senderNumber, text, options = {}) {
    const { isGroup = false, groupJid = null, quotedMsg = null } = options;
    const conversationKey = isGroup ? groupJid : sender;
    let customerTexts = [];

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
                await sock.sendMessage(conversationKey, { text: fallback }, { quoted: quotedMsg });
            } else {
                await sendMessage(sock, conversationKey, fallback);
            }
            return;
        }

        // Save customer's message
        await memory.saveMessage(conversationKey, "user", text);

        // Load conversation history (per group or per private chat)
        const history = await memory.getConversation(conversationKey, HISTORY_MESSAGES);

        // Older messages are shortened (the newest one is always sent in full)
        const messages = history.map((item, i) => ({
            role: item.role,
            content:
                i < history.length - 1 && item.message.length > HISTORY_MAX_CHARS
                    ? `${item.message.slice(0, HISTORY_MAX_CHARS)}...`
                    : item.message
        }));

        // In groups, show Aria what people have just been saying and the mood of the room, so her
        // reply fits in. This lives in memory only and is never saved.
        if (isGroup) {
            const vibe = vibeBlock(groupJid || conversationKey);
            if (vibe) {
                messages.push({ role: "system", content: vibe });
            }
        }

        // A reminder placed right before the answer. It names the language of the LAST message
        // (English, Pidgin, Yoruba...) so Aria switches when the person switches, instead of copying
        // the language of her own earlier replies. Not saved to history.
        customerTexts = history.filter((item) => item.role === "user").map((item) => item.message);
        const profile = languageProfile(customerTexts, conversationKey);
        messages.push({
            role: "system",
            content: `${profile.instruction} Return only the JSON object.`,
        });

        // Time spent thinking counts toward the "typing..." time, so replies feel human
        const thinkStart = Date.now();

        // Ask Groq
        // (hard languages like Georgian are sent to the strongest available model first)
        const raw = await askGroq(
            SYSTEM_PROMPT,
            messages,
            { strong: profile.strong }
        );

        // Tell the owner if a model ran out of its daily limit and Aria switched to another one
        aiHealth.processEvents(sock).catch(() => {});

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

        // Keep "typing..." visible for about as long as a person would take to type this reply
        await typingDelay(ai.reply, thinkStart);

        // Reply to customer (quote in groups)
        if (isGroup && quotedMsg) {
            await sock.sendMessage(conversationKey, { text: ai.reply }, { quoted: quotedMsg });
        } else {
            await sendMessage(
                sock,
                conversationKey,
                ai.reply
            );
        }

    } catch (err) {
        // Log the real error with full details (the provider and reason are in the message)
        console.error("❌ Customer Handler Error:", err.message);

        // When the AI itself could not answer, tell the owner (at most every 20 minutes) and give
        // the customer a kind, honest message instead of a vague error
        const aiProblem = err && err.name === "LlmError";
        if (aiProblem) {
            aiHealth.reportFailure(sock, err).catch(() => {});
        }
        const waitSeconds = err && err.kind === "busy" ? Math.ceil((err.retryAfterMs || 0) / 1000) : 0;
        const fallback = aiProblem
            ? busyMessage(customerTexts, waitSeconds)
            : "Sorry, I couldn't process that. Could you send it again? 😊";

        try {
            if (isGroup && quotedMsg) {
                await sock.sendMessage(conversationKey, { text: fallback }, { quoted: quotedMsg });
            } else {
                await sendMessage(sock, conversationKey, fallback);
            }
        } catch (sendErr) {
            console.error("❌ Could not send the fallback message:", sendErr.message);
        }
    }
}

module.exports = {
    handleCustomer
};