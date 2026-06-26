import express from 'express';
import { verifyKeyMiddleware, InteractionType, InteractionResponseType } from 'discord-interactions';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// --- TWOJE ID DISCORD (TYLKO TY MOŻESZ UŻYĆ /pomoc I /pomoc_urlop) ---
const BOT_OWNER_ID = process.env.BOT_OWNER_ID;

// --- TABELA KONFIGURACJI SERWERÓW ---
// Cała konfiguracja (webhooki, role, kanały) jest teraz w zmiennej środowiskowej SERVER_CONFIGS_JSON
// jako jeden zminifikowany JSON — patrz .env.example dla pełnego szablonu i README dla instrukcji.
// Nic z tego nie jest już zapisane w kodzie, więc plik jest bezpieczny do trzymania w publicznym repo.
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

// Walidacja podstawowych sekretów na starcie — szybki, czytelny błąd w logach lepszy niż ciche, dziwne crashe później.
const REQUIRED_ENV_VARS = ['DISCORD_PUBLIC_KEY', 'DISCORD_BOT_TOKEN', 'BOT_OWNER_ID', 'SERVER_CONFIGS_JSON'];
for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]) {
    console.error(`❌ BRAK wymaganej zmiennej środowiskowej: ${key}. Bot może nie działać poprawnie.`);
  }
}

// Informacyjna walidacja per-serwer: każdy serwer MOŻE mieć własny GOOGLE_SHEET_WEBHOOK_URL w SERVER_CONFIGS_JSON.
// To nie jest błąd krytyczny (bot dalej działa, po prostu nie zapisze /urlop i /szkolenie do arkusza tego serwera),
// ale warto wiedzieć o tym z logów startowych, a nie dopiero gdy ktoś użyje komendy.
for (const [guildId, cfg] of Object.entries(serverConfigs)) {
  if (!cfg.GOOGLE_SHEET_WEBHOOK_URL) {
    console.warn(`⚠️ Serwer ${guildId} nie ma ustawionego GOOGLE_SHEET_WEBHOOK_URL — wpisy /urlop i /szkolenie nie będą zapisywane do arkusza dla tego serwera.`);
  }
}

// --- ŚLEDZENIE WNIOSKÓW URLOPOWYCH W TOKU (anty race-condition + anty-spam) ---
// Klucz: messageId wniosku -> true, dopóki nie zostanie rozpatrzony.
// Klucz: userId -> true, jeśli ma już aktywny (nierozpatrzony) wniosek.
const pendingUrlopMessages = new Set();
const usersWithPendingUrlop = new Set();

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

// FIX: URL jest teraz przekazywany jako argument (z config danego serwera: guildConfig.GOOGLE_SHEET_WEBHOOK_URL),
// a nie czytany z jednej globalnej zmiennej środowiskowej — każdy serwer może mieć swój własny arkusz Google Sheets.
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
// Zwraca true/false żeby wołający mógł zareagować (np. ostrzec admina, że DM nie doszedł bo user ma zablokowane DM)
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

// Funkcja pomocnicza do wysyłania wiadomości na kanał serwera.
// Zwraca true/false, żeby handler komendy wiedział czy faktycznie się powiodło
// (zamiast zawsze zwracać "✅ wykonano" niezależnie od wyniku).
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

// --- LOG O AKTUALIZACJI BOTA (najnowszy commit z GitHub, branch main) ---
// Ustaw w zmiennych środowiskowych:
//   GITHUB_REPO       -> w formacie "owner/repo" (wymagane, żeby ta funkcja coś zrobiła)
//   GITHUB_BRANCH     -> opcjonalny, domyślnie "main"
//   GITHUB_TOKEN      -> opcjonalny, podnosi limit zapytań do GitHub API (repo jest publiczne, więc nie jest wymagany)
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

    // Konwencja GitHuba: pierwsza linia = tytuł, reszta po pustej linii = opis.
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

// Discord embed description ma limit 4096 znaków — opis commita może być długi (changelogi, listy zmian itd.),
// więc obcinamy bezpiecznie i dodajemy info, że dalsza część jest tylko na GitHubie.
function truncateForEmbed(text, maxLength = 3500) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\n\n…*(opis przycięty, pełna treść na GitHubie)*";
}

// Wysyła log "bot zaktualizowany" na webhooki WSZYSTKICH skonfigurowanych serwerów.
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

  const sentWebhooks = new Set(); // żeby nie wysłać 2x na ten sam webhook, jeśli kilka serwerów go współdzieli
  for (const guildId of Object.keys(serverConfigs)) {
    const webhookUrl = serverConfigs[guildId].WEBHOOK_URL;
    if (!webhookUrl || webhookUrl === "TUTAJ_LINK_DO_WEBHOOKA" || sentWebhooks.has(webhookUrl)) continue;
    sentWebhooks.add(webhookUrl);
    await sendWebhookLog(webhookUrl, embed);
  }

  console.log(`✅ Log o aktualizacji (commit ${commit.shortSha}) wysłany na ${sentWebhooks.size} webhook(i).`);
}

// Walidacja daty w formacie DD.MM.RRRR — sprawdza format ORAZ że to realna data kalendarzowa.
function parseStrictDate(value) {
  const dateRegex = /^(\d{2})\.(\d{2})\.(\d{4})$/;
  const match = dateRegex.exec(value || "");
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const year = parseInt(match[3], 10);

  const date = new Date(year, month - 1, day);
  // Jeśli np. wpisano 31.02.2026, JS "przeleje" datę na marzec — sprawdzamy że się zgadza.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
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
      // FIX: ten handler wcześniej NIE sprawdzał uprawnień — każdy mógł wypełnić modal i odrzucić urlop.
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

      // FIX: jeśli wiadomość już rozpatrzona w międzyczasie (np. drugi admin kliknął chwilę wcześniej)
      // albo embed zniknął z jakiegoś powodu, przerywamy zamiast wybuchać błędem / dublować akcję.
      if (!originalEmbed || (messageId && !pendingUrlopMessages.has(messageId))) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "⚠️ Ten wniosek został już rozpatrzony albo nie jest już dostępny.", flags: 64 }
        });
      }
      if (messageId) pendingUrlopMessages.delete(messageId);
      usersWithPendingUrlop.delete(targetUserId);

      const dmOk = await sendDM(targetUserId, `❌ Twój wniosek urlopowy został **ODRZUCONY** przez administratora **${adminName}**.\n**Powód:** ${powod}`);

      // LOGOWANIE ODRZUCENIA
      await sendWebhookLog(guildConfig.WEBHOOK_URL, {
        title: "📝 Akcja: Odrzucenie Urlopu",
        color: 15158332,
        description: `Administrator <@${interaction.member.user.id}> odrzucił wniosek urlopowy użytkownika <@${targetUserId}>.\n**Powód:** ${powod}` +
          (dmOk ? "" : "\n⚠️ *Nie udało się wysłać DM do użytkownika (może mieć zablokowane wiadomości prywatne).*")
      });

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
    // FIX: jeśli trafi tu inny modal submit niewiadomego custom_id, zawsze odpowiadamy,
    // żeby Discord nie zobaczył timeoutu / "interakcja nie powiodła się".
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

      // FIX: guard na brak embeda + na race condition (dwóch adminów klika niemal jednocześnie).
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

        // FIX: dodaj rolę "Na urlopie" do użytkownika
        const urlopRoleId = guildConfig.ROLES?.URLOP_ROLE_ID;
        const roleAdded = urlopRoleId ? await addRoleToMember(interaction.guild_id, targetUserId, urlopRoleId) : false;

        const dmOk = await sendDM(targetUserId, `🎉 Twój wniosek o urlop został **ZAAKCEPTOWANY** przez administratora **${adminName}**!`);

        // LOGOWANIE AKCEPTACJI
        await sendWebhookLog(guildConfig.WEBHOOK_URL, {
          title: "📝 Akcja: Akceptacja Urlopu",
          color: 5763719,
          description: `Administrator <@${interaction.member.user.id}> zaakceptował wniosek urlopowy użytkownika <@${targetUserId}>.` +
            (dmOk ? "" : "\n⚠️ *Nie udało się wysłać DM do użytkownika (może mieć zablokowane wiadomości prywatne).*") +
            (roleAdded ? "" : "\n⚠️ *Nie udało się dodać roli \"Na urlopie\" (rola może być niezakonfigurowana).*")
        });

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
    // FIX: fallback, żeby nieobsłużone custom_id nie zostawiało Discorda bez odpowiedzi.
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
                "4. Na kanale generuje się estetyczny pomarańczowy dokument z przyciskami decyzyjnymi dla Zarządu.\n" +
                "5. Jeśli masz już aktywny, nierozpatrzony wniosek, bot nie pozwoli złożyć kolejnego — najpierw musi zostać rozpatrzony obecny."
            }],
          }
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

      // FIX: walidacja logiki dat — zakończenie nie może być przed rozpoczęciem.
      if (endDateObj < startDateObj) {
        await sendDM(interaction.member.user.id, "❌ Data zakończenia urlopu nie może być wcześniejsza niż data rozpoczęcia.");
        return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Błędny zakres dat! Sprawdź wiadomość prywatną od bota.", flags: 64 } });
      }

      // FIX: walidacja że "czas" to liczba całkowita dodatnia, nie NaN/0/ujemna/tekst.
      dni = parseInt(opts.czas, 10);
      if (!Number.isInteger(dni) || dni <= 0 || String(opts.czas).trim() !== String(dni)) {
        await sendDM(interaction.member.user.id, "❌ Pole \"czas\" musi być liczbą całkowitą większą od 0 (np. 7).");
        return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Błędna wartość pola \"czas\"! Sprawdź wiadomość prywatną od bota.", flags: 64 } });
      }

      // FIX: anty-spam — blokujemy złożenie drugiego wniosku, jeśli poprzedni nie został rozpatrzony.
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

    // FIX: jeśli kanał docelowy w configu to wciąż placeholder ("ID", "ID_KANALU"), informujemy zamiast wysyłać w pustkę.
    if (!cfg.channel || cfg.channel === "ID" || cfg.channel === "ID_KANALU") {
      return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Kanał docelowy dla tej komendy nie jest skonfigurowany na tym serwerze. Skontaktuj się z właścicielem bota.", flags: 64 } });
    }

    const now = new Date();
    const data = `${now.toLocaleDateString("pl-PL", { timeZone: "Europe/Warsaw" })} ${now.toLocaleTimeString("pl-PL", { timeZone: "Europe/Warsaw", hour: '2-digit', minute: '2-digit' })}`;

    let description = "", content = opts.kto ? `<@${opts.kto}>` : "", components = [];
    let finalColor = cfg.color;

    if (name === 'urlop') {
      const dniLabel = dni === 1 ? "dzień" : "dni";

      await sendToGoogleSheet(guildConfig.GOOGLE_SHEET_WEBHOOK_URL, {
        kto_id: interaction.member.user.id,
        zakonczenie: opts.zakonczenie
      });

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

      if (isZdane) {
        await sendToGoogleSheet(guildConfig.GOOGLE_SHEET_WEBHOOK_URL, {
          kto_id: opts.kto_zdawal,
          szkolenie: opts.szkolenie
        });
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
      const roleId = guildConfig.PING_ROLE_ID;
      // FIX: jeśli PING_ROLE_ID jest placeholderem ("ID"), nie wysyłamy złamanego mentiona / przypadkowego @everyone.
      const pingMention = (roleId && roleId !== "ID") ? `<@&${roleId}>` : "";
      content = pingMention || "";

      description = `**ZEBRANIE DEPARTAMENTU** ${pingMention}\n` +
                    `**Data:** ${opts.data}\n` +
                    `**Godzina:** ${opts.godzina}\n` +
                    `**Miejsce Zebrania:** ${opts.miejsce}\n\n` +
                    `*Dziś o ${now.toLocaleTimeString("pl-PL", { timeZone: "Europe/Warsaw", hour: '2-digit', minute: '2-digit' })}*`;
    }
    else {
      description = `**Kto:** ${opts.imie_nazwisko}\n**Powód:** ${opts.powod}\n**Nowy stopień:** ${opts.stopien}\n**Nowy numer odznaki:** ${opts.odznaka}\n**Nadane przez:** <@${interaction.member.user.id}>\n\n**${data}**`;
    }

    // Wysłanie wiadomości na odpowiedni kanał
    const sentMessage = await sendChannelMessage(cfg.channel, { content, embeds: [{ title: cfg.title, color: finalColor, description }], components });

    // FIX: jeśli wysyłka się nie powiodła (np. zły ID kanału, brak uprawnień bota), informujemy o tym
    // zamiast bezwarunkowo zwracać "✅ Komenda wykonana!".
    if (!sentMessage) {
      return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `⚠️ Komenda ${name} przetworzona, ale wystąpił błąd przy wysyłaniu wiadomości na kanał docelowy. Sprawdź uprawnienia bota i konfigurację kanału.`, flags: 64 } });
    }

    // FIX: dopiero gdy wiadomość urlopu faktycznie wyszła, rejestrujemy jej ID jako "oczekujący" wniosek.
    if (name === 'urlop' && sentMessage.id) {
      pendingUrlopMessages.add(sentMessage.id);
      usersWithPendingUrlop.add(interaction.member.user.id);
    }

    // FIX: dla zawieszenia - dodaj rolę "Zawieszony" do użytkownika
    if (name === 'zawieszenie' && opts.kto) {
      const zawieszanieRoleId = guildConfig.ROLES?.ZAWIESZENIE_ROLE_ID;
      if (opts.kto) {
        await sendToGoogleSheet({
          kto_id: opts.kto,
          zawieszenie: true 
        });
      if (zawieszanieRoleId && zawieszanieRoleId !== "ID") {
        await addRoleToMember(interaction.guild_id, opts.kto, zawieszanieRoleId).catch(e => console.error('Błąd dodawania roli zawieszenia:', e));
      }
    }

    // --- LOGOWANIE UŻYCIA KOMENDY ---
    // Formatowanie opcji komendy do ładnego tekstu
    let opcjeTekst = "";
    if (Object.keys(opts).length > 0) {
      for (const [key, value] of Object.entries(opts)) {
        opcjeTekst += `**${key}:** ${value}\n`;
      }
    } else {
      opcjeTekst = "Brak argumentów.";
    }

    await sendWebhookLog(guildConfig.WEBHOOK_URL, {
      title: `🛠️ Użyto komendy: /${name}`,
      color: 3447003,
      description: `**Użytkownik:** <@${interaction.member.user.id}>\n**Kanał:** <#${interaction.channel_id}>\n\n**Przekazane dane:**\n${opcjeTekst}`,
      timestamp: new Date().toISOString()
    });

    return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `✅ Komenda ${name} wykonana!`, flags: 64 } });
  }

  // FIX: fallback dla typów interakcji, które nie trafiły w żaden z powyższych blocków
  // (np. AUTOCOMPLETE albo nieznany typ w przyszłości) — bez tego Express zawiesi request.
  return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Nieobsługiwany typ interakcji.", flags: 64 } });
});

app.listen(PORT, () => {
  console.log(`🤖 Bot działa na porcie ${PORT}`);
  // Log "bot zaktualizowany" wysyłany przy każdym starcie/restarcie procesu (np. po deployu na Railway).
  announceUpdateToAllServers();
});
