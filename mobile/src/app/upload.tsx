import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS, type Upload, createUpload, startSplit, toNumber } from '../api';
import type { TextKey } from '../i18n';
import { useT } from '../language';
import { Button, errorText, formatBytes } from '../ui';
import { type Theme, ThemeBackground, useStyles, useTheme } from '../theme';

// Stores that sell songs as DRM-free files, for songs the user does not already have.
const STORES = [
  { name: 'Amazon Digital Music', url: 'https://www.amazon.com/MP3-Music-Download/b?node=163856011', note: 'store.amazon' },
  { name: 'Bandcamp', url: 'https://bandcamp.com', note: 'store.bandcamp' },
  { name: '7digital', url: 'https://us.7digital.com', note: 'store.7digital' },
] satisfies { name: string; url: string; note: TextKey }[];

interface Picked { file: File; name: string; bytes: number }

type Step =
  | { name: 'choose' }
  | { name: 'uploading'; fraction: number }
  | { name: 'starting' }
  // The file is uploaded but the split did not start; retrying does not upload again.
  | { name: 'retry'; jobId: string };

export default function UploadSong() {
  const styles = useStyles(makeStyles), theme = useTheme(), t = useT();
  const [picked, setPicked] = useState<Picked | null>(null);
  const [title, setTitle] = useState('');
  const [step, setStep] = useState<Step>({ name: 'choose' });
  const [error, setError] = useState('');
  const upload = useRef<Upload | null>(null);

  // Leaving the screen cancels an upload in progress.
  useEffect(() => () => upload.current?.cancel(), []);

  const choose = async () => {
    setError('');
    let result: DocumentPicker.DocumentPickerResult;
    try { result = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true }); }
    catch (failure) { setError(errorText(failure)); return; }
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!UPLOAD_EXTENSIONS.test(asset.name)) {
      setError(t('upload.badType'));
      return;
    }
    const file = new File(asset.uri);
    const bytes = toNumber(file.size);
    if (bytes > MAX_UPLOAD_BYTES) {
      setError(t('upload.tooBig', { size: formatBytes(bytes) }));
      return;
    }
    setPicked({ file, name: asset.name, bytes });
    setTitle(asset.name.replace(/\.[^.]+$/, ''));
  };

  const split = async (jobId: string) => {
    setStep({ name: 'starting' });
    try {
      await startSplit(jobId);
      router.dismissTo('/');
    } catch (failure) {
      setError(errorText(failure));
      setStep({ name: 'retry', jobId });
    }
  };

  const send = async () => {
    if (!picked) return;
    setError('');
    setStep({ name: 'uploading', fraction: 0 });
    let jobId: string;
    try {
      const created = await createUpload(picked.file, picked.name, title.trim() || picked.name,
        fraction => setStep({ name: 'uploading', fraction }));
      upload.current = created.upload;
      await created.upload.promise;
      jobId = created.job.jobId;
    } catch (failure) {
      setError(errorText(failure));
      setStep({ name: 'choose' });
      return;
    } finally {
      upload.current = null;
    }
    await split(jobId);
  };

  const busy = step.name === 'uploading' || step.name === 'starting';
  return (
    // A modal sits over the song list, so it brings its own backdrop instead of the transparent screen.
    <ThemeBackground><KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.fill}>
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Text style={styles.text}>{t('upload.intro')}</Text>
      {picked
        ? <Text style={styles.file} numberOfLines={2}>{picked.name} · {formatBytes(picked.bytes)}</Text>
        : null}
      {step.name === 'choose' && <Button kind={picked ? 'plain' : 'primary'}
        label={picked ? t('upload.chooseAnother') : t('upload.choose')} onPress={() => void choose()} />}
      {picked && (
        <TextInput
          style={styles.input} placeholderTextColor={theme.muted} value={title} onChangeText={setTitle} placeholder={t('upload.title')}
          maxLength={200} editable={step.name === 'choose'}
        />
      )}
      {!!error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
      {step.name === 'uploading' && (
        <View style={styles.progress}>
          <View style={[styles.bar, { width: `${Math.round(step.fraction * 100)}%` }]} />
        </View>
      )}
      {picked && step.name === 'choose' && <Button label={t('upload.send')} onPress={() => void send()} />}
      {busy && <Text style={styles.text}>{step.name === 'uploading' ? t('upload.uploading') : t('upload.starting')}</Text>}
      {step.name === 'retry' && <Button label={t('common.tryAgain')} onPress={() => void split(step.jobId)} />}
      {!picked && <View style={styles.stores}>
        <Text style={styles.storesTitle}>{t('upload.storesTitle')}</Text>
        <Text style={styles.note}>{t('upload.storesNote')}</Text>
        {STORES.map(store => <Pressable key={store.name} accessibilityRole="link" accessibilityHint={t('upload.opensBrowser')}
          onPress={() => void Linking.openURL(store.url).catch(failure => setError(errorText(failure)))}
          style={({ pressed }) => [styles.store, pressed && { opacity: .7 }]}>
          <Text style={styles.storeName}>{store.name} ↗</Text>
          <Text style={styles.note}>{t(store.note)}</Text>
        </Pressable>)}
      </View>}
    </ScrollView>
    </KeyboardAvoidingView></ThemeBackground>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  fill: { flex: 1 },
  page: { padding: 20, gap: 14 },
  text: { fontSize: 15, color: t.muted },
  file: { fontSize: 16, color: t.ink },
  input: { borderWidth: 1, borderColor: t.line, backgroundColor: t.input, color: t.ink, borderRadius: 8, padding: 14, fontSize: 16 },
  error: { color: t.danger, fontSize: 14 },
  progress: { height: 8, borderRadius: 4, backgroundColor: t.line, overflow: 'hidden' },
  bar: { height: 8, backgroundColor: t.accent },
  stores: { marginTop: 10, gap: 8, borderTopWidth: 1, borderTopColor: t.line, paddingTop: 16 },
  storesTitle: { fontSize: 16, fontWeight: '700', color: t.ink },
  store: { borderWidth: 1, borderColor: t.line, backgroundColor: t.surface, borderRadius: 8, padding: 12, gap: 3 },
  storeName: { fontSize: 15, fontWeight: '700', color: t.accent },
  note: { fontSize: 13, lineHeight: 18, color: t.muted },
});
