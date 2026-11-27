// A song's scores laid on its stems by the stem worker (stem-analysis.mjs, a harmony record with scoreKey): the
// website's own engine (score-engine/, from web/src) on the stems decoded by ffmpeg, the song's parts from its
// Harmonic, bass and drum scores written as its harmony result, and the sound of the Harmonic score's notes as a WAV.
//   node score_run.mjs <result.json> --stem other=<wav> --stem vocals=<wav> --stem bass=<wav> --stem drums=<wav>
//     --base <analysis.json> --score <part>=<musicxml> --title <part>=<title> --saved-at <part>=<time> (for each
//     part: other, bass, drums) --extracted <out.wav>
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { importScores } = require('./score-engine/score-import.cjs');
const RATE = 22050;
const FFMPEG = process.env.LOCAL_FFMPEG_PATH ?? 'ffmpeg';

// A stem as mono samples at RATE, in the shape of an AudioBuffer the engine reads.
function decode(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let error = '';
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg failed: ${error.slice(-300)}`));
      const bytes = Buffer.concat(chunks);
      const data = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
      resolve({ numberOfChannels: 1, sampleRate: RATE, length: data.length, duration: data.length / RATE, getChannelData: () => data });
    });
  });
}

const [output, ...rest] = process.argv.slice(2);
const options = { stems: {}, score: {}, title: {}, 'saved-at': {} };
for (let index = 0; index < rest.length; index += 2) {
  const [flag, value] = [rest[index], rest[index + 1]];
  const name = flag.replace(/^--/, '');
  if (name === 'stem' || ['score', 'title', 'saved-at'].includes(name)) {
    // A part's value as part=value; a lone value (older workers) is the Harmonic score's.
    const [key, given] = /^(other|bass|drums|vocals)=/.test(value) ? value.split(/=(.*)/s) : ['other', value];
    options[name === 'stem' ? 'stems' : name][key] = given;
  } else options[name] = value;
}
const stems = {};
for (const [name, file] of Object.entries(options.stems)) stems[name] = await decode(file);
const analysis = JSON.parse(await readFile(options.base, 'utf8'));
const sources = {};
for (const [part, file] of Object.entries(options.score)) {
  sources[part] = { musicxml: await readFile(file, 'utf8'), title: options.title[part] ?? '', savedAt: options['saved-at'][part] ?? '' };
}
const started = Date.now();
const result = await importScores({
  sources, stems, analysis,
  readPdf: () => { throw new Error('A PDF is read before it is saved with the song.'); }, progress: () => {},
});
// The Harmonic, bass and drum stems' loudness every LOUDNESS_WINDOW seconds (RMS), so a part played from a score
// can follow its stem without the stem at hand (the app's score parts).
const LOUDNESS_WINDOW = 0.25;
const loudness = { window: LOUDNESS_WINDOW };
for (const name of ['other', 'bass', 'drums']) {
  if (!stems[name]) continue;
  const data = stems[name].getChannelData(0), size = Math.round(LOUDNESS_WINDOW * RATE), levels = [];
  for (let from = 0; from < data.length; from += size) {
    let sum = 0;
    const to = Math.min(data.length, from + size);
    for (let index = from; index < to; index++) sum += data[index] * data[index];
    levels.push(Math.round(Math.sqrt(sum / Math.max(1, to - from)) * 1e5) / 1e5);
  }
  loudness[name] = levels;
}
result.document.loudness = loudness;
await writeFile(output, JSON.stringify(result.document));
// Without a Harmonic score there is no extracted sound; an empty file tells the worker so.
await writeFile(options.extracted, result.extracted ? Buffer.from(await result.extracted.arrayBuffer()) : Buffer.alloc(0));
const told = Object.entries(result.parts).map(([part, laid]) => `${part}: ${laid.measures} measures, ${laid.notes} notes (${laid.heard} heard), ${result.corrections[part]} drum bars corrected`);
console.log(`scores laid in ${((Date.now() - started) / 1000).toFixed(1)} s; ${told.join('; ')}`);
