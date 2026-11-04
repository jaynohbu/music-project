import { Stack, useLocalSearchParams } from 'expo-router';
import { ScrollView } from 'react-native';
import { MixerView } from '../../mixer-view';

export default function SongMixer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
    <Stack.Screen options={{ title: 'Stem mixer' }} />
    <MixerView key={id} jobId={id} />
  </ScrollView>;
}
