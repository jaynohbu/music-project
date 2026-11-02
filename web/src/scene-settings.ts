import type { SceneSettings, SceneTrackSettings } from './services';

export function captureSceneSettings(
  masterVolume: number, sectionStart: number, sectionEnd: number, loop: boolean,
  tracks: (SceneTrackSettings & { name: string })[], sourceDuration = sectionEnd,
): SceneSettings {
  const end = Math.min(sectionEnd, sourceDuration);
  return {
    masterVolume, sectionStart: Math.min(sectionStart, Math.max(0, end - Math.min(0.05, end))),
    sectionEnd: end, loop,
    tracks: Object.fromEntries(tracks.map(track => [track.name, {
      volume: track.volume, preGain: track.preGain, compression: track.compression, distortion: track.distortion,
      bass: track.bass, mid: track.mid, treble: track.treble, pan: track.pan, reverb: track.reverb,
      muted: track.muted, solo: track.solo, bypassed: track.bypassed, useCleaned: track.useCleaned,
    }])),
  };
}

export function restoredSceneInterval(settings: SceneSettings, duration: number): { start: number; end: number } {
  const end = Math.min(duration, settings.sectionEnd);
  return { start: Math.max(0, Math.min(settings.sectionStart, end - Math.min(0.05, duration))), end };
}
