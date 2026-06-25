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
    const { name, options } = interaction.data;
    const opts = {};
    if (options) options.forEach((opt) => opts[opt.name] = opt.value);

    // Konfiguracja nazw, kolorów i kanałów
    const configs = {
      awans: { title: 'AWANS', color: 3066993, channel: process.env.CHANNEL_ID_AWANS },
      degradacja: { title: 'DEGRADACJA', color: 15158332, channel: process.env.CHANNEL_ID_DEGRADACJA },
      zawieszenie: { title: 'ZAWIESZENIE', color: 16753920, channel: process.env.CHANNEL_ID_ZAWIESZENIE },
      zagrozenie: { title: 'ZAGROŻENIE', color: 16776960, channel: process.env.CHANNEL_ID_ZAGROZENIE },
      odwolaj_zagrozenie: { title: 'ODWOŁANIE ZAGROŻENIA', color: 3447003, channel: process.env.CHANNEL_ID_ZAGROZENIE }
    };

    const cfg = configs[name];
    if (!cfg) return res.status(400).json({ error: 'Unknown command' });

    // Obsługa kolorów dla zagrożenia
    let finalColor = cfg.color;
    if (name === 'zagrozenie' && opts.stopien) {
      const colorMap = { 'Zielony': 5763719, 'Pomarańczowy': 16753920, 'Czerwony': 15158332, 'Czarny': 2303786 };
      finalColor = colorMap[opts.stopien] || finalColor;
    }

    const ktoPing = opts.kto ? `<@${opts.kto}>` : '';
    const nadawca = `<@${interaction.member.user.id}>`;
    const data = new Date().toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" }).substring(0, 16);

    // Budowanie opisu zgodnie z wzorem
    let description = `**Kto: ${opts.imie_nazwisko || 'Brak'}**\n**Powód: ${opts.powod || 'Brak'}**\n`;
    
    if (name === 'zawieszenie') {
      description += `**Czas zawieszenia: ${opts.czas}**\n**Zawieszono przez: ${nadawca}**`;
    } else if (name === 'zagrozenie') {
      description += `**Stopień zagrożenia: ${opts.stopien}**\n**Nadane przez: ${nadawca}**`;
    } else if (name === 'odwolaj_zagrozenie') {
      description += `**Nadane przez: ${nadawca}**`;
    } else {
      description += `**Nowy stopień: ${opts.stopien}**\n**Nowy numer odznaki: ${opts.odznaka}**\n**Nadane przez: ${nadawca}**`;
    }
    description += `\n\n**${data}**`;

    // Wysyłka
    await fetch(`https://discord.com/api/v10/channels/${cfg.channel}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      body: JSON.stringify({ content: ktoPing, embeds: [{ title: cfg.title, color: finalColor, description }] })
    });

    return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `✅ ${cfg.title} wysłana!`, flags: 64 } });
  }
});

app.listen(PORT, () => console.log(`🤖 Bot działa!`));
