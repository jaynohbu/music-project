import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';
import { StemScrollView } from '../../stem-scroll';
import { MixerView } from '../../mixer-view';
import type { Song } from '../../api';
import { useTheme } from '../../theme';

export default function SongMixer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [song, setSong] = useState<Song | null>(null);
  const { ink } = useTheme();
  const name = song ? `${song.title || 'Untitled song'}${song.author ? ` by ${song.author}` : ''}` : '';
  return <StemScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
    <Stack.Screen options={{ headerTitle: () => <Text numberOfLines={1} accessibilityRole="header"
      style={{ color: ink, fontSize: 17, fontWeight: '600', maxWidth: 280 }}>{name}</Text> }} />
    <MixerView key={id} jobId={id} onSong={setSong} />
  </StemScrollView>;
}
