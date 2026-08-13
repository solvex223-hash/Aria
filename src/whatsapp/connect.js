const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");
const P = require("pino");
const qrcode = require("qrcode-terminal");

const handleMessage = require("./listener");

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
  });

  // Handle incoming messages
  sock.ev.on("messages.upsert", async (message) => {
    await handleMessage(sock, message);
  });

  // Connection updates
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.clear();
      console.log("📱 Scan this QR Code with WhatsApp:\n");
      qrcode.generate(qr, { small: true });
    }

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