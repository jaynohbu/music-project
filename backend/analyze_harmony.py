#!/usr/bin/env python3
"""Finds chords, and clear melody lines with lengths, of stems, written as JSON. Output is approximate."""
import argparse
import json

import librosa
import numpy as np

from note_lines import clear_line

RATE = 22050
HOP = 2048
SECONDS = HOP / RATE
NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
# Triads only: separated stems rarely hold full voicings, so richer chord types were mostly guesses.
SHAPES = {'': (0, 4, 7), 'm': (0, 3, 7)}
# Quieter than this share of the loudest stem at that moment is treated as bleed from that stem.
BLEED_SHARE = 0.25
SHORTEST_CHORD = 0.75
MELODY_STEMS = ('guitar', 'piano')
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


def note_events(path):
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict
    _, _, events = predict(path, ICASSP_2022_MODEL_PATH)
    return [(float(start), float(end), int(pitch), float(strength)) for start, end, pitch, strength, _ in events]


def chord_changes(names, audible):
    """Audible chord spans, ignoring any too brief to be a real change or to read while scrolling."""
    spans = []
    for frame, name in enumerate(names):
        if not audible[frame]:
            continue
        if spans and spans[-1][2] == name and spans[-1][1] == frame:
            spans[-1][1] = frame + 1
        else:
            spans.append([frame, frame + 1, name])
    changes = []
    for start, end, name in spans:
        if (end - start) * SECONDS >= SHORTEST_CHORD and (not changes or changes[-1]['name'] != name):
            changes.append({'start': round(start * SECONDS, 2), 'name': name})
    return changes


def analyze(stems):
    chromas, levels = {}, {}
    harmonic_stems = [name for name in stems if name != 'bass']
    for name in harmonic_stems:
        audio, _ = librosa.load(stems[name], sr=RATE, mono=True)
        harmonic = librosa.effects.harmonic(audio, margin=2)
        chromas[name] = librosa.feature.chroma_cqt(y=harmonic, sr=RATE, hop_length=HOP, bins_per_octave=36)
        levels[name] = librosa.feature.rms(y=harmonic, hop_length=HOP)[0]
    frames = min(min(chroma.shape[1] for chroma in chromas.values()), min(map(len, levels.values())))
    loudest = np.max([level[:frames] for level in levels.values()], axis=0)
    floor = np.percentile(loudest, 95) * 0.03
    bonus = key_bonus(sum(chroma[:, :frames] for chroma in chromas.values()))
    result = {}
    for name in harmonic_stems:
        audible = (levels[name][:frames] > loudest * BLEED_SHARE) & (levels[name][:frames] > floor)
        notes = []
        if name in MELODY_STEMS:
            events = [event for event in note_events(stems[name])
                      if audible[min(int(event[0] / SECONDS), frames - 1)]]
            notes = clear_line(events)
        result[name] = {'chords': chord_changes(chord_path(chromas[name][:, :frames], bonus), audible), 'notes': notes}
    if 'bass' in stems:
        result['bass'] = {'chords': [], 'notes': clear_line(note_events(stems['bass']), bass=True)}
    return {'stems': result}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('output')
    parser.add_argument('--stem', action='append', required=True, metavar='NAME=FILE')
    arguments = parser.parse_args()
    found = analyze(dict(item.split('=', 1) for item in arguments.stem))
    with open(arguments.output, 'w', encoding='utf-8') as file:
        json.dump(found, file)
