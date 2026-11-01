#!/usr/bin/env python3
"""Finds the chords and top notes of harmonic stems, written as JSON. Output is approximate."""
import argparse
import json

import librosa
import numpy as np

RATE = 22050
HOP = 2048
SECONDS = HOP / RATE
NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
# Triads only: separated stems rarely hold full voicings, so richer chord types were mostly guesses.
SHAPES = {'': (0, 4, 7), 'm': (0, 3, 7)}
# Quieter than this share of the loudest stem at that moment is treated as bleed from that stem.
BLEED_SHARE = 0.25
# Krumhansl-Schmuckler key profiles.
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
MAJOR_FAMILY = ((0, ''), (2, 'm'), (4, 'm'), (5, ''), (7, ''), (9, 'm'))
MINOR_FAMILY = ((0, 'm'), (3, ''), (5, 'm'), (7, 'm'), (7, ''), (8, ''), (10, ''))


def chord_templates():
    names, rows = [], []
    for root, note in enumerate(NOTES):
        for suffix, shape in SHAPES.items():
            row = np.zeros(12)
            row[[(root + step) % 12 for step in shape]] = 1
            names.append(note + suffix)
            rows.append(row / np.linalg.norm(row))
    return names, np.array(rows)


def key_bonus(chroma, amount=0.08):
    """Favors chords of the song's key, which settles major or minor when a stem barely plays the third."""
    total = chroma.sum(axis=1)
    fits = [(np.corrcoef(total, np.roll(profile, root))[0, 1], root, minor)
            for minor, profile in enumerate((MAJOR_PROFILE, MINOR_PROFILE)) for root in range(12)]
    _, root, minor = max(fits)
    family = MINOR_FAMILY if minor else MAJOR_FAMILY
    fitting = {NOTES[(root + step) % 12] + suffix for step, suffix in family}
    names, _ = chord_templates()
    return np.array([[amount if name in fitting else 0] for name in names])


def chord_path(chroma, bonus, weight=8, stay=0.985):
    """Viterbi: chords persist, so changing must beat a momentary better match."""
    names, templates = chord_templates()
    scores = templates @ (chroma / np.maximum(np.linalg.norm(chroma, axis=0, keepdims=True), 1e-6)) + bonus
    count, frames = scores.shape
    log_stay, log_move = np.log(stay), np.log((1 - stay) / (count - 1))
    best = scores[:, 0] * weight
    back = np.zeros((count, frames), dtype=int)
    for frame in range(1, frames):
        keep, move = best + log_stay, best.max() + log_move
        back[:, frame] = np.where(keep >= move, np.arange(count), best.argmax())
        best = np.maximum(keep, move) + scores[:, frame] * weight
    path = np.zeros(frames, dtype=int)
    path[-1] = best.argmax()
    for frame in range(frames - 1, 0, -1):
        path[frame - 1] = back[path[frame], frame]
    return [names[index] for index in path]


def top_notes(path, audible):
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict
    _, _, events = predict(path, ICASSP_2022_MODEL_PATH)
    kept = []
    for start, end, pitch, confidence, _ in sorted(events, key=lambda event: event[0]):
        frame = min(int(start / SECONDS), len(audible) - 1)
        if confidence < 0.4 or end - start < 0.08 or not audible[frame]:
            continue
        # Keep a note unless a higher one is already sounding when it starts.
        if not any(began <= start < ended - 0.03 and higher > pitch for began, ended, higher in kept):
            kept.append((float(start), float(end), int(pitch)))
    return [{'start': round(start, 2), 'pitch': pitch} for start, _, pitch in kept]


def analyze(stems):
    chromas, levels = {}, {}
    for name, path in stems.items():
        audio, _ = librosa.load(path, sr=RATE, mono=True)
        harmonic = librosa.effects.harmonic(audio, margin=2)
        chromas[name] = librosa.feature.chroma_cqt(y=harmonic, sr=RATE, hop_length=HOP, bins_per_octave=36)
        levels[name] = librosa.feature.rms(y=harmonic, hop_length=HOP)[0]
    frames = min(min(chroma.shape[1] for chroma in chromas.values()), min(map(len, levels.values())))
    loudest = np.max([level[:frames] for level in levels.values()], axis=0)
    floor = np.percentile(loudest, 95) * 0.03
    bonus = key_bonus(sum(chroma[:, :frames] for chroma in chromas.values()))
    result = {}
    for name, path in stems.items():
        audible = (levels[name][:frames] > loudest * BLEED_SHARE) & (levels[name][:frames] > floor)
        chords = []
        last = None
        for frame, chord in enumerate(chord_path(chromas[name][:, :frames], bonus)):
            if audible[frame] and chord != last:
                chords.append({'start': round(frame * SECONDS, 2), 'name': chord})
                last = chord
        result[name] = {'chords': chords, 'notes': top_notes(path, audible)}
    return {'stems': result}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('output')
    parser.add_argument('--stem', action='append', required=True, metavar='NAME=FILE')
    arguments = parser.parse_args()
    found = analyze(dict(item.split('=', 1) for item in arguments.stem))
    with open(arguments.output, 'w', encoding='utf-8') as file:
        json.dump(found, file)
