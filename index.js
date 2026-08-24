require("dotenv").config();
const baileys = require("@whiskeysockets/baileys");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");

const { handleAdmin } = require("./src/handlers/admin");
const { handleCustomer } = require("./src/handlers/customer");
const { isAllowed, getSetting } = require("./src/database/db");

const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || "").replace(/\D/g, "");
const OFFICE_START_HOUR = Number(process.env.OFFICE_START_HOUR || 8);
const OFFICE_END_HOUR = Number(process.env.OFFICE_END_HOUR || 22);
const REPLY_DELAY_MS = 3000;

function normalizeNumber(n) {
  return n.replace(/\D/g, "");
}

// WhatsApp increasingly sends an opaque @lid identifier instead of the real
// phone number. When that happens, Baileys provides the real number in
// key.remoteJidAlt — fall back to that instead of parsing the LID as if it
// were a phone number.
function getRealSenderJid(key) {
  if (key.remoteJid?.endsWith("@lid") && key.remoteJidAlt) {
    return key.remoteJidAlt;
  }
  return key.remoteJid;
}
function isOfficeHours() {
  const lagosHour = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Africa/Lagos" })
  ).getHours();
  return lagosHour >= OFFICE_START_HOUR && lagosHour < OFFICE_END_HOUR;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
  const sock = makeWASocket({ auth: state });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📱 Scan this QR code with WhatsApp > Linked Devices > Link a Device:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Connection closed. Reconnecting:", shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      console.log("✅ Aria is connected and online.");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = getRealSenderJid(msg.key);
    const senderNumber = normalizeNumber(sender.split("@")[0]);
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    if (!text) return;

    // Admin commands (self-chat, starts with "/")
    if (senderNumber === ADMIN_NUMBER && text.trim().startsWith("/")) {
      return handleAdmin(sock, sender, text);
    }

    // STOP keyword
    if (text.trim().toUpperCase() === "STOP") {
      const { removeAllowed } = require("./database/db");
      removeAllowed(senderNumber);
      await sock.sendMessage(sender, { text: "You've been unsubscribed. Take care!" });
      return;
    }

    // Permission check
    const allowAll = getSetting("allow_all", "false") === "true";
    if (!allowAll && !isAllowed(senderNumber)) return; // silently ignore

    // Office hours check
    if (!isOfficeHours()) return;

    // Human-like delay
    await new Promise((r) => setTimeout(r, REPLY_DELAY_MS));

    try {
      await handleCustomer(sock, sender, senderNumber, text);
    } catch (err) {
      console.error("Error handling customer message:", err);
      await sock.sendMessage(sender, { text: "Sorry, I'm having trouble right now. Please try again shortly." });
    }
  });
}

startBot();