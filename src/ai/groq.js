// groq.js - asks the AI for Aria's reply. (The file keeps its old name so nothing else has to change.)
//
// The talking to Groq / Gemini / backups, the switching and the waiting all happen in ./llm.js.
// This file makes sure that what comes back is ALWAYS a usable JSON reply:
//   * valid JSON with a "reply"               -> used as it is
//   * JSON that was cut off (long answer, or languages like Georgian that need many tokens)
//                                             -> the reply text is pulled out and tidied
//   * plain text instead of JSON              -> used as the reply
//   * nothing usable                          -> the next provider is tried
//
// Settings (optional): LLM_MAX_TOKENS=1500 (the longest answer for normal languages)

const llm = require("./llm");

const BLANK = {
  intent: "general",
  action: "none",
  leadScore: 0,
  needsHuman: false,
  appointmentRequested: false,
  customerName: null,
  businessName: null,
  industry: null,
  location: null,
  interestedService: null,
  budget: null,
  summary: "",
};

const asReply = (reply) => JSON.stringify({ reply, ...BLANK });

const stripFences = (t) => t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

function tryParse(t) {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function sliceBraces(t) {
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  return a >= 0 && b > a ? t.slice(a, b + 1) : "";
}

// A cut-off reply ends in the middle of a sentence: keep up to the last finished sentence
function trimToSentence(text) {
  const cut = Math.max(text.lastIndexOf(". "), text.lastIndexOf("! "), text.lastIndexOf("? "), text.lastIndexOf("\n"));
  const end = /[.!?。…]$/.test(text.trim()) ? text.length : -1;
  if (end > 0) return text.trim();
  return cut > text.length * 0.5 ? text.slice(0, cut + 1).trim() : text.trim();
}

function unescapeJsonString(s) {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

// Turns whatever the AI wrote into a JSON string with a "reply", or null when there is nothing usable
function toReplyJson(raw) {
  const text = stripFences(String(raw || "").trim());
  if (!text) return null;

  // 1) proper JSON
  const parsed = tryParse(text) || tryParse(sliceBraces(text));
  if (parsed && typeof parsed.reply === "string" && parsed.reply.trim()) return JSON.stringify(parsed);

  // 2) JSON that is broken or cut off: pull the reply text out of it
  const m = text.match(/"reply"\s*:\s*"((?:[^"\\]|\\[\s\S])*)("|$)/);
  if (m && m[1].trim()) {
    let reply = unescapeJsonString(m[1]);
    if (!m[2]) reply = trimToSentence(reply); // it was cut off
    if (reply.trim().length >= 2) return asReply(reply.trim());
  }

  // 3) plain text answer (not JSON at all)
  if (!/^[\[{]/.test(text)) return asReply(text);

  return null;
}

async function askGroq(systemPrompt, messages = [], options = {}) {
  const strong = Boolean(options.strong);
  const normalMax = Number(process.env.LLM_MAX_TOKENS) > 0 ? Number(process.env.LLM_MAX_TOKENS) : 1500;
  // Languages written in other alphabets (Georgian, Arabic, Thai...) need several times more tokens
  const baseTokens = options.maxTokens || (strong ? 2800 : normalMax);

  const tried = [];
  let lastErr = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await llm.chat({
      system: systemPrompt,
      messages,
      maxTokens: attempt === 0 ? baseTokens : Math.min(baseTokens * 2, 3500),
      strong,
      exclude: tried,
    });

    const json = toReplyJson(res.content);
    if (json) {
      if (res.finishReason === "length") console.warn(`⚠️ ${res.engine.label}: the reply was long and got cut at the token limit. It was tidied and used.`);
      if (typeof options.onInfo === "function") options.onInfo({ engine: res.engine.label, finishReason: res.finishReason });
      return json;
    }

    // This provider gave an unusable answer: try the next one
    tried.push(res.engine.id);
    lastErr = new llm.LlmError(`${res.engine.label} gave an answer that could not be used (${res.finishReason || "empty"})`, { kind: "unusable" });
    console.warn(`⚠️ ${lastErr.message}. Trying another provider...`);
  }
  throw lastErr;
}

module.exports = askGroq;
module.exports.toReplyJson = toReplyJson;
