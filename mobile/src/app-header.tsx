import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BLUE, INK, LINE } from './ui';

export type MainRoute = '/' | '/scenes' | '/settings';
export function AppHeader({ pathname, navigate }: { pathname: string; navigate: (path: MainRoute) => void }) {
  return <SafeAreaView edges={['top', 'left', 'right']} style={styles.header}>
    <Text style={styles.brand}>Sorituh</Text>
    <View style={styles.row}>
      {([
        { label: 'Music', path: '/' }, { label: 'Scenes', path: '/scenes' }, { label: 'Settings', path: '/settings' },
      ] as const).map(item => {
        const selected = item.path === '/' ? pathname === '/' || pathname.startsWith('/song') : pathname.startsWith(item.path);
        return <Pressable key={item.path} onPress={() => navigate(item.path)} style={[styles.tab, selected && styles.selected]}
          accessibilityRole="tab" accessibilityState={{ selected }}>
          <Text style={[styles.label, selected && { color: BLUE }]}>{item.label}</Text>
        </Pressable>;
      })}
    </View>
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  header: { backgroundColor: 'white', borderBottomWidth: 1, borderBottomColor: LINE, flexShrink: 0 },
  brand: { fontSize: 22, fontWeight: '700', color: INK, paddingHorizontal: 16, paddingTop: 8 },
  row: { flexDirection: 'row', padding: 8, gap: 6 },
  tab: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  selected: { backgroundColor: '#edf2ff' },
  label: { fontSize: 16, fontWeight: '600', color: '#526177' },
});
