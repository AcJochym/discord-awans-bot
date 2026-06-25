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

    // Konfiguracja dla komend
    const isAwans = name === 'awans';
    const isDegradacja = name === 'degradacja';
    const isZawieszenie = name === 'zawieszenie';

    const title = isAwans ? 'AWANS' : (isDegradacja ? 'DEGRADACJA' : 'ZAWIESZENIE');
    const color = isAwans ? 3066993 : (isDegradacja ? 15158332 : 16753920); // Zielony, Czerwony, Pomarańczowy
    const targetChannelId = isAwans ? process.env.CHANNEL_ID_AWANS : (isDegradacja ? process.env.CHANNEL_ID_DEGRADACJA : process.env.CHANNEL_ID_ZAWIESZENIE);
    
    const ktoPing = opts.kto ? `<@${opts.kto}>` : '';
    const imieNazwisko = opts.imie_nazwisko || 'Nieznany';
    const powod = opts.powod || 'Brak';
    const nadawca = `<@${interaction.member.user.id}>`;
    const data = new Date().toLocaleString("pl-PL", { timeZone: "Europe/Warsaw", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(',', '');

    // Generowanie opisu w zależności od komendy jebać disa
    let description = `**Kto: ${imieNazwisko}**\n**Powód: ${powod}**\n`;
    
    if (isZawieszenie) {
      description += `**Czas zawieszenia: ${opts.czas}**\n**Zawieszono przez: ${nadawca}**\n\n**${data}**`;
    } else {
      description += `**Nowy stopień: ${opts.stopien}**\n**Nowy numer odznaki: ${opts.odznaka}**\n**Nadane przez: ${nadawca}**\n\n**${data}**`;
    }

    await fetch(`https://discord.com/api/v10/channels/${targetChannelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      body: JSON.stringify({ content: ktoPing, embeds: [{ title, color, description }] })
    });

    return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `✅ ${title} wysłana!`, flags: 64 } });
  }
});

app.listen(PORT);
