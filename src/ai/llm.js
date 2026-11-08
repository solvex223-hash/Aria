// llm.js - talks to the AI providers for Aria and keeps chats going when one of them runs out.
//
// Why this exists: on Groq's free plan EACH model has its own limit (for example 200,000 tokens per day
// and 8,000 tokens per minute). When a model hits its limit, Groq answers "429" and before this file
// every customer got "something went wrong". Now:
//   * a short limit (per minute) -> Aria switches to the next model, or waits a few seconds
//   * a daily limit              -> that model rests until its limit resets, Aria uses the next one
//   * a backup provider (Gemini, or any OpenAI-compatible service) can be added with just an API key
//   * you are told on WhatsApp when this happens, and /ai shows the status
//
// The order Aria tries (only the ones that are set up are used):
//   1. GROQ_TEXT_MODEL                       (default openai/gpt-oss-20b)
//   2. GROQ_FALLBACK_MODELS                  (default openai/gpt-oss-120b,qwen/qwen3.6-27b)
//   3. Gemini  if GEMINI_API_KEY is set      (model GEMINI_MODEL, default gemini-3.5-flash-lite)
//   4. Any other OpenAI-compatible service   if LLM_EXTRA_BASE_URL, LLM_EXTRA_API_KEY, LLM_EXTRA_MODEL are set
// For hard languages (Georgian, Arabic, Spanish...) the Gemini backup is tried first when it is set up.
//
// Pictures, stickers and video frames use their own list of models that can SEE images (a model that only
// reads text cannot be used for them):
//   1. GROQ_VISION_MODELS                    (default qwen/qwen3.8-27b)
//   2. GROQ_VISION_FALLBACK_MODELS           (default qwen/qwen3.6-27b)
//   3. Gemini  if GEMINI_API_KEY is set
// Each picture costs about 2,000 tokens on Groq, so pictures use up the free limit quickly.
//
// Optional settings: LLM_TIMEOUT_MS=30000, LLM_MAX_WAIT_MS=15000 (longest Aria will wait for a limit to clear)

try {
  require("dotenv").config();
} catch {
  // dotenv is optional here (index.js already loads it)
}

const ENV = process.env;
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TIMEOUT_MS = num(ENV.LLM_TIMEOUT_MS, 30000);
const MAX_WAIT_MS = num(ENV.LLM_MAX_WAIT_MS, 15000);

class LlmError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = "LlmError";
    Object.assign(this, info); // status, kind, retryAfterMs
  }
}

// ---------------------------------------------------------------------------
// Which providers and models are set up
// ---------------------------------------------------------------------------

const clean = (s) => String(s || "").trim();
const csv = (s) => String(s || "").split(",").map(clean).filter(Boolean);

// One shared object per provider+model, so a limit hit by a text chat also protects pictures (and the
// other way round): both lists point at the same objects and the same "resting" state.
const registry = new Map();
function shared(def) {
  if (!registry.has(def.id)) registry.set(def.id, def);
  return registry.get(def.id);
}

function groqDef(model) {
  return shared({
    id: `groq:${model}`,
    label: `Groq ${model}`,
    kind: "groq",
    model,
    baseUrl: clean(ENV.GROQ_BASE_URL).replace(/\/+$/, "") || "https://api.groq.com/openai/v1",
    key: clean(ENV.GROQ_API_KEY),
    json: true,
    singleSystem: false,
    strongLanguage: false,
  });
}

function geminiDef() {
  const model = clean(ENV.GEMINI_MODEL) || "gemini-3.5-flash-lite";
  return shared({
    id: "gemini",
    label: `Gemini ${model}`,
    kind: "gemini",
    model,
    baseUrl: clean(ENV.GEMINI_BASE_URL).replace(/\/+$/, "") || "https://generativelanguage.googleapis.com/v1beta/openai",
    key: clean(ENV.GEMINI_API_KEY),
    json: true,
    singleSystem: true,
    strongLanguage: true,
  });
}

// Models that can SEE pictures (stickers, photos, video frames)
function buildVisionEngines() {
  const engines = [];
  if (clean(ENV.GROQ_API_KEY)) {
    const primary = csv(ENV.GROQ_VISION_MODELS).length ? csv(ENV.GROQ_VISION_MODELS) : ["qwen/qwen3.8-27b"];
    const fallbackRaw = ENV.GROQ_VISION_FALLBACK_MODELS === undefined ? "qwen/qwen3.6-27b" : ENV.GROQ_VISION_FALLBACK_MODELS;
    for (const model of [...new Set([...primary, ...csv(fallbackRaw)])]) engines.push(groqDef(model));
  }
  if (clean(ENV.GEMINI_API_KEY)) engines.push(geminiDef());
  return engines;
}

function buildEngines() {
  const engines = [];
  const trimSlash = (u) => clean(u).replace(/\/+$/, "");

  if (clean(ENV.GROQ_API_KEY)) {
    const primary = clean(ENV.GROQ_TEXT_MODEL) || "openai/gpt-oss-20b";
    const fallbackRaw = ENV.GROQ_FALLBACK_MODELS === undefined ? "openai/gpt-oss-120b,qwen/qwen3.6-27b" : ENV.GROQ_FALLBACK_MODELS;
    const models = [primary, ...csv(fallbackRaw)];
    for (const model of [...new Set(models)]) engines.push(groqDef(model));
  }

  if (clean(ENV.GEMINI_API_KEY)) {
    engines.push(geminiDef());
  }

  if (clean(ENV.LLM_EXTRA_BASE_URL) && clean(ENV.LLM_EXTRA_API_KEY) && clean(ENV.LLM_EXTRA_MODEL)) {
    engines.push({
      id: "extra",
      label: `Backup ${clean(ENV.LLM_EXTRA_MODEL)}`,
      kind: "extra",
      model: clean(ENV.LLM_EXTRA_MODEL),
      baseUrl: trimSlash(ENV.LLM_EXTRA_BASE_URL),
      key: clean(ENV.LLM_EXTRA_API_KEY),
      json: false,
      singleSystem: true,
      strongLanguage: false,
    });
  }
  return engines;
}

const ENGINES = buildEngines();
const VISION_ENGINES = buildVisionEngines();

// What each provider is doing right now (kept in memory, resets when Aria restarts)
const state = new Map();
function st(e) {
  const day = new Date().toISOString().slice(0, 10);
  let s = state.get(e.id);
  if (!s) {
    s = { cooldownUntil: 0, reason: "", fails: 0, tokensToday: 0, requestsToday: 0, day, lastError: "", noJson: false };
    state.set(e.id, s);
  }
  if (s.day !== day) {
    s.day = day;
    s.tokensToday = 0;
    s.requestsToday = 0;
  }
  return s;
}

const events = [];
function emit(ev) {
  events.push({ at: Date.now(), ...ev });
  if (events.length > 50) events.shift();
}
// Things that happened since the last call (limits reached, keys rejected...). Used for WhatsApp alerts.
function drainEvents() {
  return events.splice(0, events.length);
}

const cooling = (e) => st(e).cooldownUntil > Date.now();
function cool(e, ms, reason) {
  const s = st(e);
  s.cooldownUntil = Date.now() + ms;
  s.reason = reason;
}

// ---------------------------------------------------------------------------
// Understanding the error a provider sends back
// ---------------------------------------------------------------------------

// "Please try again in 6m12.5s" / "1h2m3s" / "850ms" -> milliseconds
function parseDurationMs(text) {
  let total = 0;
  let found = false;
  for (const m of String(text || "").matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)(?![a-z])/g)) {
    found = true;
    const n = Number(m[1]);
    total += m[2] === "ms" ? n : m[2] === "s" ? n * 1000 : m[2] === "m" ? n * 60000 : n * 3600000;
  }
  return found ? Math.ceil(total) : 0;
}

function retryAfterMs(headers, message) {
  const h = headers && (headers.get ? headers.get("retry-after") : headers["retry-after"]);
  if (h && Number.isFinite(Number(h))) return Math.ceil(Number(h) * 1000);
  const fromMessage = parseDurationMs((String(message || "").match(/try again in ([^.]*(?:\.\d+)?[a-z]*)/i) || [])[1] || "");
  return fromMessage;
}

function isDailyLimit(message) {
  return /per day|\bTPD\b|\bRPD\b|daily/i.test(String(message || ""));
}

// ---------------------------------------------------------------------------
// One call to one provider
// ---------------------------------------------------------------------------

function reasoningOptions(e) {
  if (e.kind !== "groq") return {};
  if (e.model.startsWith("openai/gpt-oss")) return { reasoning_effort: "low", include_reasoning: false };
  if (e.model.startsWith("qwen/")) return { reasoning_effort: "none", reasoning_format: "hidden" };
  return {};
}

// Gemini and other services want ONE system message at the start and alternating user/assistant
// messages. Aria adds short instructions after the chat history, so for these providers they are
// folded into the system message and consecutive messages from the same side are joined.
function prepareMessages(e, system, messages) {
  if (!e.singleSystem) return system ? [{ role: "system", content: system }, ...messages] : messages;
  const later = messages.filter((m) => m.role === "system").map((m) => m.content);
  const rest = messages.filter((m) => m.role !== "system");
  const merged = [];
  for (const m of rest) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role && typeof last.content === "string" && typeof m.content === "string") last.content += `\n${m.content}`;
    else merged.push({ role: m.role, content: m.content });
  }
  while (merged.length && merged[0].role !== "user") merged.shift();
  const sys = later.length ? `${system}\n\n=== FOR THIS REPLY ONLY ===\n${later.join("\n\n")}` : system;
  return sys ? [{ role: "system", content: sys }, ...merged] : merged;
}

async function callEngine(e, { system, messages, maxTokens, temperature, json = true }) {
  const s = st(e);
  const body = {
    model: e.model,
    messages: prepareMessages(e, system, messages),
    temperature,
    ...(e.kind === "groq" ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    ...reasoningOptions(e),
  };
  if (json && e.json && !s.noJson) body.response_format = { type: "json_object" };

  let res;
  try {
    res = await fetch(`${e.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${e.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new LlmError(`${e.label} did not answer (${err.name === "TimeoutError" ? "timed out" : err.message})`, { kind: "network" });
  }

  const raw = await res.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // not JSON
  }

  if (!res.ok) {
    const message = data?.error?.message || data?.[0]?.error?.message || raw.slice(0, 300);

    // Groq refuses an answer that is not valid JSON but still includes what the model wrote.
    // Use that text instead of failing.
    const failed = data?.error?.failed_generation;
    if (res.status === 400 && typeof failed === "string" && failed.trim()) {
      return { content: failed, finishReason: "failed_generation", usage: null };
    }

    // A model that does not support JSON mode: try again without it
    if (res.status === 400 && body.response_format && /response_format|json_object|json mode/i.test(message)) {
      s.noJson = true;
      return callEngine(e, { system, messages, maxTokens, temperature, json });
    }

    throw new LlmError(`${e.label}: ${res.status} ${String(message).slice(0, 200)}`, {
      status: res.status,
      kind: res.status === 429 ? "rate" : res.status === 401 || res.status === 403 ? "auth" : res.status === 402 ? "billing" : res.status >= 500 ? "server" : "request",
      retryAfterMs: res.status === 429 ? retryAfterMs(res.headers, message) : 0,
      daily: res.status === 429 && isDailyLimit(message),
    });
  }

  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  return { content: typeof content === "string" ? content : "", finishReason: choice?.finish_reason || "", usage: data?.usage || null };
}

// What to do after a provider fails
function noteFailure(e, err) {
  const s = st(e);
  s.lastError = err.message;
  s.fails += 1;
  const label = e.label;

  if (err.kind === "rate") {
    const wait = err.retryAfterMs > 0 ? err.retryAfterMs : err.daily ? 3600000 : 60000;
    cool(e, wait, err.daily ? "daily limit" : "per-minute limit");
    if (wait > MAX_WAIT_MS || err.daily) emit({ type: err.daily ? "daily-limit" : "limit", engine: label, waitMs: wait });
    console.warn(`⏸️ ${label} is at its ${err.daily ? "DAILY" : "per-minute"} limit. Resting ${Math.round(wait / 1000)}s.`);
  } else if (err.kind === "auth") {
    cool(e, 30 * 60000, "key rejected");
    emit({ type: "auth", engine: label });
    console.error(`🔑 ${label} rejected the API key. Check it in Render's Environment tab.`);
  } else if (err.kind === "billing") {
    cool(e, 30 * 60000, "billing problem");
    emit({ type: "billing", engine: label });
    console.error(`💳 ${label} reports a billing or credit problem.`);
  } else if (err.kind === "server" || err.kind === "network") {
    cool(e, s.fails >= 3 ? 60000 : 15000, "not answering");
    console.warn(`⚠️ ${label} is not answering well: ${err.message}`);
  } else {
    cool(e, 5000, "request refused");
    console.warn(`⚠️ ${label} refused the request: ${err.message}`);
  }
}

function markOk(e, usage) {
  const s = st(e);
  s.fails = 0;
  s.lastError = "";
  s.requestsToday += 1;
  s.tokensToday += Number(usage?.total_tokens || 0);
}

// ---------------------------------------------------------------------------
// The main call
// ---------------------------------------------------------------------------

function ordered(strong, pool = "text") {
  if (pool === "vision") return VISION_ENGINES.slice();
  if (!strong) return ENGINES.slice();
  return [...ENGINES.filter((e) => e.strongLanguage), ...ENGINES.filter((e) => !e.strongLanguage)];
}

// Returns { content, finishReason, usage, engine } or throws an LlmError.
//   strong:  the language is hard, so try the strongest backup model first
//   exclude: provider ids not to use (for example one that already gave an unusable answer)
async function chat({ system, messages, maxTokens = 1000, temperature = 0.7, strong = false, exclude = [], pool: poolName = "text", json = true }) {
  const all = poolName === "vision" ? VISION_ENGINES : ENGINES;
  const pool = ordered(strong, poolName).filter((e) => !exclude.includes(e.id));
  if (!pool.length) {
    throw new LlmError(all.length ? "No other AI provider is available to try." : poolName === "vision" ? "No picture-reading model is set up. Add GROQ_API_KEY." : "No AI provider is set up. Add GROQ_API_KEY.", { kind: "config" });
  }

  let lastErr = null;
  for (let round = 0; round < 3; round++) {
    const ready = pool.filter((e) => !cooling(e));

    if (!ready.length) {
      const soonest = Math.min(...pool.map((e) => st(e).cooldownUntil)) - Date.now();
      if (soonest <= MAX_WAIT_MS && round < 2) {
        await sleep(Math.max(soonest, 0) + 250); // a short limit: wait a moment and try again
        continue;
      }
      throw new LlmError("All AI providers are at their limit for now.", {
        kind: "busy",
        retryAfterMs: Math.max(soonest, 0),
        cause: lastErr,
      });
    }

    for (const e of ready) {
      try {
        const out = await callEngine(e, { system, messages, maxTokens, temperature, json });
        markOk(e, out.usage);
        return { ...out, engine: e };
      } catch (err) {
        lastErr = err;
        noteFailure(e, err);
      }
    }
  }
  throw lastErr || new LlmError("The AI did not answer.", { kind: "network" });
}

// ---------------------------------------------------------------------------
// Status for the /ai command
// ---------------------------------------------------------------------------

function fmtWait(ms) {
  const m = Math.ceil(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m > 1 ? `${m} min` : `${Math.max(1, Math.ceil(ms / 1000))}s`;
}

function status(poolName = "text") {
  return (poolName === "vision" ? VISION_ENGINES : ENGINES).map((e, i) => {
    const s = st(e);
    const rest = s.cooldownUntil - Date.now();
    return {
      n: i + 1,
      label: e.label,
      ready: rest <= 0,
      resting: rest > 0 ? fmtWait(rest) : "",
      reason: rest > 0 ? s.reason : "",
      tokensToday: s.tokensToday,
      requestsToday: s.requestsToday,
      lastError: s.lastError,
    };
  });
}

// The provider Aria would use for the next normal message
function activeLabel() {
  const e = ENGINES.find((x) => !cooling(x));
  return e ? e.label : "";
}

module.exports = { chat, status, activeLabel, drainEvents, LlmError, parseDurationMs, ENGINES };
