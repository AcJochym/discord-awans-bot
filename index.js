import express from 'express';
import { verifyKeyMiddleware, InteractionType, InteractionResponseType } from 'discord-interactions';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

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
      const allowedRoleId = process.env.REQUIRED_ROLE_ID;
      const memberRoles = interaction.member.roles || [];
      if (allowedRoleId && !memberRoles.includes(allowedRoleId)) {
        return res.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Brak uprawnień.", flags: 64 } });
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

    const configs = {
      awans: { title: 'AWANS', color: 3066993, channel: process.env.CHANNEL_ID_AWANS },
      degradacja: { title: 'DEGRADACJA', color: 15158332, channel: process.env.CHANNEL_ID_DEGRADACJA },
      zawieszenie: { title: 'ZAWIESZENIE', color: 16753920, channel: process.env.CHANNEL_ID_ZAWIESZENIE },
      zagrozenie: { title: 'WPROWADZONO POZIOM ZAGROŻENIA', color: 16776960, channel: process.env.CHANNEL_ID_ZAGROZENIE },
      odwolaj_zagrozenie: { title: 'ODWOŁANO STAN ZAGROŻENIA', color: 5763719, channel: process.env.CHANNEL_ID_ZAGROZENIE },
      szkolenie: { title: 'SZKOLENIE', color: 3447003, channel: process.env.CHANNEL_ID_SZKOLENIE },
      urlop: { title: 'URLOP OCZEKUJE NA AKCEPTACJE', color: 16753920, channel: process.env.CHANNEL_ID_URLOP },
      zwolnij: { title: 'ZWOLNIENIE', color: 15158332, channel: process.env.CHANNEL_ID_ZWOLNIENIA },
      nagana: { title: 'NAGANA', color: 16711680, channel: process.env.CHANNEL_ID_NAGANA },
      kara_finansowa: { title: 'KARA FINANSOWA', color: 16766720, channel: process.env.CHANNEL_ID_KARY }
    };

    const cfg = configs[name];
    if (!cfg) return res.status(400).json({ error: 'Unknown command' });

    const now = new Date();
    const data = `${now.toLocaleDateString("pl-PL", { timeZone: "Europe/Warsaw" })} ${now.toLocaleTimeString("pl-PL", { timeZone: "Europe/Warsaw", hour: '2-digit', minute: '2-digit' })}`;
    
    let description = "", content = opts.kto ? `<@${opts.kto}>` : "", components = [];
    let finalColor = cfg.color;

    if (name === 'urlop') {
      description = `**Rozpoczęcie Urlopu:** ${opts.rozpoczecie}\n**Zakończenie Urlopu:** ${opts.zakonczenie}\n**Czas Urlopu:** ${opts.czas} dni\n**Powód:** ${opts.powod}\n\n**Wniosek złożony przez:** <@${interaction.member.user.id}>\n**Data:** ${data}`;
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
      content = "@everyone"; 
      if (opts.poziom) {
        const colorMap = { 'Zielony': 5763719, 'Pomarańczowy': 16753920, 'Czerwony': 15158332, 'Czarny': 2303786 };
        finalColor = colorMap[opts.poziom] || cfg.color;
      }
      cfg.title = `WPROWADZONO POZIOM ZAGROŻENIA "${opts.poziom}"`;
      description = `**Osoba wprowadzająca:** ${opts.wprowadzajacy}\n**Stopień osoby wprowadzającej:** ${opts.stopien_wprowadzajacego}\n**Powód:** ${opts.powod}\n**Data oraz godzina:** ${data}`;
    } 
    else if (name === 'odwolaj_zagrozenie') {
      content = "@everyone";
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
    else {
      description = `**Kto: ${opts.imie_nazwisko}**\n**Powód: ${opts.powod}**\n**Nowy stopień: ${opts.stopien}**\n**Nowy numer odznaki: ${opts.odznaka}**\n**Nadane przez: <@${interaction.member.user.id}>**\n\n**${data}**`;
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
