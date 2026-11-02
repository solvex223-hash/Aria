// groupControl.js - lets the admin control which WhatsApp groups Aria replies in.
// Commands are sent from the admin's private chat with the bot (not inside groups).
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'groups.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return {}; }
}

function save(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

const clean = (j) => (j || '').split(':')[0].split('@')[0];
const isGroup = (jid) => typeof jid === 'string' && jid.endsWith('@g.us');

function isGroupAllowed(jid) {
  return !!load()[jid]?.enabled;
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

// Should Aria reply to this message in an allowed group?
// botIds: pass [sock.user?.id, sock.user?.lid]
function shouldReplyInGroup(msg, botIds) {
  if (msg.key?.fromMe) return false; // never reply to own messages

  const jid = msg.key.remoteJid;
  const g = load()[jid];
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

const GROUP_HELP =
  '👥 *Group controls* (send these here, not inside the group)\n' +
  '/groups - list all groups with ON/OFF status\n' +
  '/group on <number or name> - Aria replies in that group\n' +
  '/group off <number or name> - Aria stops replying there\n' +
  '/group mode mention <number or name> - reply only when tagged or replied to\n' +
  '/group mode all <number or name> - reply to every message';

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

  const saved = load();

  if (t === '/groups') {
    if (!groups.length) return 'Aria is not in any groups yet.';
    return (
      groups
        .map((g, i) => {
          const s = saved[g.jid];
          const status = s?.enabled ? `✅ ON (${s.mode})` : '⛔ OFF';
          return `${i + 1}. ${g.name} - ${status}`;
        })
        .join('\n') + '\n\nTurn one on with: /group on <number>'
    );
  }

  let m;
  if ((m = raw.match(/^\/group\s+on\s+(.+)$/i))) {
    const { group, error } = pickGroup(groups, m[1]);
    if (error) return error;
    setGroup(group.jid, true, group.name);
    return `✅ Aria is now ON in "${group.name}" (mode: ${load()[group.jid].mode}).`;
  }

  if ((m = raw.match(/^\/group\s+off\s+(.+)$/i))) {
    const { group, error } = pickGroup(groups, m[1]);
    if (error) return error;
    setGroup(group.jid, false, group.name);
    return `⛔ Aria is now OFF in "${group.name}".`;
  }

  if ((m = raw.match(/^\/group\s+mode\s+(mention|all)\s+(.+)$/i))) {
    const mode = m[1].toLowerCase();
    const { group, error } = pickGroup(groups, m[2]);
    if (error) return error;
    setMode(group.jid, mode, group.name);
    return mode === 'mention'
      ? `"${group.name}": replies only when tagged or replied to.`
      : `"${group.name}": replies to every message.`;
  }

  return GROUP_HELP;
}

module.exports = {
  isGroup,
  isGroupAllowed,
  shouldReplyInGroup,
  handleGroupCommand,
  GROUP_HELP,
};