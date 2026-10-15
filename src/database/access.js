// Who Aria may reply to, who is turned off, and a few settings.
// Built on the SQLite connection in ./db.js. It creates its own tables if they are missing,
// so it works even if initializeDatabase() (schema.js) was never run.

const db = require("./db");

db.exec(`
  CREATE TABLE IF NOT EXISTS allowed_numbers (
    phone TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS blocked_numbers (
    phone TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE,
    value TEXT
  );
`);

const q = {
  isAllowed: db.prepare("SELECT 1 AS ok FROM allowed_numbers WHERE phone = ?"),
  addAllowed: db.prepare("INSERT OR IGNORE INTO allowed_numbers (phone) VALUES (?)"),
  removeAllowed: db.prepare("DELETE FROM allowed_numbers WHERE phone = ?"),
  listAllowed: db.prepare("SELECT phone FROM allowed_numbers ORDER BY created_at, phone"),
  isBlocked: db.prepare("SELECT 1 AS ok FROM blocked_numbers WHERE phone = ?"),
  addBlocked: db.prepare("INSERT OR IGNORE INTO blocked_numbers (phone) VALUES (?)"),
  removeBlocked: db.prepare("DELETE FROM blocked_numbers WHERE phone = ?"),
  listBlocked: db.prepare("SELECT phone FROM blocked_numbers ORDER BY created_at, phone"),
  getSetting: db.prepare("SELECT value FROM settings WHERE key = ?"),
  setSetting: db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ),
};

module.exports = {
  isAllowed: (phone) => Boolean(q.isAllowed.get(String(phone))),
  addAllowed: (phone) => { q.addAllowed.run(String(phone)); },
  removeAllowed: (phone) => { q.removeAllowed.run(String(phone)); },
  listAllowed: () => q.listAllowed.all().map((r) => r.phone),

  isBlocked: (phone) => Boolean(q.isBlocked.get(String(phone))),
  addBlocked: (phone) => { q.addBlocked.run(String(phone)); },
  removeBlocked: (phone) => { q.removeBlocked.run(String(phone)); },
  listBlocked: () => q.listBlocked.all().map((r) => r.phone),

  getSetting: (key, fallback) => {
    const row = q.getSetting.get(String(key));
    return row && row.value !== null && row.value !== undefined ? row.value : fallback;
  },
  setSetting: (key, value) => { q.setSetting.run(String(key), String(value)); },
};