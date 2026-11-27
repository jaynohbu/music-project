// Reads a score PDF (or image) into MusicXML with a local Audiveris, for trying score reading without AWS:
// `npm run omr` in web/. The site itself uses the ScoreReader Lambda (backend/score-api.mjs, read_score.py).
//   POST /omr?pages=2-3  body: the PDF  ->  the compressed MusicXML (.mxl) Audiveris exports
// pages (optional): which pages to read, as numbers and ranges ("2", "2-3 5"); every page takes Audiveris about
// ten seconds or more.
// Audiveris (https://github.com/Audiveris/audiveris, AGPL) is run as a separate program, found at $AUDIVERIS or
// ../.tools/Audiveris.app next to the repository. Only one score is read at a time.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.OMR_PORT ?? 3005);
const LARGEST = 40 * 1024 * 1024;
const TIMEOUT_MS = 10 * 60 * 1000;
const AUDIVERIS = process.env.AUDIVERIS
  ?? new URL('../../../.tools/Audiveris.app/Contents/MacOS/Audiveris', import.meta.url).pathname;
const KINDS = { '%PDF': '.pdf', '\x89PNG': '.png', '\xff\xd8\xff': '.jpg' };

let busy = false;

function kindOf(bytes) {
  const head = bytes.subarray(0, 4).toString('latin1');
  return Object.entries(KINDS).find(([magic]) => head.startsWith(magic))?.[1];
}

function run(input, output, sheets) {
  return new Promise((resolve, reject) => {
    const options = sheets ? ['-sheets', ...sheets.map(String)] : [];
    const child = spawn(AUDIVERIS, ['-batch', '-export', ...options, '-output', output, input], { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const keep = chunk => { log += chunk; };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, log }); });
  });
}

async function scores(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.mxl')) found.push(join(entry.parentPath ?? entry.path, entry.name));
  }
  return found.sort();
}

const send = (response, status, body, type = 'application/json') => {
  response.writeHead(status, { 'content-type': type });
  response.end(type === 'application/json' ? JSON.stringify(body) : body);
};

createServer(async (request, response) => {
  if (request.method !== 'POST' || !request.url?.startsWith('/omr')) return send(response, 404, { message: 'Not found.' });
  if (!existsSync(AUDIVERIS)) return send(response, 503, { message: `Audiveris is not installed at ${AUDIVERIS}.` });
  if (busy) return send(response, 429, { message: 'Another score is being read; try again in a moment.' });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > LARGEST) return send(response, 413, { message: 'The file is larger than 40 MB.' });
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks), kind = kindOf(bytes);
  if (!kind) return send(response, 415, { message: 'Send a PDF, PNG or JPEG score.' });
  busy = true;
  const directory = await mkdtemp(join(tmpdir(), 'omr-'));
  try {
    const input = join(directory, `score${kind}`), output = join(directory, 'out');
    await writeFile(input, bytes);
    const started = Date.now();
    const asked = new URL(request.url, 'http://local').searchParams.get('pages')?.trim();
    const chosen = asked && /^\d+(-\d+)?([ ,]+\d+(-\d+)?)*$/.test(asked) ? asked.split(/[ ,]+/) : undefined;
    let { code, log } = await run(input, output, chosen);
    // Audiveris exports nothing when any page cannot be read (a cover or a page of text): those are left out and
    // the rest read again.
    const pages = Number(/(\d+) sheets? in /.exec(log)?.[1] ?? 0);
    const unread = new Set([...log.matchAll(/Sheet \S+#(\d+) flagged as invalid/g)].map(match => Number(match[1])));
    if (!chosen && !(existsSync(output) && (await scores(output)).length) && pages > 1 && unread.size && unread.size < pages) {
      const sheets = Array.from({ length: pages }, (_, index) => index + 1).filter(sheet => !unread.has(sheet));
      console.log(`omr: pages ${[...unread].join(', ')} have no music; reading ${sheets.join(' ')}`);
      ({ code, log } = await run(input, output, sheets));
    }
    log = log.slice(-4000);
    const found = existsSync(output) ? await scores(output) : [];
    console.log(`omr: ${bytes.length} bytes, exit ${code}, ${found.length} score(s), ${((Date.now() - started) / 1000).toFixed(1)} s`);
    if (!found.length) return send(response, 422, { message: 'No music could be read from the file.', log: log.slice(-1500) });
    // A score Audiveris splits into movements comes back as its first; the page says how many there were.
    response.setHeader('x-omr-scores', String(found.length));
    send(response, 200, await readFile(found[0]), 'application/vnd.recordare.musicxml');
  } catch (error) {
    send(response, 500, { message: `Reading the score failed: ${error.message}` });
  } finally {
    busy = false;
    await rm(directory, { recursive: true, force: true });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Score reading (Audiveris) on http://127.0.0.1:${PORT}/omr`));
