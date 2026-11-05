import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { type Usage, getUsage } from '../api';
import { cacheSize, clearCache } from '../cache';
import { LANGUAGES } from '../i18n';
import { phoneLanguage, useLanguage, useT } from '../language';
import { useSession } from '../session';
import { THEMES, type Theme, useSetTheme, useStyles, useTheme } from '../theme';
import { Button, errorText, formatBytes, useConfirm } from '../ui';

export default function Settings() {
  const { email, logOut } = useSession();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [cache, setCache] = useState(cacheSize);
  const [error, setError] = useState('');
  const confirm = useConfirm();
  const styles = useStyles(makeStyles), t = useT();

  useFocusEffect(useCallback(() => {
    setCache(cacheSize());
    getUsage().then(setUsage, failure => setError(errorText(failure)));
  }, []));

  const confirmLogOut = async () => {
    if (!await confirm(t('settings.signOutTitle'), t('settings.signOutMessage'), t('settings.signOut'))) return;
    try { await logOut(); } catch (failure) { setError(errorText(failure)); }
  };

  return (
    <ScrollView contentContainerStyle={styles.page}>
      {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      <Text style={styles.section} accessibilityRole="header">{t('settings.theme')}</Text>
      <ThemePicker />
      <Text style={styles.section} accessibilityRole="header">{t('settings.language')}</Text>
      <LanguagePicker />
      <Text style={styles.section} accessibilityRole="header">{t('settings.account')}</Text>
      <Row label={t('settings.email')} value={email} />
      {usage && <>
        <Row label={t('settings.plan')} value={usage.plan === 'premium' ? t('settings.premium') : t('settings.free')} />
        <Row label={t('settings.splits')} value={t('settings.ofLimit', { used: usage.splits.used, limit: usage.splits.limit })} />
        <Row label={t('settings.songs')} value={t('settings.ofLimit', { used: usage.songs.used, limit: usage.songs.limit })} />
      </>}
      <Row label={t('settings.saved')} value={t('settings.savedValue', { count: cache.songs, size: formatBytes(cache.bytes) })} />
      <Text style={styles.note}>{t('settings.cacheNote')}</Text>
      <Button kind="plain" label={t('settings.removeSaved')} disabled={!cache.songs}
        onPress={() => {
          void (async () => {
            if (!await confirm(t('settings.removeSavedTitle'), t('settings.removeSavedMessage'), t('common.remove'))) return;
            try { clearCache(); setCache(cacheSize()); setError(''); } catch (failure) { setError(errorText(failure)); }
          })();
        }} />
      <Button kind="danger" label={t('settings.signOut')} onPress={() => void confirmLogOut()} />
    </ScrollView>
  );
}

function ThemePicker() {
  const styles = useStyles(makeStyles), current = useTheme(), setTheme = useSetTheme(), t = useT();
  return <View style={styles.themes} accessibilityRole="radiogroup">
    {THEMES.map(theme => {
      const selected = theme.id === current.id;
      return <Pressable key={theme.id} onPress={() => setTheme(theme.id)} accessibilityRole="radio"
        accessibilityState={{ checked: selected }} accessibilityLabel={t('settings.themeLabel', { name: t(`theme.${theme.id}`) })}
        style={[styles.theme, selected && styles.themeOn]}>
        <View style={[styles.swatch, { backgroundColor: theme.background, backgroundImage: theme.gradient }]}>
          {theme.image && <Image source={theme.image} resizeMode="cover" style={StyleSheet.absoluteFill} />}
          <View style={[styles.swatchCard, { backgroundColor: theme.surface }]}>
            <View style={[styles.swatchLine, { backgroundColor: theme.ink }]} />
            <View style={[styles.swatchKey, { backgroundColor: theme.accent }]} />
          </View>
        </View>
        <Text style={[styles.themeName, selected && styles.themeNameOn]} numberOfLines={1}>{t(`theme.${theme.id}`)}</Text>
      </Pressable>;
    })}
  </View>;
}

// Each language shows its own name; "Phone language" follows the iPhone's setting.
function LanguagePicker() {
  const styles = useStyles(makeStyles), { choice, setChoice, t } = useLanguage();
  const phone = LANGUAGES.find(language => language.id === phoneLanguage())!;
  const options = [{ id: null, name: `${t('settings.phoneLanguage')} · ${phone.name}` }, ...LANGUAGES];
  return <View style={styles.languages} accessibilityRole="radiogroup">
    {options.map(option => {
      const selected = option.id === choice;
      return <Pressable key={option.id ?? 'phone'} onPress={() => setChoice(option.id)} accessibilityRole="radio"
        accessibilityState={{ checked: selected }} style={[styles.language, !option.id && styles.languageWide, selected && styles.themeOn]}>
        <Text style={[styles.languageName, selected && styles.themeNameOn]} numberOfLines={1}>{option.name}</Text>
        {selected && <Text style={styles.themeNameOn}>✓</Text>}
      </Pressable>;
    })}
  </View>;
}

function Row({ label, value }: { label: string; value: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  page: { padding: 16, gap: 12 },
  section: { fontSize: 13, fontWeight: '700', letterSpacing: 1, color: t.muted, textTransform: 'uppercase', marginTop: 4 },
  themes: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  theme: { width: '31%', flexGrow: 1, padding: 6, gap: 6, borderRadius: 12, borderWidth: 2, borderColor: t.line, backgroundColor: t.surface },
  themeOn: { borderColor: t.accent },
  swatch: { height: 64, borderRadius: 8, overflow: 'hidden', justifyContent: 'flex-end', padding: 6 },
  swatchCard: { borderRadius: 5, padding: 5, gap: 4, flexDirection: 'row', alignItems: 'center' },
  swatchLine: { flex: 1, height: 4, borderRadius: 2, opacity: .7 },
  swatchKey: { width: 16, height: 10, borderRadius: 3 },
  themeName: { fontSize: 14, fontWeight: '600', color: t.muted, textAlign: 'center' },
  themeNameOn: { color: t.accent },
  languages: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  language: { width: '48%', flexGrow: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6,
    minHeight: 44, paddingHorizontal: 12, borderRadius: 10, borderWidth: 2, borderColor: t.line, backgroundColor: t.surface },
  languageWide: { width: '100%' },
  languageName: { flexShrink: 1, fontSize: 15, fontWeight: '600', color: t.ink },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line,
  },
  label: { fontSize: 16, color: t.ink },
  value: { flexShrink: 1, fontSize: 16, color: t.muted },
  note: { fontSize: 13, color: t.muted, paddingVertical: 8 },
  error: { color: t.errorInk, padding: 12, backgroundColor: t.dangerSoft },
});
