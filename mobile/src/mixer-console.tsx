import { useLayoutEffect, useRef, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, TextInput, View, type GestureResponderEvent, type PanResponderGestureState } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { type Theme, useStyles, useTheme } from './theme';

// Visual parity with the website mixer (web/src/styles.css: marker rail, waveform, console faders).
const THUMB = 'linear-gradient(180deg, #f4f7fb 0%, #a2afbf 20%, #d8e0ea 40%, #445973 44%, #3459c9 50%, #e6ecf4 56%, #8595aa 85%, #c7d1de 100%)';
const THUMB_SIDE = 'linear-gradient(90deg, #f4f7fb 0%, #a2afbf 20%, #d8e0ea 40%, #445973 44%, #3459c9 50%, #e6ecf4 56%, #8595aa 85%, #c7d1de 100%)';
const LCD = 'linear-gradient(180deg, #253245 0%, #35465e 100%)';

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

const MARKER_WIDTH = 44, EDITOR_PADDING = 14, RAIL = 28, WAVE = 44, HANDLE = 32;
export function Timeline({ label, duration, start, end, position, peaks, disabled, onSection, onSeek, onReset }: {
  label: string; duration: number; start: number; end: number; position: number; peaks?: number[]; disabled?: boolean;
  onSection: (start: number, end: number) => void; onSeek: (time: number) => void; onReset: () => void;
}) {
  const styles = useStyles(makeStyles), { start: START, end: END, playhead: PLAYHEAD, waveBar, waveBarDim } = useTheme();
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
        {peaks?.length ? <Svg width="100%" height="100%" viewBox={`0 0 ${peaks.length * 6} ${WAVE}`} preserveAspectRatio="none">
          {peaks.map((peak, index) => {
            const height = Math.max(2, peak * (WAVE - 6));
            const played = duration > 0 && (index + .5) / peaks.length * duration <= shown;
            return <Rect key={index} x={index * 6 + 1} y={(WAVE - height) / 2} width={4} height={height} rx={1}
              fill={played ? waveBar : waveBarDim} />;
          })}
        </Svg> : <View style={styles.centerLine} />}
        <View style={[styles.highlight, { left: toX(start), width: Math.max(0, toX(end) - toX(start)) }]} />
        <View style={[styles.sectionLine, { left: toX(start) - 1 }]} />
        <View style={[styles.sectionLine, { left: toX(end) - 1 }]} />
        {!peaks?.length && <View style={[styles.playedBar, { left: toX(start), width: Math.max(0, toX(shown) - toX(start)) }]} />}
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
  const styles = useStyles(makeStyles);
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

export function MasterFader({ value, onChange, label = 'Master' }: { value: number; onChange: (value: number) => void; label?: string }) {
  const styles = useStyles(makeStyles);
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
    <Text style={styles.stripName}>{label.toUpperCase()}</Text>
    <View style={styles.masterWell} onLayout={event => setWidth(event.nativeEvent.layout.width)} {...drag.panHandlers}
      accessible accessibilityRole="adjustable" accessibilityLabel={`${label} volume`}
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
  const styles = useStyles(makeStyles);
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="switch"
    accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ checked: on, disabled }}
    style={({ pressed }) => [styles.switch, pressed && { opacity: .75 }, disabled && { opacity: .45 }]}>
    <View style={[styles.lamp, on && styles.lampOn]} />
    <Text style={styles.switchText}>{label.toUpperCase()}</Text>
  </Pressable>;
}

export type IconName = 'play' | 'pause' | 'stop' | 'mute' | 'muteAll' | 'solo' | 'loop'
  | 'moveEarlier' | 'moveLater' | 'previous' | 'next' | 'remove' | 'reload' | 'reset' | 'edit' | 'add' | 'save' | 'close' | 'record';

function Icon({ name, color }: { name: IconName; color: string }) {
  const line = { stroke: color, strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  const speaker = (x: number) => `M${x} 9h3.5l4.5-4v14l-4.5-4H${x}z`;
  return <Svg width={20} height={20} viewBox="0 0 24 24">
    {name === 'play' && <Path d="M7 4.5v15l12.5-7.5z" fill={color} />}
    {name === 'pause' && <><Rect x={5.5} y={4.5} width={4.5} height={15} rx={1} fill={color} /><Rect x={14} y={4.5} width={4.5} height={15} rx={1} fill={color} /></>}
    {name === 'stop' && <Rect x={5.5} y={5.5} width={13} height={13} rx={1.5} fill={color} />}
    {name === 'mute' && <><Path d={speaker(3)} fill={color} /><Path d="M15.5 9l6 6M21.5 9l-6 6" {...line} /></>}
    {name === 'muteAll' && <><Path d={speaker(5)} {...line} strokeWidth={1.5} /><Path d={speaker(1)} fill={color} />
      <Path d="M16 9l6 6M22 9l-6 6" {...line} /></>}
    {name === 'solo' && <><Path d="M4 16v-4a8 8 0 0 1 16 0v4" {...line} />
      <Rect x={3} y={14} width={5} height={7} rx={1.5} fill={color} /><Rect x={16} y={14} width={5} height={7} rx={1.5} fill={color} /></>}
    {name === 'loop' && <><Path d="M4 12V9.5A3.5 3.5 0 0 1 7.5 6H19M16 3l3 3-3 3" {...line} />
      <Path d="M20 12v2.5a3.5 3.5 0 0 1-3.5 3.5H5M8 21l-3-3 3-3" {...line} /></>}
    {name === 'moveEarlier' && <Path d="M20 12H4M10 6l-6 6 6 6" {...line} strokeWidth={2.4} />}
    {name === 'moveLater' && <Path d="M4 12h16M14 6l6 6-6 6" {...line} strokeWidth={2.4} />}
    {name === 'previous' && <><Rect x={4} y={5} width={2.5} height={14} rx={1} fill={color} /><Path d="M19.5 5v14L8 12z" fill={color} /></>}
    {name === 'next' && <><Rect x={17.5} y={5} width={2.5} height={14} rx={1} fill={color} /><Path d="M4.5 5v14L16 12z" fill={color} /></>}
    {name === 'remove' && <Path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5" {...line} />}
    {name === 'reload' && <Path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5" {...line} />}
    {name === 'reset' && <Path d="M4 12a8 8 0 1 0 2.6-5.9M4 4v5h5M9 12h6M12 9v6" {...line} />}
    {name === 'edit' && <Path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4" {...line} />}
    {name === 'add' && <Path d="M12 4.5v15M4.5 12h15" {...line} strokeWidth={2.6} />}
    {name === 'save' && <Path d="M4.5 12.5l5 5L19.5 7" {...line} strokeWidth={2.6} />}
    {name === 'close' && <Path d="M6 6l12 12M18 6L6 18" {...line} strokeWidth={2.4} />}
    {name === 'record' && <Path d="M12 5a7 7 0 1 1 0 14a7 7 0 1 1 0-14z" fill={color} />}
  </Svg>;
}

// A small metal key with an icon; lit blue while its switch is on, solid blue for the main action.
export function IconButton({ icon, accessibilityLabel, onPress, disabled, on, primary, danger, bare }: {
  icon: IconName; accessibilityLabel: string; onPress: () => void; disabled?: boolean; on?: boolean; primary?: boolean; danger?: boolean;
  // Just the icon, no key: blue while on, grey otherwise.
  bare?: boolean;
}) {
  const styles = useStyles(makeStyles), theme = useTheme();
  if (bare) return <Pressable onPress={onPress} disabled={disabled} hitSlop={10}
    accessibilityRole={on === undefined ? 'button' : 'switch'} accessibilityLabel={accessibilityLabel}
    accessibilityState={on === undefined ? { disabled } : { checked: on, disabled }}
    style={({ pressed }) => [styles.iconBare, pressed && { opacity: .5 }, disabled && { opacity: .45 }]}>
    <Icon name={icon} color={on ? theme.accent : theme.muted} />
  </Pressable>;
  const lit = primary || on;
  return <Pressable onPress={onPress} disabled={disabled} hitSlop={4}
    accessibilityRole={on === undefined ? 'button' : 'switch'} accessibilityLabel={accessibilityLabel}
    accessibilityState={on === undefined ? { disabled } : { checked: on, disabled }}
    style={({ pressed }) => [styles.iconButton, !lit && styles.iconMetal, on && styles.iconOn, primary && styles.iconPrimary, lit && !!theme.accentImage && styles.iconChrome,
      pressed && { opacity: .75 }, disabled && { opacity: .45 }]}>
    <Icon name={icon} color={lit ? theme.onConsoleAccent ?? 'white' : danger ? theme.danger : theme.keyInk} />
  </Pressable>;
}

const makeStyles = (t: Theme) => StyleSheet.create({
  iconButton: { width: 38, height: 38, borderRadius: 6, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: t.keyBorder },
  iconBare: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  iconMetal: { backgroundImage: t.key },
  iconOn: { backgroundColor: t.consoleAccent, borderColor: t.consoleAccent,
    shadowColor: t.consoleAccent, shadowOpacity: .9, shadowRadius: 5, shadowOffset: { width: 0, height: 0 } },
  iconPrimary: { backgroundColor: t.consoleAccent, borderColor: t.consoleAccent },
  iconChrome: { backgroundImage: t.accentImage, borderColor: '#ffffffaa' },
  inlineEdit: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  inlineInput: { flex: 1, backgroundColor: t.input, borderWidth: 1, borderColor: t.line, borderRadius: 9, paddingHorizontal: 12,
    height: 44, color: t.ink, fontSize: 16 },
  editor: { paddingHorizontal: EDITOR_PADDING, paddingTop: 4 },
  rail: { height: RAIL, position: 'relative' },
  marker: { position: 'absolute', top: 0, width: MARKER_WIDTH, height: RAIL, alignItems: 'center', justifyContent: 'flex-end', zIndex: 2 },
  markerLetter: { fontSize: 11, fontWeight: '800', lineHeight: 13 },
  arrow: { width: 0, height: 0, borderLeftWidth: 8, borderRightWidth: 8, borderTopWidth: 13, borderLeftColor: 'transparent', borderRightColor: 'transparent' },
  wave: { height: WAVE, backgroundColor: t.wave, borderRadius: 4, borderWidth: 1, borderColor: t.waveLine, overflow: 'hidden' },
  tick: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: t.waveLine },
  centerLine: { position: 'absolute', left: 0, right: 0, top: WAVE / 2 - 1, height: 2, backgroundColor: t.waveBarDim },
  highlight: { position: 'absolute', top: 0, bottom: 0, backgroundColor: t.waveBar + '22' },
  sectionLine: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: t.start },
  playedBar: { position: 'absolute', top: WAVE / 2 - 3, height: 6, backgroundColor: t.waveBar, borderRadius: 3 },
  playhead: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: t.playhead },
  playheadHandle: { position: 'absolute', top: RAIL + WAVE - 14, width: 44, height: HANDLE, alignItems: 'center', zIndex: 3 },
  grip: { width: 12, height: 12, backgroundColor: t.playhead, borderRadius: 2, borderWidth: 2, borderColor: 'white', marginTop: 8 },
  times: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: HANDLE - 14 + 4, gap: 8 },
  timeStart: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  timeText: { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  resetButton: { paddingHorizontal: 10, minHeight: 32, justifyContent: 'center', borderRadius: 6, borderWidth: 1, borderColor: t.keyBorder, backgroundImage: t.key },
  resetText: { fontSize: 12, fontWeight: '700', color: t.keyInk },
  strip: { width: 74, alignItems: 'center', paddingVertical: 10, paddingHorizontal: 4, borderRightWidth: 1, borderRightColor: t.consoleLine },
  stripName: { fontSize: 10, lineHeight: 14, height: 14, fontWeight: '800', letterSpacing: .6, color: t.consoleInk, marginBottom: 6 },
  lcd: { backgroundImage: LCD, borderRadius: 3, borderWidth: 1, borderColor: '#151e2b', paddingVertical: 3, paddingHorizontal: 4, width: 62, marginBottom: 8 },
  lcdText: { color: '#c2d8ff', fontFamily: 'Menlo', fontSize: 11, textAlign: 'center', fontVariant: ['tabular-nums'] },
  well: { height: WELL, width: 66, flexDirection: 'row' },
  scale: { width: 26, height: WELL },
  scaleRow: { position: 'absolute', right: 0, flexDirection: 'row', alignItems: 'center', gap: 2 },
  scaleText: { fontSize: 8, color: t.consoleMuted, fontVariant: ['tabular-nums'] },
  scaleTick: { width: 4, height: 1, backgroundColor: t.consoleMuted },
  faderTouch: { width: 40, height: WELL, alignItems: 'center' },
  track: { position: 'absolute', top: THUMB_HEIGHT / 2, bottom: THUMB_HEIGHT / 2, width: 4, backgroundColor: '#35445a', borderRadius: 2, borderWidth: 1, borderColor: '#1d2836' },
  thumb: { position: 'absolute', width: 36, height: THUMB_HEIGHT, borderRadius: 3, borderWidth: 1, borderColor: '#718198', backgroundImage: THUMB,
    shadowColor: '#000', shadowOpacity: .35, shadowRadius: 2, shadowOffset: { width: 0, height: 2 } },
  note: { fontSize: 9, color: t.consoleMuted, marginTop: 6 },
  master: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8 },
  masterWell: { flex: 1, height: 44, justifyContent: 'center' },
  masterTrack: { position: 'absolute', left: 12, right: 12, height: 4, backgroundColor: '#35445a', borderRadius: 2, borderWidth: 1, borderColor: '#1d2836' },
  masterThumb: { position: 'absolute', width: 24, height: 36, borderRadius: 3, borderWidth: 1, borderColor: '#718198', backgroundImage: THUMB_SIDE,
    shadowColor: '#000', shadowOpacity: .35, shadowRadius: 2, shadowOffset: { width: 0, height: 2 } },
  switch: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 44, paddingHorizontal: 10, borderRadius: 5, borderWidth: 1, borderColor: t.keyBorder,
    backgroundImage: t.key },
  lamp: { width: 28, height: 18, borderRadius: 3, borderWidth: 2, borderColor: '#697b92', backgroundColor: '#8e9aab' },
  lampOn: { backgroundColor: '#a3c5ff', borderColor: '#3459c9', shadowColor: '#5d8dff', shadowOpacity: .9, shadowRadius: 5, shadowOffset: { width: 0, height: 0 } },
  switchText: { fontSize: 11, fontWeight: '800', letterSpacing: .5, color: t.keyInk },
});

// A text box with save and close keys; nothing changes until save is pressed.
export function InlineEdit({ label, initial, placeholder, onSave, onClose }: {
  label: string; initial: string; placeholder?: string; onSave: (value: string) => void; onClose: () => void;
}) {
  const styles = useStyles(makeStyles), theme = useTheme();
  const [value, setValue] = useState(initial);
  const save = () => { onSave(value); onClose(); };
  return <View style={styles.inlineEdit}>
    <TextInput autoFocus value={value} onChangeText={setValue} placeholder={placeholder} maxLength={200}
      accessibilityLabel={label} returnKeyType="done" onSubmitEditing={save} style={styles.inlineInput} placeholderTextColor={theme.muted} />
    <IconButton primary icon="save" accessibilityLabel={`Save ${label.toLowerCase()}`} onPress={save} />
    <IconButton icon="close" accessibilityLabel={`Close ${label.toLowerCase()} without saving`} onPress={onClose} />
  </View>;
}
