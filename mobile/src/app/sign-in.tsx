import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSession } from '../session';
import { BLUE, Button, RED, errorText } from '../ui';

export default function SignIn() {
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
          <Button label="Try again" onPress={retry} />
        </>}
        {state.name === 'email' && <>
          <Text style={styles.text}>{state.notice ?? 'Enter your email to get started.'}</Text>
          <TextInput
            style={styles.input} value={email} onChangeText={setEmail} placeholder="Email"
            autoCapitalize="none" autoComplete="email" autoCorrect={false} keyboardType="email-address"
            textContentType="emailAddress" editable={!busy} maxLength={254}
          />
          {!!error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
          <Button label={busy ? 'Please wait...' : 'Continue'} disabled={busy || !email.trim()} onPress={sendCode} />
        </>}
        {state.name === 'code' && <>
          <Text style={styles.text}>This email already has an account. Enter the six-digit code we sent to {email}.</Text>
          <TextInput
            style={styles.input} value={code} onChangeText={setCode} placeholder="Six-digit code"
            keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode"
            editable={!busy} maxLength={6}
          />
          {!!error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
          <Button label={busy ? 'Please wait...' : 'Sign in'} disabled={busy || code.length !== 6} onPress={verify} />
          <Button kind="plain" label="Send a new code" disabled={busy} onPress={sendCode} />
          <Button kind="plain" label="Use a different email" disabled={busy}
            onPress={() => { setError(''); changeEmail(); }} />
        </>}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#fff' },
  form: { flex: 1, justifyContent: 'center', padding: 24, gap: 14 },
  brand: { fontSize: 32, fontWeight: '700', color: BLUE },
  text: { fontSize: 16, color: '#333' },
  input: { borderWidth: 1, borderColor: '#bbb', borderRadius: 8, padding: 14, fontSize: 16 },
  error: { color: RED, fontSize: 14 },
});
