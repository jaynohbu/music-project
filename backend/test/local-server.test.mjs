import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalServer, localQueue } from '../local-server.mjs';

async function serverFixture(t, options = {}) {
  const events = [];
  const handler = async event => {
    events.push(event);
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
  };
  const server = createLocalServer({
    api: handler, accounts: handler,
    verify: async token => {
      if (token !== 'valid-token') throw new Error('Invalid signature');
      return { sub: 'cognito-user' };
    },
    ...options,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { events, base: `http://127.0.0.1:${server.address().port}` };
}

test('local health explicitly reports local processing and AWS storage', async t => {
  const { base } = await serverFixture(t);
  assert.deepEqual(await (await fetch(`${base}/health`)).json(),
    { status: 'ok', processing: 'local', storage: 'aws' });
});

test('local server takes no new jobs through the library route', async t => {
  const { base, events } = await serverFixture(t);
  const response = await fetch(`${base}/api/jobs`, {
    method: 'POST', headers: { Authorization: 'Bearer valid-token' }, body: '{"url":"https://youtu.be/abcdefghijk"}',
  });
  assert.equal(response.status, 405);
  assert.equal(events.length, 0);
});

test('local server refuses every hosted or untrusted site', async t => {
  const { base, events } = await serverFixture(t);
  for (const origin of ['https://tunesbasis.com', 'https://d324d1xuqjbi6.cloudfront.net', 'https://untrusted.example']) {
    const preflight = await fetch(`${base}/api/jobs`, { method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization',
    } });
    assert.equal(preflight.status, 403);
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
    const direct = await fetch(`${base}/api/jobs`, { headers: { Origin: origin, Authorization: 'Bearer valid-token' } });
    assert.equal(direct.status, 403);
  }
  assert.equal(events.length, 0);
});

test('local jobs require verified Cognito JWT and use verified subject', async t => {
  const { base, events } = await serverFixture(t);
  assert.equal((await fetch(`${base}/api/jobs`)).status, 401);
  assert.equal((await fetch(`${base}/api/jobs`, { headers: { Authorization: 'Bearer invalid' } })).status, 401);
  assert.equal(events.length, 0);
  const response = await fetch(`${base}/api/jobs?cursor=next`, {
    headers: { Authorization: 'Bearer valid-token' },
  });
  assert.equal(response.status, 200);
  assert.equal(events[0].requestContext.authorizer.jwt.claims.sub, 'cognito-user');
  assert.equal(events[0].queryStringParameters.cursor, 'next');
});

test('local account handlers receive token headers and trusted socket source', async t => {
  const { base, events } = await serverFixture(t);
  const response = await fetch(`${base}/api/accounts/register`, {
    method: 'POST', headers: { 'x-account-session': 'temporary-token' },
    body: '{"email":"a@example.com"}',
  });
  assert.equal(response.status, 200);
  assert.equal(events[0].headers['x-account-session'], 'temporary-token');
  assert.equal(events[0].requestContext.http.sourceIp, '127.0.0.1');
  assert.equal(events[0].requestContext.authorizer, undefined);
});

test('local server rejects unsupported routes, methods, and oversized bodies', async t => {
  const { base, events } = await serverFixture(t);
  assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
  assert.equal((await fetch(`${base}/api/jobs`, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(`${base}/api/accounts/session`, { method: 'GET' })).status, 405);
  assert.equal((await fetch(`${base}/api/accounts/session`, {
    method: 'POST', body: 'x'.repeat(4097),
  })).status, 413);
  assert.equal(events.length, 0);
});

test('local queue executes worker on this process, enforces capacity, and drains', async () => {
  let finish;
  const seen = [];
  const queue = localQueue(async job => {
    seen.push(job);
    await new Promise(resolve => { finish = resolve; });
  }, 1);
  const command = { input: { Payload: Buffer.from('{"jobId":"local"}') } };
  assert.equal((await queue.send(command)).StatusCode, 202);
  await assert.rejects(queue.send(command), /capacity/);
  assert.deepEqual(seen, [{ jobId: 'local' }]);
  finish();
  await Promise.all(queue.running);
  assert.equal(queue.running.size, 0);
});
