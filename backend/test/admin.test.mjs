import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TABLE_NAME = 'jobs';
process.env.USER_POOL_ID = 'pool';
process.env.USER_POOL_CLIENT_ID = 'public-client';
process.env.IMPERSONATION_CLIENT_ID = 'admin-client';
process.env.IMPERSONATION_SECRET = 'secret-arn';

const admin = await import('../admin-api.mjs');
const challenge = await import('../auth-challenge.mjs');

const ADMIN = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const OTHER_ADMIN = '33333333-3333-4333-8333-333333333333';
const SECRET = 'top-secret';

function setup({ items = {} } = {}) {
  const calls = [];
  const database = { async send(command) {
    calls.push([command.constructor.name, command.input]);
    if (command.constructor.name === 'QueryCommand') return { Items: items[command.input.ExpressionAttributeValues[':userId']] ?? [] };
    return {};
  } };
  const users = [
    { Username: 'admin@x.com', Enabled: true, UserStatus: 'CONFIRMED', Attributes: [{ Name: 'sub', Value: ADMIN }, { Name: 'email', Value: 'admin@x.com' }] },
    { Username: 'user@x.com', Enabled: true, UserStatus: 'CONFIRMED', Attributes: [{ Name: 'sub', Value: USER }, { Name: 'email', Value: 'user@x.com' }] },
    { Username: 'boss@x.com', Enabled: true, UserStatus: 'CONFIRMED', Attributes: [{ Name: 'sub', Value: OTHER_ADMIN }, { Name: 'email', Value: 'boss@x.com' }] },
  ];
  const cognito = { async send(command) {
    const name = command.constructor.name, input = command.input;
    calls.push([name, input]);
    if (name === 'ListUsersCommand') {
      const sub = /sub = "(.+)"/.exec(input.Filter ?? '')?.[1];
      return { Users: sub ? users.filter(user => user.Attributes[0].Value === sub) : users };
    }
    if (name === 'AdminListGroupsForUserCommand') {
      return { Groups: ['admin@x.com', 'boss@x.com'].includes(input.Username) ? [{ GroupName: 'admins' }] : [] };
    }
    if (name === 'AdminInitiateAuthCommand') return { ChallengeName: 'CUSTOM_CHALLENGE', Session: 's', ChallengeParameters: { nonce: 'n1' } };
    if (name === 'AdminRespondToAuthChallengeCommand') {
      const ok = input.ChallengeResponses.ANSWER === admin.challengeAnswer(SECRET, 'n1', input.ChallengeResponses.USERNAME);
      return ok ? { AuthenticationResult: { IdToken: 'id', AccessToken: 'access', ExpiresIn: 3600 } } : {};
    }
    return {};
  } };
  const store = { async send() { return { SecretString: SECRET }; } };
  const handler = admin.createHandler({ database, cognito, store, clock: () => new Date('2026-11-21T12:00:00Z') });
  const call = async (path, { method = 'POST', body, sub = ADMIN, groups = '[admins]', aud = 'public-client' } = {}) => {
    const result = await handler({
      rawPath: path, body: body === undefined ? undefined : JSON.stringify(body),
      requestContext: { http: { method }, authorizer: { jwt: { claims: { sub, aud, 'cognito:groups': groups } } } },
    });
    return { status: result.statusCode, body: JSON.parse(result.body) };
  };
  return { call, calls };
}

test('only an admin signed in through the public client opens admin routes', async () => {
  assert.deepEqual(admin.groupsOf({ 'cognito:groups': '[admins other]' }), ['admins', 'other']);
  assert.deepEqual(admin.groupsOf({ 'cognito:groups': ['admins'] }), ['admins']);
  assert.deepEqual(admin.groupsOf({}), []);
  const { call } = setup();
  assert.equal((await call('/api/admin/users', { method: 'GET', groups: '' })).status, 403);
  assert.equal((await call('/api/admin/users', { method: 'GET', aud: 'admin-client' })).status, 403, 'An opened account is never an admin');
  assert.equal((await call('/api/admin/users', { method: 'GET' })).status, 200);
});

test('the user list shows plan, songs, storage, splits and time per day', async () => {
  const now = new Date('2026-11-21T12:00:00Z');
  const summary = admin.summarize([
    { jobId: 'plan', plan: 'premium' },
    { jobId: 'usage:2026-11', splits: 4 },
    { jobId: 'activity:2026-11-21', open: 600, play: 300 },
    { jobId: 'activity:2026-11-16', open: 60, play: 0 },
    { jobId: 'activity:2026-11-01', open: 999, play: 999 },
    { jobId: 'a', type: 'stems', status: 'completed', createdAt: now.toISOString(), stems: { vocals: { bytes: 1000, playBytes: 200 }, bass: { bytes: 500 } } },
    { jobId: 'b', type: 'restoration', status: 'completed', bytes: 300 },
  ], now);
  assert.equal(summary.plan, 'premium');
  assert.equal(summary.songs, 1);
  assert.equal(summary.songLimit, 500);
  assert.equal(summary.bytes, 2000);
  assert.equal(summary.splits, 4);
  assert.deepEqual(summary.today, { open: 600, play: 300 });
  assert.deepEqual(summary.week, { open: 660, play: 300 }, 'Only the last seven days count');
  assert.equal(summary.lastActive, '2026-11-21');
  const { call } = setup({ items: { [USER]: [{ jobId: 'plan', plan: 'premium' }] } });
  const users = (await call('/api/admin/users', { method: 'GET' })).body.users;
  assert.equal(users.find(user => user.id === USER).plan, 'premium');
  assert.equal(users.find(user => user.id === ADMIN).plan, 'free');
});

test('disabling a user also signs them out everywhere; an admin cannot disable themselves', async () => {
  const { call, calls } = setup();
  assert.equal((await call(`/api/admin/users/${USER}/enabled`, { body: { enabled: false } })).status, 200);
  assert.deepEqual(calls.filter(([name]) => name.startsWith('AdminDisable') || name.startsWith('AdminUserGlobal')).map(([name, input]) => [name, input.Username]),
    [['AdminDisableUserCommand', 'user@x.com'], ['AdminUserGlobalSignOutCommand', 'user@x.com']]);
  assert.equal((await call(`/api/admin/users/${USER}/enabled`, { body: { enabled: true } })).status, 200);
  assert.ok(calls.some(([name]) => name === 'AdminEnableUserCommand'));
  assert.equal((await call(`/api/admin/users/${ADMIN}/enabled`, { body: { enabled: false } })).status, 409);
  assert.equal((await call(`/api/admin/users/${USER}/enabled`, { body: { enabled: 'no' } })).status, 400);
  assert.equal((await call('/api/admin/users/44444444-4444-4444-8444-444444444444/enabled', { body: { enabled: true } })).status, 404);
});

test('the plan is set by its record: premium writes it, free removes it', async () => {
  const { call, calls } = setup();
  assert.equal((await call(`/api/admin/users/${USER}/plan`, { body: { plan: 'premium' } })).status, 200);
  assert.deepEqual(calls.find(([name]) => name === 'PutCommand')[1].Item, { userId: USER, jobId: 'plan', plan: 'premium' });
  assert.equal((await call(`/api/admin/users/${USER}/plan`, { body: { plan: 'free' } })).status, 200);
  assert.deepEqual(calls.find(([name]) => name === 'DeleteCommand')[1].Key, { userId: USER, jobId: 'plan' });
  assert.equal((await call(`/api/admin/users/${USER}/plan`, { body: { plan: 'gold' } })).status, 400);
});

test('opening a user returns that user\'s tokens through the signed challenge; other admins cannot be opened', async () => {
  const { call } = setup();
  const opened = await call(`/api/admin/users/${USER}/session`);
  assert.equal(opened.status, 200);
  assert.equal(opened.body.email, 'user@x.com');
  assert.equal(opened.body.session.idToken, 'id');
  assert.equal((await call(`/api/admin/users/${OTHER_ADMIN}/session`)).status, 409);
  assert.equal((await call(`/api/admin/users/${USER}/session`, { groups: '' })).status, 403);
});

test('time is added per day in capped steps, and not while an admin views someone', async () => {
  const { call, calls } = setup();
  assert.equal((await call('/api/activity', { sub: USER, groups: '', body: { open: 60, play: 45 } })).status, 202);
  const update = calls.find(([name]) => name === 'UpdateCommand')[1];
  assert.deepEqual(update.Key, { userId: USER, jobId: 'activity:2026-11-21' });
  assert.deepEqual(update.ExpressionAttributeValues, { ':open': 60, ':play': 45 });
  for (const body of [{ open: 121, play: 0 }, { open: 1.5, play: 0 }, { open: 10 }, { open: -1, play: 0 }]) {
    assert.equal((await call('/api/activity', { sub: USER, groups: '', body })).status, 400, JSON.stringify(body));
  }
  const viewed = await call('/api/activity', { sub: USER, aud: 'admin-client', groups: '', body: { open: 60, play: 60 } });
  assert.deepEqual(viewed.body, { recorded: false });
  assert.equal(calls.filter(([name]) => name === 'UpdateCommand').length, 1);
});

test('the custom sign-in asks one challenge and accepts only the HMAC of its nonce', async () => {
  const handler = challenge.createHandler({ store: { async send() { return { SecretString: SECRET }; } } });
  const define = async session => (await handler({ triggerSource: 'DefineAuthChallenge_Authentication', request: { session }, response: {} })).response;
  assert.equal((await define([])).challengeName, 'CUSTOM_CHALLENGE');
  assert.equal((await define([{ challengeName: 'CUSTOM_CHALLENGE', challengeResult: true }])).issueTokens, true);
  assert.equal((await define([{ challengeName: 'CUSTOM_CHALLENGE', challengeResult: false }])).failAuthentication, true);
  assert.equal((await define([{ challengeName: 'SRP_A', challengeResult: true }])).failAuthentication, true);
  const created = (await handler({ triggerSource: 'CreateAuthChallenge_Authentication', request: {}, response: {} })).response;
  assert.match(created.publicChallengeParameters.nonce, /^[0-9a-f]{64}$/);
  const verify = async answer => (await handler({ triggerSource: 'VerifyAuthChallengeResponse_Authentication', userName: 'user@x.com',
    request: { privateChallengeParameters: { nonce: 'n9' }, challengeAnswer: answer }, response: {} })).response.answerCorrect;
  assert.equal(await verify(admin.challengeAnswer(SECRET, 'n9', 'user@x.com')), true);
  assert.equal(await verify(admin.challengeAnswer('guess', 'n9', 'user@x.com')), false);
  assert.equal(await verify(''), false);
});
