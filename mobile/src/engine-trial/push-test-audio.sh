#!/usr/bin/env bash
# Generates the engine trial audio into mobile/engine-trial-audio and, when an Android
# device is attached, copies it there. Each pair (a, b) holds the same two tones with
# opposite polarity, so a mix of the pair cancels only while the stems stay aligned.
# See docs/mobile-app-design.md.
#
# The files are AAC in an .mp4 container (the same as .m4a), because expo-asset only
# embeds .mp4 into iOS builds. app.config.js embeds the folder when
# EXPO_PUBLIC_ENGINE_TRIAL=1, so run this before an iPhone trial build.
#
# Usage: bash push-test-audio.sh   (needs ffmpeg; adb for Android)
# On Android, install the trial app first, so the app's storage folder exists.
set -euo pipefail
OUT=$(cd "$(dirname "$0")/../.." && pwd)/engine-trial-audio
PKG=com.tunesbasis.sorituh
TARGET=/storage/emulated/0/Android/data/$PKG/files/trial
mkdir -p "$OUT"
for d in 240 900; do
  for i in 0 1 2; do
    f=$((100 + i * 270)); g=$((f * 3 + 11))
    [ -f "$OUT/s${d}_${i}b.mp4" ] && continue
    ffmpeg -nostdin -y -loglevel error \
      -f lavfi -i "sine=frequency=${f}:sample_rate=44100:duration=${d}" \
      -f lavfi -i "sine=frequency=${g}:sample_rate=44100:duration=${d}" \
      -filter_complex "[0][1]amerge=inputs=2,asplit=2[a][b];[a]volume=0.2[x];[b]volume=-0.2[y]" \
      -map "[x]" -c:a aac -b:a 256k -movflags +faststart "$OUT/s${d}_${i}a.mp4" \
      -map "[y]" -c:a aac -b:a 256k -movflags +faststart "$OUT/s${d}_${i}b.mp4"
  done
done
ls -l "$OUT"
if ! command -v adb >/dev/null || [ -z "$(adb devices | sed 1d | grep device)" ]; then
  echo "No Android device attached; files left in $OUT"
  exit 0
fi
adb shell mkdir -p "$TARGET"
adb push "$OUT"/. "$TARGET"/
# adb creates the folders as the shell user; without this the app reads duration 0 and silence.
adb shell chmod -R 777 /storage/emulated/0/Android/data/$PKG
adb shell ls -l "$TARGET"
