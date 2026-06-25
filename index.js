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

    // Wybór ustawień w zależności od komendy
    const isAwans = name === 'awans';
    const title = isAwans ? 'AWANS' : 'DEGRADACJA';
    const color = isAwans ? 3066993 : 15158332;
    
    // Pobranie odpowiedniego kanału ze zmiennych środowiskowych
    const targetChannelId = isAwans ? process.env.CHANNEL_ID_AWANS : process.env.CHANNEL_ID_DEGRADACJA;
    
    const ktoPing = opts.kto ? `<@${opts.kto}>` : '';
    const imieNazwisko = opts.imie_nazwisko || 'Nieznany';
    const powod = opts.powod || 'Brak powodu';
    const stopien = opts.stopien || 'Brak stopnia';
    const odznaka = opts.odznaka || 'Brak odznaki';
    const nadawca = `<@${interaction.member.user.id}>`;
    
    const data = new Date().toLocaleString("pl-PL", { 
      timeZone: "Europe/Warsaw",
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
    }).replace(',', '');

    const embedDescription = 
      `**Kto: ${imieNazwisko}**\n` +
      `**Powód: ${powod}**\n` +
      `**Nowy stopień: ${stopien}**\n` +
      `**Nowy numer odznaki: ${odznaka}**\n` +
      `**Nadane przez: ${nadawca}**\n\n` +
      `**${data}**`;

    const response = await fetch(`https://discord.com/api/v10/channels/${targetChannelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      body: JSON.stringify({ content: ktoPing, embeds: [{ title, color, description: embedDescription }] })
    });

    if (response.ok) {
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `✅ ${title} została pomyślnie wysłana!`, flags: 64 }
      });
    }
  }
  res.status(400).json({ error: 'Unknown interaction' });
});

app.listen(PORT, () => console.log(`🤖 Bot działa na porcie ${PORT}`));
