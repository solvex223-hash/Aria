// groupControl.js - lets the admin control which WhatsApp groups Aria replies in.
// Commands are sent from the admin's private chat with the bot (not inside groups).
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'groups.json');

// Render wipes the data folder on every restart, so group settings are also backed up in the
// same Supabase table that keeps the WhatsApp login (under its own session name, so it never
// touches the login). Without Supabase keys, settings live only in data/groups.json.
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const REMOTE = Boolean(SUPABASE_URL && SUPABASE_KEY);
const REMOTE_SESSION = `${process.env.WA_SESSION_ID || 'aria'}-settings`;
const REMOTE_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

let cache = null;

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { cache = {}; }
  return cache;
}

function save(data) {
  cache = data;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn('⚠️ Could not write data/groups.json:', e.message);
  }
  pushRemote(data);
}

async function pushRemote(data) {
  if (!REMOTE) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/wa_auth?on_conflict=session,id`, {
      method: 'POST',
      headers: { ...REMOTE_HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([
        { session: REMOTE_SESSION, id: 'groups', value: JSON.stringify(data), updated_at: new Date().toISOString() },
      ]),
    });
    if (!res.ok) console.warn('⚠️ Could not back up group settings to Supabase:', res.status);
  } catch (e) {
    console.warn('⚠️ Could not back up group settings to Supabase:', e.message);
  }
}

// Call once when the bot starts: brings back the group settings saved before the last restart.
let restored = false;
async function initGroupStore() {
  if (!REMOTE || restored) return; // only once, so a reconnect never overwrites newer choices
  restored = true;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/wa_auth?session=eq.${encodeURIComponent(REMOTE_SESSION)}&id=eq.groups&select=value`,
      { headers: REMOTE_HEADERS }
    );
    if (!res.ok) throw new Error(`Supabase answered ${res.status}`);
    const rows = await res.json();
    if (rows[0]?.value) {
      cache = JSON.parse(rows[0].value);
      try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
      } catch {
        // the local copy is optional
      }
      console.log(`👥 Group settings restored (${Object.keys(cache).filter((k) => k !== '__default').length} groups).`);
    }
  } catch (e) {
    console.warn('⚠️ Could not restore group settings from Supabase:', e.message);
  }
}

const clean = (j) => (j || '').split(':')[0].split('@')[0];
const isGroup = (jid) => typeof jid === 'string' && jid.endsWith('@g.us');

// What happens in a group the admin never configured. Render wipes data/groups.json on every
// restart, so without a default Aria would go silent in all groups after each deploy.
//   GROUP_DEFAULT=mention  (default) reply only when tagged or replied to
//   GROUP_DEFAULT=all      reply to every message (WhatsApp may flag a busy bot, use with care)
//   GROUP_DEFAULT=off      stay silent until you turn the group on with /group on
// A group you set with /group on, /group off or /group mode always wins over this default.
const GROUP_DEFAULT = String(process.env.GROUP_DEFAULT || 'mention').trim().toLowerCase();

// "/groups on" and "/groups off" also change this default, so groups Aria joins later follow the
// same choice. It is stored under the key __default.
function currentDefault() {
  const saved = load().__default;
  return saved === 'on' || saved === 'off' ? saved : GROUP_DEFAULT === 'off' ? 'off' : 'on';
}

function groupConfig(jid) {
  const saved = load()[jid];
  if (saved) return saved;
  if (currentDefault() === 'off') return null;
  return { enabled: true, mode: GROUP_DEFAULT === 'all' ? 'all' : 'mention', isDefault: true };
}

function isGroupAllowed(jid) {
  return !!groupConfig(jid)?.enabled;
}

function setGroup(jid, enabled, name) {
  const data = load();
  data[jid] = {
    mode: 'mention',
    ...data[jid],
    enabled,
    name: name || data[jid]?.name || jid,
  };
  save(data);
}

function setMode(jid, mode, name) {
  const data = load();
  data[jid] = { enabled: false, ...data[jid], mode, name: name || data[jid]?.name || jid };
  save(data);
}

// Turn many groups on or off with a single save.
function setMany(groups, enabled) {
  const data = load();
  for (const g of groups) {
    data[g.jid] = { mode: 'mention', ...data[g.jid], enabled, name: g.name || data[g.jid]?.name || g.jid };
  }
  save(data);
}

function setDefault(value) {
  const data = load();
  data.__default = value;
  save(data);
}

function setModeMany(groups, mode) {
  const data = load();
  for (const g of groups) {
    data[g.jid] = { enabled: false, ...data[g.jid], mode, name: g.name || data[g.jid]?.name || g.jid };
  }
  save(data);
}

// Should Aria reply to this message in an allowed group?
// botIds: pass [sock.user?.id, sock.user?.lid]
function shouldReplyInGroup(msg, botIds) {
  if (msg.key?.fromMe) return false; // never reply to own messages

  const jid = msg.key.remoteJid;
  const g = groupConfig(jid);
  if (!g?.enabled) return false;
  if (g.mode === 'all') return true;

  const ids = (Array.isArray(botIds) ? botIds : [botIds]).filter(Boolean).map(clean);
  const m = msg.message || {};
  const ctx =
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.audioMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    {};

  const mentioned = (ctx.mentionedJid || []).some((j) => ids.includes(clean(j)));
  const repliedToBot = !!ctx.participant && ids.includes(clean(ctx.participant));
  return mentioned || repliedToBot;
}

// Fetch every group the bot is in, sorted by name so numbers stay stable.
async function fetchGroups(sock) {
  const all = await sock.groupFetchAllParticipating();
  return Object.values(all)
    .map((g) => ({ jid: g.id, name: g.subject || g.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Find a group by list number (1, 2, 3...) or by part of its name.
function pickGroup(groups, query) {
  const q = (query || '').trim();
  if (!q) return { error: 'Tell me which group: a number from /groups or part of its name.' };
  if (/^\d+$/.test(q)) {
    const g = groups[Number(q) - 1];
    return g ? { group: g } : { error: `No group number ${q}. Send /groups to see the list.` };
  }
  const matches = groups.filter((g) => g.name.toLowerCase().includes(q.toLowerCase()));
  if (matches.length === 1) return { group: matches[0] };
  if (matches.length === 0) return { error: `No group matches "${q}". Send /groups to see the list.` };
  return {
    error:
      `More than one group matches "${q}":\n` +
      matches.map((g) => `- ${g.name}`).join('\n') +
      '\nUse the number from /groups instead.',
  };
}

// Works out which groups a command means: "all", several numbers ("1 3 5" or "1,3,5"),
// one number, or part of a group name.
function pickTargets(groups, query) {
  const q = (query || '').trim();
  if (!q) return { error: 'Tell me which group: all, a number from /groups, or part of its name.' };
  if (!groups.length) return { error: 'Aria is not in any groups yet.' };
  if (/^all$/i.test(q)) return { groups, all: true };
  if (/^\d+([\s,]+\d+)+$/.test(q)) {
    const picked = [];
    for (const n of q.split(/[\s,]+/)) {
      const g = groups[Number(n) - 1];
      if (!g) return { error: `No group number ${n}. Send /groups to see the list.` };
      if (!picked.includes(g)) picked.push(g);
    }
    return { groups: picked };
  }
  const { group, error } = pickGroup(groups, q);
  return error ? { error } : { groups: [group] };
}

const GROUP_HELP =
  '👥 *Group controls* (send these here, not inside the group)\n' +
  '/groups - list all groups with ON/OFF status\n' +
  '/groups on - turn ALL groups on (new groups too)\n' +
  '/groups off - turn ALL groups off (new groups too)\n' +
  '/group on <number or name> - turn one group on\n' +
  '/group off <number or name> - turn one group off\n' +
  '/group on 1 3 5 - turn several on at once (same for off)\n' +
  '/group mode mention <number, name or all> - reply only when tagged or replied to\n' +
  '/group mode all <number, name or all> - reply to every message';

// Handles group-control commands. Returns reply text, or null if not a group command.
// Only call this for PRIVATE chats, and only when the sender is the admin.
async function handleGroupCommand(sock, msg, text, isAdmin) {
  const raw = (text || '').trim();
  const t = raw.toLowerCase();
  if (!(t === '/groups' || t.startsWith('/group'))) return null;
  if (!isAdmin && !msg.key?.fromMe) return null; // ignore non-admins silently
  if (isGroup(msg.key.remoteJid)) return null; // commands work in private chat only

  let groups;
  try {
    groups = await fetchGroups(sock);
  } catch (e) {
    return '⚠️ Could not load your groups right now. Try again in a moment.';
  }

  if (t === '/groups') {
    if (!groups.length) return 'Aria is not in any groups yet.';
    return (
      groups
        .map((g, i) => {
          const s = groupConfig(g.jid);
          const status = s?.enabled ? `✅ ON (${s.mode}${s.isDefault ? ', default' : ''})` : '⛔ OFF';
          return `${i + 1}. ${g.name} - ${status}`;
        })
        .join('\n') +
      '\n\n/groups on = all on, /groups off = all off\n/group on <number> or /group off <number> = one group'
    );
  }

  // ALL groups at once: "/groups on", "/groups off", "/group on all", "/group off all"
  let m = raw.match(/^\/groups?\s+(on|off)(?:\s+all)?\s*$/i);
  if (m) {
    const on = m[1].toLowerCase() === 'on';
    if (!groups.length) return 'Aria is not in any groups yet.';
    setMany(groups, on);
    setDefault(on ? 'on' : 'off');
    return on
      ? `✅ Aria is now ON in all ${groups.length} groups (and in new groups she joins). She replies when tagged or replied to, unless a group is set to "all".`
      : `⛔ Aria is now OFF in all ${groups.length} groups (and in new groups she joins). Turn one back on with /group on <number>.`;
  }

  // One group, or several: "/group on 3", "/group on 1 3 5", "/group off media"
  if ((m = raw.match(/^\/group\s+(on|off)\s+(.+)$/i))) {
    const on = m[1].toLowerCase() === 'on';
    const { groups: picked, error } = pickTargets(groups, m[2]);
    if (error) return error;
    setMany(picked, on);
    const names = picked.map((g) => `"${g.name}"`).join(', ');
    return on ? `✅ Aria is now ON in ${names}.` : `⛔ Aria is now OFF in ${names}.`;
  }

  if ((m = raw.match(/^\/group\s+mode\s+(mention|all)\s+(.+)$/i))) {
    const mode = m[1].toLowerCase();
    const { groups: picked, error } = pickTargets(groups, m[2]);
    if (error) return error;
    setModeMany(picked, mode);
    const who = picked.length === 1 ? `"${picked[0].name}"` : `${picked.length} groups`;
    return mode === 'mention'
      ? `${who}: replies only when tagged or replied to.`
      : `${who}: replies to every message.`;
  }

  return GROUP_HELP;
}

module.exports = {
  initGroupStore,
  isGroup,
  isGroupAllowed,
  shouldReplyInGroup,
  handleGroupCommand,
  GROUP_HELP,
};