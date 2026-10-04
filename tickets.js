import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { verifyKeyMiddleware, InteractionType, InteractionResponseType } from 'discord-interactions';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import fetch from 'node-fetch';
import { handleTicketInteraction } from './tickets.js';
import { DEFAULT_STAFF_ROLES, getStaff } from './staff.js';
import { registerTicketRoutes } from './ticketsPanel.js';
import { initLogStore, readServerConfigs, writeServerConfig, addLog, clearLogs, parseFilters, queryLogs, getStats, countBySource, guildSummaries, exportCsv, storageMode } from './logStore.js';

const app = express();
const PORT = process.env.PORT || 8080;
const ROOT_DIR = process.cwd();



// --- TWOJE ID DISCORD (TYLKO TY MOŻESZ UŻYĆ /pomoc I /pomoc_urlop) ---
const BOT_OWNER_ID = process.env.BOT_OWNER_ID;

// --- TABELA KONFIGURACJI SERWERÓW ---
function loadServerConfigs() {
  const raw = process.env.SERVER_CONFIGS_JSON;
  if (!raw) {
    console.error("❌ BRAK zmiennej środowiskowej SERVER_CONFIGS_JSON — bot nie ma żadnej konfiguracji serwerów!");
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error("❌ SERVER_CONFIGS_JSON zawiera niepoprawny JSON — sprawdź składnię (cytowanie, przecinki):", e.message);
    return {};
  }
}

const serverConfigs = loadServerConfigs();
const logStoreReady = initLogStore();
const savedConfigGuilds = new Set();

const sensitiveConfigKey = /token|password|secret|credential|webhook|private|api.?key/i;
const SECRET_CONFIG_PLACEHOLDER = '[KEEP_EXISTING_SECRET]';
const isConfigObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
let cachedConfigEncryptionKey = null;

function editorConfig(value) {
  if (Array.isArray(value)) return value.map(editorConfig);
  if (!isConfigObject(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .map(([key, child]) => [
      key,
      sensitiveConfigKey.test(key) ? (child ? SECRET_CONFIG_PLACEHOLDER : '') : editorConfig(child)
    ]));
}

function getConfigEncryptionKey() {
  const masterKey = process.env.CONFIG_ENCRYPTION_KEY || process.env.DASHBOARD_SESSION_SECRET || '';
  if (masterKey.length < 16) throw new Error('Ustaw CONFIG_ENCRYPTION_KEY lub DASHBOARD_SESSION_SECRET (co najmniej 16 znaków), aby szyfrować konfigurację.');
  if (!cachedConfigEncryptionKey) {
    cachedConfigEncryptionKey = crypto.scryptSync(masterKey, 'law-enforcement-server-config-v1', 32);
  }
  return cachedConfigEncryptionKey;
}

function encryptConfigValue(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    __encryptedConfig: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: encrypted.toString('base64url')
  };
}

function encryptConfigSecrets(value, key) {
  if (Array.isArray(value)) return value.map((item) => encryptConfigSecrets(item, key));
  if (!isConfigObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([name, child]) => [
    name,
    sensitiveConfigKey.test(name) ? encryptConfigValue(child, key) : encryptConfigSecrets(child, key)
  ]));
}

function decryptConfigSecrets(value, key) {
  if (Array.isArray(value)) return value.map((item) => decryptConfigSecrets(item, key));
  if (!isConfigObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([name, child]) => {
    if (!sensitiveConfigKey.test(name)) return [name, decryptConfigSecrets(child, key)];
    if (child?.__encryptedConfig !== 1) return [name, child];
    if (!key) throw new Error('Brak klucza do odszyfrowania konfiguracji.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(child.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(child.tag, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(child.data, 'base64url')),
      decipher.final()
    ]).toString('utf8');
    return [name, JSON.parse(decrypted)];
  }));
}

function containsSensitiveKey(value) {
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  if (!isConfigObject(value)) return false;
  return Object.entries(value).some(([name, child]) => sensitiveConfigKey.test(name) || containsSensitiveKey(child));
}

function mergeConfigSchemas(values) {
  const present = values.filter((value) => value !== undefined);
  if (!present.length) return undefined;
  if (present.some(Array.isArray)) {
    const items = present.flatMap((value) => Array.isArray(value) ? value : []);
    return items.length ? [mergeConfigSchemas(items)] : [];
  }
  if (present.some(isConfigObject)) {
    const keys = new Set(present.filter(isConfigObject).flatMap((value) => Object.keys(value)));
    return Object.fromEntries([...keys].map((key) => [
      key,
      mergeConfigSchemas(present.filter(isConfigObject).map((value) => value[key]))
    ]));
  }
  return present[0];
}

const configSchema = mergeConfigSchemas(Object.values(serverConfigs));

function validateConfigShape(template, value, path = 'config') {
  if (Array.isArray(template)) {
    if (!Array.isArray(value) || value.length > 100) return `${path}: oczekiwano tablicy (maks. 100 elementów).`;
    if (!template.length) return value.length ? `${path}: nie można dodawać elementów do pustej tablicy.` : null;
    for (const [index, item] of value.entries()) {
      const error = validateConfigShape(template[0], item, `${path}[${index}]`);
      if (error) return error;
    }
    return null;
  }
  if (isConfigObject(template)) {
    if (!isConfigObject(value)) return `${path}: oczekiwano obiektu.`;
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(template, key)) return `${path}.${key}: nieznane pole.`;
      const error = validateConfigShape(template[key], child, `${path}.${key}`);
      if (error) return error;
    }
    return null;
  }
  if (typeof value !== typeof template || (typeof value === 'number' && !Number.isFinite(value))) {
    return `${path}: nieprawidłowy typ wartości.`;
  }
  if (typeof value === 'string' && value.length > 4000) return `${path}: tekst jest za długi.`;
  return null;
}

function restoreSensitiveConfig(base, edited) {
  if (Array.isArray(edited)) {
    return edited.map((value, index) => restoreSensitiveConfig(Array.isArray(base) ? base[index] : undefined, value));
  }
  if (!isConfigObject(edited)) return edited;
  const result = Object.fromEntries(Object.entries(edited).map(([key, value]) => [
    key,
    sensitiveConfigKey.test(key)
      ? (value === SECRET_CONFIG_PLACEHOLDER ? (base?.[key] ?? '') : value)
      : isConfigObject(value) ? restoreSensitiveConfig(base?.[key], value) : value
  ]));
  if (isConfigObject(base)) {
    for (const [key, value] of Object.entries(base)) {
      if (sensitiveConfigKey.test(key) && !Object.hasOwn(result, key)) result[key] = value;
      else if (!Object.hasOwn(result, key) && isConfigObject(value) && containsSensitiveKey(value)) {
        result[key] = restoreSensitiveConfig(value, {});
      }
    }
  }
  return result;
}

async function loadSavedServerConfigs() {
  if (storageMode() !== 'postgres') return;
  let encryptionKey = null;
  const protectedSavedGuilds = new Set();
  try {
    encryptionKey = getConfigEncryptionKey();
  } catch (error) {
    console.warn(`Sekrety konfiguracji nie będą migrowane do bazy: ${error.message}`);
  }

  try {
    for (const row of await readServerConfigs()) {
      const guildId = String(row.guild_id);
      if (!Object.hasOwn(serverConfigs, guildId) || !isConfigObject(row.settings)) continue;
      try {
        const savedConfig = decryptConfigSecrets(row.settings, encryptionKey);
        const error = validateConfigShape(configSchema, savedConfig);
        if (error) {
          console.warn(`Pominięto nieprawidłową konfigurację serwera ${guildId}: ${error}`);
          protectedSavedGuilds.add(guildId);
          continue;
        }
        serverConfigs[guildId] = restoreSensitiveConfig(serverConfigs[guildId], savedConfig);
        savedConfigGuilds.add(guildId);
      } catch (error) {
        console.warn(`Pominięto konfigurację serwera ${guildId}: nie udało się odszyfrować zapisanych wartości.`);
        protectedSavedGuilds.add(guildId);
      }
    }

    if (encryptionKey) {
      for (const [guildId, config] of Object.entries(serverConfigs)) {
        if (protectedSavedGuilds.has(guildId)) continue;
        try {
          await writeServerConfig(guildId, encryptConfigSecrets(config, encryptionKey));
          savedConfigGuilds.add(guildId);
        } catch (error) {
          console.error(`Nie udało się zmigrować konfiguracji serwera ${guildId}:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('Nie udało się wczytać konfiguracji z PostgreSQL:', error.message);
  }
}

function addDashboardLog(level = 'info', message, meta = {}) {
  addLog(level, message, meta);
}

addDashboardLog('info', 'Dashboard został uruchomiony.', { source: 'bot' });

const URLOP_HELP_EMBED = {
  title: "🌴 Instrukcja Systemu Urlopowego — Komenda /urlop",
  color: 16753920,
  description: "Komenda `/urlop` pozwala pracownikom bezpiecznie i poprawnie złożyć wniosek o przerwę od służby.\n\n" +
    "📌 **Wymagane parametry komendy:**\n" +
    "• `rozpoczecie` — Data rozpoczęcia urlopu.\n" +
    "• `zakonczenie` — Data powrotu z urlopu.\n" +
    "• `czas` — Ilość dni w formie cyfry (np. `7`). Bot automatycznie dopisze słowo 'dni' lub 'dzień'.\n" +
    "• `powod` — Krótkie wyjaśnienie powodu nieobecności.\n\n" +
    "⚠️ **Krytyczne zasady i formatowanie (Jak pisać):**\n" +
    "Aby bot przepuścił wniosek, parametry `rozpoczecie` oraz `zakonczenie` **muszą być napisane w ścisłym formacie daty z kropkami: DD.MM.RRRR**\n" +
    "*Przykład poprawnego zapisu:* `25.06.2026`\n" +
    "*Przykład błędnego zapisu:* `25/06`, `25-06-2026`, `dzisiaj` — przy takich wpisach bot natychmiast przerwie komendę.\n\n" +
    "🔄 **Przebieg składania wniosku:**\n" +
    "1. Pracownik wpisuje `/urlop` na wyznaczonym w konfiguracji kanale urlopowym. Użycie jej w innym miejscu wywoła błąd.\n" +
    "2. Jeśli format daty jest zły, bot anuluje proces i wysyła pracownikowi upomnienie w prywatnej wiadomości.\n" +
    "3. Jeśli wszystko jest w porządku, pracownik dostaje na DM informację: *'Twój wniosek urlopowy został przesłany i oczekuje na akceptację.'*\n" +
    "4. Na kanale generuje się estetyczny pomarańczowy dokument z przyciskami decyzyjnymi dla Zarządu.\n" +
    "5. Jeśli masz już aktywny, nierozpatrzony wniosek, bot nie pozwoli złożyć kolejnego — najpierw musi zostać rozpatrzony."
};

const LSPD_RESOURCES = {
  handbook: 'https://docs.google.com/document/d/1YRmOh3BvidyKueDDVQdwEh8cQ67aLOC0cZOcs4Q2SW0/edit?usp=sharing',
  rules: 'https://docs.google.com/document/d/1Ug8rZ_slQHtgXgaD5K4BuVF9K45DGqTah24yJgSx6wA/edit?usp=sharing',
  database: 'https://docs.google.com/spreadsheets/d/10LmZ0AXRY4OJDwN9sG7mw5GMIiqFtXj7XOLFHoMi6Yc/edit?usp=sharing'
};

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

discordClient.once('ready', () => {
  console.log(`🤖 Połączono z Discord Gateway jako ${discordClient.user.tag}`);
});

discordClient.on('messageCreate', async message => {
  if (message.author.bot) return;

  const isDirectMessage = message.guildId === null;
  const isMentioned = discordClient.user && message.mentions.has(discordClient.user);
  const isRelayRequest = !isDirectMessage && /\bprzeka(?:ż|z)\b/iu.test(message.content);
  if (!isDirectMessage && !isMentioned && !isRelayRequest) return;

  if (isRelayRequest) {
    const recipient = [...message.mentions.users.values()].find(user =>
      user.id !== message.author.id && user.id !== discordClient.user?.id
    );
    const recipientMention = recipient && message.content.match(new RegExp(`<@!?${recipient.id}>`));
    const forwardedContent = recipientMention
      ? message.content.slice(recipientMention.index + recipientMention[0].length).trim()
      : '';

    if (!recipient || !forwardedContent) {
      await message.reply({
        content: 'Aby przekazać wiadomość, użyj: `przekaż @użytkownik treść wiadomości`.',
        allowedMentions: { repliedUser: false }
      });
      return;
    }

    try {
      await recipient.send({
        content: `📨 Wiadomość od **${message.member?.displayName || message.author.username}**:\n${forwardedContent}`,
        allowedMentions: { parse: [] }
      });
    } catch (error) {
      console.error('Nie udało się przekazać wiadomości na DM:', error);
      await message.reply({
        content: `Nie udało mi się przekazać wiadmomości do **${recipient.username}**. Ta osoba może mieć zablokowane wiadomości prywatne od członków serwera.`,
        allowedMentions: { repliedUser: false }
      }).catch(replyError => console.error('Nie udało się potwierdzić błędu przekazania:', replyError));
      return;
    }

    await message.reply({
      content: `✅ Przekazałem Twoją wiadomość do **${recipient.username}**.`,
      allowedMentions: { repliedUser: false }
    }).catch(error => console.error('Nie udało się potwierdzić przekazania:', error));
    return;
  }

  const words = new Set(message.content.toLocaleLowerCase('pl-PL').match(/[\p{L}\p{N}_]+/gu) || []);
  let response;

  if (words.has('urlop')) {
    response = { embeds: [URLOP_HELP_EMBED] };
  } else if ((words.has('high') && words.has('command')) || words.has('highcommand') || words.has('chief')) {
    response = '**High Command LSPD:**\n• [01] Peter O\'Connor — Chief of Police\n• [02] Mathew Ray — Assistant Chief Of Police';
  } else if (words.has('ftd') || (words.has('field') && words.has('training')) || (words.has('szkolenie') && (words.has('kto') || words.has('ftd')))) {
    response = '**Field Training Division (FTD):**\n• [109] Aiden Walker — Commander, Field Training Division\n• [122] Katrina Sheeran — Under Commander, Field Training Division';
  } else if (words.has('command')) {
    response = '**Command LSPD:**\n• [101] Thomas McKenzie — Commander\n• [102] Thomas Kenley — Commander\n• [103] Johny Asteroid — Commander';
  } else if (words.has('kompendium') || words.has('handbook')) {
    response = `**Kompendium LSPD:** ${LSPD_RESOURCES.handbook}`;
  } else if (words.has('regulamin') || words.has('rules')) {
    response = `**Regulamin LSPD:** ${LSPD_RESOURCES.rules}`;
  } else if (words.has('database') || words.has('baza')) {
    response = `**Database LSPD:** ${LSPD_RESOURCES.database}`;
  } else if (['lspd', 'policja', 'stopnie', 'rangi', 'rekrutacja', 'procedury'].some(word => words.has(word))) {
    response = `**Materiały LSPD:**\n• Kompendium: ${LSPD_RESOURCES.handbook}\n• Regulamin: ${LSPD_RESOURCES.rules}\n• Database: ${LSPD_RESOURCES.database}\n\nInformacje o szkoleniach znajdziesz pod hasłem \`FTD\`, a skład dowództwa pod hasłem \`Command\` lub \`High Command\`.`;
  } else if (['ticket', 'raport', 'kontakt'].some(word => words.has(word))) {
    response = 'Aby otworzyć ticket, wejdź na kanale w panel ticketów, kliknij przycisk otwierania zgłoszenia, wybierz kategorię i wypełnij formularz. Po utworzeniu ticketu bot udostępni Ci prywatny kanał, na którym możesz opisać sprawę i dodać załączniki. Jeśli nie widzisz panelu ticketów, skontaktuj się z administracją.';
  } else if (words.has('hej')) {
    response = 'Cześć! Jestem tutaj. W czym mogę pomóc?';
  } else {
    response = 'Nie wiem, o co chodzi. Zapytaj o `Command`, `High Command`, `FTD`, `kompendium`, `regulamin`, `database`, `urlop` lub `ticket`.';
  }

  try {
    await message.reply(response);
  } catch (error) {
    console.error('Nie udało się odpowiedzieć na wiadomość:', error);
  }
});

// Walidacja podstawowych sekretów na starcie
const REQUIRED_ENV_VARS = ['DISCORD_PUBLIC_KEY', 'DISCORD_BOT_TOKEN', 'BOT_OWNER_ID', 'SERVER_CONFIGS_JSON'];
for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]) {
    console.error(`❌ BRAK wymaganej zmiennej środowiskowej: ${key}. Bot może nie działać poprawnie.`);
  }
}

// Informacyjna walidacja per-serwer
for (const [guildId, cfg] of Object.entries(serverConfigs)) {
  if (!cfg.GOOGLE_SHEET_WEBHOOK_URL) {
    console.warn(`⚠️ Serwer ${guildId} nie ma ustawionego GOOGLE_SHEET_WEBHOOK_URL — wpisy /urlop i /szkolenie nie będą zapisywane do arkusza dla tego serwera.`);
  }
}

// --- ŚLEDZENIE WNIOSKÓW URLOPOWYCH W TOKU (anty race-condition + anty-spam) ---
const pendingUrlopMessages = new Set();
const usersWithPendingUrlop = new Set();

// Funkcja do pobrania info o guildzie (nazwa)
const guildInfoCache = new Map();
async function getGuildInfo(guildId, withCounts = false) {
  // Dane z licznikami są cache'owane 60 s — panel odświeża się często, a Discord ma limity zapytań
  const cached = withCounts ? guildInfoCache.get(guildId) : null;
  if (cached && Date.now() - cached.at < 60000) return cached.data;
  try {
    // Bez with_counts Discord NIE zwraca approximate_member_count
    const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}${withCounts ? '?with_counts=true' : ''}`, {
      headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }
    });
    if (!res.ok) {
      console.error(`Błąd pobierania info o guildzie: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (withCounts) guildInfoCache.set(guildId, { at: Date.now(), data });
    return data;
  } catch (e) {
    console.error(`Błąd pobierania info o guildzie:`, e);
    return null;
  }
}

// Funkcja do pobrania nazwy roli z mentiona lub ID
async function getRoleName(guildId, roleInput) {
  if (!roleInput) return roleInput;
  
  // Jeśli to mention roli <@&ROLE_ID>
  const roleIdMatch = roleInput.match(/<@&(\d+)>/);
  const roleId = roleIdMatch ? roleIdMatch[1] : roleInput;
  
  try {
    const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/roles`, {
      headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }
    });
    if (!res.ok) return roleInput;
    const roles = await res.json();
    const role = roles.find(r => r.id === roleId);
    return role?.name || roleInput;
  } catch (e) {
    console.error('Błąd pobierania nazwy roli:', e);
    return roleInput;
  }
}

// Funkcja do dodawania roli użytkownikowi na Discordzie
async function addRoleToMember(guildId, userId, roleId) {
  if (!roleId || roleId === "ID") {
    console.warn(`⚠️ Rola nie jest skonfigurowana dla serwera ${guildId} — pomijam dodanie roli.`);
    return false;
  }
  try {
    const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }
    });
    if (!res.ok) {
      console.error(`Błąd dodawania roli ${roleId} do użytkownika ${userId}: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`Błąd dodawania roli:`, e);
    return false;
  }
}

// Funkcja do usuwania roli użytkownikowi na Discordzie
async function removeRoleFromMember(guildId, userId, roleId) {
  if (!roleId || roleId === "ID") {
    return false;
  }
  try {
    const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }
    });
    if (!res.ok) {
      console.error(`Błąd usuwania roli ${roleId} od użytkownika ${userId}: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`Błąd usuwania roli:`, e);
    return false;
  }
}

// Funkcja wysyłająca logi na Webhook
async function sendWebhookLog(webhookUrl, embed) {
  if (!webhookUrl || webhookUrl === "TUTAJ_LINK_DO_WEBHOOKA") return;
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] })
    });
    if (!res.ok) {
      console.error(`Webhook log error: HTTP ${res.status} ${await res.text()}`);
    }
  } catch (e) {
    console.error("Błąd wysyłania logów na webhook:", e);
  }
}

// Wysyła dane do Google Sheets
async function sendToGoogleSheet(webAppUrl, data) {
  if (!webAppUrl) {
    console.error("❌ Brak skonfigurowanego GOOGLE_SHEET_WEBHOOK_URL dla tego serwera — pomijam zapis do Google Sheets.");
    return;
  }
  try {
    const res = await fetch(webAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      console.error(`Google Sheet error: HTTP ${res.status}`);
    }
  } catch (e) {
    console.error("Błąd wysyłania do Google Sheets:", e);
  }
}

// Funkcja pomocnicza do wysyłania wiadomości prywatnych (DM)
async function sendDM(userId, content) {
  try {
    const channelRes = await fetch(`https://discord.com/api/v10/users/@me/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      body: JSON.stringify({ recipient_id: userId })
    });
    if (!channelRes.ok) {
      console.error(`Nie udało się otworzyć kanału DM: HTTP ${channelRes.status}`);
      return false;
    }
    const channel = await channelRes.json();
    const msgRes = await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      body: JSON.stringify({ content })
    });
    if (!msgRes.ok) {
      console.error(`Nie udało się wysłać treści DM: HTTP ${msgRes.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("Nie udało się wysłać DM:", e);
    return false;
  }
}

// Funkcja pomocnicza do wysyłania wiadomości na kanał serwera
async function sendChannelMessage(channelId, payload) {
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.error(`Błąd wysyłania na kanał ${channelId}: HTTP ${res.status} ${await res.text()}`);
      return false;
    }
    return await res.json();
  } catch (e) {
    console.error(`Błąd wysyłania na kanał ${channelId}:`, e);
    return false;
  }
}

// --- LOG O AKTUALIZACJI BOTA (najnowszy commit z GitHub) ---
async function fetchLatestGithubCommit(repo, branch) {
  try {
    const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'discord-faction-bot' };
    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const res = await fetch(`https://api.github.com/repos/${repo}/commits/${branch}`, { headers });
    if (!res.ok) {
      console.error(`GitHub commits error: HTTP ${res.status} ${await res.text()}`);
      return null;
    }
    const commit = await res.json();
    const fullMessage = commit.commit?.message?.trim() || "(brak treści commita)";

    const [firstLine, ...rest] = fullMessage.split("\n");
    const body = rest.join("\n").trim();

    return {
      title: firstLine.trim(),
      body: body.length > 0 ? body : "_Brak dodatkowego opisu w commicie._",
      sha: commit.sha,
      shortSha: commit.sha ? commit.sha.slice(0, 7) : "?????",
      url: commit.html_url,
      author: commit.commit?.author?.name || commit.author?.login || "nieznany",
      committedAt: commit.commit?.author?.date
    };
  } catch (e) {
    console.error("Błąd pobierania najnowszego commita z GitHub:", e);
    return null;
  }
}

// Obcinanie tekstu do limitu Discord embeda
function truncateForEmbed(text, maxLength = 3500) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\n\n…*(opis przycięty, pełna treść na GitHubie)*";
}

// Wysyła log "bot zaktualizowany" na wszystkie serwery
async function announceUpdateToAllServers() {
  const repo = process.env.GITHUB_REPO;
  if (!repo) {
    console.log("ℹ️ GITHUB_REPO nie jest ustawione — pomijam log o aktualizacji.");
    return;
  }
  const branch = process.env.GITHUB_BRANCH || "main";

  const commit = await fetchLatestGithubCommit(repo, branch);
  if (!commit) {
    console.log("ℹ️ Nie udało się pobrać najnowszego commita z GitHub — pomijam log o aktualizacji.");
    return;
  }

  const embed = {
    title: `🚀 Bot zaktualizowany do nowego buildu: ${commit.title}`,
    url: commit.url,
    color: 5814783,
    description: truncateForEmbed(commit.body),
    footer: { text: `Commit: ${commit.shortSha} • Autor: ${commit.author} • Repo: ${repo} (${branch})` },
    timestamp: new Date().toISOString()
  };

  const sentWebhooks = new Set();
  for (const guildId of Object.keys(serverConfigs)) {
    const webhookUrl = serverConfigs[guildId].WEBHOOK_URL;
    if (!webhookUrl || webhookUrl === "TUTAJ_LINK_DO_WEBHOOKA" || sentWebhooks.has(webhookUrl)) continue;
    sentWebhooks.add(webhookUrl);
    await sendWebhookLog(webhookUrl, embed);
  }

  console.log(`✅ Log o aktualizacji (commit ${commit.shortSha}) wysłany na ${sentWebhooks.size} webhook(i).`);
}

// Walidacja daty w formacie DD.MM.RRRR
function parseStrictDate(value) {
  const dateRegex = /^(\d{2})\.(\d{2})\.(\d{4})$/;
  const match = dateRegex.exec(value || "");
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const year = parseInt(match[3], 10);

  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

// --- LOGOWANIE DO PANELU: Discord OAuth2 + sprawdzanie roli na serwerze ---
const DASH_BASE_URL = (() => {
  let v = (process.env.DASHBOARD_BASE_URL || '').trim().replace(/^["']+|["']+$/g, '').replace(/\/+$/, '');
  if (v && !/^https?:\/\//i.test(v)) v = `https://${v}`;
  return v;
})();
const DASH_SECRET = process.env.DASHBOARD_SESSION_SECRET || '';
const DASH_CLIENT_ID = (process.env.DISCORD_APPLICATION_ID || '').trim();
const DASH_CLIENT_SECRET = (process.env.DISCORD_CLIENT_SECRET || '').trim();
const DASH_SESSION_MS = 6 * 60 * 60 * 1000;   // sesja ważna 6 godzin
const DASH_RECHECK_MS = 10 * 60 * 1000;       // rola sprawdzana ponownie co 10 minut
const DASH_AUTH_READY = Boolean(DASH_BASE_URL && DASH_SECRET.length >= 16 && DASH_CLIENT_ID && DASH_CLIENT_SECRET);
const DASH_SECURE = DASH_BASE_URL.startsWith('https://');

if (!DASH_AUTH_READY) {
  console.warn('⚠️ Logowanie do panelu nie jest skonfigurowane (DASHBOARD_BASE_URL, DASHBOARD_SESSION_SECRET, DISCORD_CLIENT_SECRET). Panel jest ZABLOKOWANY.');
}

// Role uprawniające do panelu: DASHBOARD_ROLE_IDS, a gdy puste — REQUIRED_ROLE_IDS ze wszystkich serwerów.
function dashboardRoleIds() {
  const explicit = (process.env.DASHBOARD_ROLE_IDS || '').split(',').map((v) => v.trim()).filter(Boolean);
  const configured = explicit.length ? explicit : Object.values(serverConfigs).flatMap((cfg) => cfg.REQUIRED_ROLE_IDS || []);
  const staffRoles = Object.values(DEFAULT_STAFF_ROLES).flatMap((roles) => Object.values(roles).flat());
  const list = [...configured, ...staffRoles];
  return [...new Set(list)].filter((id) => /^\d+$/.test(id));
}

function signValue(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', DASH_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function readSigned(value) {
  if (!value || !DASH_SECRET) return null;
  const [body, sig] = value.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', DASH_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp && payload.exp < Date.now() ? null : payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, maxAgeMs) {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${DASH_SECURE ? '; Secure' : ''}`);
}

async function userHasDashboardAccess(userId) {
  if (BOT_OWNER_ID && userId === BOT_OWNER_ID) return true;
  const allowed = dashboardRoleIds();
  if (!allowed.length) return false;
  for (const guildId of Object.keys(serverConfigs)) {
    try {
      const r = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
        headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }
      });
      if (!r.ok) continue;
      const member = await r.json();
      if ((member.roles || []).some((id) => allowed.includes(id))) return true;
    } catch (error) {
      console.error('Błąd sprawdzania roli do panelu:', error.message);
    }
  }
  return false;
}

// --- Obecność administratorów i powiadomienia o logowaniu (trzymane w pamięci) ---
const dashPresence = new Map();
const dashEvents = [];
let dashEventSeq = 0;
const DASH_ONLINE_MS = 90 * 1000; // uznajemy za online, jeśli panel odpytał serwer w ostatnich 90 s

function dashAvatarUrl(id, avatar) {
  return avatar
    ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.png?size=64`
    : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(id) >> 22n) % 6n)}.png`;
}

function touchDashboardPresence(user) {
  dashPresence.set(user.id, { id: user.id, name: user.name, avatarUrl: dashAvatarUrl(user.id, user.avatar), lastSeen: Date.now() });
}

function pushDashboardEvent(type, user) {
  dashEvents.push({ seq: ++dashEventSeq, type, userId: user.id, name: user.name, avatarUrl: dashAvatarUrl(user.id, user.avatar), at: new Date().toISOString() });
  if (dashEvents.length > 50) dashEvents.shift();
}

async function requireDashboardAuth(req, res, next) {
  const isApi = req.path.startsWith('/api/');
  const deny = (code) => (isApi ? res.status(401).json({ ok: false, error: 'unauthorized' }) : res.redirect(`/login${code ? `?error=${code}` : ''}`));
  if (!DASH_AUTH_READY) return isApi ? res.status(503).json({ ok: false, error: 'auth_not_configured' }) : res.redirect('/login?error=config');

  const session = readSigned(parseCookies(req).dash_session);
  if (!session) return deny();

  if (Date.now() - session.checked > DASH_RECHECK_MS) {
    if (!(await userHasDashboardAccess(session.id))) {
      setCookie(res, 'dash_session', '', 0);
      return deny('brak_roli');
    }
    session.checked = Date.now();
    setCookie(res, 'dash_session', signValue(session), session.exp - Date.now());
  }
  req.dashUser = session;
  touchDashboardPresence(session);
  next();
}

app.get('/login', (req, res) => {
  if (readSigned(parseCookies(req).dash_session)) return res.redirect('/dashboard');
  res.sendFile(path.join(ROOT_DIR, 'login.html'));
});

app.get('/auth/discord', (req, res) => {
  if (!DASH_AUTH_READY) return res.redirect('/login?error=config');
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(res, 'dash_state', signValue({ state, exp: Date.now() + 10 * 60 * 1000 }), 10 * 60 * 1000);
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({
    client_id: DASH_CLIENT_ID,
    response_type: 'code',
    redirect_uri: `${DASH_BASE_URL}/auth/callback`,
    scope: 'identify',
    state,
    prompt: req.query.consent ? 'consent' : 'none'
  }).toString();
  res.redirect(url.toString());
});

app.get('/auth/callback', async (req, res) => {
  if (!DASH_AUTH_READY) return res.redirect('/login?error=config');
  if (['interaction_required', 'consent_required', 'login_required'].includes(req.query.error)) return res.redirect('/auth/discord?consent=1');
  if (req.query.error) return res.redirect('/login?error=anulowano');

  const saved = readSigned(parseCookies(req).dash_state);
  setCookie(res, 'dash_state', '', 0);
  if (!saved || !req.query.state || saved.state !== req.query.state || !req.query.code) return res.redirect('/login?error=state');

  try {
    const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DASH_CLIENT_ID,
        client_secret: DASH_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: String(req.query.code),
        redirect_uri: `${DASH_BASE_URL}/auth/callback`
      })
    });
    if (!tokenRes.ok) throw new Error(`token HTTP ${tokenRes.status}`);
    const token = await tokenRes.json();

    const userRes = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!userRes.ok) throw new Error(`users/@me HTTP ${userRes.status}`);
    const user = await userRes.json();
    const displayName = user.global_name || user.username;

    if (!(await userHasDashboardAccess(user.id))) {
      addDashboardLog('warn', `Odmowa dostępu do panelu: ${displayName} (${user.id}) — brak wymaganej roli.`, { source: 'bot' });
      return res.redirect('/login?error=brak_roli');
    }

    const now = Date.now();
    setCookie(res, 'dash_session', signValue({ id: user.id, name: displayName, avatar: user.avatar || null, checked: now, exp: now + DASH_SESSION_MS }), DASH_SESSION_MS);
    addDashboardLog('info', `Zalogowano do panelu: ${displayName} (${user.id}).`, { source: 'bot' });
    touchDashboardPresence({ id: user.id, name: displayName, avatar: user.avatar || null });
    pushDashboardEvent('login', { id: user.id, name: displayName, avatar: user.avatar || null });
    res.redirect('/dashboard');
  } catch (error) {
    console.error('Błąd logowania do panelu:', error.message);
    res.redirect('/login?error=blad');
  }
});

app.post('/auth/logout', (req, res) => {
  const session = readSigned(parseCookies(req).dash_session);
  if (session) dashPresence.delete(session.id);
  setCookie(res, 'dash_session', '', 0);
  res.json({ ok: true });
});

function requireBotOwner(req, res, next) {
  if (!BOT_OWNER_ID || req.dashUser?.id !== BOT_OWNER_ID) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  next();
}

app.get('/api/me', requireDashboardAuth, (req, res) => {
  const { id, name, avatar } = req.dashUser;
  res.json({ ok: true, id, name, avatarUrl: dashAvatarUrl(id, avatar), isBotOwner: Boolean(BOT_OWNER_ID && id === BOT_OWNER_ID) });
});

app.get('/api/presence', requireDashboardAuth, (req, res) => {
  const now = Date.now();
  for (const [id, entry] of dashPresence) {
    if (now - entry.lastSeen > DASH_ONLINE_MS) dashPresence.delete(id);
  }
  const since = Number.parseInt(req.query.since, 10);
  const events = Number.isFinite(since) ? dashEvents.filter((event) => event.seq > since) : [];
  const online = [...dashPresence.values()].map(({ id, name, avatarUrl }) => ({ id, name, avatarUrl }));
  res.json({ ok: true, count: online.length, online, events, lastSeq: dashEventSeq });
});

app.get('/dashboard', requireDashboardAuth, (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'dashboard.html'));
});

app.get('/dashboard.css', (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'dashboard.css'));
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    name: 'Law Enforcement',
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    guilds: Object.keys(serverConfigs).length,
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/dashboard-summary', requireDashboardAuth, async (_req, res) => {
  try {
    const serverEntries = Object.entries(serverConfigs);
    const ticketCount = serverEntries.filter(([, cfg]) => cfg.TICKETS).length;
    const webhookCount = serverEntries.filter(([, cfg]) => Boolean(cfg.WEBHOOK_URL)).length;
    const counts = await countBySource();
    const botLogs = counts.bot;
    const serverLogs = counts.server;

    const summary = {
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      totalServers: serverEntries.length,
      ticketServers: ticketCount,
      webhookServers: webhookCount,
      botLogs,
      serverLogs,
      lastUpdated: new Date().toISOString(),
      logsCount: botLogs + serverLogs,
      storage: storageMode()
    };

    res.json(summary);
  } catch (error) {
    console.error('Błąd pobierania podsumowania dashboardu:', error);
    res.status(500).json({ ok: false, error: 'Nie udało się pobrać podsumowania.' });
  }
});

app.get('/api/logs', requireDashboardAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const { logs, total } = await queryLogs(parseFilters(req.query), { limit, offset });
    res.json({ ok: true, logs, total, hasMore: offset + logs.length < total, storage: storageMode() });
  } catch (error) {
    console.error('Błąd pobierania logów:', error.message);
    res.status(500).json({ ok: false, error: 'Nie udało się pobrać logów.' });
  }
});

app.delete('/api/logs', requireDashboardAuth, requireBotOwner, async (_req, res) => {
  try {
    await clearLogs();
    res.json({ ok: true });
  } catch (error) {
    console.error('Nie udało się wyczyścić logów:', error.message);
    res.status(503).json({ ok: false, error: 'Nie udało się wyczyścić logów.' });
  }
});

app.get('/api/logs/stats', requireDashboardAuth, async (req, res) => {
  try {
    const tz = Math.max(-50400, Math.min(50400, Math.round(Number(req.query.tz) || 0)));
    res.json({ ok: true, storage: storageMode(), ...(await getStats(parseFilters(req.query), tz)) });
  } catch (error) {
    console.error('Błąd statystyk logów:', error.message);
    res.status(500).json({ ok: false, error: 'Nie udało się policzyć statystyk.' });
  }
});

app.get('/api/logs/export.csv', requireDashboardAuth, async (req, res) => {
  try {
    const csv = await exportCsv(parseFilters(req.query));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="logi-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Błąd eksportu logów:', error.message);
    res.status(500).send('Nie udało się wyeksportować logów.');
  }
});

app.get('/api/staff', requireDashboardAuth, async (req, res) => {
  try {
    res.json({ ok: true, ...(await getStaff(serverConfigs, String(req.query.guild || ''), getGuildInfo)) });
  } catch (error) {
    console.error('Błąd pobierania administracji:', error.message);
    const intent = error.status === 403;
    res.status(502).json({
      ok: false,
      code: intent ? 'members_intent' : 'error',
      error: intent
        ? 'Bot nie może odczytać listy członków. Włącz „Server Members Intent" w Developer Portal (Bot → Privileged Gateway Intents) i upewnij się, że bot jest na serwerze.'
        : 'Nie udało się pobrać listy administracji.',
      guilds: error.guilds || [],
      guildId: error.guildId || ''
    });
  }
});

registerTicketRoutes(app, { requireDashboardAuth, serverConfigs, getGuildInfo, botOwnerId: BOT_OWNER_ID, addDashboardLog, express });

app.get('/api/servers', requireDashboardAuth, async (_req, res) => {
  try {
    const guilds = [];
    const summaries = await guildSummaries();
    for (const [guildId, cfg] of Object.entries(serverConfigs)) {
      const guildInfo = await getGuildInfo(guildId, true);
      const sum = summaries.get(guildId) || { total: 0, commands: 0, lastEvent: null, errors24h: 0 };
      guilds.push({
        id: guildId,
        name: guildInfo?.name || 'Nieznany serwer',
        memberCount: guildInfo?.approximate_member_count ?? discordClient.guilds.cache.get(guildId)?.memberCount ?? null,
        channels: cfg.CHANNELS ? Object.keys(cfg.CHANNELS).length : 0,
        ticketsEnabled: Boolean(cfg.TICKETS),
        webhookConfigured: Boolean(cfg.WEBHOOK_URL),
        stats: {
          totalEvents: sum.total,
          commandCount: sum.commands,
          lastEvent: sum.lastEvent,
          status: sum.errors24h > 0 ? 'warning' : 'online'
        }
      });
    }
    res.json({ ok: true, guilds });
  } catch (error) {
    console.error('Błąd pobierania listy serwerów:', error);
    res.status(500).json({ ok: false, error: 'Nie udało się pobrać listy serwerów.' });
  }
});

app.get('/api/config/:guildId', requireDashboardAuth, requireBotOwner, (req, res) => {
  const guildId = String(req.params.guildId);
  if (!Object.hasOwn(serverConfigs, guildId)) return res.status(404).json({ ok: false, error: 'Nie znaleziono serwera.' });
  res.json({
    ok: true,
    guildId,
    config: editorConfig(serverConfigs[guildId]),
    saved: savedConfigGuilds.has(guildId),
    databaseAvailable: storageMode() === 'postgres' && (process.env.CONFIG_ENCRYPTION_KEY || process.env.DASHBOARD_SESSION_SECRET || '').length >= 16
  });
});

app.put('/api/config/:guildId', requireDashboardAuth, requireBotOwner, express.json({ limit: '100kb' }), async (req, res) => {
  const guildId = String(req.params.guildId);
  if (!Object.hasOwn(serverConfigs, guildId)) return res.status(404).json({ ok: false, error: 'Nie znaleziono serwera.' });
  if (storageMode() !== 'postgres') {
    return res.status(503).json({ ok: false, error: 'Zapis konfiguracji wymaga dostępnego PostgreSQL (DATABASE_URL).' });
  }
  let encryptionKey;
  try {
    encryptionKey = getConfigEncryptionKey();
  } catch (error) {
    return res.status(503).json({ ok: false, error: error.message });
  }

  const config = req.body?.config;
  if (!isConfigObject(config)) return res.status(400).json({ ok: false, error: 'Konfiguracja musi być obiektem JSON.' });

  const error = validateConfigShape(configSchema, config);
  if (error) return res.status(400).json({ ok: false, error });

  try {
    const updatedConfig = restoreSensitiveConfig(serverConfigs[guildId], config);
    await writeServerConfig(guildId, encryptConfigSecrets(updatedConfig, encryptionKey));
    serverConfigs[guildId] = updatedConfig;
    savedConfigGuilds.add(guildId);
    addDashboardLog('info', `Zapisano konfigurację serwera ${guildId}.`, { source: 'bot', userId: req.dashUser.id });
    res.json({ ok: true, guildId, config: editorConfig(serverConfigs[guildId]), saved: true });
  } catch (saveError) {
    console.error('Nie udało się zapisać konfiguracji:', saveError.message);
    res.status(503).json({ ok: false, error: 'Nie udało się zapisać konfiguracji w PostgreSQL.' });
  }
});

app.get('/', (_req, res) => res.status(200).send('Law Enforcement bot is online. Discord endpoint: /interactions. Dashboard: /dashboard'));

app.post('/interactions', verifyKeyMiddleware(process.env.DISCORD_PUBLIC_KEY), async (req, res) => {
  const interaction = req.body;
  const interactionStartedAt = Date.now();
  res.once('finish', () => {
    console.log(`[interaction-response] type=${interaction.type} custom_id=${interaction.data?.custom_id || '-'} status=${res.statusCode} duration=${Date.now() - interactionStartedAt}ms`);
  });
  res.once('close', () => {
    if (!res.writableEnded) {
      console.warn(`[interaction-response] connection closed before response ended; type=${interaction.type} custom_id=${interaction.data?.custom_id || '-'}`);
    }
  });
  console.log(`[interaction] type=${interaction.type} custom_id=${interaction.data?.custom_id || '-'} name=${interaction.data?.name || '-'}`);
  if (interaction.type === InteractionType.PING) return res.json({ type: InteractionResponseType.PONG });

  const guildConfig = serverConfigs[interaction.guild_id];

  if (!guildConfig) {
    return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Ten serwer nie jest skonfigurowany.", flags: 64 } });
  }

  // --- 0. SYSTEM TICKETÓW (komendy /ticket_*, przyciski tkt_*, formularze tkt_modal_*) ---
  if (await handleTicketInteraction(interaction, guildConfig, res)) return;

  // --- 1. OBSŁUGA MODALA (POWÓD ODRZUCENIA) ---
  if (interaction.type === 5) {
    const customId = interaction.data.custom_id;
    if (customId.startsWith('modal_reject_')) {
      const memberRoles = interaction.member.roles || [];
      const hasAdminRole = guildConfig.REQUIRED_ROLE_IDS && guildConfig.REQUIRED_ROLE_IDS.some(roleId => memberRoles.includes(roleId));
      if (!hasAdminRole) {
        return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Tylko administratorzy mogą rozpatrywać wnioski urlopowe.", flags: 64 } });
      }

      const targetUserId = customId.replace('modal_reject_', '');
      const powod = interaction.data.components[0].components[0].value;
      const adminName = interaction.member.user.username;
      const messageId = interaction.message?.id;
      const originalEmbed = interaction.message?.embeds?.[0];

      if (!originalEmbed || (messageId && !pendingUrlopMessages.has(messageId))) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "⚠️ Ten wniosek został już rozpatrzony albo nie jest już dostępny.", flags: 64 }
        });
      }
      if (messageId) pendingUrlopMessages.delete(messageId);
      usersWithPendingUrlop.delete(targetUserId);

      const dmOk = await sendDM(targetUserId, `❌ Twój wniosek urlopowy został **ODRZUCONY** przez administratora **${adminName}**.\n**Powód:** ${powod}`);

      // Logowanie w tle (bez await)
      sendWebhookLog(guildConfig.WEBHOOK_URL, {
        title: "📝 Akcja: Odrzucenie Urlopu",
        color: 15158332,
        description: `Administrator <@${interaction.member.user.id}> odrzucił wniosek urlopowy użytkownika <@${targetUserId}>.\n**Powód:** ${powod}` +
          (dmOk ? "" : "\n⚠️ *Nie udało się wysłać DM do użytkownika (może mieć zablokowane wiadomości prywatne).*")
      }).catch(e => console.error('Błąd logowania odrzucenia:', e));

      return res.json({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          embeds: [{
            title: "URLOP ODRZUCONY",
            color: 15158332,
            description: originalEmbed.description + `\n\n**Odrzucone przez:** <@${interaction.member.user.id}>\n**Powód odrzucenia:** ${powod}` +
              (dmOk ? "" : "\n⚠️ *Nie udało się powiadomić użytkownika na DM.*")
          }],
          components: []
        }
      });
    }
    return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Nieznany formularz.", flags: 64 } });
  }

  // --- 2. OBSŁUGA KLIKNIĘĆ W PRZYCISKI ---
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = interaction.data.custom_id;
    if (customId.startsWith('urlop_')) {
      const memberRoles = interaction.member.roles || [];
      const hasAdminRole = guildConfig.REQUIRED_ROLE_IDS && guildConfig.REQUIRED_ROLE_IDS.some(roleId => memberRoles.includes(roleId));

      if (!hasAdminRole) {
        return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Tylko administratorzy mogą rozpatrywać wnioski urlopowe.", flags: 64 } });
      }

      const [, action, targetUserId] = customId.split('_');
      const messageId = interaction.message?.id;
      const originalEmbed = interaction.message?.embeds?.[0];

      if (!originalEmbed || (messageId && !pendingUrlopMessages.has(messageId))) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "⚠️ Ten wniosek został już rozpatrzony albo nie jest już dostępny.", flags: 64 }
        });
      }

      const adminName = interaction.member.user.username;

      if (action === 'accept') {
        if (messageId) pendingUrlopMessages.delete(messageId);
        usersWithPendingUrlop.delete(targetUserId);

        // Operacje w tle (bez await)
        const urlopRoleId = guildConfig.ROLES?.URLOP_ROLE_ID;
        const roleAdded = urlopRoleId ? await addRoleToMember(interaction.guild_id, targetUserId, urlopRoleId) : false;

        const dmOk = await sendDM(targetUserId, `🎉 Twój wniosek o urlop został **ZAAKCEPTOWANY** przez administratora **${adminName}**!`);

        sendWebhookLog(guildConfig.WEBHOOK_URL, {
          title: "📝 Akcja: Akceptacja Urlopu",
          color: 5763719,
          description: `Administrator <@${interaction.member.user.id}> zaakceptował wniosek urlopowy użytkownika <@${targetUserId}>.` +
            (dmOk ? "" : "\n⚠️ *Nie udało się wysłać DM do użytkownika (może mieć zablokowane wiadomości prywatne).*") +
            (roleAdded ? "" : "\n⚠️ *Nie udało się dodać roli \"Na urlopie\" (rola może być niezakonfigurowana).*")
        }).catch(e => console.error('Błąd logowania akceptacji:', e));

        return res.json({
          type: InteractionResponseType.UPDATE_MESSAGE,
          data: {
            embeds: [{
              title: "URLOP ZAAKCEPTOWANY",
              color: 5763719,
              description: originalEmbed.description + `\n\n**Zaakceptowane przez:** <@${interaction.member.user.id}>` +
                (dmOk ? "" : "\n⚠️ *Nie udało się powiadomić użytkownika na DM.*") +
                (roleAdded ? "" : "\n⚠️ *Rola nie została dodana - sprawdź konfigurację.*")
            }],
            components: []
          }
        });
      } else if (action === 'reject') {
        return res.json({
          type: 9,
          data: {
            title: "Odrzucenie urlopu",
            custom_id: `modal_reject_${targetUserId}`,
            components: [{ type: 1, components: [{ type: 4, custom_id: "powod_input", label: "Podaj powód odrzucenia:", style: 2, required: true }] }]
          }
        });
      }
    }
    return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Nieznana akcja.", flags: 64 } });
  }

  // --- 3. OBSŁUGA KOMEND ---
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const { name, options } = interaction.data;
    const opts = {};
    if (options) options.forEach((opt) => opts[opt.name] = opt.value);

    // --- BLOKADA DLA KOMEND WŁAŚCICIELA ---
    if (name === 'pomoc' || name === 'pomoc_urlop') {
      if (interaction.member.user.id !== BOT_OWNER_ID) {
        return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Ta komenda jest dostępna tylko dla właściciela bota.", flags: 64 } });
      }

      if (name === 'pomoc') {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            embeds: [{
              title: "📚 Panel Pomocy — Komendy Frakcyjne",
              color: 3447003,
              description: "Oto wykaz działania wszystkich komend administracyjnych w bocie:\n\n" +
                "• **/awans** — Służy do awansowania pracownika. Generuje oficjalny komunikat na kanale awansów z nowym stopniem oraz zaktualizowanym numerem odznaki.\n" +
                "• **/degradacja** — Służy do obniżenia stopnia pracownika. Wysyła sformatowaną wiadomość na odpowiedni kanał.\n" +
                "• **/zawieszenie** — Służy do zawieszenia członka struktur na określony czas. Wymaga podania imienia, nazwiska, powodu oraz ram czasowych.\n" +
                "• **/zwolnij** — Usuwa pracownika z struktur frakcji, wysyłając powiadomienie do logów oraz oznaczając zwolnioną osobę.\n" +
                "• **/nagana** — Nadaje oficjalną naganę do akt. W komendzie należy wskazać, która to już nagana z kolei (np. 1/3, 2/3).\n" +
                "• **/kara_finansowa** — Nakłada na pracownika obowiązek zapłaty określonej kwoty jako karę dyscyplinarną.\n" +
                "• **/szkolenie** — Pozwala udokumentować przebieg i wynik egzaminu/szkolenia. W zależności od wybranego wyniku (zdane/niezdane) embed automatycznie dobiera odpowiedni kolor (zielony/czerwony).\n" +
                "• **/zagrozenie** — Wprowadza na serwerze stan zagrożenia. Automatycznie oznacza rolę `@everyone` (wyciszone w logach) i zmienia kolor embedu zależnie od wybranego poziomu (Zielony, Pomarańczowy, Czerwony, Czarny).\n" +
                "• **/zebranie** — Uzupełniacie sobie date, godzine, miejsce zebrania. Tak w wielkim skrócie.\n" +
                "• **/odwolaj_zagrozenie** — Przywraca normalny stan funkcjonowania serwera frakcji, informując o tym wszystkich członków.\n\n" +
                "• **/dodaj_pojazd** — Rejestruje nowy pojazd w bazie frakcyjnej wraz ze specyfikacją tuningu i przesyła dane do arkusza Google.\n" +
                "• **/wyslij_ogloszenie** — Wysyła ogłoszenie na kanał (dostępne tylko dla właściciela bota).\n\n" +
                "🎫 **System ticketów:**\n" +
                "• **/ticket_panel** — Wysyła na kanał panel z przyciskami do otwierania ticketów (tylko administracja).\n" +
                "• **/ticket_zamknij** — Zamyka ticket, w którym użyto komendy (właściciel ticketu lub support).\n" +
                "• **/ticket_dodaj** / **/ticket_usun** — Dodaje lub usuwa użytkownika z ticketu.\n" +
                "• **/ticket_nazwa** — Zmienia nazwę kanału ticketu.\n" +
                "W tickecie dostępne są przyciski: Zamknij, Przejmij, a po zamknięciu — Otwórz ponownie, Transkrypt i Usuń.\n\n" +
                "⚙️ **Jak zarządzać wnioskami urlopowymi (Akceptacja/Odrzucenie):**\n" +
                "Kiedy użytkownik poprawnie wyśle wniosek urlopowy, pod wiadomością pojawią się dwa duże przyciski:\n" +
                "1. **AKCEPTUJ (Zielony)** — Kliknięcie przycisku natychmiast zmienia kolor całego wniosku na zielony, usuwa przyciski z kanału (żeby nikt nie kliknął drugi raz) i automatycznie wysyła do pracownika prywatną wiadomość (DM) o pozytywnym rozpatrzeniu.\n" +
                "2. **ODRZUĆ (Czerwony)** — Po kliknięciu bot wyświetli na ekranie wyskakujące okienko (Modal). Administrator **musi** wpisać w nim powód odrzucenia wniosku. Po zatwierdzeniu formularza, wniosek na kanale zmieni kolor na czerwony, dopisze powód odrzucenia oraz nick administratora, a pracownik otrzyma powód odmowy bezpośrednio na swoje DM."
            }]
          }
        });
      }

      if (name === 'pomoc_urlop') {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { embeds: [URLOP_HELP_EMBED] }
        });
      }
    }

    // Weryfikacja kanału dla urlopu
    if (name === 'urlop' && interaction.channel_id !== guildConfig.CHANNELS.URLOP) {
      return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `❌ Komenda /urlop jest dostępna tylko na kanale <#${guildConfig.CHANNELS.URLOP}>.`, flags: 64 } });
    }

    // Walidacja daty i logiki dla urlopu
    let startDateObj, endDateObj, dni;
    if (name === 'urlop') {
      startDateObj = parseStrictDate(opts.rozpoczecie);
      endDateObj = parseStrictDate(opts.zakonczenie);

      if (!startDateObj || !endDateObj) {
        await sendDM(interaction.member.user.id, "❌ Błędny format daty! Użyj formatu DD.MM.RRRR (np. 25.06.2026) i sprawdź, czy data istnieje w kalendarzu.");
        return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Błędny format daty! Sprawdź wiadomość prywatną od bota.", flags: 64 } });
      }

      if (endDateObj < startDateObj) {
        await sendDM(interaction.member.user.id, "❌ Data zakończenia urlopu nie może być wcześniejsza niż data rozpoczęcia.");
        return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Błędny zakres dat! Sprawdź wiadomość prywatną od bota.", flags: 64 } });
      }

      dni = parseInt(opts.czas, 10);
      if (!Number.isInteger(dni) || dni <= 0 || String(opts.czas).trim() !== String(dni)) {
        await sendDM(interaction.member.user.id, "❌ Pole \"czas\" musi być liczbą całkowitą większą od 0 (np. 7).");
        return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Błędna wartość pola \"czas\"! Sprawdź wiadomość prywatną od bota.", flags: 64 } });
      }

      if (usersWithPendingUrlop.has(interaction.member.user.id)) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "❌ Masz już aktywny, nierozpatrzony wniosek urlopowy. Poczekaj na decyzję administracji przed złożeniem kolejnego.", flags: 64 }
        });
      }
    }

    // Walidacja uprawnień do reszty komend
    const memberRoles = interaction.member.roles || [];
    const hasAdminRole = guildConfig.REQUIRED_ROLE_IDS && guildConfig.REQUIRED_ROLE_IDS.some(roleId => memberRoles.includes(roleId));

    if (name !== 'urlop' && name !== 'wyslij_ogloszenie' && !hasAdminRole) {
      return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Brak uprawnień.", flags: 64 } });
    }

    // --- SPECJALNA OBSŁUGA /wyslij_ogloszenie ---
    if (name === 'wyslij_ogloszenie') {
      // Sprawdź uprawnienia właściciela
      if (interaction.member.user.id !== BOT_OWNER_ID) {
        return res.json({ 
          type: 4, 
          data: { content: "❌ Brak uprawnień. Ta komenda jest dostępna tylko dla właściciela bota.", flags: 64 } 
        });
      }

      // Sprawdź czy jest treść
      const tresc = opts.tresc;
      if (!tresc || tresc.trim() === "") {
        return res.json({ 
          type: 4, 
          data: { content: "❌ Treść ogłoszenia nie może być pusta!", flags: 64 } 
        });
      }

      // ✅ NATYCHMIAST odpowiedz (PIERWSZA LINIA!)
      res.json({ 
        type: 4, 
        data: { content: "✅ Ogłoszenie wysyłane...", flags: 64 } 
      });

      // 🔥 POTEM wysyłaj w tle (bez czekania) - setImmediate to unika blokowania
      setImmediate(async () => {
        try {
          const result = await sendChannelMessage(interaction.channel_id, { content: tresc });
          if (result && result.id) {
            console.log(`✅ Ogłoszenie wysłane na kanał ${interaction.channel_id} (ID: ${result.id})`);
          } else {
            console.log("⚠️ Wiadomość wysłana, ale brak ID");
          }
        } catch (err) {
          console.error(`❌ Błąd wysyłania ogłoszenia: ${err.message}`);
        }
      });

      // Nie rób return - res.json() już wysłano
      return;
    }

    // Mapowanie komend na kanały z configu danego serwera
    const configs = {
      awans: { title: 'AWANS', color: 3066993, channel: guildConfig.CHANNELS.AWANS },
      degradacja: { title: 'DEGRADACJA', color: 15158332, channel: guildConfig.CHANNELS.DEGRADACJA },
      zawieszenie: { title: 'ZAWIESZENIE', color: 16753920, channel: guildConfig.CHANNELS.ZAWIESZENIE },
      zagrozenie: { title: 'WPROWADZONO POZIOM ZAGROŻENIA', color: 16776960, channel: guildConfig.CHANNELS.ZAGROZENIE },
      odwolaj_zagrozenie: { title: 'ODWOŁANO STAN ZAGROŻENIA', color: 5763719, channel: guildConfig.CHANNELS.ZAGROZENIE },
      szkolenie: { title: 'SZKOLENIE', color: 3447003, channel: guildConfig.CHANNELS.SZKOLENIE },
      urlop: { title: 'URLOP OCZEKUJE NA AKCEPTACJE', color: 16753920, channel: guildConfig.CHANNELS.URLOP },
      zwolnij: { title: 'ZWOLNIENIE', color: 15158332, channel: guildConfig.CHANNELS.ZWOLNIENIA },
      nagana: { title: 'NAGANA', color: 16711680, channel: guildConfig.CHANNELS.NAGANA },
      zebranie: { title: 'ZEBRANIE', color: 5793266, channel: guildConfig.CHANNELS.ZEBRANIE },
      dodaj_pojazd: { title: 'NOWY POJAZD W BAZIE', color: 3447003, channel: guildConfig.CHANNELS.POJAZDY },
      kara_finansowa: { title: 'KARA FINANSOWA', color: 16766720, channel: guildConfig.CHANNELS.KARY }
    };

    const cfg = configs[name];
    if (!cfg) return res.status(400).json({ error: 'Unknown command' });

    if (!cfg.channel || cfg.channel === "ID" || cfg.channel === "ID_KANALU") {
      return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Kanał docelowy dla tej komendy nie jest skonfigurowany na tym serwerze. Skontaktuj się z właścicielem bota.", flags: 64 } });
    }

    const now = new Date();
    const data = `${now.toLocaleDateString("pl-PL", { timeZone: "Europe/Warsaw" })} ${now.toLocaleTimeString("pl-PL", { timeZone: "Europe/Warsaw", hour: '2-digit', minute: '2-digit' })}`;

    let description = "", content = opts.kto ? `<@${opts.kto}>` : "", components = [];
    let finalColor = cfg.color;

    // Pobierz informacje o guildzie (dla DM-ów)
    const guildInfo = await getGuildInfo(interaction.guild_id);
    const guildName = guildInfo?.name || "Nieznany serwer";

    // --- PRZYGOTOWANIE TREŚCI KOMEND ---
    if (name === 'urlop') {
      const dniLabel = dni === 1 ? "dzień" : "dni";
      description = `**Rozpoczęcie:** ${opts.rozpoczecie}\n**Zakończenie:** ${opts.zakonczenie}\n**Czas:** ${dni} ${dniLabel}\n**Powód:** ${opts.powod}\n\n**Złożone przez:** <@${interaction.member.user.id}>\n**Data:** ${data}`;
      components = [{ type: 1, components: [
        { type: 2, label: "AKCEPTUJ", style: 3, custom_id: `urlop_accept_${interaction.member.user.id}` },
        { type: 2, label: "ODRZUĆ", style: 4, custom_id: `urlop_reject_${interaction.member.user.id}` }
      ]}];
      
      // Wyślij DM i zapisz do Google Sheets w tle (bez await)
      sendDM(interaction.member.user.id, "✅ Twój wniosek urlopowy został przesłany i oczekuje na akceptację.")
        .catch(e => console.error('Błąd wysyłania DM urlopu:', e));
      
      sendToGoogleSheet(guildConfig.GOOGLE_SHEET_WEBHOOK_URL, {
        kto_id: interaction.member.user.id,
        zakonczenie: opts.zakonczenie
      }).catch(e => console.error('Błąd wysyłania urlopu do Google Sheets:', e));
    }
    else if (name === 'szkolenie') {
      const isZdane = opts.wynik === 'zdane';
      cfg.title = isZdane ? "Szkolenie Zdane" : "Szkolenie Niezdane";
      finalColor = isZdane ? 5763719 : 15158332;
      content = `<@${opts.kto_zdawal}>`;
      description = `**Kto:** ${opts.imie_nazwisko}\n**Szkolenie:** ${opts.szkolenie}\n**Szkoleniowiec:** <@${opts.szkoleniowiec}>\n\n**${data}**`;

      // DM do osoby szkolonej (w tle)
      if (opts.kto_zdawal) {
        const dmMessage = `**${guildName}** - **${opts.imie_nazwisko}** Twoje szkolenie **${opts.szkolenie}** zostało **${opts.wynik}**!!!`;
        sendDM(opts.kto_zdawal, dmMessage).catch(e => console.error('Błąd wysyłania DM szkolenia:', e));
      }

      if (isZdane) {
        sendToGoogleSheet(guildConfig.GOOGLE_SHEET_WEBHOOK_URL, {
          kto_id: opts.kto_zdawal,
          szkolenie: opts.szkolenie
        }).catch(e => console.error('Błąd wysyłania szkolenia do Google Sheets:', e));
      }
    }
    else if (name === 'zagrozenie') {
      if (opts.poziom) {
        const colorMap = { 'Zielony': 5763719, 'Pomarańczowy': 16753920, 'Czerwony': 15158332, 'Czarny': 2303786 };
        finalColor = colorMap[opts.poziom] || cfg.color;
      }
      cfg.title = `WPROWADZONO POZIOM ZAGROŻENIA "${opts.poziom}"`;
      description = `**Osoba wprowadzająca:** ${opts.wprowadzajacy}\n**Stopień osoby wprowadzającej:** ${opts.stopien_wprowadzajacego}\n**Powód:** ${opts.powod}\n**Data oraz godzina:** ${data}`;
    }
    else if (name === 'odwolaj_zagrozenie') {
      finalColor = 5763719;
      description = `**Osoba odwołująca:** ${opts.osoba_odwolujaca}\n**Stopień osoby odwołującej:** ${opts.stopien_odwolujacego}\n**Powód:** ${opts.powod}\n**Data oraz godzina:** ${data}`;
    }
    else if (name === 'zawieszenie') {
      description = `**Kto:** ${opts.imie_nazwisko}\n**Powód:** ${opts.powod}\n**Czas zawieszenia:** ${opts.czas}\n**Zawieszono przez:** <@${interaction.member.user.id}>\n\n**${data}**`;

      // DM do zawieszonej osoby (w tle)
      if (opts.kto) {
        const dmMessage = `**${guildName}** - **${opts.imie_nazwisko}** Zostałeś **ZAWIESZONY** na **${opts.czas}** z powodu **${opts.powod}**`;
        sendDM(opts.kto, dmMessage).catch(e => console.error('Błąd wysyłania DM zawieszenia:', e));

        sendToGoogleSheet(guildConfig.GOOGLE_SHEET_WEBHOOK_URL, {
          kto_id: opts.kto,
          zawieszenie: true 
        }).catch(e => console.error('Błąd wysyłania zawieszenia do Google Sheets:', e));

        const zawieszanieRoleId = guildConfig.ROLES?.ZAWIESZENIE_ROLE_ID;
        if (zawieszanieRoleId && zawieszanieRoleId !== "ID") {
          addRoleToMember(interaction.guild_id, opts.kto, zawieszanieRoleId)
            .catch(e => console.error('Błąd dodawania roli zawieszenia:', e));
        }
      }
    }
    else if (name === 'zwolnij') {
      content = `<@${opts.kto}>`;
      description = `**Kto:** ${opts.imie_nazwisko}\n**Powód:** ${opts.powod}\n**Nadane przez:** <@${interaction.member.user.id}>\n\n**${data}**`;

      // DM do zwolnionej osoby (w tle)
      if (opts.kto) {
        const dmMessage = `**${guildName}** - **${opts.imie_nazwisko}** Zostałeś **ZWOLNIONY** z powodu **${opts.powod}**`;
        sendDM(opts.kto, dmMessage).catch(e => console.error('Błąd wysyłania DM zwolnienia:', e));
      }
    }
    else if (name === 'nagana') {
      content = `<@${opts.kto}>`;
      description = `**Kto:** ${opts.imie_nazwisko}\n**Powód:** ${opts.powod}\n**Która nagana:** ${opts.ktora_nagana}\n**Nadane przez:** <@${interaction.member.user.id}>\n\n**${data}**`;

      sendToGoogleSheet(guildConfig.GOOGLE_SHEET_WEBHOOK_URL, {
        kto_id: opts.kto,
        nagana: opts.ktora_nagana
      }).catch(e => console.error('Błąd wysyłania do Google Sheets:', e));
      
      // DM do ukaranej osoby (w tle)
      if (opts.kto) {
        const dmMessage = `**${guildName}** - **${opts.imie_nazwisko}** Została nałożona na ciebie **${opts.ktora_nagana}** **NAGANA** z powodu **${opts.powod}**`;
        sendDM(opts.kto, dmMessage).catch(e => console.error('Błąd wysyłania DM nagany:', e));
      }
    }
    else if (name === 'kara_finansowa') {
      content = `<@${opts.kto}>`;
      description = `**Kto:** ${opts.imie_nazwisko}\n**Powód:** ${opts.powod}\n**Kwota:** ${opts.kwota}$\n**Nadane przez:** <@${interaction.member.user.id}>\n\n**${data}**`;
    }
    else if (name === 'dodaj_pojazd') {
      const isTurbo = opts.turbo ? "TRUE" : "FALSE";
      
      description = `**Właściciel / Rejestrujący:** <@${interaction.member.user.id}>\n` +
                    `**Tablica Rejestracyjna:** ${opts.tablica}\n` +
                    `**Model pojazdu:** ${opts.model}\n` +
                    `**Klasa pojazdu:** ${opts.klasa}\n` +
                    `**Ważność przeglądu:** ${opts.przeglad}\n\n` +
                    `🔧 **Modyfikacje (Tuning):**\n` +
                    `> **Silnik:** ${opts.silnik}\n` +
                    `> **Hamulce:** ${opts.hamulce}\n` +
                    `> **Skrzynia biegów:** ${opts.skrzynia}\n` +
                    `> **Zawieszenie:** ${opts.zawieszenie}\n` +
                    `> **Turbo:** ${isTurbo}\n\n` +
                    `**Data dodania do rejestru:** ${data}`;

      sendToGoogleSheet(guildConfig.GOOGLE_SHEET_WEBHOOK_URL, {
        nowy_pojazd: true,
        tablica: opts.tablica,
        model: opts.model,
        klasa: opts.klasa,
        przeglad: opts.przeglad,
        silnik: opts.silnik,
        hamulce: opts.hamulce,
        skrzynia: opts.skrzynia,
        zawieszenie: opts.zawieszenie,
        turbo: isTurbo
      }).catch(e => console.error('Błąd wysyłania pojazdu do Google Sheets:', e));
    }
    else if (name === 'awans') {
      content = `<@${opts.kto}>`;
      description = `**Kto:** ${opts.imie_nazwisko}\n**Powód:** ${opts.powod}\n**Nowy stopień:** ${opts.stopien}\n**Nowy numer odznaki:** ${opts.odznaka}\n**Awansowany przez:** <@${interaction.member.user.id}>\n\n**${data}**`;

      // DM do awansowanej osoby (w tle)
      if (opts.kto) {
        const roleName = await getRoleName(interaction.guild_id, opts.stopien);
        const dmMessage = `**${guildName}** - **${opts.imie_nazwisko}** Zostałeś **AWANSOWANY** na **${roleName}** z powodu **${opts.powod}** twój nowy numer odznaki to: ${opts.odznaka}`;
        sendDM(opts.kto, dmMessage).catch(e => console.error('Błąd wysyłania DM awansu:', e));
      }
    }
    else if (name === 'degradacja') {
      content = `<@${opts.kto}>`;
      description = `**Kto:** ${opts.imie_nazwisko}\n**Powód:** ${opts.powod}\n**Nowy stopień:** ${opts.stopien}\n**Nowy numer odznaki:** ${opts.odznaka}\n**Zdegradowany przez:** <@${interaction.member.user.id}>\n\n**${data}**`;

      // DM do zdegradowanej osoby (w tle)
      if (opts.kto) {
        const roleName = await getRoleName(interaction.guild_id, opts.stopien);
        const dmMessage = `**${guildName}** - **${opts.imie_nazwisko}** Zostałeś **ZDEGRADOWANY** na **${roleName}** z powodu **${opts.powod}** twój nowy numer odznaki to: ${opts.odznaka}`;
        sendDM(opts.kto, dmMessage).catch(e => console.error('Błąd wysyłania DM degradacji:', e));
      }
    }
    else if (name === 'zebranie') {
      const roleId = guildConfig.PING_ROLE_ID;
      const pingMention = (roleId && roleId !== "ID") ? `<@&${roleId}>` : "";
      content = pingMention || "";

      description = `**ZEBRANIE DEPARTAMENTU** ${pingMention}\n` +
                    `**Data:** ${opts.data}\n` +
                    `**Godzina:** ${opts.godzina}\n` +
                    `**Miejsce Zebrania:** ${opts.miejsce}\n\n` +
                    `*Dziś o ${now.toLocaleTimeString("pl-PL", { timeZone: "Europe/Warsaw", hour: '2-digit', minute: '2-digit' })}*`;
    }

    // ✅ WSPÓLNE WYSYŁANIE DLA WSZYSTKICH KOMEND (RAZ!)
    const sentMessage = await sendChannelMessage(cfg.channel, { content, embeds: [{ title: cfg.title, color: finalColor, description }], components });

    if (!sentMessage) {
      return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `⚠️ Komenda ${name} przetworzona, ale wystąpił błąd przy wysyłaniu wiadomości na kanał docelowy. Sprawdź uprawnienia bota i konfigurację kanału.`, flags: 64 } });
    }

    // Rejestracja wniosku urlopowego jako oczekujący
    if (name === 'urlop' && sentMessage.id) {
      pendingUrlopMessages.add(sentMessage.id);
      usersWithPendingUrlop.add(interaction.member.user.id);
    }

    // --- LOGOWANIE UŻYCIA KOMENDY (W TLE) ---
    let opcjeTekst = "";
    if (Object.keys(opts).length > 0) {
      for (const [key, value] of Object.entries(opts)) {
        opcjeTekst += `**${key}:** ${value}\n`;
      }
    } else {
      opcjeTekst = "Brak argumentów.";
    }

    sendWebhookLog(guildConfig.WEBHOOK_URL, {
      title: `🛠️ Użyto komendy: /${name}`,
      color: 3447003,
      description: `**Użytkownik:** <@${interaction.member.user.id}>\n**Kanał:** <#${interaction.channel_id}>\n\n**Przekazane dane:**\n${opcjeTekst}`,
      timestamp: new Date().toISOString()
    }).catch(e => console.error('Błąd logowania komendy:', e));

    addDashboardLog('info', `Użyto komendy /${name} na serwerze ${interaction.guild_id}.`, {
      guildId: interaction.guild_id,
      source: 'server',
      command: name,
      userId: interaction.member.user.id,
      channelId: interaction.channel_id,
      options: opts
    });

    return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `✅ Komenda ${name} wykonana!`, flags: 64 } });
  }

  // Fallback dla nieznanych typów interakcji
  return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Nieobsługiwany typ interakcji.", flags: 64 } });
});

const SERVER_PORT = process.env.PORT || 8080;

async function startServer() {
  await logStoreReady;
  await loadSavedServerConfigs();
  app.listen(SERVER_PORT, '0.0.0.0', () => {
    console.log(`🤖 Bot działa na porcie ${SERVER_PORT}`);
    addDashboardLog('info', `Bot uruchomiony na porcie ${SERVER_PORT}.`, { source: 'bot' });
    announceUpdateToAllServers();
    discordClient.login(process.env.DISCORD_BOT_TOKEN)
      .catch(error => {
        addDashboardLog('error', 'Nie udało się połączyć z Discord Gateway.', { source: 'bot', error: error.message });
        console.error('Nie udało się połączyć z Discord Gateway:', error);
      });
  });
}

startServer().catch((error) => {
  console.error('Nie udało się uruchomić serwera:', error);
  process.exitCode = 1;
});
