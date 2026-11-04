import { Stack, useLocalSearchParams, usePreventRemove } from 'expo-router';
import { useEffect, useReducer, useRef, useState, type ComponentRef } from 'react';
import { AppState, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { getScene, listReadySongs, updateScene, type SceneEntry, type Song } from '../../api';
import { StemScrollView } from '../../stem-scroll';
import { MixerView } from '../../mixer-view';
import { IconButton, InlineEdit } from '../../mixer-console';
import type { Mixer } from '../../player';
import { SceneStore } from '../../scene-store';
import { Button, ButtonRow, errorText, useConfirm } from '../../ui';
import { type Theme, useStyles, useTheme } from '../../theme';

export default function ScenePlayer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <SceneEditor key={id} id={id} />;
}
function SceneEditor({ id }: { id: string }) {
  const styles = useStyles(makeStyles), theme = useTheme();
  const [, render] = useReducer(value => value + 1, 0);
  const [store, setStore] = useState<SceneStore | null>(null);
  const [activeId, setActiveId] = useState('');
  const [error, setError] = useState('');
  const [picker, setPicker] = useState(false);
  const [songs, setSongs] = useState<Song[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allowLeave, setAllowLeave] = useState(false);
  const [reload, setReload] = useState(0);
  const [editingId, setEditingId] = useState('');
  const [renaming, setRenaming] = useState(false);
  const mixer = useRef<Mixer | null>(null);
  const autoPlay = useRef(false);
  const tabs = useRef<ComponentRef<typeof ScrollView>>(null);
  const tabBounds = useRef<Record<string, { x: number; width: number }>>({});
  const tabOffset = useRef(0), tabWidth = useRef(0);
  const confirm = useConfirm();
  useEffect(() => {
    let cancelled = false;
    void getScene(id).then(scene => {
      if (cancelled) return;
      setStore(new SceneStore(scene, updateScene, () => { if (!cancelled) render(); }));
      setActiveId(scene.entries[0]?.id ?? '');
    }).catch(failure => { if (!cancelled) setError(errorText(failure)); });
    void listReadySongs().then(songs => { if (!cancelled) setSongs(songs); })
      .catch(failure => { if (!cancelled) setError(errorText(failure)); });
    return () => { cancelled = true; };
  }, [id, reload]);
  useEffect(() => {
    if (!store) return;
    const sub = AppState.addEventListener('change', state => { if (state !== 'active') void store.flush(); });
    return () => { sub.remove(); void store.flush(); };
  }, [store]);
  usePreventRemove(!!store?.dirty && !allowLeave, ({ repeat }) => {
    void (async () => {
      if (!await store!.flush()) {
        if (!await confirm('Leave without saving?', 'Scene changes could not be saved. Stay to retry, or discard them and leave.', 'Leave')) return;
        store!.discard();
      }
      setAllowLeave(true); repeat();
    })();
  });
  const scene = store?.scene, entry = scene?.entries.find(item => item.id === activeId);
  const index = scene?.entries.findIndex(item => item.id === activeId) ?? -1;
  const title = (item: SceneEntry) => item.title || songs.find(song => song.jobId === item.jobId)?.title || 'Song';
  const select = async (next: string, play = false) => {
    try { await mixer.current?.stop(); }
    catch (failure) { setError(errorText(failure)); return; }
    setError(''); autoPlay.current = play; setActiveId(next);
  };
  const next = (play: boolean) => {
    const following = scene?.entries[index + 1];
    if (following) void select(following.id, play);
    else { autoPlay.current = false; }
  };
  const reveal = (tabId: string) => {
    const bounds = tabBounds.current[tabId];
    if (!bounds) return;
    if (bounds.x < tabOffset.current) tabs.current?.scrollTo({ x: Math.max(0, bounds.x - 4), animated: false });
    else if (bounds.x + bounds.width > tabOffset.current + tabWidth.current)
      tabs.current?.scrollTo({ x: bounds.x + bounds.width - tabWidth.current + 4, animated: false });
  };
  useEffect(() => { reveal(activeId); }, [activeId, scene?.entries]);
  const move = (delta: number) => {
    if (!store || !entry || index + delta < 0 || index + delta >= store.scene.entries.length) return;
    const entries = [...store.scene.entries], [item] = entries.splice(index, 1);
    entries.splice(index + delta, 0, item);
    store.update(scene => ({ ...scene, entries }));
  };
  const remove = async () => {
    if (!store || !entry || !await confirm('Remove song?', `Remove "${title(entry)}" and its settings from this scene? The Music song is not deleted.`, 'Remove')) return;
    await mixer.current?.stop().catch(failure => setError(errorText(failure)));
    const entries = store.scene.entries.filter(item => item.id !== entry.id);
    autoPlay.current = false;
    store.update(scene => ({ ...scene, entries }));
    setActiveId(entries[Math.min(index, entries.length - 1)]?.id ?? '');
  };
  const reloadScene = () => {
    void (async () => {
      if (store?.dirty && !await confirm('Reload saved scene?', 'Discard unsaved changes and stop playback?', 'Reload')) return;
      store?.discard();
      await mixer.current?.stop();
      autoPlay.current = false; setError(''); setActiveId(''); setStore(null); setReload(value => value + 1);
    })().catch(failure => setError(errorText(failure)));
  };
  const openPicker = async () => {
    try {
      setSongs(await listReadySongs()); setSelected(new Set()); setPicker(true);
    } catch (failure) { setError(errorText(failure)); }
  };
  const add = () => {
    if (!store) return;
    const entries = songs.filter(song => selected.has(song.jobId)).map(song => ({ id: randomUUID(), jobId: song.jobId, title: song.title }));
    if (store.scene.entries.length + entries.length > 99) { setError('A scene can have up to 99 songs.'); setPicker(false); return; }
    store.update(scene => ({ ...scene, entries: [...scene.entries, ...entries] }));
    if (!activeId) setActiveId(entries[0]?.id ?? '');
    setPicker(false);
  };
  return <StemScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
    <Stack.Screen options={{ headerTitle: () => <View style={styles.headerTitle}>
      <Text numberOfLines={1} accessibilityRole="header" style={styles.headerText}>{scene?.name || 'Scene'}</Text>
      {scene && <IconButton bare icon="edit" accessibilityLabel="Edit scene name" on={renaming} onPress={() => setRenaming(value => !value)} />}
    </View> }} />
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {!scene ? error ? <Button label="Retry loading scene" onPress={() => { setError(''); setReload(value => value + 1); }} />
      : <Text style={styles.description}>Loading scene…</Text> : <>
      {renaming && <InlineEdit label="Scene name" initial={scene.name} onClose={() => setRenaming(false)}
        onSave={name => { if (name.trim()) store!.update(scene => ({ ...scene, name: name.trim() })); }} />}
      <View style={styles.actions}>
        <Text accessibilityLiveRegion="polite" style={[styles.description, { flex: 1 }]}>{store!.status}</Text>
        <IconButton icon="reload" accessibilityLabel="Reload saved scene" onPress={reloadScene} />
      </View>
      {!!store!.error && <><Text accessibilityRole="alert" style={styles.error}>{store!.error}</Text>
        <Button label="Retry save" onPress={() => { void store!.flush(); }} /></>}
      <ScrollView ref={tabs} horizontal style={styles.tabs} onLayout={event => { tabWidth.current = event.nativeEvent.layout.width; reveal(activeId); }}
        onScroll={event => { tabOffset.current = event.nativeEvent.contentOffset.x; }} scrollEventThrottle={16}>
        {scene.entries.map((item, i) => <Pressable key={item.id} style={[styles.tab, i > 0 && { marginLeft: -10 }, activeId === item.id && styles.activeTab]}
          onLayout={event => { tabBounds.current[item.id] = event.nativeEvent.layout; if (item.id === activeId) reveal(item.id); }}
          accessibilityRole="tab" accessibilityState={{ selected: activeId === item.id }}
          onPress={() => void select(item.id)}>
          <Text numberOfLines={1} style={[styles.tabLabel, activeId === item.id && { color: theme.accent }]}>{i + 1}. {title(item)}</Text>
        </Pressable>)}
        <Pressable style={[styles.tab, styles.addTab, !!scene.entries.length && { marginLeft: -10 }]}
          accessibilityRole="button" accessibilityLabel="Add songs to the scene" onPress={() => void openPicker()}>
          <Text style={[styles.tabLabel, styles.addLabel]}>+</Text>
        </Pressable>
      </ScrollView>
      {entry ? <>
        <View style={styles.songControls}>
          <IconButton icon="previous" accessibilityLabel="Previous song" disabled={index <= 0}
            onPress={() => void select(scene.entries[index - 1].id)} />
          <View style={styles.order}>
            <IconButton icon="moveEarlier" accessibilityLabel="Move song earlier" disabled={index === 0} onPress={() => move(-1)} />
            <Text style={styles.position} accessibilityLabel={`Song ${index + 1} of ${scene.entries.length}`}>
              {index + 1}<Text style={styles.positionTotal}> / {scene.entries.length}</Text>
            </Text>
            <IconButton icon="moveLater" accessibilityLabel="Move song later" disabled={index === scene.entries.length - 1} onPress={() => move(1)} />
          </View>
          <IconButton icon="next" accessibilityLabel="Next / skip song" disabled={index >= scene.entries.length - 1}
            onPress={() => next(false)} />
          <IconButton icon="edit" accessibilityLabel="Edit scene song title" on={editingId === entry.id}
            onPress={() => setEditingId(current => current === entry.id ? '' : entry.id)} />
          <IconButton danger icon="remove" accessibilityLabel="Remove song from scene" onPress={() => void remove()} />
        </View>
        {editingId === entry.id && <InlineEdit key={entry.id} label="Scene song title" initial={entry.title ?? ''}
          placeholder={`${title(entry)} (blank uses Music title)`} onClose={() => setEditingId('')}
          onSave={value => store!.update(scene => ({ ...scene, entries: scene.entries.map(item =>
            item.id === entry.id ? { ...item, title: value.trim() || undefined } : item) }))} />}
        <MixerView key={entry.id} entry={entry} jobId={entry.jobId} title={`${index + 1}. ${title(entry)}`}
          onMixer={player => { mixer.current = player; }}
          onSong={song => setSongs(current => current.some(item => item.jobId === song.jobId) ? current : [...current, song])}
          onSettings={settings => store!.update(scene => ({ ...scene, entries: scene.entries.map(item => item.id === entry.id ? { ...item, settings } : item) }))}
          onEnded={() => next(true)}
          onReady={player => {
            if (autoPlay.current) { autoPlay.current = false; void player.play().catch(failure => setError(errorText(failure))); }
          }} />
      </> : <Text style={styles.description}>This scene is empty. Add a song to get started.</Text>}
    </>}
    <Modal visible={picker} animationType="slide" onRequestClose={() => setPicker(false)}>
      <ScrollView contentContainerStyle={styles.picker}>
        <Text style={styles.heading}>Add songs</Text>
        {songs.map(song => <Pressable key={song.jobId} style={styles.choice}
          accessibilityRole="checkbox" accessibilityState={{ checked: selected.has(song.jobId) }}
          onPress={() => setSelected(current => { const next = new Set(current); if (next.has(song.jobId)) next.delete(song.jobId); else next.add(song.jobId); return next; })}>
          <Text style={styles.label}>{selected.has(song.jobId) ? '✓ ' : '○ '}{song.title}</Text>
        </Pressable>)}
        {!songs.length && <Text style={styles.description}>No completed songs. Upload and split one from Music first.</Text>}
        <ButtonRow><Button kind="plain" label="Cancel" onPress={() => setPicker(false)} />
          <Button label="Add selected songs" disabled={!selected.size} onPress={add} /></ButtonRow>
      </ScrollView>
    </Modal>
  </StemScrollView>;
}
const makeStyles = (t: Theme) => StyleSheet.create({
  page: { padding: 16, gap: 14 },
  heading: { color: t.ink, fontSize: 26, fontWeight: '700' },
  label: { color: t.ink, fontSize: 15, fontWeight: '600' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  headerTitle: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 280 },
  headerText: { color: t.ink, fontSize: 17, fontWeight: '600', flexShrink: 1 },
  addTab: { paddingVertical: 0, paddingHorizontal: 20, justifyContent: 'center' },
  addLabel: { fontSize: 24, lineHeight: 28, fontWeight: '500' },
  songControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  order: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  position: { minWidth: 56, textAlign: 'center', color: t.ink, fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  positionTotal: { color: t.muted, fontSize: 14, fontWeight: '600' },
  description: { color: t.muted, fontSize: 14, lineHeight: 22 },
  error: { color: t.errorInk, backgroundColor: t.dangerSoft, padding: 12, borderRadius: 8 },
  tabs: { borderBottomWidth: 1, borderBottomColor: t.line },
  tab: { padding: 16, maxWidth: 260, borderWidth: 1, borderColor: t.line, borderTopRightRadius: 14, backgroundColor: t.surfaceMuted, minHeight: 48 },
  activeTab: { backgroundColor: t.tabOn, borderBottomColor: t.accent, borderBottomWidth: 3, zIndex: 2 },
  tabLabel: { fontSize: 15, fontWeight: '600', color: t.muted },
  picker: { paddingHorizontal: 20, paddingTop: 64, paddingBottom: 40, gap: 16 },
  choice: { padding: 16, borderWidth: 1, borderColor: t.line, borderRadius: 10, minHeight: 48 },
});
