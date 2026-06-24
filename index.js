import express from 'express';
import { verifyKeyMiddleware, InteractionType, InteractionResponseType } from 'discord-interactions';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post(
  '/interactions',
  verifyKeyMiddleware(process.env.DISCORD_PUBLIC_KEY),
  async (req, res) => {
    const interaction = req.body;

    if (interaction.type === InteractionType.PING) {
      return res.json({ type: InteractionResponseType.PONG });
    }

    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      const { name, options } = interaction.data;

      if (name === 'awans') {
        try {
          const optionsMap = {};
          if (options) {
            options.forEach((opt) => {
              optionsMap[opt.name] = opt.value;
            });
          }

          const kto = optionsMap.kto || 'Nieznany';
          const powod = optionsMap.powod || 'Brak powodu';
          const stopien = optionsMap.stopien || 'Brak stopnia';
          const odznaka = optionsMap.odznaka || 'Brak odznaki';

          // Pobranie aktualnego czasu w polskiej strefie (format DD.MM.YYYY HH:MM)
          const formattedDate = new Date().toLocaleString("pl-PL", { 
            timeZone: "Europe/Warsaw",
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit"
          }).replace(',', '');

          // Dokładny opis dopasowany do Twojego wzoru z obrazka
          const embedDescription = 
            `**Kto:** ${kto}\n` +
            `**Powód:** **${powod}**\n` +
            `**Nowy stopień:** ${stopien}\n` +
            `**Nowy numer odznaki:** ${odznaka}\n` +
            `**Nadane przez:** <@${interaction.member.user.id}>\n\n` +
            `${formattedDate}`;

          const embed = {
            title: 'AWANS',
            color: 3066993, // Żywy zielony kolor paska
            description: embedDescription
          };

          const channelId = process.env.DISCORD_CHANNEL_ID;
          const botToken = process.env.DISCORD_BOT_TOKEN;

          // Wysyłamy tekstowy PING na początku wiadomości (nad embedem), a pod nim embed
          const messagePayload = {
            content: `${kto}`, 
            embeds: [embed],
          };

          const channelResponse = await fetch(
            `https://discord.com/api/v10/channels/${channelId}/messages`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bot ${botToken}`,
              },
              body: JSON.stringify(messagePayload),
            }
          );

          if (!channelResponse.ok) {
            const errorData = await channelResponse.json();
            console.error('Discord API error:', errorData);
            throw new Error(`Failed to send message: ${channelResponse.status}`);
          }

          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: '✅ Awans został pomyślnie wysłany zgodnie ze wzorem!',
              flags: 64, 
            },
          });
        } catch (error) {
          console.error('Error handling awans command:', error);
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: '❌ Błąd podczas wysyłania awansu. Spróbuj ponownie.',
              flags: 64,
            },
          });
        }
      }
    }
    res.status(400).json({ error: 'Unknown interaction type' });
  }
);

app.listen(PORT, () => {
  console.log(`🤖 Discord bot server running on port ${PORT}`);
});
