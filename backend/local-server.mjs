import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { CloudFormationClient, DescribeStacksCommand, DescribeStackResourceCommand } from '@aws-sdk/client-cloudformation';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { createHandler } from './api.mjs';
import { createAccountHandler } from './accounts.mjs';
import { createStemHandler } from './stem-api.mjs';
import { createStemWorker } from './stem-worker.mjs';
import { createRestoreWorker, runStemTask } from './stem-restore.mjs';
import { createHarmonyWorker, createLyricsWorker } from './stem-analysis.mjs';
import { createSceneHandler, MAX_SCENE_BODY_BYTES } from './scene-api.mjs';

const execute = promisify(execFile);

export function localQueue(worker, capacity = 2) {
  const running = new Set();
  return {
    running,
    async send(command) {
      if (running.size >= capacity) throw new Error('Local processing capacity reached. Try again shortly.');
      const job = JSON.parse(Buffer.from(command.input.Payload).toString());
      const task = Promise.resolve().then(() => worker(job))
        .catch(error => console.error('Local worker failed to record job outcome', {
          jobId: job.jobId, name: error.name,
        }))
        .finally(() => running.delete(task));
      running.add(task);
      return { StatusCode: 202 };
    },
  };
}

export function createLocalServer({ api, accounts, stems, scenes, verify }) {
  return createServer(async (request, response) => {
    const origin = request.headers.origin;
    const reply = (status, message) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ message }));
    };
    try {
      if (request.method === 'OPTIONS' ||
          (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
        reply(403, 'Cross-origin request is not allowed.');
        return;
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok', processing: 'local', storage: 'aws' }));
        return;
      }
      const accountRoutes = ['session', 'register', 'device', 'forgot-password', 'confirm-password'];
      const isAccount = accountRoutes.some(action => url.pathname === `/api/accounts/${action}`);
      const isJobs = url.pathname === '/api/jobs';
      const isRestorations = /^\/api\/stems\/jobs\/[0-9a-f-]{36}\/restorations$/.test(url.pathname);
      const isRestoration = /^\/api\/stems\/jobs\/[0-9a-f-]{36}\/restorations\/[0-9a-f-]{36}$/.test(url.pathname);
      const isAnalysis = /^\/api\/stems\/jobs\/[0-9a-f-]{36}\/(lyrics|harmony)$/.test(url.pathname);
      const isSong = /^\/api\/stems\/jobs\/[0-9a-f-]{36}$/.test(url.pathname);
      const isMetadata = isSong && request.method === 'PATCH';
      const isSongDelete = isSong && request.method === 'DELETE';
      const isSceneList = url.pathname === '/api/scenes';
      const isScene = /^\/api\/scenes\/[0-9a-f-]{36}$/.test(url.pathname);
      const isScenes = isSceneList || isScene;
      const isStems = url.pathname === '/api/stems/uploads' || isRestorations || isRestoration || isAnalysis ||
        /^\/api\/stems\/jobs\/[0-9a-f-]{36}(\/complete)?$/.test(url.pathname);
      if (!isAccount && !isJobs && !isStems && !isScenes) { reply(404, 'Endpoint not found.'); return; }
      if ((isAccount && request.method !== 'POST') ||
          (isJobs && request.method !== 'GET') ||
          (isSceneList && !['GET', 'POST'].includes(request.method)) ||
          (isScene && !['GET', 'PATCH', 'DELETE'].includes(request.method)) ||
          (isRestoration ? request.method !== 'DELETE'
            : isRestorations || isAnalysis ? request.method !== 'POST'
              : isStems && !isMetadata && !isSongDelete && !['GET', 'POST'].includes(request.method))) {
        reply(405, 'Method not allowed.');
        return;
      }
      let claims;
      if (isJobs || isStems || isScenes) {
        const authorization = request.headers.authorization;
        if (!authorization?.startsWith('Bearer ')) { reply(401, 'Sign in to continue.'); return; }
        try {
          claims = await verify(authorization.slice(7));
        } catch (error) {
          console.warn('Local JWT verification failed', { name: error.name });
          reply(401, 'Invalid or expired Cognito session.');
          return;
        }
      }
      const chunks = [];
      let length = 0;
      const limit = isScenes ? MAX_SCENE_BODY_BYTES : 4096;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > limit) { reply(413, 'Request body is too large.'); return; }
        chunks.push(chunk);
      }
      const event = {
        rawPath: url.pathname, body: Buffer.concat(chunks).toString(),
        headers: request.headers, queryStringParameters: Object.fromEntries(url.searchParams),
        requestContext: {
          http: { method: request.method, sourceIp: request.socket.remoteAddress },
          ...(claims ? { authorizer: { jwt: { claims } } } : {}),
        },
      };
      const result = await (isAccount ? accounts : isScenes ? scenes : isStems ? stems : api)(event);
      response.writeHead(result.statusCode, result.headers);
      response.end(result.body);
    } catch (error) {
      console.error('Local API request failed', { name: error.name });
      if (!response.headersSent) reply(500, 'Local API request failed.');
      else response.end();
    }
  });
}

async function main() {
  process.env.AWS_REGION = 'us-west-2';
  const stackName = process.env.LOCAL_STACK_NAME ?? 'youtube-audio-library';
  const cloudformation = new CloudFormationClient({ region: 'us-west-2' });
  const stack = await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }));
  const output = key => {
    const value = stack.Stacks?.[0]?.Outputs?.find(item => item.OutputKey === key)?.OutputValue;
    if (!value) throw new Error(`Missing stack output ${key}`);
    return value;
  };
  process.env.TABLE_NAME = output('JobsTableName');
  process.env.BUCKET_NAME = output('AudioBucketName');
  process.env.USER_POOL_ID = output('UserPoolId');
  process.env.USER_POOL_CLIENT_ID = output('UserPoolClientId');
  process.env.INITIAL_PASSWORD_SECRET ??= 'youtube-audio-library/registration-password';
  const sessions = await cloudformation.send(new DescribeStackResourceCommand({
    StackName: stackName, LogicalResourceId: 'AccountSessions',
  }));
  process.env.ACCOUNT_SESSIONS_TABLE = sessions.StackResourceDetail?.PhysicalResourceId;
  if (!process.env.ACCOUNT_SESSIONS_TABLE) throw new Error('AccountSessions table not found.');
  const devices = await cloudformation.send(new DescribeStackResourceCommand({
    StackName: stackName, LogicalResourceId: 'AccountDevices',
  }));
  process.env.ACCOUNT_DEVICES_TABLE = devices.StackResourceDetail?.PhysicalResourceId;
  if (!process.env.ACCOUNT_DEVICES_TABLE) throw new Error('AccountDevices table not found.');
  const ffmpegPath = process.env.LOCAL_FFMPEG_PATH ?? (await execute('which', ['ffmpeg'])).stdout.trim();
  await execute(ffmpegPath, ['-version']);
  const verifier = CognitoJwtVerifier.create({
    userPoolId: process.env.USER_POOL_ID, tokenUse: 'id', clientId: process.env.USER_POOL_CLIENT_ID,
  });
  const stemPython = process.env.STEM_PYTHON_PATH ??
    fileURLToPath(new URL('../.venv-stems/bin/python', import.meta.url));
  const stemQueue = localQueue(runStemTask({
    separate: createStemWorker({ pythonPath: stemPython, ffmpegPath }),
    restore: createRestoreWorker({ pythonPath: stemPython }),
    recognize: createLyricsWorker({ pythonPath: stemPython }),
    harmonize: createHarmonyWorker({ pythonPath: stemPython }),
  }), 1);
  const acceptedStemJobs = new Set();
  const stemOrchestrator = {
    async send(command) {
      const job = JSON.parse(command.input.input);
      if (acceptedStemJobs.has(job.jobId)) return {};
      await stemQueue.send({ input: { Payload: Buffer.from(JSON.stringify(job)) } });
      acceptedStemJobs.add(job.jobId);
      return {};
    },
  };
  const server = createLocalServer({
    api: createHandler(), accounts: createAccountHandler(),
    stems: createStemHandler({ orchestrator: stemOrchestrator }), scenes: createSceneHandler(),
    verify: token => verifier.verify(token),
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  const port = Number(process.env.LOCAL_API_PORT ?? 3001);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`Local API http://127.0.0.1:${port}; processing=local, Cognito/DynamoDB/S3=AWS (${stackName})`);
  console.log(`Stem worker: ${stemPython}; device=${process.env.STEM_DEVICE ?? 'cpu'}`);
  const stop = () => {
    console.log('Stopping local API; allowing active jobs to finish.');
    server.close(async () => {
      await Promise.allSettled(stemQueue.running);
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    console.error('Local API startup failed', error.message);
    process.exitCode = 1;
  });
}
