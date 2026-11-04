import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type Theme, useStyles, useTheme } from './theme';

export type MainRoute = '/' | '/scenes' | '/settings';
export function AppHeader({ pathname, navigate }: { pathname: string; navigate: (path: MainRoute) => void }) {
  const styles = useStyles(makeStyles), theme = useTheme();
  return <SafeAreaView edges={['top', 'left', 'right']} style={styles.header}>
    <Text style={styles.brand}>Sorituh</Text>
    <View style={styles.row}>
      {([
        { label: 'Music', path: '/' }, { label: 'Scenes', path: '/scenes' }, { label: 'Settings', path: '/settings' },
      ] as const).map(item => {
        const selected = item.path === '/' ? pathname === '/' || pathname.startsWith('/song') : pathname.startsWith(item.path);
        return <Pressable key={item.path} onPress={() => navigate(item.path)} style={[styles.tab, selected && styles.selected]}
          accessibilityRole="tab" accessibilityState={{ selected }}>
          <Text style={[styles.label, selected && { color: theme.accent }]}>{item.label}</Text>
        </Pressable>;
      })}
    </View>
  </SafeAreaView>;
}
const makeStyles = (t: Theme) => StyleSheet.create({
  header: { backgroundColor: t.header, borderBottomWidth: 1, borderBottomColor: t.line, flexShrink: 0 },
  brand: { fontSize: 22, fontWeight: '700', color: t.ink, paddingHorizontal: 16, paddingTop: 8 },
  row: { flexDirection: 'row', padding: 8, gap: 6 },
  tab: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  selected: { backgroundColor: t.tabOn },
  label: { fontSize: 16, fontWeight: '600', color: t.muted },
});
