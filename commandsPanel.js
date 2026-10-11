// Panel komend: lista komend z formularzami, wyszukiwarka członków i wykonanie komendy z poziomu strony.
// Dostęp: High Command, Command, Medium Command i Command FTD (sprawdzane na wybranym serwerze) + właściciel bota.
import { discordRequest } from './shared.js';
import { COMMAND_DEFS, channelKeyFor, getCommandDef, runFactionCommand, validateCommandInput } from './commands.js';
import { staffRoleIds } from './staff.js';

const ALLOWED_GROUPS = ['high_command', 'command', 'medium_command', 'command_ftd'];
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

export function registerCommandRoutes(app, { serverConfigs, getGuildInfo, botOwnerId, deps, express }) {
  const DEFAULT_GUILD = (process.env.STAFF_GUILD_ID || '1344364720605499442').trim();
  const lastRun = new Map();

  async function canRunIn(user, guildId) {
    if (botOwnerId && user.id === botOwnerId) return true;
    const cfg = serverConfigs[guildId];
    if (!cfg) return false;
    try {
      const member = await getMember(guildId, user.id);
      if (!member) return false;
      const groups = staffRoleIds(cfg, guildId);
      return ALLOWED_GROUPS.some((g) => (groups[g] || []).some((id) => member.roles.includes(id)));
    } catch (error) {
      console.error('[panel komendy] sprawdzanie roli:', error.message);
      return false;
    }
  }

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
      if (!guilds.length) return res.status(403).json({ ok: false, error: 'Komendy są dostępne dla High Command, Command, Medium Command i Command FTD.' });
      const requested = String(req.query.guild || '');
      const guildId = (guilds.find((g) => g.id === requested) || guilds.find((g) => g.id === DEFAULT_GUILD) || guilds[0]).id;
      const cfg = serverConfigs[guildId];

      const roles = (await getRoles(guildId)).filter((r) => r.id !== guildId && !r.managed).sort((a, b) => b.position - a.position)
        .map((r) => ({ id: r.id, name: r.name, color: hex(r.color) }));

      const commands = await Promise.all(COMMAND_DEFS.map(async (def) => {
        const channelId = cfg.CHANNELS?.[channelKeyFor(def.name)];
        const configured = Boolean(channelId) && !['ID', 'ID_KANALU'].includes(channelId);
        return { ...def, configured, channelName: configured ? await getChannelName(channelId) : null };
      }));
      const groups = [...new Set(commands.map((c) => c.group))].map((label) => ({ label, commands: commands.filter((c) => c.group === label) }));
      res.json({ ok: true, guilds, guildId, groups, roles });
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
    if (!(await canRunIn(req.dashUser, guildId))) return res.status(403).json({ ok: false, error: 'Nie masz uprawnień do wysyłania komend na tym serwerze.' });

    try {
      const roleIds = new Set((await getRoles(guildId)).filter((r) => r.id !== guildId).map((r) => r.id));
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
