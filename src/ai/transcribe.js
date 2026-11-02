const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const STT_MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3";

const EXTENSIONS = {
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/webm": "webm"
};

/**
 * Transcribes a voice note using Groq's Whisper model.
 * @param {Buffer} audioBuffer - raw audio bytes downloaded from WhatsApp (usually .ogg/opus)
 * @param {string} mimeType - audio type, defaults to ogg (WhatsApp voice notes)
 * @returns {Promise<string>} the transcribed text
 */
async function transcribeAudio(audioBuffer, mimeType = "audio/ogg") {

    // "audio/ogg; codecs=opus" -> "audio/ogg"
    const type = String(mimeType).split(";")[0].trim().toLowerCase();
    const extension = EXTENSIONS[type] || "ogg";

    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: EXTENSIONS[type] ? type : "audio/ogg" });
    formData.append("file", blob, `voicenote.${extension}`);
    formData.append("model", STT_MODEL);
    formData.append("response_format", "json");
    formData.append("temperature", "0");

    // Optional: force a language (for example "en") if auto-detect guesses wrong
    if (process.env.GROQ_STT_LANGUAGE) {
        formData.append("language", process.env.GROQ_STT_LANGUAGE);
    }

    const response = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${GROQ_API_KEY}`
        },
        body: formData,
        signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Groq transcription request failed: ${response.status} ${errText}`);
    }

    const data = await response.json();
    return data.text?.trim() || "";
}

module.exports = transcribeAudio;