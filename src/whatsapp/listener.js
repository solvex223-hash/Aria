const router = require("../handlers/router");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const describeImage = require("../ai/vision");
const transcribeAudio = require("../ai/transcribe");

async function handleMessage(sock, message) {

    try {

        const msg = message.messages[0];

        if (!msg) return;

        const remoteJid = msg.key.remoteJid;

        if (remoteJid === "status@broadcast") return;

        if (remoteJid.endsWith("@g.us")) return;

        // WhatsApp routes "Message Yourself" through a special @lid JID
        // (a "linked ID"), NOT your normal phone-number JID. So self-chat
        // is detected by the @lid suffix.
        const isSelfChat = remoteJid.endsWith("@lid");

        let text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            "";

        // Handle images — download, describe via Groq vision, treat the
        // description as the "text" for the rest of the pipeline
        if (msg.message?.imageMessage) {
            console.log("🖼️  Image received, downloading...");
            try {
                const buffer = await downloadMediaMessage(msg, "buffer", {});
                const caption = msg.message.imageMessage.caption || "";
                const description = await describeImage(buffer, caption);
                text = caption
                    ? `[Customer sent an image: ${description}] ${caption}`
                    : `[Customer sent an image: ${description}]`;
                console.log("🖼️  Image described:", description);
            } catch (err) {
                console.error("❌ Failed to process image:", err);
                return;
            }
        }

        // Handle voice notes — download, transcribe via Groq Whisper,
        // treat the transcript as the "text" for the rest of the pipeline
        if (msg.message?.audioMessage) {
            console.log("🎤 Voice note received, downloading...");
            try {
                const buffer = await downloadMediaMessage(msg, "buffer", {});
                const transcript = await transcribeAudio(buffer);
                if (!transcript) {
                    console.log("🎤 Transcription came back empty, skipping.");
                    return;
                }
                text = transcript;
                console.log("🎤 Transcribed:", transcript);
            } catch (err) {
                console.error("❌ Failed to process voice note:", err);
                return;
            }
        }

        if (!text) return;

        if (msg.key.fromMe) {

            // fromMe is true both when Aria replies to a customer AND
            // when you send a message from your own phone. Only the
            // self-chat case (you messaging yourself) is an admin command.
            if (isSelfChat) {
                if (text.trim().startsWith("/")) {
                    console.log("🔑 Admin command:", text);
                }
                return await router(sock, remoteJid, text, { isAdmin: true });
            }

            // Otherwise this is Aria's own outgoing reply echoing back — ignore it
            return;
        }

        const sender = remoteJid;

        console.log("📩", sender, ":", text);

        await router(sock, sender, text, { isAdmin: false });

    } catch (err) {

        console.error(err);

    }

}

module.exports = handleMessage;