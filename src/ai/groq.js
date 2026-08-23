require("dotenv").config();

const Groq = require("groq-sdk");

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

async function askGroq(systemPrompt, messages = []) {
    try {
        const completion = await groq.chat.completions.create({
            model: process.env.MODEL || "openai/gpt-oss-120b", // llama-3.3-70b-versatile was deprecated Aug 2026
            temperature: 0.7,
            max_tokens: 800,
            response_format: {
                type: "json_object",
            },
            messages: [
                {
                    role: "system",
                    content: systemPrompt,
                },
                ...messages,
            ],
        });

        return completion.choices[0].message.content;

    } catch (err) {
        console.error("❌ Groq Error:", err.message);

        return JSON.stringify({
            reply: "I'm sorry, something went wrong. Please try again in a moment 😊",
            intent: "error",
            action: "none",
            leadScore: 0,
            saveMemory: false,
            needsHuman: false
        });
    }
}

module.exports = askGroq;