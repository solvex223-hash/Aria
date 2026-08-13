const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

/**
 * Describes an image using Groq's vision-capable model.
 * @param {Buffer} imageBuffer - raw image bytes downloaded from WhatsApp
 * @param {string} caption - any caption text the customer sent with the image
 * @returns {Promise<string>} a natural-language description of the image
 */
async function describeImage(imageBuffer, caption = "") {

    const base64 = imageBuffer.toString("base64");
    const dataUrl = `data:image/jpeg;base64,${base64}`;

    const prompt = caption
        ? `The customer sent this image with the caption: "${caption}". Describe what's in the image and how it relates to the caption, in 1-3 sentences.`
        : `Describe what's in this image in 1-3 sentences, focusing on anything relevant to a business/customer service context.`;

    const response = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: "qwen/qwen3.6-27b",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        { type: "image_url", image_url: { url: dataUrl } }
                    ]
                }
            ],
            max_tokens: 300
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Groq vision request failed: ${response.status} ${errText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || "Unable to describe the image.";
}

module.exports = describeImage;