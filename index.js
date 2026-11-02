require("dotenv").config();
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const baileys = require("@whiskeysockets/baileys");
const {
  default: makeWASocket,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = baileys;
const pino = require("pino");
const qrcode = require("qrcode-terminal");

const { openAuthStore, clearAuthStore, describeAuthStore } = require("./src/whatsapp/authStore");

const { handleAdmin } = require("./src/handlers/admin");
const { handleCustomer } = require("./src/handlers/customer");
const { isAllowed, getSetting, isBlocked, removeAllowed } = require("./src/database/access");
const { isGroup, shouldReplyInGroup, handleGroupCommand, GROUP_HELP } = require("./groupControl");
const { setTyping, markRead, readPause } = require("./src/whatsapp/typing");

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
// Human-like behaviour (blue ticks, "typing...", a short pause) lives in ./src/whatsapp/typing.js.
// Turn it off with SHOW_TYPING=false or MARK_READ=false.
// Answer everyone who messages (except numbers turned off with /off). Set REPLY_TO_ALL=false
// to go back to answering only numbers turned on with /on. A /all on or /all off typed by the
// admin still wins over this default.
const REPLY_TO_ALL = !["false", "0", "no", "off"].includes(String(process.env.REPLY_TO_ALL ?? "true").trim().toLowerCase());
// Safety brake: at most this many replies per chat per minute, so Aria can never get stuck in
// a loop with another bot (and WhatsApp doesn't flag the number).
const DEBUG_MESSAGES = String(process.env.DEBUG_MESSAGES ?? "true").trim().toLowerCase() !== "false";
const MAX_REPLIES_PER_MIN = Number(process.env.MAX_REPLIES_PER_MIN || 8);
const replyLog = new Map();
function overRateLimit(jid) {
  const now = Date.now();
  const recent = (replyLog.get(jid) || []).filter((t) => now - t < 60000);
  if (recent.length >= MAX_REPLIES_PER_MIN) {
    replyLog.set(jid, recent);
    return true;
  }
  recent.push(now);
  replyLog.set(jid, recent);
  return false;
}

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
// Where the login is saved (files or Supabase) is decided in ./src/whatsapp/authStore.js
// QR mode: run "node index.js --qr" (or set SHOW_QR=true)
const SHOW_QR =
  process.argv.includes("--qr") ||
  ["true", "1", "yes", "on"].includes(String(process.env.SHOW_QR || "").trim().toLowerCase());
// If WhatsApp never signals that it is ready, ask for the pairing code anyway after this long
const PAIRING_FALLBACK_MS = Number(process.env.PAIRING_FALLBACK_MS || 8000);
// Pause before starting a clean pairing round
const RELOGIN_DELAY_MS = Number(process.env.RELOGIN_DELAY_MS || 4000);
// Stop asking for pairing codes after this many tries, so WhatsApp doesn't flag the number
const MAX_PAIRING_ROUNDS = Number(process.env.MAX_PAIRING_ROUNDS || 6);
// Baileys log level: "warn" keeps the logs readable. Use "info" or "debug" when hunting a bug.
const VALID_LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];
const requestedLogLevel = String(process.env.LOG_LEVEL || "warn").trim().toLowerCase();
const LOG_LEVEL = VALID_LOG_LEVELS.includes(requestedLogLevel) ? requestedLogLevel : "warn";
const baileysLogger = pino({ level: LOG_LEVEL });

// The live WhatsApp connection. startBot() replaces this every time Aria reconnects,
// so /send always uses the current socket.
let activeSock = null;
let connected = false;

// Every new socket gets a new number. Events from an older socket are ignored.
let generation = 0;
let restartTimer = null;
let failStreak = 0; // failed connects in a row, used for back-off
let pairingRounds = 0; // pairing codes issued since Aria was last online

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

// Finds the real phone number of whoever sent a message.
// New WhatsApp accounts hide the phone number behind an id ending in "@lid". The real number
// comes in remoteJidAlt (private chats) or participantAlt (groups). Without this, /off and /on
// never matched, because they store phone numbers but the bot was comparing the hidden id.
async function resolveSenderNumber(sock, key, isGroupChat) {
  const primary = (isGroupChat ? key.participant : key.remoteJid) || key.remoteJid || "";
  const alt = isGroupChat ? key.participantAlt : key.remoteJidAlt;
  let jid = primary;
  if (jid.endsWith("@lid")) {
    if (alt && alt.endsWith("@s.whatsapp.net")) {
      jid = alt;
    } else {
      try {
        const pn = await sock.signalRepository?.lidMapping?.getPNForLID(jid);
        if (pn) jid = pn;
      } catch {
        // fall through
      }
      if (jid.endsWith("@lid")) {
        console.warn(`⚠️ Could not find the phone number behind ${jid}. /on and /off cannot match this sender.`);
      }
    }
  }
  return jidNumber(jid);
}

// Unwraps messages inside disappearing-message / view-once wrappers
function normalizeContent(message) {
  try {
    return (baileys.normalizeMessageContent && baileys.normalizeMessageContent(message)) || message;
  } catch {
    return message;
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
// WhatsApp login + connection handling
// ---------------------------------------------------------------------------

function nextBackoffMs() {
  failStreak += 1;
  return Math.min(5000 * 2 ** (failStreak - 1), 60000); // 5s, 10s, 20s, 40s, then 60s
}

function scheduleStart(delayMs, why) {
  clearTimeout(restartTimer);
  console.log(`⏳ Starting a new WhatsApp connection in ${Math.round(delayMs / 1000)}s (${why})`);
  restartTimer = setTimeout(() => {
    startBot().catch((err) => {
      console.error("❌ Could not start the WhatsApp connection:", err.message);
      scheduleStart(nextBackoffMs(), "start failed");
    });
  }, delayMs);
}

// Wipes the saved login and starts a clean pairing round
async function resetLoginAndRelink(why) {
  console.log(`🧹 ${why}. Clearing the saved login and starting fresh...`);
  try {
    await clearAuthStore();
  } catch (err) {
    console.error("❌ Could not clear the saved login:", err.message);
  }
  scheduleStart(RELOGIN_DELAY_MS, "fresh login");
}

// Gets the newest WhatsApp Web version number. A version WhatsApp no longer accepts is the
// most common reason for "Connection Failure" (code 405), so we never trust the built-in one alone.
async function getWaVersion() {
  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    if (Array.isArray(version)) {
      console.log(`ℹ️ WhatsApp Web version ${version.join(".")}${isLatest ? " (latest)" : " (built-in fallback)"}`);
      return version;
    }
  } catch (err) {
    console.warn("⚠️ Could not look up the latest WhatsApp version, using the built-in one:", err.message);
  }
  return undefined;
}

const CLOSE_HINTS = {
  405: "WhatsApp rejected the app version. Update Baileys (npm install @whiskeysockets/baileys@latest) and restart.",
  403: "WhatsApp refused this number for now (temporary restriction). Stop trying for a few hours.",
  428: "The connection was closed by WhatsApp. Aria will try again.",
  503: "WhatsApp is busy. Aria will try again.",
};

// Asks WhatsApp for ONE pairing code for this socket. Asking again would cancel the code
// you are typing, which is what causes "couldn't connect" on the phone.
async function requestCodeOnce(sock, myGen, pairing) {
  if (pairing.requested || myGen !== generation) return;
  pairing.requested = true;
  clearTimeout(pairing.timer);
  try {
    const code = await sock.requestPairingCode(ADMIN_NUMBER);
    if (myGen !== generation) return;
    pairingRounds += 1;
    const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
    console.log("");
    console.log(`🔗 PAIRING CODE for +${ADMIN_NUMBER}:  ${pretty}   (try ${pairingRounds}/${MAX_PAIRING_ROUNDS})`);
    console.log("   On your phone: WhatsApp > Settings > Linked Devices > Link a Device > Link with phone number instead");
    console.log("   Type this code within about 2 minutes. If it expires, Aria prints a new one by itself.");
    console.log("");
  } catch (err) {
    console.error("❌ Pairing code request failed:", err.message);
  }
}

// ---------------------------------------------------------------------------
// WhatsApp bot
// ---------------------------------------------------------------------------

async function startBot() {
  const myGen = ++generation;
  clearTimeout(restartTimer);
  connected = false;

  // Close the previous socket quietly (it is normally closed already)
  if (activeSock) {
    try {
      activeSock.end(undefined);
    } catch {
      // ignore
    }
  }

  let store;
  try {
    store = await openAuthStore();
  } catch (err) {
    console.error("❌ Could not open the saved WhatsApp login:", err.message);
    return scheduleStart(nextBackoffMs(), "login storage error");
  }
  if (myGen !== generation) return;

  // A pairing attempt that never finished leaves a half-made login behind (a phone number but
  // no account). Trying to log in with it makes WhatsApp answer 401, which used to send Aria
  // into a wipe-and-retry loop. Clear it so pairing starts clean.
  if (!store.state.creds.account && store.state.creds.me) {
    console.log("🧹 Found a half-finished login from an earlier attempt. Clearing it so pairing starts clean.");
    try {
      await clearAuthStore();
      store = await openAuthStore();
    } catch (err) {
      console.error("❌ Could not clear the half-finished login:", err.message);
      return scheduleStart(nextBackoffMs(), "login storage error");
    }
    if (myGen !== generation) return;
  }

  // No account yet = this is a fresh link that needs a pairing code
  const needsPairing = !store.state.creds.account;

  if (needsPairing) {
    if (!ADMIN_NUMBER) {
      console.error(
        "❌ ADMIN_NUMBER is not set. Add it (digits only, with country code, e.g. 2348012345678)."
      );
      return;
    }
    if (pairingRounds >= MAX_PAIRING_ROUNDS) {
      console.error(
        `❌ ${MAX_PAIRING_ROUNDS} pairing codes were issued and none was used. Stopping so WhatsApp doesn't flag the number.\n` +
          "   Check WhatsApp > Linked Devices on the phone, then restart Aria and enter the code as soon as it prints."
      );
      return;
    }
    if (ADMIN_NUMBER.startsWith("0") || ADMIN_NUMBER.length < 11) {
      console.warn(
        "⚠️ ADMIN_NUMBER looks wrong. Use the full international format with no + or leading 0, e.g. 2348012345678."
      );
    }
  }

  const version = await getWaVersion();
  if (myGen !== generation) return;

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: {
      creds: store.state.creds,
      keys: makeCacheableSignalKeyStore(store.state.keys, baileysLogger),
    },
    logger: baileysLogger,
    browser: Browsers.ubuntu("Chrome"),
    markOnlineOnConnect: false, // keeps WhatsApp notifications working on your phone
    syncFullHistory: false,
  });
  activeSock = sock;

  sock.ev.on("creds.update", () => {
    if (myGen === generation) store.saveCreds();
  });

  const pairing = { requested: false, timer: null };
  if (needsPairing) {
    console.log(`📞 Linking WhatsApp number +${ADMIN_NUMBER}. This must be the number of the phone you are linking.`);
    console.log(`💾 Login is saved in: ${describeAuthStore()}`);
    if (SHOW_QR) {
      console.log("📱 QR mode: no pairing code will be requested. Scan the QR below with WhatsApp > Linked Devices > Link a Device.");
    } else {
      // Normally the code is requested the moment WhatsApp says it is ready (the "qr" event below).
      pairing.timer = setTimeout(() => requestCodeOnce(sock, myGen, pairing), PAIRING_FALLBACK_MS);
    }
  }

  sock.ev.on("connection.update", (update) => {
    if (myGen !== generation) return;
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    if (qr) {
      if (SHOW_QR) {
        console.log("📱 Scan this QR code with WhatsApp > Linked Devices > Link a Device:");
        qrcode.generate(qr, { small: true });
      }
      if (needsPairing && !SHOW_QR) requestCodeOnce(sock, myGen, pairing);
    }

    if (isNewLogin) {
      console.log("🎉 Phone linked. WhatsApp will now restart the connection once (this is normal)...");
    }

    if (connection === "open") {
      connected = true;
      failStreak = 0;
      pairingRounds = 0;
      clearTimeout(pairing.timer);
      console.log("✅ Aria is connected and online.");
      return;
    }

    if (connection === "close") {
      connected = false;
      clearTimeout(pairing.timer);

      const err = lastDisconnect?.error;
      const statusCode = err?.output?.statusCode;
      const reasonName = DisconnectReason[statusCode] || "unknown";
      console.log(`🔌 Connection closed: ${err?.message || "no reason given"} (code ${statusCode ?? "none"}, ${reasonName})`);
      if (CLOSE_HINTS[statusCode]) console.log(`   ${CLOSE_HINTS[statusCode]}`);

      // 515: WhatsApp asks for a restart right after a successful link. Completely normal.
      if (statusCode === DisconnectReason.restartRequired) {
        failStreak = 0;
        return scheduleStart(500, "restart requested by WhatsApp");
      }

      // 440: the same login is open somewhere else (for example Render AND your PC).
      if (statusCode === DisconnectReason.connectionReplaced) {
        console.error(
          "❌ Another copy of Aria is using this same WhatsApp login (Render and your PC at the same time?).\n" +
            "   Stop the other copy. This one will not reconnect, so the two don't fight."
        );
        return;
      }

      // 401: WhatsApp says this login is no longer valid (device removed from Linked Devices)
      if (statusCode === DisconnectReason.loggedOut) {
        return resetLoginAndRelink("WhatsApp logged this device out");
      }

      // The pairing code expired or the link was never finished: start a clean round with a new code
      if (needsPairing) {
        return resetLoginAndRelink("The pairing code expired before the phone was linked");
      }

      // Anything else (network drop, timeout, WhatsApp busy): reconnect with the same login
      return scheduleStart(nextBackoffMs(), `code ${statusCode ?? "none"}`);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (myGen !== generation) return;
    const msg = messages[0];
    // One short line per incoming message, so you can see in the logs whether a message even
    // reached Aria. Turn off with DEBUG_MESSAGES=false.
    if (DEBUG_MESSAGES) {
      if (!msg) return;
      const who = String(msg.key?.remoteJid || "").split("@")[0].slice(-6);
      console.log(
        msg.message
          ? `📥 incoming (${type}) chat=...${who} fromMe=${Boolean(msg.key.fromMe)}`
          : `📥 incoming (${type}) chat=...${who} but EMPTY (WhatsApp could not decrypt it, stub ${msg.messageStubType ?? "none"})`
      );
    }
    if (!msg || !msg.message) return;

    // Status updates, broadcast lists and channels are never chats. Without this, answering
    // everyone would also reply to people's WhatsApp statuses.
    const rj = msg.key.remoteJid || "";
    if (rj === "status@broadcast" || rj.endsWith("@broadcast") || rj.endsWith("@newsletter")) return;

    const isGroupChat = isGroup(msg.key.remoteJid);
    const remoteJid = msg.key.remoteJid;

    // For groups, the actual sender is participant; for private chats it's the remoteJid
    const participant = msg.key.participant || remoteJid;
    const sender = participant; // where replies are sent
    const senderNumber = await resolveSenderNumber(sock, msg.key, isGroupChat); // real phone number
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

    // Nothing Aria can read (stickers, reactions and so on). Videos and files in a private chat
    // still get a short friendly note further down.
    const isVideoOrFile = Boolean(content.videoMessage || content.documentMessage);
    if (!text && !audio && !image && !isVideoOrFile) return;

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
      if (isBlocked(senderNumber)) {
        console.log(`🛑 Ignored +${senderNumber} (turned off with /off)`);
        return;
      }

      const allowAll = getSetting("allow_all", REPLY_TO_ALL ? "true" : "false") === "true";
      if (!allowAll && !isAllowed(senderNumber)) {
        console.log(`🔒 Ignored +${senderNumber} (not turned on with /on)`);
        return;
      }

      if (overRateLimit(sender)) {
        console.log(`⏱️ Too many replies to ${sender} in the last minute, skipping this one`);
        return;
      }

      await markRead(sock, msg);

      if (!text && !audio && !image) {
        await sleep(readPause());
        await sock.sendMessage(sender, {
          text: "Got it 😊 I can't open videos or files yet. Send me a voice note, a picture, or just type what you need.",
        });
        return;
      }

      await sleep(readPause());
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

    if (!text && !audio && !image) return;
    if (overRateLimit(remoteJid)) {
      console.log(`⏱️ Too many replies in group ${remoteJid} in the last minute, skipping this one`);
      return;
    }

    await markRead(sock, msg);
    await sleep(readPause());
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

}

// A stray error must never take the whole bot down (Render would restart it and the
// connection would drop). Log it and keep running.
process.on("unhandledRejection", (err) => {
  console.error("⚠️ Unhandled error:", err && err.message ? err.message : err);
});
process.on("uncaughtException", (err) => {
  console.error("⚠️ Uncaught error:", err && err.message ? err.message : err);
});

startHttpServer();
startBot().catch((err) => {
  console.error("❌ Failed to start Aria:", err.message);
  scheduleStart(nextBackoffMs(), "start failed");
});