import { STEM_NAMES, type SceneSettings } from './api';
import type { Mixer } from './player';

export function snapshot(mixer: Mixer): SceneSettings {
  const { useCleaned: _cleaned, ...live } = mixer.liveChannel;
  return {
    masterVolume: mixer.volume * 100, sectionStart: mixer.sectionStart, sectionEnd: mixer.sectionEnd, loop: mixer.loop,
    tracks: Object.fromEntries(STEM_NAMES.map(name => [name, { ...mixer.channel(name), volume: mixer.channel(name).volume * 100 }])),
    live: { ...live, volume: live.volume * 100, replace: mixer.replacePart },
  };
}
export function restore(mixer: Mixer, settings: SceneSettings) {
  mixer.setVolume(settings.masterVolume / 100);
  mixer.setSection(settings.sectionStart, settings.sectionEnd);
  mixer.setLoop(settings.loop);
  for (const name of STEM_NAMES) if (settings.tracks[name]) {
    mixer.setChannel(name, { ...settings.tracks[name], volume: settings.tracks[name].volume / 100 });
  }
  if (settings.live) {
    const { replace, ...live } = settings.live;
    mixer.setLiveChannel({ ...live, volume: live.volume / 100 });
    mixer.setReplacePart(replace);
  }
}
