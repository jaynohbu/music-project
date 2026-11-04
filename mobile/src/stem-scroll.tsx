import { createContext, useContext, useState, type ComponentRef, type ReactNode } from 'react';
import { ScrollView, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewProps } from 'react-native';

import type { Viewport } from './stem-focus';

class StemScroll {
  private view: ComponentRef<typeof ScrollView> | null = null;
  private offset = 0;
  attach(view: ComponentRef<typeof ScrollView> | null) { this.view = view; }
  track(offset: number) { this.offset = offset; }
  private listeners = new Set<(viewport: Viewport) => void>();
  onSettle(listener: (viewport: Viewport) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  scrollBy(dy: number) {
    if (Math.abs(dy) >= 1) this.view?.scrollTo({ y: Math.max(0, this.offset + dy), animated: false });
  }
  settle({ nativeEvent: { contentOffset, layoutMeasurement, contentSize } }: NativeSyntheticEvent<NativeScrollEvent>) {
    this.offset = contentOffset.y;
    const atEnd = contentOffset.y + layoutMeasurement.height >= contentSize.height - 8;
    this.view?.measureInWindow((_x, top, _width, height) =>
      this.listeners.forEach(listener => listener({ top, bottom: top + height, atEnd })));
  }
}

const Context = createContext<StemScroll | null>(null);
export const useStemScroll = () => useContext(Context);

// A page ScrollView that tells the mixer where the screen came to rest, so it can open the stem in view.
export function StemScrollView({ children, ...props }: ScrollViewProps & { children: ReactNode }) {
  const [scroll] = useState(() => new StemScroll());
  return <Context.Provider value={scroll}>
    <ScrollView ref={view => scroll.attach(view)} scrollEventThrottle={64} {...props}
      onScroll={event => { scroll.track(event.nativeEvent.contentOffset.y); props.onScroll?.(event); }}
      onScrollEndDrag={event => {
        // Without momentum the page stops where the finger lifts; otherwise wait for the glide to finish.
        if (Math.abs(event.nativeEvent.velocity?.y ?? 0) < 0.05) scroll.settle(event);
        props.onScrollEndDrag?.(event);
      }}
      onMomentumScrollEnd={event => { scroll.settle(event); props.onMomentumScrollEnd?.(event); }}>
      {children}
    </ScrollView>
  </Context.Provider>;
}
