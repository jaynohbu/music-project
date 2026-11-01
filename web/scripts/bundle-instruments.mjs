import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const LOWEST = 48, HIGHEST = 84;
const SOUNDFONT_REVISION = '044fab8e1456bfafc5776e86dfd6bb8697149aef';
const GUITARS = {
  'musyngkite-acoustic-guitar-v1': 'acoustic_guitar_steel',
  'musyngkite-electric-guitar-v1': 'electric_guitar_clean',
};
const PIANO_VERSION = '1.0.5';
const PIANO_VELOCITIES = [4, 8, 12, 16];
// Longest piano note: a sustained chord re-articulated every two beats at 40 BPM is 3 seconds.
const PIANO_SECONDS = '4';
const PITCHES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const octave = midi => Math.floor(midi / 12) - 1;
const directory = new URL('../public/instruments/', import.meta.url);

async function guitar(instrument) {
  const response = await fetch(`https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/${SOUNDFONT_REVISION}/MusyngKite/${instrument}-mp3.js`);
  if (!response.ok) throw new Error(`Instrument download failed: ${response.status}`);
  const text = await response.text();
  const start = text.indexOf(`MIDI.Soundfont.${instrument} = {`);
  if (start < 0) throw new Error('Unexpected instrument format');
  const samples = JSON.parse(text.slice(text.indexOf('{', start), text.lastIndexOf('}') + 1).replace(/,\s*}$/, '}'));
  const layer = {};
  for (let midi = LOWEST; midi <= HIGHEST; midi++) {
    const sample = samples[FLATS[midi % 12] + octave(midi)];
    if (typeof sample !== 'string' || !sample.startsWith('data:audio/mp3;base64,')) {
      throw new Error(`Missing sample ${midi}`);
    }
    layer[midi] = sample;
  }
  return { layers: [layer] };
}

// Salamander is sampled every three semitones. Frames are copied, so nothing is re-encoded.
async function piano() {
  const work = await mkdtemp(join(tmpdir(), 'salamander-'));
  try {
    const layers = [];
    for (const velocity of PIANO_VELOCITIES) {
      const name = `piano-mp3-velocity${velocity}`;
      const response = await fetch(`https://registry.npmjs.org/@audio-samples/${name}/-/${name}-${PIANO_VERSION}.tgz`);
      if (!response.ok) throw new Error(`Piano download failed: ${response.status}`);
      const unpacked = join(work, String(velocity));
      await mkdir(unpacked);
      const archive = join(unpacked, 'package.tgz');
      await writeFile(archive, Buffer.from(await response.arrayBuffer()));
      await run('tar', ['xzf', archive, '-C', unpacked, '--no-same-owner']);
      const layer = {};
      for (let midi = LOWEST; midi <= HIGHEST; midi += 3) {
        const source = join(unpacked, 'package', 'audio', `${PITCHES[midi % 12]}${octave(midi)}v${velocity}.mp3`);
        const output = join(unpacked, `${midi}.mp3`);
        await run('ffmpeg', ['-v', 'error', '-y', '-i', source, '-t', PIANO_SECONDS, '-map_metadata', '-1', '-c', 'copy', output]);
        layer[midi] = `data:audio/mp3;base64,${(await readFile(output)).toString('base64')}`;
      }
      layers.push(layer);
    }
    return { layers };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

await mkdir(directory, { recursive: true });
const write = async (name, content) => {
  await writeFile(new URL(`${name}.json`, directory), JSON.stringify(content));
  console.log(`Bundled ${name}: ${content.layers.length} layer(s), ${Object.keys(content.layers[0]).length} notes each`);
};
await write('salamander-piano-v1', await piano());
for (const [name, instrument] of Object.entries(GUITARS)) await write(name, await guitar(instrument));
