// Panel ticketów: lista, podgląd całej rozmowy i odpowiadanie z poziomu strony.
// Dostęp odwzorowuje Discorda — widzisz tylko kanały, które widziałbyś na serwerze (uprawnienia ról i nadpisania kanału).
import fetch from 'node-fetch';
import { getArchivedTicket, listArchivedTickets } from './logStore.js';
import { STAFF_GROUPS, staffRoleIds } from './staff.js';
import { getTicketPanelClaim, performPanelTicketAction } from './tickets.js';

const API = 'https://discord.com/api/v10';
const VIEW = 1n << 10n;
const SEND = 1n << 11n;
const ADMIN = 1n << 3n;
const ALL = (1n << 53n) - 1n;
const MAX_FILES = 3;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const BLOCKED_EXT = /\.(exe|bat|cmd|com|scr|msi|vbs|ps1|jar|js|lnk|dll)$/i;

const isId = (v) => /^\d{5,25}$/.test(String(v));
const snowTime = (id) => Number((BigInt(id) >> 22n) + 1420070400000n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexColor = (n) => (n ? `#${Number(n).toString(16).padStart(6, '0')}` : null);
const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) && u.length < 2000 ? u : null);
const isVerifiedApplicationBot = (user) => Boolean(user?.bot && (
  String(user.id) === String(process.env.DISCORD_APPLICATION_ID || '') ||
  (Number(user.public_flags || user.flags || 0) & 0x10000) !== 0
));

const caches = new Map();
function memo(key, ttl, fn) {
  const hit = caches.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.p;
  const p = fn();
  caches.set(key, { at: Date.now(), p });
  p.catch(() => { if (caches.get(key)?.p === p) caches.delete(key); });
  return p;
}

async function api(method, pathname, body) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(`${API}${pathname}`, {
      method,
      headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 429 && attempt < 2) {
      const info = await res.json().catch(() => ({}));
      await sleep(Math.min(info.retry_after || 1, 5) * 1000);
      continue;
    }
    if (!res.ok) {
      const error = new Error(`Discord HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return res.status === 204 ? null : res.json();
  }
  return null;
}

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

const getChannels = (g) => memo(`ch:${g}`, 8000, () => api('GET', `/guilds/${g}/channels`));
const getChannel = (id) => memo(`c:${id}`, 8000, () => api('GET', `/channels/${id}`));
const getRoles = (g) => memo(`roles:${g}`, 60000, () => api('GET', `/guilds/${g}/roles`));
const getMember = (g, u) => memo(`m:${g}:${u}`, 30000, () => api('GET', `/guilds/${g}/members/${u}`).catch((e) => (e.status === 404 ? null : Promise.reject(e))));

const defaultAvatar = (id) => `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(id) >> 22n) % 6n)}.png`;
const userAvatar = (u) => (u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : defaultAvatar(u.id));

// Nazwa wyświetlana (pseudonim na serwerze > nazwa globalna > login); null gdy nie znaleziono
const getPerson = (g, uid) => memo(`u:${g}:${uid}`, 10 * 60 * 1000, async () => {
  try {
    const m = await getMember(g, uid);
    if (m?.user) return { id: uid, name: m.nick || m.user.global_name || m.user.username, avatarUrl: m.avatar ? `https://cdn.discordapp.com/guilds/${g}/users/${uid}/avatars/${m.avatar}.png?size=64` : userAvatar(m.user) };
    const u = await api('GET', `/users/${uid}`);
    return { id: uid, name: u.global_name || u.username, avatarUrl: userAvatar(u) };
  } catch {
    return null;
  }
});

function permsFor(member, roleMap, channel, guildId, ownerId, userId) {
  if (userId === ownerId) return ALL;
  let base = BigInt(roleMap.get(guildId)?.permissions || 0);
  for (const rid of member.roles) base |= BigInt(roleMap.get(rid)?.permissions || 0);
  if (base & ADMIN) return ALL;
  const ow = channel.permission_overwrites || [];
  const everyone = ow.find((o) => o.id === guildId);
  if (everyone) base = (base & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let deny = 0n;
  let allow = 0n;
  for (const o of ow) if (o.type === 0 && member.roles.includes(o.id)) { deny |= BigInt(o.deny); allow |= BigInt(o.allow); }
  base = (base & ~deny) | allow;
  const mine = ow.find((o) => o.type === 1 && o.id === userId);
  if (mine) base = (base & ~BigInt(mine.deny)) | BigInt(mine.allow);
  return base;
}

function parseTopic(channel) {
  if (typeof channel.topic !== 'string' || !channel.topic.startsWith('ticket|')) return null;
  const p = channel.topic.split('|');
  if (!isId(p[1])) return null;
  return { ownerId: p[1], typeId: p[2] || '', state: p[3] === 'closed' ? 'closed' : 'open', number: p[4] || '' };
}

function typeLabel(cfg, typeId) {
  const t = cfg?.TICKETS || {};
  for (const list of [t.COMMAND?.TYPES, t.FTD?.TYPES, t.TYPES]) {
    const hit = (list || []).find((x) => String(x.ID) === String(typeId));
    if (hit) return hit.LABEL || typeId;
  }
  return typeId || 'Ticket';
}

const MENTION_RE = /<@!?(\d{5,25})>/g;
const CHANNEL_RE = /<#(\d{5,25})>/g;

function embedTexts(m) {
  const parts = [m.content || ''];
  for (const e of m.embeds || []) parts.push(e.title, e.description, e.author?.name, e.footer?.text, ...(e.fields || []).flatMap((f) => [f.name, f.value]));
  return parts.filter(Boolean).join('\n');
}

function shapeEmbed(e) {
  return {
    type: e.type || null,
    color: hexColor(e.color),
    author: e.author ? { name: e.author.name, icon: safeUrl(e.author.icon_url) } : null,
    title: e.title || null,
    url: safeUrl(e.url),
    description: e.description || null,
    fields: (e.fields || []).slice(0, 25).map((f) => ({ name: f.name, value: f.value, inline: Boolean(f.inline) })),
    thumbnail: safeUrl(e.thumbnail?.url),
    thumbnailProxy: safeUrl(e.thumbnail?.proxy_url),
    image: safeUrl(e.image?.url),
    imageProxy: safeUrl(e.image?.proxy_url),
    video: safeUrl(e.video?.url),
    videoProxy: safeUrl(e.video?.proxy_url),
    footer: e.footer?.text || null,
    timestamp: e.timestamp || null
  };
}

async function shapeMessages(raw, guildId) {
  const [roles, channels] = await Promise.all([getRoles(guildId), getChannels(guildId)]);
  const roleMap = new Map(roles.map((r) => [r.id, r]));
  const chanNames = new Map(channels.map((c) => [c.id, c.name]));

  const userIds = new Set();
  for (const m of raw) {
    userIds.add(m.author.id);
    for (const u of m.mentions || []) userIds.add(u.id);
    for (const x of embedTexts(m).matchAll(MENTION_RE)) userIds.add(x[1]);
  }
  const people = new Map();
  await mapLimit([...userIds].slice(0, 40), 5, async (id) => { people.set(id, await getPerson(guildId, id)); });

  return raw.map((m) => {
    const nameOf = (id, fallback) => people.get(id)?.name || fallback || 'użytkownik';
    const users = {};
    for (const u of m.mentions || []) users[u.id] = nameOf(u.id, u.global_name || u.username);
    for (const x of embedTexts(m).matchAll(MENTION_RE)) users[x[1]] = nameOf(x[1]);
    const chans = {};
    for (const x of embedTexts(m).matchAll(CHANNEL_RE)) chans[x[1]] = chanNames.get(x[1]) || 'kanał';
    const roleMentions = {};
    for (const id of m.mention_roles || []) roleMentions[id] = { name: roleMap.get(id)?.name || 'rola', color: hexColor(roleMap.get(id)?.color) };
    const ref = m.referenced_message;
    return {
      id: m.id,
      type: m.type,
      timestamp: m.timestamp,
      edited: m.edited_timestamp || null,
      author: {
        id: m.author.id, name: nameOf(m.author.id, m.author.global_name || m.author.username),
        avatarUrl: people.get(m.author.id)?.avatarUrl || userAvatar(m.author), bot: Boolean(m.author.bot),
        verifiedApplication: isVerifiedApplicationBot(m.author)
      },
      content: m.content || '',
      mentions: { users, roles: roleMentions, channels: chans },
      embeds: (m.embeds || []).map(shapeEmbed),
      attachments: (m.attachments || []).map((a) => ({ id: a.id, name: a.filename, url: safeUrl(a.url), proxyUrl: safeUrl(a.proxy_url), type: a.content_type || '', size: a.size, width: a.width || null, height: a.height || null })),
      reactions: (m.reactions || []).map((r) => ({ name: r.emoji.name, id: r.emoji.id || null, animated: Boolean(r.emoji.animated), count: r.count })),
      reference: ref ? { id: ref.id, author: nameOf(ref.author.id, ref.author.global_name || ref.author.username), snippet: (ref.content || (ref.embeds?.length ? '[osadzenie]' : '[załącznik]')).slice(0, 120) } : null
    };
  });
}

export function registerTicketRoutes(app, { requireDashboardAuth, serverConfigs, getGuildInfo, botOwnerId, addDashboardLog, express }) {
  const DEFAULT_GUILD = (process.env.STAFF_GUILD_ID || '1344364720605499442').trim();
  const lastSend = new Map();

  const pickGuild = (requested) => (serverConfigs[requested] ? requested : serverConfigs[DEFAULT_GUILD] ? DEFAULT_GUILD : Object.keys(serverConfigs)[0]);

  // Zwraca funkcję sprawdzającą uprawnienia użytkownika do danego kanału
  async function accessChecker(user, guildId) {
    if (botOwnerId && user.id === botOwnerId) return () => ({ view: true, send: true });
    const [member, roles, info] = await Promise.all([getMember(guildId, user.id), getRoles(guildId), getGuildInfo(guildId, true)]);
    if (!member) return () => ({ view: false, send: false });
    const roleMap = new Map(roles.map((r) => [r.id, r]));
    return (channel) => {
      const p = permsFor(member, roleMap, channel, guildId, info?.owner_id, user.id);
      return { view: (p & VIEW) !== 0n, send: (p & SEND) !== 0n };
    };
  }

  async function ticketActionPermissions(user, guildId, channel, ticket) {
    if (botOwnerId && user.id === botOwnerId) return { isAdmin: true, isStaff: true, canClose: true, canDelete: true };
    const [member, roles, info] = await Promise.all([getMember(guildId, user.id), getRoles(guildId), getGuildInfo(guildId, true)]);
    if (!member) return { isAdmin: false, isStaff: false, canClose: false, canDelete: false };
    const roleMap = new Map(roles.map((role) => [role.id, role]));
    const requiredRoles = serverConfigs[guildId].REQUIRED_ROLE_IDS || [];
    const isAdmin = user.id === info?.owner_id || requiredRoles.some((id) => member.roles.includes(id)) ||
      Boolean(BigInt(roleMap.get(guildId)?.permissions || 0) & ADMIN) ||
      member.roles.some((id) => Boolean(BigInt(roleMap.get(id)?.permissions || 0) & ADMIN));
    const hasTicketRole = (channel.permission_overwrites || []).some((overwrite) =>
      overwrite.type === 0 && overwrite.id !== guildId && member.roles.includes(overwrite.id) &&
      (BigInt(overwrite.allow) & VIEW) !== 0n);
    const isStaff = isAdmin || hasTicketRole;
    return {
      isAdmin, isStaff,
      canClose: isStaff || user.id === ticket.ownerId,
      canDelete: serverConfigs[guildId].TICKETS?.DELETE_REQUIRES_ADMIN ? isAdmin : isStaff
    };
  }

  const fail = (res, error, fallback) => {
    console.error('[panel tickety]', error.message);
    const status = error.status === 403 ? 403 : error.status === 404 ? 404 : 502;
    res.status(status).json({ ok: false, error: error.status === 403 ? 'Bot nie ma dostępu do tego kanału (sprawdź uprawnienia: Wyświetlanie kanału i Czytanie historii).' : fallback });
  };

  // Wspólna weryfikacja: poprawne ID, kanał to ticket na skonfigurowanym serwerze, użytkownik ma do niego dostęp
  async function context(req, res) {
    const id = String(req.params.channelId || '');
    if (!isId(id)) { res.status(400).json({ ok: false, error: 'Niepoprawne ID kanału.' }); return null; }
    try {
      const channel = await getChannel(id);
      const topic = parseTopic(channel);
      if (!topic || !serverConfigs[channel.guild_id]) { res.status(404).json({ ok: false, error: 'To nie jest ticket.' }); return null; }
      const check = await accessChecker(req.dashUser, channel.guild_id);
      const access = check(channel);
      if (!access.view) { res.status(403).json({ ok: false, error: 'Nie masz dostępu do tego ticketu.' }); return null; }
      return { channel, topic, access, guildId: channel.guild_id };
    } catch (error) {
      fail(res, error, 'Nie udało się wczytać ticketu.');
      return null;
    }
  }

  const ticketInfo = async (ctx) => {
    const owner = await getPerson(ctx.guildId, ctx.topic.ownerId);
    return {
      id: ctx.channel.id, guildId: ctx.guildId, name: ctx.channel.name, state: ctx.topic.state, number: ctx.topic.number,
      typeLabel: typeLabel(serverConfigs[ctx.guildId], ctx.topic.typeId), ownerId: ctx.topic.ownerId,
      ownerName: owner?.name || 'Nieznany użytkownik', ownerAvatar: owner?.avatarUrl || defaultAvatar(ctx.topic.ownerId),
      url: `https://discord.com/channels/${ctx.guildId}/${ctx.channel.id}`
    };
  };

  app.get('/api/tickets', requireDashboardAuth, async (req, res) => {
    const guildId = pickGuild(String(req.query.guild || ''));
    try {
      const [channels, check, guilds] = await Promise.all([
        getChannels(guildId), accessChecker(req.dashUser, guildId),
        Promise.all(Object.keys(serverConfigs).map(async (id) => ({ id, name: (await getGuildInfo(id, true))?.name || id })))
      ]);
      const rows = channels.map((c) => ({ c, t: parseTopic(c) })).filter((x) => x.t && check(x.c).view)
        .sort((a, b) => snowTime(b.c.last_message_id || b.c.id) - snowTime(a.c.last_message_id || a.c.id)).slice(0, 300);
      const owners = new Map();
      await mapLimit([...new Set(rows.map((x) => x.t.ownerId))], 5, async (id) => { owners.set(id, await getPerson(guildId, id)); });
      const tickets = rows.map(({ c, t }) => ({
        id: c.id, name: c.name, number: t.number, state: t.state, typeLabel: typeLabel(serverConfigs[guildId], t.typeId),
        ownerId: t.ownerId, ownerName: owners.get(t.ownerId)?.name || 'Nieznany użytkownik', ownerAvatar: owners.get(t.ownerId)?.avatarUrl || defaultAvatar(t.ownerId),
        lastMessageId: c.last_message_id || null, lastMessageAt: new Date(snowTime(c.last_message_id || c.id)).toISOString(), createdAt: new Date(snowTime(c.id)).toISOString()
      }));
      res.json({ ok: true, guilds, guildId, tickets });
    } catch (error) {
      fail(res, error, 'Nie udało się pobrać listy ticketów.');
    }
  });

  app.get('/api/tickets/archived', requireDashboardAuth, async (req, res) => {
    const guildId = pickGuild(String(req.query.guild || ''));
    try {
      const [archives, check, guilds] = await Promise.all([
        listArchivedTickets(guildId), accessChecker(req.dashUser, guildId),
        Promise.all(Object.keys(serverConfigs).map(async (id) => ({ id, name: (await getGuildInfo(id, true))?.name || id })))
      ]);
      const visible = archives.filter((row) => check({ guild_id: guildId, permission_overwrites: row.ticket.permission_overwrites || [] }).view);
      const owners = new Map();
      await mapLimit([...new Set(visible.map((row) => row.ticket.ownerId))], 5, async (id) => { owners.set(id, await getPerson(guildId, id)); });
      const tickets = visible.map(({ ticket, deletedAt }) => ({
        id: ticket.id, name: ticket.name, number: ticket.number, state: 'deleted', typeLabel: ticket.typeLabel,
        ownerId: ticket.ownerId, ownerName: owners.get(ticket.ownerId)?.name || 'Nieznany użytkownik',
        ownerAvatar: owners.get(ticket.ownerId)?.avatarUrl || defaultAvatar(ticket.ownerId),
        lastMessageAt: ticket.lastMessageAt, createdAt: ticket.createdAt, deletedAt
      }));
      res.json({ ok: true, guilds, guildId, tickets });
    } catch (error) {
      fail(res, error, 'Nie udało się pobrać archiwum ticketów.');
    }
  });

  app.get('/api/tickets/archived/:channelId/messages', requireDashboardAuth, async (req, res) => {
    const id = String(req.params.channelId || '');
    const guildId = pickGuild(String(req.query.guild || ''));
    if (!isId(id)) return res.status(400).json({ ok: false, error: 'Niepoprawne ID ticketu.' });
    try {
      const archive = await getArchivedTicket(id, guildId);
      if (!archive) return res.status(404).json({ ok: false, error: 'Nie znaleziono ticketu w archiwum.' });
      const check = await accessChecker(req.dashUser, guildId);
      if (!check({ guild_id: guildId, permission_overwrites: archive.ticket.permission_overwrites || [] }).view) {
        return res.status(403).json({ ok: false, error: 'Nie masz dostępu do tego ticketu.' });
      }
      const raw = archive.messages || [];
      const before = isId(req.query.before) ? raw.findIndex((message) => message.id === req.query.before) : -1;
      const end = before >= 0 ? before : raw.length;
      const start = Math.max(0, end - (before ? 100 : 60));
      const messages = await shapeMessages(raw.slice(start, end), guildId);
      const owner = await getPerson(guildId, archive.ticket.ownerId);
      res.json({
        ok: true,
        ticket: {
          id: archive.ticket.id, guildId, name: archive.ticket.name, state: 'deleted', number: archive.ticket.number,
          typeLabel: archive.ticket.typeLabel, ownerId: archive.ticket.ownerId, ownerName: owner?.name || 'Nieznany użytkownik',
          ownerAvatar: owner?.avatarUrl || defaultAvatar(archive.ticket.ownerId), deletedAt: archive.deletedAt, archived: true
        },
        canSend: false, messages, hasOlder: start > 0, contentHidden: false
      });
    } catch (error) {
      fail(res, error, 'Nie udało się wczytać ticketu z archiwum.');
    }
  });

  app.get('/api/tickets/:channelId/profile/:userId', requireDashboardAuth, async (req, res) => {
    const channelId = String(req.params.channelId || '');
    const userId = String(req.params.userId || '');
    const requestedGuild = String(req.query.guild || '');
    if (!isId(channelId) || !isId(userId)) return res.status(400).json({ ok: false, error: 'Niepoprawne ID.' });

    let guildId;
    let overwrites;
    if (req.query.archived === 'true') {
      guildId = pickGuild(requestedGuild);
      const archive = await getArchivedTicket(channelId, guildId);
      if (!archive) return res.status(404).json({ ok: false, error: 'Nie znaleziono ticketu w archiwum.' });
      overwrites = archive.ticket.permission_overwrites || [];
      const check = await accessChecker(req.dashUser, guildId);
      if (!check({ guild_id: guildId, permission_overwrites: overwrites }).view) {
        return res.status(403).json({ ok: false, error: 'Nie masz dostępu do tego ticketu.' });
      }
    } else {
      const ctx = await context(req, res);
      if (!ctx) return;
      guildId = ctx.guildId;
    }

    try {
      const [member, roles] = await Promise.all([getMember(guildId, userId), getRoles(guildId)]);
      const user = member?.user || await api('GET', `/users/${userId}`).catch(() => null);
      if (!user) return res.status(404).json({ ok: false, error: 'Nie znaleziono profilu użytkownika.' });
      const roleMap = new Map(roles.map((role) => [role.id, role]));
      const memberRoleIds = member?.roles || [];
      const staffIds = new Set(Object.values(staffRoleIds(serverConfigs[guildId], guildId)).flat());
      const profileRoles = memberRoleIds.map((id) => roleMap.get(id)).filter(Boolean).sort((a, b) => b.position - a.position)
        .map((role) => ({ id: role.id, name: role.name, color: hexColor(role.color), staff: staffIds.has(role.id) }));
      const group = STAFF_GROUPS.find((candidate) => staffRoleIds(serverConfigs[guildId], guildId)[candidate.key]?.some((id) => memberRoleIds.includes(id)))
        || { key: 'member', label: 'Użytkownik' };
      const avatarUrl = member?.avatar
        ? `https://cdn.discordapp.com/guilds/${guildId}/users/${userId}/avatars/${member.avatar}.png?size=128`
        : userAvatar(user);
      res.json({
        ok: true,
        member: {
          id: userId, name: member?.nick || user.global_name || user.username, username: user.username,
          nick: member?.nick || null, avatarUrl,
          bot: Boolean(user.bot), verifiedApplication: isVerifiedApplicationBot(user),
          color: profileRoles.find((role) => role.color)?.color || null,
          roles: profileRoles, joinedAt: member?.joined_at || null,
          createdAt: new Date(snowTime(userId)).toISOString()
        },
        group
      });
    } catch (error) {
      fail(res, error, 'Nie udało się wczytać profilu użytkownika.');
    }
  });

  app.get('/api/tickets/:channelId/actions', requireDashboardAuth, async (req, res) => {
    const ctx = await context(req, res);
    if (!ctx) return;
    try {
      const permissions = await ticketActionPermissions(req.dashUser, ctx.guildId, ctx.channel, ctx.topic);
      const isOpen = ctx.topic.state === 'open';
      const isClosed = ctx.topic.state === 'closed';
      const { claimedBy } = isOpen && permissions.isStaff ? await getTicketPanelClaim(ctx.channel.id) : { claimedBy: null };
      res.json({
        ok: true, state: ctx.topic.state, claimedBy,
        canClose: isOpen && permissions.canClose,
        canClaim: isOpen && permissions.isStaff && !claimedBy,
        canUnclaim: isOpen && permissions.isStaff && Boolean(claimedBy) && (permissions.isAdmin || claimedBy === req.dashUser.id),
        canReopen: isClosed && permissions.isStaff,
        canDelete: isClosed && permissions.canDelete
      });
    } catch (error) {
      fail(res, error, 'Nie udało się pobrać dostępnych akcji ticketu.');
    }
  });

  app.get('/api/tickets/:channelId/messages', requireDashboardAuth, async (req, res) => {
    const ctx = await context(req, res);
    if (!ctx) return;
    try {
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 100);
      const before = isId(req.query.before) ? `&before=${req.query.before}` : '';
      const raw = await api('GET', `/channels/${ctx.channel.id}/messages?limit=${limit}${before}`);
      raw.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      const messages = await shapeMessages(raw, ctx.guildId);
      messages.forEach((message, index) => {
        message.mine = message.author.id === req.dashUser.id;
        message.panelReply = (raw[index].embeds || []).some((embed) => embed.footer?.text === 'Odpowiedź z panelu');
      });
      const hidden = raw.filter((m) => !m.author.bot && !m.content && !m.embeds?.length && !m.attachments?.length && !m.sticker_items?.length && m.type === 0).length;
      res.json({ ok: true, ticket: await ticketInfo(ctx), canSend: ctx.access.send, messages, hasOlder: raw.length === limit, contentHidden: hidden > 0 });
    } catch (error) {
      fail(res, error, 'Nie udało się pobrać wiadomości.');
    }
  });

  app.post('/api/tickets/:channelId/actions', requireDashboardAuth, (req, res, next) => {
    const origin = req.headers.origin;
    const base = (process.env.DASHBOARD_BASE_URL || '').trim();
    if (origin && base) { try { if (origin !== new URL(base.startsWith('http') ? base : `https://${base}`).origin) return res.status(403).json({ ok: false, error: 'Niedozwolone źródło żądania.' }); } catch { /* pomijamy */ } }
    next();
  }, express.json({ limit: '2kb' }), async (req, res) => {
    const ctx = await context(req, res);
    if (!ctx) return;
    const action = String(req.body?.action || '');
    if (!['close', 'claim', 'unclaim', 'reopen', 'delete'].includes(action)) {
      return res.status(400).json({ ok: false, error: 'Nieznana akcja ticketu.' });
    }
    try {
      const permissions = await ticketActionPermissions(req.dashUser, ctx.guildId, ctx.channel, ctx.topic);
      const allowed = action === 'close' ? permissions.canClose :
        action === 'delete' ? permissions.canDelete : permissions.isStaff;
      if (!allowed) return res.status(403).json({ ok: false, error: 'Nie masz uprawnień do tej akcji.' });

      const result = await performPanelTicketAction({
        action, guildConfig: serverConfigs[ctx.guildId], guildId: ctx.guildId, channelId: ctx.channel.id,
        actorId: req.dashUser.id, actorName: req.dashUser.name, appId: process.env.DISCORD_APPLICATION_ID,
        isAdmin: permissions.isAdmin, reason: String(req.body?.reason || '').slice(0, 500)
      });
      const actionLabels = { close: 'zamknął', claim: 'przejął', unclaim: 'oddał', reopen: 'otworzył ponownie', delete: 'usunął' };
      addDashboardLog('info', `Panel: ${req.dashUser.name} ${actionLabels[action]} ticket #${ctx.channel.name}.`, { source: 'server', guildId: ctx.guildId });
      res.json({ ok: true, ...result });
    } catch (error) {
      console.error('[panel tickety] akcja:', error.message);
      res.status(400).json({ ok: false, error: error.message || 'Nie udało się wykonać akcji.' });
    }
  });

  app.post('/api/tickets/:channelId/messages', requireDashboardAuth, (req, res, next) => {
    const origin = req.headers.origin;
    const base = (process.env.DASHBOARD_BASE_URL || '').trim();
    if (origin && base) { try { if (origin !== new URL(base.startsWith('http') ? base : `https://${base}`).origin) return res.status(403).json({ ok: false, error: 'Niedozwolone źródło żądania.' }); } catch { /* pomijamy */ } }
    next();
  }, express.json({ limit: '28mb' }), async (req, res) => {
    const ctx = await context(req, res);
    if (!ctx) return;
    if (!ctx.access.send) return res.status(403).json({ ok: false, error: 'Nie masz uprawnień do pisania w tym tickecie.' });

    const text = String(req.body?.content || '').trim().slice(0, 4000);
    const files = [];
    for (const f of Array.isArray(req.body?.files) ? req.body.files.slice(0, MAX_FILES) : []) {
      const name = String(f?.name || 'plik').split(/[\\/]/).pop().replace(/[^\w.\- ()[\]]/g, '_').slice(0, 100) || 'plik';
      if (BLOCKED_EXT.test(name)) return res.status(400).json({ ok: false, error: `Niedozwolony typ pliku: ${name}` });
      const buffer = Buffer.from(String(f?.data || ''), 'base64');
      if (!buffer.length || buffer.length > MAX_FILE_BYTES) return res.status(400).json({ ok: false, error: `Plik ${name} jest pusty lub większy niż 8 MB.` });
      files.push({ name, type: String(f?.type || 'application/octet-stream').slice(0, 100), buffer });
    }
    if (!text && !files.length) return res.status(400).json({ ok: false, error: 'Wiadomość jest pusta.' });

    const now = Date.now();
    if (now - (lastSend.get(req.dashUser.id) || 0) < 700) return res.status(429).json({ ok: false, error: 'Zwolnij — wysyłasz zbyt szybko.' });
    lastSend.set(req.dashUser.id, now);

    const ping = req.body?.pingOwner === true;
    const { id, name, avatar } = req.dashUser;
    const containsGifLink = /https?:\/\/[^\s<]*(?:\.gif(?:[?#][^\s<]*)?|tenor\.com\/view\/[^\s<]*|giphy\.com\/(?:gifs|clips)\/[^\s<]*)/i.test(text);
    const containsGifFile = files.some((file) => /^image\/gif$/i.test(file.type) || /\.gif$/i.test(file.name));
    const useNativeGifPreview = containsGifLink || containsGifFile;
    const payload = {
      ...((ping || useNativeGifPreview) ? { content: [ping ? `<@${ctx.topic.ownerId}>` : '', useNativeGifPreview ? text : ''].filter(Boolean).join('\n') } : {}),
      embeds: useNativeGifPreview ? [] : [{ author: { name: String(name).slice(0, 256), icon_url: avatar ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.png?size=64` : defaultAvatar(id) }, description: text || undefined, color: 0x3b82f6, footer: { text: 'Odpowiedź z panelu' } }],
      allowed_mentions: ping ? { users: [ctx.topic.ownerId] } : { parse: [] }
    };
    try {
      let sentMessage;
      if (files.length) {
        const form = new FormData();
        form.append('payload_json', JSON.stringify({ ...payload, attachments: files.map((f, i) => ({ id: i, filename: f.name })) }));
        files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.buffer], { type: f.type }), f.name));
        const r = await globalThis.fetch(`${API}/channels/${ctx.channel.id}/messages`, { method: 'POST', headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }, body: form });
        if (!r.ok) throw Object.assign(new Error(`Discord HTTP ${r.status}`), { status: r.status });
        sentMessage = await r.json().catch(() => null);
      } else {
        sentMessage = await api('POST', `/channels/${ctx.channel.id}/messages`, payload);
      }
      addDashboardLog('info', `Panel: ${name} odpowiedział w tickecie #${ctx.channel.name}.`, { source: 'server', guildId: ctx.guildId });
      res.json({ ok: true, messageId: sentMessage?.id || null });
    } catch (error) {
      console.error('[panel tickety] wysyłanie:', error.message);
      res.status(502).json({ ok: false, error: error.status === 403 ? 'Bot nie może pisać w tym kanale (brak uprawnienia Wysyłanie wiadomości).' : 'Nie udało się wysłać wiadomości.' });
    }
  });
}
