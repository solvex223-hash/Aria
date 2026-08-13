async function sendMessage(sock, jid, text) {
    try {
        await sock.sendMessage(jid, {
            text,
        });

        console.log("📤 Reply sent to:", jid);

    } catch (err) {
        console.error("❌ Failed to send message:", err);
    }
}

module.exports = sendMessage;