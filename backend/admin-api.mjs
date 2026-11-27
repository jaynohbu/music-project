import { createHmac } from 'node:crypto';
import {
  AdminDisableUserCommand, AdminEnableUserCommand, AdminInitiateAuthCommand, AdminListGroupsForUserCommand,
  AdminRespondToAuthChallengeCommand, AdminUserGlobalSignOutCommand, CognitoIdentityProviderClient, ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { visibleJob } from './shared.mjs';
import { LIMITS, usageMonth } from './stem-usage.mjs';

// The master admin: a user in the pool's `admins` group, signed in on the website like anyone else.
// It lists users with their plan, songs, storage and time, enables or disables them, changes their plan,
// and can open the site as one of them (docs/mobile-app-design.md, Admin).
export const ADMIN_GROUP = 'admins';
// Each call adds at most this much time, so a client cannot inflate a day in one request.
export const MOST_SECONDS = 120;
const DAYS_SHOWN = 7;
const MOST_USERS = 1000;

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const identity = new CognitoIdentityProviderClient({});
const secrets = new SecretsManagerClient({});

export const activityDay = (date = new Date()) => date.toISOString().slice(0, 10);

// HTTP API passes the groups claim as a string such as "[admins]".
export function groupsOf(claims) {
  const value = claims?.['cognito:groups'];
  if (Array.isArray(value)) return value;
  return typeof value === 'string' ? value.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean) : [];
}

// Tokens from the impersonation client belong to the user being viewed, never to an admin.
export const isAdmin = claims => groupsOf(claims).includes(ADMIN_GROUP) && claims.aud === process.env.USER_POOL_CLIENT_ID;
export const isImpersonated = claims => !!process.env.IMPERSONATION_CLIENT_ID && claims?.aud === process.env.IMPERSONATION_CLIENT_ID;

// Plan, songs, storage, this month's splits and time per day, from the user's records in the jobs table.
export function summarize(items, now = new Date()) {
  const today = activityDay(now);
  const since = activityDay(new Date(now.getTime() - (DAYS_SHOWN - 1) * 86400000));
  let songs = 0, bytes = 0, lastActive = null;
  const week = { open: 0, play: 0 }, day = { open: 0, play: 0 };
  let plan = 'free', splits = 0;
  for (const item of items) {
    if (item.jobId === 'plan') { if (LIMITS[item.plan]) plan = item.plan; continue; }
    if (item.jobId === `usage:${usageMonth(now)}`) { splits = item.splits ?? 0; continue; }
    if (item.jobId?.startsWith('activity:')) {
      const date = item.jobId.slice('activity:'.length);
      if (!lastActive || date > lastActive) lastActive = date;
      if (date >= since) { week.open += item.open ?? 0; week.play += item.play ?? 0; }
      if (date === today) { day.open = item.open ?? 0; day.play = item.play ?? 0; }
      continue;
    }
    if (item.type === 'stems') {
      if (visibleJob(item, now.getTime()).status !== 'failed') songs++;
      for (const stem of Object.values(item.stems ?? {})) bytes += (stem.bytes ?? 0) + (stem.playBytes ?? 0);
    } else if ((item.type === 'restoration' || item.type === 'rendering') && item.status === 'completed') {
      bytes += (item.bytes ?? 0) + (item.playBytes ?? 0);
    }
  }
  return {
    plan, songs, songLimit: LIMITS[plan].songs, splits, splitLimit: LIMITS[plan].splits, bytes,
    today: day, week, lastActive,
  };
}

let secret;
async function challengeSecret(store) {
  secret ??= (await store.send(new GetSecretValueCommand({ SecretId: process.env.IMPERSONATION_SECRET }))).SecretString;
  return secret;
}
export const challengeAnswer = (key, nonce, username) => createHmac('sha256', key).update(`${nonce}:${username}`).digest('hex');

export function createHandler({ database = db, cognito = identity, store = secrets, clock = () => new Date() } = {}) {
  const reply = (statusCode, body) => ({
    statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body),
  });
  const pool = () => process.env.USER_POOL_ID;

  async function allItems(userId) {
    const items = [];
    let start;
    do {
      const page = await database.send(new QueryCommand({
        TableName: process.env.TABLE_NAME, KeyConditionExpression: 'userId = :userId', ExclusiveStartKey: start,
        ExpressionAttributeValues: { ':userId': userId },
      }));
      items.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start);
    return items;
  }

  const attribute = (user, name) => user.Attributes?.find(item => item.Name === name)?.Value;
  async function findUser(sub) {
    const found = await cognito.send(new ListUsersCommand({ UserPoolId: pool(), Filter: `sub = "${sub}"`, Limit: 1 }));
    return found.Users?.[0];
  }
  async function adminOf(username) {
    const groups = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: pool(), Username: username }));
    return (groups.Groups ?? []).some(group => group.GroupName === ADMIN_GROUP);
  }

  async function listUsers() {
    const users = [];
    let token;
    do {
      const page = await cognito.send(new ListUsersCommand({ UserPoolId: pool(), Limit: 60, PaginationToken: token }));
      users.push(...(page.Users ?? []));
      token = page.PaginationToken;
    } while (token && users.length < MOST_USERS);
    const now = clock();
    return Promise.all(users.map(async user => {
      const id = attribute(user, 'sub');
      return {
        id, email: attribute(user, 'email') ?? user.Username, enabled: user.Enabled !== false, status: user.UserStatus,
        createdAt: user.UserCreateDate, ...summarize(await allItems(id), now),
      };
    }));
  }

  return async event => {
    const claims = event.requestContext?.authorizer?.jwt?.claims;
    const userId = claims?.sub;
    if (!userId) return reply(401, { message: 'Sign in to continue.' });
    const method = event.requestContext.http.method;
    const route = event.rawPath ?? '';
    try {
      // Time spent in the app or on the website, for every signed-in user except an admin viewing someone.
      if (method === 'POST' && route === '/api/activity') {
        if (isImpersonated(claims)) return reply(202, { recorded: false });
        const body = JSON.parse(event.body ?? '{}');
        const seconds = name => Number.isInteger(body[name]) && body[name] >= 0 && body[name] <= MOST_SECONDS ? body[name] : null;
        const open = seconds('open'), play = seconds('play');
        if (open === null || play === null) return reply(400, { message: `Send open and play as whole seconds from 0 to ${MOST_SECONDS}.` });
        await database.send(new UpdateCommand({
          TableName: process.env.TABLE_NAME, Key: { userId, jobId: `activity:${activityDay(clock())}` },
          UpdateExpression: 'ADD #open :open, #play :play',
          ExpressionAttributeNames: { '#open': 'open', '#play': 'play' },
          ExpressionAttributeValues: { ':open': open, ':play': play },
        }));
        return reply(202, { recorded: true });
      }
      if (!route.startsWith('/api/admin/')) return reply(404, { message: 'Not found.' });
      if (!isAdmin(claims)) return reply(403, { message: 'Only an admin can open this page.' });
      if (method === 'GET' && route === '/api/admin/users') return reply(200, { users: await listUsers() });

      const match = /^\/api\/admin\/users\/([0-9a-f-]{36})\/(enabled|plan|session)$/.exec(route);
      if (!match || method !== 'POST') return reply(404, { message: 'Not found.' });
      const [, id, action] = match;
      const user = await findUser(id);
      if (!user) return reply(404, { message: 'User not found.' });
      const target = { UserPoolId: pool(), Username: user.Username };
      const body = JSON.parse(event.body ?? '{}');

      if (action === 'enabled') {
        if (typeof body.enabled !== 'boolean') return reply(400, { message: 'Send enabled as true or false.' });
        if (id === userId) return reply(409, { message: 'You cannot disable your own account.' });
        if (body.enabled) await cognito.send(new AdminEnableUserCommand(target));
        else {
          await cognito.send(new AdminDisableUserCommand(target));
          // A disabled user is also signed out everywhere, so their refresh tokens stop working.
          await cognito.send(new AdminUserGlobalSignOutCommand(target));
        }
        console.log(JSON.stringify({ audit: 'admin.enabled', admin: userId, user: id, enabled: body.enabled }));
        return reply(200, { id, enabled: body.enabled });
      }
      if (action === 'plan') {
        if (!LIMITS[body.plan]) return reply(400, { message: `Choose ${Object.keys(LIMITS).join(' or ')}.` });
        // No record means free, as stem-usage.mjs reads it.
        if (body.plan === 'free') {
          await database.send(new DeleteCommand({ TableName: process.env.TABLE_NAME, Key: { userId: id, jobId: 'plan' } }));
        } else {
          await database.send(new PutCommand({ TableName: process.env.TABLE_NAME, Item: { userId: id, jobId: 'plan', plan: body.plan } }));
        }
        console.log(JSON.stringify({ audit: 'admin.plan', admin: userId, user: id, plan: body.plan }));
        return reply(200, { id, plan: body.plan });
      }
      // Session: the user's own tokens, from a server-only client whose challenge only this function can answer.
      if (!user.Enabled) return reply(409, { message: 'Enable this user before opening their account.' });
      if (await adminOf(user.Username)) return reply(409, { message: 'Admin accounts cannot be opened this way.' });
      const started = await cognito.send(new AdminInitiateAuthCommand({
        UserPoolId: pool(), ClientId: process.env.IMPERSONATION_CLIENT_ID, AuthFlow: 'CUSTOM_AUTH',
        AuthParameters: { USERNAME: user.Username },
      }));
      const nonce = started.ChallengeParameters?.nonce;
      if (started.ChallengeName !== 'CUSTOM_CHALLENGE' || !nonce) throw new Error('Unexpected challenge.');
      const done = await cognito.send(new AdminRespondToAuthChallengeCommand({
        UserPoolId: pool(), ClientId: process.env.IMPERSONATION_CLIENT_ID, ChallengeName: 'CUSTOM_CHALLENGE',
        Session: started.Session,
        ChallengeResponses: { USERNAME: user.Username, ANSWER: challengeAnswer(await challengeSecret(store), nonce, user.Username) },
      }));
      const tokens = done.AuthenticationResult;
      if (!tokens?.IdToken) throw new Error('No tokens.');
      console.log(JSON.stringify({ audit: 'admin.session', admin: userId, user: id }));
      return reply(200, {
        email: attribute(user, 'email') ?? user.Username,
        session: { idToken: tokens.IdToken, accessToken: tokens.AccessToken, expiresIn: tokens.ExpiresIn },
      });
    } catch (error) {
      if (error instanceof SyntaxError) return reply(400, { message: 'Send a JSON body.' });
      console.error('Admin request failed', { name: error.name, message: error.message });
      return reply(500, { message: 'The admin service is unavailable. Please try again.' });
    }
  };
}

export const handler = createHandler();
