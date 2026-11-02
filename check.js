require("dotenv").config();
const fs = require("fs");
const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
console.log("authStore updated:", fs.readFileSync("src/whatsapp/authStore.js", "utf8").includes("SUPABASE_SERVICE_ROLE_KEY"));
console.log("URL set:", !!url, "| key set:", !!key);
fetch(`${url}/rest/v1/wa_auth?select=id&limit=1`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
})
  .then(async (r) => console.log("Supabase says:", r.status, (await r.text()).slice(0, 150)))
  .catch((e) => console.log("Could not reach Supabase:", e.message, "|", e.cause && (e.cause.code || e.cause.message)));