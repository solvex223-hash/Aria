// languageHint.js - works out which language the customer's LATEST message is in and gives the
// AI one clear instruction about it.
//
// Why this exists: the AI copies the style of its own earlier replies. If its first reply was in
// Pidgin, every later reply stayed in Pidgin, even after the customer switched to English. Here
// the language of the latest customer message is decided in code, and the AI is told plainly
// which language to use, so Aria switches whenever the customer switches (English <-> Pidgin <->
// Yoruba and so on) and never just stays in one language.

// Words that clearly belong to Nigerian Pidgin. Weight 2 = very Pidgin, weight 1 = a hint.
const PIDGIN_WORDS = {
  wetin: 2, abeg: 2, wahala: 2, sabi: 2, dey: 2, wey: 2, una: 2, pikin: 2, comot: 2,
  na: 1, wan: 1, dem: 1, oga: 1, naija: 1, sha: 1, abi: 1, chop: 1, kain: 1, gist: 1,
  japa: 1, nau: 1, omo: 1, shebi: 1, shey: 1, sef: 1, jare: 1, nawa: 1, gbam: 1, kpele: 1,
  oya: 1, biko: 1, werey: 1,
};

// Short phrases that are Pidgin (weight 2 each)
const PIDGIN_PHRASES = [
  /\bhow far\b(?! (is|are|do|does|did|from|can|will|would|should|to|away|it))/, /\bno be\b/, /\be don\b/, /\be dey\b/, /\be go\b/, /\bmake we\b/, /\bmake i\b/,
  /\bmake e\b/, /\bna so\b/, /\bno wahala\b/, /\bi wan\b/, /\bwan make\b/, /\bdem don\b/,
  /\bhow much be\b/, /\bna wa\b/, /\bdon (tire|go|come|finish|reach|start|do)\b/, /\bwetin (be|dey|you|i|we)\b/,
];

// Common English words. Two or more different ones in a message = it is English.
const ENGLISH_WORDS = new Set([
  "the", "is", "are", "you", "your", "and", "to", "of", "what", "how", "can", "please", "hello",
  "hi", "thanks", "thank", "need", "want", "my", "i", "for", "with", "this", "that", "do", "does",
  "have", "would", "could", "much", "price", "website", "me", "we", "it", "in", "on", "at", "a",
  "an", "be", "will", "about", "if", "or", "not", "just", "like", "good", "when", "who", "where",
  "which", "from", "they", "he", "she", "them", "was", "were", "been", "get", "make", "send",
  "tell", "know", "think", "much", "many", "any", "some", "too", "very", "really", "okay",
]);

// Other Nigerian languages and French: a few clear signs each (enough to say "reply in X")
const OTHER_LANGUAGES = [
  { name: "Yoruba", chars: /[ẹọṣ]/, words: ["bawo", "jowo", "kaaro", "kaasan", "kaale", "pele", "dupe", "nko", "ṣe"] , phrases: [/\bmo fe\b/, /\bse daadaa\b/, /\be kaaro\b/, /\be kaasan\b/, /\be kaale\b/] },
  { name: "Igbo", chars: /[ịụ]/, words: ["kedu", "ndewo", "daalu", "imela", "gwam", "nne"], phrases: [/\bnna m\b/] },
  { name: "Hausa", chars: null, words: ["sannu", "nagode", "barka", "lafiya", "yaya"], phrases: [/\bina kwana\b/, /\bdan allah\b/] },
  { name: "French", chars: null, words: ["bonjour", "bonsoir", "merci", "salut", "voudrais", "monsieur", "madame", "comment"], phrases: [/\bje suis\b/, /\bje veux\b/, /\bs'il (vous|te) pla[iî]t\b/, /\bc'est\b/] },
];

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

// Returns { lang, score }. lang is one of:
// "pidgin", "mixed" (English with a little Pidgin), "english", "yoruba", "igbo", "hausa",
// "french" or "neutral" (too short or too unclear to tell, like "ok" or "👍").
function detectLanguage(text) {
  const clean = cleanForLanguage(text);
  if (!clean) return { lang: "neutral", score: 0 };
  const tokens = clean.split(" ");

  // Other languages first (their signs are very specific)
  for (const l of OTHER_LANGUAGES) {
    let hits = 0;
    if (l.chars && l.chars.test(clean)) hits += 2;
    for (const t of tokens) if (l.words.includes(t)) hits += 1;
    for (const p of l.phrases) if (p.test(clean)) hits += 2;
    if (hits >= 2 || (hits >= 1 && tokens.length <= 3)) {
      return { lang: l.name.toLowerCase(), score: hits };
    }
  }

  // Pidgin score
  let pidgin = 0;
  for (const t of tokens) pidgin += PIDGIN_WORDS[t] || 0;
  for (const p of PIDGIN_PHRASES) if (p.test(clean)) pidgin += 2;

  // English signal: how many different common English words are there?
  const englishHits = new Set(tokens.filter((t) => ENGLISH_WORDS.has(t))).size;

  if (pidgin >= 3) return { lang: "pidgin", score: pidgin };
  if (pidgin >= 1 && englishHits >= 2) return { lang: "mixed", score: pidgin };
  if (pidgin >= 1) return { lang: tokens.length <= 3 ? "pidgin" : "mixed", score: pidgin };
  if (englishHits >= 2 || (englishHits >= 1 && tokens.length >= 4)) return { lang: "english", score: englishHits };
  if (tokens.length >= 4) return { lang: "english", score: 0 };
  return { lang: "neutral", score: 0 };
}

const NEUTRAL_LINE =
  "Reply in the same language and style as the person's recent messages (English, Pidgin or another " +
  "language). If you cannot tell, use simple, friendly English.";

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
  yoruba: "The person's latest message is in Yoruba. Reply in Yoruba, naturally and correctly. If you are not confident, say so briefly and continue in simple English.",
  igbo: "The person's latest message is in Igbo. Reply in Igbo, naturally and correctly. If you are not confident, say so briefly and continue in simple English.",
  hausa: "The person's latest message is in Hausa. Reply in Hausa, naturally and correctly. If you are not confident, say so briefly and continue in simple English.",
  french: "The person's latest message is in French. Reply in French, naturally and correctly.",
};

// customerTexts: the person's messages, oldest first. The newest decides. If the newest is too
// short to tell (like "ok" or "thanks"), the one before it is used instead.
function languageInstruction(customerTexts = []) {
  const recent = customerTexts.slice(-4).reverse();
  for (const text of recent) {
    const { lang } = detectLanguage(text);
    if (lang !== "neutral") return INSTRUCTIONS[lang] || NEUTRAL_LINE;
  }
  return NEUTRAL_LINE;
}

module.exports = { detectLanguage, languageInstruction, cleanForLanguage };
