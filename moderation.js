import { randomUUID } from 'node:crypto';
import { PermissionFlagsBits } from 'discord.js';
import { UserError, discordRequest, isId, publicError } from './shared.js';
import { staffRoleIds } from './staff.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 28 * DAY_MS;
const MAX_LOOKBACK_MS = 3650 * DAY_MS;
const MAX_MESSAGE_SCAN = 10_000;
const RENEW_BEFORE_MS = 2 * DAY_MS;
const RENEW_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BOT_MUTE_REASON = 'Permanentne mute — automatyczne odnowienie timeoutu.';

function wholeNumber(value, name) {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new UserError(`Pole „${name}” musi być nieujemną liczbą całkowitą.`);
  return parsed;
}

export function parseMuteRequest(body, now = Date.now()) {
  if (body.permanent === true) return { permanent: true, until: new Date(now + MAX_TIMEOUT_MS) };

  const dateValue = typeof body.until === 'string' ? body.until.trim() : '';
  const days = wholeNumber(body.days, 'dni');
  const hours = wholeNumber(body.hours, 'godzin');
  const minutes = wholeNumber(body.minutes, 'minut');

  if (dateValue) {
    if (days || hours || minutes) throw new UserError('Podaj datę końca mute albo czas trwania, nie oba naraz.');
    const until = new Date(dateValue);
    if (!Number.isFinite(until.getTime()) || until.getTime() <= now) throw new UserError('Data końca mute musi przypadać w przyszłości.');
    if (until.getTime() - now > MAX_TIMEOUT_MS) throw new UserError('Zwykły timeout Discorda może trwać maksymalnie 28 dni.');
    return { permanent: false, until };
  }

  const durationMs = days * DAY_MS + hours * 60 * 60 * 1000 + minutes * 60 * 1000;
  if (durationMs < 60_000) throw new UserError('Czas mute musi wynosić co najmniej minutę.');
  if (durationMs > MAX_TIMEOUT_MS) throw new UserError('Zwykły timeout Discorda może trwać maksymalnie 28 dni.');
  return { permanent: false, until: new Date(now + durationMs) };
}

export function parseDeleteLookback(body) {
  const days = wholeNumber(body.days, 'dni');
  const hours = wholeNumber(body.hours, 'godzin');
  const minutes = wholeNumber(body.minutes, 'minut');
  const durationMs = days * DAY_MS + hours * 60 * 60 * 1000 + minutes * 60 * 1000;
  if (durationMs < 60_000) throw new UserError('Zakres usuwania musi wynosić co najmniej minutę.');
  if (durationMs > MAX_LOOKBACK_MS) throw new UserError('Zakres usuwania nie może przekraczać 10 lat.');
  return durationMs;
}

function requestError(res, error, fallback, extra = {}) {
  console.error('[moderation] Błąd operacji:', error);
  const status = Number.isInteger(error?.status) ? error.status : 500;
  return res.status(status).json({ ok: false, error: publicError(error, fallback), ...extra });
}

function validId(value, label) {
  const id = String(value || '');
  if (!isId(id)) throw new UserError(`Nieprawidłowe ID: ${label}.`);
  return id;
}

function actionReason(value) {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (!reason) throw new UserError('Powód jest wymagany.');
  if (reason.length > 400) throw new UserError('Powód może mieć maksymalnie 400 znaków.');
  return reason;
}

function muteLabel(until, permanent) {
  return permanent ? 'bezterminowe (28-dniowy timeout odnawiany przed wygaśnięciem)' : `do ${until.toLocaleString('pl-PL')}`;
}

function dmContent({ action, guildName, reason, until, permanent, deletedCount, channelName }) {
  const header = {
    mute: 'Otrzymałeś mute',
    unmute: 'Twoje mute zostało zdjęte',
    deleteMessages: 'Usunięto Twoje wiadomości',
    ban: 'Otrzymałeś permanentnego bana',
    kick: 'Zostałeś wyrzucony z serwera'
  }[action];
  const details = [
    `Serwer: ${guildName}`,
    `Powód: ${reason}`,
    action === 'mute' ? `Czas: ${muteLabel(until, permanent)}` : '',
    action === 'deleteMessages' ? `Kanał: #${channelName}; liczba usuniętych wiadomości: ${deletedCount}` : ''
  ].filter(Boolean);
  return `**${header}**\n${details.join('\n')}`;
}

async function sendModerationDM(user, content, dmChannel = null) {
  try {
    const channel = dmChannel || await user.createDM();
    await channel.send({ content, allowedMentions: { parse: [] } });
    return true;
  } catch (error) {
    console.warn(`[moderation] Nie udało się wysłać DM do ${user.id}:`, error.message);
    return false;
  }
}

async function actorCanModerate(guildId, userId, config, botOwnerId) {
  if (botOwnerId && userId === botOwnerId) return true;
  let member;
  try {
    member = await discordRequest('GET', `/guilds/${guildId}/members/${userId}`);
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
  const roles = staffRoleIds(config, guildId);
  const allowed = new Set([...(roles.high_command || []), ...(roles.command || [])]);
  return (member.roles || []).some((id) => allowed.has(id));
}

async function ensureGuildAccess(guildId, req, deps) {
  const config = deps.serverConfigs[guildId];
  if (!config) throw new UserError('Nie znaleziono skonfigurowanego serwera.', 404);
  if (!(await actorCanModerate(guildId, req.dashUser.id, config, deps.botOwnerId))) {
    throw new UserError('Brak uprawnień. Wymagana ranga Command, High Command lub właściciel bota.', 403);
  }
  return config;
}

async function getGuild(client, guildId) {
  try {
    return await client.guilds.fetch(guildId);
  } catch (error) {
    if (error.status === 404 || error.code === 10004) throw new UserError('Bot nie jest na tym serwerze.', 404);
    throw error;
  }
}

async function getMember(guild, userId) {
  try {
    return await guild.members.fetch({ user: userId, force: true });
  } catch (error) {
    if (error.status === 404 || error.code === 10007) throw new UserError('Użytkownik nie należy już do tego serwera.', 404);
    throw error;
  }
}

async function getLogChannel(client, guild, config) {
  const channelId = String(config.MODERATION?.LOG_CHANNEL_ID || '');
  if (!isId(channelId)) throw new UserError('Ustaw MODERATION.LOG_CHANNEL_ID w konfiguracji serwera.', 503);
  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.guildId !== guild.id || ![0, 5].includes(channel.type) || !channel.messages) {
    throw new UserError('MODERATION.LOG_CHANNEL_ID nie wskazuje kanału tekstowego na tym serwerze.', 503);
  }
  const botMember = guild.members.me || await guild.members.fetchMe();
  const permissions = channel.permissionsFor(botMember);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)
    || !permissions.has(PermissionFlagsBits.SendMessages)
    || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
    throw new UserError('Bot musi mieć na kanale logów uprawnienia wyświetlania, wysyłania wiadomości i osadzania linków (Embed Links).', 503);
  }
  return channel;
}

function getAvatarUrl(guildId, member) {
  const user = member.user;
  if (member.avatar) return `https://cdn.discordapp.com/guilds/${guildId}/users/${user.id}/avatars/${member.avatar}.png?size=64`;
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`;
  const discriminator = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${discriminator}.png`;
}

export function buildModerationEmbed(data, member) {
  const actionStyles = {
    mute: { title: '🔇 Użytkownik wyciszony', color: 0xf1c40f },
    unmute: { title: '🔊 Mute zdjęty', color: 0x2ecc71 },
    deleteMessages: { title: '🧹 Wiadomości usunięte', color: 0xe67e22 },
    ban: { title: '⛔ Permanentny ban', color: 0xe74c3c },
    kick: { title: '👢 Użytkownik wyrzucony', color: 0xe67e22 }
  };
  const style = actionStyles[data.action];
  const fields = [
    { name: 'Użytkownik', value: `<@${data.targetId}>\n\`${data.targetId}\``, inline: true },
    { name: 'Moderator', value: `<@${data.actorId}>\n\`${data.actorId}\``, inline: true },
    { name: 'Powód', value: data.reason }
  ];

  if (data.action === 'mute') {
    const muteUntil = Math.floor(new Date(data.until).getTime() / 1000);
    fields.push({
      name: 'Czas wyciszenia',
      value: data.permanent
        ? 'Bezterminowo — timeout odnawiany automatycznie'
        : `<t:${muteUntil}:F>\n<t:${muteUntil}:R>`,
      inline: true
    });
  }
  if (data.action === 'deleteMessages') {
    fields.push(
      { name: 'Kanał', value: `<#${data.channelName.id}>`, inline: true },
      { name: 'Usunięte wiadomości', value: String(data.deletedCount), inline: true }
    );
  }
  if (data.warning) fields.push({ name: 'Ostrzeżenie', value: data.warning });

  return {
    author: { name: `LAW ENFORCEMENT • ${data.guildName}`.slice(0, 256) },
    title: style.title,
    description: `Akcja moderacyjna wobec <@${data.targetId}> została wykonana.`,
    color: style.color,
    fields,
    thumbnail: { url: getAvatarUrl(data.guildId, member) },
    footer: { text: 'Moderacja serwera' },
    timestamp: new Date().toISOString()
  };
}

function moderationActionName(action) {
  return {
    mute: 'Mute',
    unmute: 'Unmute',
    deleteMessages: 'Usunięcie wiadomości',
    ban: 'Perm Ban',
    kick: 'Kick'
  }[action] || 'Akcja moderacyjna';
}

export function buildModerationPanelNotification(context, { warning = '', error = '' } = {}) {
  const failed = Boolean(error);
  const status = failed ? 'error' : warning ? 'warning' : 'success';
  const actionName = moderationActionName(context.action);
  const actionDetails = context.action === 'deleteMessages' && Number.isInteger(context.deletedCount)
    ? ` Usunięto wiadomości: ${context.deletedCount}.`
    : '';
  const outcome = failed
    ? `❌ ${actionName} dla ${context.targetName} na serwerze ${context.guildName} nie powiodło się: ${error}`
    : `${warning ? '⚠️' : '✅'} ${actionName} dla ${context.targetName} na serwerze ${context.guildName} wykonano${warning ? ` z ostrzeżeniem: ${warning}` : ' poprawnie'} przez ${context.actorName}.${actionDetails}`;

  return {
    id: randomUUID(),
    name: failed ? 'Akcja moderacyjna nie powiodła się' : 'Akcja moderacyjna',
    text: outcome,
    status,
    avatarUrl: context.avatarUrl,
    actorId: context.actorId,
    targetId: context.targetId
  };
}

async function broadcastModerationNotification(deps, notification) {
  try {
    await deps.notifyPanel('moderation-action', notification);
  } catch (error) {
    console.error('[moderation] Nie udało się powiadomić otwartych paneli o akcji:', error);
  }
}

async function deleteMessagesInChannel(channel, userId, durationMs) {
  const cutoff = Date.now() - durationMs;
  const fourteenDaysAgo = Date.now() - 14 * DAY_MS;
  let before;
  let scanned = 0;
  let deleted = 0;
  let failed = 0;
  let reachedScanLimit = false;

  while (scanned < MAX_MESSAGE_SCAN) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}), cache: false });
    if (!page.size) break;
    const messages = [...page.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    scanned += messages.length;
    before = messages[messages.length - 1].id;

    const expired = messages.some((message) => message.createdTimestamp < cutoff);
    const candidates = messages.filter((message) => message.author.id === userId && message.createdTimestamp >= cutoff);
    const recent = candidates.filter((message) => message.createdTimestamp >= fourteenDaysAgo && message.bulkDeletable);
    const individual = candidates.filter((message) => !recent.includes(message));

    if (recent.length > 1) {
      try {
        deleted += (await channel.bulkDelete(recent, true)).size;
      } catch (error) {
        console.error('[moderation] Nie udało się zbiorczo usunąć wiadomości:', error);
        for (const message of recent) {
          try { await message.delete(); deleted += 1; } catch { failed += 1; }
        }
      }
    } else {
      individual.push(...recent);
    }

    for (const message of individual) {
      try { await message.delete(); deleted += 1; } catch { failed += 1; }
    }

    if (expired || messages.length < 100) break;
    if (scanned >= MAX_MESSAGE_SCAN) reachedScanLimit = true;
  }

  return { deleted, failed, scanned, reachedScanLimit };
}

export function registerModerationRoutes(app, deps) {
  const { express, requireDashboardAuth, requireDashboardTab } = deps;
  app.use('/api/moderation', requireDashboardAuth, requireDashboardTab('moderation'));

  app.get('/api/moderation/guilds', async (req, res) => {
    try {
      const guilds = [];
      for (const [guildId, config] of Object.entries(deps.serverConfigs)) {
        if (!(await actorCanModerate(guildId, req.dashUser.id, config, deps.botOwnerId))) continue;
        const info = await deps.getGuildInfo(guildId, false);
        guilds.push({ id: guildId, name: info?.name || guildId });
      }
      res.json({ ok: true, guilds });
    } catch (error) {
      requestError(res, error, 'Nie udało się pobrać serwerów do moderacji.');
    }
  });

  app.get('/api/moderation/:guildId/members', async (req, res) => {
    try {
      const guildId = validId(req.params.guildId, 'serwer');
      await ensureGuildAccess(guildId, req, deps);
      const after = req.query.after === undefined ? '0' : String(req.query.after);
      if (after !== '0' && !isId(after)) throw new UserError('Nieprawidłowy kursor listy użytkowników.');
      const members = await discordRequest('GET', `/guilds/${guildId}/members?limit=1000&after=${after}`);
      const users = members.filter((member) => member.user).map((member) => ({
        id: member.user.id,
        name: member.nick || member.user.global_name || member.user.username,
        username: member.user.username,
        bot: Boolean(member.user.bot),
        mutedUntil: member.communication_disabled_until || null,
        muted: Boolean(member.communication_disabled_until && new Date(member.communication_disabled_until).getTime() > Date.now()),
        avatarUrl: getAvatarUrl(guildId, member)
      }));
      res.json({
        ok: true,
        users,
        nextAfter: members.length === 1000 ? members[members.length - 1].user.id : null
      });
    } catch (error) {
      requestError(res, error, 'Nie udało się pobrać użytkowników serwera.');
    }
  });

  app.get('/api/moderation/:guildId/channels', async (req, res) => {
    try {
      const guildId = validId(req.params.guildId, 'serwer');
      const config = await ensureGuildAccess(guildId, req, deps);
      const guild = await getGuild(deps.discordClient, guildId);
      const botMember = guild.members.me || await guild.members.fetchMe();
      const channels = await guild.channels.fetch();
      const items = [...channels.values()]
        .filter((channel) => channel && [0, 5].includes(channel.type)
          && channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ViewChannel)
          && channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ReadMessageHistory)
          && channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageMessages))
        .map((channel) => ({ id: channel.id, name: channel.name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'pl', { sensitivity: 'base' }));
      res.json({
        ok: true,
        channels: items,
        logChannelConfigured: isId(String(config.MODERATION?.LOG_CHANNEL_ID || ''))
      });
    } catch (error) {
      requestError(res, error, 'Nie udało się pobrać kanałów serwera.');
    }
  });

  app.post('/api/moderation/:guildId/actions', express.json({ limit: '10kb' }), async (req, res) => {
    let notificationContext = null;
    try {
      const guildId = validId(req.params.guildId, 'serwer');
      const config = await ensureGuildAccess(guildId, req, deps);
      const targetId = validId(req.body?.userId, 'użytkownika');
      if (targetId === req.dashUser.id) throw new UserError('Nie możesz wykonać tej akcji na swoim koncie.');
      const action = String(req.body?.action || '');
      if (!['mute', 'unmute', 'deleteMessages', 'ban', 'kick'].includes(action)) throw new UserError('Nieznana akcja moderacyjna.');
      const reason = actionReason(req.body?.reason);
      const guild = await getGuild(deps.discordClient, guildId);
      if (targetId === guild.ownerId || targetId === deps.discordClient.user?.id) {
        throw new UserError('Nie można wykonać tej akcji na właścicielu serwera ani na bocie.');
      }
      const [member, logChannel] = await Promise.all([
        getMember(guild, targetId),
        getLogChannel(deps.discordClient, guild, config)
      ]);
      const botMember = guild.members.me || await guild.members.fetchMe();
      if (member.roles.highest.comparePositionTo(botMember.roles.highest) >= 0) {
        throw new UserError('Rola bota musi być wyższa od najwyższej roli moderowanego użytkownika.', 403);
      }
      const channelId = req.body?.channelId ? validId(req.body.channelId, 'kanału') : '';
      let actionData = { action, guildId, guildName: guild.name, targetId, actorId: req.dashUser.id, reason };
      notificationContext = {
        action,
        targetId,
        targetName: member.displayName || member.user.globalName || member.user.username,
        avatarUrl: getAvatarUrl(guildId, member),
        guildName: guild.name,
        actorId: req.dashUser.id,
        actorName: req.dashUser.name || req.dashUser.username || req.dashUser.id
      };
      let responseWarning = '';
      let dmSent;
      let preparedDmChannel = null;

      if (action === 'ban' || action === 'kick') {
        try {
          preparedDmChannel = await member.user.createDM();
        } catch (error) {
          console.warn(`[moderation] Nie udało się przygotować DM do ${targetId}:`, error.message);
        }
      }

      if (action === 'mute') {
        if (deps.storageMode() !== 'postgres') {
          throw new UserError('Akcje mute wymagają dostępnego PostgreSQL, aby poprawnie obsługiwać trwałe mute.', 503);
        }
        const mute = parseMuteRequest(req.body || {});
        actionData = { ...actionData, until: mute.until, permanent: mute.permanent };
        if (mute.permanent) {
          const previousMute = await deps.getPermanentMute(guildId, targetId);
          const record = {
            guildId,
            userId: targetId,
            reason,
            timeoutUntil: mute.until,
            updatedBy: req.dashUser.id
          };
          try {
            await deps.savePermanentMute(record);
          } catch (error) {
            throw new UserError('Nie udało się zapisać trwałego mute. Sprawdź dostępność PostgreSQL.', 503);
          }
          try {
            await member.timeout(MAX_TIMEOUT_MS, BOT_MUTE_REASON);
          } catch (error) {
            const restore = previousMute
              ? deps.savePermanentMute({
                guildId: previousMute.guild_id,
                userId: previousMute.user_id,
                reason: previousMute.reason,
                timeoutUntil: previousMute.timeout_until,
                updatedBy: previousMute.updated_by
              })
              : deps.deletePermanentMute(guildId, targetId);
            await restore.catch((cleanupError) => {
              console.error('[moderation] Nie udało się przywrócić poprzedniego stanu permanentnego mute:', cleanupError);
            });
            throw error;
          }
        } else {
          await member.timeout(mute.until.getTime() - Date.now(), reason);
          await deps.deletePermanentMute(guildId, targetId).catch((error) => {
            responseWarning = 'Mute ustawiono, ale nie udało się usunąć wcześniejszego harmonogramu permanentnego mute.';
            console.error('[moderation] Nie udało się wyczyścić harmonogramu permanentnego mute:', error);
          });
        }
        actionData.warning = responseWarning;
      } else if (action === 'unmute') {
        const previousMute = deps.storageMode() === 'postgres'
          ? await deps.getPermanentMute(guildId, targetId)
          : null;
        const hasActiveTimeout = member.communicationDisabledUntilTimestamp > Date.now();
        if (!hasActiveTimeout && !previousMute) {
          throw new UserError('Ten użytkownik nie ma aktywnego mute.');
        }
        if (previousMute) {
          await deps.deletePermanentMute(guildId, targetId);
        }
        try {
          await member.timeout(null, reason);
        } catch (error) {
          if (previousMute) {
            await deps.savePermanentMute({
              guildId: previousMute.guild_id,
              userId: previousMute.user_id,
              reason: previousMute.reason,
              timeoutUntil: previousMute.timeout_until,
              updatedBy: previousMute.updated_by
            }).catch((restoreError) => {
              console.error('[moderation] Nie udało się przywrócić wpisu permanentnego mute po błędzie odmutowania:', restoreError);
            });
          }
          throw error;
        }
      } else if (action === 'ban') {
        await member.ban({ reason, deleteMessageSeconds: 0 });
        if (deps.storageMode() === 'postgres') {
          await deps.deletePermanentMute(guildId, targetId).catch((error) => {
            responseWarning = 'Nie udało się wyczyścić harmonogramu permanentnego mute po banie.';
            console.error('[moderation] Nie udało się wyczyścić wpisu permanentnego mute po banie:', error);
          });
        }
        dmSent = await sendModerationDM(member.user, dmContent(actionData), preparedDmChannel);
      } else if (action === 'kick') {
        await member.kick(reason);
        if (deps.storageMode() === 'postgres') {
          await deps.deletePermanentMute(guildId, targetId).catch((error) => {
            responseWarning = 'Nie udało się wyczyścić harmonogramu permanentnego mute po kicku.';
            console.error('[moderation] Nie udało się wyczyścić wpisu permanentnego mute po kicku:', error);
          });
        }
        dmSent = await sendModerationDM(member.user, dmContent(actionData), preparedDmChannel);
      } else {
        if (!channelId) throw new UserError('Wybierz kanał, z którego mają być usunięte wiadomości.');
        const channel = await deps.discordClient.channels.fetch(channelId);
        if (!channel || channel.guildId !== guildId || ![0, 5].includes(channel.type) || !channel.messages) {
          throw new UserError('Wybrany kanał nie jest obsługiwanym kanałem tekstowym tego serwera.');
        }
        const durationMs = parseDeleteLookback(req.body || {});
        const channelPermissions = channel.permissionsFor(botMember);
        if (!channelPermissions?.has(PermissionFlagsBits.ViewChannel)
          || !channelPermissions.has(PermissionFlagsBits.ReadMessageHistory)
          || !channelPermissions.has(PermissionFlagsBits.ManageMessages)) {
          throw new UserError('Bot musi mieć na wybranym kanale uprawnienia wyświetlania, czytania historii i zarządzania wiadomościami.', 403);
        }
        const result = await deleteMessagesInChannel(channel, targetId, durationMs);
        actionData = { ...actionData, deletedCount: result.deleted, channelName: channel };
        if (result.failed || result.reachedScanLimit) {
          responseWarning = [
            result.failed ? `Nie udało się usunąć ${result.failed} wiadomości.` : '',
            result.reachedScanLimit ? `Osiągnięto limit skanowania ${MAX_MESSAGE_SCAN} wiadomości; uruchom akcję ponownie, aby sprawdzić starszą część zakresu.` : ''
          ].filter(Boolean).join(' ');
        }
        actionData.warning = responseWarning;
        dmSent = await sendModerationDM(member.user, dmContent({ ...actionData, channelName: channel.name }));
      }

      if (action === 'mute' || action === 'unmute') {
        dmSent = await sendModerationDM(member.user, dmContent(actionData));
      }

      actionData.warning = actionData.warning || responseWarning;
      let channelSent = true;
      try {
        await logChannel.send({
          embeds: [buildModerationEmbed(actionData, member)],
          allowedMentions: { parse: [] }
        });
      } catch (error) {
        channelSent = false;
        console.error('[moderation] Akcja wykonana, ale nie udało się wysłać logu na kanał:', error);
      }

      deps.addDashboardLog('info', `Moderacja: ${action} dla użytkownika ${targetId} na serwerze ${guildId}.`, {
        source: 'server',
        guildId,
        userId: targetId,
        actorId: req.dashUser.id,
        action,
        reason,
        channelId: channelId || null
      });

      const warning = [
        responseWarning,
        !dmSent ? 'Nie udało się wysłać DM do użytkownika.' : '',
        !channelSent ? 'Nie udało się wysłać powiadomienia na kanał logów.' : ''
      ].filter(Boolean).join(' ');
      notificationContext.deletedCount = actionData.deletedCount;
      const notification = buildModerationPanelNotification(notificationContext, { warning });
      await broadcastModerationNotification(deps, notification);

      res.json({
        ok: true,
        dmSent,
        channelSent,
        warning,
        deletedCount: actionData.deletedCount ?? null,
        notification
      });
    } catch (error) {
      if (notificationContext) {
        const message = publicError(error, 'Nie udało się wykonać akcji moderacyjnej.');
        const notification = buildModerationPanelNotification(notificationContext, { error: message });
        await broadcastModerationNotification(deps, notification);
        return requestError(res, error, 'Nie udało się wykonać akcji moderacyjnej.', {
          actionAttempted: true,
          notification
        });
      }
      requestError(res, error, 'Nie udało się wykonać akcji moderacyjnej.');
    }
  });
}

export function startPermanentMuteRenewal({ discordClient, listPermanentMutes, updatePermanentMuteTimeout, deletePermanentMute }) {
  let running = false;
  const renew = async () => {
    if (running || !discordClient.isReady()) return;
    running = true;
    try {
      const records = await listPermanentMutes();
      for (const record of records) {
        if (new Date(record.timeout_until).getTime() > Date.now() + RENEW_BEFORE_MS) continue;
        try {
          const guild = await discordClient.guilds.fetch(String(record.guild_id));
          const member = await guild.members.fetch({ user: String(record.user_id), force: true });
          const timeoutUntil = new Date(Date.now() + MAX_TIMEOUT_MS);
          await member.timeout(MAX_TIMEOUT_MS, BOT_MUTE_REASON);
          await updatePermanentMuteTimeout(record.guild_id, record.user_id, timeoutUntil);
        } catch (error) {
          if (error.status === 404 || error.code === 10007 || error.code === 10004) {
            await deletePermanentMute(record.guild_id, record.user_id).catch((cleanupError) => {
              console.error('[moderation] Nie udało się wyczyścić mute nieobecnego użytkownika:', cleanupError);
            });
          } else {
            console.error(`[moderation] Nie udało się odnowić permanentnego mute ${record.user_id} na serwerze ${record.guild_id}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('[moderation] Nie udało się pobrać permanentnych mute do odnowienia:', error);
    } finally {
      running = false;
    }
  };

  discordClient.on('ready', renew);
  const timer = setInterval(renew, RENEW_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    discordClient.off('ready', renew);
  };
}
