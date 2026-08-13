const sendMessage = require("../whatsapp/sender");
const { isBotEnabled, setBotEnabled } = require("../utils/botState");

async function handleAdmin(sock, sender, text) {

    const command = text.trim().split(" ")[0].toLowerCase();

    switch (command) {

        case "/help":
            return sendMessage(sock, sender,
                `🔑 *Admin Commands*\n\n` +
                `/help - show this menu\n` +
                `/status - check if Aria is running\n` +
                `/bot on - turn Aria on\n` +
                `/bot off - turn Aria off\n` +
                `/list - list recent leads (coming soon)\n` +
                `/broadcast <msg> - message all leads (coming soon)\n` +
                `/restart - restart the bot (coming soon)`
            );

        case "/status":
            return sendMessage(sock, sender,
                `📊 Aria is currently *${isBotEnabled() ? "ON ✅" : "OFF ⛔"}*`
            );

        case "/bot": {
            const sub = text.trim().split(" ")[1]?.toLowerCase();
            if (sub === "on") {
                setBotEnabled(true);
                return sendMessage(sock, sender, "✅ Aria is now ON.");
            }
            if (sub === "off") {
                setBotEnabled(false);
                return sendMessage(sock, sender, "⛔ Aria is now OFF.");
            }
            return sendMessage(sock, sender, "Usage: /bot on  OR  /bot off");
        }

        default:
            return sendMessage(sock, sender,
                `Unknown command "${command}". Send /help to see what's available.`
            );
    }
}

module.exports = {
    handleAdmin
};