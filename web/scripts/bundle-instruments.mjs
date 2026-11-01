import { mkdir, writeFile } from 'node:fs/promises';

const revision = '044fab8e1456bfafc5776e86dfd6bb8697149aef';
const instruments = {
  'acoustic-guitar': 'acoustic_guitar_steel',
  'electric-guitar': 'electric_guitar_clean',
  piano: 'acoustic_grand_piano',
};
const directory = new URL('../public/instruments/', import.meta.url);
await mkdir(directory, { recursive: true });
for (const [name, instrument] of Object.entries(instruments)) {
  const response = await fetch(`https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/${revision}/FluidR3_GM/${instrument}-mp3.js`);
  if (!response.ok) throw new Error(`Instrument download failed: ${response.status}`);
  const text = await response.text();
  const start = text.indexOf(`MIDI.Soundfont.${instrument} = {`);
  if (start < 0) throw new Error('Unexpected instrument format');
  const json = text.slice(text.indexOf('{', start), text.lastIndexOf('}') + 1);
  const samples = JSON.parse(json.replace(/,\s*}$/, '}'));
  const selected = {};
  const pitches = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  for (let midi = 48; midi <= 84; midi++) {
    const key = pitches[midi % 12] + (Math.floor(midi / 12) - 1);
    const sample = samples[key];
    if (typeof sample !== 'string' || !sample.startsWith('data:audio/mp3;base64,')) {
      throw new Error(`Missing sample ${key}`);
    }
    selected[midi] = sample;
  }
  await writeFile(new URL(`${name}.json`, directory), JSON.stringify(selected));
  console.log(`Bundled ${name}: ${Object.keys(selected).length} licensed samples`);
}
