import { Stack, useLocalSearchParams } from 'expo-router';
import { StemScrollView } from '../../stem-scroll';
import { MixerView } from '../../mixer-view';

export default function SongMixer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <StemScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
    <Stack.Screen options={{ title: 'Stem mixer' }} />
    <MixerView key={id} jobId={id} />
  </StemScrollView>;
}
