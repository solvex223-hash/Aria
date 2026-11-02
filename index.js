require("dotenv").config();
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const baileys = require("@whiskeysockets/baileys");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = baileys;
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");

const { handleAdmin } = require("./src/handlers/admin");
const { handleCustomer } = require("./src/handlers/customer");
const { isAllowed, getSetting, isBlocked, removeAllowed } = require("./src/database/access");
const { isGroup, shouldReplyInGroup, handleGroupCommand, GROUP_HELP } = require("./groupControl");

// Voice note and image helpers. If a file path is wrong, Aria still starts
// and tells you which feature is switched off and why.
let transcribeAudio = null;
let describeImage = null;
try {
  transcribeAudio = require("./src/ai/transcribe");
} catch (err) {
  console.warn("⚠️ Voice notes are OFF: could not load ./src/ai/transcribe.js -", err.message);
}
try {
  describeImage = require("./src/ai/vision");
} catch (err) {
  console.warn("⚠️ Images are OFF: could not load ./src/ai/vision.js -", err.message);
}

const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || "").replace(/\D/g, "");
const REPLY_DELAY_MS = Number(process.env.REPLY_DELAY_MS || 3000);

const VOICE_FAIL_REPLY =
  "Sorry, I couldn't hear that voice note properly. Could you send it again or type it out?";
const IMAGE_FAIL_REPLY =
  "Sorry, I couldn't open that picture. Could you send it again or tell me what's in it?";

// Web server settings. Render sets PORT automatically.
// ARIA_SEND_KEY is the shared secret the Solvex daily-report route sends in the x-api-key header.
const PORT = Number(process.env.PORT || 3000);
const SEND_KEY = process.env.ARIA_SEND_KEY || "";

// Login handling.
// By default Aria links with a pairing code (no QR in the logs). Set SHOW_QR=true to print the QR too.
const AUTH_DIR = "./auth_info";
const SHOW_QR = process.env.SHOW_QR === "true";
const PAIRING_DELAY_MS = Number(process.env.PAIRING_DELAY_MS || 3000);
// A new pairing code is requested this often until Aria is linked (default: every 60 seconds)
const PAIRING_REFRESH_MS = Number(process.env.PAIRING_REFRESH_MS || 60000);
const RELOGIN_DELAY_MS = Number(process.env.RELOGIN_DELAY_MS || 10000);
const MAX_LOGOUT_RETRIES = 5;
let logoutCount = 0;

// The live WhatsApp connection. startBot() replaces this every time Aria reconnects,
// so /send always uses the current socket.
let activeSock = null;
let connected = false;

// Stops the pairing-code loop that is currently running (if any)
let stopCurrentPairing = null;

// A logger that prints nothing, needed by Baileys' media download
const silentLogger = {
  level: "silent",
  child() {
    return silentLogger;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

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

// Unwraps messages inside disappearing-message / view-once wrappers
function normalizeContent(message) {
  try {
    return (baileys.normalizeMessageContent && baileys.normalizeMessageContent(message)) || message;
  } catch {
    return message;
  }
}

// Shows "typing..." to the customer. A nicety, so it must never break a reply.
async function setTyping(sock, jid, on) {
  try {
    await sock.sendPresenceUpdate(on ? "composing" : "paused", jid);
  } catch {
    // ignore
  }
}

function downloadMedia(msg, sock) {
  return downloadMediaMessage(msg, "buffer", {}, {
    logger: silentLogger,
    reuploadRequest: sock.updateMediaMessage,
  });
}

// Voice note -> text. Returns "" if anything goes wrong.
async function voiceNoteToText(msg, sock, audio) {
  if (!transcribeAudio) return "";
  try {
    const buffer = await downloadMedia(msg, sock);
    const transcript = await transcribeAudio(buffer, audio.mimetype || "audio/ogg");
    console.log(`🎙️ Voice note transcribed: "${transcript}"`);
    return transcript;
  } catch (err) {
    console.error("❌ Voice note failed:", err.message);
    return "";
  }
}

// Picture -> text for Aria to read. Returns "" if anything goes wrong.
async function imageToText(msg, sock, image) {
  if (!describeImage) return "";
  try {
    const buffer = await downloadMedia(msg, sock);
    const caption = (image.caption || "").trim();
    const description = await describeImage(buffer, caption, image.mimetype || "image/jpeg");
    console.log("🖼️ Image described");
    return caption
      ? `${caption}\n\n[The customer attached a picture. What it shows: ${description}]`
      : `[The customer sent a picture. What it shows: ${description}]`;
  } catch (err) {
    console.error("❌ Image failed:", err.message);
    return "";
  }
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

function stopPairing() {
  if (stopCurrentPairing) {
    stopCurrentPairing();
    stopCurrentPairing = null;
  }
}

// Prints a fresh pairing code every PAIRING_REFRESH_MS until Aria is linked.
// Each new code replaces the previous one, so always use the newest code in the logs.
function startPairing(sock) {
  stopPairing();

  if (!ADMIN_NUMBER) {
    console.error(
      "❌ ADMIN_NUMBER is not set. Add it in Render's Environment tab (digits only, with country code, e.g. 2348012345678)."
    );
    return;
  }

  console.log(`📞 Pairing codes will be generated for: +${ADMIN_NUMBER}`);
  console.log("   This must be the WhatsApp number of the phone you are linking.");
  if (ADMIN_NUMBER.startsWith("0") || ADMIN_NUMBER.length < 11) {
    console.warn(
      "⚠️ ADMIN_NUMBER looks wrong. Use the full international format with no + or leading 0, e.g. 2348012345678. A wrong number causes 'incorrect phone number' on the phone."
    );
  }

  let stopped = false;
  let timeout = null;
  let interval = null;
  let attempt = 0;

  const stop = () => {
    stopped = true;
    clearTimeout(timeout);
    clearInterval(interval);
  };
  stopCurrentPairing = stop;

  const issueCode = async () => {
    if (stopped) return;
    // Stop once linked, connected, or replaced by a newer socket
    if (sock !== activeSock || connected || sock.authState.creds.registered) {
      stop();
      return;
    }
    attempt += 1;
    try {
      const code = await sock.requestPairingCode(ADMIN_NUMBER);
      console.log(`🔗 PAIRING CODE #${attempt} for +${ADMIN_NUMBER}: ${code}`);
      console.log(
        "   On your phone: WhatsApp > Settings > Linked Devices > Link a Device > Link with phone number instead"
      );
      console.log(`   A new code will be printed in ${Math.round(PAIRING_REFRESH_MS / 1000)}s if this one isn't used.`);
    } catch (err) {
      console.error(`❌ Pairing code request #${attempt} failed:`, err.message);
    }
  };

  // First code after a short delay so the socket can finish connecting, then repeat
  timeout = setTimeout(() => {
    issueCode();
    if (!stopped) interval = setInterval(issueCode, PAIRING_REFRESH_MS);
  }, PAIRING_DELAY_MS);
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
  stopPairing();

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
      stopPairing();
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
      stopPairing();
      console.log("✅ Aria is connected and online.");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    const msg = messages[0];
    if (!msg.message) return;

    const isGroupChat = isGroup(msg.key.remoteJid);
    const remoteJid = msg.key.remoteJid;

    // For groups, the actual sender is participant; for private chats it's the remoteJid
    const participant = msg.key.participant || remoteJid;
    const sender = getRealSenderJid({ remoteJid: participant });
    const senderNumber = normalizeNumber(sender.split("@")[0]);
    const content = normalizeContent(msg.message);
    const text = content.conversation || content.extendedTextMessage?.text || "";

    // Admin check: fromMe in self-chat (private) OR sender is admin number
    const isAdminSender = senderNumber === ADMIN_NUMBER;
    const isSelfChatFromMe = msg.key.fromMe && isOwnChat(sock, msg.key);

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
        // Group commands (/groups, /group on|off|mode ...) typed in the self-chat
        const groupReply = await handleGroupCommand(sock, msg, text, true);
        if (groupReply) {
          await sock.sendMessage(msg.key.remoteJid, { text: groupReply });
          return;
        }
        return handleAdmin(sock, msg.key.remoteJid, text);
      }
      return;
    }

    // Only answer live messages. Old chats synced after linking arrive as "append"
    // and must never get a reply.
    if (type !== "notify") return;

    const audio = content.audioMessage;
    const image = content.imageMessage;

    // Nothing Aria can read (stickers, videos, documents and so on)
    if (!text && !audio && !image) return;

    // ===== PRIVATE CHATS =====
    if (!isGroupChat) {
      // Admin in private chat = admin number OR self-chat (Message yourself)
      const isAdminPrivate = isAdminSender || isSelfChatFromMe;

      // Check for group control commands from admin in private chat
      if (isAdminPrivate) {
        const groupReply = await handleGroupCommand(sock, msg, text, true);
        if (groupReply) {
          await sock.sendMessage(remoteJid, { text: groupReply });
          return;
        }
      }

      // Admin commands in private chat (only from admin)
      if (isAdminPrivate && text.trim().startsWith("/")) {
        return handleAdmin(sock, sender, text);
      }

      // Ignore broadcasts/channels
      if (sender.endsWith("@broadcast") || sender.endsWith("@newsletter")) return;

      if (text.trim().toUpperCase() === "STOP") {
        removeAllowed(senderNumber);
        await sock.sendMessage(sender, { text: "You've been unsubscribed. Take care!" });
        return;
      }

      // Numbers turned off with /off never get a reply, even in /all on mode
      if (isBlocked(senderNumber)) return;

      const allowAll = getSetting("allow_all", "false") === "true";
      if (!allowAll && !isAllowed(senderNumber)) return;

      const startedAt = Date.now();
      await setTyping(sock, sender, true);

      try {
        let customerText = text;

        // Voice notes and pictures are only processed for people Aria is allowed to answer
        if (audio) {
          customerText = await voiceNoteToText(msg, sock, audio);
          if (!customerText) {
            await sock.sendMessage(sender, { text: VOICE_FAIL_REPLY });
            return;
          }
        } else if (image) {
          customerText = await imageToText(msg, sock, image);
          if (!customerText) {
            await sock.sendMessage(sender, { text: IMAGE_FAIL_REPLY });
            return;
          }
        }

        // Human-like pause. Time already spent on a voice note or picture counts toward it.
        await sleep(REPLY_DELAY_MS - (Date.now() - startedAt));

        await handleCustomer(sock, sender, senderNumber, customerText);
      } catch (err) {
        console.error("Error handling customer message:", err);
        await sock.sendMessage(sender, { text: "Sorry, I'm having trouble right now. Please try again shortly." });
      } finally {
        await setTyping(sock, sender, false);
      }
      return;
    }

    // ===== GROUP CHATS =====
    // Check if we should reply in this group
    const botIds = [sock.user?.id, sock.user?.lid];
    if (!shouldReplyInGroup(msg, botIds)) {
      return; // silently ignore
    }

    // Log group JID and mentionedJid for debugging
    const m = msg.message || {};
    const ctx = m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo || m.audioMessage?.contextInfo || m.videoMessage?.contextInfo || {};
    const mentioned = (ctx.mentionedJid || []).map(j => j.split("@")[0]).join(",");
    console.log(`👥 Group: ${remoteJid} | mentions: [${mentioned}]`);

    // Strip bot's own @mention from text
    let cleanText = text;
    const botIdClean = (sock.user?.id || "").split(":")[0].split("@")[0];
    const botLidClean = (sock.user?.lid || "").split(":")[0].split("@")[0];
    const mentionPatterns = [
      new RegExp(`@${botIdClean}\\b`),
      new RegExp(`@${botLidClean}\\b`),
      /@\d+/g
    ];
    for (const pattern of mentionPatterns) {
      cleanText = cleanText.replace(pattern, "").trim();
    }

    const startedAt = Date.now();
    await setTyping(sock, remoteJid, true);

    try {
      let customerText = cleanText;

      // Voice notes and pictures are processed for allowed groups
      if (audio) {
        customerText = await voiceNoteToText(msg, sock, audio);
        if (!customerText) {
          await sock.sendMessage(remoteJid, { text: VOICE_FAIL_REPLY, quoted: msg });
          return;
        }
      } else if (image) {
        customerText = await imageToText(msg, sock, image);
        if (!customerText) {
          await sock.sendMessage(remoteJid, { text: IMAGE_FAIL_REPLY, quoted: msg });
          return;
        }
      }

      // Human-like pause. Time already spent on a voice note or picture counts toward it.
      await sleep(REPLY_DELAY_MS - (Date.now() - startedAt));

      // In groups: use group JID as conversation key, don't do lead scoring/saving as lead
      // Pass isGroup flag to handleCustomer
      await handleCustomer(sock, remoteJid, senderNumber, customerText, {
        isGroup: true,
        groupJid: remoteJid,
        quotedMsg: msg
      });
    } catch (err) {
      console.error("Error handling group message:", err);
      await sock.sendMessage(remoteJid, { text: "Sorry, I'm having trouble right now. Please try again shortly.", quoted: msg });
    } finally {
      await setTyping(sock, remoteJid, false);
    }
  });

  // Not linked yet: keep printing a fresh pairing code until the phone is linked
  // (runs in the background so the handlers above stay active)
  if (!sock.authState.creds.registered) {
    startPairing(sock);
  }
}

startHttpServer();
startBot().catch((err) => console.error("Failed to start Aria:", err));