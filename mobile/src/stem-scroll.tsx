import { createContext, useContext, useEffect, useLayoutEffect, useState, type ComponentRef, type ReactNode } from 'react';
import {
  Animated, PanResponder, ScrollView, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewProps,
} from 'react-native';

import { useT } from './language';
import { FOCUS_LINE, type Viewport } from './stem-focus';
import { useTheme } from './theme';

class StemScroll {
  private view: ComponentRef<typeof ScrollView> | null = null;
  private offset = 0;
  private frame: { top: number; height: number } | null = null;
  private listeners = new Set<(viewport: Viewport) => void>();
  attach(view: ComponentRef<typeof ScrollView> | null) { this.view = view; }
  measure() { this.view?.measureInWindow((_x, top, _width, height) => { this.frame = { top, height }; }); }
  onScroll(listener: (viewport: Viewport) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  get position() { return this.offset; }
  scrollTo(y: number) { this.view?.scrollTo({ y: Math.max(0, y), animated: false }); }
  scrollBy(dy: number) {
    if (Math.abs(dy) >= 1) this.scrollTo(this.offset + dy);
  }
  moved({ nativeEvent: { contentOffset, layoutMeasurement, contentSize } }: NativeSyntheticEvent<NativeScrollEvent>) {
    this.offset = contentOffset.y;
    if (!this.frame) return this.measure();
    const atEnd = contentOffset.y + layoutMeasurement.height >= contentSize.height - 8;
    const viewport = { top: this.frame.top, bottom: this.frame.top + this.frame.height, atEnd };
    this.listeners.forEach(listener => listener(viewport));
  }
}

const Context = createContext<StemScroll | null>(null);
export const useStemScroll = () => useContext(Context);

// The rails lie over the page at the screen's edges: a bar to see, a wider strip to touch. The mixers reach the
// edges underneath, and keep their controls at least EDGE in from them so a touch on a control never lands on a rail.
const RAIL = 27, SHORTEST_THUMB = 64, THUMB = 12;
export const EDGE = 28;
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

interface Sizes { view: number; content: number; offset: number }

function geometry({ view, content }: Sizes) {
  const range = Math.max(content - view, 0);
  const thumb = range > 0 ? clamp(view * view / content, SHORTEST_THUMB, view) : view;
  return { range, travel: Math.max(view - thumb, 1), thumb };
}

// The rails stay faint so they do not cover the page, and darken while the page is scrolling or a rail is held.
class RailFade {
  readonly value = new Animated.Value(0);
  private holding = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private to(target: number, duration: number) {
    Animated.timing(this.value, { toValue: target, duration, useNativeDriver: true }).start();
  }
  show() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.to(1, 120);
  }
  hold(holding: boolean) {
    this.holding = holding;
    if (holding) this.show(); else this.hideSoon();
  }
  hideSoon() {
    if (this.holding) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.to(0, 200); }, 150);
  }
}

// While a fader or other mixer control is held, the rails get out of the way entirely, and come back on release.
// A release can be lost (a cancelled touch, a control that unmounts mid-drag), so while hidden they are checked
// every three seconds and shown again if nothing has moved since the last check.
const WATCH_MS = 3000;
class RailCover {
  private hidden = false;
  private moved = false;
  private watch: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(hidden: boolean) => void>();
  subscribe(listener: (hidden: boolean) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private set(hidden: boolean) {
    if (this.watch) clearInterval(this.watch);
    this.watch = hidden ? setInterval(() => { if (!this.moved) this.set(false); this.moved = false; }, WATCH_MS) : null;
    this.moved = false;
    if (hidden !== this.hidden) { this.hidden = hidden; this.listeners.forEach(listener => listener(hidden)); }
  }
  press() { this.set(true); }
  move() { this.moved = true; }
  release() { this.set(false); }
}
export const railCover = new RailCover();

// Built outside React, as useDrag in mixer-console.tsx is, so the responder reads the latest sizes.
function createRail(scroll: StemScroll, fade: RailFade) {
  const latest = { current: { view: 0, content: 0, offset: 0 } as Sizes };
  let start = 0;
  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: event => {
      fade.hold(true);
      const { range, travel, thumb } = geometry(latest.current);
      const top = latest.current.offset / Math.max(range, 1) * travel;
      const y = event.nativeEvent.locationY;
      // A touch beside the thumb jumps there first, so the rail also works as a quick index.
      start = y >= top && y <= top + thumb ? top : clamp(y - thumb / 2, 0, travel);
      scroll.scrollTo(start / travel * range);
    },
    onPanResponderMove: (_event, gesture) => {
      const { range, travel } = geometry(latest.current);
      scroll.scrollTo(clamp(start + gesture.dy, 0, travel) / travel * range);
    },
    onPanResponderRelease: () => fade.hold(false),
    onPanResponderTerminate: () => fade.hold(false),
  });
  return { sizesRef: latest, responder };
}

// A rail at the screen's edge that scrolls the page. The page itself does not follow a finger, because
// dragging a fader would otherwise scroll the stems along with it.
function ScrollRail({ scroll, sizes, side, fade, hidden }: {
  scroll: StemScroll; sizes: Sizes; side: 'left' | 'right'; fade: RailFade; hidden: boolean;
}) {
  const theme = useTheme(), t = useT();
  const [{ sizesRef, responder }] = useState(() => createRail(scroll, fade));
  useLayoutEffect(() => { sizesRef.current = sizes; });
  const { range, travel, thumb } = geometry(sizes);
  const top = range > 0 ? sizes.offset / range * travel : 0;
  const page = (direction: number) => scroll.scrollTo(clamp(sizes.offset + direction * sizes.view * .8, 0, range));
  return <View {...responder.panHandlers} pointerEvents={hidden ? 'none' : 'auto'} style={[styles.rail, { [side]: 0, opacity: hidden ? 0 : 1 }]}
    accessible accessibilityRole="adjustable" accessibilityLabel={t('scroll.rail')}
    accessibilityValue={{ min: 0, max: 100, now: range > 0 ? Math.round(sizes.offset / range * 100) : 0 }}
    accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
    onAccessibilityAction={event => page(event.nativeEvent.actionName === 'increment' ? 1 : -1)}>
    <Animated.View pointerEvents="none" style={[styles.track, { backgroundColor: theme.surface, borderColor: theme.line,
      opacity: fade.value.interpolate({ inputRange: [0, 1], outputRange: [.12, .55] }) }]} />
    {range > 0 && <Animated.View pointerEvents="none"
      style={[styles.thumb, { top: clamp(top, 0, travel), height: thumb, backgroundColor: theme.accent, borderColor: theme.onAccent,
        opacity: fade.value.interpolate({ inputRange: [0, 1], outputRange: [.45, 1] }) }]}>
      {/* Arrows at both ends and a grip between, so the thumb reads as something to drag up and down. */}
      <View style={[styles.arrowUp, { borderBottomColor: theme.onAccent }]} />
      <View style={styles.grip}>
        {[0, 1, 2].map(line => <View key={line} style={[styles.gripLine, { backgroundColor: theme.onAccent }]} />)}
      </View>
      <View style={[styles.arrowDown, { borderTopColor: theme.onAccent }]} />
    </Animated.View>}
  </View>;
}

// The mixer pages: a ScrollView with scroll rails on both sides. A finger scrolls the page too, from anywhere that is
// not a control (a fader or a marker holds its touch, and while one is held the page does not move); the rails show
// while it does.
export function StemScrollView({ children, ...props }: ScrollViewProps & { children: ReactNode }) {
  const [scroll] = useState(() => new StemScroll());
  const [fade] = useState(() => new RailFade());
  const [sizes, setSizes] = useState<Sizes>({ view: 0, content: 0, offset: 0 });
  const [hidden, setHidden] = useState(false);
  useEffect(() => railCover.subscribe(setHidden), []);
  return <Context.Provider value={scroll}>
    <View style={styles.frame}>
      <ScrollView ref={view => scroll.attach(view)} scrollEventThrottle={16} {...props} scrollEnabled={!hidden}
        showsVerticalScrollIndicator={false}
        onScrollBeginDrag={event => { fade.hold(true); props.onScrollBeginDrag?.(event); }}
        onScrollEndDrag={event => { fade.hold(false); props.onScrollEndDrag?.(event); }}
        style={[styles.page, props.style]}
        onLayout={event => {
          scroll.measure();
          const view = event.nativeEvent.layout.height;
          setSizes(current => ({ ...current, view }));
          props.onLayout?.(event);
        }}
        onContentSizeChange={(width, content) => {
          setSizes(current => ({ ...current, content }));
          props.onContentSizeChange?.(width, content);
        }}
        onScroll={event => {
          scroll.moved(event);
          fade.show(); fade.hideSoon();
          const offset = event.nativeEvent.contentOffset.y;
          setSizes(current => (current.offset === offset ? current : { ...current, offset }));
          props.onScroll?.(event);
        }}>
        {children}
        {/* Lets the last stem scroll up to the focus line instead of stopping at the bottom of the screen. */}
        <View style={{ height: sizes.view * (1 - FOCUS_LINE) }} />
      </ScrollView>
      <ScrollRail scroll={scroll} sizes={sizes} side="left" fade={fade} hidden={hidden} />
      <ScrollRail scroll={scroll} sizes={sizes} side="right" fade={fade} hidden={hidden} />
    </View>
  </Context.Provider>;
}

const styles = StyleSheet.create({
  frame: { flex: 1 },
  page: {},
  rail: { position: 'absolute', top: 0, bottom: 0, width: RAIL, alignItems: 'center' },
  track: { position: 'absolute', top: 4, bottom: 4, width: 6, borderRadius: 3, borderWidth: StyleSheet.hairlineWidth },
  thumb: { position: 'absolute', width: THUMB, borderRadius: THUMB / 2, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center',
    justifyContent: 'space-between', paddingVertical: 5,
    shadowColor: '#000', shadowOpacity: .35, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } },
  arrowUp: { width: 0, height: 0, borderLeftWidth: 4, borderRightWidth: 4, borderBottomWidth: 6, borderLeftColor: 'transparent', borderRightColor: 'transparent' },
  arrowDown: { width: 0, height: 0, borderLeftWidth: 4, borderRightWidth: 4, borderTopWidth: 6, borderLeftColor: 'transparent', borderRightColor: 'transparent' },
  grip: { gap: 2 },
  gripLine: { width: 6, height: 1.5, borderRadius: 1, opacity: .8 },
});
