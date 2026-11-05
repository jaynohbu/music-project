// The app's text in each language. Plain TypeScript so non-UI modules and tests can use it too.
import de from './locales/de';
import en from './locales/en';
import es from './locales/es';
import fil from './locales/fil';
import fr from './locales/fr';
import id from './locales/id';
import it from './locales/it';
import ja from './locales/ja';
import ko from './locales/ko';
import pt from './locales/pt';
import vi from './locales/vi';
import zh from './locales/zh';

export type TextKey = keyof typeof en;
export type Strings = Record<TextKey, string>;
export type TextValues = Record<string, string | number>;

// Each language is listed by its own name, so people can find theirs whatever the app is showing.
export const LANGUAGES = [
  { id: 'en', name: 'English' },
  { id: 'ko', name: '한국어' },
  { id: 'ja', name: '日本語' },
  { id: 'zh', name: '简体中文' },
  { id: 'fil', name: 'Filipino' },
  { id: 'vi', name: 'Tiếng Việt' },
  { id: 'id', name: 'Bahasa Indonesia' },
  { id: 'fr', name: 'Français' },
  { id: 'de', name: 'Deutsch' },
  { id: 'es', name: 'Español' },
  { id: 'pt', name: 'Português' },
  { id: 'it', name: 'Italiano' },
] as const;
export type LanguageId = (typeof LANGUAGES)[number]['id'];

const TEXT: Record<LanguageId, Strings> = { en, ko, ja, zh, fil, vi, id, fr, de, es, pt, it };
// Tagalog is the base of Filipino, so phones set to either get the Filipino text.
const ALIASES: Record<string, LanguageId> = { tl: 'fil', in: 'id' };

export const isLanguage = (value: unknown): value is LanguageId => LANGUAGES.some(language => language.id === value);

// The first of the phone's preferred languages that the app has, such as "pt-BR" → Portuguese; English otherwise.
export function matchLanguage(tags: string[]): LanguageId {
  for (const tag of tags) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    const found = isLanguage(base) ? base : ALIASES[base];
    if (found) return found;
  }
  return 'en';
}

let current: LanguageId = 'en';
export const currentLanguage = () => current;
export function setCurrentLanguage(language: LanguageId) { current = language; }

export const t = (key: TextKey, values?: TextValues) => translate(current, key, values);

export function translate(language: LanguageId, key: TextKey, values?: TextValues): string {
  const text = TEXT[language]?.[key] ?? en[key] ?? key;
  return values ? text.replace(/\{(\w+)\}/g, (match, name: string) => name in values ? String(values[name]) : match) : text;
}
