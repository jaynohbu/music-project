import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStemHandler } from '../stem-api.mjs';
import { createLocalServer } from '../local-server.mjs';

const jobId = '12345678-1234-1234-1234-123456789012';
const event = (value, user = 'owner') => ({
  rawPath: `/api/stems/jobs/${jobId}`, body: JSON.stringify(value),
  requestContext: { http: { method: 'PATCH' }, authorizer: { jwt: { claims: { sub: user } } } },
});
const parent = { userId: 'owner', jobId, type: 'stems', status: 'completed', title: 'Old' };

test('metadata saves title and author on the owned record only, without modifying audio', async () => {
  const calls = [];
  const handler = createStemHandler({ database: { send: async command => {
    calls.push(command);
    assert.deepEqual(command.input.Key, { userId: 'owner', jobId });
    return command.constructor.name === 'GetCommand' ? { Item: parent } : {};
  } } });
  const result = await handler(event({ title: '  My song 한글  ', author: '  Composer  ', userId: 'attacker' }));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { metadata: { title: 'My song 한글', author: 'Composer' } });
  const update = calls[1].input;
  assert.equal(update.UpdateExpression, 'SET #title = :title, #author = :author');
  assert.equal(update.ExpressionAttributeValues[':type'], 'stems');
  assert.equal(update.ConditionExpression, 'attribute_exists(jobId) AND #type = :type AND attribute_not_exists(deleting)');
});

test('metadata allows removing the author and rejects invalid fields before writes', async () => {
  let writes = 0;
  const handler = createStemHandler({ database: { send: async command => {
    if (command.constructor.name === 'GetCommand') return { Item: parent };
    writes++; return {};
  } } });
  for (const value of [
    {}, null, [], { title: ' ', author: '' }, { title: 'a'.repeat(201), author: '' },
    { title: 'Title', author: 'a'.repeat(201) }, { title: 12, author: '' },
    { title: 'Title', author: null }, { title: 'Bad\nTitle', author: '' },
  ]) assert.equal((await handler(event(value))).statusCode, 400);
  assert.equal(writes, 0);
  assert.equal((await handler(event({ title: 'Title', author: '' }))).statusCode, 200);
});

test('metadata rejects unauthenticated, foreign and non-stem jobs', async () => {
  const handler = createStemHandler({ database: { send: async command => {
    assert.equal(command.constructor.name, 'GetCommand');
    return command.input.Key.userId === 'owner' ? { Item: { ...parent, type: 'youtube' } } : {};
  } } });
  assert.equal((await handler({ requestContext: {} })).statusCode, 401);
  assert.equal((await handler(event({ title: 'X', author: '' }, 'other'))).statusCode, 404);
  assert.equal((await handler(event({ title: 'X', author: '' }))).statusCode, 404);
});

test('a concurrent record deletion cannot recreate a job through metadata editing', async () => {
  const handler = createStemHandler({ database: { send: async command => {
    if (command.constructor.name === 'GetCommand') return { Item: parent };
    throw Object.assign(new Error('Deleted'), { name: 'ConditionalCheckFailedException' });
  } } });
  assert.equal((await handler(event({ title: 'X', author: '' }))).statusCode, 404);
});

test('local PATCH routes to the stem handler with verified identity', async t => {
  const server = createLocalServer({
    verify: async () => ({ sub: 'owner' }),
    stems: async request => {
      assert.equal(request.requestContext.http.method, 'PATCH');
      assert.equal(request.requestContext.authorizer.jwt.claims.sub, 'owner');
      return { statusCode: 200, body: '{"metadata":{"title":"X","author":""}}' };
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/stems/jobs/${jobId}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer test-token' },
    body: JSON.stringify({ title: 'X', author: '' }),
  });
  assert.equal(response.status, 200);
});
