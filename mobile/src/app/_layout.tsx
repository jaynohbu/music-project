import { DarkTheme, DefaultTheme, ThemeProvider as NavigationTheme, Stack, router, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View } from 'react-native';
import { AppHeader } from '../app-header';
import { SessionProvider, useSession } from '../session';
import { LanguageProvider, useT } from '../language';
import { ThemeBackground, ThemeProvider, useTheme } from '../theme';
import { ConfirmationProvider, Loading } from '../ui';

// On iOS 26 the back swipe works from anywhere on the screen, so dragging a mixer
// slider to the right left the screen. These screens use the back button instead.
const noSwipeBack = { gestureEnabled: false, fullScreenGestureEnabled: false };

function RootNavigator() {
  const { state } = useSession();
  const pathname = usePathname();
  const theme = useTheme();
  const t = useT();
  if (state.name === 'loading') return <Loading />;
  const ready = state.name === 'ready';
  return (
    <View style={{ flex: 1 }}>
    {ready && <AppHeader pathname={pathname} navigate={path => router.navigate(path)} />}
    <View style={{ flex: 1 }}><Stack screenOptions={{ headerTintColor: theme.accent, headerTitleStyle: { color: theme.ink },
      headerStyle: { backgroundColor: theme.header.slice(0, 7) },
      contentStyle: { backgroundColor: 'transparent' }, statusBarStyle: theme.dark ? 'light' : 'dark',
      headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Protected guard={ready}>
        <Stack.Screen name="index" options={{ title: t('title.music') }} />
        <Stack.Screen name="scenes/index" options={{ title: t('title.scenes') }} />
        <Stack.Screen name="scenes/[id]" options={{ title: t('title.scene'), ...noSwipeBack }} />
        <Stack.Screen name="upload" options={{ title: t('title.upload'), presentation: 'modal' }} />
        <Stack.Screen name="song/[id]" options={{ title: '', ...noSwipeBack }} />
        <Stack.Screen name="settings" options={{ title: t('title.settings') }} />
      </Stack.Protected>
      <Stack.Protected guard={!ready}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      </Stack.Protected>
    </Stack></View>
    </View>
  );
}

function Themed() {
  const theme = useTheme();
  const base = theme.dark ? DarkTheme : DefaultTheme;
  // Screens stay transparent so the theme's backdrop shows through.
  const navigation = { ...base, colors: { ...base.colors, background: 'transparent', card: theme.header.slice(0, 7),
    text: theme.ink, border: theme.line, primary: theme.accent } };
  return <ThemeBackground><NavigationTheme value={navigation}>
    <StatusBar style={theme.dark ? 'light' : 'dark'} />
    <ConfirmationProvider><SessionProvider>
      <RootNavigator />
    </SessionProvider></ConfirmationProvider>
  </NavigationTheme></ThemeBackground>;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider><LanguageProvider><ThemeProvider>
      <Themed />
    </ThemeProvider></LanguageProvider></SafeAreaProvider>
  );
}
