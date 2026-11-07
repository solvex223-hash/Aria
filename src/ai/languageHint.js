// languageHint.js - decides which language Aria must reply in, and gives the AI one clear instruction.
//
// It handles four situations:
//  1. The customer writes in English, Pidgin or a mix: Aria switches when they switch.
//  2. The customer writes in another language (Yoruba, Igbo, Hausa, French, Georgian, Arabic, Russian,
//     Chinese, Spanish...): Aria answers in that language. Non-Latin scripts are recognised from the letters.
//  3. The customer ASKS for a language ("speak Georgian", "reply in French"): Aria keeps using it,
//     even when their next messages are in English, until they ask for another language ("English please").
//  4. Languages that need a stronger AI model are flagged (strong = true), so the app can use the best
//     backup model for them.

// ---------------------------------------------------------------------------
// Pidgin and English
// ---------------------------------------------------------------------------

const PIDGIN_WORDS = {
  wetin: 2, abeg: 2, wahala: 2, sabi: 2, dey: 2, wey: 2, una: 2, pikin: 2, comot: 2,
  na: 1, wan: 1, dem: 1, oga: 1, naija: 1, sha: 1, abi: 1, chop: 1, kain: 1, gist: 1,
  japa: 1, nau: 1, omo: 1, shebi: 1, shey: 1, sef: 1, jare: 1, nawa: 1, gbam: 1, kpele: 1,
  oya: 1, biko: 1, werey: 1,
};

const PIDGIN_PHRASES = [
  /\bhow far\b(?! (is|are|do|does|did|from|can|will|would|should|to|away|it))/, /\bno be\b/, /\be don\b/, /\be dey\b/, /\be go\b/, /\bmake we\b/, /\bmake i\b/,
  /\bmake e\b/, /\bna so\b/, /\bno wahala\b/, /\bi wan\b/, /\bwan make\b/, /\bdem don\b/,
  /\bhow much be\b/, /\bna wa\b/, /\bdon (tire|go|come|finish|reach|start|do)\b/, /\bwetin (be|dey|you|i|we)\b/,
];

const ENGLISH_WORDS = new Set([
  "the", "is", "are", "you", "your", "and", "to", "of", "what", "how", "can", "please", "hello",
  "hi", "hey", "thanks", "thank", "need", "want", "my", "i", "for", "with", "this", "that", "do", "does",
  "have", "would", "could", "much", "price", "website", "me", "we", "it", "in", "on", "at", "a",
  "an", "be", "will", "about", "if", "or", "not", "just", "like", "good", "when", "who", "where",
  "which", "from", "they", "he", "she", "them", "was", "were", "been", "get", "make", "send",
  "tell", "know", "think", "many", "any", "some", "too", "very", "really", "okay", "yes", "no",
  "so", "but", "all", "there", "their", "these", "those", "its", "im", "dont", "cant", "hope",
  "help", "service", "services", "business", "time", "day", "today", "tomorrow", "work", "online",
  "company", "name", "number", "call", "email", "pay", "money", "morning", "afternoon", "evening",
  "night", "now", "here", "also", "more", "than", "then", "out", "up", "one", "new", "only", "see",
]);

// Other Nigerian languages and French written in Latin letters: a few clear signs each
const OTHER_LANGUAGES = [
  { name: "Yoruba", chars: /[ẹọṣ]/, words: ["bawo", "jowo", "kaaro", "kaasan", "kaale", "pele", "dupe", "nko", "ṣe"], phrases: [/\bmo fe\b/, /\bse daadaa\b/, /\be kaaro\b/, /\be kaasan\b/, /\be kaale\b/] },
  { name: "Igbo", chars: /[ịụ]/, words: ["kedu", "ndewo", "daalu", "imela", "gwam", "nne"], phrases: [/\bnna m\b/] },
  { name: "Hausa", chars: null, words: ["sannu", "nagode", "barka", "lafiya", "yaya"], phrases: [/\bina kwana\b/, /\bdan allah\b/] },
  { name: "French", chars: null, words: ["bonjour", "bonsoir", "merci", "salut", "voudrais", "monsieur", "madame", "comment"], phrases: [/\bje suis\b/, /\bje veux\b/, /\bs'il (vous|te) pla[iî]t\b/, /\bc'est\b/] },
];

// ---------------------------------------------------------------------------
// Writing systems: the letters tell us the language family even when we know no words
// ---------------------------------------------------------------------------

const SCRIPTS = [
  { name: "Georgian", re: /[\u10A0-\u10FF\u1C90-\u1CBF\u2D00-\u2D2F]/gu },
  { name: "Armenian", re: /[\u0530-\u058F]/gu },
  { name: "Greek", re: /[\u0370-\u03FF\u1F00-\u1FFF]/gu },
  { name: "Hebrew", re: /[\u0590-\u05FF]/gu },
  { name: "Arabic (or Persian or Urdu, whichever the person used)", re: /[\u0600-\u06FF\u0750-\u077F]/gu },
  { name: "the same language the person used (written in Cyrillic letters, for example Russian or Ukrainian)", re: /[\u0400-\u04FF]/gu },
  { name: "Hindi (or the same Devanagari-script language the person used)", re: /[\u0900-\u097F]/gu },
  { name: "Bengali", re: /[\u0980-\u09FF]/gu },
  { name: "Punjabi", re: /[\u0A00-\u0A7F]/gu },
  { name: "Gujarati", re: /[\u0A80-\u0AFF]/gu },
  { name: "Tamil", re: /[\u0B80-\u0BFF]/gu },
  { name: "Telugu", re: /[\u0C00-\u0C7F]/gu },
  { name: "Kannada", re: /[\u0C80-\u0CFF]/gu },
  { name: "Malayalam", re: /[\u0D00-\u0D7F]/gu },
  { name: "Sinhala", re: /[\u0D80-\u0DFF]/gu },
  { name: "Thai", re: /[\u0E00-\u0E7F]/gu },
  { name: "Amharic", re: /[\u1200-\u137F]/gu },
  { name: "Korean", re: /[\uAC00-\uD7AF\u1100-\u11FF]/gu },
  { name: "Japanese", re: /[\u3040-\u30FF]/gu },
  { name: "Chinese (or Japanese, whichever the person used)", re: /[\u4E00-\u9FFF]/gu },
];

function detectScript(text) {
  const letters = (String(text).match(/\p{L}/gu) || []).length;
  if (!letters) return null;
  let best = null;
  for (const s of SCRIPTS) {
    const count = (String(text).match(s.re) || []).length;
    if (count && (!best || count > best.count)) best = { name: s.name, count };
  }
  if (!best) return null;
  // Japanese writing mixes kana with Chinese characters: kana decides
  const kana = (String(text).match(/[\u3040-\u30FF]/gu) || []).length;
  if (kana >= 2) best = { name: "Japanese", count: kana };
  return best.count / letters >= 0.4 || (best.count >= 2 && letters <= 6) ? best : null;
}

// ---------------------------------------------------------------------------
// "Please speak Georgian": the customer asks for a language
// ---------------------------------------------------------------------------

const REQUESTABLE = {
  english: "English", "nigerian pidgin": "Nigerian Pidgin", "pidgin english": "Nigerian Pidgin", pidgin: "Nigerian Pidgin", "broken english": "Nigerian Pidgin",
  georgian: "Georgian", armenian: "Armenian", azerbaijani: "Azerbaijani", russian: "Russian", ukrainian: "Ukrainian",
  polish: "Polish", czech: "Czech", slovak: "Slovak", hungarian: "Hungarian", romanian: "Romanian", bulgarian: "Bulgarian",
  serbian: "Serbian", croatian: "Croatian", bosnian: "Bosnian", slovenian: "Slovenian", albanian: "Albanian", greek: "Greek",
  turkish: "Turkish", arabic: "Arabic", hebrew: "Hebrew", persian: "Persian", farsi: "Persian", urdu: "Urdu", hindi: "Hindi",
  bengali: "Bengali", punjabi: "Punjabi", tamil: "Tamil", telugu: "Telugu", kannada: "Kannada", malayalam: "Malayalam",
  marathi: "Marathi", gujarati: "Gujarati", nepali: "Nepali", sinhala: "Sinhala", thai: "Thai", vietnamese: "Vietnamese",
  indonesian: "Indonesian", malay: "Malay", filipino: "Filipino", tagalog: "Filipino (Tagalog)", chinese: "Chinese",
  mandarin: "Mandarin Chinese", cantonese: "Cantonese", japanese: "Japanese", korean: "Korean", swahili: "Swahili",
  amharic: "Amharic", somali: "Somali", zulu: "Zulu", xhosa: "Xhosa", afrikaans: "Afrikaans", yoruba: "Yoruba", igbo: "Igbo",
  hausa: "Hausa", twi: "Twi", akan: "Akan", efik: "Efik", ijaw: "Ijaw", french: "French", spanish: "Spanish",
  portuguese: "Portuguese", italian: "Italian", german: "German", dutch: "Dutch", swedish: "Swedish", norwegian: "Norwegian",
  danish: "Danish", finnish: "Finnish", icelandic: "Icelandic", irish: "Irish", welsh: "Welsh", latin: "Latin", esperanto: "Esperanto",
};

const NAME_KEYS = Object.keys(REQUESTABLE).sort((a, b) => b.length - a.length);
const NAMES_RE = `(${NAME_KEYS.map((k) => k.replace(/ /g, "\\s+")).join("|")})`;
const ASK_VERBS = "(?:speak|talk|reply|respond|answer|chat|converse|communicate|continue|switch|change|go)";

const REQUEST_PATTERNS = [
  new RegExp(`\\b${ASK_VERBS}\\b(?:\\s+\\w+){0,4}?\\s+(?:in|to|into|using)\\s+${NAMES_RE}\\b`),
  new RegExp(`\\b(?:speak|talk|understand|know)\\s+${NAMES_RE}\\b`),
  new RegExp(`\\bin\\s+${NAMES_RE}\\s+(?:please|pls|now|only|from now)\\b`),
  new RegExp(`\\b${NAMES_RE}\\s+(?:please|pls|only|language)\\b`),
  new RegExp(`^(?:in\\s+)?${NAMES_RE}$`),
];

// "I speak Yoruba" is the customer talking about themselves, not a request
const ABOUT_THEMSELVES = /\bi (?:can |also |only |do |just )?(?:speak|talk|understand|know)\b/;

// Returns the language name the person asked for ("Georgian", "English"...) or null
function requestedLanguage(text) {
  const clean = String(text || "")
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || clean.split(" ").length > 30) return null;
  const aboutSelf = ABOUT_THEMSELVES.test(clean);
  for (let i = 0; i < REQUEST_PATTERNS.length; i++) {
    if (aboutSelf && i === 1) continue;
    const m = clean.match(REQUEST_PATTERNS[i]);
    if (m) return REQUESTABLE[m[1].replace(/\s+/g, " ")] || null;
  }
  return null;
}

// Remembers each chat's requested language (in memory) so it survives long conversations
const requestedByChat = new Map();
const REQUEST_MEMORY_MS = 12 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Detecting the language of one message
// ---------------------------------------------------------------------------

// Takes out things that say nothing about language: [media descriptions], links, emojis, symbols
function cleanForLanguage(text) {
  return String(text || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/@\d+/g, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns { lang, score, name? }. lang is one of: "pidgin", "mixed", "english", "yoruba", "igbo",
// "hausa", "french", "script" (a non-Latin writing system, name = the language), "other" (some other
// language written in Latin letters) or "neutral" (too short or unclear, like "ok" or "👍").
function detectLanguage(text) {
  const clean = cleanForLanguage(text);
  if (!clean) return { lang: "neutral", score: 0 };

  const script = detectScript(clean);
  if (script) return { lang: "script", score: script.count, name: script.name };

  const tokens = clean.split(" ");

  for (const l of OTHER_LANGUAGES) {
    let hits = 0;
    if (l.chars && l.chars.test(clean)) hits += 2;
    for (const t of tokens) if (l.words.includes(t)) hits += 1;
    for (const p of l.phrases) if (p.test(clean)) hits += 2;
    if (hits >= 2 || (hits >= 1 && tokens.length <= 3)) {
      return { lang: l.name.toLowerCase(), score: hits };
    }
  }

  let pidgin = 0;
  for (const t of tokens) pidgin += PIDGIN_WORDS[t] || 0;
  for (const p of PIDGIN_PHRASES) if (p.test(clean)) pidgin += 2;

  const englishHits = new Set(tokens.filter((t) => ENGLISH_WORDS.has(t))).size;

  if (pidgin >= 3) return { lang: "pidgin", score: pidgin };
  if (pidgin >= 1 && englishHits >= 2) return { lang: "mixed", score: pidgin };
  if (pidgin >= 1) return { lang: tokens.length <= 3 ? "pidgin" : "mixed", score: pidgin };
  if (englishHits >= 2 || (englishHits >= 1 && tokens.length >= 4)) return { lang: "english", score: englishHits };
  // Four or more words and not one common English word: most likely another language (Spanish, German, Turkish...)
  if (tokens.length >= 4) return { lang: "other", score: 0 };
  return { lang: "neutral", score: 0 };
}

// ---------------------------------------------------------------------------
// The instruction for the AI
// ---------------------------------------------------------------------------

const NEUTRAL_LINE =
  "Reply in the same language and style as the person's recent messages (English, Pidgin or another " +
  "language). If you cannot tell, use simple, friendly English.";

const CANNOT_LINE = "If you truly cannot write it, say so in one short sentence and offer English or Pidgin instead.";

const INSTRUCTIONS = {
  pidgin:
    "The person's latest message is in Nigerian Pidgin. Reply in natural Nigerian Pidgin, the way a " +
    "real Nigerian would. Keep it light and do not overdo it.",
  mixed:
    "The person's latest message is mostly English with a little Pidgin. Reply in relaxed, simple " +
    "English with only a light touch of Pidgin, mirroring how they write.",
  english:
    "The person's latest message is in plain English. Reply in clear, natural English. Do NOT use " +
    "Pidgin. Your earlier replies in this chat may have been in Pidgin, but ignore their language: the " +
    "person has switched, so you switch too. If they go back to Pidgin later, go back with them.",
  yoruba: `The person's latest message is in Yoruba. Reply in Yoruba, naturally and correctly. ${CANNOT_LINE}`,
  igbo: `The person's latest message is in Igbo. Reply in Igbo, naturally and correctly. ${CANNOT_LINE}`,
  hausa: `The person's latest message is in Hausa. Reply in Hausa, naturally and correctly. ${CANNOT_LINE}`,
  french: "The person's latest message is in French. Reply in French, naturally and correctly.",
  other:
    "The person's latest message is not in English or Pidgin. Reply in the same language the person wrote in, " +
    `naturally and correctly, with simple sentences. ${CANNOT_LINE}`,
};

function instructionFor(detected) {
  if (detected.lang === "script") {
    return (
      `The person's latest message is written in ${detected.name}. Reply in the same language, naturally and ` +
      `correctly, with simple sentences. ${CANNOT_LINE}`
    );
  }
  return INSTRUCTIONS[detected.lang] || NEUTRAL_LINE;
}

const ENGLISH_ASKED =
  "The person asked for English. Reply in clear, natural English (not Pidgin and not another language) " +
  "unless they ask for something else.";

function requestedInstruction(name) {
  return (
    `The person asked you to speak ${name}. Reply in ${name} (natural, correct, simple sentences) and keep using ` +
    `${name} until they ask for another language, even if their messages are in English. Do your best and do ` +
    "not refuse. If you are unsure about a word, use a simpler one."
  );
}

// customerTexts: the person's messages, oldest first. chatKey (optional): lets the app remember a
// requested language for the whole chat. Returns { instruction, lang, requested, strong }.
//   strong = true when the language is hard (not English or Pidgin), so the app can pick the best model.
function languageProfile(customerTexts = [], chatKey = null) {
  const texts = customerTexts.slice(-30);

  // 1) Did the person ask for a language? The newest request wins.
  let asked = null;
  let askedIdx = -1;
  for (let i = texts.length - 1; i >= 0; i--) {
    const r = requestedLanguage(texts[i]);
    if (r) {
      asked = r;
      askedIdx = i;
      break;
    }
  }
  let requested = null; // a language other than English that the person asked for
  let englishAsked = false;
  if (asked === "English") {
    englishAsked = true;
    if (chatKey) requestedByChat.delete(chatKey);
  } else if (asked) {
    requested = asked;
    if (chatKey) {
      if (requestedByChat.size > 500) requestedByChat.delete(requestedByChat.keys().next().value);
      requestedByChat.set(chatKey, { name: asked, at: Date.now() });
    }
  } else if (chatKey) {
    const saved = requestedByChat.get(chatKey);
    if (saved && Date.now() - saved.at < REQUEST_MEMORY_MS) requested = saved.name;
  }

  // 2) What is the newest message actually written in? (an unclear "ok" looks at the one before it)
  let latest = { lang: "neutral", score: 0 };
  let latestIdx = -1;
  for (let i = texts.length - 1; i >= Math.max(0, texts.length - 4); i--) {
    const d = detectLanguage(texts[i]);
    if (d.lang !== "neutral") {
      latest = d;
      latestIdx = i;
      break;
    }
  }
  const foreign = ["script", "other", "yoruba", "igbo", "hausa", "french"].includes(latest.lang);

  // The newest signal wins: if the person wrote in another language AFTER asking for a language,
  // they have moved on, so follow what they write now. English or Pidgin messages never cancel a request.
  const sameAsRequested = (name) => {
    const hay = (latest.name || latest.lang || "").toLowerCase();
    return String(name || "").toLowerCase().split(/[\s()]+/).some((w) => w.length > 3 && hay.includes(w));
  };
  if (foreign && latestIdx > askedIdx && !(requested && sameAsRequested(requested))) {
    requested = null;
    englishAsked = false;
    if (chatKey) requestedByChat.delete(chatKey);
  }

  // 3) A request for another language stays until the person asks for something else
  if (requested) {
    return {
      instruction: requestedInstruction(requested),
      lang: requested.toLowerCase(),
      requested,
      strong: requested !== "Nigerian Pidgin",
    };
  }

  // "English please" wins over an older foreign-language message, but a person who then writes
  // Pidgin or English is simply followed
  if (englishAsked && (foreign || latest.lang === "neutral")) {
    return { instruction: ENGLISH_ASKED, lang: "english", requested: "English", strong: false };
  }

  return {
    instruction: instructionFor(latest),
    lang: latest.lang,
    requested: null,
    strong: foreign,
  };
}

// Simple wrapper that returns only the instruction text
function languageInstruction(customerTexts = [], chatKey = null) {
  return languageProfile(customerTexts, chatKey).instruction;
}

// A friendly message for when no AI is available for a moment. Uses Pidgin if the person writes Pidgin.
function busyMessage(customerTexts = [], waitSeconds = 0) {
  const profile = languageProfile(customerTexts);
  const mins = waitSeconds > 0 ? Math.max(1, Math.ceil(waitSeconds / 60)) : 1;
  const when = mins <= 1 ? "in about a minute" : `in about ${mins} minutes`;
  if (profile.lang === "pidgin") {
    return `Abeg give me small time 🙏 Plenty people dey message me now. Send am again ${mins <= 1 ? "after one minute" : `after like ${mins} minutes`}.`;
  }
  return `I'm getting a lot of messages at once and need a short breather 🙏 Please send that again ${when}.`;
}

module.exports = {
  detectLanguage,
  languageInstruction,
  languageProfile,
  requestedLanguage,
  busyMessage,
  cleanForLanguage,
};
