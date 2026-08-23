const { addAllowed, removeAllowed, listAllowed, setSetting, getSetting } = require("../database/db");

async function handleAdmin(sock, sender, text) {
  const [cmd, arg] = text.trim().split(/\s+/);

  if (cmd === "/on" && arg) {
    addAllowed(arg.replace(/\D/g, ""));
    await sock.sendMessage(sender, { text: `✅ Now chatting: ${arg}` });
    return;
  }
  if (cmd === "/off" && arg) {
    removeAllowed(arg.replace(/\D/g, ""));
    await sock.sendMessage(sender, { text: `🛑 Stopped: ${arg}` });
    return;
  }
  if (cmd === "/list") {
    const list = listAllowed();
    await sock.sendMessage(sender, {
      text: list.length ? `Currently chatting with:\n${list.join("\n")}` : "No one is currently allowed.",
    });
    return;
  }
  if (text.trim() === "/all on") {
    setSetting("allow_all", "true");
    await sock.sendMessage(sender, { text: "⚠️ Danger mode: replying to all strangers." });
    return;
  }
  if (text.trim() === "/all off") {
    setSetting("allow_all", "false");
    await sock.sendMessage(sender, { text: "🔒 Safe mode: replying to allowlist only." });
    return;
  }
  if (cmd === "/help") {
    await sock.sendMessage(sender, {
      text: "/on <number>\n/off <number>\n/list\n/all on\n/all off",
    });
  }
}

module.exports = { handleAdmin };