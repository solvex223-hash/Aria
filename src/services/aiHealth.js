// aiHealth.js - keeps YOU informed about the AI on WhatsApp, so you never have to guess.
//
//   * When a model's daily limit runs out and Aria switches to another one, you get a short message
//     in your "Message yourself" chat (at most once every few hours per problem).
//   * When Aria could not get an answer from ANY provider, you are told (at most once every 20 minutes).
//   * /ai shows which models are ready, which are resting and how much was used today.
//
// Setting (optional): AI_ALERT_HOURS=3  (how long to wait before repeating the same alert)

const llm = require("../ai/llm");
const sendMessage = require("../whatsapp/sender");

const ALERT_EVERY_MS = (Number(process.env.AI_ALERT_HOURS) > 0 ? Number(process.env.AI_ALERT_HOURS) : 3) * 3600000;
const FAILURE_EVERY_MS = 20 * 60000;
const lastAlert = new Map();

// Same "Message yourself" chat that lead alerts use
function selfChatJid(sock) {
  const raw = sock.user.lid || sock.user.id;
  const [idPart, domain] = raw.split("@");
  return `${idPart.split(":")[0]}@${domain}`;
}

async function tell(sock, key, text, everyMs) {
  const now = Date.now();
  if (now - (lastAlert.get(key) || 0) < everyMs) return;
  lastAlert.set(key, now);
  try {
    await sendMessage(sock, selfChatJid(sock), text);
  } catch (err) {
    console.warn("Could not send the AI alert to your chat:", err.message);
  }
}

function waitText(ms) {
  const mins = Math.max(1, Math.round(ms / 60000));
  return mins >= 60 ? `about ${Math.floor(mins / 60)}h ${mins % 60}m` : `about ${mins} min`;
}

// Looks at what happened inside llm.js (limits reached, keys rejected) and alerts you if it matters
async function processEvents(sock) {
  for (const ev of llm.drainEvents()) {
    const next = llm.activeLabel();
    if (ev.type === "daily-limit") {
      await tell(
        sock,
        `daily:${ev.engine}`,
        `⚠️ *Aria AI notice*\n${ev.engine} has used up its daily free limit. It comes back in ${waitText(ev.waitMs)}.` +
          (next ? `\nAria is now using ${next}, so chats keep going.` : "\nNo other model is ready, so Aria may ask people to wait.") +
          "\n\nTo stop this: add a payment method on Groq (Developer plan), or add a GEMINI_API_KEY as a backup. Send /ai to see the status.",
        ALERT_EVERY_MS
      );
    } else if (ev.type === "auth") {
      await tell(sock, `auth:${ev.engine}`, `🔑 *Aria AI notice*\n${ev.engine} rejected the API key. Check the key in Render's Environment tab.`, ALERT_EVERY_MS);
    } else if (ev.type === "billing") {
      await tell(sock, `billing:${ev.engine}`, `💳 *Aria AI notice*\n${ev.engine} reports a billing or credit problem. Check your account.`, ALERT_EVERY_MS);
    }
  }
}

// Called when nobody could answer a customer
async function reportFailure(sock, err) {
  if (!err || err.name !== "LlmError") return;
  await processEvents(sock);
  await tell(
    sock,
    "all-failed",
    `🚨 *Aria AI notice*\nAria could not get an answer from any AI provider just now, so someone was asked to try again.\nReason: ${String(err.message).slice(0, 160)}\nSend /ai to see which models are resting.`,
    FAILURE_EVERY_MS
  );
}

// Text for the /ai command
function statusText() {
  const rows = llm.status();
  if (!rows.length) return "No AI provider is set up. Add GROQ_API_KEY in Render's Environment tab.";
  const lines = rows.map((r) => {
    const state = r.ready ? "✅ ready" : `⏸️ resting ${r.resting} (${r.reason})`;
    const used = r.requestsToday ? ` - ${r.requestsToday} replies, ${r.tokensToday.toLocaleString("en-US")} tokens today` : "";
    return `${r.n}. ${r.label}: ${state}${used}`;
  });
  return [
    "🤖 *Aria AI status*",
    ...lines,
    "",
    "Aria uses the first one that is ready. Counts reset when Aria restarts.",
    "Groq free plan: about 200,000 tokens a day and 8,000 a minute for EACH model. Every reply sends Aria's full instructions and knowledge base (several thousand tokens), so the free allowance covers fewer chats than you might expect.",
    "More room: add a payment method on Groq (Developer plan), or set GEMINI_API_KEY as a free backup.",
  ].join("\n");
}

module.exports = { processEvents, reportFailure, statusText };
