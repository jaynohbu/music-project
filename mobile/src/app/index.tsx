import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type Song, type Usage, deleteSong, getUsage, listSongs, updateSongDetails } from '../api';
import { forgetSong } from '../cache';
import { useLanguage } from '../language';
import { deleteTake } from '../live-take';
import { IconButton } from '../mixer-console';
import { Button, ButtonRow, Centered, Loading, errorText, formatTime, useConfirm } from '../ui';
import { type Theme, useStyles, useTheme } from '../theme';

const POLL_MS = 5000;
const WORKING = new Set(['uploading', 'queued', 'processing', 'deleting']);

export default function Songs() {
  const styles = useStyles(makeStyles), theme = useTheme(), { t, language } = useLanguage();
  const [songs, setSongs] = useState<Song[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const pages = useRef(1);
  const confirm = useConfirm();
  const [deleting, setDeleting] = useState(false);
  // The song whose title and artist are being edited, one at a time.
  const [editing, setEditing] = useState<string | null>(null);

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
    if (!await confirm(t('songs.deleteTitle'), t('songs.deleteMessage', { title: song.title ?? t('common.untitledSong') }), t('songs.delete'))) return;
    setDeleting(true);
    try { await deleteSong(song.jobId); forgetSong(song.jobId); deleteTake(song.jobId); await load(); }
    catch (failure) { setError(errorText(failure)); }
    finally { setDeleting(false); }
  };
  if (!songs) {
    return error
      ? <Centered><Text style={styles.error}>{error}</Text><Button label={t('common.tryAgain')} onPress={() => void load()} /></Centered>
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
          <Text style={{ fontSize: 30, fontWeight: '700', color: theme.ink }}>{t('songs.heading')}</Text>
          <Text style={styles.detail}>{t('songs.intro')}</Text>
          {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        </View>}
        ListEmptyComponent={<Text style={styles.empty}>{t('songs.empty')}</Text>}
        ListFooterComponent={cursor ? <Button kind="plain" label={t('songs.more')} onPress={() => void more()} /> : undefined}
        renderItem={({ item: song }) => (
          <View style={styles.row}>
          <Pressable
            style={styles.rowText}
            disabled={song.status !== 'completed'}
            onPress={() => router.push({ pathname: '/song/[id]', params: { id: song.jobId } })}
            accessibilityRole="button" accessibilityLabel={t('songs.openFor', { title: song.title || t('common.untitledSong') })}
          >
            <View style={styles.rowText}>
              <View style={styles.titleRow}>
                <Text style={[styles.title, styles.grow]} numberOfLines={1}>{song.title || t('common.untitledSong')}</Text>
                {(song.status === 'completed' || song.status === 'failed') && <IconButton bare icon="edit" on={editing === song.jobId}
                  accessibilityLabel={t('songs.editFor', { title: song.title || t('common.untitledSong') })}
                  onPress={() => setEditing(editing === song.jobId ? null : song.jobId)} />}
              </View>
              <Text style={styles.detail} numberOfLines={2}>
                {[
                  song.status !== 'completed' && t(`songs.status.${song.status}`),
                  song.author && t('songs.by', { author: song.author }),
                  song.duration && formatTime(song.duration),
                  new Date(song.createdAt).toLocaleDateString(language),
                ].filter(Boolean).join(' · ')}
              </Text>
              {song.status === 'failed' && !!song.error && <Text style={styles.error}>{song.error}</Text>}
            </View>
          </Pressable>
          {editing === song.jobId && <SongDetails song={song} onClose={() => setEditing(null)}
            onSaved={details => setSongs(current => current?.map(item => item.jobId === song.jobId ? { ...item, ...details } : item) ?? null)} />}
          <ButtonRow>
            {song.status === 'completed' && <Button label={t('songs.open')} onPress={() => router.push({ pathname: '/song/[id]', params: { id: song.jobId } })} />}
            {(song.status === 'completed' || song.status === 'failed') && <Button kind="danger" label={t('songs.delete')} disabled={deleting} onPress={() => void remove(song)} />}
          </ButtonRow>
          </View>
        )}
      />
      <View style={styles.footer}>
        {usage && (
          <Text style={styles.detail}>
            {t('songs.usage', { splits: usage.splits.used, splitLimit: usage.splits.limit, songs: usage.songs.used, songLimit: usage.songs.limit })}
          </Text>
        )}
        <Button label={t('songs.add')} disabled={!!full} onPress={() => router.push('/upload')} />
      </View>
    </SafeAreaView>
  );
}

// Title and artist of one song, edited in place in the list.
function SongDetails({ song, onSaved, onClose }: {
  song: Song; onSaved: (details: { title: string; author: string }) => void; onClose: () => void;
}) {
  const styles = useStyles(makeStyles), theme = useTheme(), { t } = useLanguage();
  const [title, setTitle] = useState(song.title ?? '');
  const [author, setAuthor] = useState(song.author ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (!title.trim()) { setError(t('songs.titleRequired')); return; }
    setSaving(true); setError('');
    try {
      onSaved(await updateSongDetails(song.jobId, { title: title.trim(), author: author.trim() }));
      onClose();
    } catch (failure) { setError(errorText(failure)); }
    finally { setSaving(false); }
  };
  return <View style={styles.editor}>
    <Text style={styles.label}>{t('songs.titleLabel')}</Text>
    <TextInput value={title} onChangeText={setTitle} maxLength={200} autoFocus editable={!saving} returnKeyType="next"
      accessibilityLabel={t('songs.titleLabel')} style={styles.input} placeholderTextColor={theme.muted} placeholder={t('common.untitledSong')} />
    <Text style={styles.label}>{t('songs.artistLabel')}</Text>
    <TextInput value={author} onChangeText={setAuthor} maxLength={200} editable={!saving} returnKeyType="done" onSubmitEditing={() => void save()}
      accessibilityLabel={t('songs.artistLabel')} style={styles.input} placeholderTextColor={theme.muted} placeholder={t('songs.artistPlaceholder')} />
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    <ButtonRow>
      <Button label={saving ? t('common.pleaseWait') : t('songs.saveDetails')} disabled={saving} onPress={() => void save()} />
      <Button kind="plain" label={t('common.cancel')} disabled={saving} onPress={onClose} />
    </ButtonRow>
  </View>;
}

const makeStyles = (t: Theme) => StyleSheet.create({
  page: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  grow: { flex: 1, minWidth: 0 },
  editor: { gap: 6 },
  label: { fontSize: 13, fontWeight: '600', color: t.ink },
  input: { backgroundColor: t.input, borderWidth: 1, borderColor: t.line, borderRadius: 8, paddingHorizontal: 12, height: 44, color: t.ink, fontSize: 16 },
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
