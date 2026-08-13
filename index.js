require("dotenv").config();

const initializeDatabase = require("./src/database/schema");
const startWhatsApp = require("./src/whatsapp/connect");

// Create database and tables
initializeDatabase();

// Start WhatsApp
startWhatsApp();