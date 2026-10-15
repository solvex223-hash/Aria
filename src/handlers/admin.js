// Admin commands. You type these in your own "Message yourself" chat.
//
//   /on <number>    Aria replies to this person
//   /off <number>   Aria never replies to this person (even in /all on mode)
//   /list           who Aria replies to, and who is turned off
//   /all on         reply to everyone who messages (except numbers turned off)
//   /all off        reply only to numbers turned on with /on
//   /help           show this list
//
// Numbers can be typed as 08012345678, +234 801 234 5678 or 2348012345678.

const {
  addAllowed,
  removeAllowed,
  listAllowed,
  setSetting,
  addBlocked,
  removeBlocked,
  listBlocked,
} = require("../database/access");

// "0803 123 4567", "+234 803 123 4567", "2348031234567" -> "2348031234567"
function normalizePhone(input) {
  const digits = String(input || "").replace(/\D/g, "");
  if (/^0\d{10}$/.test(digits)) return "234" + digits.slice(1);
  return digits;
}

function isValidNumber(n) {
  return /^\d{10,15}$/.test(n);
}

const HELP_TEXT = [
  "Commands:",
  "/on <number> - Aria replies to this person",
  "/off <number> - Aria never replies to this person",
  "/list - who Aria replies to",
  "/all on - reply to everyone (except numbers turned off)",
  "/all off - reply only to numbers turned on",
  "/help - this list",
  "",
  "Number example: 08012345678 or 2348012345678",
].join("\n");

async function handleAdmin(sock, sender, text) {
  const reply = (t) => sock.sendMessage(sender, { text: t });
  const [first, ...rest] = text.trim().split(/\s+/);
  const cmd = first.toLowerCase();
  const arg = rest.join(" ");

  try {
    if (cmd === "/on") {
      const number = normalizePhone(arg);
      if (!isValidNumber(number)) {
        return await reply("Send it like this: /on 08012345678 (or with country code: /on 2348012345678)");
      }
      addAllowed(number);
      removeBlocked(number);
      return await reply(`✅ Aria will now reply to ${number}`);
    }

    if (cmd === "/off") {
      const number = normalizePhone(arg);
      if (!isValidNumber(number)) {
        return await reply("Send it like this: /off 08012345678 (or with country code: /off 2348012345678)");
      }
      removeAllowed(number);
      addBlocked(number);
      return await reply(`🛑 Aria will not reply to ${number}`);
    }

    if (cmd === "/list") {
      const allowed = listAllowed();
      const blocked = listBlocked();
      let out = allowed.length
        ? `Aria is replying to:\n${allowed.join("\n")}`
        : "Aria is not replying to anyone yet. Use /on <number>.";
      if (blocked.length) out += `\n\nTurned off (never replies):\n${blocked.join("\n")}`;
      return await reply(out);
    }

    if (cmd === "/all") {
      const mode = arg.toLowerCase();
      if (mode === "on") {
        setSetting("allow_all", "true");
        return await reply(
          "⚠️ Aria will now reply to everyone who messages this number, except numbers you turned off. Send /all off to go back to the list only."
        );
      }
      if (mode === "off") {
        setSetting("allow_all", "false");
        return await reply("🔒 Aria will only reply to numbers you turned on with /on.");
      }
      return await reply("Use /all on or /all off");
    }

    if (cmd === "/help") {
      return await reply(HELP_TEXT);
    }

    return await reply("I don't know that command. Send /help to see the list.");
  } catch (err) {
    console.error("Admin command failed:", err);
    try {
      await reply(`❌ Something went wrong: ${err.message}`);
    } catch (_) {
      // nothing more we can do
    }
  }
}

module.exports = { handleAdmin };