import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScoreHandler, LARGEST_SCORE } from '../score-api.mjs';

process.env.BUCKET_NAME = 'audio';
process.env.SCORE_READER = 'reader';
const user = 'user-1';
const id = '11111111-2222-3333-4444-555555555555';
const event = (method, rawPath, body, sub = user) => ({
  rawPath, body: body === undefined ? undefined : JSON.stringify(body),
  requestContext: { http: { method }, authorizer: sub ? { jwt: { claims: { sub } } } : undefined },
});
const parse = response => ({ status: response.statusCode, body: JSON.parse(response.body) });

function fakes(objects = {}) {
  const sent = [], invoked = [], signed = [];
  const storage = {
    async send(command) {
      sent.push(command);
      const key = command.input.Key;
      if (!(key in objects)) throw Object.assign(new Error('missing'), { name: command.constructor.name === 'HeadObjectCommand' ? 'NotFound' : 'NoSuchKey' });
      return { Body: { transformToString: async () => objects[key] } };
    },
  };
  const reader = { async send(command) { invoked.push(JSON.parse(Buffer.from(command.input.Payload).toString())); return {}; } };
  const handler = createScoreHandler({
    storage, reader,
    uploadSigner: async (_, options) => { signed.push(options); return { url: 'https://upload', fields: { key: options.Key } }; },
    signer: async (_, command) => `https://get/${command.input.Key}`,
  });
  return { handler, sent, invoked, signed };
}

test('scores: an upload is signed for the file size under the user\'s own prefix; too large or unsigned is refused', async () => {
  const { handler, signed } = fakes();
  const created = parse(await handler(event('POST', '/api/scores', { bytes: 1234 })));
  assert.equal(created.status, 201);
  assert.match(created.body.id, /^[0-9a-f-]{36}$/);
  assert.equal(signed[0].Key, `score-readings/${user}/${created.body.id}/input`);
  assert.deepEqual(signed[0].Conditions[0], ['content-length-range', 1234, 1234]);
  assert.equal(parse(await handler(event('POST', '/api/scores', { bytes: LARGEST_SCORE + 1 }))).status, 413);
  assert.equal(parse(await handler(event('POST', '/api/scores', { bytes: 'a lot' }))).status, 400);
  assert.equal(parse(await handler(event('POST', '/api/scores', { bytes: 10 }, null))).status, 401);
});

test('scores: reading starts the reader with the pages asked for, once the file is there', async () => {
  const { handler, invoked } = fakes({ [`score-readings/${user}/${id}/input`]: '%PDF' });
  assert.equal(parse(await handler(event('POST', `/api/scores/${id}/read`, { pages: '2-3 5' }))).status, 202);
  assert.deepEqual(invoked, [{ bucket: 'audio', prefix: `score-readings/${user}/${id}`, pages: '2-3 5' }]);
  assert.equal(parse(await handler(event('POST', `/api/scores/${id}/read`, { pages: '2; rm -rf' }))).status, 400);
  // Another user's reading is not there for them.
  assert.equal(parse(await handler(event('POST', `/api/scores/${id}/read`, {}, 'user-2'))).status, 404);
  assert.equal(parse(await handler(event('POST', '/api/scores/not-an-id/read', {}))).status, 404);
});

test('scores: the status is reading until the reader reports, then the score link or the reason it failed', async () => {
  const objects = {};
  const { handler } = fakes(objects);
  assert.deepEqual(parse(await handler(event('GET', `/api/scores/${id}`))).body, { id, status: 'reading' });
  objects[`score-readings/${user}/${id}/status.json`] = JSON.stringify({ status: 'completed', scores: 2 });
  assert.deepEqual(parse(await handler(event('GET', `/api/scores/${id}`))).body,
    { id, status: 'completed', scores: 2, url: `https://get/score-readings/${user}/${id}/score.mxl` });
  objects[`score-readings/${user}/${id}/status.json`] = JSON.stringify({ status: 'failed', message: 'No music could be read from the file.' });
  assert.deepEqual(parse(await handler(event('GET', `/api/scores/${id}`))).body,
    { id, status: 'failed', message: 'No music could be read from the file.' });
});
