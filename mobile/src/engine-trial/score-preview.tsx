import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { DrumHit, HarmonyGrid, HarmonyPart, LyricLine } from '../api';
import { HarmonyStrip, LyricsStrip } from '../score-view';

// Sample lyrics and scores at 120 bpm, so the simulator shows the strips without signing in.
const BEATS = Array.from({ length: 48 }, (_, beat) => beat * 0.5);
const GRID: HarmonyGrid = { beats: BEATS, firstBar: 0 };
const LYRICS: LyricLine[] = [
  { start: 1, end: 4, words: ['Twinkle', 'twinkle', 'little', 'star'].map((text, index) => ({ start: 1 + index * 0.7, end: 1.6 + index * 0.7, text })) },
  { start: 5, end: 8, words: ['How', 'I', 'wonder', 'what', 'you', 'are'].map((text, index) => ({ start: 5 + index * 0.5, end: 5.4 + index * 0.5, text })) },
];
const MELODY = [60, 60, 67, 67, 69, 69, 67, 65, 65, 64, 64, 62, 62, 60];
const PIANO: HarmonyPart = {
  chords: [{ start: 0, name: 'C' }, { start: 2, name: 'F' }, { start: 3, name: 'C' }, { start: 4, name: 'G7' }, { start: 6, name: 'C' }],
  notes: MELODY.map((pitch, index) => ({ start: index * 0.5, end: index * 0.5 + 0.5, pitch, unit: index * 4 + (index > 6 ? 4 : 0), length: index === 6 || index === 13 ? 8 : 4 })),
};
const BASS: HarmonyPart = {
  chords: [], notes: [{ start: 0, end: 1, pitch: 36, unit: 0, length: 6 }, { start: 1, end: 2, pitch: 43, unit: 6, length: 2 },
    { start: 2, end: 3, pitch: 41, unit: 8, length: 3 }, { start: 3, end: 4, pitch: 42, unit: 12, length: 8 }],
};
const DRUMS: HarmonyPart = {
  chords: [], notes: [], patterns: [{ unit: 0, label: 'A' }, { unit: 16, label: 'A' }, { unit: 32, label: 'B' }],
  hits: Array.from({ length: 48 }, (_, unit): DrumHit[] => [
    ...(unit % 2 === 0 ? [{ unit, drum: 'hihat' as const }] : []),
    ...(unit % 8 === 0 ? [{ unit, drum: 'kick' as const }] : []),
    ...(unit % 8 === 4 ? [{ unit, drum: 'snare' as const }] : []),
    ...(unit === 32 ? [{ unit, drum: 'cymbal' as const }] : []),
  ]).flat(),
};

export function ScorePreview() {
  const [time, setTime] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setTime(((Date.now() - started) / 1000) % 12), 100);
    return () => clearInterval(timer);
  }, []);
  return <View style={{ backgroundColor: 'white', borderRadius: 10, paddingVertical: 12 }}>
    <Text style={{ marginHorizontal: 14, fontWeight: '700' }}>Score preview {time.toFixed(1)}s</Text>
    <LyricsStrip lines={LYRICS} time={time} />
    <HarmonyStrip part={PIANO} stem="piano" grid={GRID} time={time} />
    <HarmonyStrip part={BASS} stem="bass" grid={GRID} time={time} />
    <HarmonyStrip part={DRUMS} stem="drums" grid={GRID} time={time} />
  </View>;
}
