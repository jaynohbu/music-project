import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type Song, type Usage, deleteSong, getUsage, listSongs } from '../api';
import { forgetSong } from '../cache';
import { Button, ButtonRow, Centered, Loading, errorText, formatTime, useConfirm } from '../ui';
import { type Theme, useStyles, useTheme } from '../theme';

const POLL_MS = 5000;
const WORKING = new Set(['uploading', 'queued', 'processing', 'deleting']);
const STATUS: Record<Song['status'], string> = {
  uploading: 'Uploading', queued: 'Waiting to split', processing: 'Splitting',
  completed: '', failed: 'Failed', deleting: 'Deleting',
};

export default function Songs() {
  const styles = useStyles(makeStyles), theme = useTheme();
  const [songs, setSongs] = useState<Song[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const pages = useRef(1);
  const confirm = useConfirm();
  const [deleting, setDeleting] = useState(false);

  // Reloads every page shown so far, as the website's list does.
  const load = useCallback(async () => {
    try {
      const loaded: Song[] = [];
      let next: string | null = null;
      for (let page = 0; page < pages.current; page++) {
        const result = await listSongs(next);
        loaded.push(...result.jobs.filter(song => song.type === 'stems'));
        next = result.cursor;
        if (!next) break;
      }
      setSongs(loaded);
      setCursor(next);
      setError('');
      setUsage(await getUsage());
    } catch (failure) {
      setError(errorText(failure));
    }
  }, []);

  const working = !!songs?.some(song => WORKING.has(song.status));
  useFocusEffect(useCallback(() => {
    void load();
    if (!working) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load, working]));

  const more = async () => {
    if (!cursor) return;
    try {
      const result = await listSongs(cursor);
      pages.current += 1;
      setSongs(current => [...(current ?? []), ...result.jobs.filter(song => song.type === 'stems')]);
      setCursor(result.cursor);
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  const remove = async (song: Song) => {
    if (!await confirm('Delete this song?', `Permanently delete "${song.title ?? 'Untitled song'}", its stems, and its entries in every scene?`, 'Delete song')) return;
    setDeleting(true);
    try { await deleteSong(song.jobId); forgetSong(song.jobId); await load(); }
    catch (failure) { setError(errorText(failure)); }
    finally { setDeleting(false); }
  };
  if (!songs) {
    return error
      ? <Centered><Text style={styles.error}>{error}</Text><Button label="Try again" onPress={() => void load()} /></Centered>
      : <Loading />;
  }

  const full = usage && (usage.songs.used >= usage.songs.limit || usage.splits.used >= usage.splits.limit);
  return (
    <SafeAreaView style={styles.page} edges={['bottom']}>
      <FlatList
        contentContainerStyle={{ padding: 16, gap: 12 }}
        data={songs}
        keyExtractor={song => song.jobId}
        refreshControl={<RefreshControl tintColor={theme.muted} refreshing={refreshing} onRefresh={async () => {
          setRefreshing(true);
          await load();
          setRefreshing(false);
        }} />}
        ListHeaderComponent={<View style={{ gap: 8, paddingBottom: 12 }}>
          <Text style={{ fontSize: 30, fontWeight: '700', color: theme.ink }}>Music</Text>
          <Text style={styles.detail}>Your split songs. Open a mixer, or arrange songs in Scenes.</Text>
          {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        </View>}
        ListEmptyComponent={<Text style={styles.empty}>No songs yet. Add one to split it into six stems.</Text>}
        ListFooterComponent={cursor ? <Button kind="plain" label="Show more" onPress={() => void more()} /> : undefined}
        renderItem={({ item: song }) => (
          <View style={styles.row}>
          <Pressable
            style={styles.rowText}
            disabled={song.status !== 'completed'}
            onPress={() => router.push({ pathname: '/song/[id]', params: { id: song.jobId } })}
            accessibilityRole="button" accessibilityLabel={`Open mixer for ${song.title || 'Untitled song'}`}
          >
            <View style={styles.rowText}>
              <Text style={styles.title} numberOfLines={1}>{song.title || 'Untitled song'}</Text>
              <Text style={styles.detail} numberOfLines={2}>
                {[
                  STATUS[song.status],
                  song.author && `By ${song.author}`,
                  song.duration && formatTime(song.duration),
                  new Date(song.createdAt).toLocaleDateString(),
                ].filter(Boolean).join(' · ')}
              </Text>
              {song.status === 'failed' && !!song.error && <Text style={styles.error}>{song.error}</Text>}
            </View>
          </Pressable>
          <ButtonRow>
            {song.status === 'completed' && <Button label="Open mixer" onPress={() => router.push({ pathname: '/song/[id]', params: { id: song.jobId } })} />}
            {(song.status === 'completed' || song.status === 'failed') && <Button kind="danger" label="Delete song" disabled={deleting} onPress={() => void remove(song)} />}
          </ButtonRow>
          </View>
        )}
      />
      <View style={styles.footer}>
        {usage && (
          <Text style={styles.detail}>
            Splits this month {usage.splits.used}/{usage.splits.limit} · Songs {usage.songs.used}/{usage.songs.limit}
          </Text>
        )}
        <Button label="Add a song" disabled={!!full} onPress={() => router.push('/upload')} />
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  page: { flex: 1 },
  headerLink: { color: t.accent, fontSize: 16 },
  row: {
    padding: 18, backgroundColor: t.surface, borderRadius: 14,
    borderWidth: 1, borderColor: t.line, gap: 14,
  },
  rowText: { flex: 1, gap: 3 },
  title: { fontSize: 19, fontWeight: '600', color: t.ink },
  detail: { fontSize: 13, color: t.muted },
  error: { fontSize: 13, color: t.danger },
  notice: { padding: 16 },
  empty: { padding: 24, fontSize: 15, color: t.muted, textAlign: 'center' },
  footer: { padding: 16, gap: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.line },
});
