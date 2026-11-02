import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { restrictLegacyYoutube } from '../youtube-admin.mjs';

test('legacy link revocation paginates only non-owner YouTube jobs and preserves other object tags', async () => {
  let pages = 0;
  const tagged = [];
  const counts = await restrictLegacyYoutube({
    owner: 'owner', bucket: 'audio', table: 'jobs',
    database: { send: async command => {
      assert.equal(command.input.ExpressionAttributeValues[':owner'], 'owner');
      assert.match(command.input.FilterExpression, /attribute_not_exists/);
      assert.equal(command.input.ConsistentRead, true);
      return pages++ === 0
        ? { Items: [{ userId: 'other', jobId: 'old', key: 'users/other/old.wav' }], LastEvaluatedKey: { userId: 'other', jobId: 'old' } }
        : { Items: [{ userId: 'other', jobId: 'pending' }] };
    } },
    storage: { send: async command => {
      if (command.constructor.name === 'GetObjectTaggingCommand') return { TagSet: [{ Key: 'existing', Value: 'keep' }] };
      tagged.push(command.input); return {};
    } },
  });
  assert.equal(pages, 2);
  assert.deepEqual(counts, { blocked: 1, missing: 0 });
  assert.deepEqual(tagged[0].Tagging.TagSet, [
    { Key: 'existing', Value: 'keep' }, { Key: 'sorituh-youtube-access', Value: 'blocked' },
  ]);
});

test('revocation also blocks MP3 YouTube files', async () => {
  const tagged = [];
  const counts = await restrictLegacyYoutube({
    owner: 'owner', bucket: 'audio', table: 'jobs',
    database: { send: async () => ({ Items: [{ userId: 'other', jobId: 'new', key: 'users/other/new.mp3' }] }) },
    storage: { send: async command => {
      if (command.constructor.name === 'GetObjectTaggingCommand') return { TagSet: [] };
      tagged.push(command.input); return {};
    } },
  });
  assert.deepEqual(counts, { blocked: 1, missing: 0 });
  assert.equal(tagged[0].Key, 'users/other/new.mp3');
});

test('revocation refuses unexpected keys instead of tagging original stems', async () => {
  await assert.rejects(restrictLegacyYoutube({
    owner: 'owner', bucket: 'audio', table: 'jobs',
    database: { send: async () => ({ Items: [{
      userId: 'other', jobId: 'id', key: 'users/other/stems/id/vocals.wav',
    }] }) },
    storage: { send: () => assert.fail('Storage must not be touched') },
  }), /Unexpected legacy/);
});

test('infrastructure revokes existing signed GET links by object tag and enables authenticated metadata PATCH', async () => {
  const template = await readFile(new URL('../../template.yaml', import.meta.url), 'utf8');
  assert.match(template, /Sid: BlockRestrictedYoutubeAudio[\s\S]*?Effect: Deny[\s\S]*?Action: s3:GetObject[\s\S]*?s3:ExistingObjectTag\/sorituh-youtube-access: blocked/);
  assert.match(template, /YOUTUBE_OWNER_SUB: !Ref YoutubeOwnerSubject/);
  assert.match(template, /UpdateMetadata:[\s\S]*?Method: PATCH/);
});
