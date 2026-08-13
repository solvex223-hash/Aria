const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

// Ensure the data folder exists
const dataDir = path.join(__dirname, "../../data");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

// Database path
const dbPath = path.join(dataDir, "aria.db");

// Create/Open database
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("❌ Database connection failed:", err.message);
  } else {
    console.log("🗄️ SQLite database connected.");
  }
});

module.exports = db;