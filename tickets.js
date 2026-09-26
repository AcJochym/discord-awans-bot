// tickets.js — system ticketów w stylu Ticket Tool dla bota opartego o HTTP Interactions.
//
// Nie potrzebuje bazy danych: stan ticketu jest zapisany w temacie kanału
//   ticket|<ID właściciela>|<ID kategorii>|<open/closed>|<numer>
// a numeracja jest odtwarzana z istniejących kanałów i ostatnich logów.
// Pełny opis konfiguracji: TICKETS.md

import fetch from 'node-fetch';

const API = 'https://discord.com/api/v10';

const PERM = { VIEW: 1 << 10, SEND: 1 << 11, EMBED: 1 << 14, ATTACH: 1 << 15, HISTORY: 1 << 16 };
const MEMBER_ALLOW = PERM.VIEW | PERM.SEND | PERM.EMBED | PERM.ATTACH | PERM.HISTORY;

const COLORS = { blue: 3447003, green: 5763719, red: 15158332, orange: 16753920, grey: 9807270 };

const CLAIM_FIELD = '✋ Obsługuje';
const STATUS_FIELD = '📊 Status';
const CLOSED_TITLE = '🔒 Ticket zamknięty';

// ───────────────────────── REST ─────────────────────────

async function discordRaw(method, path, body, attempt = 0) {
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    if (res.status === 429 && attempt < 2) {
      const info = await res.json().catch(() => ({}));
      await new Promise(r => setTimeout(r, Math.min(info.retry_after || 1, 5) * 1000));
      return discordRaw(method, path, body, attempt + 1);
    }
    let data = true;
    if (res.status !== 204) {
      const text = await res.text();
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!res.ok) console.error(`[tickets] ${method} ${path}: HTTP ${res.status} ${JSON.stringify(data)}`);
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    console.error(`[tickets] ${method} ${path}:`, e);
    return { ok: false, status: 0, data: null };
  }
}

const discord = async (method, path, body) => {
  const r = await discordRaw(method, path, body);
  return r.ok ? r.data : null;
};

const postMessage = (channelId, payload) => discord('POST', `/channels/${channelId}/messages`, payload);

async function editOriginal(interaction, data) {
  try {
    const res = await fetch(`${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) console.error(`[tickets] editOriginal: HTTP ${res.status} ${await res.text()}`);
  } catch (e) {
    console.error('[tickets] editOriginal:', e);
  }
}

// Wiadomość z plikiem (multipart) — używa wbudowanego fetch (Node 18+)
async function sendFile(channelId, payload, filename, fileText) {
  try {
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ ...payload, attachments: [{ id: 0, filename }] }));
    form.append('files[0]', new Blob([fileText], { type: 'text/html' }), filename);
    const res = await globalThis.fetch(`${API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      body: form
    });
    if (!res.ok) {
      console.error(`[tickets] sendFile: HTTP ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[tickets] sendFile:', e);
    return false;
  }
}

async function openDM(userId) {
  const ch = await discord('POST', '/users/@me/channels', { recipient_id: userId });
  return ch?.id || null;
}

async function notifyTicketOwner(userId, content) {
  const dm = await openDM(userId);
  if (!dm) {
    console.warn(`[tickets] Nie udało się otworzyć DM do właściciela ${userId}.`);
    return false;
  }
  const sent = await postMessage(dm, { content });
  if (!sent) console.warn(`[tickets] Nie udało się wysłać DM do właściciela ${userId}.`);
  return Boolean(sent);
}

const guildNames = new Map();
async function getGuildName(guildId) {
  if (guildNames.has(guildId)) return guildNames.get(guildId);
  const g = await discord('GET', `/guilds/${guildId}`);
  const name = g?.name || 'Serwer';
  guildNames.set(guildId, name);
  return name;
}

// ───────────────────────── Odpowiedzi na interakcje ─────────────────────────

const reply = (res, content) => res.json({ type: 4, data: { content, flags: 64 } });
const deferEphemeral = (res) => res.json({ type: 5, data: { flags: 64 } });
const deferUpdate = (res) => res.json({ type: 6 });

// ───────────────────────── Komponenty ─────────────────────────

// Emoji: unicode ("❓") albo własne emoji serwera w formacie <:nazwa:ID> / <a:nazwa:ID>
function parseEmoji(e) {
  if (!e) return undefined;
  const m = /^<(a?):(\w+):(\d+)>$/.exec(String(e).trim());
  return m ? { name: m[2], id: m[3], animated: m[1] === 'a' } : { name: String(e).trim() };
}
const plainEmoji = (e) => (e && !String(e).startsWith('<') ? String(e) : '');

const btn = (label, style, custom_id, emoji) => {
  const em = parseEmoji(emoji);
  return { type: 2, label, style, custom_id, ...(em ? { emoji: em } : {}) };
};
const row = (...components) => ({ type: 1, components });

const ticketControls = (claimed = false) => row(
  btn('Zamknij', 4, 'tkt_close', '🔒'),
  claimed ? btn('Zwolnij', 2, 'tkt_unclaim', '🔓') : btn('Przejmij', 3, 'tkt_claim', '✋')
);
const closedControls = () => row(btn('Otwórz ponownie', 3, 'tkt_reopen', '🔓'), btn('Transkrypt', 2, 'tkt_transcript', '📄'), btn('Usuń', 4, 'tkt_delete', '🗑️'));
const confirmRow = (yes, no) => row(btn('Tak', 4, yes), btn('Anuluj', 2, no));

// Pole formularza z definicji { ID, LABEL, PLACEHOLDER, STYLE, REQUIRED, MIN_LENGTH, MAX_LENGTH }
const isParagraph = (f) => f.STYLE === 'paragraph' || f.STYLE === 2;
const textInput = (f, required = true) => row({
  type: 4,
  custom_id: String(f.ID).slice(0, 100),
  label: String(f.LABEL).slice(0, 45),
  style: isParagraph(f) ? 2 : 1,
  required,
  min_length: f.MIN_LENGTH || undefined,
  max_length: Math.min(f.MAX_LENGTH || 1000, 4000),
  ...(f.PLACEHOLDER ? { placeholder: String(f.PLACEHOLDER).slice(0, 100) } : {})
});

// ───────────────────────── Konfiguracja ─────────────────────────

// Wartość z kategorii (TYPES[]) z awaryjnym przejściem na ustawienie globalne (TICKETS)
const pick = (t, type, key) => (type && type[key] != null ? type[key] : t[key]);

const DEFAULT_TYPE = { ID: 'ogolny', LABEL: 'Otwórz ticket', EMOJI: '🎫' };

// Sekcja configu danego panelu: TICKETS.COMMAND albo TICKETS.FTD. Gdy jej nie ma,
// panel korzysta ze wspólnych, "starych" ustawień na poziomie TICKETS (wsteczna zgodność).
const panelSection = (t, mode) => (mode === 'ftd' ? t.FTD : t.COMMAND) || {};
const pickPanel = (t, type, mode, key) =>
  (type && type[key] != null ? type[key] : panelSection(t, mode)[key] ?? t[key]);

// Lista kategorii WIDOCZNYCH na danym panelu (do 25). Command i FTD mają osobne listy —
// jeśli dany panel nie ma własnej sekcji TYPES, korzysta ze wspólnej TICKETS.TYPES.
function getPanelTypes(t, mode) {
  const own = panelSection(t, mode).TYPES;
  const list = own?.length ? own : (t.TYPES?.length ? t.TYPES : [DEFAULT_TYPE]);
  return list.slice(0, 25);
}

// Wszystkie kategorie ze WSZYSTKICH paneli (Command + FTD + stare wspólne TYPES) — używane
// do odnalezienia definicji kategorii dla już istniejącego ticketu, niezależnie z jakiego
// panelu został otwarty. ID kategorii powinny być unikalne w całej konfiguracji.
function allTypes(t) {
  const seen = new Map();
  for (const list of [t.COMMAND?.TYPES, t.FTD?.TYPES, t.TYPES]) {
    for (const ty of list || []) if (!seen.has(String(ty.ID))) seen.set(String(ty.ID), ty);
  }
  if (!seen.size) seen.set(DEFAULT_TYPE.ID, DEFAULT_TYPE);
  return [...seen.values()];
}
const findType = (t, id) => allTypes(t).find(x => String(x.ID) === String(id));
const ticketType = (t, ticket) => findType(t, ticket.typeId) || { ID: ticket.typeId, LABEL: ticket.typeId };

function parseColor(c) {
  if (typeof c === 'number') return c;
  if (typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c.trim())) return parseInt(c.trim().replace('#', ''), 16);
  return undefined;
}

// Domyślne pola formularza można ustawić w FTD.FIELDS, COMMAND.FIELDS lub TICKETS.FIELDS.
const DEFAULT_FIELDS_LIST = [
  { ID: 'odznaka', LABEL: 'Numer odznaki', PLACEHOLDER: '[XXX]', MAX_LENGTH: 20 },
  { ID: 'imie_nazwisko', LABEL: 'Imię Nazwisko', PLACEHOLDER: 'Imie Nazwisko', MAX_LENGTH: 80 },
  { ID: 'stopien', LABEL: 'Stopień', PLACEHOLDER: 'np. Police Officer III', MAX_LENGTH: 80 }
];

// mode: 'l' = formularz FTD, 'b' = formularz Command. Discord pozwala na max 5 pól.
// Command domyślnie używa tych samych pól co FTD; pola kategorii i COMMAND.FIELDS mogą je nadpisać.
function getFields(t, type, mode) {
  if (mode === 'l') {
    const ftd = t.FTD?.FIELDS?.length ? t.FTD.FIELDS : t.FIELDS;
    return (ftd?.length ? ftd : DEFAULT_FIELDS_LIST).slice(0, 5);
  }
  const custom = type.FIELDS?.length ? type.FIELDS : t.COMMAND?.FIELDS;
  const shared = custom?.length ? custom : (t.FTD?.FIELDS?.length ? t.FTD.FIELDS : t.FIELDS);
  return (shared?.length ? shared : DEFAULT_FIELDS_LIST).slice(0, 5);
}

// ───────────────────────── Uprawnienia ─────────────────────────

const memberRoles = (i) => i.member?.roles || [];
const isAdmin = (i, g) => (g.REQUIRED_ROLE_IDS || []).some(r => memberRoles(i).includes(r));

// Obsługa ticketu = administracja LUB rola, która ma dostęp do tego kanału (nadana przy tworzeniu).
// Dzięki temu każda kategoria może mieć własny zespół supportu.
function isTicketStaff(interaction, guildConfig, ticket) {
  if (isAdmin(interaction, guildConfig)) return true;
  const roles = memberRoles(interaction);
  return (ticket.channel.permission_overwrites || []).some(o =>
    o.type === 0 && o.id !== interaction.guild_id && roles.includes(o.id) && (BigInt(o.allow) & BigInt(PERM.VIEW)) !== 0n);
}

// Czy użytkownik może otworzyć ticket tej kategorii? Zwraca komunikat błędu albo null.
function checkAccess(interaction, guildConfig, t, type) {
  const roles = memberRoles(interaction);
  if ((t.BLACKLIST_ROLE_IDS || []).some(r => roles.includes(r))) {
    return '⛔ Masz zablokowaną możliwość otwierania ticketów.';
  }
  const allowed = type.ALLOWED_ROLE_IDS || [];
  if (allowed.length && !isAdmin(interaction, guildConfig) && !allowed.some(r => roles.includes(r))) {
    return `⛔ Nie możesz otworzyć tego ticketu. Wymagana jedna z ról: ${allowed.map(r => `<@&${r}>`).join(', ')}`;
  }
  return null;
}

// ───────────────────────── Pomocnicze ─────────────────────────

const pad = (n) => String(n || 0).padStart(4, '0');

const slug = (s, fallback = 'ticket') => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l')
  .replace(/[^a-z0-9_]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 30) || fallback;

function snowflakeToMs(id) {
  try { return Number((BigInt(id) >> 22n) + 1420070400000n); } catch { return Date.now(); }
}

function avatarUrl(u, size = 64) {
  if (u?.avatar) return `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=${size}`;
  let idx = 0;
  try { idx = Number((BigInt(u?.id || 0) >> 22n) % 6n); } catch { /* domyślny awatar */ }
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

function fmtDuration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'mniej niż minuta';
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return [d && `${d} d`, h && `${h} godz.`, !d && mm && `${mm} min`].filter(Boolean).join(' ');
}

const fillTemplate = (str, vars) => String(str).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));

function buildChannelName(template, vars) {
  const raw = String(template).replace(/\{(\w+)\}/g, (_, k) => (k === 'number' ? vars[k] : slug(vars[k], '')));
  return raw.replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'ticket';
}

const makeTopic = (ownerId, typeId, state, number, panelMode) =>
  `ticket|${ownerId}|${typeId}|${state}|${number}${panelMode ? `|${panelMode}` : ''}`;

function parseTicketChannel(channel) {
  if (!channel?.topic?.startsWith('ticket|')) return null;
  const [, ownerId, typeId, state, number, panelMode] = channel.topic.split('|');
  return { channel, ownerId, typeId, state: state || 'open', number: parseInt(number, 10) || 0, panelMode };
}

async function getTicket(channelId) {
  const channel = await discord('GET', `/channels/${channelId}`);
  return parseTicketChannel(channel);
}

const makeCtx = (interaction) => ({
  appId: interaction.application_id,
  guildId: interaction.guild_id,
  actorId: interaction.member.user.id
});

// Kolejka: dwa równoległe tworzenia ticketów na jednym serwerze nie dostaną tego samego numeru
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

// Kolejny numer = największy numer z istniejących kanałów i z ostatnich logów + 1
async function nextTicketNumber(t, channels) {
  let max = 0;
  for (const c of channels) {
    const p = parseTicketChannel(c);
    if (p) max = Math.max(max, p.number);
  }
  if (t.LOG_CHANNEL_ID) {
    const msgs = await discord('GET', `/channels/${t.LOG_CHANNEL_ID}/messages?limit=100`);
    for (const m of msgs || []) {
      for (const e of m.embeds || []) {
        const mm = /Ticket #(\d+)/.exec(e.footer?.text || '');
        if (mm) max = Math.max(max, parseInt(mm[1], 10));
      }
    }
  }
  return max + 1;
}

async function sendLog(t, embed, file) {
  if (!t.LOG_CHANNEL_ID) return;
  const payload = { embeds: [{ ...embed, timestamp: new Date().toISOString() }] };
  if (file && (await sendFile(t.LOG_CHANNEL_ID, payload, file.name, file.html))) return;
  await postMessage(t.LOG_CHANNEL_ID, payload);
}

const logFooter = (ticket, type) => ({ text: `Ticket #${pad(ticket.number)} • ${type.LABEL}` });

// ───────────────────────── Transkrypt ─────────────────────────

async function fetchAllMessages(channelId) {
  const all = [];
  let before;
  while (true) {
    const batch = await discord('GET', `/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ''}`);
    if (!batch || batch.length === 0) break;
    all.push(...batch);
    before = batch[batch.length - 1].id;
    if (batch.length < 100) break;
  }
  return all.reverse();
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Prosty markdown Discorda → HTML (pogrubienie, kursywa, kod, linki, wzmianki)
function mdToHtml(text, mentions = []) {
  let s = String(text || '');
  s = s.replace(/<@!?(\d+)>/g, (_, id) => '@' + (mentions.find(u => u.id === id)?.username || id));
  s = s.replace(/<@&\d+>/g, '@rola').replace(/<#\d+>/g, '#kanał').replace(/<a?:(\w+):\d+>/g, ':$1:');
  s = esc(s);
  s = s.replace(/```(?:\w+\n)?([\s\S]*?)```/g, (_, c) => `<pre>${c}</pre>`);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
  s = s.replace(/__([^_\n]+)__/g, '<u>$1</u>');
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  return s.replace(/\n/g, '<br>');
}

const fmtTime = (iso) => new Date(iso).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' });

const TRANSCRIPT_CSS = `
:root{color-scheme:dark}
body{margin:0;background:#1e1f22;color:#dbdee1;font:15px/1.45 "gg sans","Segoe UI",Arial,sans-serif}
.wrap{max-width:920px;margin:0 auto;padding:24px 16px 60px}
.head{background:#2b2d31;border-radius:10px;padding:18px 20px;margin-bottom:18px;border-left:4px solid #5865f2}
.head h1{margin:0 0 8px;font-size:20px;color:#fff}
.meta{display:flex;flex-wrap:wrap;gap:6px 24px;color:#b5bac1;font-size:13px}.meta b{color:#fff}
.msg{display:flex;gap:12px;padding:2px 8px;border-radius:6px}.msg:hover{background:#2e3035}.msg.first{margin-top:14px}
.av{width:40px;flex:none}.av img{width:40px;height:40px;border-radius:50%}
.body{min-width:0;flex:1}.name{font-weight:600;color:#fff}
.tag{background:#5865f2;color:#fff;border-radius:4px;font-size:10px;padding:1px 5px;margin-left:6px;vertical-align:middle}
.time{color:#949ba4;font-size:12px;margin-left:8px}
.txt{overflow-wrap:anywhere}.txt code{background:#111214;padding:1px 4px;border-radius:4px}
.txt pre{background:#111214;padding:8px;border-radius:6px;overflow:auto;margin:4px 0}
.embed{background:#2b2d31;border-left:4px solid #5865f2;border-radius:4px;padding:8px 12px;margin-top:6px;max-width:520px}
.embed .et{font-weight:600;color:#fff;margin-bottom:2px}.embed .ef{margin-top:4px}.embed .ef b{color:#fff}
.att img{max-width:420px;max-height:320px;border-radius:6px;margin-top:6px;display:block}
.empty{color:#949ba4;font-style:italic}a{color:#00a8fc}
`;

function buildTranscriptHtml(info, messages) {
  const authors = new Set(messages.map(m => m.author?.username).filter(Boolean));
  let prev = null;
  const rows = messages.map(m => {
    const grouped = prev && prev.author.id === m.author.id && new Date(m.timestamp) - new Date(prev.timestamp) < 7 * 60 * 1000;
    prev = m;
    const embeds = (m.embeds || []).map(e => {
      const color = e.color != null ? '#' + Number(e.color).toString(16).padStart(6, '0') : '#5865f2';
      return `<div class="embed" style="border-left-color:${esc(color)}">` +
        (e.title ? `<div class="et">${esc(e.title)}</div>` : '') +
        (e.description ? `<div>${mdToHtml(e.description)}</div>` : '') +
        (e.fields || []).map(f => `<div class="ef"><b>${esc(f.name)}</b><br>${mdToHtml(f.value)}</div>`).join('') +
        (e.footer?.text ? `<div class="time" style="margin:6px 0 0">${esc(e.footer.text)}</div>` : '') + `</div>`;
    }).join('');
    const atts = (m.attachments || []).map(a =>
      /^image\//.test(a.content_type || '')
        ? `<div class="att"><a href="${esc(a.url)}"><img src="${esc(a.url)}" alt="${esc(a.filename)}"></a></div>`
        : `<div class="att"><a href="${esc(a.url)}">📎 ${esc(a.filename)}</a></div>`).join('');
    const text = m.content ? `<div class="txt">${mdToHtml(m.content, m.mentions)}</div>` : '';
    const empty = !m.content && !embeds && !atts ? '<div class="empty">(brak treści)</div>' : '';
    const header = grouped ? '' :
      `<div><span class="name">${esc(m.author.global_name || m.author.username)}</span>${m.author.bot ? '<span class="tag">BOT</span>' : ''}<span class="time">${esc(fmtTime(m.timestamp))}</span></div>`;
    return `<div class="msg${grouped ? '' : ' first'}"><div class="av">${grouped ? '' : `<img src="${esc(avatarUrl(m.author))}" alt="">`}</div><div class="body">${header}${text}${embeds}${atts}${empty}</div></div>`;
  }).join('\n');

  return `<!DOCTYPE html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Transkrypt #${esc(info.name)}</title><style>${TRANSCRIPT_CSS}</style></head><body><div class="wrap">
<div class="head"><h1>Transkrypt ticketu #${esc(info.name)}</h1><div class="meta">
<span><b>Serwer:</b> ${esc(info.guildName)}</span>
<span><b>Kategoria:</b> ${esc(info.typeLabel)}</span>
<span><b>Numer:</b> #${pad(info.number)}</span>
<span><b>Właściciel:</b> ${esc(info.ownerName)}</span>
<span><b>Otwarty:</b> ${esc(fmtTime(info.openedAt))}</span>
<span><b>Wygenerowany:</b> ${esc(fmtTime(Date.now()))}</span>
<span><b>Wiadomości:</b> ${messages.length}</span>
<span><b>Uczestnicy:</b> ${esc([...authors].join(', ') || '—')}</span>
</div></div>
${rows}
</div></body></html>`;
}

async function makeTranscript(ctx, ticket, type, messages) {
  const [owner, guildName] = await Promise.all([discord('GET', `/users/${ticket.ownerId}`), getGuildName(ctx.guildId)]);
  return {
    name: `transcript-${ticket.channel.name}.html`,
    html: buildTranscriptHtml({
      name: ticket.channel.name,
      number: ticket.number,
      typeLabel: type.LABEL,
      ownerName: owner?.global_name || owner?.username || ticket.ownerId,
      guildName,
      openedAt: snowflakeToMs(ticket.channel.id)
    }, messages)
  };
}

// ───────────────────────── Panel ─────────────────────────

// Komponenty obu paneli używają list rozwijanych z osobnymi kategoriami.
function buildPanelComponents(t, mode, placeholder) {
  const types = getPanelTypes(t, mode);
  const section = panelSection(t, mode);
  return [row({
    type: 3,
    custom_id: mode === 'ftd' ? 'tkt_select' : 'tkt_select_command',
    placeholder: String(placeholder || section.PLACEHOLDER || t.PLACEHOLDER || 'Wybierz kategorię...').slice(0, 150),
    min_values: 1,
    max_values: 1,
    options: types.map(ty => {
      const em = parseEmoji(ty.EMOJI);
      return {
        label: String(ty.LABEL).slice(0, 100),
        value: String(ty.ID).slice(0, 100),
        ...(ty.DESCRIPTION ? { description: String(ty.DESCRIPTION).slice(0, 100) } : {}),
        ...(em ? { emoji: em } : {})
      };
    })
  })];
}

// Formularz otwarcia ticketu dla wybranego trybu panelu.
const ticketModal = (t, type, mode) => ({
  type: 9,
  data: {
    custom_id: `tkt_modal_${mode}_${type.ID}`,
    title: `Nowy ticket — ${type.LABEL}`.slice(0, 45),
    components: getFields(t, type, mode).map(textInput)
  }
});

const closeModal = () => ({
  type: 9,
  data: {
    custom_id: 'tkt_closemodal',
    title: 'Zamknięcie ticketu',
    components: [textInput({ ID: 'powod', LABEL: 'Powód zamknięcia (opcjonalnie)', STYLE: 'paragraph', MAX_LENGTH: 500, PLACEHOLDER: 'np. Sprawa rozwiązana' }, false)]
  }
});

// ───────────────────────── Akcje na ticketach ─────────────────────────

const CREATE_ERRORS = {
  50013: 'Bot nie ma wymaganych uprawnień (**Zarządzanie kanałami** i **Zarządzanie rolami**) albo jego rola jest za nisko.',
  50001: 'Bot nie ma dostępu do wskazanej kategorii kanałów.',
  30013: 'Kategoria jest pełna (limit Discorda to 50 kanałów w kategorii).',
  50035: 'Któreś ID w konfiguracji `TICKETS` jest nieprawidłowe (kategoria kanałów lub rola supportu).',
  10003: 'Kategoria kanałów z konfiguracji nie istnieje.'
};

function createTicket(interaction, guildConfig, t, type, mode, answers, values) {
  return withLock(`create:${interaction.guild_id}`, () => createTicketLocked(interaction, guildConfig, t, type, mode, answers, values));
}

async function createTicketLocked(interaction, guildConfig, t, type, mode, answers, values) {
  const guildId = interaction.guild_id;
  const user = interaction.member.user;
  const panelMode = mode === 'l' ? 'ftd' : 'command';

  const denied = checkAccess(interaction, guildConfig, t, type);
  if (denied) return { error: denied };

  const categoryId = pickPanel(t, type, panelMode, 'CATEGORY_ID');
  if (!categoryId) return { error: `❌ Brak CATEGORY_ID w konfiguracji ticketów (ustaw w TICKETS.${panelMode.toUpperCase()}, globalnie w TICKETS albo w danej kategorii).` };

  const channels = await discord('GET', `/guilds/${guildId}/channels`);
  if (!channels) return { error: '❌ Nie udało się pobrać listy kanałów. Sprawdź uprawnienia bota.' };

  // Limit otwartych ticketów: per kategoria (gdy ustawiono MAX_PER_USER w kategorii) albo łącznie
  const perType = type.MAX_PER_USER != null;
  const max = perType ? type.MAX_PER_USER : (t.MAX_PER_USER ?? 1);
  const mine = channels.map(parseTicketChannel).filter(p => p && p.ownerId === user.id && p.state === 'open' && (!perType || p.typeId === String(type.ID)));
  if (max > 0 && mine.length >= max) {
    return { error: `❌ Masz już otwarty ticket${perType ? ' w tej kategorii' : ''}: ${mine.map(p => `<#${p.channel.id}>`).join(', ')}` };
  }

  const number = await nextTicketNumber(t, channels);
  const support = type.SUPPORT_ROLE_IDS || [];

  // Domyślna nazwa: ID kategorii + numer odznaki z formularza (np. "raport_ftd-123").
  // Gdy formularz nie ma pola "odznaka" (np. domyślne pola Command bez własnych FIELDS),
  // ticket wraca do nazwy z numerem ticketu: "{type}-{number}".
  const defaultChannelName = values.odznaka ? '{type}-{odznaka}' : '{type}-{number}';
  const name = buildChannelName(pick(t, type, 'CHANNEL_NAME') || defaultChannelName, {
    ...values, type: type.ID, number: pad(number), username: user.username
  });

  const overwrites = [
    { id: guildId, type: 0, allow: '0', deny: String(PERM.VIEW) },
    { id: user.id, type: 1, allow: String(MEMBER_ALLOW), deny: '0' },
    { id: interaction.application_id, type: 1, allow: String(MEMBER_ALLOW), deny: '0' },
    ...support.map(id => ({ id, type: 0, allow: String(MEMBER_ALLOW), deny: '0' }))
  ];

  const created = await discordRaw('POST', `/guilds/${guildId}/channels`, {
    name, type: 0, parent_id: categoryId,
    topic: makeTopic(user.id, type.ID, 'open', number, panelMode),
    permission_overwrites: overwrites
  });
  if (!created.ok) {
    const hint = CREATE_ERRORS[created.data?.code] || 'Sprawdź logi bota.';
    return { error: `❌ Nie udało się utworzyć ticketu. ${hint}` };
  }
  const channel = created.data;

  const supportMentions = support.map(roleId => `<@&${roleId}>`).join(', ');
  const vars = { user: `<@${user.id}>`, type: type.LABEL, number: pad(number), support: supportMentions || 'obsługa', ...values };
  const pingSupport = pick(t, type, 'PING_SUPPORT') !== false && support.length > 0;

  const sent = await postMessage(channel.id, {
    content: `<@${user.id}>${pingSupport ? ' ' + support.map(r => `<@&${r}>`).join(' ') : ''}`,
    allowed_mentions: { users: [user.id], roles: pingSupport ? support : [] },
    embeds: [{
      author: { name: user.global_name || user.username, icon_url: avatarUrl(user) },
      title: `${name} - ${type.LABEL}`,
      description: fillTemplate(pick(t, type, 'WELCOME_MESSAGE') ||
        'Dziękujemy za zgłoszenie, {user}! Zespół {support} zajmie się Twoją sprawą najszybciej, jak to możliwe. Możesz w międzyczasie dopisać dodatkowe informacje lub dodać załączniki.', vars),
      color: parseColor(type.COLOR) ?? COLORS.blue,
      fields: [...answers, { name: STATUS_FIELD, value: '⏳ Oczekuje na obsługę' }],
      footer: { text: `Ticket #${pad(number)} • ${type.LABEL}` },
      timestamp: new Date().toISOString()
    }],
    components: [ticketControls()]
  });
  if (!sent) {
    await discord('DELETE', `/channels/${channel.id}`);
    return { error: '❌ Ticket został utworzony, ale nie udało się wysłać w nim wiadomości, więc go usunąłem. Sprawdź uprawnienia bota.' };
  }

  await notifyTicketOwner(user.id,
    `✅ Ticket **${name} - ${type.LABEL}** został utworzony.\nStatus: ⏳ Oczekuje na obsługę.\n` +
    `Otwórz ticket: https://discord.com/channels/${guildId}/${channel.id}\n` +
    'Możesz dopisać szczegóły i załączyć pliki bezpośrednio na kanale ticketu.');

  await sendLog(t, {
    title: '🎫 Ticket otwarty', color: COLORS.green,
    description: `**Kanał:** <#${channel.id}>\n**Użytkownik:** <@${user.id}>\n**Kategoria:** ${type.LABEL}\n` +
      answers.map(a => `**${a.name}:** ${a.value}`).join('\n'),
    footer: logFooter({ number }, type)
  });

  return { channel, number };
}

async function closeTicket(ctx, t, type, ticket, reason) {
  const ch = ticket.channel;
  const actor = ctx.actorId ? `<@${ctx.actorId}>` : '🤖 System (brak aktywności)';

  // Właściciel i dodani użytkownicy tracą dostęp (role supportu zostają)
  const members = (ch.permission_overwrites || []).filter(o => o.type === 1 && o.id !== ctx.appId);
  for (const o of members) {
    await discord('PUT', `/channels/${ch.id}/permissions/${o.id}`, { type: 1, allow: '0', deny: String(PERM.VIEW) });
  }

  const patch = { topic: makeTopic(ticket.ownerId, ticket.typeId, 'closed', ticket.number, ticket.panelMode) };
  const closedCategory = pick(t, type, 'CLOSED_CATEGORY_ID');
  if (closedCategory) patch.parent_id = closedCategory;
  if (!(await discord('PATCH', `/channels/${ch.id}`, patch))) return false;

  const openedMs = snowflakeToMs(ch.id);
  const duration = fmtDuration(Date.now() - openedMs);
  await postMessage(ch.id, {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: CLOSED_TITLE, color: COLORS.red,
      description: `Zamknięty przez ${actor} <t:${Math.floor(Date.now() / 1000)}:R>` + (reason ? `\n**Powód:** ${reason}` : ''),
      fields: [{ name: 'Czas trwania', value: duration, inline: true }],
      timestamp: new Date().toISOString()
    }],
    components: [closedControls()]
  });

  // Transkrypt → logi (+ DM do właściciela)
  const messages = await fetchAllMessages(ch.id);
  const transcript = await makeTranscript(ctx, ticket, type, messages);
  const sendFileToLog = t.TRANSCRIPT_ON_CLOSE !== false;

  await sendLog(t, {
    title: `🔒 Ticket zamknięty — #${ch.name}`, color: COLORS.red,
    fields: [
      { name: 'Kategoria', value: type.LABEL, inline: true },
      { name: 'Właściciel', value: `<@${ticket.ownerId}>`, inline: true },
      { name: 'Zamknął', value: actor, inline: true },
      { name: 'Czas trwania', value: duration, inline: true },
      { name: 'Wiadomości', value: String(messages.length), inline: true },
      { name: 'Powód', value: reason || '—' }
    ],
    footer: logFooter(ticket, type)
  }, sendFileToLog ? transcript : null);

  const dm = await openDM(ticket.ownerId);
  if (dm) {
    const guildName = await getGuildName(ctx.guildId);
    const embed = {
      title: '🔒 Twój ticket został zamknięty', color: COLORS.red,
      description: `**Ticket:** #${ch.name} (${type.LABEL})\n**Zamknął:** ${actor}\n**Powód:** ${reason || '—'}`,
      footer: { text: guildName }, timestamp: new Date().toISOString()
    };
    if (!(await sendFile(dm, { embeds: [embed] }, transcript.name, transcript.html))) {
      await postMessage(dm, { embeds: [embed] });
    }
  }
  return true;
}

async function reopenTicket(ctx, t, type, ticket) {
  const ch = ticket.channel;

  const denied = (ch.permission_overwrites || []).filter(o => o.type === 1 && (BigInt(o.deny) & BigInt(PERM.VIEW)) !== 0n);
  for (const o of denied) {
    await discord('PUT', `/channels/${ch.id}/permissions/${o.id}`, { type: 1, allow: String(MEMBER_ALLOW), deny: '0' });
  }

  const patch = { topic: makeTopic(ticket.ownerId, ticket.typeId, 'open', ticket.number, ticket.panelMode) };
  const category = ticket.panelMode
    ? pickPanel(t, type, ticket.panelMode, 'CATEGORY_ID')
    : pick(t, type, 'CATEGORY_ID');
  if (category) patch.parent_id = category;
  if (!(await discord('PATCH', `/channels/${ch.id}`, patch))) return false;

  await postMessage(ch.id, {
    content: `<@${ticket.ownerId}>`,
    allowed_mentions: { users: [ticket.ownerId] },
    embeds: [{ title: '🔓 Ticket otwarty ponownie', color: COLORS.green, description: `Otworzony przez <@${ctx.actorId}>`, timestamp: new Date().toISOString() }],
    components: [ticketControls()]
  });

  await sendLog(t, {
    title: '🔓 Ticket otwarty ponownie', color: COLORS.green,
    description: `**Kanał:** <#${ch.id}>\n**Otworzył:** <@${ctx.actorId}>`, footer: logFooter(ticket, type)
  });
  return true;
}

async function deleteTicket(ctx, t, type, ticket) {
  const ch = ticket.channel;
  const messages = await fetchAllMessages(ch.id);

  // Transkrypt był już zapisany przy zamknięciu. Zapisujemy nowy tylko, gdy po zamknięciu ktoś pisał.
  const last = messages[messages.length - 1];
  const activityAfterClose = !last || !(last.author?.id === ctx.appId && last.embeds?.[0]?.title === CLOSED_TITLE);

  await postMessage(ch.id, { content: '🗑️ Ticket zostanie usunięty za 5 sekund.' });

  const transcript = activityAfterClose ? await makeTranscript(ctx, ticket, type, messages) : null;
  await sendLog(t, {
    title: `🗑️ Ticket usunięty — #${ch.name}`, color: COLORS.red,
    description: `**Właściciel:** <@${ticket.ownerId}>\n**Usunął:** ${ctx.actorId ? `<@${ctx.actorId}>` : '🤖 System (automatyczne czyszczenie)'}\n**Wiadomości:** ${messages.length}` +
      (transcript ? '\n📄 Zapisano końcowy transkrypt (były wiadomości po zamknięciu).' : ''),
    footer: logFooter(ticket, type)
  }, transcript && t.TRANSCRIPT_ON_CLOSE !== false ? transcript : null);

  setTimeout(() => discord('DELETE', `/channels/${ch.id}`), 5000);
}

// ───────────────────────── Obsługa: komendy ─────────────────────────

async function handleCommand(interaction, guildConfig, t, res) {
  const { name, options } = interaction.data;
  const opts = {};
  (options || []).forEach(o => { opts[o.name] = o.value; });
  const userId = interaction.member.user.id;
  const chId = interaction.channel_id;

  deferEphemeral(res);
  const done = (content) => editOriginal(interaction, { content });

  if (name === 'ticket_panel') {
    if (!isAdmin(interaction, guildConfig)) return done('❌ Brak uprawnień.');
    const mode = opts.tryb || (t.PANEL_STYLE === 'ftd' ? 'ftd' : 'command');
    const P = panelSection(t, mode).PANEL || t.PANEL || {};
    const defaultDesc = 'Potrzebujesz pomocy? Wybierz kategorię z listy poniżej, aby otworzyć ticket. Prywatny kanał zostanie utworzony tylko dla Ciebie i administracji.';
    const sent = await postMessage(opts.kanal || chId, {
      embeds: [{
        title: opts.tytul || P.TITLE || '🎫 Centrum pomocy',
        description: opts.opis || P.DESCRIPTION || defaultDesc,
        color: parseColor(P.COLOR) ?? COLORS.blue,
        thumbnail: P.THUMBNAIL_URL ? { url: P.THUMBNAIL_URL } : undefined,
        image: P.IMAGE_URL ? { url: P.IMAGE_URL } : undefined,
        footer: P.FOOTER ? { text: P.FOOTER } : undefined
      }],
      components: buildPanelComponents(t, mode, opts.placeholder)
    });
    return done(sent
      ? `✅ Panel ticketów (${mode === 'ftd' ? 'FTD' : 'Command'} — lista rozwijana) wysłany na <#${opts.kanal || chId}>.`
      : '❌ Nie udało się wysłać panelu. Sprawdź uprawnienia bota na tym kanale oraz czy konfiguracja `TYPES` jest poprawna.');
  }

  // Pozostałe komendy działają tylko w kanale ticketu
  const ticket = await getTicket(chId);
  if (!ticket) return done('❌ Ta komenda działa tylko na kanale ticketu.');
  const type = ticketType(t, ticket);
  const staff = isTicketStaff(interaction, guildConfig, ticket);

  if (name === 'ticket_zamknij') {
    if (ticket.state === 'closed') return done('⚠️ Ten ticket jest już zamknięty.');
    if (userId !== ticket.ownerId && !staff) return done('❌ Brak uprawnień.');
    const ok = await closeTicket(makeCtx(interaction), t, type, ticket, opts.powod);
    return done(ok ? '✅ Ticket zamknięty.' : '❌ Nie udało się zamknąć ticketu (sprawdź uprawnienia bota).');
  }

  if (!staff) return done('❌ Tylko obsługa tego ticketu może użyć tej komendy.');

  if (name === 'ticket_dodaj') {
    if (ticket.state === 'closed') return done('⚠️ Ten ticket jest zamknięty — najpierw otwórz go ponownie.');
    const ok = await discord('PUT', `/channels/${chId}/permissions/${opts.user}`, { type: 1, allow: String(MEMBER_ALLOW), deny: '0' });
    if (!ok) return done('❌ Nie udało się dodać użytkownika.');
    await postMessage(chId, { content: `➕ <@${opts.user}> został dodany do ticketu przez <@${userId}>.`, allowed_mentions: { users: [opts.user] } });
    return done('✅ Dodano użytkownika.');
  }

  if (name === 'ticket_usun') {
    if (opts.user === ticket.ownerId) return done('❌ Nie możesz usunąć właściciela ticketu.');
    const ok = await discord('DELETE', `/channels/${chId}/permissions/${opts.user}`);
    if (!ok) return done('❌ Nie udało się usunąć użytkownika.');
    await postMessage(chId, { content: `➖ <@${opts.user}> został usunięty z ticketu przez <@${userId}>.`, allowed_mentions: { parse: [] } });
    return done('✅ Usunięto użytkownika.');
  }

  if (name === 'ticket_nazwa') {
    const newName = slug(opts.nazwa);
    const ok = await discord('PATCH', `/channels/${chId}`, { name: newName });
    return done(ok ? `✅ Zmieniono nazwę na **${newName}**. (Discord limituje zmianę nazw do 2 na 10 minut.)` : '❌ Nie udało się zmienić nazwy.');
  }

  return done('❌ Nieznana komenda ticketów.');
}

// ───────────────────────── Obsługa: formularze ─────────────────────────

async function handleModal(interaction, guildConfig, t, res) {
  const id = interaction.data.custom_id;
  const userId = interaction.member.user.id;

  // Zamknięcie ticketu z powodem
  if (id === 'tkt_closemodal') {
    deferEphemeral(res);
    const ticket = await getTicket(interaction.channel_id);
    if (!ticket || ticket.state !== 'open') return editOriginal(interaction, { content: '⚠️ Ten ticket nie jest otwarty.' });
    if (userId !== ticket.ownerId && !isTicketStaff(interaction, guildConfig, ticket)) {
      return editOriginal(interaction, { content: '❌ Nie masz uprawnień do zamknięcia tego ticketu.' });
    }
    const reason = (interaction.data.components?.[0]?.components?.[0]?.value || '').trim();
    const ok = await closeTicket(makeCtx(interaction), t, ticketType(t, ticket), ticket, reason);
    return editOriginal(interaction, { content: ok ? '✅ Ticket zamknięty.' : '❌ Nie udało się zamknąć ticketu (sprawdź uprawnienia bota).' });
  }

  // Otwarcie ticketu — custom_id: tkt_modal_<tryb>_<ID kategorii>, gdzie tryb: l = lista, b = przycisk
  if (!id.startsWith('tkt_modal_')) return reply(res, '❌ Nieznany formularz.');
  deferEphemeral(res);

  const rest = id.slice('tkt_modal_'.length);
  const hasMode = (rest[0] === 'l' || rest[0] === 'b') && rest[1] === '_';
  const mode = hasMode ? rest[0] : 'b';
  const type = findType(t, hasMode ? rest.slice(2) : rest);
  if (!type) return editOriginal(interaction, { content: '❌ Nieznany typ ticketu.' });

  const values = {};
  for (const r of interaction.data.components || []) for (const c of r.components || []) values[c.custom_id] = (c.value || '').trim();

  const answers = getFields(t, type, mode).map(f => {
    const value = String(values[f.ID] || '—').slice(0, 1024);
    return { name: String(f.LABEL).slice(0, 256), value, inline: !isParagraph(f) && value.length <= 40 };
  });

  const result = await createTicket(interaction, guildConfig, t, type, mode, answers, values);
  if (result.error) return editOriginal(interaction, { content: result.error });
  return editOriginal(interaction, { content: `✅ Twój ticket został utworzony: <#${result.channel.id}>` });
}

// ───────────────────────── Obsługa: przyciski i lista ─────────────────────────

async function handleButton(interaction, guildConfig, t, res) {
  const id = interaction.data.custom_id;
  const userId = interaction.member.user.id;
  const chId = interaction.channel_id;

  // Otwarcie ticketu (lista lub przycisk) → formularz
  if (id === 'tkt_select' || id === 'tkt_select_command' || id.startsWith('tkt_open_')) {
    const isSelect = id === 'tkt_select' || id === 'tkt_select_command';
    const mode = id === 'tkt_select_command' ? 'command' : 'ftd';
    const typeId = isSelect ? interaction.data.values?.[0] : id.slice('tkt_open_'.length);
    const type = findType(t, typeId);
    if (!type) return reply(res, '❌ Nieznana kategoria ticketu.');

    const denied = checkAccess(interaction, guildConfig, t, type);
    if (denied) reply(res, denied);
    else res.json(ticketModal(t, type, isSelect ? (mode === 'ftd' ? 'l' : 'b') : 'b'));

    // Zresetuj menu na panelu (inaczej Discord zostawia zaznaczoną opcję i nie da się jej wybrać ponownie)
    const msg = interaction.message;
    if (isSelect && msg?.id) {
      const placeholder = msg.components?.[0]?.components?.[0]?.placeholder;
      discord('PATCH', `/channels/${chId}/messages/${msg.id}`, { components: buildPanelComponents(t, mode, placeholder) });
    }
    return;
  }

  // Wszystkie pozostałe akcje działają na kanale ticketu
  const ticket = await getTicket(chId);
  if (!ticket) return reply(res, '❌ To nie jest kanał ticketu.');
  const type = ticketType(t, ticket);
  const staff = isTicketStaff(interaction, guildConfig, ticket);
  const isOwner = userId === ticket.ownerId;
  const ctx = makeCtx(interaction);
  const embed = interaction.message?.embeds?.[0];
  const claimedBy = () => {
    const status = embed?.fields?.find(f => f.name === STATUS_FIELD)?.value;
    const legacyClaim = embed?.fields?.find(f => f.name === CLAIM_FIELD)?.value;
    return /<@!?(\d+)>/.exec(status || legacyClaim || '')?.[1];
  };

  switch (id) {
    case 'tkt_close':
      if (ticket.state === 'closed') return reply(res, '⚠️ Ten ticket jest już zamknięty.');
      if (!isOwner && !staff) return reply(res, '❌ Nie masz uprawnień do zamknięcia tego ticketu.');
      return res.json(closeModal());

    case 'tkt_claim': {
      if (!staff) return reply(res, '❌ Tylko obsługa ticketu może go przejąć.');
      if (ticket.state !== 'open' || !embed) return reply(res, '❌ Nie można przejąć tego ticketu.');
      if (claimedBy()) return reply(res, `⚠️ Ten ticket jest już przejęty przez <@${claimedBy()}>.`);
      postMessage(chId, { content: `✋ <@${userId}> przejął(a) ten ticket.`, allowed_mentions: { parse: [] } });
      notifyTicketOwner(ticket.ownerId,
        `👋 Ticket **${ticket.channel.name}** został przejęty przez <@${userId}>. Obsługa zajmuje się Twoim zgłoszeniem.\n` +
        `Otwórz ticket: https://discord.com/channels/${interaction.guild_id}/${chId}`)
        .catch(e => console.error('[tickets] Powiadomienie DM o przejęciu nie powiodło się:', e));
      const fields = (embed.fields || []).filter(f => f.name !== STATUS_FIELD && f.name !== CLAIM_FIELD);
      fields.push({ name: STATUS_FIELD, value: `🟢 Przejęty przez <@${userId}>` });
      return res.json({
        type: 7,
        data: {
          embeds: [{ ...embed, fields }],
          components: [ticketControls(true)]
        }
      });
    }

    case 'tkt_unclaim': {
      const owner = claimedBy();
      if (!embed || !owner) return reply(res, '⚠️ Ten ticket nie jest przejęty.');
      if (userId !== owner && !isAdmin(interaction, guildConfig)) return reply(res, '❌ Tylko osoba, która przejęła ticket (lub administrator), może go zwolnić.');
      postMessage(chId, { content: `🔓 <@${userId}> zwolnił(a) ten ticket — czeka na nowego opiekuna.`, allowed_mentions: { parse: [] } });
      notifyTicketOwner(ticket.ownerId,
        `🔔 Obsługa zwolniła ticket **${ticket.channel.name}**. Zgłoszenie oczekuje teraz na obsługę.\n` +
        `Otwórz ticket: https://discord.com/channels/${interaction.guild_id}/${chId}`)
        .catch(e => console.error('[tickets] Powiadomienie DM o zwolnieniu nie powiodło się:', e));
      const fields = (embed.fields || []).filter(f => f.name !== STATUS_FIELD && f.name !== CLAIM_FIELD);
      fields.push({ name: STATUS_FIELD, value: '⏳ Oczekuje na obsługę' });
      return res.json({
        type: 7,
        data: {
          embeds: [{ ...embed, fields }],
          components: [ticketControls(false)]
        }
      });
    }

    case 'tkt_reopen': {
      if (!staff) return reply(res, '❌ Tylko obsługa ticketu może otworzyć go ponownie.');
      deferEphemeral(res);
      if (ticket.state !== 'closed') return editOriginal(interaction, { content: '⚠️ Ten ticket nie jest zamknięty.' });
      const ok = await reopenTicket(ctx, t, type, ticket);
      if (ok && interaction.message?.id) await discord('PATCH', `/channels/${chId}/messages/${interaction.message.id}`, { components: [] });
      return editOriginal(interaction, { content: ok ? '✅ Ticket otwarty ponownie.' : '❌ Nie udało się otworzyć ticketu.' });
    }

    case 'tkt_transcript': {
      if (!staff) return reply(res, '❌ Tylko obsługa ticketu może wygenerować transkrypt.');
      deferEphemeral(res);
      const messages = await fetchAllMessages(chId);
      const transcript = await makeTranscript(ctx, ticket, type, messages);
      const ok = await sendFile(chId, { content: `📄 Transkrypt (${messages.length} wiadomości) na prośbę <@${userId}>:`, allowed_mentions: { parse: [] } }, transcript.name, transcript.html);
      return editOriginal(interaction, { content: ok ? '✅ Transkrypt wysłany na kanał.' : '❌ Nie udało się wysłać transkryptu.' });
    }

    case 'tkt_delete': {
      const allowed = t.DELETE_REQUIRES_ADMIN ? isAdmin(interaction, guildConfig) : staff;
      if (!allowed) return reply(res, t.DELETE_REQUIRES_ADMIN ? '❌ Ticket może usunąć tylko administrator.' : '❌ Tylko obsługa ticketu może go usunąć.');
      return res.json({ type: 4, data: { content: '🗑️ Na pewno chcesz **trwale usunąć** ten ticket? Transkrypt jest zapisany w logach.', flags: 64, components: [confirmRow('tkt_delete_yes', 'tkt_delete_no')] } });
    }

    case 'tkt_delete_no':
      return res.json({ type: 7, data: { content: 'Anulowano.', components: [] } });

    case 'tkt_delete_yes': {
      deferUpdate(res);
      const allowed = t.DELETE_REQUIRES_ADMIN ? isAdmin(interaction, guildConfig) : staff;
      if (!allowed) return editOriginal(interaction, { content: '❌ Nie możesz usunąć tego ticketu.', components: [] });
      await deleteTicket(ctx, t, type, ticket);
      return editOriginal(interaction, { content: '✅ Ticket zostanie usunięty za chwilę.', components: [] });
    }
  }

  return reply(res, '❌ Nieznana akcja ticketu.');
}

// ───────────────────────── Główny punkt wejścia ─────────────────────────
// Zwraca true, jeśli interakcja należała do systemu ticketów (i została obsłużona).

export async function handleTicketInteraction(interaction, guildConfig, res) {
  const customId = interaction.data?.custom_id;
  const isCommand = interaction.type === 2 && interaction.data?.name?.startsWith('ticket_');
  const isTicketComponent = (interaction.type === 3 || interaction.type === 5) && customId?.startsWith('tkt_');
  if (!isCommand && !isTicketComponent) return false;

  const t = guildConfig.TICKETS;
  if (!t) {
    reply(res, '❌ System ticketów nie jest skonfigurowany na tym serwerze (brak sekcji `TICKETS`).');
    return true;
  }

  try {
    if (isCommand) await handleCommand(interaction, guildConfig, t, res);
    else if (interaction.type === 5) await handleModal(interaction, guildConfig, t, res);
    else await handleButton(interaction, guildConfig, t, res);
  } catch (e) {
    console.error('[tickets] Błąd:', e);
    if (!res.headersSent) reply(res, '❌ Wystąpił błąd systemu ticketów.');
    else editOriginal(interaction, { content: '❌ Wystąpił błąd systemu ticketów.', components: [] });
  }
  return true;
}
