const fs = require("fs");
const path = require("path");

const SETTINGS_PATH = path.join(__dirname, "..", "..", "data", "settings.json");

const DEFAULT_SETTINGS = {
    botEnabled: true
};

function readSettings() {
    try {
        if (!fs.existsSync(SETTINGS_PATH)) {
            writeSettings(DEFAULT_SETTINGS);
            return { ...DEFAULT_SETTINGS };
        }
        const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch (err) {
        console.error("⚠️ Failed to read settings.json, using defaults:", err.message);
        return { ...DEFAULT_SETTINGS };
    }
}

function writeSettings(settings) {
    try {
        fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    } catch (err) {
        console.error("⚠️ Failed to write settings.json:", err.message);
    }
}

function isBotEnabled() {
    return readSettings().botEnabled;
}

function setBotEnabled(value) {
    const settings = readSettings();
    settings.botEnabled = value;
    writeSettings(settings);
}

module.exports = {
    isBotEnabled,
    setBotEnabled
};