import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand,
  AdminDeleteUserCommand, InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { STEM_NAMES } from '../stem-shared.mjs';

// Explicit live test: temporary account and synthetic fixtures, no audio processing.
const base = process.env.SMOKE_API_URL;
if (!base) throw new Error('Set SMOKE_API_URL explicitly before running this live test.');
const config = { region: 'us-west-2' };
const cognito = new CognitoIdentityProviderClient(config);
const database = DynamoDBDocumentClient.from(new DynamoDBClient(config));
const storage = new S3Client(config);
const stack = await new CloudFormationClient(config).send(new DescribeStacksCommand({
  StackName: 'youtube-audio-library',
}));
const output = key => stack.Stacks[0].Outputs.find(item => item.OutputKey === key).OutputValue;
const table = output('JobsTableName'), bucket = output('AudioBucketName');
const email = `sorituh-smoke-${randomUUID()}@example.com`;
const password = `Aa1!${randomUUID()}${randomUUID()}`;
const parentId = randomUUID(), legacyId = randomUUID(), foreignId = randomUUID();
const records = [], objects = [];
const sceneIds = [];
let request;
let userId, accountCreated = false;
try {
  const account = await cognito.send(new AdminCreateUserCommand({
    UserPoolId: output('UserPoolId'), Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
  }));
  accountCreated = true;
  userId = account.User.Attributes.find(item => item.Name === 'sub').Value;
  await cognito.send(new AdminSetUserPasswordCommand({
    UserPoolId: output('UserPoolId'), Username: email, Password: password, Permanent: true,
  }));
  const auth = await cognito.send(new InitiateAuthCommand({
    ClientId: output('UserPoolClientId'), AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  request = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, {
      method, headers: {
        Authorization: `Bearer ${auth.AuthenticationResult.IdToken}`, 'Content-Type': 'application/json',
      }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const put = async item => {
    records.push({ userId: item.userId, jobId: item.jobId });
    await database.send(new PutCommand({ TableName: table, Item: item }));
  };
  const mediaKey = `users/${userId}/stems/${parentId}/vocals.wav`;
  objects.push(mediaKey);
  await storage.send(new PutObjectCommand({ Bucket: bucket, Key: mediaKey, Body: Buffer.alloc(100), ContentType: 'audio/wav' }));
  await put({
    userId, jobId: parentId, type: 'stems', status: 'completed', title: 'Temporary smoke',
    createdAt: new Date().toISOString(), duration: 1,
    stems: Object.fromEntries(STEM_NAMES.map(name => [name, { key: mediaKey }])),
  });
  const legacyKey = `users/${userId}/${legacyId}.wav`;
  objects.push(legacyKey);
  await storage.send(new PutObjectCommand({ Bucket: bucket, Key: legacyKey, Body: Buffer.alloc(100), ContentType: 'audio/wav' }));
  await put({ userId, jobId: legacyId, status: 'completed', key: legacyKey, createdAt: new Date().toISOString() });
  const foreignUser = `smoke-foreign-${randomUUID()}`;
  await put({ userId: foreignUser, jobId: foreignId, type: 'stems', status: 'completed', title: 'Untouched' });

  assert.equal((await request('/jobs', 'POST', { url: 'https://youtu.be/abcdefghijk' })).status, 404);
  const upload = await request('/stems/uploads', 'POST', { fileName: 'fixture.wav', bytes: 100, title: 'Direct upload still allowed' });
  assert.equal(upload.status, 201);
  records.push({ userId, jobId: upload.body.job.jobId });
  assert.equal(upload.body.job.userId, userId);
  const changed = await request(`/stems/jobs/${parentId}`, 'PATCH', { title: 'Saved title', author: 'Saved author' });
  assert.equal(changed.status, 200);
  const reloaded = await request(`/stems/jobs/${parentId}`);
  assert.equal(reloaded.body.job.title, 'Saved title');
  assert.equal(reloaded.body.job.author, 'Saved author');
  assert.equal((await request(`/stems/jobs/${foreignId}`, 'PATCH', { title: 'Attack', author: '' })).status, 404);
  const untouched = await database.send(new GetCommand({ TableName: table, Key: { userId: foreignUser, jobId: foreignId } }));
  assert.equal(untouched.Item.title, 'Untouched');
  const library = await request('/jobs');
  assert.equal(library.status, 200);
  assert.ok(library.body.jobs.every(job => job.type === 'stems'));

  const stemLink = await getSignedUrl(storage, new GetObjectCommand({ Bucket: bucket, Key: mediaKey }), { expiresIn: 120 });
  assert.equal((await fetch(stemLink)).status, 200, 'Original uploaded stems remain accessible.');
  const created = await request('/scenes', 'POST', { name: 'Temporary rehearsal' });
  assert.equal(created.status, 201);
  sceneIds.push(created.body.scene.id);
  const scenePath = `/scenes/${created.body.scene.id}`;
  const settings = {
    masterVolume: 52, sectionStart: 0, sectionEnd: 1, loop: false,
    tracks: Object.fromEntries(STEM_NAMES.map(name => [name, {
      volume: 39, preGain: 100, compression: 0, distortion: 0, bass: 0, mid: 0,
      treble: 0, pan: 0, reverb: 0, muted: false, solo: false, bypassed: false, useCleaned: false,
    }])),
  };
  const entries = [
    { id: randomUUID(), jobId: parentId, title: 'Scene-only name', settings },
    { id: randomUUID(), jobId: parentId },
  ];
  const saved = await request(scenePath, 'PATCH', { revision: created.body.scene.revision, entries });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual((await request(scenePath)).body.scene.entries, entries);
  assert.equal((await request(`/stems/jobs/${parentId}`)).body.job.title, 'Saved title');
  assert.equal((await request(scenePath, 'PATCH', { revision: created.body.scene.revision, name: 'Stale' })).status, 409);
  assert.equal((await request(`/scenes/${randomUUID()}`)).status, 404);
  assert.ok((await request('/jobs')).body.jobs.every(job => job.type === 'stems'));
  const deleted = await request(`/stems/jobs/${parentId}`, 'DELETE');
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal((await request(`/stems/jobs/${parentId}`)).status, 404);
  assert.deepEqual((await request(scenePath)).body.scene.entries, []);
  assert.equal((await fetch(stemLink)).status, 404, 'Deleting the source removes its stored stem audio.');
  assert.equal((await request(scenePath, 'DELETE')).status, 200);
  assert.equal((await request(scenePath)).status, 404);
  console.log('PASS: no job-creation route, split-only library, upload/metadata ownership, scenes CRUD/settings/isolation/stale revision, song deletion, scene-reference and audio cleanup.');
} finally {
  const cleanup = await Promise.allSettled([
    ...sceneIds.map(async id => {
      const result = await request(`/scenes/${id}`, 'DELETE');
      if (![200, 404].includes(result.status)) throw new Error(`Scene smoke cleanup failed: ${result.status}`);
    }),
    ...objects.map(Key => storage.send(new DeleteObjectCommand({ Bucket: bucket, Key }))),
    ...records.map(Key => database.send(new DeleteCommand({ TableName: table, Key }))),
    ...(accountCreated ? [cognito.send(new AdminDeleteUserCommand({ UserPoolId: output('UserPoolId'), Username: email }))] : []),
  ]);
  const failures = cleanup.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Temporary smoke resource cleanup failed.');
}
