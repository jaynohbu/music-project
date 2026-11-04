import { createContext, useContext, useState, type ComponentRef, type ReactNode } from 'react';
import { ScrollView, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewProps } from 'react-native';

import type { Viewport } from './stem-focus';

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
  scrollBy(dy: number) {
    if (Math.abs(dy) >= 1) this.view?.scrollTo({ y: Math.max(0, this.offset + dy), animated: false });
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

// A page ScrollView that tells the mixer where the screen is while it scrolls, so it can open the stem in view.
export function StemScrollView({ children, ...props }: ScrollViewProps & { children: ReactNode }) {
  const [scroll] = useState(() => new StemScroll());
  return <Context.Provider value={scroll}>
    <ScrollView ref={view => scroll.attach(view)} scrollEventThrottle={50} {...props}
      onLayout={event => { scroll.measure(); props.onLayout?.(event); }}
      onScroll={event => { scroll.moved(event); props.onScroll?.(event); }}
      onScrollEndDrag={event => { scroll.moved(event); props.onScrollEndDrag?.(event); }}
      onMomentumScrollEnd={event => { scroll.moved(event); props.onMomentumScrollEnd?.(event); }}>
      {children}
    </ScrollView>
  </Context.Provider>;
}
