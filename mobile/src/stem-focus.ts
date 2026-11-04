export interface Viewport { top: number; bottom: number; atEnd: boolean }
export interface StemFrame<Name> { name: Name; top: number; bottom: number }

export const FOCUS_LINE = 0.35;
const END_HEADER_ROOM = 80;

// The stem crossing the upper third of the screen is the one being read; at the very end, the last stem whose top is in view.
export function focusedStem<Name>(frames: StemFrame<Name>[], viewport: Viewport): Name | null {
  if (viewport.atEnd) {
    const visible = frames.filter(frame => frame.top < viewport.bottom - END_HEADER_ROOM);
    return visible.length ? visible[visible.length - 1].name : null;
  }
  const line = viewport.top + (viewport.bottom - viewport.top) * FOCUS_LINE;
  return frames.find(frame => frame.top <= line && frame.bottom > line)?.name ?? null;
}
