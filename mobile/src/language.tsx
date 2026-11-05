import { getLocales } from 'expo-localization';
import { File, Paths } from 'expo-file-system';
import { createContext, ReactNode, useContext, useMemo, useState } from 'react';
import { isLanguage, LanguageId, matchLanguage, setCurrentLanguage, t, TextKey, TextValues, translate } from './i18n';

// null follows the phone's language.
type Choice = LanguageId | null;

const saved = new File(Paths.document, 'language.json');
function load(): Choice {
  try {
    const id = saved.exists ? JSON.parse(saved.textSync()).language : null;
    return isLanguage(id) ? id : null;
  } catch { return null; }
}

export function phoneLanguage(): LanguageId {
  try { return matchLanguage(getLocales().map(locale => locale.languageTag)); } catch { return 'en'; }
}

type Translate = (key: TextKey, values?: TextValues) => string;
type Value = { language: LanguageId; choice: Choice; setChoice: (choice: Choice) => void; t: Translate };

const Context = createContext<Value>({ language: 'en', choice: null, setChoice: () => {}, t });
export const useLanguage = () => useContext(Context);
export const useT = () => useContext(Context).t;

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState(load);
  const language = choice ?? phoneLanguage();
  // Set before children render, so text outside components (errors, notes) uses the same language.
  setCurrentLanguage(language);
  const value = useMemo<Value>(() => ({
    language,
    choice,
    setChoice: (next: Choice) => {
      setChoiceState(next);
      try { saved.write(JSON.stringify({ language: next })); } catch { /* The choice still applies until the app restarts. */ }
    },
    // A new function per language makes every component using it re-render with the new text.
    t: (key, values) => translate(language, key, values),
  }), [language, choice]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
