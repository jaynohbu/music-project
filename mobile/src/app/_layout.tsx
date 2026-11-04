import { Stack, router, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View } from 'react-native';
import { AppHeader } from '../app-header';
import { SessionProvider, useSession } from '../session';
import { BACKGROUND, BLUE, ConfirmationProvider, INK, Loading } from '../ui';

function RootNavigator() {
  const { state } = useSession();
  const pathname = usePathname();
  if (state.name === 'loading') return <Loading />;
  const ready = state.name === 'ready';
  return (
    <View style={{ flex: 1 }}>
    {ready && <AppHeader pathname={pathname} navigate={path => router.navigate(path)} />}
    <View style={{ flex: 1 }}><Stack screenOptions={{ headerTintColor: BLUE, headerTitleStyle: { color: INK },
      contentStyle: { backgroundColor: BACKGROUND }, headerBackButtonDisplayMode: 'minimal' }}>
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

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <ConfirmationProvider><SessionProvider>
        <RootNavigator />
      </SessionProvider></ConfirmationProvider>
    </SafeAreaProvider>
  );
}
