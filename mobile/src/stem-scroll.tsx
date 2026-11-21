import { createContext, useContext, useLayoutEffect, useState, type ComponentRef, type ReactNode } from 'react';
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

// Wide enough to grab without looking, with a handle that stands out on every theme.
const RAIL = 34, SHORTEST_THUMB = 56;
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
function ScrollRail({ scroll, sizes, side, fade }: { scroll: StemScroll; sizes: Sizes; side: 'left' | 'right'; fade: RailFade }) {
  const theme = useTheme(), t = useT();
  const [{ sizesRef, responder }] = useState(() => createRail(scroll, fade));
  useLayoutEffect(() => { sizesRef.current = sizes; });
  const { range, travel, thumb } = geometry(sizes);
  const top = range > 0 ? sizes.offset / range * travel : 0;
  const page = (direction: number) => scroll.scrollTo(clamp(sizes.offset + direction * sizes.view * .8, 0, range));
  return <View {...responder.panHandlers} style={[styles.rail, { [side]: 0 }]}
    accessible accessibilityRole="adjustable" accessibilityLabel={t('scroll.rail')}
    accessibilityValue={{ min: 0, max: 100, now: range > 0 ? Math.round(sizes.offset / range * 100) : 0 }}
    accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
    onAccessibilityAction={event => page(event.nativeEvent.actionName === 'increment' ? 1 : -1)}>
    <Animated.View pointerEvents="none" style={[styles.track, { backgroundColor: theme.surface, borderColor: theme.line,
      opacity: fade.value.interpolate({ inputRange: [0, 1], outputRange: [.12, .55] }) }]} />
    {range > 0 && <Animated.View pointerEvents="none"
      style={[styles.thumb, { top: clamp(top, 0, travel), height: thumb, backgroundColor: theme.accent, borderColor: theme.onAccent,
        opacity: fade.value.interpolate({ inputRange: [0, 1], outputRange: [.3, 1] }) }]}>
      {[0, 1, 2].map(line => <View key={line} style={[styles.grip, { backgroundColor: theme.onAccent }]} />)}
    </Animated.View>}
  </View>;
}

// The mixer pages: a ScrollView that tells the mixer where the screen is while it scrolls, so it can open
// the stem in view, with scroll rails on both sides in place of finger scrolling.
export function StemScrollView({ children, ...props }: ScrollViewProps & { children: ReactNode }) {
  const [scroll] = useState(() => new StemScroll());
  const [fade] = useState(() => new RailFade());
  const [sizes, setSizes] = useState<Sizes>({ view: 0, content: 0, offset: 0 });
  return <Context.Provider value={scroll}>
    <View style={styles.frame}>
      <ScrollView ref={view => scroll.attach(view)} scrollEventThrottle={16} {...props} scrollEnabled={false}
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
      <ScrollRail scroll={scroll} sizes={sizes} side="left" fade={fade} />
      <ScrollRail scroll={scroll} sizes={sizes} side="right" fade={fade} />
    </View>
  </Context.Provider>;
}

const styles = StyleSheet.create({
  frame: { flex: 1 },
  // Room for the rails, so they never cover a control.
  page: { marginHorizontal: RAIL },
  rail: { position: 'absolute', top: 0, bottom: 0, width: RAIL, alignItems: 'center' },
  // Only slightly rounded ends.
  track: { position: 'absolute', top: 4, bottom: 4, width: 12, borderRadius: 3, borderWidth: 1 },
  thumb: { position: 'absolute', width: 24, borderRadius: 4, borderWidth: 1, alignItems: 'center', justifyContent: 'center', gap: 4,
    shadowColor: '#000', shadowOpacity: .35, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } },
  grip: { width: 12, height: 2, borderRadius: 1, opacity: .8 },
});
