import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand,
  AdminDeleteUserCommand, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { STEM_NAMES } from '../stem-shared.mjs';

// Explicit live runner: uses only a temporary account and synthetic audio.
process.env.AWS_REGION = 'us-west-2';
const cf = new CloudFormationClient({}), cognito = new CognitoIdentityProviderClient({});
const db = DynamoDBDocumentClient.from(new DynamoDBClient({})), s3 = new S3Client({});
const stack = await cf.send(new DescribeStacksCommand({ StackName: 'youtube-audio-library' }));
const output = name => stack.Stacks[0].Outputs.find(item => item.OutputKey === name).OutputValue;
const base = process.env.SMOKE_API_URL;
if (!base) throw new Error('Set SMOKE_API_URL explicitly to run live integration.');
const email = `accompaniment-smoke-${randomUUID()}@example.com`;
const password = `Aa1!${randomUUID()}${randomUUID()}`;
const jobId = randomUUID(), childId = randomUUID();
let userId, created = false;
const objectKeys = [];
const wav = Buffer.alloc(44 + 44100 * 4 * 3);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(176400, 28);
wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < 44100 * 3; i++) {
  const value = Math.round(Math.sin(2 * Math.PI * 440 * i / 44100) * 2000);
  wav.writeInt16LE(value, 44 + i * 4); wav.writeInt16LE(value, 46 + i * 4);
}
try {
  const account = await cognito.send(new AdminCreateUserCommand({
    UserPoolId: output('UserPoolId'), Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
  }));
  created = true;
  userId = account.User.Attributes.find(item => item.Name === 'sub').Value;
  await cognito.send(new AdminSetUserPasswordCommand({
    UserPoolId: output('UserPoolId'), Username: email, Password: password, Permanent: true,
  }));
  const auth = await cognito.send(new InitiateAuthCommand({
    ClientId: output('UserPoolClientId'), AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, {
      method, headers: { Authorization: `Bearer ${auth.AuthenticationResult.IdToken}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    assert.ok(response.ok, `HTTP ${response.status} ${route}: ${result.message}`);
    return result;
  };
  const stems = {};
  for (const name of STEM_NAMES) {
    const key = `users/${userId}/stems/${jobId}/${name}.wav`;
    objectKeys.push(key);
    await s3.send(new PutObjectCommand({ Bucket: output('AudioBucketName'), Key: key, Body: wav, ContentType: 'audio/wav' }));
    stems[name] = { key, bytes: wav.length };
  }
  await db.send(new PutCommand({ TableName: output('JobsTableName'), Item: {
    userId, jobId, type: 'stems', status: 'completed', duration: 3, title: 'Temporary accompaniment smoke',
    createdAt: new Date().toISOString(), stems,
  } }));
  const settings = { requestId: childId, instrument: 'piano', style: 'arpeggio', tempo: 120,
    sources: ['piano', 'bass'], chords: [{ start: 0, end: 3, chord: 'C' }] };
  const route = `/stems/jobs/${jobId}/accompaniments`;
  const first = await request(route, 'POST', settings);
  assert.equal(first.accompaniment.id, childId);
  const retry = await request(route, 'POST', settings);
  assert.equal(retry.accompaniment.id, childId);
  objectKeys.push(`generated-inputs/${userId}/${childId}/audio.wav`,
    `users/${userId}/accompaniments/${jobId}/${childId}.wav`);
  const upload = async bytes => {
    const form = new FormData();
    for (const [key, value] of Object.entries(retry.upload.fields)) form.append(key, value);
    form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'accompaniment.wav');
    return fetch(retry.upload.url, { method: 'POST', body: form });
  };
  assert.equal((await upload(Buffer.concat([wav, Buffer.alloc(1)]))).ok, false, 'Exact-size policy must reject one extra byte.');
  assert.ok((await upload(wav)).ok);
  const complete = `${route}/${childId}/complete`;
  const finished = await request(complete, 'POST', {});
  assert.equal(finished.accompaniment.id, childId);
  const audio = await fetch(finished.accompaniment.playUrl);
  assert.ok(audio.ok);
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), wav);
  // Reusing the still-valid upload cannot overwrite the finalized output.
  assert.ok((await upload(Buffer.alloc(wav.length))).ok);
  const again = await request(complete, 'POST', {});
  assert.deepEqual(Buffer.from(await (await fetch(again.accompaniment.playUrl)).arrayBuffer()), wav);
  const saved = (await request(`/stems/jobs/${jobId}`)).job;
  assert.equal(saved.generatedStems.length, 1);
  assert.equal(saved.generatedStems[0].instrument, 'piano');
  const list = await request('/jobs');
  assert.equal(list.jobs.length, 1);
  assert.equal(list.jobs[0].generatedStems.length, 1);
  const child = (await db.send(new GetCommand({ TableName: output('JobsTableName'), Key: { userId, jobId: childId } }))).Item;
  assert.equal(child.expiresAt, undefined);
  const originalUrl = saved.stems.other.playUrl;
  assert.deepEqual(await request(`${route}/${childId}`, 'DELETE'), { deleted: true });
  assert.deepEqual(await request(`${route}/${childId}`, 'DELETE'), { deleted: true });
  const remaining = (await request(`/stems/jobs/${jobId}`)).job;
  assert.equal(remaining.generatedStems.length, 0);
  assert.equal((await fetch(finished.accompaniment.playUrl)).ok, false, 'Deleted audio must be gone from S3.');
  assert.ok((await fetch(originalUrl)).ok, 'Original stems must survive deleting a generated stem.');
  console.log('PASS: authenticated save, exact-size policy, validated WAV, immutable saved output, retry, persistence, signed reload and delete.');
} finally {
  for (const key of objectKeys) await s3.send(new DeleteObjectCommand({ Bucket: output('AudioBucketName'), Key: key }));
  if (userId) {
    for (const id of [jobId, childId]) await db.send(new DeleteCommand({
      TableName: output('JobsTableName'), Key: { userId, jobId: id },
    }));
  }
  if (created) await cognito.send(new AdminDeleteUserCommand({ UserPoolId: output('UserPoolId'), Username: email }));
}
