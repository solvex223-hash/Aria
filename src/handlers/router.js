const customer = require("./customer");
const admin = require("./admin");

async function router(sock, sender, text, options = {}) {

    const { isAdmin = false } = options;

    console.log("================================");
    console.log("Sender:", sender);
    console.log("Text:", text);
    console.log("Admin:", isAdmin);
    console.log("================================");

    // Ignore empty messages
    if (!text || !text.trim()) {
        return;
    }

    // Admin commands (from self-chat) start with "/"
    if (isAdmin) {
        if (text.trim().startsWith("/")) {
            return admin.handleAdmin(sock, sender, text);
        }
        // Self-chat message that isn't a command — ignore it, it's just
        // you leaving yourself a note, not something Aria should act on.
        return;
    }

    // Everything else is a real customer conversation
    return customer.handleCustomer(
        sock,
        sender,
        text
    );
}

module.exports = router;