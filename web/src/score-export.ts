// The Harmonic score as files to take elsewhere: a MIDI file that plays in time with the song from its first beat
// (its tempo follows the song's beats), every note as the stem played it (its own start, end and velocity, as a
// SoundFont would render it); MusicXML for notation programs, on the written grid, where notes on one sixteenth are a
// chord; and the notes as JSON events. Chord names go with them (MIDI marker events, MusicXML harmony). Pure functions
// only, so they can be unit-tested.
import type { HarmonyGrid, HarmonyNote, HarmonyPart } from './services';

const TICKS = 480;            // Per quarter note.
const SIXTEENTH = TICKS / 4;
const BAR = 16;               // Sixteenths in a bar.

function variable(value: number): number[] {
  const out = [value & 0x7f];
  while ((value >>= 7) > 0) out.unshift((value & 0x7f) | 0x80);
  return out;
}
const text = (value: string) => [...new TextEncoder().encode(value)];
const word = (value: number, size: number) => Array.from({ length: size }, (_, i) => (value >> (8 * (size - 1 - i))) & 0xff);

// Where each sixteenth sits on the grid, in song seconds and in sixteenths, as the score writes it.
function chordUnit(beats: number[], seconds: number): number {
  let index = 0;
  while (index < beats.length - 2 && beats[index + 1] <= seconds) index++;
  const span = beats[index + 1] - beats[index] || 0.5;
  return Math.round((index + (seconds - beats[index]) / span) * 2) * 2;
}

// Song seconds as a (fractional) beat of the grid, extrapolating past its ends.
function beatAt(beats: number[], seconds: number): number {
  let index = 0;
  while (index < beats.length - 2 && beats[index + 1] <= seconds) index++;
  return index + (seconds - beats[index]) / (beats[index + 1] - beats[index] || 0.5);
}

const velocityOf = (note: HarmonyNote) => Math.max(1, Math.min(127, note.velocity ?? Math.round(40 + 87 * (note.confidence ?? 0.7))));

// A format 0 MIDI file: a tempo change on every beat, so it stays with the song, the chord names as markers, and
// every note when the stem played it, as loud.
export function harmonyMidi(part: HarmonyPart, grid: HarmonyGrid): Uint8Array<ArrayBuffer> {
  const events: { tick: number; order: number; data: number[] }[] = [];
  for (let beat = 0; beat < grid.beats.length - 1; beat++) {
    const micro = Math.round((grid.beats[beat + 1] - grid.beats[beat]) * 1e6);
    events.push({ tick: beat * TICKS, order: 0, data: [0xff, 0x51, 0x03, ...word(micro, 3)] });
  }
  // Bars as the song's: a short first bar when the first full bar does not start on beat one.
  const pickup = grid.firstBar % 4;
  if (pickup) events.push({ tick: 0, order: 0, data: [0xff, 0x58, 0x04, pickup, 2, 24, 8] });
  events.push({ tick: pickup * TICKS, order: 0, data: [0xff, 0x58, 0x04, 4, 2, 24, 8] });
  for (const chord of part.chords) {
    const name = text(chord.name);
    events.push({ tick: chordUnit(grid.beats, chord.start) * SIXTEENTH, order: 1, data: [0xff, 0x06, ...variable(name.length), ...name] });
  }
  for (const note of part.notes) {
    const on = Math.max(0, Math.round(beatAt(grid.beats, note.start) * TICKS));
    events.push({ tick: on, order: 3, data: [0x90, note.pitch, velocityOf(note)] });
    events.push({ tick: Math.max(on + 1, Math.round(beatAt(grid.beats, note.end) * TICKS)), order: 2, data: [0x80, note.pitch, 0] });
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const track: number[] = [];
  let last = 0;
  for (const event of events) {
    track.push(...variable(event.tick - last), ...event.data);
    last = event.tick;
  }
  track.push(0, 0xff, 0x2f, 0x00);
  return new Uint8Array([...text('MThd'), ...word(6, 4), ...word(0, 2), ...word(1, 2), ...word(TICKS, 2),
    ...text('MTrk'), ...word(track.length, 4), ...track]);
}

const STEPS = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
const FLAT_STEPS = ['C', 'D', 'D', 'E', 'E', 'F', 'G', 'G', 'A', 'A', 'B', 'B'];
const SHARP_ALTER = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
const FLAT_ALTER = [0, -1, 0, -1, 0, 0, -1, 0, -1, 0, -1, 0];
const MAJOR_FIFTHS: Record<string, number> = {
  C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7,
};
const MINOR_FIFTHS: Record<string, number> = {
  A: 0, E: 1, B: 2, 'F#': 3, 'C#': 4, 'G#': 5, 'D#': 6, 'A#': 7, D: -1, G: -2, C: -3, F: -4, Bb: -5, Eb: -6, Ab: -7,
};
const ROOT = /^([A-G])([#b]?)(.*?)(?:\/([A-G])([#b]?))?$/;
const KINDS: Record<string, string> = {
  '': 'major', m: 'minor', '7': 'dominant', maj7: 'major-seventh', m7: 'minor-seventh', sus2: 'suspended-second',
  sus4: 'suspended-fourth', sus: 'suspended-fourth', dim: 'diminished', aug: 'augmented', '6': 'major-sixth', m6: 'minor-sixth',
  '9': 'dominant-ninth', maj9: 'major-ninth', m9: 'minor-ninth', dim7: 'diminished-seventh', m7b5: 'half-diminished', '5': 'power',
};
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function keyFifths(key?: string): number {
  if (!key) return 0;
  const minor = key.endsWith('m');
  return (minor ? MINOR_FIFTHS : MAJOR_FIFTHS)[minor ? key.slice(0, -1) : key] ?? 0;
}

function pitchXml(pitch: number, flats: boolean): string {
  const pc = pitch % 12;
  const step = (flats ? FLAT_STEPS : STEPS)[pc], alter = (flats ? FLAT_ALTER : SHARP_ALTER)[pc];
  return `<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${Math.floor(pitch / 12) - 1}</octave></pitch>`;
}

function harmonyXml(name: string): string {
  const match = ROOT.exec(name);
  if (!match) return '';
  const alter = (sign: string) => sign === '#' ? '<root-alter>1</root-alter>' : sign === 'b' ? '<root-alter>-1</root-alter>' : '';
  const kind = KINDS[match[3]] ?? (match[3].startsWith('m') && !match[3].startsWith('maj') ? 'minor' : 'major');
  const bass = match[4] ? `<bass><bass-step>${match[4]}</bass-step>${alter(match[5]).replace(/root/g, 'bass')}</bass>` : '';
  return `<harmony><root><root-step>${match[1]}</root-step>${alter(match[2])}</root><kind text="${escape(match[3])}">${kind}</kind>${bass}</harmony>`;
}

// Written note values that fit in a span of sixteenths, longest first (dotted ones included).
const VALUES: [number, string, boolean][] = [[16, 'whole', false], [12, 'half', true], [8, 'half', false], [6, 'quarter', true],
  [4, 'quarter', false], [3, 'eighth', true], [2, 'eighth', false], [1, '16th', false]];
function pieces(length: number): [number, string, boolean][] {
  const out: [number, string, boolean][] = [];
  while (length > 0) {
    const value = VALUES.find(([size]) => size <= length)!;
    out.push(value);
    length -= value[0];
  }
  return out;
}

// MusicXML (partwise, one treble part): bars from the song's first bar, a pickup bar for anything before it.
// Each sixteenth's notes are one chord, lasting until the next chord or the bar's end (held over with ties);
// gaps are rests.
export function harmonyMusicXml(part: HarmonyPart, grid: HarmonyGrid, title: string): string {
  const flats = keyFifths(part.key) < 0;
  const firstUnit = grid.firstBar * 4;
  const pickup = ((firstUnit % BAR) + BAR) % BAR;
  const lastUnit = Math.max(grid.beats.length * 4, ...part.notes.map(note => note.unit + note.length));
  const bars: [number, number][] = [];
  if (pickup) bars.push([firstUnit - pickup, firstUnit]);
  for (let start = firstUnit; start < lastUnit; start += BAR) bars.push([start, start + BAR]);
  const stacks = new Map<number, HarmonyNote[]>();
  for (const note of part.notes) {
    if (note.unit < (bars[0]?.[0] ?? 0)) continue;
    stacks.set(note.unit, [...(stacks.get(note.unit) ?? []), note]);
  }
  const starts = [...stacks.keys()].sort((a, b) => a - b);
  const chordsAt = new Map<number, string>();
  for (const chord of part.chords) chordsAt.set(chordUnit(grid.beats, chord.start), chord.name);
  const named = new Set<number>();
  const tempo = grid.beats.length > 1 ? 60 / ((grid.beats[grid.beats.length - 1] - grid.beats[0]) / (grid.beats.length - 1)) : 120;
  const measures = bars.map(([start, end], index) => {
    let xml = `<measure number="${pickup ? index : index + 1}"${pickup && !index ? ' implicit="yes"' : ''}>`;
    if (!index) {
      xml += `<attributes><divisions>4</divisions><key><fifths>${keyFifths(part.key)}</fifths></key>`
        + `<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>`
        + `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(tempo)}</per-minute></metronome></direction-type><sound tempo="${Math.round(tempo)}"/></direction>`;
    }
    let at = start;
    // A chord name goes before the note or rest on its sixteenth; rests split where a chord changes.
    const mark = () => {
      const name = chordsAt.get(at);
      if (name && name !== 'N.C.' && !named.has(at)) xml += harmonyXml(name);
      named.add(at);
    };
    const rest = (until: number) => {
      while (at < until) {
        mark();
        const change = [...chordsAt.keys()].filter(unit => unit > at && unit < until).sort((a, b) => a - b)[0] ?? until;
        for (const [size, type, dot] of pieces(change - at)) {
          xml += `<note><rest/><duration>${size}</duration><type>${type}</type>${dot ? '<dot/>' : ''}</note>`;
          at += size;
        }
      }
    };
    // A chord begun in an earlier bar and still sounding continues here, tied.
    const held = starts.filter(unit => unit < start).at(-1);
    const heldStack = held !== undefined ? stacks.get(held)! : [];
    const heldNext = starts.find(unit => unit > (held ?? Infinity)) ?? Infinity;
    const heldEnd = held !== undefined ? Math.min(Math.max(...heldStack.map(note => held + note.length)), heldNext) : start;
    const sound = (stack: HarmonyNote[], from: number, until: number, tiedIn: boolean, tiedOut: boolean) => {
      const parts = pieces(until - from);
      parts.forEach(([size, type, dot], piece) => {
        const tieStart = piece < parts.length - 1 || tiedOut, tieStop = piece > 0 || tiedIn;
        stack.forEach((note, i) => {
          const ties = (tieStop ? '<tie type="stop"/>' : '') + (tieStart ? '<tie type="start"/>' : '');
          const notations = (tieStop ? '<tied type="stop"/>' : '') + (tieStart ? '<tied type="start"/>' : '');
          xml += `<note>${i ? '<chord/>' : ''}${pitchXml(note.pitch, flats)}<duration>${size}</duration>${ties}<type>${type}</type>`
            + `${dot ? '<dot/>' : ''}${notations ? `<notations>${notations}</notations>` : ''}</note>`;
        });
        at += size;
      });
    };
    mark();
    if (heldEnd > start) sound(heldStack, start, Math.min(heldEnd, end), true, heldEnd > end);
    for (const unit of starts.filter(unit => unit >= start && unit < end)) {
      if (unit < at) continue;
      rest(unit);
      mark();
      const stack = [...stacks.get(unit)!].sort((a, b) => a.pitch - b.pitch);
      const next = starts.find(other => other > unit) ?? Infinity;
      const until = Math.min(unit + Math.max(...stack.map(note => note.length)), next);
      sound(stack, unit, Math.min(until, end), false, until > end);
    }
    rest(end);
    return xml + '</measure>';
  });
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n'
    + `<score-partwise version="4.0"><work><work-title>${escape(title)}</work-title></work>`
    + '<part-list><score-part id="P1"><part-name>Harmonic</part-name></score-part></part-list>'
    + `<part id="P1">${measures.join('')}</part></score-partwise>\n`;
}

// One event per note, as the transcription design has them: its bar (from the song's first bar; a pickup is bar -1),
// pitch, start and end as played, its beat in the bar (as played, not snapped), velocity and confidence; voted when
// the vote among repeated passages added it. With the chords and the repeated passages.
export interface PlayedEvent {
  barId: number; pitchMidi: number; onsetSec: number; offsetSec: number; durationSec: number; onsetBeat: number;
  velocity: number; confidence: number | null; voted?: boolean;
}
export function harmonyEvents(part: HarmonyPart, grid: HarmonyGrid): { events: PlayedEvent[]; chords: HarmonyPart['chords']; repeats: HarmonyPart['repeats'] } {
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const events = [...part.notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch).map(note => {
    const beat = beatAt(grid.beats, note.start) - grid.firstBar;
    const barId = Math.floor((note.unit - grid.firstBar * 4) / BAR);
    return {
      barId, pitchMidi: note.pitch, onsetSec: round(note.start), offsetSec: round(note.end), durationSec: round(note.end - note.start),
      onsetBeat: round(beat - barId * 4), velocity: velocityOf(note), confidence: note.confidence ?? null, ...(note.voted ? { voted: true } : {}),
    };
  });
  return { events, chords: part.chords, repeats: part.repeats ?? [] };
}
