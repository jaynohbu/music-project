import { Stack, useLocalSearchParams, usePreventRemove } from 'expo-router';
import { useEffect, useReducer, useRef, useState, type ComponentRef } from 'react';
import { AppState, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { getScene, listReadySongs, updateScene, type SceneEntry, type Song } from '../../api';
import { MixerView } from '../../mixer-view';
import type { Mixer } from '../../player';
import { SceneStore } from '../../scene-store';
import { BLUE, Button, GREY, INK, LINE, errorText, useConfirm } from '../../ui';

export default function ScenePlayer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <SceneEditor key={id} id={id} />;
}
function SceneEditor({ id }: { id: string }) {
  const [, render] = useReducer(value => value + 1, 0);
  const [store, setStore] = useState<SceneStore | null>(null);
  const [activeId, setActiveId] = useState('');
  const [error, setError] = useState('');
  const [picker, setPicker] = useState(false);
  const [songs, setSongs] = useState<Song[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allowLeave, setAllowLeave] = useState(false);
  const [reload, setReload] = useState(0);
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
  return <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
    <Stack.Screen options={{ title: scene?.name ?? 'Scene' }} />
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {!scene ? error ? <Button label="Retry loading scene" onPress={() => { setError(''); setReload(value => value + 1); }} />
      : <Text style={styles.description}>Loading scene…</Text> : <>
      <Text style={styles.heading}>{scene.name}</Text>
      <Text style={styles.label}>Scene name</Text>
      <TextInput style={styles.input} value={scene.name} maxLength={200} accessibilityLabel="Scene name"
        onChangeText={name => store!.update(scene => ({ ...scene, name }))} />
      <View style={styles.actions}>
        <Text accessibilityLiveRegion="polite" style={styles.description}>{store!.status}</Text>
        <Button label="Add songs" onPress={() => void openPicker()} />
      </View>
      {!!store!.error && <><Text accessibilityRole="alert" style={styles.error}>{store!.error}</Text>
        <View style={styles.actions}>
          <Button label="Retry save" onPress={() => { void store!.flush(); }} />
          <Button kind="plain" label="Reload saved scene" onPress={() => {
            void (async () => {
              if (!await confirm('Reload saved scene?', 'Discard unsaved changes and stop playback?', 'Reload')) return;
              store!.discard();
              await mixer.current?.stop();
              autoPlay.current = false; setError(''); setActiveId(''); setStore(null); setReload(value => value + 1);
            })().catch(failure => setError(errorText(failure)));
          }} />
        </View></>}
      <ScrollView ref={tabs} horizontal style={styles.tabs} onLayout={event => { tabWidth.current = event.nativeEvent.layout.width; reveal(activeId); }}
        onScroll={event => { tabOffset.current = event.nativeEvent.contentOffset.x; }} scrollEventThrottle={16}>
        {scene.entries.map((item, i) => <Pressable key={item.id} style={[styles.tab, i > 0 && { marginLeft: -10 }, activeId === item.id && styles.activeTab]}
          onLayout={event => { tabBounds.current[item.id] = event.nativeEvent.layout; if (item.id === activeId) reveal(item.id); }}
          accessibilityRole="tab" accessibilityState={{ selected: activeId === item.id }}
          onPress={() => void select(item.id)}>
          <Text numberOfLines={1} style={[styles.tabLabel, activeId === item.id && { color: BLUE }]}>{i + 1}. {title(item)}</Text>
        </Pressable>)}
      </ScrollView>
      {entry ? <>
        <Text style={styles.label}>Scene song title (blank uses Music title)</Text>
        <TextInput value={entry.title ?? ''} placeholder={title(entry)} style={styles.input} maxLength={200} accessibilityLabel="Scene song title"
          onChangeText={title => store!.update(scene => ({ ...scene, entries: scene.entries.map(item =>
            item.id === entry.id ? { ...item, title: title.trim() ? title : undefined } : item) }))} />
        <View style={styles.actions}>
          <Button kind="plain" label="Move earlier" disabled={index === 0} onPress={() => move(-1)} />
          <Button kind="plain" label="Move later" disabled={index === scene.entries.length - 1} onPress={() => move(1)} />
          <Button kind="danger" label="Remove song" onPress={() => void remove()} />
        </View>
        <View style={styles.actions}>
          <Button kind="plain" label="Previous song" disabled={index <= 0} onPress={() => void select(scene.entries[index - 1].id)} />
          <Button kind="plain" label="Next / skip song" disabled={index >= scene.entries.length - 1} onPress={() => next(false)} />
        </View>
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
        <View style={styles.actions}><Button kind="plain" label="Cancel" onPress={() => setPicker(false)} />
          <Button label="Add selected songs" disabled={!selected.size} onPress={add} /></View>
      </ScrollView>
    </Modal>
  </ScrollView>;
}
const styles = StyleSheet.create({
  page: { padding: 16, gap: 14 },
  heading: { color: INK, fontSize: 26, fontWeight: '700' },
  label: { color: INK, fontSize: 15, fontWeight: '600' },
  input: { backgroundColor: 'white', borderWidth: 1, borderColor: LINE, borderRadius: 9, padding: 12, color: INK, fontSize: 16 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  description: { color: GREY, fontSize: 14, lineHeight: 22 },
  error: { color: '#a52c35', backgroundColor: '#fff0f0', padding: 12, borderRadius: 8 },
  tabs: { borderBottomWidth: 1, borderBottomColor: LINE },
  tab: { padding: 16, maxWidth: 260, borderWidth: 1, borderColor: LINE, borderTopRightRadius: 14, backgroundColor: '#eef2f8', minHeight: 48 },
  activeTab: { backgroundColor: '#dfe9ff', borderBottomColor: BLUE, borderBottomWidth: 3, zIndex: 2 },
  tabLabel: { fontSize: 15, fontWeight: '600', color: GREY },
  picker: { paddingHorizontal: 20, paddingTop: 64, paddingBottom: 40, gap: 16 },
  choice: { padding: 16, borderWidth: 1, borderColor: LINE, borderRadius: 10, minHeight: 48 },
});
