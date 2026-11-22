import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';
import { EDGE, StemScrollView } from '../../stem-scroll';
import { MixerView } from '../../mixer-view';
import type { Song } from '../../api';
import { useTheme } from '../../theme';

export default function SongMixer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [song, setSong] = useState<Song | null>(null);
  const { ink } = useTheme();
  const name = song ? `${song.title || 'Untitled song'}${song.author ? ` by ${song.author}` : ''}` : '';
  return <StemScrollView contentContainerStyle={{ paddingVertical: 16, paddingHorizontal: EDGE, gap: 16 }}>
    {/* The song's name heads the page; the Music tab above leads back to the list. */}
    {!!name && <Text numberOfLines={2} accessibilityRole="header" style={{ color: ink, fontSize: 20, fontWeight: '700' }}>{name}</Text>}
    <MixerView key={id} jobId={id} onSong={setSong} />
  </StemScrollView>;
}
