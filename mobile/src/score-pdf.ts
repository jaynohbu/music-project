import { printToFileAsync } from 'expo-print';
import { shareAsync } from 'expo-sharing';
import { File, Paths } from 'expo-file-system';

// A4 in points, the page size of the sheet's HTML.
const A4 = { width: 595, height: 842 };

// Prints the sheet to a PDF named after the song and part, then opens the share sheet to save or send it.
export async function shareScorePdf(html: string, fileName: string): Promise<void> {
  const { uri } = await printToFileAsync({ html, ...A4, margins: { top: 0, right: 0, bottom: 0, left: 0 } });
  const named = new File(Paths.cache, fileName);
  await new File(uri).move(named, { overwrite: true });
  await shareAsync(named.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: fileName });
}
