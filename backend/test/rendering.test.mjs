import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { familyEvents, matchLoudness, offered, renderPart, renderStem, samplesFor } from '../score-render.mjs';
import { createStemHandler } from '../stem-api.mjs';

process.env.TABLE_NAME = 'jobs';
process.env.BUCKET_NAME = 'bucket';
process.env.STEM_STATE_MACHINE = 'machine';
const samples = { rate: 1000, pitches: [36, 39, 42, 45, 48, 51, 54, 57, 60, 63, 66, 69, 72], slot: 3.5, length: 3 };

test('sounds are offered with the song\'s ranked ones first, then every other of the family', () => {
  const library = { groups: { pop: { styles: [], guitar: [27, 25], keys: [0] } }, samples,
    sounds: { 0: { name: 'Piano', family: 'keys' }, 25: { name: 'Steel', family: 'guitar' }, 27: { name: 'Clean', family: 'guitar' }, 220: { name: 'Shiny', family: 'guitar' } } };
  assert.deepEqual(offered(library, { genre: 'pop', guitar: { sounds: [25, 27] } }, 'guitar'), [25, 27, 220]);
  assert.deepEqual(offered(library, undefined, 'guitar'), [27, 25, 220]);
});

test('a family plays its own part: every note but the sung line; a kit\'s drums are its slots on the beats', () => {
  const result = { beats: [0, 0.5, 1, 1.5, 2], firstBar: 0, stems: {
    drums: { chords: [], notes: [], hits: [{ unit: 4, drum: 'snare' }, { unit: 0, drum: 'kick' }, { unit: 6, drum: 'cowbell' }] },
    bass: { chords: [], notes: [{ start: 1, end: 1.5, pitch: 40, unit: 8, length: 4, velocity: 80 }] },
  }, ensemble: { chords: [], notes: [{ start: 0.5, end: 0.75, pitch: 64, unit: 0, length: 1 }], melody: [{ start: 0, end: 1, pitch: 72, unit: 0, length: 2 }] } };
  assert.deepEqual(familyEvents('drums', result).map(event => [event.time, event.pitch]), [[0, 0], [0.5, 1]]);
  assert.deepEqual(familyEvents('bass', result).map(event => event.pitch), [40]);
  assert.deepEqual(familyEvents('keys', result), [{ time: 0.5, duration: 0.25, pitch: 64, velocity: 90 }], 'the ensemble, not its sung line');
  assert.deepEqual(familyEvents('guitar', { beats: [], stems: {} }), []);
  assert.deepEqual(samplesFor({ samples, layouts: { bass: { ...samples, pitches: [24] } } }, 'bass').pitches, [24]);
});

test('a part follows its stem\'s loudness and is rendered whole from its samples, early by their attack', () => {
  const levels = samples.pitches.map(() => new Array(12).fill(0.2));
  const events = Array.from({ length: 40 }, (_, k) => ({ time: k * 0.25, duration: 0.25, pitch: 60, velocity: 64 }));
  const { events: moved, gain } = matchLoudness(events, Array.from({ length: 40 }, (_, k) => k < 20 ? 0.05 : 0.1), 0.25, samples, levels);
  assert.ok(gain > 0 && moved[30].velocity > moved[5].velocity);
  const soundRate = 100, sound = new Float32Array(samples.pitches.length * 350);
  samples.pitches.forEach((_, index) => sound.fill(index + 1, index * 350, index * 350 + 300));
  const attacks = samples.pitches.map((_, index) => index === 8 ? 0.1 : 0);
  const out = renderPart([{ time: 1, duration: 0.5, pitch: 60, velocity: 127 }], sound, soundRate, samples, attacks, 3, 1000);
  assert.equal(out.length, 3000);
  assert.equal(out[890], 0);
  assert.ok(Math.abs(out[1200] - 9 * 0.5) < 1e-6);
  assert.ok(out[1550] > 0 && out[1800] === 0);
});

test('a part is made as a stereo AAC stem as long as the song, from the sound\'s FLAC', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'render-test-'));
  try {
    // A sound of 21 slots of a 440 Hz tone at the library's layout.
    const library = { groups: { pop: { styles: [], keys: [200] } }, sounds: { 200: { name: 'Tone', family: 'keys' } },
      samples: { rate: 32000, pitches: Array.from({ length: 21 }, (_, i) => 36 + 3 * i), slot: 3.5, length: 3 } };
    const flac = path.join(directory, 'tone.flac');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=32000:duration=73.5', flac]);
    const fetcher = async url => url.endsWith('styles.json')
      ? { ok: true, json: async () => library }
      : { ok: true, arrayBuffer: async () => { const bytes = await readFile(flac); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length); } };
    const result = { beats: [0, 1], stems: {}, ensemble: { chords: [], notes: [{ start: 0.5, end: 1.5, pitch: 69, unit: 0, length: 4 }] },
      fromScore: { parts: { other: {} } }, loudness: { window: 0.25, other: new Array(16).fill(0.05) } };
    const output = path.join(directory, 'out.m4a');
    assert.equal(await renderStem({ result, family: 'keys', sound: 200, seconds: 4, directory, output, fetcher }), true);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { encoding: 'utf8' }));
    assert.equal(probe.streams[0].codec_name, 'aac');
    assert.equal(probe.streams[0].channels, 2);
    assert.ok(Math.abs(Number(probe.format.duration) - 4) < 0.1, probe.format.duration);
    await assert.rejects(renderStem({ result, family: 'guitar', sound: 200, seconds: 4, directory, output, fetcher }), /not one of this part/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a sound is asked for once per result, family and sound, and only for a part laid from a score', async () => {
  const items = new Map(), started = [];
  const parentId = '22222222-2222-4222-8222-222222222222', harmonyId = '33333333-3333-4333-8333-333333333333';
  const key = item => `${item.userId}|${item.jobId}`;
  items.set(`u|${parentId}`, { userId: 'u', jobId: parentId, type: 'stems', status: 'completed', duration: 60 });
  items.set(`u|${harmonyId}`, { userId: 'u', jobId: harmonyId, type: 'harmony', parentJobId: parentId, status: 'completed', version: 16,
    key: 'users/u/harmony/x.json', generatedAt: '2026-11-27T00:00:00.000Z', fromScore: { parts: { other: { title: '' } } } });
  const database = { async send(command) {
    const input = command.input, kind = command.constructor.name;
    if (kind === 'GetCommand') return { Item: structuredClone(items.get(`${input.Key.userId}|${input.Key.jobId}`)) };
    if (kind === 'PutCommand') { items.set(key(input.Item), structuredClone(input.Item)); return {}; }
    if (kind === 'QueryCommand') {
      const values = input.ExpressionAttributeValues;
      return { Items: [...items.values()].filter(item => item.parentJobId === values[':parent'] && item.type === values[':type']).map(item => structuredClone(item)) };
    }
    return {};
  } };
  const handler = createStemHandler({ database, storage: { send: async () => ({}) }, orchestrator: { send: async command => { started.push(JSON.parse(command.input.input)); return {}; } },
    signer: async () => 'https://signed' });
  const ask = body => handler({ rawPath: `/api/stems/jobs/${parentId}/renderings`, body: JSON.stringify(body),
    requestContext: { http: { method: 'POST' }, authorizer: { jwt: { claims: { sub: 'u' } } } } });
  const first = await ask({ family: 'keys', sound: 201 });
  assert.equal(first.statusCode, 202, first.body);
  const rendering = JSON.parse(first.body).rendering;
  assert.deepEqual([rendering.family, rendering.sound, rendering.harmonyId, rendering.status], ['keys', 201, harmonyId, 'queued']);
  assert.deepEqual(started, [{ userId: 'u', jobId: rendering.id, kind: 'rendering' }]);
  assert.equal(JSON.parse((await ask({ family: 'keys', sound: 201 })).body).rendering.id, rendering.id, 'the same one again');
  assert.equal(started.length, 1);
  assert.equal((await ask({ family: 'bass', sound: 240 })).statusCode, 409, 'no bass score');
  assert.equal((await ask({ family: 'flute', sound: 1 })).statusCode, 400);
});
