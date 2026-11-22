import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The website's mixer, waveform and score colours (--m-* in styles.css) are the app's (mobile/src/theme.tsx).
const app = readFileSync(new URL('../../mobile/src/theme.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const KEYS = ['metal', 'key', 'keyBorder', 'keyInk', 'consoleAccent', 'consoleInk', 'consoleMuted', 'consoleLine', 'wave', 'waveLine',
  'waveBar', 'waveBarDim', 'start', 'end', 'playhead', 'strip', 'note', 'staff', 'scoreInk', 'wordDim', 'wordNear', 'wordActive', 'accent'];
const constants = Object.fromEntries([...app.matchAll(/const (\w+) = '([^']*)';/g)].map(([, name, value]) => [name, value]));
const kebab = key => key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);

test('every theme gives the website mixer the app\'s colours', () => {
  const themes = [...app.matchAll(/const \w+: Theme = \{([\s\S]*?)\n\};/g)].map(([, body]) => body);
  assert.equal(themes.length, 6);
  for (const body of themes) {
    const id = /id: '(\w+)'/.exec(body)[1];
    const selector = id === 'simple' ? ':root, :root[data-theme="simple"] {' : `:root[data-theme="${id}"] {\n  --m-`;
    const start = css.indexOf(selector);
    assert.notEqual(start, -1, `${id} has mixer colours`);
    const block = css.slice(start, css.indexOf('}', start));
    for (const key of KEYS) {
      const match = new RegExp(`\\b${key}: (?:'([^']*)'|([A-Z_]+))`).exec(body);
      const expected = match[1] ?? constants[match[2]];
      assert.ok(block.includes(`--m-${kebab(key)}: ${expected};`), `${id} ${key} is ${expected}`);
    }
  }
});
