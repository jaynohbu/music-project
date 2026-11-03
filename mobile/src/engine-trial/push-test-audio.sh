#!/usr/bin/env bash
# Generates the engine trial audio and copies it to a connected Android device.
# Each pair (a, b) holds the same two tones with opposite polarity, so a mix of the
# pair cancels only while the stems stay aligned. See docs/mobile-app-design.md.
#
# Usage: bash push-test-audio.sh [output folder]   (needs ffmpeg and adb on PATH)
# Install the trial app first, so the app's storage folder exists.
set -euo pipefail
OUT=${1:-${TMPDIR:-/tmp}/sorituh-engine-audio}
PKG=com.tunesbasis.sorituh
TARGET=/storage/emulated/0/Android/data/$PKG/files/trial
mkdir -p "$OUT"
for d in 240 900; do
  for i in 0 1 2; do
    f=$((100 + i * 270)); g=$((f * 3 + 11))
    [ -f "$OUT/s${d}_${i}b.m4a" ] && continue
    ffmpeg -nostdin -y -loglevel error \
      -f lavfi -i "sine=frequency=${f}:sample_rate=44100:duration=${d}" \
      -f lavfi -i "sine=frequency=${g}:sample_rate=44100:duration=${d}" \
      -filter_complex "[0][1]amerge=inputs=2,asplit=2[a][b];[a]volume=0.2[x];[b]volume=-0.2[y]" \
      -map "[x]" -c:a aac -b:a 256k -movflags +faststart "$OUT/s${d}_${i}a.m4a" \
      -map "[y]" -c:a aac -b:a 256k -movflags +faststart "$OUT/s${d}_${i}b.m4a"
  done
done
adb shell mkdir -p "$TARGET"
adb push "$OUT"/. "$TARGET"/
# adb creates the folders as the shell user; without this the app reads duration 0 and silence.
adb shell chmod -R 777 /storage/emulated/0/Android/data/$PKG
adb shell ls -l "$TARGET"
