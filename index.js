require("dotenv").config();
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const baileys = require("@whiskeysockets/baileys");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");

const { handleAdmin } = require("./src/handlers/admin");
const { handleCustomer } = require("./src/handlers/customer");
const { isAllowed, getSetting, isBlocked, removeAllowed } = require("./src/database/access");

const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || "").replace(/\D/g, "");
const REPLY_DELAY_MS = Number(process.env.REPLY_DELAY_MS || 3000);

// Web server settings. Render sets PORT automatically.
// ARIA_SEND_KEY is the shared secret the Solvex daily-report route sends in the x-api-key header.
const PORT = Number(process.env.PORT || 3000);
const SEND_KEY = process.env.ARIA_SEND_KEY || "";

// Login handling.
// By default Aria links with a pairing code (no QR in the logs). Set SHOW_QR=true to print the QR too.
const AUTH_DIR = "./auth_info";
const SHOW_QR = process.env.SHOW_QR === "true";
const PAIRING_DELAY_MS = Number(process.env.PAIRING_DELAY_MS || 3000);
const RELOGIN_DELAY_MS = Number(process.env.RELOGIN_DELAY_MS || 10000);
const MAX_LOGOUT_RETRIES = 5;
let logoutCount = 0;

// The live WhatsApp connection. startBot() replaces this every time Aria reconnects,
// so /send always uses the current socket.
let activeSock = null;
let connected = false;

function normalizeNumber(n) {
  return n.replace(/\D/g, "");
}

// "2348012345678:12@s.whatsapp.net" or "99887766@lid" -> digits only
function jidNumber(jid) {
  return String(jid || "").split("@")[0].split(":")[0].replace(/\D/g, "");
}

// True when a chat is the admin's own "Message yourself" chat.
function isOwnChat(sock, key) {
  const chat = jidNumber(key.remoteJid);
  const chatAlt = jidNumber(key.remoteJidAlt);
  const own = [jidNumber(sock.user?.id), jidNumber(sock.user?.lid), ADMIN_NUMBER].filter(Boolean);
  return own.includes(chat) || (chatAlt && own.includes(chatAlt));
}

function getRealSenderJid(key) {
  if (key.remoteJid?.endsWith("@lid") && key.remoteJidAlt) {
    return key.remoteJidAlt;
  }
  return key.remoteJid;
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
// WhatsApp login helpers
// ---------------------------------------------------------------------------

// Asks WhatsApp for a pairing code and prints it clearly in the logs. Retries a few times.
async function requestPairing(sock) {
  if (!ADMIN_NUMBER) {
    console.error(
      "❌ ADMIN_NUMBER is not set. Add it in Render's Environment tab (digits only, with country code, e.g. 2348012345678)."
    );
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      // Give the socket a moment to finish connecting before requesting a code
      await new Promise((resolve) => setTimeout(resolve, PAIRING_DELAY_MS));
      const code = await sock.requestPairingCode(ADMIN_NUMBER);
      console.log("🔗 YOUR PAIRING CODE:", code);
      console.log("On your phone: WhatsApp > Settings > Linked Devices > Link a Device > Link with phone number instead");
      return;
    } catch (err) {
      console.error(`❌ Pairing code request failed (attempt ${attempt}/3):`, err.message);
    }
  }
  console.error("❌ Could not get a pairing code. Redeploy or restart the service to try again.");
}

// WhatsApp logged Aria out (for example the linked device was removed). The saved login is now
// useless, so clear it and start fresh. That makes Aria ask for a new pairing code instead of
// crashing and looping with a dead login.
function handleLoggedOut() {
  logoutCount += 1;
  if (logoutCount > MAX_LOGOUT_RETRIES) {
    console.error(
      "❌ Logged out too many times in a row. Stopping retries. Check WhatsApp > Linked Devices, then redeploy."
    );
    return;
  }
  console.log(
    `Logged out of WhatsApp (${logoutCount}/${MAX_LOGOUT_RETRIES}). Clearing the saved login and requesting a new pairing code...`
  );
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch (err) {
    console.error("Could not clear the saved login:", err.message);
  }
  setTimeout(() => {
    startBot().catch((err) => console.error("Restart after logout failed:", err));
  }, RELOGIN_DELAY_MS);
}

// ---------------------------------------------------------------------------
// WhatsApp bot
// ---------------------------------------------------------------------------

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({ auth: state });
  activeSock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && SHOW_QR) {
      console.log("📱 Scan this QR code with WhatsApp > Linked Devices > Link a Device:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      connected = false;
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) {
        console.log("Connection closed. Reconnecting: true");
        startBot().catch((err) => console.error("Reconnect failed:", err));
        return;
      }
      handleLoggedOut();
    } else if (connection === "open") {
      connected = true;
      logoutCount = 0;
      console.log("✅ Aria is connected and online.");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    const msg = messages[0];
    if (!msg.message) return;

    const sender = getRealSenderJid(msg.key);
    const senderNumber = normalizeNumber(sender.split("@")[0]);
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

    if (msg.key.fromMe) {
      // Aria runs on the admin's own number, so the "Message yourself" chat is where the admin
      // types commands. Only live messages typed by the admin count ("notify"). Aria's own replies
      // and the daily reports arrive as "append", so they can never trigger a command loop.
      if (text.trim().startsWith("/") && isOwnChat(sock, msg.key)) {
        if (type !== "notify") {
          console.log(`Ignoring self-chat command (message type: ${type})`);
          return;
        }
        console.log("🛠 Admin command from self-chat:", text.trim().split(/\s+/)[0]);
        return handleAdmin(sock, msg.key.remoteJid, text);
      }
      return;
    }

    if (!text) return;

    if (senderNumber === ADMIN_NUMBER && text.trim().startsWith("/")) {
      return handleAdmin(sock, sender, text);
    }

    // Aria only talks one-to-one. Ignore groups, status updates and channels.
    if (sender.endsWith("@g.us") || sender.endsWith("@broadcast") || sender.endsWith("@newsletter")) return;

    if (text.trim().toUpperCase() === "STOP") {
      removeAllowed(senderNumber);
      await sock.sendMessage(sender, { text: "You've been unsubscribed. Take care!" });
      return;
    }

    // Numbers turned off with /off never get a reply, even in /all on mode
    if (isBlocked(senderNumber)) return;

    const allowAll = getSetting("allow_all", "false") === "true";
    if (!allowAll && !isAllowed(senderNumber)) return;

    await new Promise((r) => setTimeout(r, REPLY_DELAY_MS));

    try {
      await handleCustomer(sock, sender, senderNumber, text);
    } catch (err) {
      console.error("Error handling customer message:", err);
      await sock.sendMessage(sender, { text: "Sorry, I'm having trouble right now. Please try again shortly." });
    }
  });

  // Not linked yet: ask for a pairing code (runs in the background so the handlers above stay active)
  if (!sock.authState.creds.registered) {
    requestPairing(sock);
  }
}

startHttpServer();
startBot().catch((err) => console.error("Failed to start Aria:", err));