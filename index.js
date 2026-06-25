import express from 'express';
import { verifyKeyMiddleware, InteractionType, InteractionResponseType } from 'discord-interactions';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

app.post('/interactions', verifyKeyMiddleware(process.env.DISCORD_PUBLIC_KEY), async (req, res) => {
  const interaction = req.body;
  if (interaction.type === InteractionType.PING) return res.json({ type: InteractionResponseType.PONG });

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    // --- ZABEZPIECZENIE ROLI ---
    const allowedRoleId = process.env.REQUIRED_ROLE_ID;
    const memberRoles = interaction.member.roles || [];
    
    if (allowedRoleId && !memberRoles.includes(allowedRoleId)) {
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "❌ Nie masz uprawnień do używania tej komendy.", flags: 64 }
      });
    }

    const { name, options } = interaction.data;
    const opts = {};
    if (options) options.forEach((opt) => opts[opt.name] = opt.value);

    // Konfiguracja bazowa
    const configs = {
      awans: { title: 'AWANS', color: 3066993, channel: process.env.CHANNEL_ID_AWANS },
      degradacja: { title: 'DEGRADACJA', color: 15158332, channel: process.env.CHANNEL_ID_DEGRADACJA },
      zawieszenie: { title: 'ZAWIESZENIE', color: 16753920, channel: process.env.CHANNEL_ID_ZAWIESZENIE },
      zagrozenie: { title: 'WPROWADZONO POZIOM ZAGROŻENIA', color: 16776960, channel: process.env.CHANNEL_ID_ZAGROZENIE },
      odwolaj_zagrozenie: { title: 'ODWOŁANO STAN ZAGROŻENIA', color: 5763719, channel: process.env.CHANNEL_ID_ZAGROZENIE },
      szkolenie: { title: 'SZKOLENIE', color: 3447003, channel: process.env.CHANNEL_ID_SZKOLENIE }
    };

    const cfg = configs[name];
    if (!cfg) return res.status(400).json({ error: 'Unknown command' });

    // Logika kolorów
    let finalColor = cfg.color;
    if (name === 'zagrozenie' && opts.poziom) {
      const colorMap = { 'Zielony': 5763719, 'Pomarańczowy': 16753920, 'Czerwony': 15158332, 'Czarny': 2303786 };
      finalColor = colorMap[opts.poziom] || cfg.color;
    }
    if (name === 'odwolaj_zagrozenie') finalColor = 5763719;

    // Poprawiona data i godzina
    const now = new Date();
    const datePart = now.toLocaleDateString("pl-PL", { timeZone: "Europe/Warsaw" });
    const timePart = now.toLocaleTimeString("pl-PL", { timeZone: "Europe/Warsaw", hour: '2-digit', minute: '2-digit' });
    const data = `${datePart} ${timePart}`;

    let description = "";
    let content = opts.kto ? `<@${opts.kto}>` : "";

    // Budowanie treści
    if (name === 'szkolenie') {
      const isZdane = opts.wynik === 'zdane';
      cfg.title = isZdane ? "Szkolenie Zdane" : "Szkolenie Niezdane";
      finalColor = isZdane ? 5763719 : 15158332;
      content = `<@${opts.kto_zdawal}>`;
      description = `**Kto:** ${opts.imie_nazwisko}\n**Szkolenie:** ${opts.szkolenie}\n**Szkoleniowiec:** <@${opts.szkoleniowiec}>\n\n**${data}**`;
    }
    else if (name === 'zagrozenie') {
      // content = "@everyone";
      cfg.title = `WPROWADZONO POZIOM ZAGROŻENIA "${opts.poziom}"`;
      description = `**Osoba wprowadzająca:** ${opts.wprowadzajacy}\n**Stopień osoby wprowadzającej:** ${opts.stopien_wprowadzajacego}\n**Powód:** ${opts.powod}\n**Data oraz godzina:** ${data}`;
    } 
    else if (name === 'odwolaj_zagrozenie') {
      // content = "@everyone";
      description = `**Osoba odwołująca:** ${opts.osoba_odwolujaca}\n**Stopień osoby odwołującej:** ${opts.stopien_odwolujacego}\n**Powód:** ${opts.powod}\n**Data oraz godzina:** ${data}`;
    } 
    else if (name === 'zawieszenie') {
      description = `**Kto: ${opts.imie_nazwisko}**\n**Powód: ${opts.powod}**\n**Czas zawieszenia: ${opts.czas}**\n**Zawieszono przez: <@${interaction.member.user.id}>**\n\n**${data}**`;
    } 
    else {
      description = `**Kto: ${opts.imie_nazwisko}**\n**Powód: ${opts.powod}**\n**Nowy stopień: ${opts.stopien}**\n**Nowy numer odznaki: ${opts.odznaka}**\n**Nadane przez: <@${interaction.member.user.id}>**\n\n**${data}**`;
    }

    // Wysyłka do Discorda
    await fetch(`https://discord.com/api/v10/channels/${cfg.channel}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      body: JSON.stringify({ content: content, embeds: [{ title: cfg.title, color: finalColor, description }] })
    });

    return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `✅ Komenda ${name} wykonana!`, flags: 64 } });
  }
});

app.listen(PORT, () => console.log(`🤖 Bot działa na porcie ${PORT}`));
