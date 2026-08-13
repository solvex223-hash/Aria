const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

/**
 * Transcribes a voice note using Groq's Whisper model.
 * @param {Buffer} audioBuffer - raw audio bytes downloaded from WhatsApp (usually .ogg/opus)
 * @returns {Promise<string>} the transcribed text
 */
async function transcribeAudio(audioBuffer) {

    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: "audio/ogg" });
    formData.append("file", blob, "voicenote.ogg");
    formData.append("model", "whisper-large-v3");

    const response = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${GROQ_API_KEY}`
        },
        body: formData
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Groq transcription request failed: ${response.status} ${errText}`);
    }

    const data = await response.json();
    return data.text?.trim() || "";
}

module.exports = transcribeAudio;