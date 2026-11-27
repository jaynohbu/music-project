# Sorituh mobile app design

Status: the app is in daily iPhone testing through EAS internal builds; the server and website are deployed. Since 2026-11-20 the work added a shared ensemble score with automatic analysis, key change, a live-input mixer channel, themes with backgrounds, scene-level mix saving, and the same features on the website where they apply. Last updated 2026-11-21 (commit `24135be`).

This is the source of truth for the native app work. Read it before changing `mobile/`, the stem pipeline, or account limits. A Korean summary for people is in `sorituh-mobile-app-design.docx`; if the two differ, this file wins.

## Goal

Replace the WebView wrapper with a native Expo app that plays stems from its own audio engine. Users sign in with an email only and never see a password. The AWS backend stays. The website stays and, since 2026-11-20, gets the app's features where they apply (see Website).

## Current state

| Area | State | Where |
|---|---|---|
| App | Installed from EAS `staging` builds on the user's iPhone; signed-in use daily. Latest build `1109096e` (commit `24135be`) | `mobile/src/` |
| Sign-in | Email + device ID, as designed. Codes now go through SES, which is in sandbox (see Constraints) | `mobile/src/auth.ts`, `backend/accounts.mjs` |
| Audio engine | Four stems streamed from disk, full effects, key change through a library patch | `mobile/src/player.ts`, `mobile/patches/` |
| Score analysis | Version 10: Harmonic score (key from the notes, extended chords spelled in the key, every chord tone played, no chord where it is silent), bass and drum parts, hi-hat filling. Found automatically when a song is first opened | `backend/analyze_harmony.py`, `backend/note_lines.py` |
| Live input | A mixer channel like a stem; instrument detected automatically; take saved per song | `mobile/src/live-*.ts`, `mobile/src/instrument-detect.ts`, [live-follow.md](./live-follow.md) |
| Scenes | Mix, live mix and key change saved per scene entry; nothing saved from Music | `backend/scene-api.mjs`, `mobile/src/mixer-settings.ts` |
| Themes | Heavy metal (default), Rock, Pop, Jazz club, Worship, Simple, with backgrounds, in app and website | `mobile/src/theme.tsx`, `web/src/themes.ts` |
| Website | Deployed 2026-11-21 with the ensemble score, themes, usage, store links | `web/src/` |
| Worker image | `cpu-20261121080006` | `backend/Dockerfile.stems` |
| Not built | Score editor, website languages and live input, account deletion, billing, store submission | see Build order |

Commit and push when the user asks; deploys (API, worker image, website) and EAS builds also need the user's go-ahead.

## Architecture

```
App (Expo)
 ├ Sign-in: email + device ID
 ├ Screens: music list (edit title/artist), scenes, upload, mixer, settings
 ├ Audio engine: real-time mix of 6 AAC files read from disk, plus the live input channel
 ├ Key change: WSOLA pitch shift on every stem (patched library)
 └ Local cache: most recent 20 songs or 2 GB, whichever comes first
Server (existing AWS stack)
 ├ API: accounts, song list, scenes, usage limits, lyrics and score analysis
 ├ Split worker: on-demand Fargate task (htdemucs, four stems; htdemucs_6s before 2026-11-21), also produces AAC
 ├ Analysis worker: same image; lyrics, ensemble score, bass and drum parts
 └ S3: WAV (original, downloads) + AAC (playback, cache) + analysis JSON
```

## Decisions

### Accounts

`POST /api/accounts/device` takes `email`, `deviceId`, `password` and optional `code`, and needs an `X-Account-Session` header from `POST /api/accounts/session`.

| Situation | Result | Email code |
|---|---|---|
| New email | Creates an enabled account, device saved as unproven | No |
| Known device (reinstall, or sign-in after logout) | Sets the new password | No |
| Existing account, new device | Sends a code, returns `code-required`, password unchanged | Yes |
| Existing account, new device, correct code | Sets the password, device saved as proven | Yes |

- **Keep the code for new devices.** The server cannot otherwise tell a new phone from someone typing another person's email. The user accepted this.
- Any code confirmation, including the website's Reset password, removes unproven devices, so whoever claimed an address first loses access once its owner proves it.
- `AccountDevices` stores only SHA-256 hashes of the email and device ID.
- The device ID must survive reinstalls: `Application.getAndroidId()` on Android; a generated UUID in the Keychain on iOS, because `identifierForVendor` can change. The Android ID changes with the signing key.
- An account has one password, so each device that gets a new password invalidates the others. Known devices recover silently on launch. App users who go to the website must use Reset password.

### Compression

- **Format:** AAC 256 kbps in `.m4a`, chosen over MP3 for better quality at the same size when a stem is soloed. Encode with `-movflags +faststart` so files can play while downloading.
- **Where:** inside the existing split task in `stem-worker.mjs`, after the WAV upload and before the `completed` record. There is no queue, no S3 trigger and no extra state machine step, because the task is already running with the WAVs on disk.
- **Keep the WAVs.** `stems[name].key` stays the WAV, since restoration reads it (`stem-restore.mjs:105`). Add a separate field such as `playKey`.
- **API:** `playUrl` returns AAC and falls back to WAV when `playKey` is missing; `downloadUrl` stays WAV (`signedStemJob` in `stem-api.mjs`). Return a version value so clients can spot replaced files.
- **Compression failure does not fail the song.** Log it and play the WAV.
- **Do not compress on the phone or re-encode AAC.** The app saves the bytes it downloaded. Phone compression would mean downloading 254 MB instead of 46 MB on every first load.
- **Restored stems** get the same step in `stem-restore.mjs`.
- **Existing songs** get a one-off conversion script; until then they play WAV. `backend/convert-playback.mjs` lists what it would convert, and converts with `--apply` (needs `TABLE_NAME`, `BUCKET_NAME`, `AWS_REGION=us-west-2` and ffmpeg). Run it after the deploy, with the user's approval.
- **As built (2026-11-03):** each stem record gets `playKey` and `playBytes` next to `key`, and the song gets `playVersion: 'aac-256k'`; cleaned stems get the same three fields. The `.m4a` sits beside its WAV (`vocals.wav` → `vocals.m4a`), so song deletion removes it with the folder; deleting one cleaned stem removes both files. A song gets AAC for all six stems or none, so it never mixes formats. The API returns `playVersion` (`'wav'` when there is no copy) on songs and cleaned stems. `stem-playback.mjs` keeps the `stem-` prefix because `Dockerfile.stems` copies only `stem-*.mjs`.
- **Timing:** ffmpeg writes an edit list for the AAC start delay. Decoding with ffmpeg, a click lands on the same sample as in the WAV, so the app (whose engine decodes with FFmpeg) stays aligned with lyrics, chords and WAV cleaned stems. Browser decoders were not checked; check the website's mixer against lyrics after the deploy.
- **Deletion must remove AAC files.** `restoration-api.mjs:142` deletes by exact key and needs changing. Check `createSongDeletion` in `scene-api.mjs` too.

| 4 stems | WAV | AAC 256 kbps |
|---|---|---|
| 4 minutes | 254 MB | 46 MB |
| 15 minutes (maximum) | 953 MB | 173 MB |
| Sustained speed to stream | 8.5 Mbps | 1.5 Mbps |

AAC adds about 20–50 ms of start delay. Stems shift together, but timing against lyrics, chords and original/restored switching must be tested. Sizes are calculated; encode time has not been measured.

### Audio engine

- **Read from disk and decode as it plays; do not load whole songs into memory.** The website's approach (`decodeAudioData` in `web/src/stem-pages.ts`) needs about 508 MB for a 4-minute song and 1.9 GB for 15 minutes, and AAC does not reduce that.
- Drive all 6 stems from one audio callback and clock, keeping sample-accurate sync through seeks.
- **Updated scope, explicitly approved during the native parity repair:** include all nine web controls: volume, pre-gain, compression, distortion, bass, mid, treble, pan and reverb, plus bypass. This supersedes the earlier EQ-only decision. `src/effects.ts` uses the website's defaults/ranges, fixed soft-clip curve and seeded impulse. Compression is a stereo-linked worklet with the same threshold/ratio mapping and 3 ms attack/250 ms release, but without the browser node's lookahead or knee; it is not claimed to sound identical.
- **Idle effects are unlinked (static fix):** with every stem running its compressor worklet and convolver on each 128-frame block, the audio thread overran on iPhone. A late worklet block is zeroed natively, which sounds like static. `route()` in `src/effects.ts` now links a stem's compressor only while its compression is above 0 and the stem isn't bypassed. It links the convolver only while reverb is above 0, unlinking it 250 ms after the send closes so the tail fades. At default settings neither runs.
- **Waveforms:** the mixer streams stems, so `src/waveform.ts` decodes each stem once more at 2 kHz, one at a time after the mixer is ready, and caches 100 normalized peaks as `<stem file>.peaks.json` in the song's cache folder. This matches the website's `waveformPeaks`. The cleaned version gets its own peaks. On the simulator six 4-minute test stems decoded in about 2.3 s.
- Full effects are not yet measured on a physical phone. The current independent per-stem convolvers preserve each stem's pan/mute/solo/bypass behavior, but the trial below showed a substantial CPU cost for six reverbs. Benchmark full effects before shipping; a shared reverb would require an intentional routing/tail-behavior change.
- Background playback: iOS background audio, Android foreground media service, lock-screen controls.
- `react-native-audio-api` 0.13.6 carries the mixer on the iPhone (Step 1). Android phones are still untested.
- **Library patch (2026-11-21):** `mobile/patches/react-native-audio-api+0.13.6.patch`, applied by `patch-package` on `postinstall`, adds a `pitchShift` property (semitones) to file sources. The library already had a WSOLA stretcher with a pitch factor for buffer sources; the patch passes it on file sources too and uses the stretcher whenever the pitch is shifted. Regenerate the patch with `npx patch-package react-native-audio-api --exclude '^package\.json$|^android/|/external/|\.DS_Store$'`, or it picks up build output.
- Mixer layout on the phone: a finger scrolls the page from anywhere that is not a control, and the page holds still while a control is held (no scroll rails since 2026-11-27). Space under the last stem lets it reach the focus line. Faders are 90 pt, the master bar is slim, each console is named after its stem ("Guitar mixer").

### Local cache

- App file storage (`expo-file-system`); S3 stays the source of truth, so anything can be deleted and fetched again.
- Limit: 20 songs or 2 GB, whichever comes first. 20 songs alone could reach 3.5 GB.
- Evict by last played time, one whole song at a time. Delete, do not recompress.
- Never evict the song that is playing or open in the mixer.
- Download to a temporary path and add to the cache only when complete.
- Prefer downloading before evicting; evict first only when disk space requires it.
- Re-download when the server version changes. Remove on song deletion. Clear on logout.
- Signed URLs last 1 hour, so request fresh ones before each download.
- Offline use is out of scope: sign-in and the song list need the network.

### Usage limits

Enforce on the server only.

| | Free | Premium |
|---|---|---|
| Splits per month | 30 | 100 |
| Stored songs | 100 | 500 |

- **Splits:** check when the upload is created, so nobody uploads for nothing, then take the count atomically when the split starts (`/complete`). Refund if the split fails. Deleting a song does not refund. Months are UTC calendar months.
- **Stored songs:** count of current songs, so deleting frees a slot. Initialise from existing data.
- **One new account per device,** because otherwise each new email resets the free limits. Add a lookup by `deviceHash`.
- **Restoration and analysis** use the same paid Fargate task. Default: one restoration per stem and one run of each analysis per split song.
- **Plan:** a `plan` value in the database, changed by hand at first. In-app subscriptions must use Apple and Google billing, added later.

**As built (2026-11-03; the user confirmed the assumptions above):**

- Records in the jobs table, beside the user's songs: `{ userId, jobId: 'plan', plan: 'premium' }` (no record means free) and `{ userId, jobId: 'usage:YYYY-MM', splits }`. They have no `type` or `createdAt`, so song lists and child queries never show them. To make someone premium, put the plan record by hand.
- `GET /api/stems/usage` returns `{ plan, month, splits: { used, limit }, songs: { used, limit } }` for the app to show.
- `POST /api/stems/uploads` refuses with 403 and `code: 'SONG_LIMIT'` or `'SPLIT_LIMIT'`. Stored songs are counted from the song records (failed and expired ones excluded), so nothing needs initialising.
- `POST /complete` takes the split with a conditional `ADD`, so two requests cannot both take the last one, and stores `usageMonth` on the song. The worker's failure path and the state machine's finalize step refund it once. A start that never reaches the worker (the song stays `queued` until it expires) is not refunded.
- **Cleanups:** one per stem; a failed one can be retried. Deleting a cleaned stem frees that stem again, the same way deleting a song frees a song slot.
- **Lyrics and chords:** one run per song, as before; a failed run can be retried. Regenerating one stem's chords: once per stem and source (original or cleaned stem).
- **One new account per device:** `AccountDevices` has a `ByDevice` index. A device request that would create a new account for a device already linked to another email deletes the account it just made and returns 409 `DEVICE_HAS_ACCOUNT`. The user pool hides whether an email exists, so the check runs after the create. Signing in to other existing accounts from that device still works.

### Harmonic notes, key and ends (2026-11-22, harmony version 10)

The user found the Harmonic score's melody and key not caught well, and the accompaniment playing on after the song ended. The score is no longer meant as a melody: it holds every note the guitars and keys play that belongs to the chord of the moment.

- **Causes found** (Our God, Enter Sandman): about half of the old melody notes (46%, 53%) had a note an octave, a twelfth or two octaves below sounding as they started: overtones, mostly from distorted guitar, picked by the highest-note rule, so the line jumped an octave or more 10–18% of the time. The top line matched the singing only 17–21% of the time (the tune is in the vocals). The key came from the spectrum, where a power chord's overtones sound a major third that is not played: Enter Sandman read E major (0.85 against Em 0.74). Chords were always spelled with the fixed mixed names, so B major showed Abm.
- **Notes:** Basic Pitch notes of strength 0.35 or more, less overtones (a note 12, 19 or 24 semitones above one at least as strong, sounding as it starts), from E2 up, at least 60 ms, whose pitch class is in the chord playing as they start (slash bass included); none under no chord. Notes starting on the same sixteenth are one chord on the staff (up to six, the strongest), sharing a written length that runs to the next chord when the gap is an eighth or less. `second` is empty. Repeats count a chord's notes as one onset. The scores draw a chord with one stem, from the head farthest from its end past the nearest, beamed as one note (`beamNotes`, same in app and website).
- **Key:** from the notes heard (duration × strength per pitch class) with the Krumhansl-Schmuckler profiles; where the third on the same root clearly says the other mode (twice as much), it wins. The spectrum's key remains the fallback. Enter Sandman: G 8.3% against G# 1.1% gives Em. The bass's chords now use this key, and every chord is spelled in the key (sharps in G, D, A, E, B, F#, Em, Bm, F#m, C#m, G#m; flats in F, Bb, Eb, Ab, Db, Dm, Gm, Cm, Fm, Bbm, Ebm; C and Am keep the mixed names).
- **Ends:** a silence of the harmonic stems of 2 s or more, and the end of the last chord, are written as no chord (`N.C.`). Comping strikes nothing there, so the rhythm parts stop with the song; before, the last chord had no end and was struck to the end of the file.
- **Comping in the stem's register** (website, no re-analysis): the user found the rhythm parts flat, with no high or low chords. Each chord now reads where the Harmonic stem played it (10th to 90th percentile of the score's notes while it lasts) and is voiced there: the bass near the stem's low note (keys an octave under), every chord tone in the octave under its high note, the gap filled (guitar root or fifth, keys the bass's octave), inside guitar E2–C6 and keys E1–C7; with fewer than two notes the old open-position voicing stays. Enter Sandman's riff now sits at E2–G3; Our God's top notes range F#3–F#5.
- **Held notes, version 12:** the user found back-to-back repeats of one note busy (every split attack struck again). The same pitch starting again within 0.12 s of a note's end is now that note held: joined before the score is written (stronger strength kept) and again in the website's melody line (for scores not yet redone). 35–45% of the melody notes were such repeats, mostly with no gap at all; Our God 1074 → 597 written chords, Enter Sandman 885 → 452.
- **Melody + rhythm parts** (renamed from melody + chords; the user meant melody with the rhythm, the rhythm taken from the rhythm part): exactly the rhythm part's comping, with the melody (the top note of each chord the Harmonic score writes) on it at velocity 108. A melody note within 0.07 s of a stroke sounds with it, and replaces a stroke note of the same pitch rather than doubling it. A first version played the comping at 70% and a fourth lower; the user found a rhythm part plus a melody part much better than one melody part, and one part should be as good, so it now is the rhythm part as it is.
- **Upper and lower notes together, version 13:** notes starting within 0.07 s of the one before (up to 0.14 s from the first), as a strum spreads them, are one chord: written on the first one's sixteenth, and in the website's melody line only their top note plays (before, a low note a sixteenth early played as a melody note of its own, then the top note). Our God 609 written chords, Enter Sandman 426.
- **Repetition-aware polyphonic transcription, version 15** (docs/repetition_aware_polyphonic_transcription_proposal.docx; version 14's melody-only score is undone). Events again: each sixteenth's pitch set (up to six notes), with a confidence per note (0.6 × strength + 0.4 × attack). Attack is the model's onset signal for that pitch or the stem's spectral flux against its own loud level, whichever is larger: the same pitch again right after a note is a new strike only with an attack of 0.5 or more, otherwise it is held; a faint note (under 0.5) barely struck (under 0.1) is ringing or bleed. Notes outside the chord are kept when heard at 0.6 or more. Chord recognition hears every note detected as well as the top line. Repeats are no longer copied from their clearest playing: within each family a note most of the other playings write is added where it is missing if the model hears that pitch there at 0.25 or more (marked `voted`, drawn lighter); a note no other playing has, not even among the faint candidates (strength 0.2 and up), is dropped below confidence 0.6 when there are three playings or more; chords are voted per beat by majority, each playing keeping its rests. The part carries `repeats` and `corrections` ({added, removed}); the page sums them up and saves the score as MIDI (a tempo per beat, chord markers) or MusicXML (pickup bar, ties over bar lines, chord names, key).
- **Evaluation** (tools/transcription/evaluate.py; synthetic songs from the website's sounds, an eight-bar progression played four times with two bars varied, 15% of notes very soft, stray notes and noise). A = detected notes only, B = + repeat vote, C = + chords. Onset F1 A → B: piano 0.847 → 0.904, clean electric 0.871 → 0.913, overdrive 0.759 → 0.811, electric piano 0.853 → 0.892; pitch-set recall +0.08 to +0.11 with precision unchanged (0.99 to 1.0); two playings only: 0.866 → 0.905 and 0.84 → 0.902. C is within 0.01 of B (the chord filter guards against bleed the synthetic songs barely have). Hearing every note raised chord accuracy (root and major/minor) on guitar from 0.656 to 0.758 and 0.680 to 0.773; piano 0.898. Real songs: Our God 1128 events (1.68 notes each), 325 notes added and 23 dropped by vote; Enter Sandman 1076 events, 299 added, 7 dropped.
- **Harmony v16: notes as played** (docs/repetition_aware_polyphonic_transcription_updated.docx). Every note keeps its own start and end as played (not snapped) and a velocity (1 to 127: the stem's loudness as it starts against its loud level around, with how strongly its pitch starts). Its end is the model's, cut earlier only where its pitch falls under 30% of how it started for 120 ms (a ringing tail); 50% cut piano notes short as they decay (onset+offset F1 0.822 → 0.79). Repeats may be moved to another key (at least two bars and 85% alike when moved back); before the vote, each pair of playings is lined up onset by onset by time warping (at most two sixteenths apart), and chords are voted among playings in one key. The website plays the score as transcribed ("transcribed notes" parts: every note at its own time, length and velocity in a chosen sound, as a SoundFont renders MIDI); MIDI files keep the played timing and velocity; "Events" saves the notes as JSON (barId, pitchMidi, onsetSec, offsetSec, durationSec, onsetBeat, velocity, confidence). Measured again (seed 1; piano, clean electric, overdrive, electric piano), A → B: onset F1 0.847 → 0.908, 0.827 → 0.893, 0.724 → 0.772, 0.82 → 0.88; multi-pitch F1 0.847 → 0.911, 0.827 → 0.895, 0.777 → 0.841, 0.82 → 0.884; repeated strikes kept as notes of their own 0.791 → 0.897, 0.744 → 0.883, 0.656 → 0.769, 0.718 → 0.842; rendered again, the notes sound 0.819 → 0.862 alike to the piano stem (log-mel cosine). Velocity follows the played level only weakly (rank correlation 0.16 to 0.30; per-pitch CQT level was weaker still): within a chord, one soft note is hard to hear. Real songs: Our God 337 notes added and 10 dropped, Enter Sandman 267 and 6; neither has a moved repeat.
- **Score alignment (spectrum page, 2026-11-26).** A passage's score (PDF read into MusicXML by Audiveris in the ScoreReader Lambda: a container image, backend/Dockerfile.scores and read_score.py, built by build-score-image.sh and released with SCORE_IMAGE=... publish-api.sh; the page uploads through backend/score-api.mjs, POST /api/scores, POST /api/scores/{id}/read, GET /api/scores/{id}, files under score-readings/ kept a day; tools/omr runs the same locally. Or MusicXML/.mxl, read in the browser by web/src/musicxml.ts) is aligned with the song in web/src/score-align.ts. Every stem's spectrogram is folded into chroma (pitch classes as loud as the stem plays them, levels 45 dB below its loudest counting as nothing) and onsets; the score is drawn the same way. Subsequence DTW (the whole score, any stretch of the song, tempo free between half and twice the guess, a small cost for each change) runs for the two likeliest key shifts and tempos from the song's beats and the score's marking; each staff then goes to the stem it sounds most like, and a second pass compares each stem with its own parts, a pitched stem no part is for costing where it plays loud (so an instrumental intro is not matched to a sung verse with the same chords). With the song's beats the score is also tried laid rigidly on them, from each beat near the path's start, and taken unless the path fits better by 0.06. "Intro" lets it start only within 8 s of the song's first sound. The other stem is then restored: a score note is kept where the stem has its pitch (or, lacking it, an octave either side) 6 dB above that pitch's usual level, from the stem's own attack near the written start to where it sinks 25 dB below the attack (no later than half a beat past the written end); a note held on from the same pitch needs its own attack; parts given to the vocals or bass are theirs. A part given to the vocals is left to them; one given to the bass is restored where the other stem has it and is not 24 dB under the bass there (spill). **More sounds (2026-11-27).** Fourteen sounds made from free sampled instruments, licences checked in each source's LICENSE (tools/accompaniment/sample_sounds.py; ids from 200): Salamander grand (CC BY 3.0), Steinway B grand, Yamaha upright, French harpsichord and FM piano from VCSL (CC0), CP80, Wurlitzer and Pianet electric pianos by Greg Sullivan (CC BY 3.0), Shiny electric and acoustic, Emily, Green and Black hollow-body guitars by Karoryfer (CC0), Spanish classical guitar by FreePats (CC0). Each note is the nearest sample at a strong layer, retuned by resampling; every sample's pitch is measured so a library numbering its octaves differently is moved (Yamaha upright and the harpsichord +12, the hollow-body guitars −12); rendered notes are 3–10 cents from true (median). CLAP fingerprints (sound_fingerprints.py, run in the stem image) put them in every genre group, so new analyses rank them; songs analysed before list them after their ranked sounds. Credits: web/public/accompaniment/CREDITS.txt, linked from the site's footer. Scenes take sound numbers up to 255. Accurate Salamander, Headroom Piano and Blue Jeans and Moonbeams were left out: no official source was found. **In the app (2026-11-27, first part; needs the next build).** Chords & notes (renamed from Chords & melody in all twelve languages, with its hint, background note and Regenerate label) asks, as the website does, whether there is a score (Upload a score / Find them from the audio); a PDF or image is read by the ScoreReader (api.ts readScore, saved by its reading's id), MusicXML is sent as it is; a song with a score uses it without asking, and one whose result is not from its present score asks the server to lay it on (laySongScore); while a score is read or laid, the Harmonic card shows only "Processing… about N min". The score strip lights every note sounding now by its played start and end (chords and the second line too), as the website's. Save PDF is gone from the cards (the preview keeps its own). The score is played on guitar and keys in the app too (mobile/src/score-parts.ts): the website's sound library (styles.json and the FLAC samples, kept in the phone's cache), each instrument a channel of its own in the native mixer (effects, fader, mute, solo; muted to begin with) with a sound picker (the song's closest first) and a stem's console; notes are scheduled 0.3 s ahead against the song clock (the stems' start time and speed, so live-follow speed changes keep them in step), started early by their sample's attack; velocities follow the Harmonic stem's loudness, which the server now sends with a result made from a score (loudness: RMS every 0.25 s, score_run.mjs), the part's own loudness reckoned from its samples' level curves. Scenes keep the instruments' sound, volume and mute in accompaniment, as the website does. **On the server (2026-11-27, for the app).** A song's score is laid on it by the stem worker, not the browser: saving the score (POST …/score, MusicXML or a ScoreReader reading's id, the reader now also saving plain score.musicxml) starts a harmony record with scoreKey, scoreSavedAt and baseKey (the last analysed result) when the song has its analysis, and asking for chords & notes (POST …/harmony, {useScore} or a regeneration of Harmonic) does on a song with a score; the worker runs score_run.mjs in Node, which decodes the stems with ffmpeg and runs the website's own engine (backend/score-engine/, transpiled from web/src by build-score-engine.mjs, which build-stem-image.sh runs), saves the result (checked by checkScoreHarmony) and the extracted WAV, and records fromScore (without the per-measure bars) and scoring: true. Our God: about four minutes from saving to the result (the run itself 40 s). The web mixer only reads the score, saves it and waits, showing "Processing… about N min". **A song's own score (2026-11-27, later).** An uploaded score is saved with the song (backend/song-score.mjs: POST/DELETE /api/stems/jobs/{id}/score, the MusicXML under users/<user>/scores/<song>/, job.score {title, savedAt, extractedAt}); its chords & notes always come from it: Chords & notes (and Regenerate chords & notes on the Harmonic track) asks whether there is a score — Upload a score, or Find them from the audio — and a song with a score uses it without asking; the mixer lays it on the song by itself whenever the song's result is not from its present score (fromScore.scoreSavedAt), once the stems and beats are loaded (with no beats yet, the analysis runs first). Remove score goes back to the analysis. Everything the analysis found that the score does not have is removed, and everything the score has is kept: the Harmonic notes are every note of the score's non-vocal parts, those heard in the Harmonic and bass stems as played (start, end, velocity), the rest filled in where the score writes them, as loud as the notes heard in their measure (found: false; drawn dashed on the spectrum page, and not extracted, since there is nothing of them in the stems) — Our God: 1826 notes, 1464 heard; the chords are the score's printed chord symbols where it has them, at their printed places and moved to the song's key (read by Audiveris with Tesseract's full English data, which its legacy engine needs; Dockerfile.scores, TESSDATA_PREFIX; musicxml.ts keeps each symbol's root, written kind and slash bass), and in measures without a readable symbol named from the score's notes a measure at a time (score-align.ts scoreChords: the closest of major, minor, 7, maj7, m7, sus2, sus4, dim, built on the lowest note when two fit alike, a slash for another bass, a second chord in a measure's second half where clearly better, N.C. in bars the score lacks); the bass part is the score's lowest note at each moment as the bass stem plays it, in its lowest clear octave; the drum hits stay, on the score's beats. The sound of the score's notes extracted from the Harmonic and bass stems is saved too (a WAV, /score/extracted), shown and heard only on the spectrum page, which opens with the song's saved score result. Timing was checked on Our God: the saved notes start on the stem's attacks (5-second windows within −116 to +93 ms, most within ±23 ms, no drift; 1312 of 1467 heard notes have a stem attack within 140 ms, median −7 ms); the key change shifts timing by a constant 2–15 ms; the voice schedules notes exactly on the song clock. What sounded late was the sound: strings, pads and organ swell in (half their level after 0.07–0.5 s), so a note is now started early by its sample's attack (accompaniment-player.ts sampleAttacks: until a 10 ms running level reaches half its peak, at the speed it is played, at most 0.25 s) and held as much longer, live and in the offline render. The score part's level follows the Harmonic stem through the song (accompaniment-player.ts matchLoudness: the part rendered offline in its sound, both measured every 0.25 s, each note's velocity moved by the smoothed difference, at most 4× either way, against their typical ratio, which sets the part's level so Volume 100% is as loud as the stem); a restored note's velocity is the stem's level at its attack, 127 at the stem's loudest. Our God: 29 printed chord symbols read in 28 measures (Em7, G, Bm7, C, Am7, G/B…; C2, D/F# and some others not read), so G#m7, D#m7, G#m7… where printed and the rest named from the notes, 125 chords; bass 483 notes (G#2, E2… as the analysis heard them) where the analysis had 618 of its own; extracted sound 12.6 MB. **In the mixer (2026-11-27).** The Harmonic track has Upload score (and the PDF pages to read): the score is read, aligned with every stem the mixer has decoded, laid measure by measure on the drum bars and saved as the song's harmony result (web/src/score-import.ts, loaded only on upload; about 40 s for Our God, most of it the five spectrograms), and the Harmonic score shown there is replaced; Use the analysis again goes back. Under its score, the score is played on Guitar and on Keys at once (replacing the website's Accompaniment section, removed): each a channel of its own with its Sound (a dropdown of sound fonts, the closest first) and the same mixer console as a stem (volume, pre-gain, compression, distortion, EQ, pan, reverb, mute, solo, effects bypass, reset; the console is one template for stems and score parts), muted to begin with; the Harmonic track's own mute silences only the recording; All mute and solo take every channel into account; it plays the melody and the chords together: every note of the score as written and played, with the score's melody (the part given to the vocals, kept as ensemble.melody). A scene keeps them as two accompaniment entries (guitar-notes and keys-notes, style 'score', with sound, volume and mute). The Harmonic, bass and drum tracks no longer offer Save PDF, MIDI, MusicXML or Events (Full score stays), the mixer has no Remove score or PDF pages field (every page is read), and while a score is processed the track shows only "Processing… about N min" (22 s a PDF page and 50 s to lay it on the song). **An aligned score is the song's Harmonic score.** After every alignment the page saves a harmony result made from it (score-align.ts harmonyFromScore; POST /api/stems/jobs/{id}/harmony {fromScore}): the ensemble part is only the restored notes, each at its written place on the beats the score was laid on (corrected beats), as played; the analysis's counter-line, repeats and corrections are dropped; its chord names, accompaniment choices, bass notes and drum hits are kept, moved onto those beats. It is a new current harmony record marked fromScore (parts regenerated before it are left out; regenerating Harmonic is refused while it is used); {useAnalysis: true} makes the last analysed result current again. The analysis is used only for songs with no score. Our God: 1936 analysed notes replaced by the 1464 from the score. **Measure by measure (the default, score-align.ts fitMeasures):** the printed score's measures are laid on the drum analysis's beats in one pass of dynamic programming over the beats: each measure over its quarters' worth of drum beats or one more or fewer (0.3 a beat), costing how unlike the song it is there (each stem against its own parts, an eighth at a time; an uncovered pitched stem playing loud costs too); the next measure costs nothing more, any other (a repeat, a jump, the same again) 0.5; a bar the score lacks is a free bar of 3–5 beats (0.1 + 0.75 × how loud). The beats are made again from it (a measure laid over a beat too many loses the one that most breaks the spacing; one too few gets one in the widest gap), the drum hits are moved onto them, and a drum bar is counted corrected where its measure covered more or fewer beats or started off a downbeat. Our God (90 printed measures, whole song): 124 bars laid, 0 drum bars corrected (its drum grid was right); the song's form found by itself: 1–36, 17–32, 63–70, 39–70, 63–70, 71–90, the intro riff 5–7 to end, one bar not in the score; 1464 notes restored (1345 as written). With the grid broken on purpose (a beat lost at 60 s, a false beat at 150 s) the loss and the false beat are found, 40 bars counted corrected (38 between them a beat off the downbeat) and the beats rebuilt to within 1 ms; with the bars a beat out of phase, all 124 corrected. Otherwise the score is aligned as written: repeat barlines and first/second endings (read from every part; an ending read in pieces or without its stop is joined up, and ends at the next forward repeat) are taken (musicxml.ts unrollRepeats; D.S./Coda are not read), and the whole of it is aligned at once by default, on coarser feature steps when the warping table would pass 12 million cells (a measure range can still be chosen). Our God: 90 printed measures played as 113, aligned against the whole song in 1.7 s (node); measures land on the chord analysis's bar lines except where the recording has more than the score (printed 37–43 stretch over about two bars each, and the outro); for a PDF the pages to read can be named (Audiveris takes about 10 s a page; a page it cannot read, such as a cover, makes it export nothing, so the reader reads again without it). Our God with the user's piano/vocal PDF (Musicnotes, E minor), read by Audiveris 5.11 (90 measures, 1585 notes; in the intro only bar 7–8's ledger-line D6 read as B5 and one left-hand note wrong): the song's key found 4 semitones up (G# minor); measures 1–8 and 1–24 (intro and verse 1) all on the chord analysis's bar lines exactly; Voice went to the vocals stem, the piano to the other stem; 117 of 120 intro notes restored. **Separated by the score:** the other stem's own sound where the restored notes and their first 10 overtones are (each a third of a semitone either side, to 50 ms past the note's end; spectrogram.ts maskedSignal) and everything else, played together with a mute for each. Our God bars 1–24: the score notes hold 57% of the other stem's energy; where an unscored note sounds with a scored one, about 12 dB of it stays (window spill), and an overtone they share stays with the scored note. By default the notes are restored and separated from the other and bass stems mixed ("Extract from"; a part given to the bass is then restored like the other stem's), and a fourth view draws the spectrogram cells kept. Our God has no bass until 80 s, so bars 1–32 come out the same either way; with the score's Voice part left to the vocals, the verse still restores 10–18 piano notes a bar.
- **Scores stay while they are redone:** a version change used to hide every song's scores until it was analysed again (the user saw them vanish). Now the last finished result of any version is returned as the result marked `stale` (older apps show it; newer app and website start a new run), and while a run goes it comes as `previous`, shown with "Updating notes…" until the new one replaces it (regenerated parts and added accompaniment parts follow).
- **Harmonic regenerates alone:** `stem: 'other'` runs the ensemble on the song's grid with the bass for slash chords (`--only other`), written as the other part; same once-per-source rule as bass and drums.
- **Version 11, notes that matter and rests:** a written chord is kept only when its strongest note is a real attack, at least 0.85 of the median of the chords within 4 s around it (so quiet verses keep theirs) and 0.38; inside it, notes under 0.7 of its strongest go. Lengths are how long the notes sound, joined to the next chord only across a sixteenth (was an eighth). Our God 1298 → 1074 chords, Enter Sandman 1110 → 885. Rests: frames 20 dB or more under the stems' own 95th-percentile level within 16 s around them are silent, and 0.6 s of silence is no chord (was 2 s at the song-wide 3% floor), so a stop in a loud riff counts and a soft intro does not. Rests from missing notes were tried and dropped: on Enter Sandman they found 21 "rests" where the stem was as loud as around them (notes outside the chord). Measured, neither test song's Harmonic stem rests mid-song (only the end). Repeats no longer copy a rest from one playing to another; each keeps its own, with the copied chord coming back where it ends. Comping stops ringing at a rest.

### Live accompaniment (2026-11-22, website first; harmony version 9)

Added parts are played from the Harmonic score in the browser, not rendered or stored: Electric rhythm, Keyboard rhythm (every chord tone struck on a style's comping rhythm, slash basses included), Electric melody + rhythm and Keyboard melody + rhythm (the rhythm part as it is with the score's notes on it). The strokes are the style's comping rhythm, steady on the beat grid over the chord progression (striking when the stem did sounded and read wrong); the melody is the score's line. Notes struck together share their loudness (1/√(notes/2)) so a full chord does not clip. Each part has Style and Sound dropdowns that change it while it plays, volume and mute; up to four parts; a soloed stem silences them. The key change moves their notes directly (no pitch shift). Scenes save them as `accompaniment` (kind, style, sound, volume, muted), validated by the scene API; the app keeps them when it saves a scene but does not play them yet.

- **Assets** (`tools/accompaniment/build_assets.py`, run by hand, outputs committed): MMA (GPL; only run there) gives 325 comping styles from the genre groups' style files, eight bars each, strokes merged per eighth of a beat (`web/public/accompaniment/styles.json`); FluidSynth with MuseScore General (MIT) gives 20 sounds sampled every three semitones, mono 32 kHz FLAC, 1–3 MB each, loaded when first used; CLAP fingerprints of each sound (`backend/accompaniment_sounds.json`) and sixteen-step comping profiles (`backend/accompaniment_styles.json`).
- **Choices** (`backend/accompaniment.py`, run after the score with the vocals and title): CLAP hears the genre from the whole mix (several sentences per genre; a title with sacred words adds to worship), the group's styles are ranked by how close their comping is to the Harmonic stem's onsets on each sixteenth, and its sounds by CLAP similarity to the Harmonic stem. Stored as `accompaniment` in the result; the dropdowns list them closest first, then the rest of the family. Failure leaves the score without choices (the website then offers the pop group). On Enter Sandman: metal, Rock128Plus, overdrive guitar; on Our God: worship, PopBallad1, clean electric guitar.
- **Playing** (`web/src/accompaniment.ts` pure, `web/src/accompaniment-player.ts`): notes are scheduled a quarter second ahead on the mixer's AudioContext from the same start time and offset as the stems, with loops followed; each note plays the nearest sample at the rate of the missing semitones with a short envelope.
- The worker image now has transformers 4.44 and the CLAP model (`laion/clap-htsat-unfused`, Apache 2.0). Earlier listening pages (gen-test, gen-test2) were prototypes of rendered stems.

### Repeated passages (2026-11-22, harmony version 7)

`backend/repeats.py`, called at the end of the ensemble analysis, finds passages of the Harmonic notes that come back, the way BLAST aligns sequences: bars are the letters, a seed is two bars that sound alike, and it is extended both ways (crossing up to two weaker bars, as BLAST's drop-off) while the whole passage stays at least 70% alike, up to 16 bars. Passages are compared on what sounds in each eighth (pitch classes of the melody and second line, with their lengths), because detection hears a repeat a little differently each time; note-by-note matching found 8-bar repeats at only 45%. A passage must have at least two notes per bar on average, three quarters of its bars played, and starts and ends on played bars. Families (longest first, each bar in one family) take their clearest member (most like the others, then surest notes): its melody and chords are copied over the other members, and the second line (the grey ghost notes) is dropped inside every member. The result lists `repeats` (family, bars, members, source). On Our God: 11-bar verse and chorus pairs and an 8-bar pair; on Enter Sandman: 7- and 5-bar riff pairs.

**Harmonic:** the Other stem is shown as Harmonic (하모닉 in Korean) in the app and website; stored names stay `other`.

### Four stems (2026-11-21)

- Splits use Demucs `htdemucs`: vocals, drums, bass and other. Guitars, keys and every other pitched part are in other. `htdemucs_ft` (cleaner, about 4× the CPU time) and a GPU worker were considered; the user chose plain `htdemucs` on the current Fargate CPU worker.
- The score's ensemble is now other alone (below, read "other" for "guitar, piano and other"); bass and drums are unchanged.
- Existing songs were split again in place (same job IDs, titles and scene entries) by `backend/resplit-songs.mjs`, from the original where one was kept (Stairway in `music-files`, Our God from the old library WAV and from a saved upload) and otherwise from the six stems summed back together. Their cleaned versions and scores were removed (scores come back when the song is opened); lyrics stayed. Scene entries lost their guitar and piano faders. A backup of each song's record and stems is under `backup/resplit-2026-11-21/` in the audio bucket.
- The app cache keys a song by `playVersion@completedAt`, so a song split again is downloaded again. Live input: guitar, keyboard and piano stand in for other.

### Score analysis (2026-11-20, harmony version 5)

The user found the per-stem scores of guitar, piano and other torn apart and hard to follow, so they are analysed as one ensemble. Decided with the user:

- **Ensemble:** guitar, piano and other are mixed and analysed together; bass supplies chord roots only and keeps its own bass line. The result's `ensemble` has the key, one chord progression and two lines, shared by the guitar, piano and other cards.
- **Chords:** triads plus 7, maj7, m7, sus2, sus4, add9, dim, aug, and slash chords where the bass plays another chord tone (C/E). Richer chords must beat a triad by a margin, so plain chords stay plain. Inner voices are expressed by these chord names, not written as notes.
- **Lines:** the melody is the highest clear voice from G3 up; the second line is the highest voice under it from C3 up (a counter-melody or the top of the accompaniment). Notes need strength 0.35 (stems alone use 0.5). Stairway: melody coverage 64% → 79%, second line 71%.
- **Drums:** pattern letters (A, B…) are no longer written; they looked like chord names. Missing hi-hats inside a steady pattern are filled when the hi-hat band (6–16 kHz, read every 3 ms) shows a hit within **12% of the slot's note length**, at least half as strong as the hi-hats around it (a snare on the same sixteenth must reach a full hi-hat's level). Stairway: 580 detected, 39 filled. The user first said 10%, then 5%; 12% was recommended because players drift 10–20 ms, and a comparison at 8/12/16% can be shown on request.
- **Regeneration:** only bass and drums can be redone alone; the ensemble is redone with the whole song. (Since version 10 Harmonic can be redone alone too.)
- **Automatic:** opening a completed song with no current result (app or website) asks for it once in the background and shows a status line. A failed run is left for the button. Older results (versions 3 and 4) are ignored, so songs are re-analysed on first open.
- A local run on Stairway takes about 78 s on this Mac.

### Key change (2026-11-21)

- −6 to +6 semitones in the mixer console (KEY row under the master), applied to every stem including vocals, the cleaned versions and the live take, without changing speed (option A, real time; server-rendered keys were the rejected option B).
- Scores follow: chords, slash basses, both lines and the key name, spelled with flats in flat keys.
- Saved per scene entry as `transpose`; reset returns to 0. Expected to sound natural to about ±3 semitones; vocals may sound mechanical beyond that. Not yet judged by ear.
- **Website (2026-11-22):** the same KEY row under the master (−6 to +6, the key name in the middle, "Original E" beside it once changed). `web/src/pitch-shift.ts` moves each decoded stem and its cleaned version with WSOLA plus resampling in background workers (about 2 s for four 4-minute stems), keeping length and timing, so playback, loops and seeking are unchanged; playback restarts in place when the new key is ready. Quick presses are gathered (400 ms). Scores (strip with key signature, full score, PDF) follow, drums aside. The key is saved in scenes and reset returns it to 0. Checked in Chrome on Enter Sandman (E → F♯, D♭).
- **Spelling:** parts without a key of their own (bass) are spelled like the song's key (`transposePart(part, semitones, songKey)`); F♯ is preferred to G♭.

### Saving the mix

- **Scenes only.** A scene entry saves every stem's mix, master, section, loop, the live channel's mix, the band-part option (`live`) and the key change (`transpose`). The server accepts `live` and `transpose` as optional fields.
- **Music:** opening a song from Music saves nothing and starts at defaults; the whole-song reset exists only in scenes.
- The live take itself (audio and tempo log) is song content and stays per song.

### Themes

- Heavy metal (default), Rock, Pop, Jazz club (was Jazz band), Worship (was Christian), Simple.
- Backgrounds: heavy metal was supplied by the user; Rock, Pop, Jazz club and Worship are rendered by scripts (`mobile/scripts/theme-art/`: light beams through haze, bloom, bokeh, silhouettes). Unsplash photos were considered but its bot check blocks scripted downloads.
- Modals need the theme backdrop explicitly (the scene song picker was white until 2026-11-21).

### Rejected experiments (2026-11-06)

- **Three-part split by synthesis (2026-11-21):** fitted rhythm guitar (strums over half-bar chord shapes), solo guitar (one pitch at a time) and keys (held chord shapes) to the band without vocals, bass and drums, by matching their sum to the magnitude spectrogram. On the Stairway solo it ended at lead 56%, rhythm 35%, keys 9%. The user listened and rejected it; the script, outputs and listening page were deleted.
- **MusicGen Melody bar-by-bar stem generation (2026-11-21):** measured on Fargate (4 vCPU, 16 GB) with the 4-stem Other of Stairway as the melody condition. About 91 s per bar for 3 candidates, batching gave almost nothing (CPU-bound), adding the bars before and after cost 3x time and hit 16.9 GB with no better scores, onset similarity was low. The user listened and rejected it; everything from the test was deleted. The model weights are also non-commercial (CC-BY-NC).
- **4 stems instead of 6 (2026-11-06):** started, then reversed by the user; adopted later, on 2026-11-21 (see Four stems). The first attempt is still in `git stash`.
- **Harmonic-guided cross-stem refinement** (moving bass harmonics between stems, giving Other back to guitar/piano/bass) and **residual redistribution**: measured on remixed server stems, bass got 2–5 dB worse and guitar 1–2 dB worse; residual sharing helped piano but hurt guitar and bass. Not shipped.
- **Residual stem:** the Stairway residual (mix minus six stems) is −20.3 dB and tonal. It was not built after the experiments stopped. Separately, Demucs' default clip rescale lowered the drums about 1 dB in that song.

### Website

Since 2026-11-20 the website gets the app's features where they apply: the ensemble score (shared by guitar, piano and other, with the key), no drum letters, the second line, automatic analysis on open with a status line, themes with backgrounds (menu in the header, saved per browser), the usage line on Music, store links on upload, per-stem mixer names, cropped score strips, and pass-through of the app's `live` and `transpose` scene fields. Not on the website: 12 languages, live input.

## App deployment

Follow the user's existing Yanji app: `~/Documents/GitHub/yanji/yanji-mobile-app` (`eas.json`, `deploy-ios.sh`, `.easignore`, `README.md`). Read it before setting this up.

**Accounts (same as Yanji, set up 2026-11-02):**

- Expo account `nohjiyoung` (logged in on this Mac). EAS project `@nohjiyoung/sorituh`, ID `621ec342-3002-4e90-994e-d789aa50e02e`, in `mobile/app.json`.
- Apple ID `nohjiyoung@hotmail.com`, in `submit.production.ios.appleId` of `mobile/eas.json`. Yanji's iOS production builds succeeded on EAS through 2026-10-06, so the paid developer team works; the old "no team" `build.log` predates that.
- `mobile/eas.json` has `development`, `staging`, `engine-trial` (staging plus `EXPO_PUBLIC_ENGINE_TRIAL=1`) and `production`. The API URLs are fixed in `mobile/src/auth.ts`, so the profiles carry no `API_BASE` yet.
- `.easignore` is at the repo root (`youtube-app/.easignore`), because EAS reads it from the git root and ignores one in `mobile/`. It repeats the `.gitignore` rules plus `.env*` and logs, leaves out `web/`, `backend/` and `music-files/`, and uploads `mobile/engine-trial-audio/`. Remove that folder after step 1.
- Not done yet: App Store Connect app and `ascAppId`, `deploy-ios.sh`, Google Play. An iPhone needs registering (`eas device:create`) before an internal build installs on it.

**Copy from Yanji:**

- **Build and submit through EAS**, not local Xcode: `eas build --platform ios --profile production --auto-submit --wait --non-interactive`, run from `npm run deploy-ios`.
- **Three `eas.json` profiles:** `development` (development client, internal), `staging` (internal, production URLs) and `production` (store, `autoIncrement`), with `cli.appVersionSource: "remote"` so EAS manages build numbers.
- **Settings per profile** through `env` in `eas.json`, with `API_BASE` as the API URL.
- **Preflight in the deploy script:** `set -euo pipefail`, `EXPO_NO_DOTENV=1`, check `eas` is installed and logged in, and assert the production config has no demo or development values before building.
- **`.easignore`** excludes `.env*`, logs and other local files from uploads.
- `ITSAppUsesNonExemptEncryption: false` in `app.json`, which skips the export compliance question on each upload.

**Different for Sorituh:**

- Bundle ID `com.tunesbasis.sorituh`, and its own EAS project and App Store Connect app (`ascAppId`). Do not reuse Yanji's values.
- Yanji is on Expo SDK 54; Sorituh is on SDK 58. Copy the process, not the versions.
- Yanji is also a WebView app, so its code is not a model for the audio engine.
- Yanji has no Android submit configuration or script. Google Play setup has to be written, using the same pattern.

**Test on iPhone** with the `staging` profile, which installs through EAS internal distribution.

**Backend does not change.** Yanji's backend scripts (EC2/PM2 in `yanji-service`) are not used here. The Sorituh backend stays on AWS SAM with `publish-api.sh` and `publish-web.sh`.

Creating the App Store Connect app, EAS builds and store submissions act on external accounts, so do them only when the user asks.

## Assumptions to confirm

These came from the user's short description. The user confirmed 1, 2 and 4 on 2026-11-03:

1. "프리미엄이면 100개까지" means 100 splits per month for premium.
2. "평생 최대 100개" means songs currently stored, not a lifetime total that deletion cannot free.
3. Scenes are left out of the first app version.
4. The per-song limit on restoration and analysis was proposed by the assistant, not requested.

## Build order

1. **Engine trial:** 6 stems at once, sync, seeking, effects and a 15-minute song, on a low-end Android phone and an iPhone. A failure here reopens the design, so it comes first.
2. **Server:** AAC, deletion, conversion of existing songs, usage limits, device API deployment.
3. **App, first version:** sign-in, song list, upload, mixer, cache, background playback.
4. **App, second version:** lyrics and score, restoration, live input, themes, languages, ensemble score, key change. Done and in testing.
5. **Next, planned with the user:** a score editor in the app (full-screen modal; notes, rests, pitch, accidentals, key signature and chords editable; bars and beats fixed to the drum grid; saved per song so every scene shares it), then the website in 12 languages, then live input and key change on the website.
6. **Release:** account deletion, SES production access, billing, App Store Connect and store submission (see App deployment).

## Step 1 plan: engine trial

**Status: passed on the iPhone; the user accepted the library on 2026-11-03 and moved on to step 2 (server).** A low-end Android phone is still to be tested when one is available (see Next session: physical phones). The user approved starting on 2026-11-02.

Answer one question: can `react-native-audio-api` carry the mixer on real phones? Build the least code that answers it. Do not start on app screens, the server or sign-in.

**Setup:**

- Read `mobile/AGENTS.md` and the current library docs first, and check SDK 58 and new architecture support. If it does not support them, report that before going further.
- Put the trial on a temporary screen in `mobile/`, reached without signing in, so `mobile/App.tsx` can be restored afterwards. Do not ship this screen.
- Generate test audio with ffmpeg: 6 stereo AAC 256 kbps `.m4a` files with `+faststart`, at 4 and 15 minutes, using a shared click track so drift can be measured. Bundle or copy them to app storage. No user audio or S3 access is needed.

**Pass criteria:**

| Check | Pass |
|---|---|
| Simultaneous playback | 6 stems play with no dropouts for the full 15 minutes |
| Sync | Stems stay within 1 ms of each other (sample-accurate if possible), including after 20 seeks |
| Mixer | Volume and mute on each stem apply with no clicks |
| Effects | EQ runs on all 6 at once |
| Memory | The 15-minute song stays well under the 1.9 GB of the web approach; record the peak |
| CPU and battery | Record CPU use and whether the phone heats up over 15 minutes |
| Background | Audio continues with the screen locked, and lock-screen controls work |

**Devices:** the Android emulator is only for a first pass, because its timing and memory do not represent phones. The result counts only on a low-end Android phone and an iPhone. An iPhone needs an EAS build with the `engine-trial` profile (see App deployment). Ask the user which physical phones are available.

**Result:** record measurements per device under this section, then recommend one of: use the library, use custom native modules, or reopen the design. Stop there for the user's decision.

### Results so far (2026-11-02)

**Android emulator only** (`sdk_gphone64_arm64`, 1 CPU core, 3 GB RAM), `react-native-audio-api` 0.13.6 on Expo SDK 58. This is a first pass; physical phones are still needed. Trial code: `mobile/src/engine-trial/EngineTrial.tsx`, enabled by building with `EXPO_PUBLIC_ENGINE_TRIAL=1`. It now runs only the EQ scenario; the earlier scenarios used compressor and reverb code that has since been removed.

**Method:** test files hold tones with opposite polarity, so a mix cancels only while stems are aligned. Muting one side first proves audio is really playing. `mobile/src/engine-trial/push-test-audio.sh` generates the files and copies them to a connected Android device.

| Check | Measured | Status |
|---|---|---|
| Sync within a pair | -120 dB when mixed, against -33 dB audible (A) | Pass |
| Sync across pairs | -120 dB for 0a+1b, 1a+2b and 2a+0b (D) | Pass |
| After seeks | -120 dB median over 20 seeks, with and without effects; 5 seeks across pairs | Pass |
| 15 minutes with effects | 800 s of continuous listening, median -120 dB, no crash | Pass |
| Stalls | 0 ms in the compressor run before end of file | Pass; not measured in the 15-minute run |
| Peak memory | 230 MB on 15 minutes with reverb; 240 MB with compressor and reverb on 4 minutes | Pass, against 1.9 GB for the web approach |
| CPU (no effects) | About 4% of the emulator's one core | Recorded |
| CPU with one reverb per stem (now out of scope) | About 60–65%, with peaks to 81% | Recorded; reverb was the heavy part |
| Compressor (now out of scope) | JS worklet on all 6: 12 dB input change gave 3 dB output at ratio 4, CPU about 69%, peaks to 77% | Pass |
| EQ only, current scope (G) | -120 dB over 20 seeks; CPU about 4%, peaks to 8%; peak memory 84 MB on the 4-minute file | Pass |
| 15 minutes with EQ only | Not rerun; the 230 MB run above included reverb | Open, low risk |
| Mixer clicks | iPhone (2026-11-03), by ear on tones: no click with 30 ms ramps, and none with instant gain changes either, so the library or the level may hide clicks; the ramp stays in the real mixer | Pass on iPhone |
| Background and lock screen | iPhone (2026-11-03): Listen 15 min kept playing in the background to the end of the file (900 s), and an Auto 15 min run stayed in sync through about 2 minutes in the background. Lock-screen play and pause stopped and started the sound | Pass on iPhone |
| Battery and heat | iPhone (2026-11-03): no heat after 15 minutes, by feel. Battery not measured | Heat pass on iPhone; battery open |
| iPhone, 4 minutes with EQ (G, 2026-11-03) | -120 dB median over 20 seeks; audible check -33 dB; worst single windows -93 to -96 dB (still about 60 dB below audible); `getCurrentTime()` spread 0 or 2.9 ms (one 128-frame render quantum, not drift) | Pass |
| iPhone, 15 minutes with EQ (H, 2026-11-03, second build) | 5 seeks at -120 dB; continuous play from 0 s at -120 dB median, stall within ±3 ms, until 738 s, where position and context clock froze and the final audible check read silence while JS ran on to DONE. The build had no state or interruption logging, and the user noticed nothing | Stop at 738 s unexplained; did not reproduce |
| iPhone, 15 minutes with EQ (H, 2026-11-03, third build with logging) | 5 seeks at -120 dB; continuous play from 0 s to 848 s, every 60 s window median -120 dB, worst -90 dB, stall within ±3 ms, `state=running` throughout. The app went to the background for about 2 minutes mid-run with no effect; final audible check -33 dB. No interruption or route change logged | Pass |
| Physical Android | No phone available | Open |

Trial runs stopped reporting a position once a file ended, which shows up as a large `stall` value at 240 s. That is expected and is not a dropout.

**Findings for the real engine:**

- Route each source through `MediaElementAudioSourceNode`. Without it, `start()` also connects the source directly to the speakers and bypasses the effects.
- Sample-accurate start and seek use `start(when)` on `AudioFileSourceNode`, which is **not public API**: it is deep-imported from `lib/module/Audio/AudioFileSourceNode`. The library is pre-1.0, so the version is pinned to 0.13.6; expect this to break on upgrade.
- There is no `DynamicsCompressorNode` (on the library's roadmap). The trial's JS worklet worked but had no 6 ms lookahead. `react-native-worklets` was removed after the EQ-only decision and has now been restored at Expo-compatible version 0.13.0 for the approved full-effects scope. A new native binary is required; this is not a JS-only update.
- Read sync from audio, not from `getCurrentTime()`. Its spread reached 23 ms while the mix still cancelled, so it does not measure alignment.
- If reverb comes back: use one shared reverb rather than one per stem, because six convolvers were the main CPU cost.
- Pushing files with `adb` creates folders the app cannot read until `chmod -R 777`; a closed file reports duration 0 and silence, with no error.

**Recommendation (2026-11-03, after the iPhone trial):** use `react-native-audio-api`. On the iPhone, sync held at -120 dB through seeks and 15 minutes with EQ, background and lock-screen playback worked, and mixer changes had no clicks. Still open: one unexplained stop at 738 s in an earlier build without logging (did not reproduce), and a low-end Android phone for memory, CPU and battery. iPhone memory and CPU cannot be measured on this Mac. The user chose this on 2026-11-03 and moved on to step 2; Android is tested later.

### Next session: physical phones

For the Android phone only, when one is available; step 2 comes first. The user has an **iPhone** (2026-11-02); no Android phone yet.

**Trial app (updated 2026-11-02):** the screen now has buttons instead of running on launch. "Auto 4 min" runs scenario G (20 seeks), "Auto 15 min" runs scenario H (5 seeks and 800 s of listening). "Listen 15 min" is a mixer the user hears: play, pause, ±30 s, mute and volume per stem, a ramp switch (30 ms ramps; off sets gains at once and should click), and lock-screen controls through `PlaybackNotificationManager` with the `playback` audio session. The b stems start muted, so plain tones are heard. On return to the app it logs wall time against how far the audio moved, which shows whether audio kept going while locked. "Share log" sends the full log, so the user can paste it here.

**Test audio:** `bash src/engine-trial/push-test-audio.sh` writes 12 files (217 MB) to `mobile/engine-trial-audio/` as AAC in `.mp4`, because expo-asset embeds `.mp4` but not `.m4a`. It pushes them to Android only when a device is attached. `mobile/app.config.js` embeds the folder only when `EXPO_PUBLIC_ENGINE_TRIAL=1`, and iOS reads them from `Paths.bundle` (`expo-file-system`). The folder is gitignored but not in the root `.easignore`, so EAS uploads it with every build; delete it after the trial.

1. **iPhone:**
   1. The user registers the iPhone: `eas device:create` in `mobile/` (interactive; opens a link or QR code on the iPhone to install a profile).
   2. With the user's approval: `eas build --platform ios --profile engine-trial`. EAS asks for Apple sign-in and creates the certificate and ad hoc profile on the first build, so run it interactively.
   3. Install from the build link on the iPhone (Developer Mode must be on: Settings > Privacy & Security).
   4. Run "Auto 4 min", then "Auto 15 min", and share each log. Then "Listen 15 min" by ear: mute and volume with ramp on and off, seeks, screen lock for a few minutes, lock-screen play and pause, and heat after 15 minutes.
   5. iOS memory and CPU cannot be read from an internal build without Xcode (this Mac's Xcode 16.2 is too old). Record "no crash or audio loss over 15 minutes" and heat by feel; Android supplies the numbers.
2. **Android phone over USB** (when one is available; developer mode and USB debugging on; `adb devices` lists it):
   1. From `mobile/`, build and install with `EXPO_PUBLIC_ENGINE_TRIAL=1` and the environment in "Working in this repo": `npx expo prebuild --platform android --no-install`, then `npx expo run:android --variant release --no-bundler`.
   2. Run `bash src/engine-trial/push-test-audio.sh`, then restart the app and tap a test.
   3. The trial logs lines starting with `TRIAL` (`adb logcat -s ReactNativeJS:I`) and ends with `DONE` or `FAILED`. Sample memory with `adb shell dumpsys meminfo com.tunesbasis.sorituh` and CPU with `adb shell top -b -n 1 -p <pid>` every 10 s.
3. Record results per device in the table above, then make the recommendation in "Result" and stop for the user's decision.

After step 1, `mobile/App.tsx` is still the WebView app; step 3 replaces it.

## Step 3: app, first version

**Status (2026-11-03): written, typechecks and lints, and a release build opens to the sign-in screen on the Android emulator. Nothing has been tested signed in, and nothing on the iPhone.** The WebView app (`App.tsx`) and `react-native-webview` and `expo-audio` are removed.

**Layout:** Expo Router, routes in `mobile/src/app/`. `index.ts` loads `expo-router/entry`, or the engine trial when `EXPO_PUBLIC_ENGINE_TRIAL=1`.

| File | What it does |
|---|---|
| `src/app/_layout.tsx` | Session provider; `Stack.Protected` shows sign-in or the app; persistent, safe-area top Music/Scenes/Settings navigation via `src/app-header.tsx` |
| `src/app/sign-in.tsx` | Email and code form, moved from the old `App.tsx` |
| `src/app/index.tsx` | Owned stem-song cards (`GET /api/jobs`, pages of 20), usage, Add a song, visible Open mixer/Delete actions; polls every 5 s during processing; custom deletion confirmation explains Scene cleanup |
| `src/app/upload.tsx` | Modal document picker/upload flow; checks extension and 55 MB, presigned POST with progress, then `/complete`; retry does not upload again; returns to Music |
| `src/app/song/[id].tsx` | Standalone reusable `MixerView` |
| `src/app/scenes/index.tsx` | List/create/open/delete owned Scenes |
| `src/app/scenes/[id].tsx` | Numbered overlapping song tabs, independent names/settings, add/remove songs, move earlier/later, sequential natural-end playback; manual tab selection/Stop/Pause do not auto-advance |
| `src/mixer-view.tsx` | Six stem cards matching the website: Original/Cleaned switch, timeline, metallic Mixer heading with level/LED/FX status, Play/Pause/Stop, MUTE/ALL MUTE/SOLO/LOOP lamp switches, master fader, nine vertical channel strips (horizontal scroll), EFFECTS BYPASS/RESET; visible loading/playback errors |
| `src/mixer-console.tsx` | Web-styled controls: draggable down-arrow S/E markers with the section highlight, red playhead with grip (scrub previews, seeks once on release), Start/Playing/End times with Reset; metallic vertical faders (LCD, scale, dark track, blue-centre thumb) and horizontal master fader; lamp switches. Gradients use React Native's native `backgroundImage`, so no new dependency. All drags claim the responder so the page ScrollView cannot steal them; every control is VoiceOver-adjustable |
| `src/mixer-settings.ts` | Native fractions ↔ web percentages, all effects/flags/selection/loop; restores against decoded/source duration |
| `src/scene-store.ts` | Debounced revision-aware serialized autosave; preserves local edits on failure, Retry/Reload actions and unsaved-change removal guard |
| `src/ui.tsx` | Shared Sorituh palette/buttons and custom confirmation modals (no native Alert dialogs) |
| `src/app/settings.tsx` | Email, plan, splits and songs used, cache size, Remove saved songs, Sign out |
| `src/session.tsx` | Sign-in state, ID token refresh (`REFRESH_TOKEN_AUTH`, 60 s early), falls back to the saved password and then the device route |
| `src/api.ts` | API calls with the ID token as `Authorization: Bearer` |
| `src/cache.ts` | Cache in `Paths.document/songs/<jobId>/`; validates file existence/size, caches completed cleaned versions, deduplicates downloads, reference-counts active songs, waits for every failed-download task before cleanup |
| `src/player.ts` | Async initialization resumes context before building sources; shared `start(when)` for originals/cleaned stems, real source switching, error propagation, atomic Stop and serialized cleanup |
| `src/audio-native.d.ts` | Pinned native audio event binding; subscriptions are explicitly removed because library `attach()/dispose()` does not unregister its JS listeners |
| `test/native-mixer.test.cjs` | Node regression tests using mocked native audio/filesystem and the real backend Scene settings validator |
| `test/mixer-console.test.cjs` | Drives the real console components' gesture handlers with a tiny hook renderer: fader range/snap/clamp, bypass, master, S/E interval limits and scrub-then-seek |

**Choices made without asking (change if wrong):**

- English text, as in the old app and the website.
- Leaving the mixer screen stops playback; there is no mini player. Screen lock and background keep playing while the mixer is open.
- Standalone Music songs open at the website's defaults. Scene entries autosave every effect, master volume, mute/solo, bypass, cleaned-source preference, section and loop independently. Reorder preserves the active entry ID; up to 99 entries, including duplicates. Playback position and playing state are not saved.
- Scene save failures are visible and do not silently overwrite newer server revisions. Retry uses the last acknowledged revision; Reload explicitly discards local edits. Removal navigation flushes pending changes or asks before leaving.
- Loop/selection completion is driven by the native position/end callbacks and a 100 ms UI tick, not sample-accurate loop points. Verify background section boundaries and Scene advancement on the physical phone.
- Lock screen: play, pause, ±15 s and seek. Playback pauses on a phone call and resumes if the system says so, and pauses when headphones are unplugged.
- No duration check before upload; the worker rejects songs over 15 minutes and refunds the split.
- Signing out runs Cognito `GlobalSignOut`, removes the saved password and clears the cache.
- Downloads with HTTP errors are caught by size (under 4 KB), since the download task does not report the status.

**To test next:** sign in on the emulator (a new device on an existing account needs the emailed code), open each of the 4 songs (they play WAV until `convert-playback.mjs --apply` runs), upload a short song, check sync by ear, seeking, lock screen, the cache limit and sign-out. Then an iPhone build with the `staging` profile.

**Native parity repair validation:** `npm test` passes 16 tests covering real effect-node parameter wiring, stereo-linked/non-amplifying compression, synchronized original/cleaned scheduling and switching, mute/solo gains, lock-screen title updates, Play failure and queue recovery, completion exactly once, loop without Scene advance (including turning loop off during restart), shutdown during Play, stalled-audio errors, invalid-source cleanup, cache deduplication/reference counts/missing files/download failures, percentage snapshots accepted by the real backend validator, and autosave revision serialization/conflicts/discard. `npx tsc --noEmit`, `npx expo lint`, all 20 Expo Doctor checks, final Android `:app:assembleRelease` with native Worklets, and an iOS Hermes export pass. The Android APK was compiled only, not installed. These are not evidence of signed-in playback, full-effects CPU/battery, or iPhone navigation/audio correctness. No commit, push or production release was made for this repair.

**Approved iPhone test build:** after validation, the user approved an internal `staging` build. EAS build [`57af3d51-e0c9-44f0-865b-2e6c0e81f995`](https://expo.dev/accounts/nohjiyoung/projects/sorituh/builds/57af3d51-e0c9-44f0-865b-2e6c0e81f995) finished successfully and is ready to install on the existing registered iPhone using that link. Installation and signed-in playback have not yet been verified. Staging explicitly sets `EXPO_PUBLIC_ENGINE_TRIAL=0`; the separate engine-trial profile still overrides it with `1`. The latest EAS CLI installation failed with npm `Invalid Version`; the already installed compatible EAS CLI 20.5.1 authenticated and submitted the build successfully.

### Mixer-loading crash investigation (2026-11-03)

The user reported the staging app exits while loading the mixer, and requested an iOS simulator reproduction. This Mac can run its installed iOS 18.3 simulator, although Xcode 16.2 cannot compile Expo 58 locally. An EAS simulator build, [`1de8315e-4136-499d-bcda-41c250898a53`](https://expo.dev/accounts/nohjiyoung/projects/sorituh/builds/1de8315e-4136-499d-bcda-41c250898a53), was built using the `mixer-diagnostic` profile. It runs the **production Mixer** with six bundled test stems, without account credentials.

- **Reproduced:** native `EXC_BAD_ACCESS / SIGSEGV` at address `0x30`, in `audioapi::ThreadPool::wait()` → `ConvolverNode::performConvolution()` → `ConvolverNode::processNode()`, while loading the mixer. The supplied pasted report matches the simulator report.
- **Cause:** `src/effects.ts` connected a convolver with no impulse buffer, expecting to initialize it later when Reverb became nonzero. Native audio-api 0.13.6 renders that connected path even with send gain zero. Its convolver unconditionally dereferences a thread pool which is created only when `buffer` is set.
- **Fix:** initialize the cached impulse on every convolver **before connecting it**. Moving the Reverb fader now only adjusts gains; it never replaces the live impulse. No effects were removed.
- **Regression:** the audio mock now refuses to connect an uninitialized convolver. The relevant test failed before the fix and passes afterward.
- **Native verification:** replaced only the simulator artifact's JS bundle using Expo's compiled Hermes export, leaving the native binary unchanged. The same reproduction completes create/play/all-effects/stop/close, reports approximately 2.8 seconds of audio progress, and remains alive. A second run rendered the actual `MixerControls` and the shared safe-area top `AppHeader` successfully. This is test-audio verification, not signed-in real-song or physical-iPhone performance validation.
- **Navigation:** Music/Scenes/Settings now appear at the top, below the notch, with a separate flex container for the route stack so content cannot squeeze the header away.
- **Diagnostic isolation:** `EXPO_PUBLIC_MIXER_DIAGNOSTIC=1` selects `src/engine-trial/MixerDiagnostic.tsx` and embeds test audio only for that build. Normal staging continues to use the real app; no authentication behavior was changed.

The original iPhone staging build above still contains the crash. The user approved a replacement; fixed iPhone staging build [`b77fb229-c94e-416a-a70d-898cf38b6080`](https://expo.dev/accounts/nohjiyoung/projects/sorituh/builds/b77fb229-c94e-416a-a70d-898cf38b6080) completed successfully and is ready to install. Both diagnostic flags are explicitly `0` in staging, so this is the normal signed-in app with the convolver fix and top navigation. Physical-phone verification of the replacement remains pending.

### Silent mixer and lock-screen crash (2026-11-03)

After the convolver fix the app stayed open but made no sound. Analyser RMS probes in the simulator diagnostic (`src/engine-trial/MixerDiagnostic.tsx`) showed signal up to `distortionDry` and exact zero from the distortion mix onward, including the master.

- **Cause (native `react-native-audio-api` 0.13.6, `AudioNode.cpp`):** with the default `channelCountMode: 'max'`, a node with a single input processes that input node's own buffer in place, so the ×0 distortion wet gain zeroed the shared compressor output; a fan-out node's second consumer also received a stale cached buffer.
- **Fix:** every graph node is constructed with `{ channelCount: 2, channelCountMode: 'explicit' }` (`EXPLICIT_STEREO`/`stereoGain` in `src/effects.ts`), which mixes inputs into the node's own buffer. The worklet compressor cannot take options, so it feeds exactly one explicit `compressed` splitter gain. `context.createX()` cannot pass options; use the node constructors. Set the waveshaper `curve` and convolver `buffer` through setters (the option parsers do not read them), the convolver before connecting.
- **Verified in the simulator with test audio:** every stage carries signal, master RMS ≈ 0.0137; with compression 35, distortion 20, reverb 30 the reverb path and master remain audible (master ≈ 0.0133). Not yet verified on the iPhone with real songs.
- **Second crash found while probing:** SIGSEGV in `-[NotificationRegistry showNotificationWithType:]`. The native lock-screen registry mutates an unsynchronized dictionary from concurrent queues, and the app fired several `enableControl` calls in parallel. `src/player.ts` now serializes `enableControl`/`show`/`hide` through one queue; `show` reads the latest state when it runs and is skipped once the mixer is closed.
- **Regression tests:** "every mixing node is explicit stereo" and "lock-screen control calls never overlap" both fail when the fixes are reverted.

**Web-matching mixer controls:** the user asked for down-arrow start/end markers, a cursor showing the playing position, and the website's vertical metallic faders. `src/mixer-console.tsx` implements these. Rendering was checked with simulator screenshots, matching the web colours and layout. Native streaming file sources expose no peaks, so the timeline is a plain track with quarter ticks rather than a waveform. The simulator could not receive synthetic touches without macOS Accessibility permission, so dragging was verified by `test/mixer-console.test.cjs` (mutations of the fader mapping and the ScrollView guard fail all four tests), not by hand. `@react-native-community/slider` is no longer imported but remains installed until the next dependency cleanup.

The user approved a replacement iPhone staging build: [`b7d97010-a0da-440f-99f9-ea2d42457b20`](https://expo.dev/accounts/nohjiyoung/projects/sorituh/builds/b7d97010-a0da-440f-99f9-ea2d42457b20) finished successfully. It contains the explicit-stereo audio fix, the lock-screen serialization and the web-matching controls. Physical-phone playback is still to be confirmed.

### Mixer scrolling and diagnostic test audio

- Faders, the timeline and the master fader used to claim every touch on start, so the page could not scroll. `useDrag` now accepts `claim: 'horizontal'` (timeline, master: claimed only for sideways drags) and `startsOn` (channel faders: claimed only when the touch starts on the knob). Vertical swipes elsewhere scroll the page; S/E markers and the playhead still claim immediately.
- The bundled diagnostic stems are opposite-polarity pairs, so playing all six cancels to silence and makes mute/solo misleading. The controls test now uses only the non-cancelling "a" stems and logs per-stem levels for all-on, mute and solo, which confirmed mute and solo work. Real songs are unaffected.
- iPhone staging build 93fc2cf2 includes the scrolling fix.

### Live follow

Playing along with an instrument while the stems follow the player's tempo, and saving the take with its tempo log, is described in [live-follow.md](./live-follow.md).

### Lyrics and score (악보)

The app now has the website's lyrics and score in each stem card, between the header and the timeline:

- **Vocals:** "Lyrics" starts finding lyrics. Once found, a word strip glides so the sung word reaches the middle, and its neighbours are lit more faintly. "Edit lyrics" pauses playback and opens a full-screen editor with timed rows, add-line buttons and an in-modal discard confirmation. Saving moves the cursor one second before the first change.
- **Other, bass:** "Chords & melody" runs the whole score. The result is a staff with chords, notes, rests, ties and a clef. "Regenerate" redoes one stem from the version being heard (original or cleaned).
- **Drums:** a drum staff with crossed cymbals, beamed hands, the kick as a separate voice and pattern letters.
- The API calls, 4-second polling, wording and empty and failed messages are the same as the website's.

Where the code lives:

- `src/score.ts`: pure layout and timing, ported unchanged from `web/src/harmony-strip.ts`, `lyrics-strip.ts` and `lyrics-editor.ts`, and tested in `test/score.test.cjs`.
- `src/song-tasks.ts`: state and polling.
- `src/score-view.tsx`: views.

The staff uses `react-native-svg`. It draws in four-bar chunks and mounts only those near the playhead. Moving the active highlight redraws one chunk.

`react-native-svg` is a native module, so this needs a new native build. Builds 93fc2cf2 and earlier do not include it.

**Beams (2026-11-22).** Eighths and shorter that follow each other within one beat are joined by beams instead of flags (`beamNotes` in `src/score.ts`, the same block in `web/src/harmony-strip.ts`, checked by `web/test/score-sheet.test.mjs`). Each group's stems go one way (the voice's side when two lines share the staff, else where most notes sit); the beam follows the notes at a slant of at most 0.2 and moves out until every stem is at least 20 long; runs of sixteenths get one second beam, a lone sixteenth a stub. Used by the app and website strips, the full score and the PDF.

**Held controls (2026-11-22, rails removed 2026-11-27).** Holding any mixer control (fader, knob, markers, waveform) stops the page scrolling; letting go frees it. `controlHold` in `src/stem-scroll.tsx` also checks every 3 s while held and lets go if nothing moved, in case a release is lost.

**Score PDF and full score (2026-11-22).** Each written score (other, bass, drums) has "Full score" and "Save PDF" buttons. `src/score-sheet.ts` lays the strip's marks out four bars to a line on A4 pages, with the title, the artist (right, under the title), part and key, tempo, a clef and key signature on every line, bar numbers and page numbers. `sheetPages` returns each page as an SVG string and `scoreSheet` wraps them in printable HTML, so both are pure and tested in `test/score-sheet.test.cjs`.

- **Full score:** the app shows the pages in a full-screen modal (`src/score-preview.tsx`, `SvgXml`, pinch to zoom; pages are parsed as they scroll into view), with Save PDF. The website shows the same HTML in a dialog's frame (grey background and page shadows on screen only) and prints that frame.

- **App:** `src/score-pdf.ts` prints the HTML with `expo-print`, renames the file to "<title> - <part>.pdf" and opens the share sheet with `expo-sharing` (Save to Files, AirDrop, mail). The sheet follows the key change. Both modules are native, so this needs a new native build: 39609899 and later.
- **Website:** `web/src/score-sheet.ts` is the same code with other imports, which `web/test/score-sheet.test.mjs` checks. It prints from a hidden frame, so the browser's print dialog offers Save as PDF. The file name comes from the page title. The website's layout now has the app's key-signature spelling for this. Its scrolling strip still uses the mixed spelling because it has no key signature.

### Bass and drum scores (2026-11-28)
- **Upload per part:** the Harmonic, bass and drum cards each have an Upload score button (web and app); each part's GEN button asks whether there is a score for that part, and a saved one is used without asking. Scores are kept by part (`score` for the Harmonic one, `partScores.bass`/`.drums`; `/api/stems/jobs/{id}/score[/bass|/drums]`), and one worker run lays all of them (score_run.mjs `--score part=file`).
- **Laying:** the drum score first (its drum hits compared with the drum transcription's, bar by bar, repeats taken, jumps costly since drum bars repeat), then the Harmonic score, then the bass score (fitted against the bass stem in the Harmonic stem's place; its notes replace the bass line). The first corrects the drum beats; the later ones keep that grid. Before laying, the beats are mended: a gap of about two beats gets one back, two half gaps lose the beat between. Our God, test scores made from the transcription: the drum score laid on every true bar; with a beat lost at 60 s and a false one at 150 s every downbeat was right again and the beats 0 ms from the true ones. All three together: 52 s, 0 corrections.
- **Playing:** Bass (score) and Drums (score) channels under their stems, muted to begin with, each with a console and a sound list: 19 basses (General MIDI 32–39; Karoryfer, D. Smolken, FreePats, CC0) on pitches from C1, and 13 kits (General MIDI kits 128–134; Virtuosity, Swirly, Big Rusty, DrumGizmo DRS and Muldjord, FreePats synth percussion; CC0 / CC BY 4.0), each kit's drums at the same balance. The analysis ranks basses against the bass stem and kits against the drum stem (CLAP); the server sends the bass and drum stems' loudness with a scored result.
- **App mixers:** every mixer starts folded and opens on its own, a round chevron key on its header; the scroll rails are 50% wider (27 pt strip, 12 pt thumb with arrows at both ends), and a finger scrolls the page from anywhere that is not a control (a held control stops it), the rails showing while it does.

### Languages

Settings → Language offers 12 languages: English, 한국어, 日本語, 简体中文, Filipino, Tiếng Việt, Bahasa Indonesia, Français, Deutsch, Español, Português and Italiano. "Phone language" is the default. It follows the iPhone's language (via `expo-localization`) and falls back to English. The choice is saved in `language.json` in the app's documents.

- `src/locales/en.ts` is the source. Each key's text may hold `{name}` placeholders. Every other file is typed as `Strings`, so `npx tsc --noEmit` fails if a language is missing a key.
- `src/i18n.ts` holds the language list, phone-language matching and the global `t()`, which is used for errors raised outside screens. `src/language.tsx` provides `useT()` and `useLanguage()` for screens, so they redraw when the language changes.
- Data lists (instruments, effects, follow strengths, themes) keep English labels. Screens look up `stem.*`, `effect.*`, `instrument.*`, `follow.*` and `theme.*` keys by id.
- To add text: add a key to `en.ts`, then add the same key to the other 11 files.
- Known limits: messages written by the server and iOS system prompts (such as the microphone permission) stay in English. The translations are machine-made and should be reviewed by native speakers.
- `expo-localization` is a native module, so this needs a new native build.

## Admin (master user, 2026-11-21)

- The master admin is an ordinary user in the same Cognito pool, in the group `admins`. It needs no device: it signs in on the website with email and password. `backend/create-admin.mjs` creates it from `SORITUH_ADMIN_EMAIL` and `SORITUH_ADMIN_PASSWORD` in the root `.env` (ignored by git) and adds it to the group.
- The website shows an Admin link and page (`web/src/admin-page.ts`) only to that group. The API (`backend/admin-api.mjs`) checks the group on every request, and only for tokens from the public client.
- Per user the page shows: enabled or disabled, plan (Free or Premium, changeable), songs and limit, storage, splits this month, time open and time playing today and over 7 days, last active day.
- Disable also signs the user out on every device. An admin cannot disable their own account.
- Open as user: the API signs in as that user through `ImpersonationClient`, a server-only client that allows only CUSTOM_AUTH. Its challenge (`backend/auth-challenge.mjs`) accepts only an HMAC made with a secret in Secrets Manager. The tokens last one hour and cannot be refreshed. The website keeps the admin's session in the tab, shows a red "Viewing as" banner, and returns to the Admin page on Exit or when the hour ends. Admin accounts and disabled users cannot be opened. Every action is written to the log as an `audit` line.
- Time: the app (`mobile/src/activity.ts`) and the website (`ActivityService`) send `POST /api/activity` about once a minute with seconds open and seconds playing, at most 120 each. They are stored per UTC day as `activity:YYYY-MM-DD` in the jobs table. Time while an admin views an account is not counted.

## Constraints

- **iOS cannot be built on this Mac.** Expo SDK 58 needs Swift 6.2 (Xcode 26); the Mac has Xcode 16.2 on macOS 14.5. Use EAS and a physical iPhone, as in App deployment. Yanji's submit settings suggest an Apple Developer account exists, but its status has not been checked, and an old Yanji `build.log` shows a "no team" failure.
- **Apple requires in-app account deletion** for apps that create accounts. Not built.
- **Android signing:** the current APK is for testing; Google Play needs a release key. Changing the key changes the Android ID, so test accounts will need the email code once.
- **Email:** Cognito's built-in sender did not reach Hotmail, so `template.yaml` sends through SES from `no-reply@tunesbasis.com` (applied by the 2026-11-20 deploy). **SES is still in sandbox**, so codes reach only the verified addresses `nohjiyoung@hotmail.com` and `jay-noh@naver.com`; anyone else cannot sign in on a new device or reset a password. The user still has to choose: request SES production access, or go back to `COGNITO_DEFAULT`.
- **Open sign-up:** there is no email proof or admin approval on new accounts. Abuse protection is IP rate limiting plus the limits above.
- **Device ID acts as a credential:** email plus device ID can reset a password. A rooted Android phone can expose the ID.
- **Accounts awaiting admin approval** stay disabled in the app.

The ADTOF licence is handled by a plan to train an in-house model before production. Do not raise it.

## Working in this repo

- **Android build:** from `mobile/`, run `npx expo run:android --variant release --no-bundler` with `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"` and `ANDROID_HOME=~/Library/Android/sdk`. The system Java 26 is not suitable. AVD: `Medium_Phone_API_36.1`.
- **CocoaPods** needs `LANG=en_US.UTF-8` and `LC_ALL=en_US.UTF-8`.
- **Expo APIs:** `mobile/AGENTS.md` says to check the versioned docs, because SDK 58 differs from older knowledge. `ios/` and `android/` are generated and gitignored; never edit them by hand.
- **Checks:** `node --test test/*.test.mjs` in `backend/`; `npm test`, `npx tsc --noEmit`, `npx expo lint` and `npx expo-doctor` in `mobile/`; `sam validate --lint` in the repo root.
- **API deploy:** `STEM_IMAGE=<image> bash publish-api.sh youtube-audio-library`; without `STEM_IMAGE` the deployed image stays. The current image is `086723604095.dkr.ecr.us-west-2.amazonaws.com/youtube-audio-library-artifacts-stemrepository-8kjzuftyhvbg:cpu-20261121080006`. Worker code changes need a new image first (`build-stem-image.sh`, needs Docker Desktop running). The publish scripts ship the working folder as it stands.
- **Analysis locally:** a venv with the worker's Python requirements (no torch, demucs or whisper) plus `basic-pitch==0.4.0 --no-deps`, and the ADTOF model from the Dockerfile's URL as `DRUM_MODEL`, runs `analyze_harmony.py` on downloaded stems.
- **iPhone builds:** `eas build --platform ios --profile staging` and install from the build link. `xcrun devicectl` cannot install on the user's iPhone because Xcode 16.2 has no disk image for its iOS. The `simulator` profile builds for the iOS 18 simulator on this Mac. `eas build` sometimes fails right after a cancel; rerunning works.
- **Scene settings and the server:** the backend validates every field of scene settings, so a new app field (like `live` or `transpose`) needs the API deployed before an app build that sends it.
- **Names:** "youtube" in the stack name, the `youtube-session` key and similar is only a label; YouTube downloading has been removed.

## Score channels and rails (2026-11-27)

- The score channels under a stem (Guitar and Keys under Harmonic, Bass (score), Drums (score)) appear only once that stem's own uploaded score is laid on the song (`tasks.fromScore`). A transcribed part plays only through its stem.
- A Harmonic card whose part is transcribed says so: not exact, and an uploaded score replaces it (`tasks.transcribedNote`).
- The scroll rails are gone; pages inset by EDGE = 16.
