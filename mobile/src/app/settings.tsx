import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { type Usage, getUsage } from '../api';
import { cacheSize, clearCache } from '../cache';
import { useSession } from '../session';
import { THEMES, type Theme, useSetTheme, useStyles, useTheme } from '../theme';
import { Button, errorText, formatBytes, useConfirm } from '../ui';

export default function Settings() {
  const { email, logOut } = useSession();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [cache, setCache] = useState(cacheSize);
  const [error, setError] = useState('');
  const confirm = useConfirm();
  const styles = useStyles(makeStyles);

  useFocusEffect(useCallback(() => {
    setCache(cacheSize());
    getUsage().then(setUsage, failure => setError(errorText(failure)));
  }, []));

  const confirmLogOut = async () => {
    if (!await confirm('Sign out?', 'Songs saved on this phone are removed.', 'Sign out')) return;
    try { await logOut(); } catch (failure) { setError(errorText(failure)); }
  };

  return (
    <ScrollView contentContainerStyle={styles.page}>
      {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      <Text style={styles.section} accessibilityRole="header">Theme</Text>
      <ThemePicker />
      <Text style={styles.section} accessibilityRole="header">Account</Text>
      <Row label="Email" value={email} />
      {usage && <>
        <Row label="Plan" value={usage.plan === 'premium' ? 'Premium' : 'Free'} />
        <Row label="Splits this month" value={`${usage.splits.used} of ${usage.splits.limit}`} />
        <Row label="Songs" value={`${usage.songs.used} of ${usage.songs.limit}`} />
      </>}
      <Row label="Saved on this phone" value={`${cache.songs} songs · ${formatBytes(cache.bytes)}`} />
      <Text style={styles.note}>Up to 20 songs or 2 GB are kept for playback. The oldest played go first.</Text>
      <Button kind="plain" label="Remove saved songs" disabled={!cache.songs}
        onPress={() => {
          void (async () => {
            if (!await confirm('Remove saved songs?', 'Remove local playback copies? Songs in your account and Scenes stay unchanged.', 'Remove')) return;
            try { clearCache(); setCache(cacheSize()); setError(''); } catch (failure) { setError(errorText(failure)); }
          })();
        }} />
      <Button kind="danger" label="Sign out" onPress={() => void confirmLogOut()} />
    </ScrollView>
  );
}

function ThemePicker() {
  const styles = useStyles(makeStyles), current = useTheme(), setTheme = useSetTheme();
  return <View style={styles.themes} accessibilityRole="radiogroup">
    {THEMES.map(theme => {
      const selected = theme.id === current.id;
      return <Pressable key={theme.id} onPress={() => setTheme(theme.id)} accessibilityRole="radio"
        accessibilityState={{ checked: selected }} accessibilityLabel={`${theme.name} theme`}
        style={[styles.theme, selected && styles.themeOn]}>
        <View style={[styles.swatch, { backgroundColor: theme.background, backgroundImage: theme.gradient }]}>
          {theme.image && <Image source={theme.image} resizeMode="cover" style={StyleSheet.absoluteFill} />}
          <View style={[styles.swatchCard, { backgroundColor: theme.surface }]}>
            <View style={[styles.swatchLine, { backgroundColor: theme.ink }]} />
            <View style={[styles.swatchKey, { backgroundColor: theme.accent }]} />
          </View>
        </View>
        <Text style={[styles.themeName, selected && styles.themeNameOn]} numberOfLines={1}>{theme.name}</Text>
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
  row: {
    flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line,
  },
  label: { fontSize: 16, color: t.ink },
  value: { flexShrink: 1, fontSize: 16, color: t.muted },
  note: { fontSize: 13, color: t.muted, paddingVertical: 8 },
  error: { color: t.errorInk, padding: 12, backgroundColor: t.dangerSoft },
});
