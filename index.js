import express from 'express';
import { verifyKeyMiddleware, InteractionType, InteractionResponseType } from 'discord-interactions';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

app.post('/interactions', verifyKeyMiddleware(process.env.DISCORD_PUBLIC_KEY), async (req, res) => {
  const interaction = req.body;
  if (interaction.type === InteractionType.PING) return res.json({ type: InteractionResponseType.PONG });

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const { name, options } = interaction.data;
    const opts = {};
    if (options) options.forEach(o => opts[o.name] = o.value);

    const ktoPing = `<@${opts.kto}>`;
    const nadawca = `<@${interaction.member.user.id}>`;
    const data = new Date().toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" }).substring(0, 16);

    // --- LOGIKA DLA AWANSU I DEGRADACJI ---
    const isAwans = name === 'awans';
    const title = isAwans ? 'AWANS' : 'DEGRADACJA';
    const color = isAwans ? 3066993 : 15158332;

    const description = 
      `**Kto:** **${opts.imie_nazwisko}**\n` +
      `**Powód:** **${opts.powod}**\n` +
      `**Nowy stopień:** **${opts.stopien}**\n` +
      `**Nowy numer odznaki:** **${opts.odznaka}**\n` +
      `**Nadane przez:** **${nadawca}**\n\n` +
      `**${data}**`;

    const payload = {
      content: ktoPing,
      embeds: [{ title, color, description }]
    };

    await fetch(`https://discord.com/api/v10/channels/${process.env.DISCORD_CHANNEL_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      body: JSON.stringify(payload)
    });

    return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: '✅ Operacja zakończona!', flags: 64 } });
  }
});

app.listen(3000);
