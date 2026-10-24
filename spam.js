// System antyspamowy oparty na kanałach-pułapkach.
// Każda wiadomość zwykłego użytkownika na monitorowanym kanale = wyciszenie na maksymalny czas (28 dni, odnawiane)
// + usunięcie jego wiadomości z ostatnich 5 minut na całym serwerze. Administracja decyduje w panelu: Perm ban albo Odblokuj.
import { UserError, discordRequest, fetch as httpFetch, isId, snowTime } from './shared.js';
import { getPool, onDatabaseReady, storageMode } from './logStore.js';
import { staffRoleIds } from './staff.js';

// Rol­a sekretarki (nigdy nie karana) — stała dla serwera LSPD, nadpisywana przez SPAM_EXEMPT_ROLE_IDS w konfiguracji
const SECRETARY_ROLE_IDS = ['1519781307792756736'];

// Kanały-pułapki (można nadpisać w konfiguracji serwera: SPAM_CHANNEL_IDS; wyjątki rolowe: SPAM_EXEMPT_ROLE_IDS)
const DEFAULT_SPAM_CHANNELS = ['1560984351825592341', '1560984427939496076'];   // LSPD midway.gg, FTD
const MAX_TIMEOUT_MS = 28 * 24 * 3600 * 1000 - 3600 * 1000;   // limit Discorda to 28 dni
const RENEW_BELOW_MS = 14 * 24 * 3600 * 1000;
const DELETE_WINDOW_MS = 5 * 60 * 1000;
const TRACK_WINDOW_MS = 10 * 60 * 1000;
const RETENTION_DAYS = Math.max(1, Number.parseInt(process.env.SPAM_RETENTION_DAYS, 10) || 180);
export const NOTICE_TITLE = '🚫 KANAŁ MONITOROWANY';

export const spamChannelIds = (cfg = {}) => (Array.isArray(cfg.SPAM_CHANNEL_IDS) ? cfg.SPAM_CHANNEL_IDS : DEFAULT_SPAM_CHANNELS).map(String).filter(isId);

// ───────── Wykrywanie ─────────
export const INVITE_RE = /(?:discord(?:app)?\.com\/invite|discord\.gg|discord\.me|dsc\.gg|invite\.gg)\/[\w-]+/i;

// Powody zgłoszenia: trap = sam fakt napisania w kanale-pułapce; reszta opisuje, co to było
export function spamReasons({ content = '', attachments = 0, mentionsEveryone = false } = {}) {
  const reasons = ['trap'];
  if (INVITE_RE.test(content)) reasons.push('invite');
  else if (/https?:\/\/|\bwww\./i.test(content)) reasons.push('link');
  if (mentionsEveryone || /@(everyone|here)\b/.test(content)) reasons.push('mass_mention');
  if (attachments > 0) reasons.push('attachment');
  return reasons;
}

// Kto nigdy nie jest karany: boty, właściciel bota i serwera, administratorzy, administracja (role z konfiguracji) i sekretarka
export function isExempt({ userId, guildId, roleIds = [], isAdmin = false, guildOwnerId = null }, cfg = {}, botOwnerId = null) {
  if (userId === botOwnerId || userId === guildOwnerId || isAdmin) return true;
  const exempt = new Set([
    ...(cfg.REQUIRED_ROLE_IDS || []), ...Object.values(staffRoleIds(cfg, guildId)).flat(),
    ...SECRETARY_ROLE_IDS, ...(cfg.SPAM_EXEMPT_ROLE_IDS || [])
  ].map(String));
  return roleIds.some((id) => exempt.has(String(id)));
}

// ───────── Ostatnie wiadomości użytkowników (tylko pamięć, ~10 minut) ─────────
const recent = new Map();   // "guild:user" -> [{ id, channelId, channelName, ts, content, attachments }]
const keyOf = (guildId, userId) => `${guildId}:${userId}`;

export function trackMessage(entry) {
  const key = keyOf(entry.guildId, entry.userId);
  const list = (recent.get(key) || []).filter((m) => entry.ts - m.ts < TRACK_WINDOW_MS && m.id !== entry.id);
  list.push({ id: entry.id, channelId: entry.channelId, channelName: entry.channelName || null, ts: entry.ts, content: String(entry.content || '').slice(0, 1500), attachments: entry.attachments || [] });
  recent.set(key, list.slice(-100));
}

export const recentMessages = (guildId, userId, sinceMs) => (recent.get(keyOf(guildId, userId)) || []).filter((m) => m.ts >= sinceMs);

function pruneRecent(now = Date.now()) {
  for (const [key, list] of recent) {
    const fresh = list.filter((m) => now - m.ts < TRACK_WINDOW_MS);
    if (fresh.length) recent.set(key, fresh); else recent.delete(key);
  }
}

// ───────── Magazyn incydentów (PostgreSQL, a gdy baza niedostępna — pamięć) ─────────
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS spam_incidents (
    id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, user_name TEXT, avatar_url TEXT,
    channel_id TEXT, channel_name TEXT, trigger_content TEXT, reasons JSONB NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'quarantined', timeout_until TIMESTAMPTZ, notes TEXT,
    deleted JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), resolved_by TEXT, resolved_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_spam_incidents_guild ON spam_incidents (guild_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_spam_incidents_user ON spam_incidents (guild_id, user_id, status);
  CREATE TABLE IF NOT EXISTS spam_notices (channel_id TEXT PRIMARY KEY, posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS spam_files (
    id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, message_id TEXT, name TEXT, content_type TEXT NOT NULL, size INT NOT NULL,
    data BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_spam_files_created ON spam_files (created_at);
`;
let schemaPromise = null;
const memoryIncidents = new Map();
const memoryNotices = new Set();
let memorySeq = 0;
const memoryFiles = new Map();
let fileSeq = 0;

// ───────── Podglądy załączników (dowody) ─────────
// Linki z Discorda wygasają, a po usunięciu wiadomości plik znika, więc obrazy zapisujemy w bazie PRZED usunięciem wiadomości.
const EVIDENCE_MAX_BYTES = 1_500_000;   // jeden podgląd
const EVIDENCE_MAX_FILES = 20;          // na jedno zgłoszenie
const CDN_HOSTS = /^(?:cdn\.discordapp\.com|media\.discordapp\.net|images-ext-\d+\.discordapp\.net)$/;   // pobieramy wyłącznie z CDN Discorda
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

// Typ obrazu rozpoznany po zawartości (nie ufamy nagłówkom ani nazwie pliku)
export function sniffImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

async function db() {
  const pool = getPool();
  if (!pool || storageMode() !== 'postgres') return null;   // baza chwilowo niedostępna — pracujemy na pamięci
  schemaPromise ||= pool.query(SCHEMA_SQL).catch((error) => { schemaPromise = null; throw error; });
  await schemaPromise;
  return pool;
}

const iso = (v) => (v ? new Date(v).toISOString() : null);
const fromRow = (r) => ({
  id: String(r.id), guildId: r.guild_id, userId: r.user_id, userName: r.user_name, avatarUrl: r.avatar_url, channelId: r.channel_id, channelName: r.channel_name,
  triggerContent: r.trigger_content, reasons: r.reasons, status: r.status, timeoutUntil: iso(r.timeout_until), notes: r.notes, deleted: r.deleted,
  createdAt: iso(r.created_at), resolvedBy: r.resolved_by, resolvedAt: iso(r.resolved_at)
});

async function insertIncident(pool, i) {
  const r = await pool.query(
    `INSERT INTO spam_incidents (guild_id, user_id, user_name, avatar_url, channel_id, channel_name, trigger_content, reasons, status, timeout_until, notes, deleted, created_at, resolved_by, resolved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [i.guildId, i.userId, i.userName, i.avatarUrl, i.channelId, i.channelName, i.triggerContent, JSON.stringify(i.reasons), i.status, i.timeoutUntil, i.notes, JSON.stringify(i.deleted), i.createdAt, i.resolvedBy || null, i.resolvedAt || null]
  );
  return fromRow(r.rows[0]);
}

async function createIncident(data) {
  const incident = { ...data, status: 'quarantined', createdAt: new Date().toISOString(), resolvedBy: null, resolvedAt: null };
  try {
    const pool = await db();
    if (pool) return await insertIncident(pool, incident);
  } catch (error) {
    console.error('[spam] zapis incydentu do bazy nie powiódł się, zapisuję w pamięci:', error.message);
  }
  const local = { ...incident, id: `m${++memorySeq}`, local: true };
  memoryIncidents.set(local.id, local);
  return local;
}

async function getIncident(id) {
  if (memoryIncidents.has(id)) return memoryIncidents.get(id);
  if (!/^\d+$/.test(id)) return null;
  const pool = await db();
  if (!pool) return null;
  const r = await pool.query('SELECT * FROM spam_incidents WHERE id = $1', [id]);
  return r.rows[0] ? fromRow(r.rows[0]) : null;
}

const COLUMNS = { status: 'status', timeoutUntil: 'timeout_until', notes: 'notes', deleted: 'deleted', reasons: 'reasons', resolvedBy: 'resolved_by', resolvedAt: 'resolved_at' };

async function updateIncident(id, patch) {
  if (memoryIncidents.has(id)) { Object.assign(memoryIncidents.get(id), patch); return memoryIncidents.get(id); }
  const pool = await db();
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(COLUMNS)) {
    if (!(key in patch)) continue;
    params.push(key === 'deleted' || key === 'reasons' ? JSON.stringify(patch[key]) : patch[key]);
    sets.push(`${column} = $${params.length}`);
  }
  if (!sets.length) return getIncident(id);
  params.push(id);
  const r = await pool.query(`UPDATE spam_incidents SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  return r.rows[0] ? fromRow(r.rows[0]) : null;
}

async function findActive(guildId, userId) {
  for (const inc of memoryIncidents.values()) if (inc.guildId === guildId && inc.userId === userId && inc.status === 'quarantined') return inc;
  try {
    const pool = await db();
    if (!pool) return null;
    const r = await pool.query("SELECT * FROM spam_incidents WHERE guild_id = $1 AND user_id = $2 AND status = 'quarantined' ORDER BY created_at DESC LIMIT 1", [guildId, userId]);
    return r.rows[0] ? fromRow(r.rows[0]) : null;
  } catch (error) {
    console.error('[spam] odczyt aktywnego incydentu:', error.message);
    return null;
  }
}

async function listIncidents(guildId, status) {
  const local = [...memoryIncidents.values()].filter((i) => i.guildId === guildId && (!status || i.status === status));
  let stored = [];
  try {
    const pool = await db();
    if (pool) {
      const r = await pool.query(`SELECT * FROM spam_incidents WHERE guild_id = $1 ${status ? 'AND status = $2' : ''} ORDER BY created_at DESC LIMIT 300`, status ? [guildId, status] : [guildId]);
      stored = r.rows.map(fromRow);
    }
  } catch (error) {
    console.error('[spam] lista incydentów:', error.message);
  }
  return [...local, ...stored].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 300);
}

async function listQuarantined() {
  const all = [...memoryIncidents.values()].filter((i) => i.status === 'quarantined');
  try {
    const pool = await db();
    if (pool) all.push(...(await pool.query("SELECT * FROM spam_incidents WHERE status = 'quarantined'")).rows.map(fromRow));
  } catch (error) {
    console.error('[spam] lista wyciszonych:', error.message);
  }
  return all;
}

// Incydenty zapisane w pamięci podczas awarii bazy trafiają do niej po jej powrocie
async function flushLocal() {
  const pool = await db();
  if (!pool) return;
  for (const [id, incident] of [...memoryIncidents]) {
    if (!incident.local) continue;
    await insertIncident(pool, incident);
    memoryIncidents.delete(id);
  }
}

async function noticePosted(channelId) {
  if (memoryNotices.has(channelId)) return true;
  try {
    const pool = await db();
    return pool ? (await pool.query('SELECT 1 FROM spam_notices WHERE channel_id = $1', [channelId])).rowCount > 0 : false;
  } catch { return false; }
}

async function markNotice(channelId) {
  memoryNotices.add(channelId);
  try {
    const pool = await db();
    if (pool) await pool.query('INSERT INTO spam_notices (channel_id) VALUES ($1) ON CONFLICT DO NOTHING', [channelId]);
  } catch (error) { console.error('[spam] zapis informacji o ostrzeżeniu:', error.message); }
}

async function saveFile(guildId, messageId, name, contentType, data) {
  try {
    const pool = await db();
    if (pool) {
      const r = await pool.query('INSERT INTO spam_files (guild_id, message_id, name, content_type, size, data) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [guildId, messageId, String(name).slice(0, 200), contentType, data.length, data]);
      return String(r.rows[0].id);
    }
  } catch (error) {
    console.error('[spam] zapis podglądu do bazy nie powiódł się, zapisuję w pamięci:', error.message);
  }
  const id = `mf${++fileSeq}`;
  memoryFiles.set(id, { guildId, contentType, data });
  if (memoryFiles.size > 100) memoryFiles.delete(memoryFiles.keys().next().value);
  return id;
}

async function getFile(id) {
  if (memoryFiles.has(id)) return memoryFiles.get(id);
  if (!/^\d+$/.test(id)) return null;
  const pool = await db();
  if (!pool) return null;
  const r = await pool.query('SELECT guild_id, content_type, data FROM spam_files WHERE id = $1', [id]);
  return r.rows[0] ? { guildId: r.rows[0].guild_id, contentType: r.rows[0].content_type, data: r.rows[0].data } : null;
}

// Pobiera pomniejszony podgląd (przez media proxy Discorda), a gdy się nie uda — mały oryginał
async function downloadThumbnail(att) {
  const candidates = [att.proxyUrl ? `${att.proxyUrl}${att.proxyUrl.includes('?') ? '&' : '?'}width=640&height=640` : null, att.url].filter(Boolean);
  for (const url of candidates) {
    try {
      if (!CDN_HOSTS.test(new URL(url).hostname)) continue;
      const res = await httpFetch(url, { timeout: 5000 });
      if (!res.ok || Number(res.headers.get('content-length')) > 8_000_000) continue;
      const data = Buffer.from(await res.arrayBuffer());
      if (!data.length || data.length > EVIDENCE_MAX_BYTES) continue;
      const contentType = sniffImage(data);
      if (contentType) return { data, contentType };
    } catch { /* próbujemy następny adres */ }
  }
  return null;
}

// Dla wiadomości do usunięcia: zapisuje podglądy obrazów i zwraca opis załączników (messageId -> lista)
async function collectEvidence(entries, guildId) {
  const result = new Map();
  const jobs = [];
  let stored = 0;
  for (const entry of entries) {
    const metas = [];
    for (const a of entry.attachments || []) {
      const meta = { name: a.name || 'plik', size: a.size || null, contentType: a.contentType || null, url: a.url || null, fileId: null, note: null };
      metas.push(meta);
      const looksImage = /^image\/(png|jpe?g|gif|webp)/i.test(a.contentType || '') || IMAGE_EXT.test(a.name || '');
      if (!looksImage) { meta.note = 'To nie obraz — zapisano tylko nazwę (link może wygasnąć)'; continue; }
      if (stored >= EVIDENCE_MAX_FILES) { meta.note = 'Limit zapisanych podglądów dla tego zgłoszenia'; continue; }
      stored += 1;
      jobs.push((async () => {
        const image = await downloadThumbnail(a);
        if (!image) { meta.note = 'Nie udało się pobrać podglądu (link mógł wygasnąć)'; return; }
        try { meta.fileId = await saveFile(guildId, entry.id, meta.name, image.contentType, image.data); } catch { meta.note = 'Nie udało się zapisać podglądu'; }
      })());
    }
    result.set(entry.id, metas);
  }
  await Promise.all(jobs);
  return result;
}

// ───────── Działania na Discordzie ─────────
const describeError = (error) => (error?.status === 403 ? 'brak uprawnień bota lub wyższa rola użytkownika (HTTP 403)' : error?.status === 404 ? 'nie znaleziono (HTTP 404)' : error?.message || 'nieznany błąd');
const timeoutUntilIso = () => new Date(Date.now() + MAX_TIMEOUT_MS).toISOString();

const setTimeoutFor = (guildId, userId, until, reason) => discordRequest('PATCH', `/guilds/${guildId}/members/${userId}`, { communication_disabled_until: until }, { reason });

// Usuwa wiadomości (po kanałach, hurtowo) i zwraca rekordy do historii
async function deleteEntries(entries) {
  const records = entries.map((m) => ({ id: m.id, channelId: m.channelId, channelName: m.channelName, ts: new Date(m.ts).toISOString(), content: m.content, attachments: m.attachments, deleted: false, error: null }));
  const byChannel = new Map();
  for (const r of records) byChannel.set(r.channelId, [...(byChannel.get(r.channelId) || []), r]);
  for (const [channelId, items] of byChannel) {
    const fresh = items.filter((r) => Date.now() - snowTime(r.id) < 13 * 24 * 3600 * 1000);   // bulk-delete działa do 14 dni
    try {
      if (fresh.length === 1) await discordRequest('DELETE', `/channels/${channelId}/messages/${fresh[0].id}`);
      else for (let i = 0; i < fresh.length; i += 100) await discordRequest('POST', `/channels/${channelId}/messages/bulk-delete`, { messages: fresh.slice(i, i + 100).map((r) => r.id) });
      fresh.forEach((r) => { r.deleted = true; });
    } catch (error) {
      const gone = error?.status === 404;   // już usunięta
      fresh.forEach((r) => { r.deleted = gone; r.error = gone ? null : describeError(error); });
    }
  }
  return records;
}

const serial = new Map();
function serialize(key, task) {
  const next = (serial.get(key) || Promise.resolve()).catch(() => {}).then(task);
  serial.set(key, next);
  next.finally(() => { if (serial.get(key) === next) serial.delete(key); }).catch(() => {});
  return next;
}

async function quarantine(info, cfg, ctx) {
  const { deps } = ctx;
  const now = Date.now();
  const reasons = spamReasons({ content: info.content, attachments: info.attachments.length, mentionsEveryone: info.mentionsEveryone });
  trackMessage(info);   // pewność, że wiadomość wyzwalająca jest na liście do usunięcia
  const until = timeoutUntilIso();
  const notes = [];

  const [timedOut, deleted] = await Promise.all([
    setTimeoutFor(info.guildId, info.userId, until, 'Spam: wiadomość na kanale-pułapce').then(() => true).catch((error) => { notes.push(`Wyciszenie nie powiodło się: ${describeError(error)}`); return false; }),
    (async () => {
      const entries = recentMessages(info.guildId, info.userId, now - DELETE_WINDOW_MS);
      const evidence = await collectEvidence(entries, info.guildId);   // podglądy zapisujemy ZANIM wiadomości znikną
      const records = await deleteEntries(entries);
      for (const record of records) record.attachments = evidence.get(record.id) || [];
      return records;
    })()
  ]);
  deleted.filter((r) => r.error).forEach((r) => notes.push(`Nie usunięto wiadomości z #${r.channelName || r.channelId}: ${r.error}`));

  const active = await findActive(info.guildId, info.userId);
  let incident;
  if (active) {
    const known = new Set(active.deleted.map((r) => r.id));
    incident = await updateIncident(active.id, {
      deleted: [...active.deleted, ...deleted.filter((r) => !known.has(r.id))],
      reasons: [...new Set([...active.reasons, ...reasons])],
      timeoutUntil: timedOut ? until : active.timeoutUntil,
      notes: [active.notes, ...notes].filter(Boolean).join(' | ') || null
    });
  } else {
    incident = await createIncident({
      guildId: info.guildId, userId: info.userId, userName: info.userName || info.userId, avatarUrl: info.avatarUrl || null, channelId: info.channelId,
      channelName: info.channelName, triggerContent: String(info.content || '').slice(0, 1500), reasons, timeoutUntil: timedOut ? until : null,
      notes: notes.join(' | ') || null, deleted
    });
    const label = { trap: 'kanał-pułapka', invite: 'zaproszenie do serwera', link: 'link', mass_mention: 'masowa wzmianka', attachment: 'załącznik' };
    deps.notifyPanel?.('spam', { id: incident.id, guildId: info.guildId, userId: info.userId, userName: incident.userName, avatarUrl: incident.avatarUrl, reasons })?.catch?.(() => {});
    deps.sendWebhookLog?.(cfg.WEBHOOK_URL, {
      title: '🛡️ Spam: wyciszono użytkownika', color: 15158332,
      description: `**Użytkownik:** <@${info.userId}> (${info.userName || info.userId})\n**Kanał:** <#${info.channelId}>\n**Powód:** ${reasons.map((r) => label[r]).join(', ')}\n**Usunięte wiadomości:** ${deleted.filter((r) => r.deleted).length}/${deleted.length}\n**Wyciszenie:** ${timedOut ? 'do ' + until.slice(0, 10) : 'NIE POWIODŁO SIĘ'}\n\nDecyzja w panelu: zakładka Spam (Perm ban / Odblokuj).`,
      timestamp: new Date().toISOString()
    });
  }
  deps.addDashboardLog('warn', `Spam: ${info.userName || info.userId} napisał na kanale-pułapce (${info.channelName || info.channelId}); usunięto ${deleted.filter((r) => r.deleted).length} wiadomości.`, { guildId: info.guildId, source: 'server', userId: info.userId, channelId: info.channelId });
  return incident;
}

export async function processSpamMessage(info, ctx) {
  const cfg = ctx.serverConfigs[info.guildId];
  if (!cfg || info.bot || !spamChannelIds(cfg).includes(info.channelId)) return null;
  let roleIds = info.roleIds;
  if (!roleIds) {   // nie znamy ról autora — sprawdzamy, żeby nie ukarać administracji przez pomyłkę
    try { roleIds = (await discordRequest('GET', `/guilds/${info.guildId}/members/${info.userId}`)).roles; } catch (error) {
      ctx.deps.addDashboardLog('warn', `Spam: nie sprawdzono ról użytkownika ${info.userId} (${describeError(error)}), pominięto.`, { guildId: info.guildId, source: 'server' });
      return null;
    }
  }
  if (isExempt({ ...info, roleIds }, cfg, ctx.botOwnerId)) return null;
  return serialize(keyOf(info.guildId, info.userId), () => quarantine(info, cfg, ctx));
}

// Adapter: obiekt wiadomości discord.js -> zwykłe dane
function describe(message) {
  return {
    id: message.id, guildId: message.guildId, channelId: message.channelId, channelName: message.channel?.name || null, content: message.content || '',
    ts: message.createdTimestamp || Date.now(), bot: Boolean(message.author?.bot || message.webhookId || message.system), userId: message.author?.id,
    userName: message.member?.displayName || message.author?.globalName || message.author?.username,
    avatarUrl: message.member?.displayAvatarURL?.({ size: 64 }) || message.author?.displayAvatarURL?.({ size: 64 }) || null,
    attachments: [...(message.attachments?.values?.() || [])].map((a) => ({ name: a.name, url: a.url, proxyUrl: a.proxyURL, contentType: a.contentType, size: a.size })), mentionsEveryone: Boolean(message.mentions?.everyone),
    roleIds: message.member?.roles?.cache ? [...message.member.roles.cache.keys()] : null,
    isAdmin: Boolean(message.member?.permissions?.has?.('Administrator')), guildOwnerId: message.guild?.ownerId || null
  };
}

// Wywoływane dla każdej wiadomości na serwerze: zapamiętuje ją na 10 minut i sprawdza, czy to kanał-pułapka
export async function onGuildMessage(message, ctx) {
  if (!message.guildId || message.author?.bot) return null;
  const info = describe(message);
  if (info.bot || !info.userId) return null;
  trackMessage(info);
  return processSpamMessage(info, ctx);
}

// ───────── Ostrzeżenie na kanałach przy pierwszym uruchomieniu ─────────
export async function ensureSpamNotices(ctx) {
  const posted = [];
  for (const [guildId, cfg] of Object.entries(ctx.serverConfigs)) {
    for (const channelId of spamChannelIds(cfg)) {
      try {
        const channel = await discordRequest('GET', `/channels/${channelId}`);
        if (channel.guild_id !== guildId) continue;   // kanał należy do innego serwera
        if (await noticePosted(channelId)) continue;
        const history = await discordRequest('GET', `/channels/${channelId}/messages?limit=50`).catch(() => []);
        if (history.some((m) => m.author?.bot && m.embeds?.some((e) => e.title === NOTICE_TITLE))) { await markNotice(channelId); continue; }
        await discordRequest('POST', `/channels/${channelId}/messages`, {
          embeds: [{
            title: NOTICE_TITLE, color: 15158332,
            description: '**KTOKOLWIEK NAPISZE TUTAJ COKOLWIEK = PERM BAN.**\n\nTen kanał jest tylko do czytania i jest pilnowany automatycznie. Każda wiadomość (także link lub zaproszenie do innego serwera) jest wykrywana, a Twoje wiadomości z ostatnich 5 minut na tym serwerze zostaną usunięte.',
            footer: { text: 'System antyspamowy' }
          }],
          allowed_mentions: { parse: [] }
        });
        await markNotice(channelId);
        posted.push(channelId);
        ctx.deps.addDashboardLog('info', `Spam: wysłano ostrzeżenie na kanał-pułapkę ${channel.name || channelId}.`, { guildId, source: 'server' });
      } catch (error) {
        console.error(`[spam] ostrzeżenie na kanale ${channelId}:`, describeError(error));
      }
    }
  }
  return posted;
}

// ───────── Odnawianie wyciszeń i porządki ─────────
export async function renewTimeouts() {
  let renewed = 0;
  for (const inc of await listQuarantined()) {
    if (inc.timeoutUntil && new Date(inc.timeoutUntil).getTime() - Date.now() > RENEW_BELOW_MS) continue;
    const until = timeoutUntilIso();
    try {
      await setTimeoutFor(inc.guildId, inc.userId, until, 'Spam: odnowienie wyciszenia');
      await updateIncident(inc.id, { timeoutUntil: until });
      renewed += 1;
    } catch (error) {
      if (error?.status !== 404) console.error(`[spam] odnowienie wyciszenia ${inc.userId}:`, describeError(error));
    }
  }
  return renewed;
}

async function purgeOld() {
  try {
    const pool = await db();
    if (pool) {
      await pool.query("DELETE FROM spam_incidents WHERE created_at < NOW() - ($1 || ' days')::interval AND status <> 'quarantined'", [String(RETENTION_DAYS)]);
      await pool.query("DELETE FROM spam_files WHERE created_at < NOW() - ($1 || ' days')::interval", [String(RETENTION_DAYS)]);
    }
  } catch (error) { console.error('[spam] czyszczenie starych wpisów:', error.message); }
}

export function startSpamJobs(ctx) {
  setInterval(() => pruneRecent(), 60 * 1000).unref();
  const daily = () => { renewTimeouts().catch((e) => console.error('[spam] odnawianie:', e.message)); purgeOld(); };
  daily();
  setInterval(daily, 6 * 60 * 60 * 1000).unref();
  onDatabaseReady(() => flushLocal().catch((e) => console.error('[spam] przenoszenie do bazy:', e.message)));
}

// ───────── Decyzje administracji ─────────
async function resolve(id, actor, status, action) {
  return serialize(`incident:${id}`, () => resolveNow(id, actor, status, action));
}

async function resolveNow(id, actor, status, action) {
  const incident = await getIncident(String(id));
  if (!incident) throw new UserError('Nie znaleziono wpisu.', 404);
  if (incident.status !== 'quarantined') throw new UserError('Ten wpis jest już rozpatrzony.', 409);
  const note = await action(incident);
  return updateIncident(incident.id, { status, resolvedBy: `${actor.name} (${actor.id})`, resolvedAt: new Date().toISOString(), notes: [incident.notes, note].filter(Boolean).join(' | ') || null });
}

export const banIncident = (id, actor) => resolve(id, actor, 'banned', async (inc) => {
  await discordRequest('PUT', `/guilds/${inc.guildId}/bans/${inc.userId}`, { delete_message_seconds: 300 }, { reason: `Spam (panel): ${actor.name}` });
  return null;
});

export const unblockIncident = (id, actor) => resolve(id, actor, 'unblocked', async (inc) => {
  try {
    await setTimeoutFor(inc.guildId, inc.userId, null, `Spam: odblokowanie (panel): ${actor.name}`);
    return null;
  } catch (error) {
    if (error?.status === 404) return 'Użytkownik nie jest już na serwerze.';
    throw error;
  }
});

// ───────── Trasy panelu ─────────
const channelInfo = new Map();
const getChannel = (id) => {
  const hit = channelInfo.get(id);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.p;
  const p = discordRequest('GET', `/channels/${id}`).catch(() => null);
  channelInfo.set(id, { at: Date.now(), p });
  return p;
};

const imageCountOf = (i) => (i.deleted || []).reduce((n, m) => n + (m.attachments || []).filter((a) => a.fileId).length, 0);

const light = (i) => ({
  imageCount: imageCountOf(i),
  id: i.id, userId: i.userId, userName: i.userName, avatarUrl: i.avatarUrl, channelName: i.channelName, reasons: i.reasons, status: i.status, createdAt: i.createdAt,
  timeoutUntil: i.timeoutUntil, deletedCount: i.deleted.length, preview: String(i.triggerContent || '').slice(0, 120), resolvedBy: i.resolvedBy, resolvedAt: i.resolvedAt
});

export function registerSpamRoutes(app, { serverConfigs, getGuildInfo, addDashboardLog }) {
  const DEFAULT_GUILD = (process.env.STAFF_GUILD_ID || '1344364720605499442').trim();

  async function monitoredFor(guildId) {
    const found = [];
    for (const id of spamChannelIds(serverConfigs[guildId])) {
      const channel = await getChannel(id);
      if (channel && channel.guild_id === guildId) found.push({ id, name: channel.name });
    }
    return found;
  }

  const ownsIncident = (incident) => incident && serverConfigs[incident.guildId];

  // Zapisany podgląd obrazu (dowód). Tylko dla osób z zakładką Spam; plik jest podawany jako obraz w piaskownicy, nigdy jako strona
  app.get('/api/spam/files/:fileId', async (req, res) => {
    try {
      const file = await getFile(String(req.params.fileId));
      if (!file || !serverConfigs[file.guildId]) return res.status(404).json({ ok: false, error: 'Nie znaleziono pliku.' });
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', 'inline; filename="dowod"');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(file.data);
    } catch (error) {
      console.error('[spam] plik:', error.message);
      res.status(502).json({ ok: false, error: 'Nie udało się wczytać pliku.' });
    }
  });

  app.get('/api/spam', async (req, res) => {
    try {
      const guilds = [];
      for (const id of Object.keys(serverConfigs)) if ((await monitoredFor(id)).length) guilds.push({ id, name: (await getGuildInfo(id, true))?.name || id });
      if (!guilds.length) return res.json({ ok: true, guilds: [], guildId: null, monitored: [], incidents: [], counts: {} });
      const requested = String(req.query.guild || '');
      const guildId = (guilds.find((g) => g.id === requested) || guilds.find((g) => g.id === DEFAULT_GUILD) || guilds[0]).id;
      const all = await listIncidents(guildId, null);
      const counts = { quarantined: 0, banned: 0, unblocked: 0 };
      all.forEach((i) => { counts[i.status] = (counts[i.status] || 0) + 1; });
      res.json({ ok: true, guilds, guildId, monitored: await monitoredFor(guildId), incidents: all.map(light), counts });
    } catch (error) {
      console.error('[spam] lista:', error.message);
      res.status(502).json({ ok: false, error: 'Nie udało się wczytać listy.' });
    }
  });

  app.get('/api/spam/:id', async (req, res) => {
    try {
      const incident = await getIncident(String(req.params.id));
      if (!ownsIncident(incident)) return res.status(404).json({ ok: false, error: 'Nie znaleziono wpisu.' });
      // Aktualny stan na Discordzie (czy jest na serwerze, czy wyciszenie nadal trwa) — gdy ktoś zdjął je ręcznie, administracja to zobaczy
      let live = null;
      if (incident.status === 'quarantined') {
        try {
          const member = await discordRequest('GET', `/guilds/${incident.guildId}/members/${incident.userId}`);
          live = { inGuild: true, timeoutUntil: member.communication_disabled_until || null };
        } catch (error) {
          live = error?.status === 404 ? { inGuild: false, timeoutUntil: null } : null;
        }
      }
      res.json({ ok: true, incident, live });
    } catch (error) {
      console.error('[spam] szczegóły:', error.message);
      res.status(502).json({ ok: false, error: 'Nie udało się wczytać wpisu.' });
    }
  });

  const decision = (name, fn, verb) => app.post(`/api/spam/:id/${name}`, async (req, res) => {
    try {
      const existing = await getIncident(String(req.params.id));
      if (!ownsIncident(existing)) return res.status(404).json({ ok: false, error: 'Nie znaleziono wpisu.' });
      const incident = await fn(existing.id, { id: req.dashUser.id, name: req.dashUser.name });
      addDashboardLog('warn', `Spam: ${req.dashUser.name} — ${verb} (${incident.userName || incident.userId}).`, { guildId: incident.guildId, source: 'server', userId: incident.userId });
      res.json({ ok: true, incident });
    } catch (error) {
      if (error instanceof UserError) return res.status(error.status).json({ ok: false, error: error.message });
      console.error(`[spam] ${name}:`, error.message);
      res.status(502).json({ ok: false, error: error.status === 403 ? 'Bot nie ma uprawnień do tej akcji (Ban Members / Moderate Members) albo użytkownik ma wyższą rolę niż bot.' : 'Nie udało się wykonać akcji. Spróbuj ponownie.' });
    }
  });
  decision('ban', banIncident, 'perm ban');
  decision('unblock', unblockIncident, 'odblokowanie');
}
