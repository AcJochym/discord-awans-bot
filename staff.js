// Lista administracji pogrupowana po rangach (rolach) na serwerze Discord.
import { discordRequest, isId } from './shared.js';

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // guildId -> { at, promise }

// Kolejność = priorytet: osoba trafia do NAJWYŻSZEJ grupy, do której ma rolę.
export const STAFF_GROUPS = [
  { key: 'high_command', label: 'High Command' },
  { key: 'command', label: 'Command' },
  { key: 'medium_command', label: 'Medium Command' },
  { key: 'command_ftd', label: 'Command FTD' },
  { key: 'ftd', label: 'FTD' }
];

// Lista administracji pokazuje tylko ten serwer (można nadpisać zmienną STAFF_GUILD_ID).
const STAFF_GUILD_ID = (process.env.STAFF_GUILD_ID || '1344364720605499442').trim();

// Role grup dla serwera — używane, gdy w konfiguracji serwera nie ma "STAFF_ROLES".
export const DEFAULT_STAFF_ROLES = {
  '1344364720605499442': {
    HIGH_COMMAND: ['1505571491180314956'],
    COMMAND: ['1344373183079256064'],
    MEDIUM_COMMAND: ['1344664019751014543'],
    COMMAND_FTD: ['1344370783769722933'],
    FTD: ['1344370800354136164']
  }
};

const ids = (arr) => (Array.isArray(arr) ? arr.map(String).filter(isId) : []);

// Role grup: z "STAFF_ROLES" w konfiguracji serwera, a gdy ich brak — wyprowadzone z konfiguracji ticketów.
export function staffRoleIds(cfg = {}, guildId = '') {
  const manual = cfg.STAFF_ROLES || DEFAULT_STAFF_ROLES[guildId] || {};
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

export function ticketAccessRoleIds(cfg = {}, ticket = {}) {
  const t = cfg.TICKETS || {};
  const typeId = String(ticket.typeId || ticket.ID || '');
  const commandTypes = t.COMMAND?.TYPES || [];
  const ftdTypes = t.FTD?.TYPES || [];
  const type = [...commandTypes, ...ftdTypes, ...(t.TYPES || [])].find((item) => String(item.ID) === typeId);
  const ftdTicket = ticket.panelMode === 'ftd' || (!ticket.panelMode && ftdTypes.some((item) => String(item.ID) === typeId));
  const groups = ftdTicket
    ? [typeId === 'ftd' ? 'command_ftd' : 'ftd']
    : typeId === 'high_command' ? ['high_command']
      : typeId === 'command' ? ['high_command', 'command']
        : typeId === 'medium_command' ? ['high_command', 'command', 'medium_command']
          : [];
  const roles = staffRoleIds(cfg, String(ticket.guildId || ''));
  if (groups.length) return [...new Set(groups.flatMap((group) => roles[group] || []))];
  return ids(type?.SUPPORT_ROLE_IDS);
}

const api = (pathname) => discordRequest('GET', pathname);

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
  const groupRoles = staffRoleIds(cfg, guildId);
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
  const entries = serverConfigs[STAFF_GUILD_ID] ? [[STAFF_GUILD_ID, serverConfigs[STAFF_GUILD_ID]]] : Object.entries(serverConfigs);
  const ordered = entries
    .map(([id, cfg]) => ({ id, cfg, score: new Set(Object.values(staffRoleIds(cfg, id)).flat()).size }))
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
