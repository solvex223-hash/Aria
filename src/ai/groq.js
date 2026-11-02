require("dotenv").config();

const Groq = require("groq-sdk");

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

// Change the model with GROQ_TEXT_MODEL in .env (or Render's Environment tab), no code edit needed.
// llama-3.3-70b-versatile was retired by Groq on 16 Aug 2026.
const MODEL = process.env.GROQ_TEXT_MODEL || "openai/gpt-oss-20b";

// Reasoning models think before they answer, and that thinking uses part of the token limit.
// Keep it short and hide it so only the JSON reply comes back.
function reasoningOptions(model) {
    if (model.startsWith("openai/gpt-oss")) {
        return { reasoning_effort: "low", include_reasoning: false };
    }
    if (model.startsWith("qwen/")) {
        return { reasoning_effort: "none", reasoning_format: "hidden" };
    }
    return {};
}


// Sometimes the model answers in plain text instead of JSON (it happens most in casual chat, and
// in Pidgin). Groq then rejects the answer with a 400 "json_validate_failed" error, but it still
// includes the text the model wrote ("failed_generation"). Instead of telling the customer
// "something went wrong", we rescue that text and use it as the reply.
function failedGenerationFrom(err) {
    const direct = [err?.error?.error?.failed_generation, err?.error?.failed_generation];
    for (const c of direct) {
        if (typeof c === "string" && c.trim()) return c;
    }
    try {
        const body = JSON.parse(String(err?.message || "").replace(/^\d+\s+/, ""));
        const f = body?.error?.failed_generation;
        if (typeof f === "string" && f.trim()) return f;
    } catch {
        // not JSON, ignore
    }
    return null;
}

function rescueReply(raw) {
    let text = String(raw).trim();

    // Case 1: it is actually valid JSON with a reply inside
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.reply === "string") return JSON.stringify(parsed);
    } catch {
        // continue
    }

    // Case 2: broken JSON, but the reply text can still be pulled out
    const m = text.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) {
        try {
            text = JSON.parse(`"${m[1]}"`);
        } catch {
            text = m[1];
        }
    }

    // Case 3: plain text. Use it as it is.
    return JSON.stringify({
        reply: text,
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
    });
}

async function askGroq(systemPrompt, messages = []) {
    try {
        const completion = await groq.chat.completions.create({
            model: MODEL,
            temperature: 0.7,
            max_completion_tokens: 2000,
            response_format: {
                type: "json_object",
            },
            ...reasoningOptions(MODEL),
            messages: [
                {
                    role: "system",
                    content: systemPrompt,
                },
                ...messages,
            ],
        });

        const choice = completion.choices[0];

        if (choice.finish_reason === "length") {
            console.warn("⚠️ Groq reply was cut off by the token limit. Raise max_completion_tokens.");
        }

        const content = choice.message.content;
        if (!content || !content.trim()) {
            throw new Error("Groq returned an empty reply");
        }

        return content;

    } catch (err) {
        const rescued = failedGenerationFrom(err);
        if (rescued) {
            console.warn("⚠️ The AI answered in plain text instead of JSON. Using its text as the reply.");
            return rescueReply(rescued);
        }
        console.error(`❌ Groq Error (model: ${MODEL}):`, err.message);
        throw err;
    }
}

module.exports = askGroq;