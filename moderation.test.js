import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { buildModerationEmbed, parseDeleteLookback, parseMuteRequest } from './moderation.js';

const DAY_MS = 24 * 60 * 60 * 1000;

test('Discord permission flags used by moderation exist', () => {
  assert.ok(PermissionFlagsBits.ViewChannel);
  assert.ok(PermissionFlagsBits.ReadMessageHistory);
  assert.ok(PermissionFlagsBits.ManageMessages);
  assert.ok(PermissionFlagsBits.SendMessages);
  assert.ok(PermissionFlagsBits.EmbedLinks);
});

test('permanent mute uses a maximum-length Discord timeout for renewal', () => {
  const now = Date.UTC(2026, 0, 1);
  const result = parseMuteRequest({ permanent: true }, now);
  assert.equal(result.permanent, true);
  assert.equal(result.until.getTime(), now + 28 * DAY_MS);
});

test('timed mute accepts a duration or an exact future date up to 28 days', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(parseMuteRequest({ days: 2, hours: 3, minutes: 4 }, now).until.getTime(), now + 2 * DAY_MS + 3 * 60 * 60 * 1000 + 4 * 60 * 1000);
  assert.equal(parseMuteRequest({ until: new Date(now + 28 * DAY_MS).toISOString() }, now).until.getTime(), now + 28 * DAY_MS);
  assert.throws(() => parseMuteRequest({ until: new Date(now + 28 * DAY_MS + 1).toISOString() }, now), /maksymalnie 28 dni/);
  assert.throws(() => parseMuteRequest({ minutes: 0 }, now), /co najmniej minutę/);
});

test('message deletion lookback validates units and caps excessive ranges', () => {
  assert.equal(parseDeleteLookback({ days: 1, hours: 2, minutes: 3 }), DAY_MS + 2 * 60 * 60 * 1000 + 3 * 60 * 1000);
  assert.throws(() => parseDeleteLookback({ days: -1 }), /nieujemną/);
  assert.throws(() => parseDeleteLookback({ days: 3651 }), /10 lat/);
});

test('moderation channel embed shows action, participants, mute duration, and message cleanup details', () => {
  const member = {
    avatar: null,
    user: { id: '123456789012345678', avatar: null }
  };
  const base = {
    guildId: '234567890123456789',
    guildName: 'Serwer testowy',
    targetId: member.user.id,
    actorId: '345678901234567890',
    reason: 'Powód testowy'
  };

  const mute = buildModerationEmbed({
    ...base,
    action: 'mute',
    until: new Date('2026-01-03T12:00:00.000Z'),
    permanent: false
  }, member);
  assert.match(mute.title, /wyciszony/);
  assert.equal(mute.fields.find((field) => field.name === 'Powód').value, base.reason);
  assert.match(mute.fields.find((field) => field.name === 'Czas wyciszenia').value, /<t:\d+:F>/);
  assert.match(mute.thumbnail.url, /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/\d\.png$/);

  const deletion = buildModerationEmbed({
    ...base,
    action: 'deleteMessages',
    channelName: { id: '456789012345678901' },
    deletedCount: 7,
    warning: 'Część wiadomości nie została usunięta.'
  }, member);
  assert.match(deletion.fields.find((field) => field.name === 'Kanał').value, /456789012345678901/);
  assert.equal(deletion.fields.find((field) => field.name === 'Usunięte wiadomości').value, '7');
  assert.equal(deletion.fields.find((field) => field.name === 'Ostrzeżenie').value, 'Część wiadomości nie została usunięta.');
});
