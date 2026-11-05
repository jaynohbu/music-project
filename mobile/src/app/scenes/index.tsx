import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { createScene, deleteScene, listScenes, type Scene } from '../../api';
import { useT } from '../../language';
import { Button, ButtonRow, errorText, useConfirm } from '../../ui';
import { type Theme, useStyles, useTheme } from '../../theme';

export default function Scenes() {
  const styles = useStyles(makeStyles), theme = useTheme(), t = useT();
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
    if (!await confirm(t('scenes.deleteTitle'), t('scenes.deleteMessage', { name: scene.name }), t('scenes.delete'))) return;
    setBusy(true);
    try { await deleteScene(scene.id); await load(); }
    catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  };
  return <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
    <Text style={styles.eyebrow}>{t('scenes.eyebrow')}</Text>
    <Text style={styles.heading}>{t('scenes.heading')}</Text>
    <Text style={styles.description}>{t('scenes.intro')}</Text>
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    <View style={styles.card}>
      <Text style={styles.label}>{t('scenes.newName')}</Text>
      <TextInput value={name} onChangeText={setName} maxLength={200} style={styles.input} placeholderTextColor={theme.muted} accessibilityLabel={t('scenes.newName')} />
      <Button label={t('scenes.create')} disabled={!name.trim() || busy} onPress={() => void create()} />
    </View>
    {loading && <Text style={styles.description}>{t('scenes.loading')}</Text>}
    {!loading && !scenes.length && <Text style={styles.description}>{t('scenes.empty')}</Text>}
    {scenes.map(scene => <View key={scene.id} style={styles.card}>
      <Text style={styles.title}>{scene.name}</Text>
      <Text style={styles.description}>{t('scenes.songCount', { count: scene.entries.length })}</Text>
      <ButtonRow>
        <Button label={t('scenes.open')} onPress={() => router.push({ pathname: '/scenes/[id]', params: { id: scene.id } })} />
        <Button kind="danger" label={t('scenes.delete')} disabled={busy} onPress={() => void remove(scene)} />
      </ButtonRow>
    </View>)}
    <Button kind="plain" label={t('scenes.refresh')} disabled={busy} onPress={() => void load()} />
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
