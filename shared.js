// Wspólne narzędzia: fetch z limitem czasu, błędy bezpieczne dla użytkownika, zapytania do Discorda i obliczanie uprawnień.

const DEFAULT_TIMEOUT_MS = 10_000;

// Zamiennik fetch (wbudowany w Node 18+) z domyślnym limitem czasu. Własny limit: { timeout: 30000 }
export function fetch(url, options = {}) {
  const { timeout = DEFAULT_TIMEOUT_MS, ...rest } = options;
  if (!rest.signal) rest.signal = AbortSignal.timeout(timeout);
  return globalThis.fetch(url, rest);
}

// Błąd, którego treść można bezpiecznie pokazać użytkownikowi w panelu
export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UserError';
    this.status = status;
  }
}

export const isId = (v) => /^\d{5,25}$/.test(String(v));
export const snowTime = (id) => Number((BigInt(id) >> 22n) + 1420070400000n);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Zapytanie do API Discorda jako bot: limit czasu, ponawianie przy 429, błąd z polem .status
export async function discordRequest(method, pathname, body, { timeout } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(`https://discord.com/api/v10${pathname}`, {
      method,
      timeout,
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

// ───────── Uprawnienia kanału (jak na Discordzie) ─────────
export const PERM = { VIEW: 1n << 10n, SEND: 1n << 11n, ADMIN: 1n << 3n };
const ALL_PERMS = (1n << 53n) - 1n;

export function permsFor(member, roleMap, channel, guildId, ownerId, userId) {
  if (userId === ownerId) return ALL_PERMS;
  let base = BigInt(roleMap.get(guildId)?.permissions || 0);
  for (const rid of member.roles) base |= BigInt(roleMap.get(rid)?.permissions || 0);
  if (base & PERM.ADMIN) return ALL_PERMS;
  const overwrites = channel.permission_overwrites || [];
  const everyone = overwrites.find((o) => o.id === guildId);
  if (everyone) base = (base & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let deny = 0n;
  let allow = 0n;
  for (const o of overwrites) {
    if (o.type === 0 && member.roles.includes(o.id)) { deny |= BigInt(o.deny); allow |= BigInt(o.allow); }
  }
  base = (base & ~deny) | allow;
  const mine = overwrites.find((o) => o.type === 1 && o.id === userId);
  if (mine) base = (base & ~BigInt(mine.deny)) | BigInt(mine.allow);
  return base;
}

// Temat kanału ticketu: ticket|ownerId|typeId|open/closed|numer
export function parseTopic(channel) {
  if (typeof channel?.topic !== 'string' || !channel.topic.startsWith('ticket|')) return null;
  const p = channel.topic.split('|');
  if (!isId(p[1])) return null;
  return { ownerId: p[1], typeId: p[2] || '', state: p[3] === 'closed' ? 'closed' : 'open', number: p[4] || '' };
}

// Komunikat bezpieczny dla przeglądarki: własne, polskie komunikaty przechodzą, błędy techniczne (Discord, sieć, kod) zamieniamy na ogólny
export function publicError(error, fallback = 'Nie udało się wykonać operacji.') {
  if (error instanceof UserError) return error.message;
  const technical = error?.status || error?.code || error?.name !== 'Error'
    || /^(Discord|HTTP|fetch|Unexpected|Cannot|Invalid|Request|connect|read|write)\b/i.test(error?.message || '');
  return !technical && error?.message ? String(error.message).slice(0, 300) : fallback;
}
