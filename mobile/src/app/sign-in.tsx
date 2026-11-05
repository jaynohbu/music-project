import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useT } from '../language';
import { useSession } from '../session';
import { Button, errorText } from '../ui';
import { type Theme, useStyles, useTheme } from '../theme';

export default function SignIn() {
  const styles = useStyles(makeStyles), theme = useTheme(), t = useT();
  const { state, email, setEmail, retry, continueWith, changeEmail } = useSession();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const sendCode = () => run(async () => {
    setCode('');
    await continueWith(email.trim().toLowerCase());
  });
  const verify = () => run(() => continueWith(email, code));

  return (
    <SafeAreaView style={styles.page}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.form}>
        <Text style={styles.brand}>Sorituh</Text>
        {state.name === 'offline' && <>
          <Text style={styles.text}>{state.message}</Text>
          <Button label={t('common.tryAgain')} onPress={retry} />
        </>}
        {state.name === 'email' && <>
          <Text style={styles.text}>{state.notice ?? t('signIn.start')}</Text>
          <TextInput
            style={styles.input} placeholderTextColor={theme.muted} value={email} onChangeText={setEmail} placeholder={t('signIn.email')}
            autoCapitalize="none" autoComplete="email" autoCorrect={false} keyboardType="email-address"
            textContentType="emailAddress" editable={!busy} maxLength={254}
          />
          {!!error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
          <Button label={busy ? t('common.pleaseWait') : t('signIn.continue')} disabled={busy || !email.trim()} onPress={sendCode} />
        </>}
        {state.name === 'code' && <>
          <Text style={styles.text}>{t('signIn.codePrompt', { email })}</Text>
          <TextInput
            style={styles.input} placeholderTextColor={theme.muted} value={code} onChangeText={setCode} placeholder={t('signIn.code')}
            keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode"
            editable={!busy} maxLength={6}
          />
          {!!error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
          <Button label={busy ? t('common.pleaseWait') : t('signIn.signIn')} disabled={busy || code.length !== 6} onPress={verify} />
          <Button kind="plain" label={t('signIn.newCode')} disabled={busy} onPress={sendCode} />
          <Button kind="plain" label={t('signIn.otherEmail')} disabled={busy}
            onPress={() => { setError(''); changeEmail(); }} />
        </>}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  page: { flex: 1 },
  form: { flex: 1, justifyContent: 'center', padding: 24, gap: 14 },
  brand: { fontSize: 32, fontWeight: '700', color: t.accent },
  text: { fontSize: 16, color: t.ink },
  input: { borderWidth: 1, borderColor: t.line, borderRadius: 8, padding: 14, fontSize: 16, color: t.ink, backgroundColor: t.input },
  error: { color: t.danger, fontSize: 14 },
});
