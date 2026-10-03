// Lista administracji pogrupowana po rangach (rolach) na serwerze Discord.
import fetch from 'node-fetch';

const API = 'https://discord.com/api/v10';
const TTL_MS = 60 * 1000;
const cache = new Map(); // guildId -> { at, promise }

// Kolejność = priorytet: osoba trafia do NAJWYŻSZEJ grupy, do której ma rolę.
export const STAFF_GROUPS = [
  { key: 'high_command', label: 'High Command' },
  { key: 'command', label: 'Command' },
  { key: 'medium_command', label: 'Medium Command' },
  { key: 'command_ftd', label: 'Command FTD' },
  { key: 'ftd', label: 'FTD' }
];

const isId = (v) => /^\d{5,25}$/.test(String(v));
const ids = (arr) => (Array.isArray(arr) ? arr.map(String).filter(isId) : []);

// Role grup: z "STAFF_ROLES" w konfiguracji serwera, a gdy ich brak — wyprowadzone z konfiguracji ticketów.
export function staffRoleIds(cfg = {}) {
  const manual = cfg.STAFF_ROLES || {};
  const cmd = cfg.TICKETS?.COMMAND?.TYPES || [];
  const ftd = cfg.TICKETS?.FTD?.TYPES || [];
  const of = (types, id) => ids(types.find((t) => t.ID === id)?.SUPPORT_ROLE_IDS);
  const derived = {
    high_command: of(cmd, 'high_command'),
    command: of(cmd, 'command'),
    medium_command: of(cmd, 'medium_command'),
    command_ftd: of(ftd, 'ftd').slice(0, 1),
    ftd: of(ftd, 'neg').slice(0, 1)
  };
  const out = {};
  for (const g of STAFF_GROUPS) {
    const own = ids(manual[g.key.toUpperCase()]);
    out[g.key] = own.length ? own : derived[g.key];
  }
  return out;
}

async function api(pathname) {
  const res = await fetch(`${API}${pathname}`, { headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` } });
  if (!res.ok) {
    const error = new Error(`Discord HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

async function allMembers(guildId) {
  const out = [];
  let after = '0';
  for (let i = 0; i < 10; i += 1) {
    const page = await api(`/guilds/${guildId}/members?limit=1000&after=${after}`);
    out.push(...page);
    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
  }
  return out;
}

const createdAt = (id) => new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString();
const hex = (n) => (n ? `#${n.toString(16).padStart(6, '0')}` : null);

async function load(guildId, cfg, getGuildInfo) {
  const [members, roles, info] = await Promise.all([allMembers(guildId), api(`/guilds/${guildId}/roles`), getGuildInfo(guildId, true)]);
  const roleMap = new Map(roles.map((r) => [r.id, r]));
  const groupRoles = staffRoleIds(cfg);
  const staffIds = new Set(Object.values(groupRoles).flat());
  const groups = STAFF_GROUPS.map((g) => ({ key: g.key, label: g.label, members: [] }));

  for (const m of members) {
    if (!m.user || m.user.bot) continue;
    const idx = STAFF_GROUPS.findIndex((g) => groupRoles[g.key].some((id) => m.roles.includes(id)));
    if (idx < 0) continue;
    const u = m.user;
    const memberRoles = m.roles.map((id) => roleMap.get(id)).filter(Boolean).sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name, color: hex(r.color), staff: staffIds.has(r.id) }));
    groups[idx].members.push({
      id: u.id,
      name: m.nick || u.global_name || u.username,
      username: u.username,
      nick: m.nick || null,
      avatarUrl: m.avatar
        ? `https://cdn.discordapp.com/guilds/${guildId}/users/${u.id}/avatars/${m.avatar}.png?size=128`
        : u.avatar
          ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128`
          : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(u.id) >> 22n) % 6n)}.png`,
      color: memberRoles.find((r) => r.color)?.color || null,
      roles: memberRoles,
      joinedAt: m.joined_at || null,
      createdAt: createdAt(u.id)
    });
  }
  groups.forEach((g) => g.members.sort((a, b) => a.name.localeCompare(b.name, 'pl', { sensitivity: 'base' })));
  return { guildId, guildName: info?.name || 'Nieznany serwer', groups, total: groups.reduce((s, g) => s + g.members.length, 0), updatedAt: new Date().toISOString() };
}

export async function getStaff(serverConfigs, requestedId, getGuildInfo) {
  const ordered = Object.entries(serverConfigs)
    .map(([id, cfg]) => ({ id, cfg, score: new Set(Object.values(staffRoleIds(cfg)).flat()).size }))
    .sort((a, b) => b.score - a.score); // serwery z najbardziej zróżnicowanymi rolami na górze (domyślny wybór)
  if (!ordered.length) throw Object.assign(new Error('Brak serwerów w konfiguracji'), { guilds: [] });

  const guilds = await Promise.all(ordered.map(async (e) => ({ id: e.id, name: (await getGuildInfo(e.id, true))?.name || e.id })));
  const pick = ordered.find((e) => e.id === requestedId) || ordered[0];

  let entry = cache.get(pick.id);
  if (!entry || Date.now() - entry.at > TTL_MS) {
    entry = { at: Date.now(), promise: load(pick.id, pick.cfg, getGuildInfo) };
    cache.set(pick.id, entry);
    entry.promise.catch(() => cache.delete(pick.id));
  }
  try {
    return { ...(await entry.promise), guilds };
  } catch (error) {
    error.guilds = guilds;
    error.guildId = pick.id;
    throw error;
  }
}
