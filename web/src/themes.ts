import { Injectable, signal } from '@angular/core';

// The same themes as the app (mobile/src/theme.tsx); their colours live in styles.css under [data-theme].
export const THEMES = [
  { id: 'heavy_metal', name: 'Heavy metal' }, { id: 'rock', name: 'Rock' }, { id: 'pop', name: 'Pop' },
  { id: 'jazz_band', name: 'Jazz club' }, { id: 'christian', name: 'Worship' }, { id: 'simple', name: 'Simple' },
] as const;
export type ThemeId = typeof THEMES[number]['id'];
const DEFAULT_THEME: ThemeId = 'heavy_metal';
const STORAGE_KEY = 'sorituh-theme';

// Kept per browser, like the app keeps it per phone.
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<ThemeId>(DEFAULT_THEME);
  constructor() {
    let saved: string | null = null;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* Private windows can refuse storage. */ }
    this.apply(THEMES.some(theme => theme.id === saved) ? saved as ThemeId : DEFAULT_THEME);
  }
  apply(id: ThemeId): void {
    this.theme.set(id);
    document.documentElement.dataset['theme'] = id;
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* The choice still applies until the page reloads. */ }
  }
}
