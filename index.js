require("dotenv").config();

const http = require("http");

const initializeDatabase = require("./src/database/schema");
const startWhatsApp = require("./src/whatsapp/connect");

// Prevent a single failed network request (e.g. a dropped fetch to Groq,
// or a WhatsApp connection blip) from crashing the entire process.
process.on("unhandledRejection", (reason) => {
    console.error("⚠️ Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
    console.error("⚠️ Uncaught Exception:", err);
    // Deliberately NOT exiting — connect.js already handles WhatsApp
    // reconnects; this just stops unrelated errors from taking Aria down.
});

// ===============================
// KEEP-ALIVE HTTP SERVER
// ===============================
// Render's free tier sleeps the service after 15 minutes with no
// incoming HTTP traffic. This tiny server gives something for an
// external pinger (e.g. UptimeRobot) to hit every few minutes, so
// Render never sees Aria as "idle" and keeps it running 24/7.
// PORT is set automatically by Render — falls back to 3000 locally.
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Aria is alive ✅");
}).listen(PORT, () => {
    console.log(`🌐 Keep-alive server listening on port ${PORT}`);
});

// Create database and tables
initializeDatabase();

// Start WhatsApp
startWhatsApp();