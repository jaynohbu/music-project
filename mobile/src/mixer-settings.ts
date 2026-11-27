import { STEM_NAMES, type SceneSettings } from './api';
import type { Mixer } from './player';
import { SCORE_FAMILIES } from './score-parts';

export function snapshot(mixer: Mixer): SceneSettings {
  const { useCleaned: _cleaned, ...live } = mixer.liveChannel;
  return {
    masterVolume: mixer.volume * 100, sectionStart: mixer.sectionStart, sectionEnd: mixer.sectionEnd, loop: mixer.loop,
    tracks: Object.fromEntries(STEM_NAMES.map(name => [name, { ...mixer.channel(name), volume: mixer.channel(name).volume * 100 }])),
    live: { ...live, volume: live.volume * 100, replace: mixer.replacePart },
    transpose: mixer.transpose,
    // The parts played from the score, as the website keeps them: a "-notes" part per instrument, style 'score'.
    accompaniment: SCORE_FAMILIES.flatMap(family => {
      const sound = mixer.scoreSound(family), channel = mixer.scoreChannel(family);
      return sound === undefined ? [] : [{ kind: `${family}-notes`, style: 'score', sound, volume: Math.round(channel.volume * 100), muted: channel.muted }];
    }),
  };
}
export function restore(mixer: Mixer, settings: SceneSettings) {
  mixer.setVolume(settings.masterVolume / 100);
  mixer.setSection(settings.sectionStart, settings.sectionEnd);
  mixer.setLoop(settings.loop);
  for (const name of STEM_NAMES) if (settings.tracks[name]) {
    mixer.setChannel(name, { ...settings.tracks[name], volume: settings.tracks[name].volume / 100 });
  }
  mixer.setTranspose(settings.transpose ?? 0);
  // A scene's score parts (older ones of another kind take their instrument's channel).
  for (const part of settings.accompaniment ?? []) {
    const family = SCORE_FAMILIES.find(found => part.kind.startsWith(found)) ?? 'keys';
    if (mixer.scoreSound(family) !== undefined) continue;
    mixer.setScoreSound(family, part.sound);
    mixer.setScoreChannel(family, { volume: part.volume / 100, muted: part.muted });
  }
  if (settings.live) {
    const { replace, ...live } = settings.live;
    mixer.setLiveChannel({ ...live, volume: live.volume / 100 });
    mixer.setReplacePart(replace);
  }
}
