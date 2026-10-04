// Magazyn logów panelu: PostgreSQL (gdy ustawiono DATABASE_URL) albo pamięć tymczasowa.
import pg from 'pg';

const MEMORY_LIMIT = 3000;
const RETENTION_DAYS = Math.max(1, Number.parseInt(process.env.LOG_RETENTION_DAYS, 10) || 90);
const memory = [];   // najnowsze na początku
const pending = [];  // logi dodane zanim baza była gotowa
const archivedTickets = new Map();
let pool = null;
let ready = false;
let initDone = false;
let nextMemId = 1;
let persistenceGeneration = 0;
let persistenceQueue = Promise.resolve();

export const storageMode = () => (ready ? 'postgres' : 'memory');

function sslFor(url) {
  if (process.env.DATABASE_SSL === 'false') return undefined;
  if (/\.railway\.internal|localhost|127\.0\.0\.1/.test(url)) return undefined;
  return { rejectUnauthorized: false };
}

const INSERT_SQL = 'INSERT INTO dashboard_logs (ts, level, source, guild_id, command, message, meta) VALUES ($1,$2,$3,$4,$5,$6,$7)';

export async function initLogStore() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    initDone = true;
    console.warn('⚠️ Brak DATABASE_URL — logi panelu są tylko w pamięci i znikną po restarcie.');
    return;
  }
  try {
    pool = new pg.Pool({ connectionString: url, max: 5, ssl: sslFor(url), connectionTimeoutMillis: 5000 });
    pool.on('error', (e) => console.error('Błąd połączenia z bazą logów:', e.message));
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dashboard_logs (
        id BIGSERIAL PRIMARY KEY,
        ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        level TEXT NOT NULL DEFAULT 'info',
        source TEXT NOT NULL DEFAULT 'bot',
        guild_id TEXT,
        command TEXT,
        message TEXT NOT NULL,
        meta JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_dashboard_logs_ts ON dashboard_logs (ts DESC);
      CREATE INDEX IF NOT EXISTS idx_dashboard_logs_source_ts ON dashboard_logs (source, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_dashboard_logs_guild_ts ON dashboard_logs (guild_id, ts DESC);
      CREATE TABLE IF NOT EXISTS server_configs (
        guild_id TEXT PRIMARY KEY,
        settings JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS archived_tickets (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        deleted_at TIMESTAMPTZ NOT NULL,
        ticket JSONB NOT NULL,
        messages JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_archived_tickets_guild_deleted ON archived_tickets (guild_id, deleted_at DESC);
    `);
    ready = true;
    for (const row of pending.splice(0)) persist(row);
    await purgeOld();
    setInterval(purgeOld, 6 * 60 * 60 * 1000).unref();
    console.log(`✅ Baza logów: PostgreSQL (retencja ${RETENTION_DAYS} dni).`);
  } catch (error) {
    console.error('❌ Nie udało się połączyć z bazą logów, używam pamięci:', error.message);
    pool = null;
  } finally {
    initDone = true;
  }
}

export async function readServerConfigs() {
  if (!ready) return [];
  const result = await pool.query('SELECT guild_id, settings FROM server_configs');
  return result.rows;
}

export async function writeServerConfig(guildId, settings) {
  if (!ready) throw new Error('PostgreSQL is unavailable');
  await pool.query(`
    INSERT INTO server_configs (guild_id, settings, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (guild_id) DO UPDATE
    SET settings = EXCLUDED.settings, updated_at = NOW()
  `, [guildId, settings]);
}

export async function saveArchivedTicket(ticket, messages) {
  const row = { channelId: String(ticket.id), guildId: String(ticket.guildId), deletedAt: new Date().toISOString(), ticket, messages };
  if (!ready) {
    archivedTickets.set(row.channelId, row);
    return;
  }
  await pool.query(`
    INSERT INTO archived_tickets (channel_id, guild_id, deleted_at, ticket, messages)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (channel_id) DO UPDATE SET
      guild_id = EXCLUDED.guild_id, deleted_at = EXCLUDED.deleted_at,
      ticket = EXCLUDED.ticket, messages = EXCLUDED.messages
  `, [row.channelId, row.guildId, row.deletedAt, JSON.stringify(row.ticket), JSON.stringify(row.messages)]);
}

export async function listArchivedTickets(guildId) {
  if (!ready) return [...archivedTickets.values()].filter((row) => row.guildId === String(guildId)).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  const result = await pool.query('SELECT channel_id, guild_id, deleted_at, ticket FROM archived_tickets WHERE guild_id = $1 ORDER BY deleted_at DESC', [String(guildId)]);
  return result.rows.map((row) => ({ channelId: row.channel_id, guildId: row.guild_id, deletedAt: new Date(row.deleted_at).toISOString(), ticket: row.ticket }));
}

export async function getArchivedTicket(channelId, guildId) {
  if (!ready) {
    const row = archivedTickets.get(String(channelId));
    return row?.guildId === String(guildId) ? row : null;
  }
  const result = await pool.query('SELECT channel_id, guild_id, deleted_at, ticket, messages FROM archived_tickets WHERE channel_id = $1 AND guild_id = $2', [String(channelId), String(guildId)]);
  const row = result.rows[0];
  return row ? { channelId: row.channel_id, guildId: row.guild_id, deletedAt: new Date(row.deleted_at).toISOString(), ticket: row.ticket, messages: row.messages } : null;
}

async function purgeOld() {
  try {
    await pool.query("DELETE FROM dashboard_logs WHERE ts < NOW() - ($1 || ' days')::interval", [String(RETENTION_DAYS)]);
  } catch (e) {
    console.error('Błąd czyszczenia starych logów:', e.message);
  }
}

function persist(row) {
  const generation = persistenceGeneration;
  const write = persistenceQueue.then(() => {
    if (!ready || generation !== persistenceGeneration) return;
    return pool.query(INSERT_SQL, [row.timestamp, row.level, row.source, row.guildId, row.command, row.message, row.meta]);
  });
  persistenceQueue = write.catch((e) => console.error('Błąd zapisu logu do bazy:', e.message));
}

export async function clearLogs({ source = null, guildId = null } = {}) {
  const selectedGuild = guildId ? String(guildId) : null;
  const matches = (row) => (!source || row.source === source) && (!selectedGuild || row.guildId === selectedGuild);
  const clearAll = !source && !selectedGuild;

  if (clearAll) {
    persistenceGeneration++;
    memory.length = 0;
    pending.length = 0;
    nextMemId = 1;
    if (!ready) return;
    const deletion = persistenceQueue.then(() => pool.query('DELETE FROM dashboard_logs'));
    persistenceQueue = deletion.catch((e) => console.error('Błąd czyszczenia logów w bazie:', e.message));
    await deletion;
    return;
  }

  for (let index = memory.length - 1; index >= 0; index--) if (matches(memory[index])) memory.splice(index, 1);
  for (let index = pending.length - 1; index >= 0; index--) if (matches(pending[index])) pending.splice(index, 1);
  if (!ready) return;

  const conditions = [];
  const params = [];
  if (source) { params.push(source); conditions.push(`source = $${params.length}`); }
  if (selectedGuild) { params.push(selectedGuild); conditions.push(`guild_id = $${params.length}`); }
  const deletion = persistenceQueue.then(() => pool.query(`DELETE FROM dashboard_logs WHERE ${conditions.join(' AND ')}`, params));
  persistenceQueue = deletion.catch((e) => console.error('Błąd czyszczenia logów w bazie:', e.message));
  await deletion;
}

export function addLog(level = 'info', message = '', meta = {}) {
  const { source = 'bot', guildId = null, command = null, ...rest } = meta;
  const row = {
    id: `m${nextMemId++}`,
    level: ['info', 'warn', 'error'].includes(level) ? level : 'info',
    source: source === 'server' ? 'server' : 'bot',
    guildId: guildId ? String(guildId) : null,
    command: command || null,
    message: String(message).slice(0, 2000),
    timestamp: new Date().toISOString(),
    meta: Object.keys(rest).length ? JSON.stringify(rest) : null
  };
  memory.unshift(row);
  if (memory.length > MEMORY_LIMIT) memory.length = MEMORY_LIMIT;
  if (ready) persist(row);
  else if (!initDone) pending.push(row);
}

// ---------- Filtry ----------
const RANGES = { '1h': 36e5, '24h': 864e5, '7d': 6048e5, '30d': 2592e6, '90d': 7776e6 };
const toDate = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };

export function parseFilters(q = {}) {
  let from = null;
  let to = null;
  if (q.range === 'custom') { from = toDate(q.from); to = toDate(q.to); }
  else if (RANGES[q.range]) from = new Date(Date.now() - RANGES[q.range]);
  return {
    from, to,
    source: ['bot', 'server'].includes(q.source) ? q.source : null,
    guild: /^\d{5,25}$/.test(q.guild || '') ? q.guild : null,
    level: ['info', 'warn', 'error'].includes(q.level) ? q.level : null,
    search: String(q.q || '').trim().slice(0, 100)
  };
}

function sqlWhere(f) {
  const c = [];
  const p = [];
  const add = (sql, v) => { p.push(v); c.push(sql.replace('?', `$${p.length}`)); };
  if (f.from) add('ts >= ?', f.from);
  if (f.to) add('ts <= ?', f.to);
  if (f.source) add('source = ?', f.source);
  if (f.guild) add('guild_id = ?', f.guild);
  if (f.level) add('level = ?', f.level);
  if (f.search) add('message ILIKE ?', `%${f.search.replace(/[\\%_]/g, '\\$&')}%`);
  return { where: c.length ? `WHERE ${c.join(' AND ')}` : '', params: p };
}

function memMatch(f) {
  const s = f.search.toLowerCase();
  return (r) => {
    const t = Date.parse(r.timestamp);
    return (!f.from || t >= f.from) && (!f.to || t <= f.to) && (!f.source || r.source === f.source)
      && (!f.guild || r.guildId === f.guild) && (!f.level || r.level === f.level)
      && (!s || r.message.toLowerCase().includes(s));
  };
}

function parseMeta(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

const fromRow = (r) => ({ id: String(r.id), level: r.level, source: r.source, guildId: r.guild_id, command: r.command, message: r.message, timestamp: new Date(r.ts).toISOString(), meta: parseMeta(r.meta) });
const fromMemory = ({ meta, ...row }) => ({ ...row, meta: parseMeta(meta) });

export async function queryLogs(f, { limit = 50, offset = 0 } = {}) {
  if (!ready) {
    const all = memory.filter(memMatch(f));
    return { logs: all.slice(offset, offset + limit).map(fromMemory), total: all.length };
  }
  const { where, params } = sqlWhere(f);
  const [rows, count] = await Promise.all([
    pool.query(`SELECT id, ts, level, source, guild_id, command, message, meta FROM dashboard_logs ${where} ORDER BY ts DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, params),
    pool.query(`SELECT COUNT(*)::int AS n FROM dashboard_logs ${where}`, params)
  ]);
  return { logs: rows.rows.map(fromRow), total: count.rows[0].n };
}

// ---------- Statystyki ----------
const STEPS = [300, 900, 3600, 10800, 21600, 43200, 86400, 172800, 604800, 2592000];

export async function getStats(f, tzSeconds = 0) {
  const now = Date.now();
  const to = f.to ? f.to.getTime() : now;
  let from = f.from ? f.from.getTime() : null;
  if (from === null) {
    if (ready) {
      const { where, params } = sqlWhere({ ...f, from: null });
      const r = await pool.query(`SELECT MIN(ts) AS m FROM dashboard_logs ${where}`, params);
      from = r.rows[0].m ? new Date(r.rows[0].m).getTime() : to - 864e5;
    } else {
      const all = memory.filter(memMatch(f));
      from = all.length ? Date.parse(all[all.length - 1].timestamp) : to - 864e5;
    }
  }
  const span = Math.max(to - from, 6e4) / 1000;
  const step = STEPS.find((s) => span / s <= 48) || STEPS[STEPS.length - 1];
  const bucketOf = (sec) => Math.floor((sec + tzSeconds) / step) * step - tzSeconds;

  let rows; // { t, level, source, command, guildId, n }
  if (ready) {
    const { where, params } = sqlWhere(f);
    const r = await pool.query(
      `SELECT FLOOR((EXTRACT(EPOCH FROM ts) + ${tzSeconds}) / ${step})::bigint AS b, level, source, command, guild_id, COUNT(*)::int AS n
       FROM dashboard_logs ${where} GROUP BY 1, 2, 3, 4, 5`, params);
    rows = r.rows.map((x) => ({ t: Number(x.b) * step - tzSeconds, level: x.level, source: x.source, command: x.command, guildId: x.guild_id, n: x.n }));
  } else {
    rows = memory.filter(memMatch(f)).map((x) => ({ t: bucketOf(Date.parse(x.timestamp) / 1000), level: x.level, source: x.source, command: x.command, guildId: x.guildId, n: 1 }));
  }

  const series = new Map();
  for (let t = bucketOf(from / 1000); t <= to / 1000; t += step) series.set(t, { t: t * 1000, info: 0, warn: 0, error: 0 });
  const totals = { total: 0, info: 0, warn: 0, error: 0, bot: 0, server: 0, commands: 0 };
  const cmds = new Map();
  const guilds = new Map();
  for (const r of rows) {
    const b = series.get(r.t) || (series.set(r.t, { t: r.t * 1000, info: 0, warn: 0, error: 0 }), series.get(r.t));
    b[r.level] += r.n;
    totals.total += r.n; totals[r.level] += r.n; totals[r.source] += r.n;
    if (r.command) { totals.commands += r.n; cmds.set(r.command, (cmds.get(r.command) || 0) + r.n); }
    if (r.guildId) guilds.set(r.guildId, (guilds.get(r.guildId) || 0) + r.n);
  }
  const top = (m, k, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ [k]: key, count }));
  return {
    totals, step,
    timeline: [...series.values()].sort((a, b) => a.t - b.t),
    commands: top(cmds, 'command', 8),
    guilds: top(guilds, 'guildId', 8)
  };
}

// ---------- Pozostałe zapytania ----------
export async function countBySource() {
  if (!ready) return { bot: memory.filter((r) => r.source === 'bot').length, server: memory.filter((r) => r.source === 'server').length };
  const r = await pool.query('SELECT source, COUNT(*)::int AS n FROM dashboard_logs GROUP BY source');
  const out = { bot: 0, server: 0 };
  r.rows.forEach((x) => { out[x.source] = x.n; });
  return out;
}

export async function guildSummaries() {
  const out = new Map();
  if (!ready) {
    const day = Date.now() - 864e5;
    for (const r of memory) {
      if (!r.guildId) continue;
      const g = out.get(r.guildId) || { total: 0, commands: 0, lastEvent: r.timestamp, errors24h: 0 };
      g.total++;
      if (r.command) g.commands++;
      if (r.level === 'error' && Date.parse(r.timestamp) > day) g.errors24h++;
      out.set(r.guildId, g);
    }
    return out;
  }
  const r = await pool.query(`SELECT guild_id, COUNT(*)::int AS total, COUNT(command)::int AS commands, MAX(ts) AS last_event,
    COUNT(*) FILTER (WHERE level = 'error' AND ts > NOW() - INTERVAL '24 hours')::int AS errors24h
    FROM dashboard_logs WHERE guild_id IS NOT NULL GROUP BY guild_id`);
  r.rows.forEach((x) => out.set(x.guild_id, { total: x.total, commands: x.commands, lastEvent: new Date(x.last_event).toISOString(), errors24h: x.errors24h }));
  return out;
}

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // ochrona przed formułami w Excelu
  return `"${s.replace(/"/g, '""')}"`;
};

export async function exportCsv(f) {
  const { logs } = await queryLogs(f, { limit: 20000, offset: 0 });
  const lines = ['Data;Poziom;Zrodlo;Serwer (ID);Komenda;Tresc'];
  for (const l of logs) lines.push([l.timestamp, l.level, l.source === 'server' ? 'serwer' : 'system', l.guildId, l.command, l.message].map(csvCell).join(';'));
  return `\uFEFF${lines.join('\r\n')}`;
}
