import { setAudioModeAsync } from 'expo-audio';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, TextInput,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import {
  RejectedError, SITE_URL, WebSession, forgetPassword, savedEmail, savedLogin, signIn, signInDevice,
} from './src/auth';

const BLUE = '#3459c9';

type Screen =
  | { name: 'loading' }
  | { name: 'offline'; message: string }
  | { name: 'email'; notice?: string }
  | { name: 'code' }
  | { name: 'site'; session: WebSession };

// Hands the session to the website before it starts, then reports when it signs out.
const siteScript = (session: WebSession) => `
  if (!sessionStorage.getItem('youtube-session')) {
    sessionStorage.setItem('youtube-session', ${JSON.stringify(JSON.stringify(session))});
  }
  setInterval(function () {
    if (!sessionStorage.getItem('youtube-session')) window.ReactNativeWebView.postMessage('signed-out');
  }, 1000);
  true;
`;

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const start = useCallback(async () => {
    setScreen({ name: 'loading' });
    try {
      const login = await savedLogin();
      if (!login) {
        setEmail(await savedEmail() ?? '');
        setScreen({ name: 'email' });
        return;
      }
      setEmail(login.email);
      try {
        setScreen({ name: 'site', session: await signIn(login.email, login.password) });
      } catch (failure) {
        if (!(failure instanceof RejectedError)) throw failure;
        // The password was replaced from another device or the website.
        await forgetPassword();
        const session = await signInDevice(login.email);
        setScreen(session ? { name: 'site', session } : { name: 'code' });
      }
    } catch (failure) {
      if (failure instanceof RejectedError) {
        setScreen({ name: 'email', notice: failure.message });
      } else {
        setScreen({ name: 'offline', message: failure instanceof Error ? failure.message : 'Unable to connect.' });
      }
    }
  }, []);

  useEffect(() => {
    // Without this, iPhones in silent mode play no audio from the website.
    setAudioModeAsync({ playsInSilentMode: true }).catch(failure => console.warn('Audio mode not set', failure));
    void start();
  }, [start]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  const sendCode = () => run(async () => {
    const address = email.trim().toLowerCase();
    const session = await signInDevice(address);
    setEmail(address);
    setCode('');
    setScreen(session ? { name: 'site', session } : { name: 'code' });
  });
  const verify = () => run(async () => {
    const session = await signInDevice(email, code);
    if (session) setScreen({ name: 'site', session });
  });
  const signedOut = useCallback(async () => {
    await forgetPassword();
    setScreen({ name: 'email' });
  }, []);

  if (screen.name === 'site') {
    return (
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <SafeAreaView style={styles.site}>
          <WebView
            source={{ uri: SITE_URL }}
            injectedJavaScriptBeforeContentLoaded={siteScript(screen.session)}
            onMessage={event => { if (event.nativeEvent.data === 'signed-out') void signedOut(); }}
            onShouldStartLoadWithRequest={request => {
              if (request.url.startsWith(SITE_URL) || !request.isTopFrame) return true;
              void Linking.openURL(request.url);
              return false;
            }}
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            allowsBackForwardNavigationGestures
            startInLoadingState
            renderLoading={() => <ActivityIndicator style={StyleSheet.absoluteFill} color={BLUE} />}
          />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.page}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.form}>
          <Text style={styles.brand}>Sorituh</Text>
          {screen.name === 'loading' && <ActivityIndicator color={BLUE} />}
          {screen.name === 'offline' && <>
            <Text style={styles.text}>{screen.message}</Text>
            <Pressable style={styles.button} onPress={() => void start()}>
              <Text style={styles.buttonText}>Try again</Text>
            </Pressable>
          </>}
          {screen.name === 'email' && <>
            <Text style={styles.text}>{screen.notice ?? 'Enter your email to get started.'}</Text>
            <TextInput
              style={styles.input} value={email} onChangeText={setEmail} placeholder="Email"
              autoCapitalize="none" autoComplete="email" autoCorrect={false} keyboardType="email-address"
              textContentType="emailAddress" editable={!busy} maxLength={254}
            />
            {!!error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
            <Pressable style={[styles.button, (busy || !email.trim()) && styles.disabled]}
              disabled={busy || !email.trim()} onPress={() => void sendCode()}>
              <Text style={styles.buttonText}>{busy ? 'Please wait...' : 'Continue'}</Text>
            </Pressable>
          </>}
          {screen.name === 'code' && <>
            <Text style={styles.text}>This email already has an account. Enter the six-digit code we sent to {email}.</Text>
            <TextInput
              style={styles.input} value={code} onChangeText={setCode} placeholder="Six-digit code"
              keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode"
              editable={!busy} maxLength={6}
            />
            {!!error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
            <Pressable style={[styles.button, (busy || code.length !== 6) && styles.disabled]}
              disabled={busy || code.length !== 6} onPress={() => void verify()}>
              <Text style={styles.buttonText}>{busy ? 'Please wait...' : 'Sign in'}</Text>
            </Pressable>
            <Pressable style={styles.link} disabled={busy} onPress={() => void sendCode()}>
              <Text style={styles.linkText}>Send a new code</Text>
            </Pressable>
            <Pressable style={styles.link} disabled={busy} onPress={() => { setError(''); setScreen({ name: 'email' }); }}>
              <Text style={styles.linkText}>Use a different email</Text>
            </Pressable>
          </>}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  site: { flex: 1, backgroundColor: '#fff' },
  page: { flex: 1, backgroundColor: '#fff' },
  form: { flex: 1, justifyContent: 'center', padding: 24, gap: 14 },
  brand: { fontSize: 32, fontWeight: '700', color: BLUE },
  text: { fontSize: 16, color: '#333' },
  input: { borderWidth: 1, borderColor: '#bbb', borderRadius: 8, padding: 14, fontSize: 16 },
  error: { color: '#b00020', fontSize: 14 },
  button: { backgroundColor: BLUE, borderRadius: 8, padding: 15, alignItems: 'center' },
  disabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  link: { padding: 8, alignItems: 'center' },
  linkText: { color: BLUE, fontSize: 15 },
});
