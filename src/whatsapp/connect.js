const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");
const P = require("pino");

const handleMessage = require("./listener");

// Your WhatsApp number in international format, no + or spaces.
// e.g. for +234 812 345 6789 -> "2348123456789"
// Set this in Render's Environment tab as WHATSAPP_PHONE_NUMBER
const PHONE_NUMBER = process.env.WHATSAPP_PHONE_NUMBER;

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
  });

  // If we're not already registered/paired, request a pairing code
  // instead of waiting for a QR code.
  if (!sock.authState?.creds?.registered) {
    if (!PHONE_NUMBER) {
      console.error(
        "❌ WHATSAPP_PHONE_NUMBER env var is not set. Add it in Render's Environment tab (e.g. 2348123456789) to request a pairing code."
      );
    } else {
      // Small delay to let the socket initialize before requesting
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(PHONE_NUMBER);
          console.log("📱 Your WhatsApp pairing code is:", code);
          console.log(
            "➡️  On your phone: WhatsApp > Settings > Linked Devices > Link a Device > Link with phone number instead"
          );
        } catch (err) {
          console.error("❌ Failed to request pairing code:", err.message);
        }
      }, 3000);
    }
  }

  // Handle incoming messages
  sock.ev.on("messages.upsert", async (message) => {
    await handleMessage(sock, message);
  });

  // Connection updates
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log("✅ Aria is connected to WhatsApp!");
    }

    if (connection === "close") {
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !==
        DisconnectReason.loggedOut;

      console.log("❌ Connection closed.");

      if (shouldReconnect) {
        console.log("🔄 Reconnecting...");
        startWhatsApp();
      } else {
        console.log("🚪 Logged out.");
      }
    }
  });

  // Save authentication credentials
  sock.ev.on("creds.update", saveCreds);

  return sock;
}

module.exports = startWhatsApp;