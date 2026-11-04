import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { createScene, deleteScene, listScenes, type Scene } from '../../api';
import { Button, ButtonRow, errorText, useConfirm } from '../../ui';
import { type Theme, useStyles, useTheme } from '../../theme';

export default function Scenes() {
  const styles = useStyles(makeStyles), theme = useTheme();
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const load = useCallback(async () => {
    try { setScenes(await listScenes()); setError(''); }
    catch (failure) { setError(errorText(failure)); }
    finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  const create = async () => {
    setBusy(true);
    try {
      const scene = await createScene(name.trim()); setName('');
      router.push({ pathname: '/scenes/[id]', params: { id: scene.id } });
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  };
  const remove = async (scene: Scene) => {
    if (!await confirm('Delete scene?', `Delete "${scene.name}"? Your music files will not be deleted.`, 'Delete scene')) return;
    setBusy(true);
    try { await deleteScene(scene.id); await load(); }
    catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  };
  return <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
    <Text style={styles.eyebrow}>YOUR SETS</Text>
    <Text style={styles.heading}>Scenes</Text>
    <Text style={styles.description}>Your songs in order, with independent mixer settings.</Text>
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    <View style={styles.card}>
      <Text style={styles.label}>New scene name</Text>
      <TextInput value={name} onChangeText={setName} maxLength={200} style={styles.input} placeholderTextColor={theme.muted} accessibilityLabel="New scene name" />
      <Button label="Create scene" disabled={!name.trim() || busy} onPress={() => void create()} />
    </View>
    {loading && <Text>Loading scenes…</Text>}
    {!loading && !scenes.length && <Text style={styles.description}>No scenes yet. Create one and add songs from Music.</Text>}
    {scenes.map(scene => <View key={scene.id} style={styles.card}>
      <Text style={styles.title}>{scene.name}</Text>
      <Text style={styles.description}>{scene.entries.length} songs</Text>
      <ButtonRow>
        <Button label="Open scene" onPress={() => router.push({ pathname: '/scenes/[id]', params: { id: scene.id } })} />
        <Button kind="danger" label="Delete scene" disabled={busy} onPress={() => void remove(scene)} />
      </ButtonRow>
    </View>)}
    <Button kind="plain" label="Refresh" disabled={busy} onPress={() => void load()} />
  </ScrollView>;
}
const makeStyles = (t: Theme) => StyleSheet.create({
  page: { padding: 16, gap: 14 },
  eyebrow: { fontSize: 12, letterSpacing: 1.5, color: t.accent, fontWeight: '700' },
  heading: { fontSize: 30, fontWeight: '700', color: t.ink },
  description: { fontSize: 14, lineHeight: 21, color: t.muted },
  card: { backgroundColor: t.surface, padding: 18, borderWidth: 1, borderColor: t.line, borderRadius: 14, gap: 12 },
  input: { borderColor: t.line, borderWidth: 1, borderRadius: 9, padding: 12, fontSize: 16, color: t.ink, backgroundColor: t.input },
  label: { color: t.ink, fontWeight: '600', fontSize: 14 },
  title: { color: t.ink, fontWeight: '700', fontSize: 19 },
  error: { color: t.errorInk, backgroundColor: t.dangerSoft, padding: 12, borderRadius: 8 },
});
