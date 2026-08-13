const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

// Ensure the data folder exists
const dataDir = path.join(__dirname, "../../data");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Database path
const dbPath = path.join(dataDir, "aria.db");

// Create/Open database
let db;
try {
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  console.log("🗄️ SQLite database connected.");
} catch (err) {
  console.error("❌ Database connection failed:", err.message);
  throw err;
}

module.exports = db;