import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createAccountHandler, SESSION_SECONDS } from '../accounts.mjs';

const token = 'A'.repeat(43);
const namedError = name => Object.assign(new Error('Simulated failure'), { name });
const event = (action, body = {}) => ({
  rawPath: `/api/accounts/${action}`,
  requestContext: { http: { sourceIp: '192.0.2.1', method: 'POST' } },
  headers: { 'x-account-session': token },
  body: JSON.stringify(body),
});
const parse = response => JSON.parse(response.body);
function fixture(options = {}) {
  const commands = [];
  const identityCommands = [];
  const factory = createAccountHandler({
    now: () => 1000, random: () => token,
    database: { send: async command => { commands.push(command); return {}; } },
    identity: { send: async command => { identityCommands.push(command); return {}; } },
    secretStore: { send: async () => ({ SecretString: `${randomBytes(12).toString('hex')}aA1!` }) },
    ...options,
  });
  return { handler: factory, commands, identityCommands };
}

test('issues exactly five-minute session and stores only a token hash', async () => {
  const { handler, commands } = fixture();
  const response = await handler(event('session'));
  assert.equal(response.statusCode, 201);
  assert.deepEqual(parse(response), { token, expiresAt: 1300000, expiresIn: 300 });
  assert.equal(SESSION_SECONDS, 300);
  assert.equal(commands[0].input.ExpressionAttributeValues[':limit'], 10);
  assert.equal(commands[1].input.Item.id,
    `session:${createHash('sha256').update(token).digest('hex')}`);
  assert.equal(commands[1].input.Item.expiresAt, 1300);
  assert.ok(!JSON.stringify(commands).includes(token));
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('session issuance throttle is explicit; database errors are not hidden', async () => {
  for (const [name, status] of [['ConditionalCheckFailedException', 429], ['InternalServerError', 503]]) {
    const { handler } = fixture({ database: { send: async () => { throw namedError(name); } } });
    assert.equal((await handler(event('session'))).statusCode, status);
  }
});

test('missing or malformed temporary tokens never call AWS account APIs', async () => {
  const { handler, identityCommands, commands } = fixture();
  for (const headers of [{}, { 'x-account-session': 'malicious' }]) {
    const response = await handler({ ...event('register', { email: 'a@example.com' }), headers });
    assert.equal(response.statusCode, 401);
    assert.equal(parse(response).restartSession, true);
  }
  assert.equal(identityCommands.length, 0);
  assert.equal(commands.length, 0);
});

test('expired or exhausted session requests fail server-side before creating account', async () => {
  let command;
  const { handler, identityCommands } = fixture({
    database: { send: async input => { command = input; throw namedError('ConditionalCheckFailedException'); } },
  });
  assert.equal((await handler(event('register', { email: 'a@example.com' }))).statusCode, 401);
  assert.equal(command.input.ExpressionAttributeValues[':now'], 1000);
  assert.equal(command.input.ExpressionAttributeValues[':limit'], 5);
  assert.match(command.input.ConditionExpression, /expiresAt > :now/);
  assert.equal(identityCommands.length, 0);
});

test('register creates verified user, suppresses email, disables before permanent password', async () => {
  const { handler, identityCommands } = fixture();
  const response = await handler(event('register', { email: 'Alice@Example.com' }));
  assert.equal(response.statusCode, 201);
  assert.deepEqual(identityCommands.map(c => c.constructor.name),
    ['AdminCreateUserCommand', 'AdminDisableUserCommand', 'AdminSetUserPasswordCommand']);
  const created = identityCommands[0].input;
  assert.equal(created.Username, 'alice@example.com');
  assert.equal(created.MessageAction, 'SUPPRESS');
  assert.deepEqual(created.UserAttributes, [
    { Name: 'email', Value: 'alice@example.com' }, { Name: 'email_verified', Value: 'true' },
  ]);
  assert.equal(identityCommands[2].input.Permanent, true);
  assert.match(parse(response).message, /disabled/);
  assert.ok(!parse(response).password);
});

test('duplicate registration never changes or disables an existing user', async () => {
  const calls = [];
  const { handler } = fixture({ identity: { send: async command => {
    calls.push(command);
    throw namedError('UsernameExistsException');
  } } });
  assert.equal((await handler(event('register', { email: 'a@example.com' }))).statusCode, 409);
  assert.deepEqual(calls.map(c => c.constructor.name), ['AdminCreateUserCommand']);
});

test('partial new-account setup is rolled back, not reported as successful', async () => {
  for (const failsAt of ['AdminDisableUserCommand', 'AdminSetUserPasswordCommand']) {
    const calls = [];
    const { handler } = fixture({ identity: { send: async command => {
      calls.push(command);
      if (command.constructor.name === failsAt) throw namedError('InternalServerError');
      return {};
    } } });
    assert.equal((await handler(event('register', { email: 'a@example.com' }))).statusCode, 503);
    assert.equal(calls.at(-1).constructor.name, 'AdminDeleteUserCommand');
  }
});

test('invalid JSON, email, reset code and password do not reach Cognito', async () => {
  const { handler, identityCommands } = fixture();
  for (const value of [null, [], {}, { email: 'invalid' }]) {
    assert.equal((await handler(event('register', value))).statusCode, 400);
  }
  assert.equal((await handler({ ...event('register'), body: 'bad JSON' })).statusCode, 400);
  for (const value of [
    { email: 'a@example.com', code: '12345', password: 'notvalid' },
    { email: 'a@example.com', code: '123456', password: 'a'.repeat(12) },
    { email: 'a@example.com', code: '123456', password: `${'a'.repeat(257)}A1!` },
  ]) assert.equal((await handler(event('confirm-password', value))).statusCode, 400);
  assert.equal(identityCommands.length, 0);
});

test('forgot and confirm flows call Cognito without admin-enable permissions', async () => {
  const { handler, identityCommands } = fixture();
  assert.equal((await handler(event('forgot-password', { email: 'a@example.com' }))).statusCode, 200);
  const password = `${randomBytes(12).toString('hex')}aA1!`;
  const response = await handler(event('confirm-password', { email: 'a@example.com', code: '123456', password }));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(identityCommands.map(c => c.constructor.name),
    ['ForgotPasswordCommand', 'ConfirmForgotPasswordCommand']);
  assert.equal(identityCommands[1].input.ConfirmationCode, '123456');
  assert.equal(identityCommands[1].input.Password, password);
});

test('Cognito reset failures remain explicit', async () => {
  for (const [name, status] of [
    ['NotAuthorizedException', 400], ['CodeMismatchException', 400],
    ['ExpiredCodeException', 400], ['TooManyRequestsException', 429],
    ['CodeDeliveryFailureException', 503],
  ]) {
    const { handler } = fixture({ identity: { send: async () => { throw namedError(name); } } });
    const response = await handler(event('forgot-password', { email: 'a@example.com' }));
    assert.equal(response.statusCode, status);
    assert.ok(parse(response).message);
  }
});

const deviceBody = { email: 'New@Example.com', deviceId: 'abcdef0123456789', password: 'correctHorse1!correct' };
const hashed = value => createHash('sha256').update(value).digest('hex');
const deviceKey = { emailHash: hashed('new@example.com'), deviceHash: hashed('abcdef0123456789') };
function deviceFixture({ exists = true, known = false, unproven = [], failOn } = {}) {
  const database = [];
  const identity = [];
  const { handler } = fixture({
    database: { send: async command => {
      database.push(command);
      if (command.constructor.name === 'GetCommand') return known ? { Item: deviceKey } : {};
      if (command.constructor.name === 'QueryCommand') return { Items: unproven };
      return {};
    } },
    identity: { send: async command => {
      identity.push(command);
      const name = command.constructor.name;
      if (name === 'AdminCreateUserCommand' && exists) throw namedError('UsernameExistsException');
      if (name === failOn) throw namedError('InternalErrorException');
      return {};
    } },
  });
  const names = list => list.map(command => command.constructor.name);
  return { handler, database, identity, names };
}

test('device request creates a new account with no code and remembers the device as unproven', async () => {
  const { handler, database, identity, names } = deviceFixture({ exists: false });
  const response = await handler(event('device', deviceBody));
  assert.equal(response.statusCode, 201);
  assert.deepEqual(parse(response), { status: 'ready' });
  assert.deepEqual(names(identity), ['AdminCreateUserCommand', 'AdminSetUserPasswordCommand']);
  assert.equal(identity[1].input.Password, deviceBody.password);
  assert.equal(identity[1].input.Permanent, true);
  const saved = database.find(command => command.constructor.name === 'PutCommand' && command.input.Item.deviceHash);
  assert.deepEqual(saved.input.Item, { ...deviceKey, proven: false });
  assert.ok(!JSON.stringify(database.map(command => command.input)).includes(deviceBody.deviceId));
});

test('reinstall on a known device resets the password with no code', async () => {
  const { handler, identity, names } = deviceFixture({ known: true });
  const response = await handler(event('device', deviceBody));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(parse(response), { status: 'ready' });
  assert.deepEqual(names(identity), ['AdminCreateUserCommand', 'AdminSetUserPasswordCommand']);
  assert.equal(identity[1].input.Password, deviceBody.password);
});

test('an unknown device cannot change an existing password without the emailed code', async () => {
  const { handler, identity, names } = deviceFixture();
  const response = await handler(event('device', deviceBody));
  assert.deepEqual(parse(response), { status: 'code-required' });
  assert.deepEqual(names(identity), ['AdminCreateUserCommand', 'ForgotPasswordCommand']);
});

test('a correct code registers the device as proven and removes unproven devices', async () => {
  const other = { emailHash: deviceKey.emailHash, deviceHash: 'other' };
  const { handler, database, identity, names } = deviceFixture({ unproven: [other] });
  const response = await handler(event('device', { ...deviceBody, code: '123456' }));
  assert.deepEqual(parse(response), { status: 'ready' });
  assert.deepEqual(names(identity), ['AdminCreateUserCommand', 'ConfirmForgotPasswordCommand']);
  assert.deepEqual(database.find(c => c.constructor.name === 'DeleteCommand').input.Key, other);
  const saved = database.filter(c => c.constructor.name === 'PutCommand').at(-1);
  assert.deepEqual(saved.input.Item, { ...deviceKey, proven: true });
});

test('a rejected code leaves registered devices alone', async () => {
  const { handler, database, names } = deviceFixture({ failOn: 'ConfirmForgotPasswordCommand' });
  assert.equal((await handler(event('device', { ...deviceBody, code: '123456' }))).statusCode, 503);
  assert.ok(!names(database).includes('DeleteCommand'));
  assert.ok(!names(database).includes('QueryCommand'));
});

test('a website password reset also removes unproven devices', async () => {
  const other = { emailHash: deviceKey.emailHash, deviceHash: 'other' };
  const { handler, database } = deviceFixture({ unproven: [other] });
  const response = await handler(event('confirm-password', { ...deviceBody, code: '123456' }));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(database.find(c => c.constructor.name === 'DeleteCommand').input.Key, other);
});

test('device setup failure removes only the account it created', async () => {
  const { handler, identity, names } = deviceFixture({ exists: false, failOn: 'AdminSetUserPasswordCommand' });
  assert.equal((await handler(event('device', deviceBody))).statusCode, 503);
  assert.deepEqual(names(identity),
    ['AdminCreateUserCommand', 'AdminSetUserPasswordCommand', 'AdminDeleteUserCommand']);
});

test('device requests need a session and valid fields before touching accounts', async () => {
  const { handler, identity } = deviceFixture();
  assert.equal((await handler({ ...event('device', deviceBody), headers: {} })).statusCode, 401);
  for (const change of [{ email: 'nope' }, { deviceId: 'short' }, { password: 'weak' }, { code: '12' }]) {
    assert.equal((await handler(event('device', { ...deviceBody, ...change }))).statusCode, 400);
  }
  assert.equal(identity.length, 0);
});
