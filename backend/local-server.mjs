import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { CloudFormationClient, DescribeStacksCommand, DescribeStackResourceCommand } from '@aws-sdk/client-cloudformation';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { createHandler } from './api.mjs';
import { createWorker } from './worker.mjs';
import { createAccountHandler } from './accounts.mjs';
import { createStemHandler } from './stem-api.mjs';
import { createStemWorker } from './stem-worker.mjs';

const execute = promisify(execFile);

export function localQueue(worker, capacity = 2) {
  const running = new Set();
  return {
    running,
    async send(command) {
      if (running.size >= capacity) throw new Error('Local conversion capacity reached. Try again shortly.');
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

export function createLocalServer({ api, accounts, stems, verify }) {
  return createServer(async (request, response) => {
    const reply = (status, message) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ message }));
    };
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok', conversion: 'local', storage: 'aws' }));
        return;
      }
      const accountRoutes = ['session', 'register', 'forgot-password', 'confirm-password'];
      const isAccount = accountRoutes.some(action => url.pathname === `/api/accounts/${action}`);
      const isJobs = url.pathname === '/api/jobs';
      const isAccompaniment =
        /^\/api\/stems\/jobs\/[0-9a-f-]{36}\/accompaniments(\/[0-9a-f-]{36}(\/complete)?)?$/.test(url.pathname);
      const isGeneratedStem = /^\/api\/stems\/jobs\/[0-9a-f-]{36}\/accompaniments\/[0-9a-f-]{36}$/.test(url.pathname);
      const isStems = url.pathname === '/api/stems/uploads' || isAccompaniment ||
        /^\/api\/stems\/jobs\/[0-9a-f-]{36}(\/complete)?$/.test(url.pathname);
      if (!isAccount && !isJobs && !isStems) { reply(404, 'Endpoint not found.'); return; }
      if ((isAccount && request.method !== 'POST') ||
          (isGeneratedStem ? request.method !== 'DELETE'
            : (isJobs || isStems) && !['GET', 'POST'].includes(request.method))) {
        reply(405, 'Method not allowed.');
        return;
      }
      let claims;
      if (isJobs || isStems) {
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
      for await (const chunk of request) {
        length += chunk.length;
        // Chord timelines (up to 500 entries) need more room than other JSON requests.
        if (length > (isAccompaniment ? 65536 : 4096)) { reply(413, 'Request body is too large.'); return; }
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
      const result = await (isAccount ? accounts : isStems ? stems : api)(event);
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
  const projectDownloader = fileURLToPath(new URL('../.venv-download/bin/yt-dlp', import.meta.url));
  const downloaderPath = process.env.LOCAL_YTDLP_PATH ??
    (existsSync(projectDownloader) ? projectDownloader : 'yt-dlp');
  const help = await execute(downloaderPath, ['--help']);
  if (!help.stdout.includes('--js-runtimes')) {
    throw new Error('Local yt-dlp is too old. Set LOCAL_YTDLP_PATH to a current executable supporting --js-runtimes.');
  }
  const downloaderVersion = (await execute(downloaderPath, ['--version'])).stdout.trim();
  const ffmpegPath = process.env.LOCAL_FFMPEG_PATH ?? (await execute('which', ['ffmpeg'])).stdout.trim();
  await execute(ffmpegPath, ['-version']);
  const verifier = CognitoJwtVerifier.create({
    userPoolId: process.env.USER_POOL_ID, tokenUse: 'id', clientId: process.env.USER_POOL_CLIENT_ID,
  });
  const queue = localQueue(createWorker({ ffmpegPath, downloaderPath }));
  const stemPython = process.env.STEM_PYTHON_PATH ??
    fileURLToPath(new URL('../.venv-stems/bin/python', import.meta.url));
  const stemQueue = localQueue(createStemWorker({ pythonPath: stemPython, ffmpegPath }), 1);
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
    api: createHandler({ invoker: queue }), accounts: createAccountHandler(),
    stems: createStemHandler({ orchestrator: stemOrchestrator }),
    verify: token => verifier.verify(token),
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  const port = Number(process.env.LOCAL_API_PORT ?? 3001);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`Local API http://127.0.0.1:${port}; conversion=local, Cognito/DynamoDB/S3=AWS (${stackName})`);
  console.log(`Downloader: ${downloaderPath} (${downloaderVersion})`);
  console.log(`Stem worker: ${stemPython}; device=${process.env.STEM_DEVICE ?? 'cpu'}`);
  const stop = () => {
    console.log('Stopping local API; allowing active conversions to finish.');
    server.close(async () => {
      await Promise.allSettled([...queue.running, ...stemQueue.running]);
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
