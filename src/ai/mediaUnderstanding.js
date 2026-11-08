// mediaUnderstanding.js - lets Aria "see" stickers and videos (pictures and voice notes already work).
//
// STICKER  -> the sticker picture goes to the vision model, which says what it shows and the feeling
//             it gives (laughing, shocked, crying...). Animated stickers that the model rejects fall back
//             to the small preview picture that WhatsApp puts inside the sticker.
// VIDEO    -> up to 3 frames are taken from the video and sent to the vision model together, and the
//             sound is turned into text by the same voice-note transcriber. Needs the ffmpeg-static
//             package. Without it, Aria still uses the small preview picture inside the video.
//
// Settings (optional, in .env or Render's Environment tab):
//   VIDEO_MAX_MB=16        videos bigger than this are not downloaded (preview picture only)
//   VIDEO_MAX_SECONDS=30   only the first 30 seconds of a video are looked at
//   VIDEO_FRAMES=2         pictures taken from a video (1 to 3, each costs about 2,000 tokens)
//   FFMPEG_PATH=...        use your own ffmpeg instead of the ffmpeg-static package

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const describeImage = require("./vision");

let transcribeAudio = null;
try {
  transcribeAudio = require("./transcribe");
} catch {
  // voice transcription is optional here
}

let ffmpegPath = process.env.FFMPEG_PATH || null;
if (!ffmpegPath) {
  try {
    ffmpegPath = require("ffmpeg-static");
  } catch {
    // not installed: videos fall back to their preview picture
  }
}

const VIDEO_MAX_BYTES = Number(process.env.VIDEO_MAX_MB || 16) * 1024 * 1024;
const VIDEO_MAX_SECONDS = Number(process.env.VIDEO_MAX_SECONDS || 30);
// Each picture costs about 2,000 tokens on Groq, so 2 frames is the default (VIDEO_FRAMES=1..3)
const MAX_FRAMES = Math.min(3, Math.max(1, Number(process.env.VIDEO_FRAMES) || 2));

function run(bin, args, timeout = 45000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || "").slice(0, 300);
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

const toBuffer = (data) => (Buffer.isBuffer(data) ? data : Buffer.from(data));

// ---------------------------------------------------------------------------
// Stickers
// ---------------------------------------------------------------------------

// Returns a short description of the sticker and the feeling it gives, or "" if it cannot be read.
async function describeSticker(buffer, sticker = {}) {
  const mime = String(sticker.mimetype || "image/webp").split(";")[0].trim() || "image/webp";

  try {
    const text = await describeImage(buffer, "", mime, { purpose: "sticker" });
    if (text) return text;
  } catch (err) {
    console.warn(`⚠️ Sticker could not be read directly (${err.message.slice(0, 120)}). Trying its preview picture...`);
  }

  // Animated stickers can be refused. WhatsApp keeps a small still picture inside the sticker.
  if (sticker.pngThumbnail && sticker.pngThumbnail.length) {
    try {
      const text = await describeImage(toBuffer(sticker.pngThumbnail), "", "image/png", { purpose: "sticker" });
      if (text) return text;
    } catch (err) {
      console.warn(`⚠️ Sticker preview could not be read either: ${err.message.slice(0, 120)}`);
    }
  }

  // Some stickers carry a text label describing them
  if (sticker.accessibilityLabel) return String(sticker.accessibilityLabel).slice(0, 200);
  return "";
}

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------

// Takes up to MAX_FRAMES evenly spaced frames and the spoken words out of a video.
async function extractFromVideo(buffer) {
  if (!ffmpegPath) return { frames: [], speech: "" };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aria-video-"));
  const input = path.join(dir, "input.mp4");
  const seconds = String(VIDEO_MAX_SECONDS);
  let frames = [];
  let speech = "";

  try {
    fs.writeFileSync(input, buffer);

    // Frames: one every 2 seconds (always at least the first one), small JPEGs
    try {
      await run(ffmpegPath, [
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", input, "-t", seconds,
        "-vf", "fps=1/2,scale=512:-2",
        "-q:v", "5",
        path.join(dir, "f%02d.jpg"),
      ]);
      const files = fs.readdirSync(dir).filter((f) => /^f\d+\.jpg$/.test(f)).sort();
      const pick =
        files.length <= MAX_FRAMES
          ? files
          : Array.from({ length: MAX_FRAMES }, (_, i) => files[Math.round((i * (files.length - 1)) / Math.max(1, MAX_FRAMES - 1))]);
      frames = pick.map((f) => fs.readFileSync(path.join(dir, f)));
    } catch (err) {
      console.warn(`⚠️ Could not take pictures from the video: ${err.message.slice(0, 120)} ${err.stderr || ""}`);
    }

    // Sound: mono 16 kHz WAV, then the voice-note transcriber
    if (transcribeAudio) {
      try {
        const wav = path.join(dir, "sound.wav");
        await run(ffmpegPath, [
          "-y", "-hide_banner", "-loglevel", "error",
          "-i", input, "-t", seconds,
          "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
          wav,
        ]);
        if (fs.existsSync(wav) && fs.statSync(wav).size > 4000) {
          speech = (await transcribeAudio(fs.readFileSync(wav), "audio/wav")) || "";
        }
      } catch {
        // no sound track, or it could not be read: that is fine
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { frames, speech: speech.trim().length >= 2 ? speech.trim() : "" };
}

// download: an async function that returns the video's bytes (only called when needed)
// Returns { description, speech }, both "" if nothing could be read.
async function describeVideo(download, video = {}) {
  const caption = String(video.caption || "").trim();
  const size = Number(video.fileLength || 0);
  const small = !size || size <= VIDEO_MAX_BYTES;

  let frames = [];
  let speech = "";

  if (ffmpegPath && small) {
    try {
      const buffer = await download();
      ({ frames, speech } = await extractFromVideo(buffer));
    } catch (err) {
      console.warn(`⚠️ Video could not be opened: ${err.message.slice(0, 120)}`);
    }
  } else if (!ffmpegPath) {
    console.warn("ℹ️ ffmpeg-static is not installed, so Aria only sees a small preview of videos. Run: npm install ffmpeg-static");
  } else {
    console.warn(`ℹ️ Video is bigger than ${Math.round(VIDEO_MAX_BYTES / 1048576)} MB, using its preview picture only.`);
  }

  // Fallback: the tiny preview picture that WhatsApp stores inside the video message
  if (!frames.length && video.jpegThumbnail && video.jpegThumbnail.length) {
    frames = [toBuffer(video.jpegThumbnail)];
  }

  let description = "";
  if (frames.length) {
    description = await describeImage(frames, caption, "image/jpeg", { purpose: "video" });
  }

  return { description: (description || "").trim(), speech };
}

module.exports = { describeSticker, describeVideo, extractFromVideo };
