import express from 'express';
import { verifyKeyMiddleware, InteractionType, InteractionResponseType } from 'discord-interactions';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// --- TWOJE ID DISCORD (TYLKO TY MOŻESZ UŻYĆ /pomoc I /pomoc_urlop) ---
const BOT_OWNER_ID = "419910833112350720"; 

// --- TABELA KONFIGURACJI SERWERÓW ---
const serverConfigs = {
  //Field Training Division - TESTOWE
  "1476244145440948256": {
    REQUIRED_ROLE_IDS: ["1476244145923297429", "TUTAJ_MOZESZ_DODAC_DRUGA_ROLE_TESTOWA"],
    PING_ROLE_ID: "ID",
    CHANNELS: {
      AWANS: "1476244147202428977", DEGRADACJA: "1476244147202428977", ZAWIESZENIE: "1476244147202428977", 
      ZAGROZENIE: "1476244147202428977", SZKOLENIE: "1476244147202428977", URLOP: "1476244147202428977", 
      ZWOLNIENIA: "1476244147202428977", NAGANA: "1476244147202428977", KARY: "1476244147202428977", ZEBRANIE: "ID"
    }
  },
  //LSPD
  "1344364720605499442": {
    REQUIRED_ROLE_IDS: ["1505571491180314956", "1344373183079256064", "1344664019751014543"],
    PING_ROLE_ID: "1344364929775304775",
    CHANNELS: {
      AWANS: "1344379382013362238", DEGRADACJA: "1344379443858247700", ZAWIESZENIE: "1344379535436546099", 
      ZAGROZENIE: "1417946459378024519", SZKOLENIE: "1344386111975329925", URLOP: "1344379129193173094", 
      ZWOLNIENIA: "1344379809278595114", NAGANA: "1519663613386952774", KARY: "1519663613386952774", ZEBRANIE: "1344374624636502126"
    }
  },
  //BCSO
  "ID_TWOJEGO_SERWERA_3": {
    REQUIRED_ROLE_IDS: ["ID_ROLI_ADMINA_1", "ID_ROLI_ADMINA_2"],
    PING_ROLE_ID: "ID_ROLI_LSPD_DO_PINGOWANIA",
    CHANNELS: {
      AWANS: "ID_KANALU", DEGRADACJA: "ID_KANALU", ZAWIESZENIE: "ID_KANALU", 
      ZAGROZENIE: "ID_KANALU", SZKOLENIE: "ID_KANALU", URLOP: "ID_KANALU", 
      ZWOLNIENIA: "ID_KANALU", NAGANA: "ID_KANALU", KARY: "ID_KANALU", ZEBRANIE: "ID"
    }
  },
  //LSSD
  "ID_TWOJEGO_SERWERA_4": {
    REQUIRED_ROLE_IDS: ["ID_ROLI_ADMINA_1", "ID_ROLI_ADMINA_2"],
    PING_ROLE_ID: "ID_ROLI_LSPD_DO_PINGOWANIA",
    CHANNELS: {
      AWANS: "ID_KANALU", DEGRADACJA: "ID_KANALU", ZAWIESZENIE: "ID_KANALU", 
      ZAGROZENIE: "ID_KANALU", SZKOLENIE: "ID_KANALU", URLOP: "ID_KANALU", 
      ZWOLNIENIA: "ID_KANALU", NAGANA: "ID_KANALU", KARY: "ID_KANALU", ZEBRANIE: "ID"
    }
  },
  //DOC
  "ID_TWOJEGO_SERWERA_5": {
    REQUIRED_ROLE_IDS: ["ID_ROLI_ADMINA_1", "ID_ROLI_ADMINA_2"],
    PING_ROLE_ID: "ID_ROLI_LSPD_DO_PINGOWANIA",
    CHANNELS: {
      AWANS: "ID_KANALU", DEGRADACJA: "ID_KANALU", ZAWIESZENIE: "ID_KANALU", 
      ZAGROZENIE: "ID_KANALU", SZKOLENIE: "ID_KANALU", URLOP: "ID_KANALU", 
      ZWOLNIENIA: "ID_KANALU", NAGANA: "ID_KANALU", KARY: "ID_KANALU", ZEBRANIE: "ID"
    }
  },
};

// Funkcja pomocnicza do wysyłania wiadomości prywatnych (DM)
async function sendDM(userId, content) {
  try {
    const channelRes = await fetch(`https://discord.com/api/v10/users/@me/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      body: JSON.stringify({ recipient_id: userId })
    });
    const channel = await channelRes.json();
    await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      body: JSON.stringify({ content })
    });
  } catch (e) {
    console.error("Nie udało się wysłać DM:", e);
  }
}

app.post('/interactions', verifyKeyMiddleware(process.env.DISCORD_PUBLIC_KEY), async (req, res) => {
  const interaction = req.body;
  if (interaction.type === InteractionType.PING) return res.json({ type: InteractionResponseType.PONG });

  // Pobranie konfiguracji dla serwera, na którym wywołano interakcję
  const guildConfig = serverConfigs[interaction.guild_id];
  
  // Jeśli serwer nie jest skonfigurowany, przerywamy działanie
  if (!guildConfig) {
    return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Ten serwer nie jest skonfigurowany.", flags: 64 } });
  }

  // --- 1. OBSŁUGA MODALA (POWÓD ODRZUCENIA) ---
  if (interaction.type === 5) { // 5 = MODAL_SUBMIT
    const customId = interaction.data.custom_id;
    if (customId.startsWith('modal_reject_')) {
      const targetUserId = customId.replace('modal_reject_', '');
      const powod = interaction.data.components[0].components[0].value;
      const adminName = interaction.member.user.username;
      const originalEmbed = interaction.message.embeds[0];

      await sendDM(targetUserId, `❌ Twój wniosek urlopowy został ODRZUCONY przez administratora **${adminName}**.\n**Powód:** ${powod}`);
      
      return res.json({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          embeds: [{ 
            title: "URLOP ODRZUCONY", 
            color: 15158332, 
            description: originalEmbed.description + `\n\n**Odrzucone przez:** <@${interaction.member.user.id}>\n**Powód odrzucenia:** ${powod}` 
          }],
          components: []
        }
      });
    }
  }

  // --- 2. OBSŁUGA KLIKNIĘĆ W PRZYCISKI ---
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = interaction.data.custom_id;
    if (customId.startsWith('urlop_')) {
      // Zabezpieczenie: Sprawdzanie czy użytkownik ma przynajmniej jedną z ról w tablicy REQUIRED_ROLE_IDS
      const memberRoles = interaction.member.roles || [];
      const hasAdminRole = guildConfig.REQUIRED_ROLE_IDS && guildConfig.REQUIRED_ROLE_IDS.some(roleId => memberRoles.includes(roleId));

      if (!hasAdminRole) {
        return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Tylko administratorzy mogą rozpatrywać wnioski urlopowe.", flags: 64 } });
      }

      const [, action, targetUserId] = customId.split('_');
      const originalEmbed = interaction.message.embeds[0];
      const adminName = interaction.member.user.username;

      if (action === 'accept') {
        await sendDM(targetUserId, `🎉 Twój wniosek o urlop został ZAAKCEPTOWANY przez administratora **${adminName}**!`);
        return res.json({
          type: InteractionResponseType.UPDATE_MESSAGE,
          data: {
            embeds: [{ title: "URLOP ZAAKCEPTOWANY", color: 5763719, description: originalEmbed.description + `\n\n**Zaakceptowane przez:** <@${interaction.member.user.id}>` }],
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
  }

  // --- 3. OBSŁUGA KOMEND ---
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const { name, options } = interaction.data;
    const opts = {};
    if (options) options.forEach((opt) => opts[opt.name] = opt.value);

    // --- BLOKADA DLA KOMEND WŁAŚCICIELA (/pomoc oraz /pomoc_urlop) ---
    if (name === 'pomoc' || name === 'pomoc_urlop') {
      // Jeśli ktoś inny wpisze komendę – dostanie ukrytą wiadomość z błędem
      if (interaction.member.user.id !== BOT_OWNER_ID) {
        return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Ta komenda jest dostępna tylko dla właściciela bota.", flags: 64 } });
      }

      // Treść komendy pomoc – usunięto flage 64 (będzie publiczna dla wszystkich)
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
                "⚙️ **Jak zarządzać wnioskami urlopowymi (Akceptacja/Odrzucenie):**\n" +
                "Kiedy użytkownik poprawnie wyśle wniosek urlopowy, pod wiadomością pojawią się dwa duże przyciski:\n" +
                "1. **AKCEPTUJ (Zielony)** — Kliknięcie przycisku natychmiast zmienia kolor całego wniosku na zielony, usuwa przyciski z kanału (żeby nikt nie kliknął drugi raz) i automatycznie wysyła do pracownika prywatną wiadomość (DM) o pozytywnym rozpatrzeniu.\n" +
                "2. **ODRZUĆ (Czerwony)** — Po kliknięciu bot wyświetli na ekranie wyskakujące okienko (Modal). Administrator **musi** wpisać w nim powód odrzucenia wniosku. Po zatwierdzeniu formularza, wniosek na kanale zmieni kolor na czerwony, dopisze powód odrzucenia oraz nick administratora, a pracownik otrzyma powód odmowy bezpośrednio na swoje DM."
            }]
          }
        });
      }

      // Treść komendy pomoc_urlop – usunięto flage 64 (będzie publiczna dla wszystkich)
      if (name === 'pomoc_urlop') {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            embeds: [{
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
                "4. Na kanale generuje się estetyczny pomarańczowy dokument z przyciskami decyzyjnymi dla Zarządu."
            }],
          }
        });
      }
    }

    // Weryfikacja kanału dla urlopu
    if (name === 'urlop' && interaction.channel_id !== guildConfig.CHANNELS.URLOP) {
      return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `❌ Komenda /urlop jest dostępna tylko na kanale <#${guildConfig.CHANNELS.URLOP}>.`, flags: 64 } });
    }

    // Weryfikacja daty dla urlopu
    if (name === 'urlop') {
      const dateRegex = /^\d{2}\.\d{2}\.\d{4}$/;
      if (!dateRegex.test(opts.rozpoczecie) || !dateRegex.test(opts.zakonczenie)) {
        await sendDM(interaction.member.user.id, "❌ Błędny format daty! Użyj formatu DD.MM.RRRR (np. 25.06.2026).");
        return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Błędny format daty! Sprawdź wiadomość prywatną od bota.", flags: 64 } });
      }
    }

    // Walidacja uprawnień do reszty komend (sprawdzanie wielu ról z tablicy)
    const memberRoles = interaction.member.roles || [];
    const hasAdminRole = guildConfig.REQUIRED_ROLE_IDS && guildConfig.REQUIRED_ROLE_IDS.some(roleId => memberRoles.includes(roleId));

    if (name !== 'urlop' && !hasAdminRole) {
      return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Brak uprawnień.", flags: 64 } });
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
      kara_finansowa: { title: 'KARA FINANSOWA', color: 16766720, channel: guildConfig.CHANNELS.KARY }
    };

    const cfg = configs[name];
    if (!cfg) return res.status(400).json({ error: 'Unknown command' });

    const now = new Date();
    const data = `${now.toLocaleDateString("pl-PL", { timeZone: "Europe/Warsaw" })} ${now.toLocaleTimeString("pl-PL", { timeZone: "Europe/Warsaw", hour: '2-digit', minute: '2-digit' })}`;
    
    let description = "", content = opts.kto ? `<@${opts.kto}>` : "", components = [];
    let finalColor = cfg.color;

    if (name === 'urlop') {
      const dni = parseInt(opts.czas);
      const dniLabel = dni === 1 ? "dzień" : "dni";

      description = `**Rozpoczęcie:** ${opts.rozpoczecie}\n**Zakończenie:** ${opts.zakonczenie}\n**Czas:** ${dni} ${dniLabel}\n**Powód:** ${opts.powod}\n\n**Złożone przez:** <@${interaction.member.user.id}>\n**Data:** ${data}`;
      components = [{ type: 1, components: [
        { type: 2, label: "AKCEPTUJ", style: 3, custom_id: `urlop_accept_${interaction.member.user.id}` },
        { type: 2, label: "ODRZUĆ", style: 4, custom_id: `urlop_reject_${interaction.member.user.id}` }
      ]}];
      await sendDM(interaction.member.user.id, "✅ Twój wniosek urlopowy został przesłany i oczekuje na akceptację.");
    } 
    else if (name === 'szkolenie') {
      const isZdane = opts.wynik === 'zdane';
      cfg.title = isZdane ? "Szkolenie Zdane" : "Szkolenie Niezdane";
      finalColor = isZdane ? 5763719 : 15158332;
      content = `<@${opts.kto_zdawal}>`;
      description = `**Kto:** ${opts.imie_nazwisko}\n**Szkolenie:** ${opts.szkolenie}\n**Szkoleniowiec:** <@${opts.szkoleniowiec}>\n\n**${data}**`;
    }
    else if (name === 'zagrozenie') {
     // content = "@everyone"; 
      if (opts.poziom) {
        const colorMap = { 'Zielony': 5763719, 'Pomarańczowy': 16753920, 'Czerwony': 15158332, 'Czarny': 2303786 };
        finalColor = colorMap[opts.poziom] || cfg.color;
      }
      cfg.title = `WPROWADZONO POZIOM ZAGROŻENIA "${opts.poziom}"`;
      description = `**Osoba wprowadzająca:** ${opts.wprowadzajacy}\n**Stopień osoby wprowadzającej:** ${opts.stopien_wprowadzajacego}\n**Powód:** ${opts.powod}\n**Data oraz godzina:** ${data}`;
    } 
    else if (name === 'odwolaj_zagrozenie') {
     // content = "@everyone";
      finalColor = 5763719;
      description = `**Osoba odwołująca:** ${opts.osoba_odwolujaca}\n**Stopień osoby odwołującej:** ${opts.stopien_odwolujacego}\n**Powód:** ${opts.powod}\n**Data oraz godzina:** ${data}`;
    }
    else if (name === 'zawieszenie') {
      description = `**Kto:** ${opts.imie_nazwisko}\n**Powód:** ${opts.powod}\n**Czas zawieszenia:** ${opts.czas}\n**Zawieszono przez:** <@${interaction.member.user.id}>\n\n**${data}**`;
    } 
    else if (name === 'zwolnij') {
      content = `<@${opts.kto}>`;
      description = `Kto: ${opts.imie_nazwisko}\nPowód: **${opts.powod}**\nNadane przez: <@${interaction.member.user.id}>\n\n${data}`;
    }
    else if (name === 'nagana') {
      content = `<@${opts.kto}>`;
      description = `**Kto:** ${opts.imie_nazwisko}\n**Powód:** ${opts.powod}\n**Która nagana:** ${opts.ktora_nagana}\n**Nadane przez:** <@${interaction.member.user.id}>\n\n**${data}**`;
    }
    else if (name === 'kara_finansowa') {
      content = `<@${opts.kto}>`;
      description = `**Kto:** ${opts.imie_nazwisko}\n**Powód:** ${opts.powod}\n**Kwota:** ${opts.kwota}$\n**Nadane przez:** <@${interaction.member.user.id}>\n\n**${data}**`;
    }
      else if (name === 'zebranie') {
      // Pobieramy ID roli z konfiguracji
      const roleId = guildConfig.PING_ROLE_ID;
      content = roleId ? `<@&${roleId}>` : "@everyone"; 
      
      // Formatowanie zgodne z obrazkiem image_3f9d06.png
      description = `**ZEBRANIE DEPARTAMENTU** <@&${roleId}>\n` +
                    `**Data:** ${opts.data}\n` +
                    `**Godzina:** ${opts.godzina}\n` +
                    `**Miejsce Zebrania:** ${opts.miejsce}\n\n` +
                    `*Dziś o ${now.toLocaleTimeString("pl-PL", { timeZone: "Europe/Warsaw", hour: '2-digit', minute: '2-digit' })}*`;
    }
    else {
      description = `**Kto:** ${opts.imie_nazwisko}\n**Powód:** ${opts.powod}\n**Nowy stopień:** ${opts.stopien}\n**Nowy numer odznaki:** ${opts.odznaka}\n**Nadane przez:** <@${interaction.member.user.id}>\n\n**${data}**`;
    }

    await fetch(`https://discord.com/api/v10/channels/${cfg.channel}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      body: JSON.stringify({ content, embeds: [{ title: cfg.title, color: finalColor, description }], components })
    });

    return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `✅ Komenda ${name} wykonana!`, flags: 64 } });
  }
});

app.listen(PORT, () => console.log(`🤖 Bot działa na porcie ${PORT}`));
