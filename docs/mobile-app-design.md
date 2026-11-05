# Sorituh mobile app design

Status: step 1 passed on the iPhone, step 2 is deployed, and step 3 now includes native Scenes and the full effects mixer. The parity repair passes 16 mocked regression tests, typecheck, lint, Expo Doctor, Android native compilation and iOS bundle export; it has not yet been tested signed in on a physical phone. Last updated 2026-11-03.

This is the source of truth for the native app work. Read it before changing `mobile/`, the stem pipeline, or account limits. A Korean summary for people is in `sorituh-mobile-app-design.docx`; if the two differ, this file wins.

## Goal

Replace the WebView wrapper with a native Expo app that plays stems from its own audio engine. Users sign in with an email only and never see a password. The AWS backend stays; the website stays but gets no new features.

## Current state

| Area | State | Where |
|---|---|---|
| App, first version | Written 2026-11-03; builds and opens to sign-in on the Android emulator; not tested signed in or on the iPhone | `mobile/src/app/`, see Step 3 |
| Sign-in logic | Keep | `mobile/src/auth.ts` |
| Device account API | Deployed 2026-11-03 with the `ByDevice` index; session route answers 201; not yet used from a phone | `backend/accounts.mjs`, `template.yaml` |
| AAC generation | Deployed 2026-11-03 (worker image `cpu-20261103210959`); not yet seen on a real split | `backend/stem-playback.mjs`, `backend/stem-worker.mjs`, `backend/stem-restore.mjs` |
| AAC for existing songs | Script written; dry run lists 4 songs and 7 cleaned stems; not applied yet | `backend/convert-playback.mjs` |
| Usage limits | Deployed 2026-11-03; `GET /api/stems/usage` answers 401 signed out | `backend/stem-usage.mjs`, `backend/stem-api.mjs`, `backend/accounts.mjs` |
| Audio engine | Written from the trial findings; not yet run on real songs | `mobile/src/player.ts` |
| Local cache | Written; not yet run | `mobile/src/cache.ts` |

Step 1 and step 2 work is committed and pushed (`9b01351` on `main`). Commit, push or deploy only when the user asks.

Nothing has run end to end against real AWS or on a physical phone.

## Architecture

```
App (Expo)
 ├ Sign-in: email + device ID
 ├ Screens: music list, scenes, upload, mixer, settings
 ├ Audio engine: real-time mix of 6 AAC files read from disk
 └ Local cache: most recent 20 songs or 2 GB, whichever comes first
Server (existing AWS stack)
 ├ API: accounts, song list, scenes, usage limits
 ├ Split worker: on-demand Fargate task, also produces AAC
 └ S3: WAV (original, downloads) + AAC (playback, cache)
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

| 6 stems | WAV | AAC 256 kbps |
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
- First candidate is `react-native-audio-api`. It passed on the Android emulator but is **not yet proven on physical phones** (see Step 1 plan). The fallback is custom Expo modules using AVAudioEngine on iOS and Oboe on Android.

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

### Website

No new features. It gets AAC playback automatically through `playUrl`.

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
4. **App, second version:** lyrics and chords (written 2026-11-03, see "Lyrics and score"; rendering checked on the iOS simulator build 20efb6bf with `react-native-svg`; an iPhone build with the new native module is still needed), restoration.
5. **Release:** account deletion, Amazon SES, billing, EAS setup and store submission (see App deployment). Set up the `staging` profile earlier, because step 1 needs an iPhone build.

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
- **Guitar, piano, other, bass:** "Chords & melody" runs the whole score. The result is a staff with chords, notes, rests, ties and a clef. "Regenerate" redoes one stem from the version being heard (original or cleaned).
- **Drums:** a drum staff with crossed cymbals, beamed hands, the kick as a separate voice and pattern letters.
- The API calls, 4-second polling, wording and empty and failed messages are the same as the website's.

Where the code lives:

- `src/score.ts`: pure layout and timing, ported unchanged from `web/src/harmony-strip.ts`, `lyrics-strip.ts` and `lyrics-editor.ts`, and tested in `test/score.test.cjs`.
- `src/song-tasks.ts`: state and polling.
- `src/score-view.tsx`: views.

The staff uses `react-native-svg`. It draws in four-bar chunks and mounts only those near the playhead. Moving the active highlight redraws one chunk.

`react-native-svg` is a native module, so this needs a new native build. Builds 93fc2cf2 and earlier do not include it.

### Languages

Settings → Language offers 12 languages: English, 한국어, 日本語, 简体中文, Filipino, Tiếng Việt, Bahasa Indonesia, Français, Deutsch, Español, Português and Italiano. "Phone language" is the default. It follows the iPhone's language (via `expo-localization`) and falls back to English. The choice is saved in `language.json` in the app's documents.

- `src/locales/en.ts` is the source. Each key's text may hold `{name}` placeholders. Every other file is typed as `Strings`, so `npx tsc --noEmit` fails if a language is missing a key.
- `src/i18n.ts` holds the language list, phone-language matching and the global `t()`, which is used for errors raised outside screens. `src/language.tsx` provides `useT()` and `useLanguage()` for screens, so they redraw when the language changes.
- Data lists (instruments, effects, follow strengths, themes) keep English labels. Screens look up `stem.*`, `effect.*`, `instrument.*`, `follow.*` and `theme.*` keys by id.
- To add text: add a key to `en.ts`, then add the same key to the other 11 files.
- Known limits: messages written by the server and iOS system prompts (such as the microphone permission) stay in English. The translations are machine-made and should be reviewed by native speakers.
- `expo-localization` is a native module, so this needs a new native build.

## Constraints

- **iOS cannot be built on this Mac.** Expo SDK 58 needs Swift 6.2 (Xcode 26); the Mac has Xcode 16.2 on macOS 14.5. Use EAS and a physical iPhone, as in App deployment. Yanji's submit settings suggest an Apple Developer account exists, but its status has not been checked, and an old Yanji `build.log` shows a "no team" failure.
- **Apple requires in-app account deletion** for apps that create accounts. Not built.
- **Android signing:** the current APK is for testing; Google Play needs a release key. Changing the key changes the Android ID, so test accounts will need the email code once.
- **Email:** the user pool uses Cognito's built-in sender (about 50 messages a day, from memory, unverified). Move to Amazon SES before launch.
- **Open sign-up:** there is no email proof or admin approval on new accounts. Abuse protection is IP rate limiting plus the limits above.
- **Device ID acts as a credential:** email plus device ID can reset a password. A rooted Android phone can expose the ID.
- **Accounts awaiting admin approval** stay disabled in the app.

The ADTOF licence is handled by a plan to train an in-house model before production. Do not raise it.

## Working in this repo

- **Android build:** from `mobile/`, run `npx expo run:android --variant release --no-bundler` with `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"` and `ANDROID_HOME=~/Library/Android/sdk`. The system Java 26 is not suitable. AVD: `Medium_Phone_API_36.1`.
- **CocoaPods** needs `LANG=en_US.UTF-8` and `LC_ALL=en_US.UTF-8`.
- **Expo APIs:** `mobile/AGENTS.md` says to check the versioned docs, because SDK 58 differs from older knowledge. `ios/` and `android/` are generated and gitignored; never edit them by hand.
- **Checks:** `node --test test/*.test.mjs` in `backend/`; `npm test`, `npx tsc --noEmit`, `npx expo lint` and `npx expo-doctor` in `mobile/`; `sam validate --lint` in the repo root.
- **API deploy:** `STEM_IMAGE=<image> bash publish-api.sh youtube-audio-library`. The current image is `086723604095.dkr.ecr.us-west-2.amazonaws.com/youtube-audio-library-artifacts-stemrepository-8kjzuftyhvbg:cpu-20261103210959`. Worker code changes need a new image first (`build-stem-image.sh`). The publish scripts ship the working folder as it stands.
- **Names:** "youtube" in the stack name, the `youtube-session` key and similar is only a label; YouTube downloading has been removed.
