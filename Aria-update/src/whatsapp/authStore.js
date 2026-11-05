// Where Aria keeps its WhatsApp login (the "session").
//
// Two modes, picked automatically:
//   1. SUPABASE  - when SUPABASE_URL and SUPABASE_SERVICE_KEY are set. The login lives in the
//                  `wa_auth` table, so it survives Render restarts and redeploys.
//   2. FILES     - otherwise. The login lives in the folder AUTH_DIR (default ./auth_info).
//                  Fine on your PC. On Render's free tier this folder is wiped on every restart.
//
// Both modes return the same thing: { state, saveCreds, kind }.
// Use clearAuthStore() to wipe the login (for example after WhatsApp logs Aria out).

const fs = require("fs");
const path = require("path");
const {
  useMultiFileAuthState,
  initAuthCreds,
  BufferJSON,
  proto,
} = require("@whiskeysockets/baileys");

const AUTH_DIR = process.env.AUTH_DIR || path.join(process.cwd(), "auth_info");
const SESSION_ID = process.env.WA_SESSION_ID || "aria";
const TABLE = process.env.WA_AUTH_TABLE || "wa_auth";

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
// Accepts either name, because Supabase calls it the "service_role" key and .env files often use SUPABASE_SERVICE_ROLE_KEY.
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_KEY);

// Every write to the saved login goes through this chain, one at a time and in order.
// startBot() waits for it before reading the login back, so a restart can never read
// a login that is only half saved.
let writeChain = Promise.resolve();
function enqueueWrite(fn) {
  const run = writeChain.then(fn);
  writeChain = run.catch((err) => {
    console.error("⚠️ Saving the WhatsApp login failed:", err.message);
  });
  return run.catch(() => {});
}

// ---------------------------------------------------------------------------
// Supabase (PostgREST) helpers. Plain fetch, no extra package needed.
// ---------------------------------------------------------------------------

async function rest(method, query, body, extraHeaders = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${TABLE}${query ? `?${query}` : ""}`;
  const res = await fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let hint = "";
    if (res.status === 404 || /PGRST205|does not exist/i.test(text)) {
      hint = ` (does the "${TABLE}" table exist? Run supabase/wa_auth.sql in the Supabase SQL editor)`;
    } else if (res.status === 401 || res.status === 403) {
      hint = " (check SUPABASE_SERVICE_ROLE_KEY is the service_role key)";
    }
    throw new Error(`Supabase ${method} failed with ${res.status}: ${text.slice(0, 200)}${hint}`);
  }
  return text ? JSON.parse(text) : null;
}

const enc = encodeURIComponent;

// ("a","b") list for PostgREST's in.(...) filter, URL-encoded
function inList(values) {
  const quoted = values.map((v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return enc(`(${quoted.join(",")})`);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const serialize = (value) => JSON.stringify(value, BufferJSON.replacer);
const deserialize = (text) => JSON.parse(text, BufferJSON.reviver);

async function openSupabaseStore() {
  // A network error here must THROW. If we pretended there was no login, Aria would
  // create a new one and overwrite the good one.
  const rows = await rest("GET", `session=eq.${enc(SESSION_ID)}&id=eq.creds&select=value`);
  const creds = rows && rows[0] ? deserialize(rows[0].value) : initAuthCreds();

  const cache = new Map();

  const keys = {
    async get(type, ids) {
      const data = {};
      const missing = [];
      for (const id of ids) {
        const rid = `${type}-${id}`;
        if (cache.has(rid)) data[id] = cache.get(rid);
        else missing.push(id);
      }
      for (const part of chunk(missing, 50)) {
        try {
          const found = await rest(
            "GET",
            `session=eq.${enc(SESSION_ID)}&id=in.${inList(part.map((id) => `${type}-${id}`))}&select=id,value`
          );
          for (const row of found || []) {
            let value = deserialize(row.value);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            cache.set(row.id, value);
            data[row.id.slice(type.length + 1)] = value;
          }
        } catch (err) {
          console.error("⚠️ Could not read WhatsApp keys from Supabase:", err.message);
        }
      }
      return data;
    },

    async set(data) {
      const upserts = [];
      const deletes = [];
      for (const type of Object.keys(data)) {
        for (const id of Object.keys(data[type])) {
          const value = data[type][id];
          const rid = `${type}-${id}`;
          if (value) {
            cache.set(rid, value);
            upserts.push({ session: SESSION_ID, id: rid, value: serialize(value) });
          } else {
            cache.delete(rid);
            deletes.push(rid);
          }
        }
      }
      await enqueueWrite(async () => {
        for (const part of chunk(upserts, 200)) {
          await rest("POST", "on_conflict=session,id", part, {
            Prefer: "resolution=merge-duplicates,return=minimal",
          });
        }
        for (const part of chunk(deletes, 50)) {
          await rest("DELETE", `session=eq.${enc(SESSION_ID)}&id=in.${inList(part)}`, undefined, {
            Prefer: "return=minimal",
          });
        }
      });
    },
  };

  // creds.update fires very often. If a save is already running, remember that one more
  // is needed and let the running save pick it up, so we never queue up dozens of writes.
  let credsPending = false;
  let credsRunning = null;
  async function saveCreds() {
    credsPending = true;
    if (credsRunning) return credsRunning;
    credsRunning = (async () => {
      try {
        while (credsPending) {
          credsPending = false;
          const row = [{ session: SESSION_ID, id: "creds", value: serialize(creds) }];
          await enqueueWrite(() =>
            rest("POST", "on_conflict=session,id", row, {
              Prefer: "resolution=merge-duplicates,return=minimal",
            })
          );
        }
      } finally {
        credsRunning = null;
      }
    })();
    return credsRunning;
  }

  return { kind: "supabase", state: { creds, keys }, saveCreds };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

async function openFileStore() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  return {
    kind: "files",
    state,
    saveCreds: () =>
      enqueueWrite(async () => {
        // Never crash if the folder was cleared while a save was pending
        fs.mkdirSync(AUTH_DIR, { recursive: true });
        await saveCreds();
      }),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function openAuthStore() {
  await writeChain; // let any save in progress finish first
  return USE_SUPABASE ? openSupabaseStore() : openFileStore();
}

async function clearAuthStore() {
  await writeChain;
  if (USE_SUPABASE) {
    await rest("DELETE", `session=eq.${enc(SESSION_ID)}`, undefined, { Prefer: "return=minimal" });
  } else {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
}

function describeAuthStore() {
  return USE_SUPABASE
    ? `Supabase table "${TABLE}" (session "${SESSION_ID}")`
    : `folder ${AUTH_DIR} (wiped on every Render restart unless you attach a disk)`;
}

module.exports = { openAuthStore, clearAuthStore, describeAuthStore };
