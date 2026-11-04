import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { type Usage, getUsage } from '../api';
import { cacheSize, clearCache } from '../cache';
import { useSession } from '../session';
import { BACKGROUND, Button, GREY, INK, LINE, errorText, formatBytes, useConfirm } from '../ui';

export default function Settings() {
  const { email, logOut } = useSession();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [cache, setCache] = useState(cacheSize);
  const [error, setError] = useState('');
  const confirm = useConfirm();

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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 12, backgroundColor: BACKGROUND },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: LINE,
  },
  label: { fontSize: 16, color: INK },
  value: { flexShrink: 1, fontSize: 16, color: GREY },
  note: { fontSize: 13, color: GREY, paddingVertical: 8 },
  error: { color: '#a52c35', padding: 12, backgroundColor: '#fff0f0' },
});
