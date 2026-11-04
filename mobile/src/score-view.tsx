import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, Easing, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import Svg, { Circle, Ellipse, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import type { HarmonyGrid, HarmonyPart, LyricLine, LyricWord } from './api';
import {
  BEAM_HEIGHT, CLEFS, CYMBAL_LEDGER, HELD_AFTER_WORD, MIDDLE_LINE_Y, STAFF_LINES, UNIT_WIDTH, UNITS_PER_BAR,
  drumScore, editedLines, firstChange, gapAfter, lineText, lyricIndex, notePieces, positionAt, reachedIndex, scoreRests,
  type LyricRow, type NotePiece, type ScoreRest,
} from './score';
import { BLUE, Button, GREY, INK, LINE, formatTime } from './ui';

// Matches the mixer's 100ms position timer, so the strips glide between updates.
const GLIDE_MS = 100;
const STRIP = '#f1f4f9';
const NOTE = '#2c3a4e';
const glide = (value: Animated.Value, to: number) =>
  Animated.timing(value, { toValue: to, duration: GLIDE_MS, easing: Easing.linear, useNativeDriver: true }).start();

const Fades = () => <>
  <View pointerEvents="none" style={[styles.fade, { left: 0, backgroundImage: `linear-gradient(90deg, ${STRIP}, ${STRIP}00)` }]} />
  <View pointerEvents="none" style={[styles.fade, { right: 0, backgroundImage: `linear-gradient(270deg, ${STRIP}, ${STRIP}00)` }]} />
</>;

// Only the text and highlight redraw a word; its layout callback writes by stable index.
const Word = memo(function Word({ text, state, onCenter }: { text: string; state: 'active' | 'near' | ''; onCenter: (x: number) => void }) {
  return <Text onLayout={event => onCenter(event.nativeEvent.layout.x + event.nativeEvent.layout.width / 2)}
    style={[styles.word, state === 'near' && styles.wordNear, state === 'active' && styles.wordActive]}>{text}</Text>;
}, (before, after) => before.text === after.text && before.state === after.state);

// The words flow past, and the one being sung glides into the middle.
export function LyricsStrip({ lines, time }: { lines: LyricLine[]; time: number }) {
  const words = useMemo(() => lines.flatMap(line => line.words), [lines]);
  const [width, setWidth] = useState(0);
  const [centers, setCenters] = useState<number[]>([]);
  const [offset] = useState(() => new Animated.Value(0));
  // Word positions arrive one by one from layout; they are kept per line, then flattened.
  const measured = useRef<number[][]>([]);
  const lineLefts = useRef<number[]>([]);
  const latest = useRef(lines);
  const pending = useRef(false);
  useEffect(() => { latest.current = lines; }, [lines]);
  // Many layouts arrive together, so they are gathered into one update per frame.
  const publish = () => {
    if (pending.current) return;
    pending.current = true;
    requestAnimationFrame(() => {
      pending.current = false;
      const next: number[] = [];
      latest.current.forEach((line, index) => line.words.forEach((_, word) =>
        next.push((lineLefts.current[index] ?? 0) + (measured.current[index]?.[word] ?? 0))));
      setCenters(next);
    });
  };
  const index = lyricIndex(words, time);
  const ready = width > 0 && centers.length === words.length && words.length > 0;
  useEffect(() => {
    if (!ready) return;
    const middle = width / 2;
    const fromTime = index < 0 ? 0 : words[index].start;
    const from = index < 0 ? centers[0] - middle : centers[index];
    const next = Math.min(index + 1, words.length - 1);
    const span = words[next].start - fromTime;
    const progress = span > 0 ? Math.min(1, (time - fromTime) / span) : 0;
    glide(offset, middle - (from + (centers[next] - from) * progress));
  }, [ready, width, centers, index, time, words, offset]);
  // Word timings are sometimes a word early or late, so the words either side are lit too, more faintly.
  const active = index >= 0 && time < words[index].end + HELD_AFTER_WORD ? index : -1;
  let flat = 0;
  return <View style={styles.lyrics} onLayout={event => setWidth(event.nativeEvent.layout.width)}
    accessibilityLabel={`Lyrics: ${active >= 0 ? words[active].text : ''}`}>
    <Animated.View style={[styles.lyricsFlow, { opacity: ready ? 1 : 0, transform: [{ translateX: offset }] }]}>
      {lines.map((line, lineIndex) => <View key={lineIndex} style={styles.lyricsLine}
        onLayout={event => { lineLefts.current[lineIndex] = event.nativeEvent.layout.x; publish(); }}>
        {line.words.map((word: LyricWord, wordIndex) => {
          const at = flat++;
          const state = at === active ? 'active' : active >= 0 && Math.abs(at - active) === 1 ? 'near' : '';
          return <Word key={wordIndex} text={word.text} state={state}
            onCenter={x => { (measured.current[lineIndex] ??= [])[wordIndex] = x; publish(); }} />;
        })}
      </View>)}
    </Animated.View>
    <Fades />
  </View>;
}

// The score is drawn in chunks of four bars, and only those near the playhead are mounted.
const CHUNK = UNITS_PER_BAR * 4 * UNIT_WIDTH;
const MARGIN = 320;
const HEIGHT = 128;
const chunkOf = (x: number) => Math.floor(x / CHUNK);

interface Score {
  drums: boolean; written: boolean;
  chords: { name: string; unit: number; x: number }[];
  notes: NotePiece[][];
  strokes: ReturnType<typeof drumScore>['strokes'];
  beams: ReturnType<typeof drumScore>['beams'];
  rests: ScoreRest[];
  bars: number[];
  spans: { unit: number; length: number }[];
}

function layout(part: HarmonyPart, stem: string, grid: HarmonyGrid): Score {
  const drums = stem === 'drums';
  const written = part.notes.length > 0 || !!part.hits?.length;
  const drawn = drumScore(part.hits ?? [], grid.firstBar);
  const chords = drums
    ? (part.patterns ?? []).map(pattern => ({ name: pattern.label, unit: pattern.unit, x: pattern.unit * UNIT_WIDTH + UNIT_WIDTH / 2 }))
    // Chords land on the nearest eighth note, so they line up with the notes below.
    : part.chords.map(chord => {
      const unit = Math.round(positionAt(grid.beats, chord.start) / 2) * 2;
      return { name: chord.name, unit, x: unit * UNIT_WIDTH };
    });
  const bars: number[] = [];
  if (written) {
    for (let unit = grid.firstBar * 4; unit < grid.beats.length * 4; unit += UNITS_PER_BAR) bars.push(unit * UNIT_WIDTH - UNIT_WIDTH / 2);
  }
  return {
    drums, written, chords, bars,
    notes: drums ? [] : part.notes.map(note => notePieces(stem, note, grid.firstBar)),
    strokes: drums ? drawn.strokes : [], beams: drums ? drawn.beams : [],
    rests: drums ? drawn.rests : scoreRests(part.notes, grid.firstBar),
    spans: drums ? drawn.strokes : part.notes,
  };
}

const cross = (x: number, y: number) => `M${x - 4} ${y - 4} L${x + 4} ${y + 4} M${x - 4} ${y + 4} L${x + 4} ${y - 4}`;

function RestMark({ rest }: { rest: ScoreRest }) {
  const y = MIDDLE_LINE_Y, ink = '#4c5c72';
  if (rest.units === 16) return <Rect x={rest.x + 6} y={y - 8} width={12} height={4} fill={ink} />;
  if (rest.units === 8) return <Rect x={rest.x + 6} y={y - 4} width={12} height={4} fill={ink} />;
  const line = { fill: 'none', stroke: ink, strokeWidth: 1.7 };
  if (rest.units === 4) return <Path d={`M${rest.x - 2} ${y - 11} l5 6 l-4 5 l5 6 c-4 -2 -6 0 -3 4`} {...line} />;
  return <G>
    <Path d={`M${rest.x + 4} ${y - 6} l-4 ${rest.units === 1 ? 17 : 12}`} {...line} />
    <Path d={`M${rest.x - 3} ${y - 5} q4 2 7 -1`} {...line} />
    <Circle r={1.9} cx={rest.x - 3} cy={y - 5} fill={ink} />
    {rest.units === 1 && <>
      <Path d={`M${rest.x - 4} ${y + 1} q4 2 7 -1`} {...line} />
      <Circle r={1.9} cx={rest.x - 4} cy={y + 1} fill={ink} />
    </>}
  </G>;
}

function NoteMark({ pieces, color }: { pieces: NotePiece[]; color: string }) {
  const line = { fill: 'none', stroke: color, strokeWidth: 1.2 };
  return <G>{pieces.map((piece, index) => <G key={index}>
    {piece.ledgers.map(y => <Line key={y} x1={piece.x - 8} x2={piece.x + 8} y1={y} y2={y} {...line} />)}
    <Ellipse rx={5.2} ry={3.8} cx={piece.x} cy={piece.y} transform={`rotate(-20 ${piece.x} ${piece.y})`}
      fill={piece.hollow ? 'none' : color} stroke={piece.hollow ? color : 'none'} strokeWidth={1.5} />
    {piece.stem && <Line x1={piece.stem.x} x2={piece.stem.x} y1={piece.y} y2={piece.stem.end} {...line} />}
    {piece.flags.map((flag, at) => <Path key={at} d={flag} {...line} />)}
    {piece.dot && <Circle r={1.6} cx={piece.dot.x} cy={piece.dot.y} fill={color} />}
    {piece.tie && <Path d={piece.tie} {...line} />}
    {!!piece.accidental && <SvgText x={piece.x - 7} y={piece.y + 4} textAnchor="end" fontSize={13} fill={color}>{piece.accidental}</SvgText>}
  </G>)}</G>;
}

function StrokeMark({ stroke, color }: { stroke: Score['strokes'][number]; color: string }) {
  const line = { fill: 'none', stroke: color, strokeWidth: 1.2 };
  return <G>
    {stroke.ledger && <Line x1={stroke.x - 8} x2={stroke.x + 8} y1={CYMBAL_LEDGER} y2={CYMBAL_LEDGER} {...line} />}
    {stroke.heads.map(head => head.cross
      ? <Path key={head.y} d={cross(stroke.x, head.y)} {...line} strokeWidth={1.5} />
      : <Ellipse key={head.y} rx={5.2} ry={3.8} cx={stroke.x} cy={head.y} transform={`rotate(-20 ${stroke.x} ${head.y})`} fill={color} />)}
    {stroke.stems.map((stem, at) => <Line key={at} x1={stem.x} x2={stem.x} y1={stem.from} y2={stem.to} {...line} />)}
    {stroke.flags.map((flag, at) => <Path key={at} d={flag} {...line} />)}
    {stroke.dots.map((dot, at) => <Circle key={at} r={1.6} cx={dot.x} cy={dot.y} fill={color} />)}
  </G>;
}

// One chunk of the score; its neighbours' marks that reach into it are drawn by their own chunk.
const Chunk = memo(function Chunk({ score, chunk, activeChord, activeNote }: {
  score: Score; chunk: number; activeChord: number; activeNote: number;
}) {
  const inside = (x: number) => chunkOf(x) === chunk;
  const left = chunk * CHUNK - MARGIN, width = CHUNK + 2 * MARGIN;
  return <Svg width={width} height={HEIGHT} viewBox={`${left} 0 ${width} ${HEIGHT}`} style={{ position: 'absolute', left, top: 0 }}>
    {score.bars.filter(inside).map(x => <Line key={x} x1={x} x2={x} y1={STAFF_LINES[4]} y2={STAFF_LINES[0]} stroke="#8a99ad" strokeWidth={1} />)}
    {score.chords.map((chord, index) => inside(chord.x) && <SvgText key={index} x={chord.x} y={18} textAnchor="middle" fontWeight="700"
      fontSize={index === activeChord ? 16 : 14} fill={index === activeChord ? BLUE : '#42536b'}>{chord.name}</SvgText>)}
    {score.rests.map((rest, index) => inside(rest.x) && <RestMark key={index} rest={rest} />)}
    {score.beams.map((beam, index) => inside(beam.x) && <Rect key={index} x={beam.x} y={beam.y} width={beam.width} height={BEAM_HEIGHT} fill={NOTE} />)}
    {score.strokes.map((stroke, index) => inside(stroke.x) && <StrokeMark key={stroke.unit} stroke={stroke} color={index === activeNote ? BLUE : NOTE} />)}
    {score.notes.map((pieces, index) => inside(pieces[0].x) && <NoteMark key={index} pieces={pieces} color={index === activeNote ? BLUE : NOTE} />)}
  </Svg>;
});

// A staff that scrolls under a fixed "now" line, the same as the website's score strip.
export function HarmonyStrip({ part, stem, grid, time }: { part: HarmonyPart; stem: string; grid: HarmonyGrid; time: number }) {
  const score = useMemo(() => layout(part, stem, grid), [part, stem, grid]);
  const [width, setWidth] = useState(0);
  const [offset] = useState(() => new Animated.Value(0));
  const position = positionAt(grid.beats, time);
  const middle = width / 2;
  useEffect(() => { if (width) glide(offset, middle - position * UNIT_WIDTH); }, [width, middle, position, offset]);
  const chord = reachedIndex(score.chords.map(item => item.unit), position);
  const note = reachedIndex(score.spans.map(item => item.unit), position);
  const activeNote = note >= 0 && position < score.spans[note].unit + score.spans[note].length ? note : -1;
  const noteX = (index: number) => score.drums ? score.strokes[index].x : score.notes[index][0].x;
  const here = position * UNIT_WIDTH;
  const first = chunkOf(Math.max(0, here - middle - MARGIN)), last = chunkOf(here + middle + MARGIN);
  const chunks = Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index);
  const clef = CLEFS[stem]?.clef;
  const label = score.drums ? `Drum score with ${score.strokes.length} strokes`
    : `Chords and melody: ${part.chords.map(item => item.name).slice(0, 40).join(', ')}`;
  return <View style={[styles.harmony, !score.written && styles.chordsOnly]} onLayout={event => setWidth(event.nativeEvent.layout.width)}
    accessible accessibilityRole="image" accessibilityLabel={label}>
    {score.written && STAFF_LINES.map(y => <View key={y} style={[styles.staffLine, { top: y }]} />)}
    <View style={styles.window}>
      <Animated.View style={[styles.flow, { opacity: width ? 1 : 0, transform: [{ translateX: offset }] }]}>
        {chunks.map(chunk => <Chunk key={chunk} score={score} chunk={chunk}
          activeChord={chord >= 0 && chunkOf(score.chords[chord].x) === chunk ? chord : -1}
          activeNote={activeNote >= 0 && chunkOf(noteX(activeNote)) === chunk ? activeNote : -1} />)}
      </Animated.View>
    </View>
    {score.drums ? <View style={styles.drumClef} />
      : score.written && <Text style={[styles.clef, clef === 'bass' ? styles.bassClef : styles.trebleClef]}>{clef === 'bass' ? '𝄢' : '𝄞'}</Text>}
    <Fades />
    <View pointerEvents="none" style={styles.now} />
  </View>;
}

// Every line keeps its timing; text can be changed, cleared to remove the line, or added in a gap.
export function LyricsEditor({ lines, duration, onSave, onClose }: {
  lines: LyricLine[]; duration: number; onSave: (lines: LyricLine[]) => Promise<void>; onClose: () => void;
}) {
  const nextId = useRef(lines.length);
  const [rows, setRows] = useState<LyricRow[]>(() => lines.map((line, id) => ({ id, start: line.start, end: line.end, text: lineText(line), words: line.words })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [discarding, setDiscarding] = useState(false);
  const add = (index: number) => {
    const gap = gapAfter(rows, index, duration);
    if (gap) setRows([...rows.slice(0, index + 1), { id: nextId.current++, ...gap, text: '' }, ...rows.slice(index + 1)]);
  };
  const save = async () => {
    setSaving(true); setError('');
    try { await onSave(editedLines(rows)); }
    catch (failure) { setError(`Could not save the lyrics: ${failure instanceof Error ? failure.message : String(failure)}`); setSaving(false); }
  };
  const cancel = () => {
    if (saving) return;
    if (firstChange(lines, editedLines(rows)) === null) onClose(); else setDiscarding(true);
  };
  const addButton = (index: number, label: string, text: string) => <Pressable onPress={() => add(index)}
    disabled={saving || !gapAfter(rows, index, duration)} accessibilityRole="button" accessibilityLabel={label}
    style={[styles.add, (saving || !gapAfter(rows, index, duration)) && { opacity: 0.4 }]}>
    <Text style={styles.addText}>{text}</Text>
  </Pressable>;
  return <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={cancel}>
    <KeyboardAvoidingView style={styles.editor} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.editorHeader}>
        <Text style={styles.editorTitle} accessibilityRole="header">Edit lyrics</Text>
        <Text style={styles.hint}>Timing stays with each line. Clear a line to remove it.</Text>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.editorLines} keyboardShouldPersistTaps="handled">
        {addButton(-1, 'Add a line at the beginning', '+ Add line')}
        {rows.map((row, index) => <View key={row.id} style={styles.editorRow}>
          <Text style={styles.time}>{formatTime(row.start)}</Text>
          <TextInput value={row.text} editable={!saving} maxLength={2000} style={styles.input}
            accessibilityLabel={`Line at ${formatTime(row.start)}`}
            onChangeText={text => setRows(current => current.map(item => item.id === row.id ? { ...item, text } : item))} />
          {addButton(index, `Add a line after ${formatTime(row.start)}`, '+')}
        </View>)}
      </ScrollView>
      {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      <View style={styles.editorFooter}>
        <Button kind="plain" label="Cancel" disabled={saving} onPress={cancel} />
        <Button label={saving ? 'Saving...' : 'Save lyrics'} disabled={saving} onPress={() => void save()} />
      </View>
    </KeyboardAvoidingView>
    {discarding && <View style={styles.backdrop}><View style={styles.dialog} accessibilityViewIsModal>
      <Text style={styles.dialogTitle}>Discard lyric changes?</Text>
      <Text style={styles.dialogMessage}>Discard your changes to the lyrics?</Text>
      <View style={styles.dialogActions}>
        <Button kind="plain" label="Cancel" onPress={() => setDiscarding(false)} />
        <Button label="Discard" onPress={onClose} />
      </View>
    </View></View>}
  </Modal>;
}

const styles = StyleSheet.create({
  fade: { position: 'absolute', top: 0, bottom: 0, width: '12%' },
  lyrics: { overflow: 'hidden', height: 36, marginTop: 10, marginHorizontal: 14, borderRadius: 6, backgroundColor: STRIP },
  // Wide enough for any song, so the words are never wrapped to the strip's width.
  lyricsFlow: { position: 'absolute', left: 0, top: 6, width: 200000, flexDirection: 'row' },
  lyricsLine: { flexDirection: 'row', gap: 7, marginRight: 34 },
  word: { color: '#697b92', fontSize: 16, lineHeight: 24 },
  wordNear: { color: '#5f7fd6' },
  wordActive: { color: '#2447b8', fontWeight: '700' },
  harmony: { height: HEIGHT, marginTop: 10, marginHorizontal: 14, borderRadius: 6, backgroundColor: STRIP, overflow: 'hidden' },
  chordsOnly: { height: 30 },
  staffLine: { position: 'absolute', left: 0, right: 0, height: 1, marginTop: -0.5, backgroundColor: '#8a99ad' },
  window: { position: 'absolute', top: 0, bottom: 0, left: 44, right: 0, overflow: 'hidden' },
  flow: { position: 'absolute', left: -44, top: 0, height: HEIGHT, width: 1 },
  clef: { position: 'absolute', left: 6, color: '#42536b' },
  trebleClef: { top: 46, fontSize: 44, lineHeight: 52 },
  bassClef: { top: 40, fontSize: 34, lineHeight: 52 },
  drumClef: { position: 'absolute', left: 12, top: 64, width: 10, height: 16, borderLeftWidth: 3, borderRightWidth: 3, borderColor: '#42536b' },
  now: { position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, backgroundColor: BLUE, opacity: 0.45 },
  editor: { flex: 1, backgroundColor: 'white', paddingTop: 56 },
  editorHeader: { paddingHorizontal: 18, paddingBottom: 12, gap: 4, borderBottomWidth: 1, borderBottomColor: LINE },
  editorTitle: { fontSize: 22, fontWeight: '700', color: INK },
  hint: { color: GREY, fontSize: 13 },
  editorLines: { padding: 18, gap: 6 },
  editorRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  time: { width: 44, color: '#697b92', fontSize: 13, fontVariant: ['tabular-nums'] },
  input: { flex: 1, borderWidth: 1, borderColor: '#aebacb', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8, fontSize: 16, color: INK },
  add: { alignSelf: 'flex-start', minHeight: 36, minWidth: 36, paddingHorizontal: 10, justifyContent: 'center', alignItems: 'center',
    borderRadius: 6, backgroundColor: '#eef2fb' },
  addText: { color: BLUE, fontWeight: '700', fontSize: 14 },
  error: { backgroundColor: '#fff0f0', color: '#a52c35', padding: 12, marginHorizontal: 18, borderRadius: 8 },
  editorFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, padding: 18, paddingBottom: 34, borderTopWidth: 1, borderTopColor: LINE },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: '#19253699', padding: 24, justifyContent: 'center' },
  dialog: { backgroundColor: 'white', borderRadius: 16, padding: 24, gap: 16 },
  dialogTitle: { fontSize: 22, fontWeight: '700', color: INK },
  dialogMessage: { fontSize: 16, lineHeight: 24, color: GREY },
  dialogActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12, flexWrap: 'wrap' },
});
