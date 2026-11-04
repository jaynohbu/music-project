import { Children, createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { type Theme, useStyles, useTheme } from './theme';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

type Confirm = (title: string, message: string, action?: string) => Promise<boolean>;
const Confirmation = createContext<Confirm | null>(null);
export function useConfirm() {
  const confirm = useContext(Confirmation);
  if (!confirm) throw new Error('ConfirmationProvider is missing.');
  return confirm;
}
export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const styles = useStyles(makeStyles);
  const [pending, setPending] = useState<{ title: string; message: string; action: string } | null>(null);
  const resolve = useRef<((result: boolean) => void) | null>(null);
  useEffect(() => () => { resolve.current?.(false); }, []);
  const finish = (result: boolean) => { resolve.current?.(result); resolve.current = null; setPending(null); };
  const confirm: Confirm = (title, message, action = 'Confirm') => {
    resolve.current?.(false);
    setPending({ title, message, action });
    return new Promise<boolean>(done => { resolve.current = done; });
  };
  return <Confirmation.Provider value={confirm}>{children}
    <Modal visible={!!pending} transparent animationType="fade" onRequestClose={() => finish(false)}>
      <View style={styles.backdrop}><View style={styles.dialog} accessibilityViewIsModal>
        <Text style={styles.dialogTitle}>{pending?.title}</Text>
        <Text style={styles.dialogMessage}>{pending?.message}</Text>
        <ButtonRow>
          <Button label="Cancel" kind="plain" onPress={() => finish(false)} />
          <Button label={pending?.action ?? 'Confirm'} onPress={() => finish(true)} />
        </ButtonRow>
      </View></View>
    </Modal>
  </Confirmation.Provider>;
}

export function Button({ label, onPress, disabled, kind = 'primary', style }: {
  label: string; onPress: () => void; disabled?: boolean; kind?: 'primary' | 'plain' | 'danger';
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles(makeStyles), theme = useTheme();
  return (
    <Pressable
      style={[styles.button, styles[kind], disabled && styles.disabled, style]}
      onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityState={{ disabled: !!disabled }}
    >
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}
        style={[styles.label, kind !== 'primary' && { color: kind === 'danger' ? theme.danger : theme.accent }]}>{label}</Text>
    </Pressable>
  );
}

// Lays buttons side by side, each taking an equal share of the width.
export function ButtonRow({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const styles = useStyles(makeStyles);
  return <View style={[styles.buttonRow, style]}>
    {Children.toArray(children).map((child, i) => <View key={i} style={styles.buttonCell}>{child}</View>)}
  </View>;
}

export function Centered({ children }: { children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return <View style={styles.centered}>{children}</View>;
}

export function Loading() {
  return <Centered><ActivityIndicator color={useTheme().accent} /></Centered>;
}

export const errorText = (failure: unknown) =>
  failure instanceof Error ? failure.message : 'Something went wrong. Please try again.';

export function formatTime(seconds: number) {
  const whole = Math.max(Math.floor(seconds), 0);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export function formatBytes(bytes: number) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

const makeStyles = (t: Theme) => StyleSheet.create({
  button: { borderRadius: 8, paddingVertical: 13, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
  primary: { backgroundColor: t.accent },
  plain: { backgroundColor: t.accentSoft },
  danger: { backgroundColor: t.dangerSoft },
  disabled: { opacity: 0.45 },
  label: { color: t.onAccent, fontSize: 16, fontWeight: '600' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 },
  backdrop: { flex: 1, backgroundColor: t.backdrop, padding: 24, justifyContent: 'center' },
  dialog: { backgroundColor: t.dialog, borderRadius: 16, padding: 24, gap: 16 },
  dialogTitle: { fontSize: 22, fontWeight: '700', color: t.ink },
  dialogMessage: { fontSize: 16, lineHeight: 24, color: t.muted },
});
