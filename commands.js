// Komendy frakcyjne: definicje pól (dla panelu) oraz wspólna logika wykonania — używana zarówno przez Discorda (/awans …), jak i przez panel.

const REQUIRED_MSG_CHANNEL = '❌ Kanał docelowy dla tej komendy nie jest skonfigurowany na tym serwerze. Skontaktuj się z właścicielem bota.';

// Gdzie trafia wiadomość, tytuł i kolor embedu
const META = {
  awans: { title: 'AWANS', color: 3066993, channelKey: 'AWANS' },
  degradacja: { title: 'DEGRADACJA', color: 15158332, channelKey: 'DEGRADACJA' },
  zawieszenie: { title: 'ZAWIESZENIE', color: 16753920, channelKey: 'ZAWIESZENIE' },
  zagrozenie: { title: 'WPROWADZONO POZIOM ZAGROŻENIA', color: 16776960, channelKey: 'ZAGROZENIE' },
  odwolaj_zagrozenie: { title: 'ODWOŁANO STAN ZAGROŻENIA', color: 5763719, channelKey: 'ZAGROZENIE' },
  szkolenie: { title: 'SZKOLENIE', color: 3447003, channelKey: 'SZKOLENIE' },
  urlop: { title: 'URLOP OCZEKUJE NA AKCEPTACJE', color: 16753920, channelKey: 'URLOP' },
  zwolnij: { title: 'ZWOLNIENIE', color: 15158332, channelKey: 'ZWOLNIENIA' },
  nagana: { title: 'NAGANA', color: 16711680, channelKey: 'NAGANA' },
  zebranie: { title: 'ZEBRANIE', color: 5793266, channelKey: 'ZEBRANIE' },
  dodaj_pojazd: { title: 'NOWY POJAZD W BAZIE', color: 3447003, channelKey: 'POJAZDY' },
  kara_finansowa: { title: 'KARA FINANSOWA', color: 16766720, channelKey: 'KARY' }
};

export const channelKeyFor = (name) => META[name]?.channelKey || null;

// ───────── Definicje komend widoczne w panelu ─────────
const f = (key, label, type, o = {}) => ({ key, label, type, required: true, ...o });
const PERSON = [
  f('kto', 'Osoba (użytkownik Discord)', 'user'),
  f('imie_nazwisko', 'Imię i nazwisko', 'text', { max: 100, placeholder: 'np. Jan Kowalski' }),
  f('powod', 'Powód', 'text', { max: 500 })
];

export const COMMAND_DEFS = [
  { name: 'awans', label: 'Awans', emoji: '📈', group: 'Kadry', description: 'Awansuje osobę na nowy stopień i numer odznaki.', fields: [...PERSON.slice(0, 3), f('stopien', 'Nowy stopień (rola)', 'role'), f('odznaka', 'Nowy numer odznaki', 'text', { max: 20 })] },
  { name: 'degradacja', label: 'Degradacja', emoji: '📉', group: 'Kadry', description: 'Obniża stopień osoby i zmienia numer odznaki.', fields: [...PERSON.slice(0, 3), f('stopien', 'Nowy stopień (rola)', 'role'), f('odznaka', 'Nowy numer odznaki', 'text', { max: 20 })] },
  { name: 'zawieszenie', label: 'Zawieszenie', emoji: '⏸️', group: 'Kadry', description: 'Zawiesza osobę na określony czas (nadaje rolę zawieszenia).', fields: [...PERSON, f('czas', 'Czas zawieszenia', 'text', { max: 60, placeholder: 'np. 7 dni, 2 tygodnie albo 25.06.2026', hint: 'Bot sam wyliczy datę powrotu.' })] },
  { name: 'zwolnij', label: 'Zwolnienie', emoji: '🚪', group: 'Kadry', description: 'Zwalnia osobę ze struktur i wysyła jej powiadomienie.', fields: PERSON },
  { name: 'nagana', label: 'Nagana', emoji: '⚠️', group: 'Dyscyplina', description: 'Nadaje oficjalną naganę do akt.', fields: [...PERSON, f('ktora_nagana', 'Która nagana', 'select', { options: [['1/3', '1/3'], ['2/3', '2/3'], ['3/3', '3/3']] })] },
  { name: 'kara_finansowa', label: 'Kara finansowa', emoji: '💸', group: 'Dyscyplina', description: 'Nakłada karę finansową na osobę.', fields: [...PERSON, f('kwota', 'Kwota ($)', 'number', { min: 1, max: 1000000000 })] },
  { name: 'szkolenie', label: 'Szkolenie', emoji: '🎓', group: 'Szkolenia', description: 'Dokumentuje wynik szkolenia lub egzaminu.', fields: [
    f('kto_zdawal', 'Kto zdawał (użytkownik Discord)', 'user'), f('imie_nazwisko', 'Imię i nazwisko', 'text', { max: 100 }),
    f('szkolenie', 'Nazwa szkolenia', 'select', {options: [['NEG', 'NEG'], ['SV', 'SV'], ['PWC', 'PWC'], ['MERY', 'MERY'], ['OCEAN', 'OCEAN'], ['SEU', 'SEU'], ['ASU', 'ASU'], ['LW', 'LW'], ['MED', 'MED'], ['JPAT', 'JPAT']] }), f('szkoleniowiec', 'Szkoleniowiec (użytkownik Discord)', 'user'),
    f('wynik', 'Wynik', 'select', { options: [['zdane', '✅ Zdane'], ['niezdane', '❌ Niezdane']] })] },
  { name: 'zagrozenie', label: 'Wprowadź zagrożenie', emoji: '🚨', group: 'Ogłoszenia', description: 'Wprowadza stan zagrożenia na serwerze.', fields: [
    f('poziom', 'Poziom zagrożenia', 'select', { options: [['Zielony', '🟩 Zielony'], ['Pomarańczowy', '🟧 Pomarańczowy'], ['Czerwony', '🟥 Czerwony'], ['Czarny', '⬛ Czarny']] }),
    f('wprowadzajacy', 'Osoba wprowadzająca', 'user'), f('stopien_wprowadzajacego', 'Stopień osoby wprowadzającej', 'role'), f('powod', 'Powód', 'text', { max: 500 })] },
  { name: 'odwolaj_zagrozenie', label: 'Odwołaj zagrożenie', emoji: '✅', group: 'Ogłoszenia', description: 'Przywraca normalny stan funkcjonowania serwera.', fields: [
    f('osoba_odwolujaca', 'Osoba odwołująca', 'user'), f('stopien_odwolujacego', 'Stopień osoby odwołującej', 'role'), f('powod', 'Powód', 'text', { max: 500 })] },
  { name: 'zebranie', label: 'Zebranie', emoji: '📣', group: 'Ogłoszenia', description: 'Ogłasza zebranie departamentu (oznacza rolę z konfiguracji).', fields: [
    f('data', 'Data', 'date'), f('godzina', 'Godzina', 'time'), f('miejsce', 'Miejsce zebrania', 'text', { max: 200 })] },
  { name: 'dodaj_pojazd', label: 'Dodaj pojazd', emoji: '🚓', group: 'Pojazdy', description: 'Rejestruje pojazd i przesyła dane do arkusza Google.', fields: [
    f('tablica', 'Tablica rejestracyjna', 'text', { max: 20 }), f('model', 'Model pojazdu', 'text', { max: 100 }), f('klasa', 'Klasa pojazdu', 'text', { max: 50 }),
    f('przeglad', 'Ważność przeglądu', 'text', { max: 50, placeholder: 'np. 25.12.2026' }),
    f('silnik', 'Silnik', 'text', { max: 100 }), f('hamulce', 'Hamulce', 'text', { max: 100 }), f('skrzynia', 'Skrzynia biegów', 'text', { max: 100 }),
    f('zawieszenie', 'Zawieszenie', 'text', { max: 100 }), f('turbo', 'Turbo', 'bool', { required: false })] }
];

export const getCommandDef = (name) => COMMAND_DEFS.find((def) => def.name === name) || null;

// ───────── Walidacja danych z formularza ─────────
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
const isId = (v) => /^\d{5,25}$/.test(String(v));

function validDate(value) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (!m) return false;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

// Zwraca { opts, errors:[{field,message}] }. roleIds — dozwolone ID ról serwera (dla pól typu "role").
export function validateCommandInput(def, values = {}, { roleIds = new Set() } = {}) {
  const opts = {};
  const errors = [];
  for (const field of def.fields) {
    const raw = values[field.key];
    const text = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();
    const fail = (message) => errors.push({ field: field.key, message });

    if (field.type === 'bool') {
      if (raw === true || raw === 'true') opts[field.key] = true;
      continue;
    }
    if (!text) { if (field.required) fail('To pole jest wymagane.'); continue; }
    if (CONTROL.test(text)) { fail('Niedozwolone znaki sterujące.'); continue; }

    switch (field.type) {
      case 'user':
        if (!isId(text)) fail('Wybierz użytkownika z listy.'); else opts[field.key] = text;
        break;
      case 'role':
        if (!isId(text) || !roleIds.has(text)) fail('Wybierz rolę z listy.');
        else opts[field.key] = `<@&${text}>`;   // jak po wklejeniu wzmianki roli w komendzie na Discordzie
        break;
      case 'select':
        if (!field.options.some(([value]) => value === text)) fail('Wybierz jedną z dostępnych opcji.'); else opts[field.key] = text;
        break;
      case 'number': {
        const n = Number(text);
        if (!/^\d+$/.test(text) || n < (field.min ?? 0) || n > (field.max ?? Number.MAX_SAFE_INTEGER)) fail(`Podaj liczbę całkowitą od ${field.min ?? 0} do ${field.max}.`);
        else opts[field.key] = n;
        break;
      }
      case 'date':
        if (!validDate(text)) fail('Podaj poprawną datę w formacie DD.MM.RRRR.'); else opts[field.key] = text;
        break;
      case 'time':
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) fail('Podaj godzinę w formacie GG:MM.'); else opts[field.key] = text;
        break;
      default:
        if (text.length > (field.max || 500)) fail(`Maksymalnie ${field.max || 500} znaków (jest ${text.length}).`); else opts[field.key] = text;
    }
  }
  return { opts, errors };
}

// ───────── Wykonanie komendy ─────────
// ctx: { guildId, guildConfig, userId, channelId, dni, via }
// deps: funkcje bota (wysyłanie wiadomości, DM, arkusz, role, logi…) — wstrzykiwane, dzięki czemu logikę da się testować.
// Z Discorda osobę wpisuje się jako tekst, a w panelu wybiera z listy (wtedy dostajemy samo ID) — ID zamieniamy na wzmiankę
const person = (value) => (/^\d{5,25}$/.test(String(value)) ? `<@${value}>` : value);

export async function runFactionCommand(name, opts, ctx, deps) {
  const { guildId, guildConfig, userId, channelId = null, dni, via = 'discord' } = ctx;
  const meta = META[name];
  if (!meta) return { ok: false, unknown: true, message: 'Unknown command' };

  const cfg = { title: meta.title, color: meta.color, channel: guildConfig.CHANNELS?.[meta.channelKey] };
  if (!cfg.channel || cfg.channel === 'ID' || cfg.channel === 'ID_KANALU') return { ok: false, message: REQUIRED_MSG_CHANNEL };

  const now = new Date();
  const data = `${now.toLocaleDateString('pl-PL', { timeZone: 'Europe/Warsaw' })} ${now.toLocaleTimeString('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' })}`;

  let description = '';
  let content = opts.kto ? `<@${opts.kto}>` : '';
  let components = [];
  let finalColor = cfg.color;

  const guildInfo = await deps.getGuildInfo(guildId);
  const guildName = guildInfo?.name || 'Nieznany serwer';
  const background = (promise, label) => Promise.resolve(promise).catch((e) => console.error(`Błąd ${label}:`, e));

  if (name === 'urlop') {
    const dniLabel = dni === 1 ? 'dzień' : 'dni';
    description = `**Rozpoczęcie:** ${opts.rozpoczecie}\n**Zakończenie:** ${opts.zakonczenie}\n**Czas:** ${dni} ${dniLabel}\n**Powód:** ${opts.powod}\n\n**Złożone przez:** <@${userId}>\n**Data:** ${data}`;
    components = [{ type: 1, components: [
      { type: 2, label: 'AKCEPTUJ', style: 3, custom_id: `urlop_accept_${userId}` },
      { type: 2, label: 'ODRZUĆ', style: 4, custom_id: `urlop_reject_${userId}` }
    ] }];
    background(deps.sendDM(userId, '✅ Twój wniosek urlopowy został przesłany i oczekuje na akceptację.'), 'wysyłania DM urlopu');
    background(deps.sendToGoogleSheet(guildConfig.GOOGLE_SHEET_WEBHOOK_URL, { kto_id: userId, zakonczenie: opts.zakonczenie }), 'wysyłania urlopu do Google Sheets');
  } else if (name === 'szkolenie') {
    const isZdane = opts.wynik === 'zdane';
    cfg.title = isZdane ? 'Szkolenie Zdane' : 'Szkolenie Niezdane';
    finalColor = isZdane ? 5763719 : 15158332;
    content = `<@${opts.kto_zdawal}>`;
    description = `**Kto:** ${opts.imie_nazwisko}\n**Szkolenie:** ${opts.szkolenie}\n**Szkoleniowiec:** <@${opts.szkoleniowiec}>\n\n**${data}**`;
    if (opts.kto_zdawal) {
      background(deps.sendDM(opts.kto_zdawal, `**${guildName}** - **${opts.imie_nazwisko}** Twoje szkolenie **${opts.szkolenie}** zostało **${opts.wynik}**!!!`), 'wysyłania DM szkolenia');
    }
    if (isZdane) background(deps.sendToGoogleSheet(guildConfig.GOOGLE_SHEET_WEBHOOK_URL, { kto_id: opts.kto_zdawal, szkolenie: opts.szkolenie }), 'wysyłania szkolenia do Google Sheets');
  } else if (name === 'zagrozenie') {
    if (opts.poziom) {
      const colorMap = { Zielony: 5763719, 'Pomarańczowy': 16753920, Czerwony: 15158332, Czarny: 2303786 };
      finalColor = colorMap[opts.poziom] || cfg.color;
    }
    cfg.title = `WPROWADZONO POZIOM ZAGROŻENIA "${opts.poziom}"`;
    description = `**Osoba wprowadzająca:** ${person(opts.wprowadzajacy)}\n**Stopień osoby wprowadzającej:** ${opts.stopien_wprowadzajacego}\n**Powód:** ${opts.powod}\n**Data oraz godzina:** ${data}`;
  } else if (name === 'odwolaj_zagrozenie') {
    finalColor = 5763719;
    description = `**Osoba odwołująca:** ${person(opts.osoba_odwolujaca)}\n**Stopień osoby odwołującej:** ${opts.stopien_odwolujacego}\n**Powód:** ${opts.powod}\n**Data oraz godzina:** ${data}`;
  } else if (name === 'zawieszenie') {
    description = `**Kto:** ${opts.imie_nazwisko}\n**Powód:** ${opts.powod}\n**Czas zawieszenia:** ${opts.czas}\n**Zawieszono przez:** <@${userId}>\n\n**${data}**`;
    if (opts.kto) {
      background(deps.sendDM(opts.kto, `**${guildName}** - **${opts.imie_nazwisko}** Zostałeś **ZAWIESZONY** na **${opts.czas}** z powodu **${opts.powod}**`), 'wysyłania DM zawieszenia');
      background(deps.sendToGoogleSheet(guildConfig.GOOGLE_SHEET_WEBHOOK_URL, { kto_id: opts.kto, zawieszenie: true }), 'wysyłania zawieszenia do Google Sheets');
      const roleId = guildConfig.ROLES?.ZAWIESZENIE_ROLE_ID;
      if (roleId && roleId !== 'ID') background(deps.addRoleToMember(guildId, opts.kto, roleId), 'dodawania roli zawieszenia');
    }
  } else if (name === 'zwolnij') {
    content = `<@${opts.kto}>`;
    description = `**Kto:** ${opts.imie_nazwisko}\n**Powód:** ${opts.powod}\n**Nadane przez:** <@${userId}>\n\n**${data}**`;
    if (opts.kto) background(deps.sendDM(opts.kto, `**${guildName}** - **${opts.imie_nazwisko}** Zostałeś **ZWOLNIONY** z powodu **${opts.powod}**`), 'wysyłania DM zwolnienia');
  } else if (name === 'nagana') {
    content = `<@${opts.kto}>`;
    description = `**Kto:** ${opts.imie_nazwisko}\n**Powód:** ${opts.powod}\n**Która nagana:** ${opts.ktora_nagana}\n**Nadane przez:** <@${userId}>\n\n**${data}**`;
    background(deps.sendToGoogleSheet(guildConfig.GOOGLE_SHEET_WEBHOOK_URL, { kto_id: opts.kto, nagana: opts.ktora_nagana }), 'wysyłania do Google Sheets');
    if (opts.kto) background(deps.sendDM(opts.kto, `**${guildName}** - **${opts.imie_nazwisko}** Została nałożona na ciebie **${opts.ktora_nagana}** **NAGANA** z powodu **${opts.powod}**`), 'wysyłania DM nagany');
  } else if (name === 'kara_finansowa') {
    content = `<@${opts.kto}>`;
    description = `**Kto:** ${opts.imie_nazwisko}\n**Powód:** ${opts.powod}\n**Kwota:** ${opts.kwota}$\n**Nadane przez:** <@${userId}>\n\n**${data}**`;
  } else if (name === 'dodaj_pojazd') {
    const isTurbo = opts.turbo ? 'TRUE' : 'FALSE';
    description = `**Właściciel / Rejestrujący:** <@${userId}>\n` +
      `**Tablica Rejestracyjna:** ${opts.tablica}\n**Model pojazdu:** ${opts.model}\n**Klasa pojazdu:** ${opts.klasa}\n**Ważność przeglądu:** ${opts.przeglad}\n\n` +
      `🔧 **Modyfikacje (Tuning):**\n> **Silnik:** ${opts.silnik}\n> **Hamulce:** ${opts.hamulce}\n> **Skrzynia biegów:** ${opts.skrzynia}\n> **Zawieszenie:** ${opts.zawieszenie}\n> **Turbo:** ${isTurbo}\n\n` +
      `**Data dodania do rejestru:** ${data}`;
    background(deps.sendToGoogleSheet(guildConfig.GOOGLE_SHEET_WEBHOOK_URL, {
      nowy_pojazd: true, tablica: opts.tablica, model: opts.model, klasa: opts.klasa, przeglad: opts.przeglad,
      silnik: opts.silnik, hamulce: opts.hamulce, skrzynia: opts.skrzynia, zawieszenie: opts.zawieszenie, turbo: isTurbo
    }), 'wysyłania pojazdu do Google Sheets');
  } else if (name === 'awans' || name === 'degradacja') {
    const awans = name === 'awans';
    content = `<@${opts.kto}>`;
    description = `**Kto:** ${opts.imie_nazwisko}\n**Powód:** ${opts.powod}\n**Nowy stopień:** ${opts.stopien}\n**Nowy numer odznaki:** ${opts.odznaka}\n**${awans ? 'Awansowany' : 'Zdegradowany'} przez:** <@${userId}>\n\n**${data}**`;
    if (opts.kto) {
      const roleName = await deps.getRoleName(guildId, opts.stopien);
      const verb = awans ? 'AWANSOWANY' : 'ZDEGRADOWANY';
      background(deps.sendDM(opts.kto, `**${guildName}** - **${opts.imie_nazwisko}** Zostałeś **${verb}** na **${roleName}** z powodu **${opts.powod}** twój nowy numer odznaki to: ${opts.odznaka}`), `wysyłania DM ${awans ? 'awansu' : 'degradacji'}`);
    }
  } else if (name === 'zebranie') {
    const roleId = guildConfig.PING_ROLE_ID;
    const pingMention = (roleId && roleId !== 'ID') ? `<@&${roleId}>` : '';
    content = pingMention;
    description = `**ZEBRANIE DEPARTAMENTU** ${pingMention}\n**Data:** ${opts.data}\n**Godzina:** ${opts.godzina}\n**Miejsce Zebrania:** ${opts.miejsce}\n\n` +
      `*Dziś o ${now.toLocaleTimeString('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' })}*`;
  }

  const sentMessage = await deps.sendChannelMessage(cfg.channel, { content, embeds: [{ title: cfg.title, color: finalColor, description }], components });
  if (!sentMessage) {
    return { ok: false, message: `⚠️ Komenda ${name} przetworzona, ale wystąpił błąd przy wysyłaniu wiadomości na kanał docelowy. Sprawdź uprawnienia bota i konfigurację kanału.` };
  }

  if (name === 'urlop' && sentMessage.id) deps.registerPendingUrlop?.(sentMessage.id, userId);

  if (name === 'zawieszenie' && opts.kto && sentMessage.id) {
    try {
      await deps.saveAbsence({
        id: sentMessage.id, guildId, userId: opts.kto, displayName: opts.imie_nazwisko || opts.kto, kind: 'suspension', reason: opts.powod,
        startsOn: deps.todayInWarsaw(), returnsOn: deps.parseSuspensionReturnDate(opts.czas)
      });
    } catch (error) {
      console.error('Nie udało się zapisać zawieszenia:', error.message);
    }
  }

  const opcjeTekst = Object.keys(opts).length ? Object.entries(opts).map(([key, value]) => `**${key}:** ${value}\n`).join('') : 'Brak argumentów.';
  background(deps.sendWebhookLog(guildConfig.WEBHOOK_URL, {
    title: `🛠️ Użyto komendy: /${name}${via === 'panel' ? ' (panel WWW)' : ''}`,
    color: 3447003,
    description: `**Użytkownik:** <@${userId}>\n**Kanał:** ${channelId ? `<#${channelId}>` : 'panel WWW'}\n\n**Przekazane dane:**\n${opcjeTekst}`,
    timestamp: new Date().toISOString()
  }), 'logowania komendy');

  deps.addDashboardLog('info', `Użyto komendy /${name} na serwerze ${guildId}${via === 'panel' ? ' (z panelu)' : ''}.`, {
    guildId, source: 'server', command: name, userId, channelId, options: opts, via
  });

  return { ok: true, message: `✅ Komenda ${name} wykonana!`, sentMessage, channelId: cfg.channel };
}
