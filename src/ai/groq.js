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
        console.error(`❌ Groq Error (model: ${MODEL}):`, err.message);
        throw err;
    }
}

module.exports = askGroq;