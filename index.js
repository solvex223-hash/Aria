require("dotenv").config();
const http = require("http");
const crypto = require("crypto");
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

// Web server settings. Render sets PORT automatically.
// ARIA_SEND_KEY is the shared secret the Solvex daily-report route sends in the x-api-key header.
const PORT = Number(process.env.PORT || 3000);
const SEND_KEY = process.env.ARIA_SEND_KEY || "";

// The live WhatsApp connection. startBot() replaces this every time Aria reconnects,
// so /send always uses the current socket.
let activeSock = null;
let connected = false;

function normalizeNumber(n) {
  return n.replace(/\D/g, "");
}

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

// ---------------------------------------------------------------------------
// Web server: health check for your uptime pinger + POST /send for the daily report
// ---------------------------------------------------------------------------

function keyMatches(provided) {
  const a = Buffer.from(String(provided || ""));
  const b = Buffer.from(SEND_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        const err = new Error("Body too large");
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleSend(req, json) {
  if (!SEND_KEY) {
    return json(503, { error: "ARIA_SEND_KEY is not set on this server" });
  }
  if (!keyMatches(req.headers["x-api-key"])) {
    return json(401, { error: "Unauthorized" });
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    if (err.statusCode === 413) return json(413, { error: "Body too large" });
    return json(400, { error: "Body must be valid JSON" });
  }

  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  if (!message) return json(400, { error: "message is required" });
  if (message.length > 4000) {
    return json(400, { error: "message is too long (max 4000 characters)" });
  }

  // Safety: /send can only ever message the admin number, so a leaked key
  // can't be used to spam other people from your WhatsApp.
  const to = normalizeNumber(String(payload.to || ADMIN_NUMBER));
  if (!ADMIN_NUMBER || to !== ADMIN_NUMBER) {
    return json(403, { error: "Recipient not allowed" });
  }

  if (!connected || !activeSock) {
    return json(503, { error: "WhatsApp is not connected" });
  }

  try {
    await activeSock.sendMessage(`${to}@s.whatsapp.net`, { text: message });
    console.log("📤 Report sent to admin via /send");
    return json(200, { ok: true });
  } catch (err) {
    console.error("❌ /send failed:", err);
    return json(500, { error: err.message || "Send failed" });
  }
}

function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    try {
      const path = (req.url || "/").split("?")[0];

      // Health check: always 200 so your uptime pinger keeps Render awake.
      if ((req.method === "GET" || req.method === "HEAD") && (path === "/" || path === "/health")) {
        return json(200, { ok: true, whatsapp: connected ? "connected" : "disconnected" });
      }

      if (req.method === "POST" && path === "/send") {
        return await handleSend(req, json);
      }

      return json(404, { error: "Not found" });
    } catch (err) {
      console.error("HTTP handler error:", err);
      if (!res.headersSent) return json(500, { error: "Internal error" });
    }
  });

  server.on("error", (err) => console.error("HTTP server error:", err));
  server.listen(PORT, () => console.log(`🌐 Aria web server listening on port ${PORT}`));
}

// ---------------------------------------------------------------------------
// WhatsApp bot
// ---------------------------------------------------------------------------

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
  const sock = makeWASocket({ auth: state });
  activeSock = sock;

  sock.ev.on("creds.update", saveCreds);

  if (!sock.authState.creds.registered) {
    // Wait for the socket to actually finish connecting before requesting a code
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const phoneNumber = ADMIN_NUMBER;
    const code = await sock.requestPairingCode(phoneNumber);
    console.log("🔗 Your pairing code:", code);
    console.log("On your phone: WhatsApp > Settings > Linked Devices > Link a Device > Link with phone number instead");
  }

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📱 Scan this QR code with WhatsApp > Linked Devices > Link a Device:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      connected = false;
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Connection closed. Reconnecting:", shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      connected = true;
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

    if (senderNumber === ADMIN_NUMBER && text.trim().startsWith("/")) {
      return handleAdmin(sock, sender, text);
    }

    if (text.trim().toUpperCase() === "STOP") {
      const { removeAllowed } = require("./src/database/db");
      removeAllowed(senderNumber);
      await sock.sendMessage(sender, { text: "You've been unsubscribed. Take care!" });
      return;
    }

    const allowAll = getSetting("allow_all", "false") === "true";
    if (!allowAll && !isAllowed(senderNumber)) return;

    if (!isOfficeHours()) return;

    await new Promise((r) => setTimeout(r, REPLY_DELAY_MS));

    try {
      await handleCustomer(sock, sender, senderNumber, text);
    } catch (err) {
      console.error("Error handling customer message:", err);
      await sock.sendMessage(sender, { text: "Sorry, I'm having trouble right now. Please try again shortly." });
    }
  });
}

startHttpServer();
startBot();