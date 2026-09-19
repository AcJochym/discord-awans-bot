// tickets.js — system ticketów w stylu Ticket Tool (bot oparty o HTTP Interactions)
// Stan ticketu jest przechowywany w temacie kanału: "ticket|<ownerId>|<typeId>|open/closed"
// dzięki czemu bot nie potrzebuje bazy danych i przeżywa restarty.

import fetch from 'node-fetch';

const API = 'https://discord.com/api/v10';

const PERM = { VIEW: 1 << 10, SEND: 1 << 11, EMBED: 1 << 14, ATTACH: 1 << 15, HISTORY: 1 << 16 };
const MEMBER_ALLOW = PERM.VIEW | PERM.SEND | PERM.EMBED | PERM.ATTACH | PERM.HISTORY;

const COLORS = { blue: 3447003, green: 5763719, red: 15158332, orange: 16753920 };

// ───────────────────────── REST helpers ─────────────────────────

async function discord(method, path, body, attempt = 0) {
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    if (res.status === 429 && attempt < 2) {
      const data = await res.json().catch(() => ({}));
      await new Promise(r => setTimeout(r, Math.min(data.retry_after || 1, 5) * 1000));
      return discord(method, path, body, attempt + 1);
    }
    if (!res.ok) {
      console.error(`[tickets] ${method} ${path}: HTTP ${res.status} ${await res.text()}`);
      return null;
    }
    if (res.status === 204) return true;
    return await res.json();
  } catch (e) {
    console.error(`[tickets] ${method} ${path}:`, e);
    return null;
  }
}

const postMessage = (channelId, payload) => discord('POST', `/channels/${channelId}/messages`, payload);

// Edycja odpowiedzi na interakcję (po wcześniejszym "defer")
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

// Wysyłanie wiadomości z plikiem (multipart) — używa wbudowanego fetch (Node 18+)
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
const btn = (label, style, custom_id, emoji) => {
  const em = parseEmoji(emoji);
  return { type: 2, label, style, custom_id, ...(em ? { emoji: em } : {}) };
};
const row = (...components) => ({ type: 1, components });
const ticketControls = () => row(btn('Zamknij', 4, 'tkt_close', '🔒'), btn('Przejmij', 3, 'tkt_claim', '✋'));
const closedControls = () => row(btn('Otwórz ponownie', 3, 'tkt_reopen', '🔓'), btn('Transkrypt', 2, 'tkt_transcript', '📄'), btn('Usuń', 4, 'tkt_delete', '🗑️'));
const confirmRow = (yes, no) => row(btn('Tak', 4, yes), btn('Anuluj', 2, no));

const textInput = (custom_id, label, style, max_length) => row({ type: 4, custom_id, label, style, required: true, max_length });

// ───────────────────────── Pomocnicze ─────────────────────────

const getTypes = (t) => (t.TYPES && t.TYPES.length ? t.TYPES : [{ ID: 'ogolny', LABEL: 'Otwórz ticket', EMOJI: '🎫' }]).slice(0, 25);

// Komponenty panelu: 'przyciski' (do 25, po 5 w rzędzie) albo 'lista' (rozwijane menu, do 25 opcji)
function buildPanelComponents(t, mode, placeholder) {
  const types = getTypes(t);
  if (mode === 'lista') {
    return [row({
      type: 3,
      custom_id: 'tkt_select',
      placeholder: String(placeholder || t.PLACEHOLDER || 'Wybierz kategorię...').slice(0, 150),
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
  const buttons = types.map(ty => btn(ty.LABEL, 1, `tkt_open_${ty.ID}`, ty.EMOJI));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(row(...buttons.slice(i, i + 5)));
  return rows;
}

// Formularz otwarcia ticketu (wspólny dla przycisku i listy)
const ticketModal = (type) => ({
  type: 9,
  data: {
    custom_id: `tkt_modal_${type.ID}`,
    title: `Nowy ticket — ${type.LABEL}`.slice(0, 45),
    components: [textInput('temat', 'Temat', 1, 100), textInput('opis', 'Opisz swoją sprawę', 2, 1000)]
  }
});

const memberRoles = (i) => i.member?.roles || [];
const isAdmin = (i, g) => (g.REQUIRED_ROLE_IDS || []).some(r => memberRoles(i).includes(r));
const isStaff = (i, g, t) => isAdmin(i, g) || (t.SUPPORT_ROLE_IDS || []).some(r => memberRoles(i).includes(r));

const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'ticket';

// Odczyt stanu ticketu z tematu kanału
async function getTicket(channelId) {
  const channel = await discord('GET', `/channels/${channelId}`);
  if (!channel?.topic?.startsWith('ticket|')) return null;
  const [, ownerId, typeId, state] = channel.topic.split('|');
  return { channel, ownerId, typeId, state: state || 'open' };
}

async function logEvent(t, embed) {
  if (!t.LOG_CHANNEL_ID) return;
  await postMessage(t.LOG_CHANNEL_ID, { embeds: [{ ...embed, timestamp: new Date().toISOString() }] });
}

// ───────────────────────── Transkrypt ─────────────────────────

async function fetchAllMessages(channelId, limit = 1000) {
  const all = [];
  let before;
  while (all.length < limit) {
    const batch = await discord('GET', `/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ''}`);
    if (!batch || batch.length === 0) break;
    all.push(...batch);
    before = batch[batch.length - 1].id;
    if (batch.length < 100) break;
  }
  return all.reverse();
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function buildTranscriptHtml(channelName, messages) {
  const rows = messages.map(m => {
    const content = (m.content || '').replace(/<@!?(\d+)>/g, (_, id) => '@' + (m.mentions?.find(u => u.id === id)?.username || id));
    const time = new Date(m.timestamp).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' });
    const embeds = (m.embeds || []).map(e =>
      `<div class="embed"><b>${esc(e.title || '')}</b><br>${esc(e.description || '').replace(/\n/g, '<br>')}` +
      (e.fields || []).map(f => `<br><b>${esc(f.name)}:</b> ${esc(f.value)}`).join('') + `</div>`).join('');
    const atts = (m.attachments || []).map(a => `<div><a href="${esc(a.url)}">📎 ${esc(a.filename)}</a></div>`).join('');
    return `<div class="msg"><span class="author${m.author.bot ? ' bot' : ''}">${esc(m.author.username)}</span> <span class="time">${esc(time)}</span>` +
      `<div>${esc(content).replace(/\n/g, '<br>')}</div>${embeds}${atts}</div>`;
  }).join('\n');

  return `<!DOCTYPE html><html lang="pl"><head><meta charset="utf-8"><title>Transkrypt #${esc(channelName)}</title>
<style>
body{background:#313338;color:#dbdee1;font-family:Arial,sans-serif;max-width:900px;margin:0 auto;padding:20px}
h1{font-size:20px}.msg{padding:8px 0;border-bottom:1px solid #3f4147}
.author{font-weight:bold;color:#fff}.author.bot{color:#5865f2}.time{font-size:12px;color:#949ba4;margin-left:6px}
.embed{border-left:4px solid #5865f2;background:#2b2d31;padding:8px;margin-top:4px;border-radius:4px}a{color:#00a8fc}
</style></head><body><h1>Transkrypt ticketu #${esc(channelName)}</h1><p>Wiadomości: ${messages.length}</p>${rows}</body></html>`;
}

// ───────────────────────── Akcje na ticketach ─────────────────────────

async function createTicket(interaction, guildConfig, t, type, fields) {
  const guildId = interaction.guild_id;
  const user = interaction.member.user;

  if (!t.CATEGORY_ID) return { error: '❌ Brak `TICKETS.CATEGORY_ID` w konfiguracji serwera.' };

  const channels = await discord('GET', `/guilds/${guildId}/channels`);
  if (!channels) return { error: '❌ Nie udało się pobrać listy kanałów. Sprawdź uprawnienia bota.' };

  const max = t.MAX_PER_USER ?? 1;
  const mine = channels.filter(c => c.topic?.startsWith(`ticket|${user.id}|`) && c.topic.endsWith('|open'));
  if (mine.length >= max) {
    return { error: `❌ Masz już otwarty ticket: ${mine.map(c => `<#${c.id}>`).join(', ')}` };
  }

  const support = t.SUPPORT_ROLE_IDS || [];
  const overwrites = [
    { id: guildId, type: 0, allow: '0', deny: String(PERM.VIEW) },
    { id: user.id, type: 1, allow: String(MEMBER_ALLOW), deny: '0' },
    { id: interaction.application_id, type: 1, allow: String(MEMBER_ALLOW), deny: '0' },
    ...support.map(id => ({ id, type: 0, allow: String(MEMBER_ALLOW), deny: '0' }))
  ];

  const channel = await discord('POST', `/guilds/${guildId}/channels`, {
    name: `${slug(type.ID)}-${slug(user.username)}`,
    type: 0,
    parent_id: t.CATEGORY_ID,
    topic: `ticket|${user.id}|${type.ID}|open`,
    permission_overwrites: overwrites
  });
  if (!channel) return { error: '❌ Nie udało się utworzyć kanału. Bot potrzebuje uprawnień **Zarządzanie kanałami** i **Zarządzanie rolami**, a kategoria nie może być pełna (limit 50 kanałów).' };

  const pings = t.PING_SUPPORT !== false ? support.map(r => `<@&${r}>`).join(' ') : '';
  await postMessage(channel.id, {
    content: `<@${user.id}> ${pings}`.trim(),
    allowed_mentions: { users: [user.id], roles: t.PING_SUPPORT !== false ? support : [] },
    embeds: [{
      title: `${type.EMOJI || '🎫'} Ticket — ${type.LABEL}`,
      color: COLORS.blue,
      description: t.WELCOME_MESSAGE || 'Dziękujemy za kontakt! Ktoś z administracji wkrótce się z Tobą skontaktuje. W międzyczasie opisz dokładnie swoją sprawę.',
      fields: [{ name: 'Temat', value: fields.temat || '—' }, { name: 'Opis', value: fields.opis || '—' }],
      footer: { text: `Ticket użytkownika ${user.username}` },
      timestamp: new Date().toISOString()
    }],
    components: [ticketControls()]
  });

  await logEvent(t, {
    title: '🎫 Ticket otwarty', color: COLORS.green,
    description: `**Kanał:** <#${channel.id}>\n**Użytkownik:** <@${user.id}>\n**Typ:** ${type.LABEL}\n**Temat:** ${fields.temat || '—'}`
  });

  return { channel };
}

async function closeTicket(interaction, t, ticket, reason) {
  const chId = ticket.channel.id;
  const closer = interaction.member.user.id;

  // Zabierz dostęp właścicielowi i dodanym użytkownikom (role supportu zostają)
  const members = (ticket.channel.permission_overwrites || []).filter(o => o.type === 1 && o.id !== interaction.application_id);
  for (const o of members) {
    await discord('PUT', `/channels/${chId}/permissions/${o.id}`, { type: 1, allow: '0', deny: String(PERM.VIEW) });
  }

  const patch = { topic: `ticket|${ticket.ownerId}|${ticket.typeId}|closed` };
  if (t.CLOSED_CATEGORY_ID) patch.parent_id = t.CLOSED_CATEGORY_ID;
  const patched = await discord('PATCH', `/channels/${chId}`, patch);
  if (!patched) return false;

  await postMessage(chId, {
    embeds: [{
      title: '🔒 Ticket zamknięty', color: COLORS.red,
      description: `Zamknięty przez <@${closer}>` + (reason ? `\n**Powód:** ${reason}` : ''),
      timestamp: new Date().toISOString()
    }],
    components: [closedControls()]
  });

  await logEvent(t, {
    title: '🔒 Ticket zamknięty', color: COLORS.red,
    description: `**Kanał:** <#${chId}>\n**Właściciel:** <@${ticket.ownerId}>\n**Zamknął:** <@${closer}>` + (reason ? `\n**Powód:** ${reason}` : '')
  });
  return true;
}

async function reopenTicket(interaction, t, ticket) {
  const chId = ticket.channel.id;
  const opener = interaction.member.user.id;

  const denied = (ticket.channel.permission_overwrites || []).filter(o => o.type === 1 && (BigInt(o.deny) & BigInt(PERM.VIEW)) !== 0n);
  for (const o of denied) {
    await discord('PUT', `/channels/${chId}/permissions/${o.id}`, { type: 1, allow: String(MEMBER_ALLOW), deny: '0' });
  }

  const patch = { topic: `ticket|${ticket.ownerId}|${ticket.typeId}|open` };
  if (t.CATEGORY_ID) patch.parent_id = t.CATEGORY_ID;
  const patched = await discord('PATCH', `/channels/${chId}`, patch);
  if (!patched) return false;

  await postMessage(chId, {
    content: `<@${ticket.ownerId}>`,
    allowed_mentions: { users: [ticket.ownerId] },
    embeds: [{ title: '🔓 Ticket otwarty ponownie', color: COLORS.green, description: `Otworzony przez <@${opener}>`, timestamp: new Date().toISOString() }],
    components: [ticketControls()]
  });

  await logEvent(t, { title: '🔓 Ticket otwarty ponownie', color: COLORS.green, description: `**Kanał:** <#${chId}>\n**Otworzył:** <@${opener}>` });
  return true;
}

async function deleteTicket(interaction, t, ticket) {
  const chId = ticket.channel.id;
  const name = ticket.channel.name;
  const staffId = interaction.member.user.id;

  await postMessage(chId, { content: '🗑️ Ticket zostanie usunięty za 5 sekund. Zapisuję transkrypt...' });

  const messages = await fetchAllMessages(chId);
  const html = buildTranscriptHtml(name, messages);
  const filename = `transcript-${name}.html`;

  if (t.LOG_CHANNEL_ID) {
    await sendFile(t.LOG_CHANNEL_ID, {
      embeds: [{
        title: '🗑️ Ticket usunięty', color: COLORS.red,
        description: `**Ticket:** #${name}\n**Właściciel:** <@${ticket.ownerId}>\n**Usunął:** <@${staffId}>\n**Wiadomości:** ${messages.length}`,
        timestamp: new Date().toISOString()
      }]
    }, filename, html);
  }

  if (t.DM_TRANSCRIPT) {
    const dm = await openDM(ticket.ownerId);
    if (dm) await sendFile(dm, { content: `📄 Transkrypt Twojego ticketu **#${name}**:` }, filename, html);
  }

  setTimeout(() => discord('DELETE', `/channels/${chId}`), 5000);
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
    const mode = opts.tryb || (t.PANEL_STYLE === 'lista' ? 'lista' : 'przyciski');
    const defaultDesc = mode === 'lista'
      ? 'Potrzebujesz pomocy? Wybierz kategorię z listy poniżej, aby otworzyć ticket. Prywatny kanał zostanie utworzony tylko dla Ciebie i administracji.'
      : 'Potrzebujesz pomocy? Kliknij przycisk poniżej, aby otworzyć ticket. Prywatny kanał zostanie utworzony tylko dla Ciebie i administracji.';
    const sent = await postMessage(opts.kanal || chId, {
      embeds: [{ title: opts.tytul || '🎫 Centrum pomocy', description: opts.opis || defaultDesc, color: COLORS.blue }],
      components: buildPanelComponents(t, mode, opts.placeholder)
    });
    return done(sent
      ? `✅ Panel ticketów (${mode === 'lista' ? 'lista rozwijana' : 'przyciski'}) wysłany na <#${opts.kanal || chId}>.`
      : '❌ Nie udało się wysłać panelu. Sprawdź uprawnienia bota na tym kanale oraz czy konfiguracja `TYPES` jest poprawna.');
  }

  // Pozostałe komendy działają tylko w kanale ticketu
  const ticket = await getTicket(chId);
  if (!ticket) return done('❌ Ta komenda działa tylko na kanale ticketu.');

  if (name === 'ticket_zamknij') {
    if (ticket.state === 'closed') return done('⚠️ Ten ticket jest już zamknięty.');
    if (userId !== ticket.ownerId && !isStaff(interaction, guildConfig, t)) return done('❌ Brak uprawnień.');
    const ok = await closeTicket(interaction, t, ticket, opts.powod);
    return done(ok ? '✅ Ticket zamknięty.' : '❌ Nie udało się zamknąć ticketu (sprawdź uprawnienia bota).');
  }

  if (!isStaff(interaction, guildConfig, t)) return done('❌ Tylko administracja może użyć tej komendy.');

  if (name === 'ticket_dodaj') {
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
    const ok = await discord('PATCH', `/channels/${chId}`, { name: slug(opts.nazwa) });
    return done(ok ? `✅ Zmieniono nazwę na **${slug(opts.nazwa)}**. (Discord limituje zmianę nazw do 2 na 10 minut.)` : '❌ Nie udało się zmienić nazwy.');
  }

  return done('❌ Nieznana komenda ticketów.');
}

// ───────────────────────── Obsługa: modal (otwarcie ticketu) ─────────────────────────

async function handleModal(interaction, guildConfig, t, res) {
  const id = interaction.data.custom_id;
  if (!id.startsWith('tkt_modal_')) return reply(res, '❌ Nieznany formularz.');

  deferEphemeral(res);

  const typeId = id.slice('tkt_modal_'.length);
  const type = getTypes(t).find(x => String(x.ID) === typeId);
  if (!type) return editOriginal(interaction, { content: '❌ Nieznany typ ticketu.' });

  const fields = {};
  for (const r of interaction.data.components || []) for (const c of r.components || []) fields[c.custom_id] = c.value;

  const result = await createTicket(interaction, guildConfig, t, type, fields);
  if (result.error) return editOriginal(interaction, { content: result.error });
  return editOriginal(interaction, { content: `✅ Twój ticket został utworzony: <#${result.channel.id}>` });
}

// ───────────────────────── Obsługa: przyciski ─────────────────────────

async function handleButton(interaction, guildConfig, t, res) {
  const id = interaction.data.custom_id;
  const userId = interaction.member.user.id;
  const chId = interaction.channel_id;
  const staff = isStaff(interaction, guildConfig, t);

  // Otwarcie ticketu z LISTY → formularz
  if (id === 'tkt_select') {
    const typeId = interaction.data.values?.[0];
    const type = getTypes(t).find(x => String(x.ID) === typeId);
    if (!type) return reply(res, '❌ Nieznana kategoria ticketu.');
    res.json(ticketModal(type));

    // Zresetuj menu na panelu (Discord inaczej zostawia zaznaczoną opcję i nie da się jej wybrać ponownie)
    const msg = interaction.message;
    if (msg?.id) {
      const placeholder = msg.components?.[0]?.components?.[0]?.placeholder;
      discord('PATCH', `/channels/${chId}/messages/${msg.id}`, { components: buildPanelComponents(t, 'lista', placeholder) });
    }
    return;
  }

  // Otwarcie ticketu z PRZYCISKU → formularz
  if (id.startsWith('tkt_open_')) {
    const typeId = id.slice('tkt_open_'.length);
    const type = getTypes(t).find(x => String(x.ID) === typeId);
    if (!type) return reply(res, '❌ Nieznany typ ticketu.');
    return res.json(ticketModal(type));
  }

  switch (id) {
    case 'tkt_close': {
      const ticket = await getTicket(chId);
      if (!ticket) return reply(res, '❌ To nie jest kanał ticketu.');
      if (ticket.state === 'closed') return reply(res, '⚠️ Ten ticket jest już zamknięty.');
      if (userId !== ticket.ownerId && !staff) return reply(res, '❌ Nie masz uprawnień do zamknięcia tego ticketu.');
      return res.json({ type: 4, data: { content: '🔒 Na pewno chcesz zamknąć ten ticket?', flags: 64, components: [confirmRow('tkt_close_yes', 'tkt_close_no')] } });
    }

    case 'tkt_close_no':
    case 'tkt_delete_no':
      return res.json({ type: 7, data: { content: 'Anulowano.', components: [] } });

    case 'tkt_close_yes': {
      deferUpdate(res);
      const ticket = await getTicket(chId);
      if (!ticket || ticket.state !== 'open' || (userId !== ticket.ownerId && !staff)) {
        return editOriginal(interaction, { content: '❌ Nie można zamknąć tego ticketu.', components: [] });
      }
      const ok = await closeTicket(interaction, t, ticket);
      return editOriginal(interaction, { content: ok ? '✅ Ticket zamknięty.' : '❌ Nie udało się zamknąć ticketu (sprawdź uprawnienia bota).', components: [] });
    }

    case 'tkt_claim': {
      if (!staff) return reply(res, '❌ Tylko administracja może przejąć ticket.');
      const embed = interaction.message?.embeds?.[0];
      if (!embed) return reply(res, '❌ Nie można przejąć tego ticketu.');
      postMessage(chId, { content: `✋ <@${userId}> przejął(a) ten ticket.`, allowed_mentions: { parse: [] } });
      return res.json({
        type: 7,
        data: {
          embeds: [{ ...embed, fields: [...(embed.fields || []), { name: '✋ Przejęte przez', value: `<@${userId}>` }] }],
          components: [row(btn('Zamknij', 4, 'tkt_close', '🔒'))]
        }
      });
    }

    case 'tkt_reopen': {
      if (!staff) return reply(res, '❌ Tylko administracja może ponownie otworzyć ticket.');
      deferEphemeral(res);
      const ticket = await getTicket(chId);
      if (!ticket || ticket.state !== 'closed') return editOriginal(interaction, { content: '⚠️ Ten ticket nie jest zamknięty.' });
      const ok = await reopenTicket(interaction, t, ticket);
      if (ok && interaction.message?.id) await discord('PATCH', `/channels/${chId}/messages/${interaction.message.id}`, { components: [] });
      return editOriginal(interaction, { content: ok ? '✅ Ticket otwarty ponownie.' : '❌ Nie udało się otworzyć ticketu.' });
    }

    case 'tkt_transcript': {
      if (!staff) return reply(res, '❌ Tylko administracja może wygenerować transkrypt.');
      deferEphemeral(res);
      const ticket = await getTicket(chId);
      if (!ticket) return editOriginal(interaction, { content: '❌ To nie jest kanał ticketu.' });
      const messages = await fetchAllMessages(chId);
      const ok = await sendFile(chId, { content: `📄 Transkrypt (${messages.length} wiadomości) na prośbę <@${userId}>:`, allowed_mentions: { parse: [] } },
        `transcript-${ticket.channel.name}.html`, buildTranscriptHtml(ticket.channel.name, messages));
      return editOriginal(interaction, { content: ok ? '✅ Transkrypt wysłany na kanał.' : '❌ Nie udało się wysłać transkryptu.' });
    }

    case 'tkt_delete': {
      if (!staff) return reply(res, '❌ Tylko administracja może usunąć ticket.');
      return res.json({ type: 4, data: { content: '🗑️ Na pewno chcesz **trwale usunąć** ten ticket? Transkrypt zostanie zapisany w logach.', flags: 64, components: [confirmRow('tkt_delete_yes', 'tkt_delete_no')] } });
    }

    case 'tkt_delete_yes': {
      deferUpdate(res);
      const ticket = await getTicket(chId);
      if (!ticket || !staff) return editOriginal(interaction, { content: '❌ Nie można usunąć tego ticketu.', components: [] });
      await deleteTicket(interaction, t, ticket);
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
