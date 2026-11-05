// Makes Aria feel like a person: marks messages as read, shows "typing..." while she works,
// and waits roughly as long as a human would take to type the reply.
//
// Settings (all optional, set them in .env or in Render's Environment tab):
//   SHOW_TYPING=true          show "typing..." (default true, set false to turn off)
//   MARK_READ=true            blue ticks when Aria starts answering (default true)
//   TYPING_MS_PER_CHAR=28     typing speed: milliseconds per character
//   TYPING_MIN_MS=1200        never type for less than this
//   TYPING_MAX_MS=7000        never type for longer than this

const FALSE_WORDS = ["false", "0", "no", "off"];
const flag = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  return !FALSE_WORDS.includes(String(raw).trim().toLowerCase());
};

const SHOW_TYPING = flag("SHOW_TYPING", true);
const MARK_READ = flag("MARK_READ", true);
const MS_PER_CHAR = Number(process.env.TYPING_MS_PER_CHAR || 28);
const MIN_MS = Number(process.env.TYPING_MIN_MS || 1200);
const MAX_MS = Number(process.env.TYPING_MAX_MS || 7000);

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// "typing..." disappears by itself after a few seconds, so it is refreshed while Aria works.
const timers = new Map();

async function setTyping(sock, jid, on) {
  if (!SHOW_TYPING) return;
  try {
    if (on) {
      if (timers.has(jid)) return;
      try {
        await sock.presenceSubscribe(jid);
      } catch {
        // not critical
      }
      await sock.sendPresenceUpdate("composing", jid);
      const timer = setInterval(() => {
        sock.sendPresenceUpdate("composing", jid).catch(() => {});
      }, 6000);
      timers.set(jid, timer);
    } else {
      clearInterval(timers.get(jid));
      timers.delete(jid);
      await sock.sendPresenceUpdate("paused", jid);
    }
  } catch {
    // Typing is a nicety. It must never break a reply.
  }
}

// Blue ticks. Also never allowed to break anything.
async function markRead(sock, msg) {
  if (!MARK_READ) return;
  try {
    await sock.readMessages([msg.key]);
  } catch {
    // ignore
  }
}

// A short "reading the message" pause before the typing starts (1.0 to 2.2 seconds by default).
function readPause() {
  const base = Number(process.env.REPLY_DELAY_MS ?? 1000);
  return base > 0 ? base + Math.random() * 1200 : 0;
}

// Waits so the total time "typing" matches the length of the reply.
// startedAt = when the AI started thinking, so thinking time counts toward the typing time.
async function typingDelay(replyText, startedAt = Date.now()) {
  if (!SHOW_TYPING) return;
  const wanted = Math.min(MAX_MS, Math.max(MIN_MS, String(replyText || "").length * MS_PER_CHAR));
  const jitter = wanted * (0.9 + Math.random() * 0.3);
  await sleep(jitter - (Date.now() - startedAt));
}

module.exports = { setTyping, markRead, readPause, typingDelay, sleep };
