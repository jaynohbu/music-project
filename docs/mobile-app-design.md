# Sorituh mobile app design

Status: step 1 (engine trial) passed on the iPhone; step 2 (server) is next. Last updated 2026-11-03.

This is the source of truth for the native app work. Read it before changing `mobile/`, the stem pipeline, or account limits. A Korean summary for people is in `sorituh-mobile-app-design.docx`; if the two differ, this file wins.

## Goal

Replace the WebView wrapper with a native Expo app that plays stems from its own audio engine. Users sign in with an email only and never see a password. The AWS backend stays; the website stays but gets no new features.

## Current state

| Area | State | Where |
|---|---|---|
| WebView app | Works on the Android emulator; to be replaced except for sign-in | `mobile/App.tsx` |
| Sign-in logic | Keep | `mobile/src/auth.ts` |
| Device account API | Deployed 2026-11-03 with the `ByDevice` index; session route answers 201; not yet used from a phone | `backend/accounts.mjs`, `template.yaml` |
| AAC generation | Deployed 2026-11-03 (worker image `cpu-20261103210959`); not yet seen on a real split | `backend/stem-playback.mjs`, `backend/stem-worker.mjs`, `backend/stem-restore.mjs` |
| AAC for existing songs | Script written; dry run lists 4 songs and 7 cleaned stems; not applied yet | `backend/convert-playback.mjs` |
| Usage limits | Deployed 2026-11-03; `GET /api/stems/usage` answers 401 signed out | `backend/stem-usage.mjs`, `backend/stem-api.mjs`, `backend/accounts.mjs` |
| Audio engine | Not started; biggest risk | none yet |
| Local cache | Not started | none yet |

Step 1 and step 2 work is committed and pushed (`9b01351` on `main`). Commit, push or deploy only when the user asks.

Nothing has run end to end against real AWS or on a physical phone.

## Architecture

```
App (Expo)
 ├ Sign-in: email + device ID
 ├ Screens: music list, upload, mixer, settings
 ├ Audio engine: real-time mix of 6 AAC files read from disk
 └ Local cache: most recent 20 songs or 2 GB, whichever comes first
Server (existing AWS stack)
 ├ API: accounts, song list, usage limits
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
- Port bass/mid/treble EQ from `web/src/stem-effects.ts`. **Compressor and reverb are out of scope for now:** the user decided on 2026-11-02 that neither is an important feature. The website keeps them. Other effects on the web mixer (distortion, pan, pre-gain) were not discussed; do not port them without asking.
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
4. **App, second version:** lyrics, chords, restoration.
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
- If the compressor comes back: there is no `DynamicsCompressorNode` (on the library's roadmap). The trial's JS worklet worked but had no 6 ms lookahead, and needed `react-native-worklets`, which has been removed from the app.
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
- **Checks:** `node --test test/*.test.mjs` in `backend/`; `npx tsc --noEmit`, `npx expo lint` and `npx expo-doctor` in `mobile/`; `sam validate --lint` in the repo root.
- **API deploy:** `STEM_IMAGE=<image> bash publish-api.sh youtube-audio-library`. The current image is `086723604095.dkr.ecr.us-west-2.amazonaws.com/youtube-audio-library-artifacts-stemrepository-8kjzuftyhvbg:cpu-20261103210959`. Worker code changes need a new image first (`build-stem-image.sh`). The publish scripts ship the working folder as it stands.
- **Names:** "youtube" in the stack name, the `youtube-session` key and similar is only a label; YouTube downloading has been removed.
