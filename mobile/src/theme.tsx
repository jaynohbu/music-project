import { File, Paths } from 'expo-file-system';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { ImageBackground, StyleSheet, View, type ImageSourcePropType } from 'react-native';

export type ThemeId = 'simple' | 'heavy_metal' | 'pop' | 'jazz_band' | 'christian';

export interface Theme {
  id: ThemeId; name: string; dark: boolean;
  // Page backdrop: a photo (assets/theme_<id>.png) when one is registered below, else the gradient.
  background: string; gradient?: string; image?: ImageSourcePropType; overlay: string;
  header: string; tabOn: string; surface: string; surfaceMuted: string; input: string; dialog: string; backdrop: string;
  ink: string; muted: string; line: string;
  accent: string; accentSoft: string; onAccent: string;
  danger: string; dangerSoft: string; errorInk: string;
  // Mixer console hardware.
  metal: string; key: string; keyBorder: string; keyInk: string; consoleAccent: string; consoleInk: string; consoleMuted: string; consoleLine: string;
  wave: string; waveLine: string; waveBar: string; waveBarDim: string; start: string; end: string; playhead: string;
  // Lyrics and score strips; strip must be a 6-digit hex so its edges can fade out.
  strip: string; note: string; staff: string; scoreInk: string; wordDim: string; wordNear: string; wordActive: string;
}

// Background photos must be required statically. To add one, drop assets/theme_<id>.png in and list it here.
const IMAGES: Partial<Record<ThemeId, ImageSourcePropType>> = {
  heavy_metal: require('../assets/theme_heavy_metal.png'),
};

const simple: Theme = {
  id: 'simple', name: 'Simple', dark: false,
  background: '#f5f7fb', overlay: 'transparent',
  header: '#ffffff', tabOn: '#edf2ff', surface: '#ffffff', surfaceMuted: '#eef2f8', input: '#ffffff', dialog: '#ffffff', backdrop: '#19253699',
  ink: '#192536', muted: '#526177', line: '#dce3ed',
  accent: '#3459c9', accentSoft: '#eef2fb', onAccent: '#ffffff',
  danger: '#b00020', dangerSoft: '#fff0f0', errorInk: '#a52c35',
  metal: 'linear-gradient(180deg, #edf1f6 0%, #cbd4df 45%, #eef2f7 55%, #c4ceda 100%)',
  key: 'linear-gradient(180deg, #fbfcfe 0%, #d5dce6 100%)', keyBorder: '#8f9db0', keyInk: '#28384e', consoleAccent: '#3459c9',
  consoleInk: '#28384e', consoleMuted: '#4b5b72', consoleLine: '#a9b5c5',
  wave: '#f3f6fd', waveLine: '#dfe5f1', waveBar: '#3459c9', waveBarDim: '#8fa3d4', start: '#173da4', end: '#08744a', playhead: '#c73648',
  strip: '#f1f4f9', note: '#2c3a4e', staff: '#8a99ad', scoreInk: '#42536b', wordDim: '#697b92', wordNear: '#5f7fd6', wordActive: '#2447b8',
};

const heavyMetal: Theme = {
  id: 'heavy_metal', name: 'Heavy metal', dark: true,
  background: '#09090b', gradient: 'linear-gradient(180deg, #1a0a0a 0%, #09090b 60%, #200606 100%)', overlay: '#000000a0',
  header: '#0a0a0ce6', tabOn: '#e0301e33', surface: '#141418dd', surfaceMuted: '#26262cdd', input: '#1c1c20', dialog: '#17171b', backdrop: '#000000b3',
  ink: '#f2f2f2', muted: '#b0b0b8', line: '#ffffff26',
  accent: '#e8341c', accentSoft: '#e8341c2e', onAccent: '#ffffff',
  danger: '#ff5a4f', dangerSoft: '#ff5a4f26', errorInk: '#ff8a80',
  metal: 'linear-gradient(180deg, #3b3e44 0%, #1e2024 45%, #34373c 55%, #151619 100%)',
  key: 'linear-gradient(180deg, #4b4e55 0%, #24262a 100%)', keyBorder: '#62666e', keyInk: '#ececec', consoleAccent: '#ff5a2e',
  consoleInk: '#ececec', consoleMuted: '#a6a9b0', consoleLine: '#4d5057',
  wave: '#101013', waveLine: '#26262b', waveBar: '#ff4a26', waveBarDim: '#6e3328', start: '#ff9a3c', end: '#5fd38a', playhead: '#ff2d2d',
  strip: '#18181c', note: '#ececec', staff: '#6c6c74', scoreInk: '#c4c4cc', wordDim: '#8b8b93', wordNear: '#ff9a7a', wordActive: '#ff4422',
};

const pop: Theme = {
  id: 'pop', name: 'Pop', dark: false,
  background: '#ffd6ef', gradient: 'linear-gradient(160deg, #ff9fd8 0%, #c9a2ff 50%, #86e6ff 100%)', overlay: '#ffffff33',
  header: '#ffffffd9', tabOn: '#ffe0f2', surface: '#ffffffe0', surfaceMuted: '#fbe9f7', input: '#ffffff', dialog: '#ffffff', backdrop: '#3a145599',
  ink: '#2b1142', muted: '#6d5088', line: '#f0d0ee',
  accent: '#e0248f', accentSoft: '#ffe3f3', onAccent: '#ffffff',
  danger: '#c8102e', dangerSoft: '#ffe8ec', errorInk: '#b3123a',
  metal: 'linear-gradient(180deg, #fff1fb 0%, #f1c9e9 45%, #fdf0fb 55%, #e6bfe4 100%)',
  key: 'linear-gradient(180deg, #fff8fd 0%, #f2d2ec 100%)', keyBorder: '#d39bcb', keyInk: '#4a1c5e', consoleAccent: '#c8137a',
  consoleInk: '#4a1c5e', consoleMuted: '#7a4f8c', consoleLine: '#dcaed6',
  wave: '#fdf2fb', waveLine: '#f3dcef', waveBar: '#e0248f', waveBarDim: '#f0a3cf', start: '#7a2fd0', end: '#0a8f8a', playhead: '#ff2f7a',
  strip: '#fbeaf6', note: '#3a1650', staff: '#c79bc4', scoreInk: '#5e3a75', wordDim: '#9a7cb0', wordNear: '#e86bb4', wordActive: '#c8137a',
};

const jazzBand: Theme = {
  id: 'jazz_band', name: 'Jazz band', dark: true,
  background: '#0f1830', gradient: 'linear-gradient(170deg, #0e1832 0%, #261031 55%, #4a1320 100%)', overlay: 'transparent',
  header: '#0c1326e6', tabOn: '#d6a74033', surface: '#121a30e0', surfaceMuted: '#1d2640e0', input: '#151d33', dialog: '#141c32', backdrop: '#050813b3',
  ink: '#f6ecd6', muted: '#c9b88f', line: '#d6a74040',
  accent: '#d9a63c', accentSoft: '#d9a63c2e', onAccent: '#1b1206',
  danger: '#ff7a6b', dangerSoft: '#ff7a6b26', errorInk: '#ffa395',
  metal: 'linear-gradient(180deg, #ecd391 0%, #b98e3d 45%, #e5c67c 55%, #9b7131 100%)',
  key: 'linear-gradient(180deg, #f6e3ad 0%, #c9a052 100%)', keyBorder: '#8a6424', keyInk: '#2b1d08', consoleAccent: '#6e1426',
  consoleInk: '#2b1d08', consoleMuted: '#4e3913', consoleLine: '#8a6424',
  wave: '#0d1428', waveLine: '#1e2742', waveBar: '#e2b04a', waveBarDim: '#6d5a33', start: '#7fb2ff', end: '#7fdca4', playhead: '#ff6b6b',
  strip: '#141c33', note: '#f3e6c6', staff: '#5d6684', scoreInk: '#d8c69c', wordDim: '#8f8670', wordNear: '#e6c47a', wordActive: '#ffcf5a',
};

const christian: Theme = {
  id: 'christian', name: 'Christian', dark: false,
  background: '#fdf6e6', gradient: 'linear-gradient(180deg, #fffaf0 0%, #fbeccb 45%, #d8e8f8 100%)', overlay: '#ffffff26',
  header: '#fffdf8e6', tabOn: '#fbf0d8', surface: '#ffffffe6', surfaceMuted: '#f8f1e2', input: '#ffffff', dialog: '#fffdf8', backdrop: '#3a311f80',
  ink: '#2e2a20', muted: '#6e6655', line: '#eadfc4',
  accent: '#b4862a', accentSoft: '#fbf1dc', onAccent: '#ffffff',
  danger: '#a8322a', dangerSoft: '#fdeeea', errorInk: '#9b3027',
  metal: 'linear-gradient(180deg, #fffdf6 0%, #ece0c4 45%, #fffaf0 55%, #e3d4b2 100%)',
  key: 'linear-gradient(180deg, #fffefa 0%, #eee3c9 100%)', keyBorder: '#c9b48a', keyInk: '#4a3b1c', consoleAccent: '#8a6212',
  consoleInk: '#4a3b1c', consoleMuted: '#7a6a48', consoleLine: '#d3c19a',
  wave: '#fffbf2', waveLine: '#f1e7d0', waveBar: '#b4862a', waveBarDim: '#e0c98f', start: '#3b6fb6', end: '#2f8a57', playhead: '#c0503a',
  strip: '#faf3e3', note: '#3a3324', staff: '#c4b38e', scoreInk: '#5e543e', wordDim: '#9a8f76', wordNear: '#c9a24e', wordActive: '#8a6212',
};

export const THEMES: Theme[] = [simple, heavyMetal, pop, jazzBand, christian].map(theme => ({ ...theme, image: IMAGES[theme.id] }));

const saved = new File(Paths.document, 'theme.json');
function load(): ThemeId {
  try {
    const id = saved.exists ? JSON.parse(saved.textSync()).theme : null;
    return THEMES.some(theme => theme.id === id) ? id : 'simple';
  } catch { return 'simple'; }
}

const Context = createContext<{ theme: Theme; setTheme: (id: ThemeId) => void }>({ theme: THEMES[0], setTheme: () => {} });
export const useTheme = () => useContext(Context).theme;
export const useSetTheme = () => useContext(Context).setTheme;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [id, setId] = useState(load);
  const value = useMemo(() => ({
    theme: THEMES.find(theme => theme.id === id) ?? THEMES[0],
    setTheme: (next: ThemeId) => {
      setId(next);
      try { saved.write(JSON.stringify({ theme: next })); } catch { /* The choice still applies until the app restarts. */ }
    },
  }), [id]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

// Each file builds its styles from the theme once; the sheet is shared by every component using it.
const sheets = new WeakMap<object, Map<ThemeId, unknown>>();
export function useStyles<T>(make: (theme: Theme) => T): T {
  const theme = useTheme();
  let byTheme = sheets.get(make);
  if (!byTheme) sheets.set(make, byTheme = new Map());
  if (!byTheme.has(theme.id)) byTheme.set(theme.id, make(theme));
  return byTheme.get(theme.id) as T;
}

export function ThemeBackground({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const backdrop = <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: theme.overlay }]} />;
  if (theme.image) return <ImageBackground source={theme.image} resizeMode="cover" style={{ flex: 1, backgroundColor: theme.background }}>
    {backdrop}{children}
  </ImageBackground>;
  return <View style={{ flex: 1, backgroundColor: theme.background, backgroundImage: theme.gradient }}>{backdrop}{children}</View>;
}
