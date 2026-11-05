// groupVibe.js - lets Aria "read the room" in WhatsApp groups.
//
// While Aria is turned on in a group, she quietly remembers the last few things people said
// (text, and a tag like [sticker] or [voice note] for other messages). Nothing is sent from here
// and nothing is saved to disk or a database: it only lives in memory and is gone on restart.
// When someone talks to Aria, the recent lines and a short "read of the room" (language, energy,
// message length) go to the AI so her reply fits the mood of the group, even if you are offline.
//
// Settings (optional, in .env or Render's Environment tab):
//   GROUP_VIBE_MESSAGES=20      how many recent group messages to keep per group
//   GROUP_TRIGGER_WORDS=aria    names that count as "talking to Aria" (comma separated, or none to switch off)

const { detectLanguage } = require("../ai/languageHint");

const MAX_MESSAGES = Math.max(5, Number(process.env.GROUP_VIBE_MESSAGES || 20));
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // forget anything older than 6 hours
const MAX_GROUPS = 100;
const MAX_LINE_CHARS = 240;

const rooms = new Map(); // groupJid -> [{ t, who, text }]

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TRIGGER_WORDS = String(process.env.GROUP_TRIGGER_WORDS || "aria")
  .split(",")
  .map((w) => w.trim().toLowerCase())
  .filter((w) => w && w !== "off" && w !== "none"); // GROUP_TRIGGER_WORDS=none switches name-calling off

const TRIGGER_RE = TRIGGER_WORDS.length
  ? new RegExp(`(^|[^\\p{L}\\p{N}])(${TRIGGER_WORDS.map(escapeRegex).join("|")})(?=$|[^\\p{L}\\p{N}])`, "iu")
  : null;

// True when someone calls Aria by name ("Aria, what do you think?")
function isCalledByName(text) {
  return Boolean(TRIGGER_RE && text && TRIGGER_RE.test(String(text)));
}

// Turns any WhatsApp message into one short line of text. Returns "" for things that are not
// part of the conversation (reactions, group notices and so on).
function describeForVibe(text, content = {}) {
  const t = String(text || "").trim();
  if (t) return t;
  if (content.stickerMessage) return "[sent a sticker]";
  if (content.imageMessage) {
    const c = (content.imageMessage.caption || "").trim();
    return c ? `[sent a picture] ${c}` : "[sent a picture]";
  }
  if (content.videoMessage) {
    const c = (content.videoMessage.caption || "").trim();
    return c ? `[sent a video] ${c}` : "[sent a video]";
  }
  if (content.audioMessage) return content.audioMessage.ptt ? "[sent a voice note]" : "[sent an audio]";
  if (content.documentMessage) return "[sent a file]";
  return "";
}

function rememberGroupMessage(groupJid, { who, text, content, fromMe } = {}) {
  const line = describeForVibe(text, content);
  if (!line) return;

  let room = rooms.get(groupJid);
  if (!room) {
    if (rooms.size >= MAX_GROUPS) rooms.delete(rooms.keys().next().value);
    room = [];
    rooms.set(groupJid, room);
  }

  room.push({
    t: Date.now(),
    who: fromMe ? "Admin" : who || "Someone",
    text: line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line,
  });

  const cutoff = Date.now() - MAX_AGE_MS;
  while (room.length > MAX_MESSAGES || (room.length && room[0].t < cutoff)) room.shift();
}

// A short, plain-words read of the room: language mix, energy, message length
function readTheRoom(lines) {
  const real = lines.filter((l) => !/^\[sent /.test(l.text));
  if (real.length < 2) return "";

  let pidgin = 0;
  let english = 0;
  let laughs = 0;
  let emojis = 0;
  let totalLen = 0;

  for (const l of real) {
    const { lang } = detectLanguage(l.text);
    if (lang === "pidgin" || lang === "mixed") pidgin += 1;
    else if (lang === "english") english += 1;
    if (/\b(lol|lmao|lmfao|haha+|hehe+)\b|😂|🤣|💀/iu.test(l.text)) laughs += 1;
    if (/\p{Extended_Pictographic}/u.test(l.text)) emojis += 1;
    totalLen += l.text.length;
  }

  const n = real.length;
  const language =
    pidgin / n >= 0.5 ? "mostly Nigerian Pidgin" : english / n >= 0.6 ? "mostly English" : "a mix of English and Pidgin";
  const energy =
    laughs / n >= 0.25 ? "playful, lots of laughing" : emojis / n >= 0.4 ? "lively and emoji-heavy" : totalLen / n >= 90 ? "serious, with longer messages" : "calm and casual";
  const length = totalLen / n < 35 ? "very short messages" : totalLen / n < 90 ? "short messages" : "longer messages";

  return `Quick read of the room: the group is writing ${language}; the mood is ${energy}; people write ${length}.`;
}

// The block of text given to the AI when someone talks to Aria in a group
function vibeBlock(groupJid, limit = 15) {
  const room = rooms.get(groupJid);
  if (!room || !room.length) return "";
  const cutoff = Date.now() - MAX_AGE_MS;
  const lines = room.filter((l) => l.t >= cutoff).slice(-limit);
  if (!lines.length) return "";

  const read = readTheRoom(lines);
  return (
    "GROUP CHAT CONTEXT (oldest first, newest last). This is what people have just been saying in this group:\n" +
    lines.map((l) => `${l.who}: ${l.text}`).join("\n") +
    (read ? `\n${read}` : "") +
    "\nFit into this mood when you reply. Answer the person who spoke to you, keep it short, and do not repeat this context."
  );
}

module.exports = { rememberGroupMessage, vibeBlock, isCalledByName, describeForVibe };
