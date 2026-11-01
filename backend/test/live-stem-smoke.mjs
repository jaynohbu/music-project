import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand,
  AdminDeleteUserCommand, InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { STEM_NAMES } from '../stem-shared.mjs';

// Explicit integration runner: creates only synthetic audio and a temporary account.
process.env.AWS_REGION = 'us-west-2';
const cf = new CloudFormationClient({});
const cognito = new CognitoIdentityProviderClient({});
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const stack = await cf.send(new DescribeStacksCommand({ StackName: 'youtube-audio-library' }));
const output = name => {
  const value = stack.Stacks[0].Outputs.find(item => item.OutputKey === name)?.OutputValue;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const base = process.env.SMOKE_API_URL ?? 'http://127.0.0.1:3001/api';
const duration = Number(process.env.SMOKE_DURATION_SECONDS ?? 3);
assert.ok(Number.isFinite(duration) && duration > 0 && duration <= 420);
const email = `stem-smoke-${randomUUID()}@example.com`;
const password = `Aa1!${randomUUID()}${randomUUID()}`;
let created = false;
let userId;
let job;
let directory;
try {
  const user = await cognito.send(new AdminCreateUserCommand({
    UserPoolId: output('UserPoolId'), Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
  }));
  created = true;
  userId = user.User.Attributes.find(item => item.Name === 'sub').Value;
  await cognito.send(new AdminSetUserPasswordCommand({
    UserPoolId: output('UserPoolId'), Username: email, Password: password, Permanent: true,
  }));
  const auth = await cognito.send(new InitiateAuthCommand({
    ClientId: output('UserPoolClientId'), AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  const token = auth.AuthenticationResult.IdToken;
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(`${base}${route}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    assert.ok(response.ok, `${route}: HTTP ${response.status}: ${result.message}`);
    return result;
  };
  assert.equal((await fetch(`${base}/stems/uploads`, { method: 'POST', body: '{}' })).status, 401);
  directory = await mkdtemp(path.join(tmpdir(), 'stem-live-smoke-'));
  const source = path.join(directory, 'synthetic.flac');
  await promisify(execFile)(process.env.LOCAL_FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg', [
    '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
    `sine=frequency=440:duration=${duration}`, '-ac', '2', '-ar', '44100', source,
  ]);
  const bytes = await readFile(source);
  const upload = await request('/stems/uploads', 'POST', {
    fileName: 'synthetic.flac', bytes: bytes.length, title: 'Temporary stem integration test',
  });
  job = upload.job;
  const form = new FormData();
  for (const [name, value] of Object.entries(upload.upload.fields)) form.append(name, value);
  form.append('file', new Blob([bytes]), 'synthetic.flac');
  const uploaded = await fetch(upload.upload.url, { method: 'POST', body: form });
  assert.ok(uploaded.ok, `S3 POST failed: ${uploaded.status}`);
  await request(`/stems/jobs/${job.jobId}/complete`, 'POST', {});
  const deadline = Date.now() + 10 * 60000;
  while (Date.now() < deadline) {
    const result = await request(`/stems/jobs/${job.jobId}`);
    if (result.job.status === 'failed') throw new Error(result.job.error);
    if (result.job.status === 'completed') {
      let length;
      for (const name of STEM_NAMES) {
        const audio = await fetch(result.job.stems[name].playUrl);
        assert.ok(audio.ok);
        const data = Buffer.from(await audio.arrayBuffer());
        assert.equal(data.toString('ascii', 0, 4), 'RIFF');
        assert.equal(data.toString('ascii', 8, 12), 'WAVE');
        if (length !== undefined) assert.equal(data.length, length);
        length = data.length;
      }
      assert.equal(result.job.duration, duration);
      const repeat = await request(`/stems/jobs/${job.jobId}/complete`, 'POST', {});
      assert.equal(repeat.job.status, 'completed');
      const list = await request('/jobs');
      assert.ok(list.jobs.some(item => item.jobId === job.jobId && Object.keys(item.stems).length === 6));
      console.log(`PASS ${base}: authenticated direct S3 upload, real Demucs, six aligned WAVs, signed playback, list and idempotent completion.`);
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 4000));
  }
  if (Date.now() >= deadline) throw new Error('Integration test timed out.');
} finally {
  if (job) {
    for (const key of [
      job.inputKey, ...STEM_NAMES.map(name => `users/${userId}/stems/${job.jobId}/${name}.wav`),
    ]) {
      await s3.send(new DeleteObjectCommand({ Bucket: output('AudioBucketName'), Key: key }));
    }
    await db.send(new DeleteCommand({ TableName: output('JobsTableName'), Key: { userId, jobId: job.jobId } }));
  }
  if (created) await cognito.send(new AdminDeleteUserCommand({ UserPoolId: output('UserPoolId'), Username: email }));
  if (directory) await rm(directory, { recursive: true, force: true });
}
