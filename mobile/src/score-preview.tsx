import { useMemo, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SvgXml } from 'react-native-svg';
import type { SheetPages } from './score-sheet';
import { Button, ButtonRow } from './ui';
import { useT } from './language';
import { type Theme, useStyles } from './theme';

const GAP = 12;

// The whole score as the printed pages, one under another; pinch to zoom in on a line.
export function ScorePreview({ sheet, title, saving, onSave, onClose }: {
  sheet: SheetPages; title: string; saving: boolean; onSave: () => void; onClose: () => void;
}) {
  const styles = useStyles(makeStyles), t = useT();
  const { width: screen } = useWindowDimensions();
  const [shown, setShown] = useState(2);
  const width = screen - 2 * GAP, height = width * sheet.height / sheet.width;
  // Pages are parsed as they come into view, so a long score opens at once.
  const pages = useMemo(() => sheet.pages.slice(0, shown), [sheet.pages, shown]);
  return <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1} accessibilityRole="header">{title}</Text>
        <Text style={styles.hint}>{t('tasks.previewPages', { count: sheet.pages.length })}</Text>
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.pages} maximumZoomScale={3} minimumZoomScale={1}
        scrollEventThrottle={200} onScroll={event => {
          const { contentOffset, layoutMeasurement } = event.nativeEvent;
          const needed = Math.ceil((contentOffset.y + 2 * layoutMeasurement.height) / (height + GAP));
          if (needed > shown) setShown(Math.min(needed, sheet.pages.length));
        }}>
        {sheet.pages.map((_, index) => <View key={index} style={[styles.page, { width, height }]}
          accessible accessibilityRole="image" accessibilityLabel={t('tasks.previewPage', { page: index + 1, pages: sheet.pages.length })}>
          {index < pages.length && <SvgXml xml={pages[index]} width={width} height={height} />}
        </View>)}
      </ScrollView>
      <ButtonRow style={styles.footer}>
        <Button kind="plain" label={t('tasks.previewClose')} onPress={onClose} />
        <Button label={saving ? t('tasks.pdfMaking') : t('tasks.pdf')} disabled={saving} onPress={onSave} />
      </ButtonRow>
    </View>
  </Modal>;
}

const makeStyles = (t: Theme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: t.dialog, paddingTop: 56 },
  header: { paddingHorizontal: 18, paddingBottom: 12, gap: 4, borderBottomWidth: 1, borderBottomColor: t.line },
  title: { fontSize: 20, fontWeight: '700', color: t.ink },
  hint: { color: t.muted, fontSize: 13 },
  scroll: { flex: 1, backgroundColor: '#8a8a8a' },
  pages: { padding: GAP, gap: GAP },
  page: { backgroundColor: '#ffffff', shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  footer: { padding: 18, paddingBottom: 34, borderTopWidth: 1, borderTopColor: t.line },
});
