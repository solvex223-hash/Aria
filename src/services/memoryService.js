const db = require("../database/db");

function saveMessage(phone, role, message) {
  return new Promise((resolve, reject) => {
    try {
      const stmt = db.prepare(`
        INSERT INTO conversations
        (phone, role, message)
        VALUES (?, ?, ?)
      `);
      stmt.run(phone, role, message);
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

function getConversation(phone, limit = 20) {
  return new Promise((resolve, reject) => {
    try {
      const stmt = db.prepare(`
        SELECT role, message
        FROM conversations
        WHERE phone = ?
        ORDER BY id DESC
        LIMIT ?
      `);
      const rows = stmt.all(phone, limit);
      rows.reverse();
      resolve(rows);
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  saveMessage,
  getConversation
};