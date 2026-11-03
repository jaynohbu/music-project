import { randomBytes, createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient, AdminCreateUserCommand, AdminDisableUserCommand,
  AdminSetUserPasswordCommand, AdminDeleteUserCommand, ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

export const SESSION_SECONDS = 300;
const hash = value => createHash('sha256').update(value).digest('hex');
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({});
const secrets = new SecretsManagerClient({});

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readBody(event) {
  try {
    const text = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString() : event.body;
    if ((text?.length ?? 0) > 4096) throw new Error('Body too large');
    const body = JSON.parse(text ?? '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body');
    return body;
  } catch {
    throw new RequestError(400, 'Send a valid JSON object.');
  }
}

function emailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
    throw new RequestError(400, 'Enter a valid email address.');
  }
  return value.trim().toLowerCase();
}

const strongPassword = value => typeof value === 'string' && value.length >= 12 &&
  value.length <= 256 && /[A-Z]/.test(value) && /[a-z]/.test(value) &&
  /[0-9]/.test(value) && /[^A-Za-z0-9]/.test(value);

export function createAccountHandler({
  database = db, identity = cognito, secretStore = secrets,
  now = () => Math.floor(Date.now() / 1000),
  random = () => randomBytes(32).toString('base64url'),
} = {}) {
  const table = () => process.env.ACCOUNT_SESSIONS_TABLE;
  // A device registered without an emailed code never proved it owns the address,
  // so it loses access as soon as somebody does prove it.
  const forgetUnprovenDevices = async email => {
    const emailHash = hash(email);
    const { Items = [] } = await database.send(new QueryCommand({
      TableName: process.env.ACCOUNT_DEVICES_TABLE, ConsistentRead: true,
      KeyConditionExpression: 'emailHash = :email',
      FilterExpression: 'proven = :false',
      ExpressionAttributeValues: { ':email': emailHash, ':false': false },
    }));
    for (const { deviceHash } of Items) {
      await database.send(new DeleteCommand({
        TableName: process.env.ACCOUNT_DEVICES_TABLE, Key: { emailHash, deviceHash },
      }));
    }
  };
  return async event => {
    const reply = (statusCode, body) => ({
      statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify(body),
    });
    try {
      const action = event.rawPath?.split('/').at(-1);
      const timestamp = now();
      if (action === 'session') {
        // Bound issuance per source address in addition to API Gateway throttling.
        const ip = event.requestContext?.http?.sourceIp;
        if (!ip) throw new RequestError(400, 'Missing request source.');
        const window = Math.floor(timestamp / SESSION_SECONDS);
        try {
          await database.send(new UpdateCommand({
            TableName: table(), Key: { id: `rate:${hash(ip)}:${window}` },
            UpdateExpression: 'SET expiresAt = :ttl ADD attempts :one',
            ConditionExpression: 'attribute_not_exists(attempts) OR attempts < :limit',
            ExpressionAttributeValues: {
              ':ttl': (window + 2) * SESSION_SECONDS, ':one': 1, ':limit': 10,
            },
          }));
        } catch (error) {
          if (error.name !== 'ConditionalCheckFailedException') throw error;
          throw new RequestError(429, 'Too many sessions. Wait five minutes and try again.');
        }
        const token = random();
        const expiresAt = timestamp + SESSION_SECONDS;
        await database.send(new PutCommand({
          TableName: table(),
          Item: { id: `session:${hash(token)}`, expiresAt, attempts: 0 },
          ConditionExpression: 'attribute_not_exists(id)',
        }));
        return reply(201, { token, expiresAt: expiresAt * 1000, expiresIn: SESSION_SECONDS });
      }
      if (!['register', 'device', 'forgot-password', 'confirm-password'].includes(action)) {
        throw new RequestError(404, 'Account endpoint not found.');
      }
      const token = Object.entries(event.headers ?? {})
        .find(([key]) => key.toLowerCase() === 'x-account-session')?.[1];
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
        throw new RequestError(401, 'Temporary session missing. Restart this page.');
      }
      try {
        await database.send(new UpdateCommand({
          TableName: table(), Key: { id: `session:${hash(token)}` },
          UpdateExpression: 'ADD attempts :one',
          ConditionExpression: 'expiresAt > :now AND attempts < :limit',
          ExpressionAttributeValues: { ':one': 1, ':now': timestamp, ':limit': 5 },
        }));
      } catch (error) {
        if (error.name !== 'ConditionalCheckFailedException') throw error;
        throw new RequestError(401, 'Temporary session expired or exhausted. Restart this page.');
      }
      const body = readBody(event);
      const email = emailAddress(body.email);
      const params = { UserPoolId: process.env.USER_POOL_ID, Username: email };
      if (action === 'register') {
        const result = await secretStore.send(new GetSecretValueCommand({
          SecretId: process.env.INITIAL_PASSWORD_SECRET,
        }));
        const password = result.SecretString;
        if (typeof password !== 'string' || password.length < 12 ||
            !/[A-Z]/.test(password) || !/[a-z]/.test(password) ||
            !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
          throw new Error('Registration password secret does not meet the pool policy.');
        }
        await identity.send(new AdminCreateUserCommand({
          ...params, MessageAction: 'SUPPRESS',
          TemporaryPassword: `${random()}aA1!`,
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'email_verified', Value: 'true' },
          ],
        }));
        try {
          // Disable before installing the shared permanent password.
          await identity.send(new AdminDisableUserCommand(params));
          await identity.send(new AdminSetUserPasswordCommand({
            ...params, Password: password, Permanent: true,
          }));
        } catch (error) {
          console.error('Registration setup failed', { name: error.name });
          // Remove only the account created by this invocation, never an existing user.
          await identity.send(new AdminDeleteUserCommand(params));
          throw error;
        }
        return reply(201, {
          message: 'Registration complete. Your account is disabled until an administrator enables it.',
        });
      }
      if (action === 'device') {
        const { deviceId, password, code } = body;
        if (typeof deviceId !== 'string' || !/^[A-Za-z0-9-]{16,128}$/.test(deviceId) ||
            !strongPassword(password) ||
            (code !== undefined && (typeof code !== 'string' || !/^\d{6}$/.test(code)))) {
          throw new RequestError(400, 'Send a valid device, password and code.');
        }
        const key = { emailHash: hash(email), deviceHash: hash(deviceId) };
        const remember = proven => database.send(new PutCommand({
          TableName: process.env.ACCOUNT_DEVICES_TABLE, Item: { ...key, proven },
        }));
        // One new account per device, or each new email would reset the free usage limits.
        const { Items: linked = [] } = await database.send(new QueryCommand({
          TableName: process.env.ACCOUNT_DEVICES_TABLE, IndexName: 'ByDevice',
          KeyConditionExpression: 'deviceHash = :device',
          ExpressionAttributeValues: { ':device': key.deviceHash },
        }));
        const deviceTaken = linked.some(item => item.emailHash !== key.emailHash);
        let created = false;
        try {
          await identity.send(new AdminCreateUserCommand({
            ...params, MessageAction: 'SUPPRESS',
            TemporaryPassword: `${random()}aA1!`,
            UserAttributes: [
              { Name: 'email', Value: email },
              { Name: 'email_verified', Value: 'true' },
            ],
          }));
          created = true;
          if (deviceTaken) {
            // Remove only the account created by this invocation, never an existing user.
            await identity.send(new AdminDeleteUserCommand(params));
            return reply(409, {
              code: 'DEVICE_HAS_ACCOUNT',
              message: 'This phone already has an account. Sign in with the email you used before.',
            });
          }
          await identity.send(new AdminSetUserPasswordCommand({ ...params, Password: password, Permanent: true }));
          await remember(false);
          return reply(201, { status: 'ready' });
        } catch (error) {
          if (created) {
            console.error('Device account setup failed', { name: error.name });
            // Remove only the account created by this invocation, never an existing user.
            await identity.send(new AdminDeleteUserCommand(params));
            throw error;
          }
          if (error.name !== 'UsernameExistsException') throw error;
        }
        if (code) {
          await identity.send(new ConfirmForgotPasswordCommand({
            ClientId: process.env.USER_POOL_CLIENT_ID, Username: email,
            ConfirmationCode: code, Password: password,
          }));
          await forgetUnprovenDevices(email);
          await remember(true);
          return reply(200, { status: 'ready' });
        }
        const known = await database.send(new GetCommand({
          TableName: process.env.ACCOUNT_DEVICES_TABLE, Key: key, ConsistentRead: true,
        }));
        if (known.Item) {
          await identity.send(new AdminSetUserPasswordCommand({ ...params, Password: password, Permanent: true }));
          return reply(200, { status: 'ready' });
        }
        // The email alone must never unlock an account this device has not been used with.
        await identity.send(new ForgotPasswordCommand({
          ClientId: process.env.USER_POOL_CLIENT_ID, Username: email,
        }));
        return reply(200, { status: 'code-required' });
      }
      if (action === 'forgot-password') {
        await identity.send(new ForgotPasswordCommand({
          ClientId: process.env.USER_POOL_CLIENT_ID, Username: email,
        }));
        return reply(200, { message: 'A reset code has been sent. Check your email.' });
      }
      if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code) || !strongPassword(body.password)) {
        throw new RequestError(400, 'Enter a six-digit code and a password of 12+ characters with uppercase, lowercase, a number and a symbol.');
      }
      await identity.send(new ConfirmForgotPasswordCommand({
        ClientId: process.env.USER_POOL_CLIENT_ID, Username: email,
        ConfirmationCode: body.code, Password: body.password,
      }));
      await forgetUnprovenDevices(email);
      return reply(200, { message: 'Password updated. You can now sign in if your account is enabled.' });
    } catch (error) {
      // Never log account request bodies, session tokens, passwords, or reset codes.
      console.warn('Account request failed', { name: error.name, status: error.status });
      if (error instanceof RequestError) {
        return reply(error.status, { message: error.message, restartSession: error.status === 401 });
      }
      const failures = {
        UsernameExistsException: [409, 'This account already exists. Contact your administrator or reset your password.'],
        UserNotFoundException: [400, 'Unable to reset this account. Check your email or contact your administrator.'],
        NotAuthorizedException: [400, 'This account is unavailable. Ask your administrator to enable it.'],
        CodeMismatchException: [400, 'Incorrect reset code. Please try again.'],
        ExpiredCodeException: [400, 'The reset code expired. Request a new code.'],
        InvalidPasswordException: [400, 'The password does not meet the account policy.'],
        LimitExceededException: [429, 'Too many attempts. Wait and try again.'],
        TooManyRequestsException: [429, 'Too many requests. Wait and try again.'],
        InvalidParameterException: [400, 'Unable to process this account request. Check your details or contact your administrator.'],
      };
      const failure = failures[error.name];
      if (failure) return reply(failure[0], { message: failure[1] });
      console.error('Account service unavailable', { name: error.name });
      return reply(503, { message: 'The account service is unavailable. Please try again.' });
    }
  };
}

export const handler = createAccountHandler();
