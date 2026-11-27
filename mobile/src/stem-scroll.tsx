import { createContext, useContext, useEffect, useState, type ComponentRef, type ReactNode } from 'react';
import { ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewProps } from 'react-native';

import { FOCUS_LINE, type Viewport } from './stem-focus';

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

// The mixers reach the screen's edges; the pages inset their other content by EDGE.
export const EDGE = 16;

// While a fader or other mixer control is held the page does not follow the finger, and follows it again on release.
// A release can be lost (a cancelled touch, a control that unmounts mid-drag), so while held it is checked every
// three seconds and let go if nothing has moved since the last check.
const WATCH_MS = 3000;
class ControlHold {
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
export const controlHold = new ControlHold();

// The mixer pages: a ScrollView a finger scrolls from anywhere that is not a control (a fader or a marker holds its
// touch, and while one is held the page does not move).
export function StemScrollView({ children, ...props }: ScrollViewProps & { children: ReactNode }) {
  const [scroll] = useState(() => new StemScroll());
  const [view, setView] = useState(0);
  const [held, setHeld] = useState(false);
  useEffect(() => controlHold.subscribe(setHeld), []);
  return <Context.Provider value={scroll}>
    <ScrollView ref={view => scroll.attach(view)} scrollEventThrottle={16} {...props} scrollEnabled={!held}
      onLayout={event => {
        scroll.measure();
        setView(event.nativeEvent.layout.height);
        props.onLayout?.(event);
      }}
      onScroll={event => {
        scroll.moved(event);
        props.onScroll?.(event);
      }}>
      {children}
      {/* Lets the last stem scroll up to the focus line instead of stopping at the bottom of the screen. */}
      <View style={{ height: view * (1 - FOCUS_LINE) }} />
    </ScrollView>
  </Context.Provider>;
}
