import { useLayoutEffect, useRef, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View, type GestureResponderEvent, type PanResponderGestureState } from 'react-native';

// Visual parity with the website mixer (web/src/styles.css: marker rail, waveform, console faders).
export const METAL = 'linear-gradient(180deg, #edf1f6 0%, #cbd4df 45%, #eef2f7 55%, #c4ceda 100%)';
const THUMB = 'linear-gradient(180deg, #f4f7fb 0%, #a2afbf 20%, #d8e0ea 40%, #445973 44%, #3459c9 50%, #e6ecf4 56%, #8595aa 85%, #c7d1de 100%)';
const THUMB_SIDE = 'linear-gradient(90deg, #f4f7fb 0%, #a2afbf 20%, #d8e0ea 40%, #445973 44%, #3459c9 50%, #e6ecf4 56%, #8595aa 85%, #c7d1de 100%)';
const LCD = 'linear-gradient(180deg, #253245 0%, #35465e 100%)';
const START = '#173da4', END = '#08744a', PLAYHEAD = '#c73648';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const snap = (value: number, min: number, step: number) => Math.round((value - min) / step) * step + min;

type Move = (event: GestureResponderEvent, gesture: PanResponderGestureState) => void;
// The handlers live in a mutable box so the responder always sees the latest props; claiming the
// responder (and refusing termination) keeps the surrounding ScrollView from stealing the drag.
// claim: 'start' takes the touch immediately (small targets such as markers and knobs);
// 'horizontal' waits for a mostly sideways drag, so vertical swipes still scroll the page.
interface DragHandlers { grant: Move; move: Move; release?: Move; claim?: 'start' | 'horizontal'; startsOn?: (event: GestureResponderEvent) => boolean }
function useDrag(handlers: DragHandlers) {
  const [{ handlersRef, responder }] = useState(() => createDrag(handlers));
  useLayoutEffect(() => { handlersRef.current = handlers; });
  return responder;
}
function createDrag(handlers: DragHandlers) {
  const latest = { current: handlers };
  const responder = PanResponder.create({
    onStartShouldSetPanResponder: event => latest.current.claim !== 'horizontal' && (latest.current.startsOn?.(event) ?? true),
    onMoveShouldSetPanResponder: (event, gesture) => latest.current.claim === 'horizontal'
      && Math.abs(gesture.dx) > 6 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
    onPanResponderGrant: (event, gesture) => latest.current.grant(event, gesture),
    onPanResponderMove: (event, gesture) => latest.current.move(event, gesture),
    onPanResponderRelease: (event, gesture) => latest.current.release?.(event, gesture),
    onPanResponderTerminate: (event, gesture) => latest.current.release?.(event, gesture),
  });
  return { handlersRef: latest, responder };
}

const MARKER_WIDTH = 44, EDITOR_PADDING = 14;
export function Timeline({ label, duration, start, end, position, disabled, onSection, onSeek, onReset }: {
  label: string; duration: number; start: number; end: number; position: number; disabled?: boolean;
  onSection: (start: number, end: number) => void; onSeek: (time: number) => void; onReset: () => void;
}) {
  const [width, setWidth] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const origin = useRef({ value: 0, x: 0 });
  const minimum = Math.min(.05, duration);
  const toTime = (x: number) => width > 0 ? clamp(x / width, 0, 1) * duration : 0;
  const toX = (time: number) => duration > 0 ? clamp(time / duration, 0, 1) * width : 0;
  const shown = scrub ?? position;

  const startDrag = useDrag({
    grant: () => { origin.current.value = start; },
    move: (_, g) => { if (!disabled) onSection(clamp(origin.current.value + toTime(g.dx), 0, end - minimum), end); },
  });
  const endDrag = useDrag({
    grant: () => { origin.current.value = end; },
    move: (_, g) => { if (!disabled) onSection(start, clamp(origin.current.value + toTime(g.dx), start + minimum, duration)); },
  });
  const scrubTo = (x: number) => clamp(toTime(x), start, end);
  const waveDrag = useDrag({
    claim: 'horizontal',
    grant: (event, g) => { origin.current.x = event.nativeEvent.locationX - g.dx; if (!disabled) setScrub(scrubTo(origin.current.x + g.dx)); },
    move: (_, g) => { if (!disabled) setScrub(scrubTo(origin.current.x + g.dx)); },
    release: (_, g) => { if (!disabled) onSeek(scrubTo(origin.current.x + g.dx)); setScrub(null); },
  });
  const handleDrag = useDrag({
    grant: () => { origin.current.x = toX(shown); if (!disabled) setScrub(shown); },
    move: (_, g) => { if (!disabled) setScrub(scrubTo(origin.current.x + g.dx)); },
    release: (_, g) => { if (!disabled) onSeek(scrubTo(origin.current.x + g.dx)); setScrub(null); },
  });
  const nudge = (kind: 'start' | 'end' | 'playhead', delta: number) => {
    if (kind === 'start') onSection(clamp(start + delta, 0, end - minimum), end);
    else if (kind === 'end') onSection(start, clamp(end + delta, start + minimum, duration));
    else onSeek(clamp(position + delta, start, end));
  };
  const adjustable = (kind: 'start' | 'end' | 'playhead', value: number, min: number, max: number) => ({
    accessible: true, accessibilityRole: 'adjustable' as const,
    accessibilityValue: { min: Math.round(min), max: Math.round(max), now: Math.round(value), text: `${value.toFixed(2)} seconds` },
    accessibilityActions: [{ name: 'increment' as const }, { name: 'decrement' as const }],
    onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) =>
      nudge(kind, event.nativeEvent.actionName === 'increment' ? 1 : -1),
  });
  const ticks = [0, .25, .5, .75, 1];
  const changed = start > 0 || end < duration;

  return <View style={styles.editor}>
    <View style={styles.rail} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
      {width > 0 && <>
        <View {...startDrag.panHandlers} {...adjustable('start', start, 0, end)} accessibilityLabel={`${label} start marker`}
          style={[styles.marker, { left: toX(start) - MARKER_WIDTH / 2 }]} hitSlop={6}>
          <Text style={[styles.markerLetter, { color: START }]}>S</Text>
          <View style={[styles.arrow, { borderTopColor: START }]} />
        </View>
        <View {...endDrag.panHandlers} {...adjustable('end', end, start, duration)} accessibilityLabel={`${label} end marker`}
          style={[styles.marker, { left: toX(end) - MARKER_WIDTH / 2 }]} hitSlop={6}>
          <Text style={[styles.markerLetter, { color: END }]}>E</Text>
          <View style={[styles.arrow, { borderTopColor: END }]} />
        </View>
      </>}
    </View>
    <View style={styles.wave} {...waveDrag.panHandlers} accessibilityLabel={`${label} timeline; drag to scrub all stems`}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {ticks.map(tick => <View key={tick} style={[styles.tick, { left: `${tick * 100}%` }]} />)}
        <View style={styles.centerLine} />
        <View style={[styles.highlight, { left: toX(start), width: Math.max(0, toX(end) - toX(start)) }]} />
        <View style={[styles.sectionLine, { left: toX(start) - 1 }]} />
        <View style={[styles.sectionLine, { left: toX(end) - 1 }]} />
        <View style={[styles.playedBar, { left: toX(start), width: Math.max(0, toX(shown) - toX(start)) }]} />
        <View style={[styles.playhead, { left: toX(shown) - 1 }]} />
      </View>
    </View>
    {width > 0 && <View {...handleDrag.panHandlers} {...adjustable('playhead', shown, start, end)}
      accessibilityLabel={`${label} playhead`} hitSlop={8}
      style={[styles.playheadHandle, { left: EDITOR_PADDING + toX(shown) - 22 }]}>
      <View style={styles.grip} />
    </View>}
    <View style={styles.times}>
      <View style={styles.timeStart}>
        <Pressable onPress={onReset} disabled={!changed} accessibilityRole="button"
          accessibilityLabel={`${label} reset loop interval to the whole song`}
          style={[styles.resetButton, !changed && { opacity: .45 }]}>
          <Text style={styles.resetText}>Reset</Text>
        </Pressable>
        <Text style={[styles.timeText, { color: START }]}>Start {start.toFixed(2)}s</Text>
      </View>
      <Text style={[styles.timeText, { color: PLAYHEAD }]}>Playing {shown.toFixed(2)}s</Text>
      <Text style={[styles.timeText, { color: END }]}>End {end.toFixed(2)}s</Text>
    </View>
  </View>;
}

const WELL = 150, THUMB_HEIGHT = 24;
export function ChannelStrip({ label, display, value, min, max, step, disabled, note, onChange }: {
  label: string; display: string; value: number; min: number; max: number; step: number;
  disabled?: boolean; note: string; onChange: (value: number) => void;
}) {
  const origin = useRef(0);
  const travel = WELL - THUMB_HEIGHT;
  const fraction = max > min ? clamp((value - min) / (max - min), 0, 1) : 0;
  const fromY = (y: number) => snap(clamp(min + (1 - clamp((y - THUMB_HEIGHT / 2) / travel, 0, 1)) * (max - min), min, max), min, step);
  const knobCentre = (1 - fraction) * travel + THUMB_HEIGHT / 2;
  const drag = useDrag({
    startsOn: event => !disabled && Math.abs(event.nativeEvent.locationY - knobCentre) <= 22,
    grant: () => { origin.current = knobCentre; },
    move: (_, g) => { if (!disabled) onChange(fromY(origin.current + g.dy)); },
  });
  const scale = [1, .75, .5, .25, 0];
  const format = (number: number) => Number.isInteger(number) ? String(number) : number.toFixed(1);
  return <View style={[styles.strip, disabled && { opacity: .5 }]}>
    <Text style={styles.stripName} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={.7}>{label.toUpperCase()}</Text>
    <View style={styles.lcd}><Text style={styles.lcdText} numberOfLines={1}>{display}</Text></View>
    <View style={styles.well}>
      <View pointerEvents="none" style={styles.scale}>
        {scale.map(item => <View key={item} style={[styles.scaleRow, { top: THUMB_HEIGHT / 2 + (1 - item) * travel - 6 }]}>
          <Text style={styles.scaleText}>{format(min + (max - min) * item)}</Text><View style={styles.scaleTick} />
        </View>)}
      </View>
      <View {...drag.panHandlers} style={styles.faderTouch} accessible accessibilityRole="adjustable"
        accessibilityLabel={label} accessibilityValue={{ min, max, now: value, text: display }}
        accessibilityState={{ disabled }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={event => !disabled && onChange(clamp(value + (event.nativeEvent.actionName === 'increment' ? step : -step) * (step < 1 ? 2 : 5), min, max))}>
        <View pointerEvents="none" style={styles.track} />
        <View pointerEvents="none" style={[styles.thumb, { top: (1 - fraction) * travel }]} />
      </View>
    </View>
    <Text style={styles.note} numberOfLines={1}>{note}</Text>
  </View>;
}

export function MasterFader({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [width, setWidth] = useState(0);
  const origin = useRef(0);
  const thumb = 24, travel = Math.max(1, width - thumb);
  const fromX = (x: number) => Math.round(clamp((x - thumb / 2) / travel, 0, 1) * 100);
  const drag = useDrag({
    claim: 'horizontal',
    grant: (event, g) => { origin.current = event.nativeEvent.locationX - g.dx; onChange(fromX(origin.current + g.dx)); },
    move: (_, g) => onChange(fromX(origin.current + g.dx)),
  });
  return <View style={styles.master}>
    <Text style={styles.stripName}>MASTER</Text>
    <View style={styles.masterWell} onLayout={event => setWidth(event.nativeEvent.layout.width)} {...drag.panHandlers}
      accessible accessibilityRole="adjustable" accessibilityLabel="Master volume"
      accessibilityValue={{ min: 0, max: 100, now: value, text: `${value}%` }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={event => onChange(clamp(value + (event.nativeEvent.actionName === 'increment' ? 5 : -5), 0, 100))}>
      <View pointerEvents="none" style={styles.masterTrack} />
      <View pointerEvents="none" style={[styles.masterThumb, { left: value / 100 * travel }]} />
    </View>
    <View style={[styles.lcd, { width: 56, marginBottom: 0 }]}><Text style={styles.lcdText}>{value}%</Text></View>
  </View>;
}

export function LampSwitch({ label, on, onPress, disabled, accessibilityLabel }: {
  label: string; on: boolean; onPress: () => void; disabled?: boolean; accessibilityLabel?: string;
}) {
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="switch"
    accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ checked: on, disabled }}
    style={({ pressed }) => [styles.switch, pressed && { opacity: .75 }, disabled && { opacity: .45 }]}>
    <View style={[styles.lamp, on && styles.lampOn]} />
    <Text style={styles.switchText}>{label.toUpperCase()}</Text>
  </Pressable>;
}

export function ConsoleButton({ label, onPress, disabled, primary, accessibilityLabel }: {
  label: string; onPress: () => void; disabled?: boolean; primary?: boolean; accessibilityLabel?: string;
}) {
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label}
    accessibilityState={{ disabled }}
    style={({ pressed }) => [styles.consoleButton, primary && styles.consolePrimary, pressed && { opacity: .75 }, disabled && { opacity: .45 }]}>
    <Text style={[styles.consoleButtonText, primary && { color: 'white' }]}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  editor: { paddingHorizontal: EDITOR_PADDING, paddingTop: 4 },
  rail: { height: 38, position: 'relative' },
  marker: { position: 'absolute', top: 0, width: MARKER_WIDTH, height: 38, alignItems: 'center', justifyContent: 'flex-end', zIndex: 2 },
  markerLetter: { fontSize: 12, fontWeight: '800', lineHeight: 14 },
  arrow: { width: 0, height: 0, borderLeftWidth: 10, borderRightWidth: 10, borderTopWidth: 16, borderLeftColor: 'transparent', borderRightColor: 'transparent' },
  wave: { height: 64, backgroundColor: '#f3f6fd', borderRadius: 4, borderWidth: 1, borderColor: '#d7deeb', overflow: 'hidden' },
  tick: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: '#dfe5f1' },
  centerLine: { position: 'absolute', left: 0, right: 0, top: 31, height: 2, backgroundColor: '#b9c6e4' },
  highlight: { position: 'absolute', top: 0, bottom: 0, backgroundColor: '#3459c933' },
  sectionLine: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: START },
  playedBar: { position: 'absolute', top: 29, height: 6, backgroundColor: '#3459c9', borderRadius: 3 },
  playhead: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: PLAYHEAD },
  playheadHandle: { position: 'absolute', top: 38 + 64 - 14, width: 44, height: 44, alignItems: 'center', zIndex: 3 },
  grip: { width: 12, height: 12, backgroundColor: PLAYHEAD, borderRadius: 2, borderWidth: 2, borderColor: 'white', marginTop: 8 },
  times: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 26, gap: 8 },
  timeStart: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  timeText: { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  resetButton: { paddingHorizontal: 10, minHeight: 32, justifyContent: 'center', borderRadius: 6, borderWidth: 1, borderColor: '#a9b5c5', backgroundColor: 'white' },
  resetText: { fontSize: 12, fontWeight: '700', color: '#28384e' },
  strip: { width: 74, alignItems: 'center', paddingVertical: 10, paddingHorizontal: 4, borderRightWidth: 1, borderRightColor: '#a9b5c5' },
  stripName: { fontSize: 10, lineHeight: 14, height: 14, fontWeight: '800', letterSpacing: .6, color: '#28384e', marginBottom: 6 },
  lcd: { backgroundImage: LCD, borderRadius: 3, borderWidth: 1, borderColor: '#151e2b', paddingVertical: 3, paddingHorizontal: 4, width: 62, marginBottom: 8 },
  lcdText: { color: '#c2d8ff', fontFamily: 'Menlo', fontSize: 11, textAlign: 'center', fontVariant: ['tabular-nums'] },
  well: { height: WELL, width: 66, flexDirection: 'row' },
  scale: { width: 26, height: WELL },
  scaleRow: { position: 'absolute', right: 0, flexDirection: 'row', alignItems: 'center', gap: 2 },
  scaleText: { fontSize: 8, color: '#4b5b72', fontVariant: ['tabular-nums'] },
  scaleTick: { width: 4, height: 1, backgroundColor: '#4b5b72' },
  faderTouch: { width: 40, height: WELL, alignItems: 'center' },
  track: { position: 'absolute', top: THUMB_HEIGHT / 2, bottom: THUMB_HEIGHT / 2, width: 4, backgroundColor: '#35445a', borderRadius: 2, borderWidth: 1, borderColor: '#1d2836' },
  thumb: { position: 'absolute', width: 36, height: THUMB_HEIGHT, borderRadius: 3, borderWidth: 1, borderColor: '#718198', backgroundImage: THUMB,
    shadowColor: '#000', shadowOpacity: .35, shadowRadius: 2, shadowOffset: { width: 0, height: 2 } },
  note: { fontSize: 9, color: '#4b5b72', marginTop: 6 },
  master: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8 },
  masterWell: { flex: 1, height: 44, justifyContent: 'center' },
  masterTrack: { position: 'absolute', left: 12, right: 12, height: 4, backgroundColor: '#35445a', borderRadius: 2, borderWidth: 1, borderColor: '#1d2836' },
  masterThumb: { position: 'absolute', width: 24, height: 36, borderRadius: 3, borderWidth: 1, borderColor: '#718198', backgroundImage: THUMB_SIDE,
    shadowColor: '#000', shadowOpacity: .35, shadowRadius: 2, shadowOffset: { width: 0, height: 2 } },
  switch: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 44, paddingHorizontal: 10, borderRadius: 5, borderWidth: 1, borderColor: '#8f9db0',
    backgroundImage: 'linear-gradient(180deg, #fbfcfe 0%, #d5dce6 100%)' },
  lamp: { width: 28, height: 18, borderRadius: 3, borderWidth: 2, borderColor: '#697b92', backgroundColor: '#8e9aab' },
  lampOn: { backgroundColor: '#a3c5ff', borderColor: '#3459c9', shadowColor: '#5d8dff', shadowOpacity: .9, shadowRadius: 5, shadowOffset: { width: 0, height: 0 } },
  switchText: { fontSize: 11, fontWeight: '800', letterSpacing: .5, color: '#28384e' },
  consoleButton: { minHeight: 44, paddingHorizontal: 14, borderRadius: 6, justifyContent: 'center', borderWidth: 1, borderColor: '#8f9db0', backgroundColor: 'white' },
  consolePrimary: { backgroundColor: '#3459c9', borderColor: '#2747a8' },
  consoleButtonText: { fontWeight: '700', color: '#28384e' },
});
