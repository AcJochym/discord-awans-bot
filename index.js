import express from 'express';
import { verifyKeyMiddleware, InteractionType, InteractionResponseType } from 'discord-interactions';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Discord Interactions endpoint with signature verification
app.post(
  '/interactions',
  verifyKeyMiddleware(process.env.DISCORD_PUBLIC_KEY),
  async (req, res) => {
    const interaction = req.body;

    // Handle PING interaction (Discord URL verification)
    if (interaction.type === InteractionType.PING) {
      return res.json({ type: InteractionResponseType.PONG });
    }

    // Handle APPLICATION_COMMAND interaction
    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      const { name, options } = interaction.data;

      // Handle /awans command
      if (name === 'awans') {
        try {
          // Extract options from command
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

          // Create embed object
          const embed = {
            title: 'AWANS',
            color: 3066993, // Teal/cyan color
            fields: [
              {
                name: '👤 Kto',
                value: kto,
                inline: true,
              },
              {
                name: '📝 Powód',
                value: powod,
                inline: true,
              },
              {
                name: '⭐ Stopień',
                value: stopien,
                inline: true,
              },
              {
                name: '🎖️ Odznaka',
                value: odznaka,
                inline: true,
              },
              {
                name: '👑 Nadane przez',
                value: `<@${interaction.member.user.id}>`,
                inline: false,
              },
            ],
            timestamp: new Date().toISOString(),
            footer: {
              text: 'System Awansów',
            },
          };

          // Send embed to channel
          const channelId = process.env.DISCORD_CHANNEL_ID;
          const botToken = process.env.DISCORD_BOT_TOKEN;

          const messagePayload = {
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

          // Respond to user with hidden message (flags: 64 = ephemeral)
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: '✅ Awans został pomyślnie wysłany!',
              flags: 64, // Ephemeral/hidden message
            },
          });
        } catch (error) {
          console.error('Error handling awans command:', error);

          // Send error response to user
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

    // Default response for unknown interactions
    res.status(400).json({ error: 'Unknown interaction type' });
  }
);

// Start server
app.listen(PORT, () => {
  console.log(`🤖 Discord bot server running on port ${PORT}`);
  console.log(`📡 Interactions endpoint: POST /interactions`);
});
