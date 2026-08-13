const db = require("../database/db");

function saveMessage(phone, role, message) {
    return new Promise((resolve, reject) => {

        db.run(
            `
            INSERT INTO conversations
            (phone, role, message)
            VALUES (?, ?, ?)
            `,
            [phone, role, message],
            (err) => {

                if (err) return reject(err);

                resolve();
            }
        );

    });
}

function getConversation(phone, limit = 20) {

    return new Promise((resolve, reject) => {

        db.all(
            `
            SELECT role, message
            FROM conversations
            WHERE phone = ?
            ORDER BY id DESC
            LIMIT ?
            `,
            [phone, limit],
            (err, rows) => {

                if (err) return reject(err);

                rows.reverse();

                resolve(rows);

            }
        );

    });

}

module.exports = {

    saveMessage,

    getConversation

};