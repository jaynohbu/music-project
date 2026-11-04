import { DarkTheme, DefaultTheme, ThemeProvider as NavigationTheme, Stack, router, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View } from 'react-native';
import { AppHeader } from '../app-header';
import { SessionProvider, useSession } from '../session';
import { ThemeBackground, ThemeProvider, useTheme } from '../theme';
import { ConfirmationProvider, Loading } from '../ui';

function RootNavigator() {
  const { state } = useSession();
  const pathname = usePathname();
  const theme = useTheme();
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
        <Stack.Screen name="index" options={{ title: 'Sorituh · Music' }} />
        <Stack.Screen name="scenes/index" options={{ title: 'Sorituh · Scenes' }} />
        <Stack.Screen name="scenes/[id]" options={{ title: 'Scene' }} />
        <Stack.Screen name="upload" options={{ title: 'Add a song', presentation: 'modal' }} />
        <Stack.Screen name="song/[id]" options={{ title: '' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
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
    <SafeAreaProvider><ThemeProvider>
      <Themed />
    </ThemeProvider></SafeAreaProvider>
  );
}
