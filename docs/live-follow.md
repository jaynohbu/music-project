# Live follow: playing along with the stems

Status: written 2026-11-04 for the iPhone app; instruments added 2026-11-05. Typecheck, lint and all 55 tests pass. On the simulator a take was recorded, saved, reloaded after relaunch and played back with the stems. Not yet tested with a real instrument on a phone; the simulator microphone only hears silence, so the band never changed speed there. Needs a new native build because the microphone permission text is added to Info.plist.

## What it does

A player picks an instrument (guitar, bass, keyboard, piano, drums, vocals or other), plugs it into the iPhone and plays along with a song. The six backing stems follow the player's tempo in real time: when the player speeds up or slows down, the band does too, without changing pitch.

When recording stops, the performance is kept as the song's **take**:

- The audio is saved as recorded, untouched.
- The tempo the band followed is saved next to it as a tempo log.
- On playback the take plays, and the stems replay the same tempo changes, so the two stay together.
- The band's matching stem (for example the bass stem when playing bass) is silenced while the player is heard, with a switch to keep it.
- Each song has one take. Recording again asks before replacing it. Deleting the take, or deleting the song, removes the audio and its tempo log; the stems then play at normal speed again.

The stems are never re-rendered. Speed changes are applied live by the audio engine, both while recording and on playback.

## Decisions

| Question | Choice | Why |
|---|---|---|
| Who follows whom | The band follows the player | Humans drift; the backing should breathe with them |
| What is saved | Raw take + tempo log | No processing delay, no quality loss, easy to delete or redo |
| Takes per song | One | Simple to understand and manage |
| Platform | iPhone first | Where the user tests; Android untested |
| Speed range | 0.7× to 1.3× | Beyond this, time-stretching sounds artificial |
| Pitch | Kept | Uses the audio library's pitch-preserving stretch |
| Instruments | Chosen before recording, one take per song | Each needs different note detection and stands in for a different stem |
| Band's matching stem | Silenced automatically, switch to keep it | The player replaces that part; nothing in the saved mix or scenes changes |

## How following works

1. **Beat map.** Following needs the song's beats, which come from the chord analysis (`HarmonyGrid.beats`, seconds in the song). If a song has none, the panel offers **Find beats**.
2. **Note detection.** `OnsetDetector` listens to the microphone in 512-frame blocks and reports the moment of each new note. It uses *spectral flux*: every 256 samples it takes a 1024-sample spectrum (2048 for bass), log-compresses it, and adds up how much each frequency grew compared with the frame before (allowing one bin of drift, so vibrato and bends are not new notes). A note is a peak in that sum well above its recent average, at least a set gap after the last one. This catches plucks and hits (sudden energy) and also legato keys or sung notes (a change of pitch with no rise in loudness). A loudness-only detector was tried first and failed on bass: the slow waveform ripples looked like notes, and re-plucks rose only 3–7 dB.
3. **Where the note belongs.** Each note is mapped to the band's song position at that moment, minus the input latency (default 30 ms).
4. **Matching to a beat.** `Follower` keeps a weighted line through the player's recent notes (the last 6 beats, recent ones count more) to predict where the next beat should fall. A note close to a whole beat (within 0.3 beat) or half beat (within 0.15) counts. After three misses it falls back to the band's position with a wider window. Stray or extra notes are ignored.
5. **Setting the speed.** From matched notes it estimates the player's tempo and how far ahead or behind the band is, then sets a rate that catches up over 1–4 beats. The rate never moves more than 15% from the player's tempo and stays within 0.7–1.3×.
6. **Strength.** Loose (0.2), Normal (0.5) and Tight (0.85) control how quickly the band reacts and how hard it corrects.
7. **Logging.** Every rate change is logged as `{at, pos, rate}`: time in the take, position in the song, new speed.

If the player stops or loses the beat, the band holds its current speed until notes line up again.

## Playback

When a song with a take plays, the mixer:

- Opens the take as a seventh track with its own volume and mute.
- Converts the song position to a take position using the tempo log, plus the saved latency, and seeks there.
- Every 25 ms sets the stems' rate from the log, and nudges it slightly if the stems and take have drifted apart.

Seeking, looping and section start/end all work with the take, because positions are converted through the log in both directions.

## Files

| File | Role |
|---|---|
| `mobile/src/live-follow.ts` | Pure algorithm: tempo log maths, note detector, follower. No React or audio imports, so it is fully unit-tested |
| `mobile/src/live-session.ts` | One recording: microphone permission, audio session, recorder, optional monitoring, feeding notes to the follower, applying rates, saving or discarding |
| `mobile/src/live-take.ts` | Take storage in `Documents/takes/<jobId>/` (`take.json` + `.m4a`) |
| `mobile/src/live-panel.tsx` | The "Live …" card at the top of the Music mixer: instrument picker, band-stem switch, recording, take controls |
| `mobile/src/player.ts` | Mixer gains a playback rate (pitch kept), a rate-aware position, the take track, and a replaced stem that is silenced without changing its channel settings |
| `mobile/src/mixer-view.tsx` | Shows the panel; locks transport and seek while recording; marks the replaced stem "Your part" |
| `mobile/src/mixer-console.tsx` | Adds the record icon; the master fader takes a label so it can be reused for the take |
| `mobile/src/app/index.tsx` | Deleting a song deletes its take |
| `mobile/app.json` | Microphone permission text (`iosMicrophonePermission`), the only native-side change |
| `mobile/test/live-follow.test.cjs` | 13 tests: log round trip, note detection (guitar, bass, legato keyboard, held vibrato note, noise only), instrument stems, gradual and sudden tempo changes, jitter, extra notes, loose players, no beat map |
| `mobile/test/native-mixer.test.cjs` | Adds rate/position, take seek/follow/remove, and replaced-stem tests |

No code in `mobile/ios` or `mobile/android` changed. The recorder is the existing `react-native-audio-api` module.

### Saved take (`take.json`)

```json
{
  "version": 1,
  "file": "take_20261105_001800.m4a",
  "recordedAt": 1793837890462,
  "duration": 9.58,
  "latency": 0.03,
  "points": [{ "at": 0.71, "pos": 0, "rate": 1 }],
  "volume": 0.9,
  "muted": false,
  "instrument": "bass",
  "replace": true
}
```

Takes saved before instruments existed load as guitar with `replace` on.

Takes stay on the phone only. They are not uploaded or shared with the website.

## Instruments

| Instrument | Band stem silenced | Detection settings |
|---|---|---|
| Guitar | guitar | default: 1024-sample frames, from 70 Hz, 80 ms gap |
| Bass | bass | 2048-sample frames (low notes need longer frames), from 30 Hz, 100 ms gap |
| Keyboard | piano | from 40 Hz |
| Piano | piano | from 40 Hz |
| Drums | drums | from 40 Hz, 60 ms gap for fast fills |
| Vocals | vocals | from 80 Hz, slightly more sensitive, 150 ms gap |
| Other | none | from 40 Hz |

The panel title follows the choice ("Live bass", "Live vocals", "Live instrument" for Other), as does the setup hint. Changing the instrument when a take exists relabels that take.

**Band stem off.** While recording, or while an unmuted take is playing, the matching stem is silenced. Turning the switch off, muting the take or deleting it brings the stem back. The stem's own volume, mute, solo and scene settings are not changed; the console shows **Your part** on it instead.

## The Live panel

- **Instrument**: Guitar, Bass, Keyboard, Piano, Drums, Vocals or Other.
- **Band … off**: silences the band's matching stem (hidden for Other).
- **Record / Stop**: plays the song from where the playhead is and records. Stopping saves the take.
- **Follow**: Loose, Normal or Tight.
- **Hear input**: plays the instrument through the phone while recording.
- While recording: elapsed time, band speed, current beat, input level. Play, stop and seek are locked so the song cannot be stopped by accident.
- With a take: tempo graph (dashed line is normal speed, with the playhead), take volume and mute, **Sync Earlier / Later** in 10 ms steps if the take sounds early or late, and delete.
- Leaving the screen while recording saves what was played.

## Limits

- **Signal.** Best with an audio interface and wired headphones. Bluetooth adds delay. The phone microphone also hears the band, which confuses note detection. Acoustic piano, drums and vocals often use a microphone, so headphones matter even more there.
- **Detection was tuned on synthetic sounds** (plucked, legato, vibrato, drum-like noise hits, background noise). Real instruments may need different thresholds.
- **Reaction time.** The band catches up within one or two beats; it cannot predict a sudden change.
- **Playing style.** Steady rhythm works best. Very free or rubato playing, or long held notes, give few notes to follow; the band then holds its speed.
- **Latency.** The 30 ms default is an estimate. Use Sync to correct each take.
- **First speed change.** The stretcher switches mode when the rate first leaves 1.0×, which can cause a tiny one-time glitch.

## Testing

- `npm test` in `mobile/` runs the follow algorithm against simulated players (steady, ramping 100→115→90%, a sudden 25% jump, jitter, extra notes, five random loose players) and the mixer's rate and take handling.
- Simulator: recording, saving, reloading after relaunch and playback with the take were checked by hand.
- Simulator: choosing Vocals and recording showed "Live vocals" and silenced the Vocals stem ("Your part", LED off) in the heavy metal theme; the instrument picker and switch were checked in the simple theme.
- Still to do on a real iPhone: follow real instruments (guitar and bass through an interface, a keyboard line out, voice on a mic), check the band audibly follows, check Sync, and try each Follow strength.
