// Rejestruje komendy ticketów na serwerach z SERVER_CONFIGS_JSON.
// Używa POST na pojedynczą komendę (tworzy/aktualizuje TYLKO te komendy),
// więc Twoje istniejące komendy (/awans, /urlop itd.) zostają nietknięte.
//
// Uruchomienie:
//   DISCORD_BOT_TOKEN=... DISCORD_APPLICATION_ID=... SERVER_CONFIGS_JSON='{...}' node register-ticket-commands.js

import fetch from 'node-fetch';

const APP_ID = process.env.DISCORD_APPLICATION_ID;
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const configs = JSON.parse(process.env.SERVER_CONFIGS_JSON || '{}');

if (!APP_ID || !TOKEN) {
  console.error('❌ Ustaw DISCORD_APPLICATION_ID oraz DISCORD_BOT_TOKEN.');
  process.exit(1);
}

const commands = [
  {
    name: 'ticket_panel',
    description: 'Wysyła panel do otwierania ticketów',
    options: [
      { type: 3, name: 'tytul', description: 'Tytuł panelu', required: false },
      { type: 3, name: 'opis', description: 'Opis panelu', required: false },
      { type: 7, name: 'kanal', description: 'Kanał docelowy panelu (domyślnie obecny)', required: false, channel_types: [0] }
    ]
  },
  {
    name: 'ticket_zamknij',
    description: 'Zamyka obecny ticket',
    options: [{ type: 3, name: 'powod', description: 'Powód zamknięcia', required: false }]
  },
  {
    name: 'ticket_dodaj',
    description: 'Dodaje użytkownika do ticketu',
    options: [{ type: 6, name: 'user', description: 'Kogo dodać', required: true }]
  },
  {
    name: 'ticket_usun',
    description: 'Usuwa użytkownika z ticketu',
    options: [{ type: 6, name: 'user', description: 'Kogo usunąć', required: true }]
  },
  {
    name: 'ticket_nazwa',
    description: 'Zmienia nazwę kanału ticketu',
    options: [{ type: 3, name: 'nazwa', description: 'Nowa nazwa', required: true, max_length: 90 }]
  }
];

for (const guildId of Object.keys(configs)) {
  for (const cmd of commands) {
    const res = await fetch(`https://discord.com/api/v10/applications/${APP_ID}/guilds/${guildId}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${TOKEN}` },
      body: JSON.stringify(cmd)
    });
    console.log(res.ok ? '✅' : '❌', guildId, `/${cmd.name}`, res.ok ? '' : `HTTP ${res.status} ${await res.text()}`);
  }
}
