// A score read from MusicXML (.musicxml, .xml, or compressed .mxl), as what sounds: every note's pitch (as heard,
// so transposing instruments are moved to concert pitch), its start and length in quarter notes from the score's
// beginning, its measure, part and staff; the measures' starts and lengths; and the chord symbols. Tied notes are
// one note; grace notes, cue notes and unpitched (percussion) notes are left out. Repeats are not unrolled: the
// score is read as printed. Pure functions with its own small XML reader (no DOM), so it can be unit-tested.

export interface ScoreNote { pitch: number; start: number; length: number; measure: number; part: number; staff: number }
export interface ScoreMeasure { number: string; start: number; length: number; beats: number; beatType: number }
export interface ScoreChord { start: number; pitchClasses: number[] }
export interface ScorePart { id: string; name: string }
export interface Score {
  title: string;
  parts: ScorePart[];
  measures: ScoreMeasure[];
  notes: ScoreNote[];
  chords: ScoreChord[];
  // Quarter notes per minute, when the score marks one.
  tempo?: number;
}

interface XmlElement { name: string; attributes: Record<string, string>; children: XmlElement[]; text: string }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code: string) =>
  code[0] === '#' ? String.fromCodePoint(code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : +code.slice(1))
    : ENTITIES[code] ?? whole);

// Elements, attributes and text; comments, processing instructions, the doctype and CDATA markers are skipped.
function parseXml(source: string): XmlElement {
  const root: XmlElement = { name: '#root', attributes: {}, children: [], text: '' };
  const stack = [root];
  const tag = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  const attribute = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let last = 0, match: RegExpExecArray | null;
  while ((match = tag.exec(source))) {
    const top = stack[stack.length - 1];
    top.text += decode(source.slice(last, match.index));
    last = tag.lastIndex;
    if (match[1] !== undefined) { top.text += match[1]; continue; }
    if (!match[3]) continue;
    if (match[2]) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const element: XmlElement = { name: match[3], attributes: {}, children: [], text: '' };
    for (const [, name, double, single] of match[4].matchAll(attribute)) element.attributes[name] = decode(double ?? single);
    top.children.push(element);
    if (!match[5]) stack.push(element);
  }
  return root;
}

const child = (element: XmlElement | undefined, name: string) => element?.children.find(found => found.name === name);
const children = (element: XmlElement | undefined, name: string) => element?.children.filter(found => found.name === name) ?? [];
const textOf = (element: XmlElement | undefined, name: string) => child(element, name)?.text.trim();
const numberOf = (element: XmlElement | undefined, name: string, fallback: number) => {
  const value = Number(textOf(element, name));
  return Number.isFinite(value) && textOf(element, name) !== undefined ? value : fallback;
};

const STEPS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
// Semitones above the root of each chord kind (MusicXML's kind values); unknown kinds are major.
const KINDS: Record<string, number[]> = {
  major: [0, 4, 7], minor: [0, 3, 7], augmented: [0, 4, 8], diminished: [0, 3, 6], dominant: [0, 4, 7, 10],
  'major-seventh': [0, 4, 7, 11], 'minor-seventh': [0, 3, 7, 10], 'diminished-seventh': [0, 3, 6, 9],
  'augmented-seventh': [0, 4, 8, 10], 'half-diminished': [0, 3, 6, 10], 'major-minor': [0, 3, 7, 11],
  'major-sixth': [0, 4, 7, 9], 'minor-sixth': [0, 3, 7, 9], 'dominant-ninth': [0, 4, 7, 10, 2], 'major-ninth': [0, 4, 7, 11, 2],
  'minor-ninth': [0, 3, 7, 10, 2], 'suspended-second': [0, 2, 7], 'suspended-fourth': [0, 5, 7], power: [0, 7],
  'dominant-11th': [0, 4, 7, 10, 5], 'dominant-13th': [0, 4, 7, 10, 9], 'major-11th': [0, 4, 7, 11, 5], 'minor-11th': [0, 3, 7, 10, 5],
};

export function parseMusicXml(source: string): Score {
  const document = parseXml(source);
  const score = document.children.find(element => element.name === 'score-partwise');
  if (!score) {
    if (document.children.some(element => element.name === 'score-timewise')) throw new Error('Timewise MusicXML is not supported; export it as partwise.');
    throw new Error('This is not a MusicXML score.');
  }
  const title = textOf(child(score, 'work'), 'work-title') ?? textOf(score, 'movement-title') ?? '';
  const names = new Map(children(child(score, 'part-list'), 'score-part').map(part => [part.attributes['id'], textOf(part, 'part-name') ?? '']));
  const parts: ScorePart[] = [];
  const measures: ScoreMeasure[] = [];
  const notes: ScoreNote[] = [];
  const chords: ScoreChord[] = [];
  let tempo: number | undefined;
  children(score, 'part').forEach((partElement, part) => {
    const id = partElement.attributes['id'] ?? `P${part + 1}`;
    parts.push({ id, name: names.get(id) || `Part ${part + 1}` });
    let divisions = 1, transpose = 0, beats = 4, beatType = 4, start = 0;
    // Notes still tied over, by staff, voice and pitch.
    const tied = new Map<string, ScoreNote>();
    children(partElement, 'measure').forEach((measure, index) => {
      let at = 0, furthest = 0, lastStart = 0;
      for (const element of measure.children) {
        if (element.name === 'attributes') {
          divisions = numberOf(element, 'divisions', divisions);
          const time = child(element, 'time');
          if (time) { beats = numberOf(time, 'beats', beats); beatType = numberOf(time, 'beat-type', beatType); }
          const moved = child(element, 'transpose');
          if (moved) transpose = numberOf(moved, 'chromatic', 0) + 12 * numberOf(moved, 'octave-change', 0);
        } else if (element.name === 'backup') {
          at -= numberOf(element, 'duration', 0) / divisions;
        } else if (element.name === 'forward') {
          at += numberOf(element, 'duration', 0) / divisions;
        } else if (element.name === 'direction' || element.name === 'sound') {
          const sound = element.name === 'sound' ? element : child(element, 'sound');
          const marked = Number(sound?.attributes['tempo']);
          if (tempo === undefined && marked > 0) tempo = marked;
        } else if (element.name === 'harmony' && part === 0) {
          const root = child(element, 'root');
          const step = STEPS[textOf(root, 'root-step') ?? ''];
          if (step !== undefined) {
            const base = step + numberOf(root, 'root-alter', 0) + transpose;
            const kind = KINDS[textOf(element, 'kind') ?? 'major'] ?? KINDS['major'];
            const offset = numberOf(element, 'offset', 0) / divisions;
            chords.push({ start: start + at + offset, pitchClasses: kind.map(step => (((base + step) % 12) + 12) % 12) });
          }
        } else if (element.name === 'note') {
          const length = numberOf(element, 'duration', 0) / divisions;
          const inChord = !!child(element, 'chord');
          const noteStart = inChord ? lastStart : at;
          if (!inChord) { lastStart = at; at += length; }
          furthest = Math.max(furthest, at);
          const pitch = child(element, 'pitch');
          if (!pitch || child(element, 'grace') || child(element, 'cue') || length <= 0) continue;
          const midi = 12 * (numberOf(pitch, 'octave', 4) + 1) + (STEPS[textOf(pitch, 'step') ?? 'C'] ?? 0) + numberOf(pitch, 'alter', 0) + transpose;
          const staff = numberOf(element, 'staff', 1);
          const key = `${staff}/${textOf(element, 'voice') ?? '1'}/${Math.round(midi)}`;
          const ties = children(element, 'tie').map(tie => tie.attributes['type']);
          const held = tied.get(key);
          if (ties.includes('stop') && held && Math.abs(held.start + held.length - (start + noteStart)) < 1e-6) {
            held.length += length;
            if (!ties.includes('start')) tied.delete(key);
            continue;
          }
          const note = { pitch: Math.round(midi), start: start + noteStart, length, measure: index, part, staff };
          notes.push(note);
          if (ties.includes('start')) tied.set(key, note);
        }
        furthest = Math.max(furthest, at);
      }
      // The first part's measures are the score's, as long as their time signature says: only a pickup (the first
      // measure, or one marked implicit) is as short as what it holds. Read scores can miss or add a rest, so what a
      // measure holds is not trusted otherwise.
      if (part === 0) {
        const written = beats * 4 / beatType;
        const pickup = index === 0 || measure.attributes['implicit'] === 'yes';
        const length = pickup && furthest > 1e-6 && furthest < written - 1e-6 ? furthest : written;
        measures.push({ number: measure.attributes['number'] ?? String(index + 1), start, length, beats, beatType });
      }
      start += part === 0 ? measures[index].length : measures[index]?.length ?? furthest;
    });
  });
  if (!measures.length) throw new Error('The score has no measures.');
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  chords.sort((a, b) => a.start - b.start);
  return { title, parts, measures, notes, chords, tempo };
}

// The score inside a compressed MusicXML (.mxl) file: a zip whose META-INF/container.xml names the score.
export async function unzipMusicXml(bytes: Uint8Array): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (view.getUint32(at, true) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error('This .mxl file is not a zip archive.');
  const files = new Map<string, () => Promise<Uint8Array>>();
  let at = view.getUint32(end + 16, true);
  for (let entry = 0; entry < view.getUint16(end + 10, true); entry++) {
    const method = view.getUint16(at + 10, true), size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const data = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const stored = bytes.slice(data, data + size);
    files.set(name, async () => {
      if (method === 0) return stored;
      if (method !== 8) throw new Error(`Unsupported compression in ${name}.`);
      const stream = new Blob([stored]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    });
    at += 46 + nameLength + extra + comment;
  }
  const text = async (name: string) => new TextDecoder().decode(await files.get(name)!());
  let path = files.has('META-INF/container.xml')
    ? /full-path\s*=\s*"([^"]+)"/.exec(await text('META-INF/container.xml'))?.[1] : undefined;
  path ??= [...files.keys()].find(name => !name.startsWith('META-INF/') && /\.(musicxml|xml)$/i.test(name));
  if (!path || !files.has(path)) throw new Error('No score found inside the .mxl file.');
  return text(path);
}
