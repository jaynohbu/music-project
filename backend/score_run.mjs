// A song's score laid on its stems by the stem worker (stem-analysis.mjs, a harmony record with scoreKey): the
// website's own engine (score-engine/, from web/src) on the stems decoded by ffmpeg, the song's chords & notes
// written as its harmony result and the sound of the score's notes as a WAV.
//   node score_run.mjs <result.json> --stem other=<wav> --stem vocals=<wav> --stem bass=<wav> --stem drums=<wav>
//     --base <analysis.json> --score <musicxml> --extracted <out.wav> --title <title> --saved-at <time>
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { importScore } = require('./score-engine/score-import.cjs');
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
const options = { stems: {} };
for (let index = 0; index < rest.length; index += 2) {
  const [flag, value] = [rest[index], rest[index + 1]];
  if (flag === '--stem') { const [name, file] = value.split(/=(.*)/s); options.stems[name] = file; }
  else options[flag.replace(/^--/, '')] = value;
}
const stems = {};
for (const [name, file] of Object.entries(options.stems)) stems[name] = await decode(file);
const analysis = JSON.parse(await readFile(options.base, 'utf8'));
const musicxml = await readFile(options.score, 'utf8');
const started = Date.now();
const result = await importScore({
  source: { musicxml, title: options.title ?? '', savedAt: options['saved-at'] ?? '' }, stems, analysis,
  readPdf: () => { throw new Error('A PDF is read before it is saved with the song.'); }, progress: () => {},
});
await writeFile(output, JSON.stringify(result.document));
await writeFile(options.extracted, Buffer.from(await result.extracted.arrayBuffer()));
console.log(`score laid in ${((Date.now() - started) / 1000).toFixed(1)} s: ${result.document.fromScore.measures} measures, ${result.document.fromScore.notes} notes, ${result.fit.corrections.bars} drum bars corrected`);
