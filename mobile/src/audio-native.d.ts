import type { IAudioEventEmitter } from 'react-native-audio-api/lib/typescript/jsi-interfaces';

declare global {
  var AudioEventEmitter: IAudioEventEmitter;
}
