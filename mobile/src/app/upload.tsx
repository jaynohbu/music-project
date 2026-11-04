import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS, type Upload, createUpload, startSplit, toNumber } from '../api';
import { Button, errorText, formatBytes } from '../ui';
import { type Theme, useStyles, useTheme } from '../theme';

interface Picked { file: File; name: string; bytes: number }

type Step =
  | { name: 'choose' }
  | { name: 'uploading'; fraction: number }
  | { name: 'starting' }
  // The file is uploaded but the split did not start; retrying does not upload again.
  | { name: 'retry'; jobId: string };

export default function UploadSong() {
  const styles = useStyles(makeStyles), theme = useTheme();
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
      setError('Choose a WAV, MP3, M4A, FLAC, OGG or AAC file.');
      return;
    }
    const file = new File(asset.uri);
    const bytes = toNumber(file.size);
    if (bytes > MAX_UPLOAD_BYTES) {
      setError(`This file is ${formatBytes(bytes)}. Files can be up to 55 MB.`);
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
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.page}>
      <Text style={styles.text}>
        Choose an audio file up to 55 MB and 15 minutes long. It is split into vocals, guitar, bass, piano, drums
        and other.
      </Text>
      {picked
        ? <Text style={styles.file} numberOfLines={2}>{picked.name} · {formatBytes(picked.bytes)}</Text>
        : null}
      {step.name === 'choose' && <Button kind={picked ? 'plain' : 'primary'}
        label={picked ? 'Choose another file' : 'Choose a file'} onPress={() => void choose()} />}
      {picked && (
        <TextInput
          style={styles.input} placeholderTextColor={theme.muted} value={title} onChangeText={setTitle} placeholder="Title"
          maxLength={200} editable={step.name === 'choose'}
        />
      )}
      {!!error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
      {step.name === 'uploading' && (
        <View style={styles.progress}>
          <View style={[styles.bar, { width: `${Math.round(step.fraction * 100)}%` }]} />
        </View>
      )}
      {picked && step.name === 'choose' && <Button label="Upload and split" onPress={() => void send()} />}
      {busy && <Text style={styles.text}>{step.name === 'uploading' ? 'Uploading...' : 'Starting the split...'}</Text>}
      {step.name === 'retry' && <Button label="Try again" onPress={() => void split(step.jobId)} />}
    </KeyboardAvoidingView>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  page: { flex: 1, padding: 20, gap: 14 },
  text: { fontSize: 15, color: t.muted },
  file: { fontSize: 16, color: t.ink },
  input: { borderWidth: 1, borderColor: t.line, backgroundColor: t.input, color: t.ink, borderRadius: 8, padding: 14, fontSize: 16 },
  error: { color: t.danger, fontSize: 14 },
  progress: { height: 8, borderRadius: 4, backgroundColor: t.line, overflow: 'hidden' },
  bar: { height: 8, backgroundColor: t.accent },
});
