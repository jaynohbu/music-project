import { STEM_NAMES, type SceneSettings } from './api';
import type { Mixer } from './player';

export function snapshot(mixer: Mixer): SceneSettings {
  return {
    masterVolume: mixer.volume * 100, sectionStart: mixer.sectionStart, sectionEnd: mixer.sectionEnd, loop: mixer.loop,
    tracks: Object.fromEntries(STEM_NAMES.map(name => [name, { ...mixer.channel(name), volume: mixer.channel(name).volume * 100 }])),
  };
}
export function restore(mixer: Mixer, settings: SceneSettings) {
  mixer.setVolume(settings.masterVolume / 100);
  mixer.setSection(settings.sectionStart, settings.sectionEnd);
  mixer.setLoop(settings.loop);
  for (const name of STEM_NAMES) if (settings.tracks[name]) {
    mixer.setChannel(name, { ...settings.tracks[name], volume: settings.tracks[name].volume / 100 });
  }
}
