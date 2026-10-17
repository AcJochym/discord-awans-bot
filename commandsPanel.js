// Panel komend: lista komend z formularzami, wyszukiwarka członków i wykonanie komendy z poziomu strony.
// Dostęp: High Command, Command, Medium Command i Command FTD (sprawdzane na wybranym serwerze) + właściciel bota.
import { discordRequest } from './shared.js';
import { ALL_COMMAND_GROUPS, COMMAND_DEFS, allowedCommandGroups, channelKeyFor, getCommandDef, rankKeysFor, runFactionCommand, validateCommandInput } from './commands.js';

// Stopnie dostępne w /awans i /degradacja (kolejność = hierarchia). Własną listę można ustawić w konfiguracji serwera: RANK_ROLE_IDS.
const DEFAULT_RANK_ROLES = {
  '1344364720605499442': [
    '1381734918064832634', // Chief Of Police
    '1344365855563190313', // Assistant Chief Of Police
    '1344367095424614550', // Commander
    '1344367652851683530', // Captain
    '1344368020830814271', // Lieutenant
    '1344368260082307174', // Sergeant II
    '1344368586151563314', // Sergeant
    '1519781307792756736', // Sekretarka
    '1344368776233095209', // Police Officer III+1
    '1344369080240443483', // Police Officer III
    '1344369418440020029', // Police Officer II
    '1344369742177239121', // Police Officer I
    '1344370056481603657' // Recruit
  ]
};

const caches = new Map();

function memo(key, ttl, fn) {
  const hit = caches.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.p;
  const p = fn();
  caches.set(key, { at: Date.now(), p });
  p.catch(() => { if (caches.get(key)?.p === p) caches.delete(key); });
  return p;
}

const getMember = (g, u) => memo(`m:${g}:${u}`, 30_000, () => discordRequest('GET', `/guilds/${g}/members/${u}`).catch((e) => (e.status === 404 ? null : Promise.reject(e))));
const getRoles = (g) => memo(`roles:${g}`, 60_000, () => discordRequest('GET', `/guilds/${g}/roles`));
const getChannelName = (id) => memo(`c:${id}`, 5 * 60_000, () => discordRequest('GET', `/channels/${id}`).then((c) => c.name).catch(() => null));

const defaultAvatar = (id) => `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(id) >> 22n) % 6n)}.png`;
const hex = (n) => (n ? `#${Number(n).toString(16).padStart(6, '0')}` : null);

function memberView(guildId, m) {
  const u = m.user;
  return {
    id: u.id,
    name: m.nick || u.global_name || u.username,
    username: u.username,
    avatarUrl: m.avatar
      ? `https://cdn.discordapp.com/guilds/${guildId}/users/${u.id}/avatars/${m.avatar}.png?size=64`
      : u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : defaultAvatar(u.id)
  };
}

// Role-stopnie dla danego serwera: lista z konfiguracji/domyślna (w kolejności hierarchii) albo — gdy jej brak — wszystkie zwykłe role
function rankRoles(cfg, guildId, allRoles) {
  const usable = allRoles.filter((r) => r.id !== guildId && !r.managed);
  const configured = (Array.isArray(cfg.RANK_ROLE_IDS) ? cfg.RANK_ROLE_IDS : DEFAULT_RANK_ROLES[guildId] || []).map(String).filter((id) => /^\d{5,25}$/.test(id));
  if (!configured.length) return usable.sort((a, b) => b.position - a.position);
  const byId = new Map(usable.map((r) => [r.id, r]));
  return configured.map((id) => byId.get(id)).filter(Boolean);
}

// ───────── Wyszukiwarka członków ─────────
// Discord szuka tylko po początku nicku, więc "[109] Aiden Walker" nie znajdzie się po "Aiden" ani "109".
// Dlatego pobieramy listę członków (cache 2 min) i szukamy sami: dowolny fragment, wiele słów, bez polskich znaków i nawiasów.
const norm = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/gi, 'l').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function loadDirectory(guildId) {
  const out = [];
  let after = '0';
  for (let i = 0; i < 10; i += 1) {
    const page = await discordRequest('GET', `/guilds/${guildId}/members?limit=1000&after=${after}`);
    out.push(...page);
    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
  }
  return out.filter((m) => m.user && !m.user.bot).map((m) => {
    const view = memberView(guildId, m);
    const hay = norm([m.nick, m.user.global_name, m.user.username].filter(Boolean).join(' '));
    return { view, hay, words: hay.split(' '), primary: norm(view.name) };
  });
}

export function searchDirectory(directory, query) {
  const raw = String(query || '').trim();
  const tokens = norm(raw).split(' ').filter(Boolean);
  if (!tokens.length) return [];
  const byId = /^\d{5,}$/.test(raw);
  const scored = [];
  for (const entry of directory) {
    if (byId && entry.view.id.startsWith(raw)) { scored.push([100, entry]); continue; }
    let score = 0;
    let matches = true;
    for (const token of tokens) {
      if (entry.words.includes(token)) score += 4;                          // całe słowo
      else if (entry.words.some((word) => word.startsWith(token))) score += 3; // początek słowa
      else if (entry.hay.includes(token)) score += 1;                       // fragment w środku
      else { matches = false; break; }
    }
    if (!matches) continue;
    if (entry.primary.startsWith(tokens.join(' '))) score += 2;
    scored.push([score, entry]);
  }
  return scored.sort((a, b) => b[0] - a[0] || a[1].view.name.localeCompare(b[1].view.name, 'pl')).slice(0, 8).map(([, entry]) => entry.view);
}

export function registerCommandRoutes(app, { serverConfigs, getGuildInfo, botOwnerId, deps, express }) {
  const DEFAULT_GUILD = (process.env.STAFF_GUILD_ID || '1344364720605499442').trim();
  const lastRun = new Map();

  // Sekcje komend dostępne dla użytkownika na danym serwerze (puste = brak dostępu). Zależą od rangi na Discordzie.
  async function groupsFor(user, guildId) {
    if (botOwnerId && user.id === botOwnerId) return new Set(ALL_COMMAND_GROUPS);
    const cfg = serverConfigs[guildId];
    if (!cfg) return new Set();
    try {
      const member = await getMember(guildId, user.id);
      return member ? allowedCommandGroups(rankKeysFor(member.roles, cfg, guildId)) : new Set();
    } catch (error) {
      console.error('[panel komendy] sprawdzanie roli:', error.message);
      return new Set();
    }
  }

  const canRunIn = async (user, guildId) => (await groupsFor(user, guildId)).size > 0;

  async function allowedGuilds(user) {
    const found = [];
    for (const id of Object.keys(serverConfigs)) {
      if (await canRunIn(user, id)) found.push({ id, name: (await getGuildInfo(id, true))?.name || id });
    }
    return found;
  }

  app.get('/api/commands', async (req, res) => {
    try {
      const guilds = await allowedGuilds(req.dashUser);
      if (!guilds.length) return res.status(403).json({ ok: false, error: 'Twoja ranga nie ma dostępu do komend.' });
      const requested = String(req.query.guild || '');
      const guildId = (guilds.find((g) => g.id === requested) || guilds.find((g) => g.id === DEFAULT_GUILD) || guilds[0]).id;
      const cfg = serverConfigs[guildId];
      const allowed = await groupsFor(req.dashUser, guildId);

      const roles = rankRoles(cfg, guildId, await getRoles(guildId)).map((r) => ({ id: r.id, name: r.name, color: hex(r.color) }));

      // Dane zalogowanej osoby — do automatycznego wypełnienia pól „osoba wprowadzająca" i jej stopnia
      let me = null;
      const self = await getMember(guildId, req.dashUser.id).catch(() => null);
      if (self?.user) {
        const hasRankList = Array.isArray(cfg.RANK_ROLE_IDS) || Boolean(DEFAULT_RANK_ROLES[guildId]);
        me = { ...memberView(guildId, self), rankRoleId: hasRankList ? roles.find((r) => self.roles.includes(r.id))?.id || null : null };
      }

      const commands = await Promise.all(COMMAND_DEFS.filter((def) => allowed.has(def.group)).map(async (def) => {
        const channelId = cfg.CHANNELS?.[channelKeyFor(def.name)];
        const configured = Boolean(channelId) && !['ID', 'ID_KANALU'].includes(channelId);
        return { ...def, configured, channelName: configured ? await getChannelName(channelId) : null };
      }));
      const groups = [...new Set(commands.map((c) => c.group))].map((label) => ({ label, commands: commands.filter((c) => c.group === label) }));
      res.json({ ok: true, guilds, guildId, groups, roles, me, access: [...allowed], limited: allowed.size < ALL_COMMAND_GROUPS.length });
    } catch (error) {
      console.error('[panel komendy] lista:', error.message);
      res.status(502).json({ ok: false, error: 'Nie udało się wczytać komend.' });
    }
  });

  app.get('/api/commands/members', async (req, res) => {
    const guildId = String(req.query.guild || '');
    const q = String(req.query.q || '').trim().slice(0, 32);
    if (!(await canRunIn(req.dashUser, guildId))) return res.status(403).json({ ok: false, error: 'forbidden' });
    if (q.length < 2) return res.json({ ok: true, members: [] });
    try {
      try {
        return res.json({ ok: true, members: searchDirectory(await memo(`dir:${guildId}`, 120_000, () => loadDirectory(guildId)), q) });
      } catch (listError) {
        console.error('[panel komendy] lista członków niedostępna, szukam po początku nicku:', listError.message);
      }
      const found = await memo(`s:${guildId}:${q.toLowerCase()}`, 20_000, () => discordRequest('GET', `/guilds/${guildId}/members/search?query=${encodeURIComponent(q)}&limit=8`));
      res.json({ ok: true, members: found.filter((m) => m.user && !m.user.bot).map((m) => memberView(guildId, m)) });
    } catch (error) {
      console.error('[panel komendy] szukanie członków:', error.message);
      res.status(502).json({ ok: false, error: 'Nie udało się wyszukać użytkowników. Sprawdź, czy „Server Members Intent" jest włączony.' });
    }
  });

  app.post('/api/commands/run', express.json({ limit: '20kb' }), async (req, res) => {
    const body = req.body || {};
    const guildId = String(body.guild || '');
    const def = getCommandDef(String(body.command || ''));
    if (!def || !serverConfigs[guildId]) return res.status(400).json({ ok: false, error: 'Nieznana komenda lub serwer.' });
    const allowedGroups = await groupsFor(req.dashUser, guildId);
    if (!allowedGroups.size) return res.status(403).json({ ok: false, error: 'Nie masz uprawnień do wysyłania komend na tym serwerze.' });
    if (!allowedGroups.has(def.group)) return res.status(403).json({ ok: false, error: `Twoja ranga nie ma dostępu do komend z sekcji „${def.group}”.` });

    try {
      const roleIds = new Set(rankRoles(serverConfigs[guildId], guildId, await getRoles(guildId)).map((r) => r.id));
      const { opts, errors } = validateCommandInput(def, body.values, { roleIds });
      for (const field of def.fields.filter((x) => x.type === 'user' && opts[x.key])) {
        if (!(await getMember(guildId, opts[field.key]))) errors.push({ field: field.key, message: 'Nie znaleziono tego użytkownika na serwerze.' });
      }
      if (errors.length) return res.status(422).json({ ok: false, error: 'Popraw zaznaczone pola.', errors });

      const now = Date.now();
      if (now - (lastRun.get(req.dashUser.id) || 0) < 1500) return res.status(429).json({ ok: false, error: 'Zwolnij — poczekaj chwilę przed kolejną komendą.' });
      lastRun.set(req.dashUser.id, now);

      const result = await runFactionCommand(def.name, opts, { guildId, guildConfig: serverConfigs[guildId], userId: req.dashUser.id, channelId: null, via: 'panel' }, deps);
      if (!result.ok) return res.status(502).json({ ok: false, error: result.message });
      res.json({ ok: true, message: `Komenda /${def.name} wykonana.`, channelName: await getChannelName(result.channelId) });
    } catch (error) {
      console.error('[panel komendy] wykonanie:', error.message);
      res.status(502).json({ ok: false, error: 'Nie udało się wykonać komendy. Spróbuj ponownie.' });
    }
  });
}
