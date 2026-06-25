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

    // 1. Logika nazw i kolorów
    const title = name.toUpperCase();
    const color = name === 'awans' ? 3066993 : (name === 'degradacja' ? 15158332 : 16753920);
    
    // 2. Wybór kanału (Upewnij się, że masz te zmienne w Railway!)
    const channelMap = {
      awans: process.env.CHANNEL_ID_AWANS,
      degradacja: process.env.CHANNEL_ID_DEGRADACJA,
      zawieszenie: process.env.CHANNEL_ID_ZAWIESZENIE
    };
    const targetChannelId = channelMap[name];

    // 3. Budowanie opisu
    const ktoPing = opts.kto ? `<@${opts.kto}>` : '';
    const nadawca = `<@${interaction.member.user.id}>`;
    const data = new Date().toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" }).substring(0, 16);
    
    let description = `**Kto: ${opts.imie_nazwisko || 'Brak'}**\n**Powód: ${opts.powod || 'Brak'}**\n`;
    
    if (name === 'zawieszenie') {
      description += `**Czas zawieszenia: ${opts.czas || 'Brak'}**\n**Zawieszono przez: ${nadawca}**\n\n**${data}**`;
    } else {
      description += `**Nowy stopień: ${opts.stopien || 'Brak'}**\n**Nowy numer odznaki: ${opts.odznaka || 'Brak'}**\n**Nadane przez: ${nadawca}**\n\n**${data}**`;
    }

    // 4. Wysłanie wiadomości
    await fetch(`https://discord.com/api/v10/channels/${targetChannelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      body: JSON.stringify({ content: ktoPing, embeds: [{ title, color, description }] })
    });

    return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `✅ ${title} wysłana!`, flags: 64 } });
  }
});

app.listen(PORT);
