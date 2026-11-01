#!/usr/bin/env python3
"""Finds chords, and clear melody lines with lengths, of stems, written as JSON. Output is approximate."""
import argparse
import json

import librosa
import numpy as np

from scipy.signal import find_peaks

from note_lines import clear_line, first_bar, note_values, struck_line

RATE = 22050
HOP = 2048
SECONDS = HOP / RATE
BEAT_HOP = 512
NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
# Triads only: separated stems rarely hold full voicings, so richer chord types were mostly guesses.
SHAPES = {'': (0, 4, 7), 'm': (0, 3, 7)}
# Quieter than this share of the loudest stem at that moment is treated as bleed from that stem.
BLEED_SHARE = 0.25
SHORTEST_CHORD = 0.75
MELODY_STEMS = ('guitar', 'piano')
FIRST_MODEL_PITCH = 21
LOWEST_BASS = 23
HIGHEST_BASS = 67
# Measured on a synthetic bass with known plucks: below this, sustained low notes flicker into false
# attacks; above it, real plucks go missing. Basic Pitch's own notes merge repeats and favor overtones.
STROKE_STRENGTH = 0.45
QUIET_STROKE = 0.05  # Attacks quieter than this share of the stem's loud level are bleed.
STROKE_GAP = 0.07
PITCH_WINDOW = 0.12  # How long after an attack its pitch is read.
LEAST_PITCH = 0.15
OVERTONE_SHARE = 0.6  # The lowest pitch this close to the strongest is the fundamental.
RING_FLOOR = 0.15
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


def bass_notes(path, beats):
    """One note per pluck: the model's onset signal says when, the lowest strong pitch just after says what."""
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict
    from basic_pitch.note_creation import model_frames_to_time
    output, _, _ = predict(path, ICASSP_2022_MODEL_PATH)
    note, onset = output['note'], output['onset']
    times = model_frames_to_time(len(note))
    audio, _ = librosa.load(path, sr=RATE, mono=True)
    level = librosa.feature.rms(y=audio, hop_length=BEAT_HOP)[0]
    quiet = np.percentile(level, 95) * QUIET_STROKE
    low, high = LOWEST_BASS - FIRST_MODEL_PITCH, HIGHEST_BASS - FIRST_MODEL_PITCH + 1
    peaks, _ = find_peaks(onset[:, low:high].max(axis=1), height=STROKE_STRENGTH,
                          distance=max(1, int(STROKE_GAP * len(times) / max(times[-1], 1e-6))))
    strokes = []
    for index, frame in enumerate(peaks):
        following = int(peaks[index + 1]) if index + 1 < len(peaks) else len(note)
        read_to = min(max(int(np.searchsorted(times, times[frame] + PITCH_WINDOW)), frame + 2), max(following, frame + 2), len(note))
        strengths = note[frame:read_to, low:high].mean(axis=0)
        if strengths.max() < LEAST_PITCH or level[min(int(times[frame] * RATE / BEAT_HOP) + 4, len(level) - 1)] <= quiet:
            continue
        pitch = low + int(np.argmax(strengths >= strengths.max() * OVERTONE_SHARE))
        silent = np.nonzero(note[frame + 2:following, pitch] < RING_FLOOR)[0]
        last = frame + 2 + int(silent[0]) if silent.size else min(following, len(note) - 1)
        strokes.append((float(times[frame]), float(times[last]), pitch + FIRST_MODEL_PITCH))
    return note_values(struck_line(strokes), beats, every=True)


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


def beat_times(stems):
    """Beats from the drums when they play enough, else from everything, extended to cover the song."""
    def onsets(path):
        audio, _ = librosa.load(path, sr=RATE, mono=True)
        return librosa.onset.onset_strength(y=audio, sr=RATE, hop_length=BEAT_HOP), len(audio) / RATE

    envelope, duration = onsets(stems['drums'])
    hits = librosa.onset.onset_detect(onset_envelope=envelope, sr=RATE, hop_length=BEAT_HOP, units='time')
    if len(hits) < duration / 4:
        envelopes = [onsets(path)[0] for path in stems.values()]
        shortest = min(map(len, envelopes))
        envelope = sum(item[:shortest] / max(np.percentile(item, 99), 1e-6) for item in envelopes)
    _, frames = librosa.beat.beat_track(onset_envelope=envelope, sr=RATE, hop_length=BEAT_HOP, tightness=100, trim=False)
    beats = librosa.frames_to_time(frames, sr=RATE, hop_length=BEAT_HOP).tolist()
    if len(beats) < 8:
        beats = [index * 0.5 for index in range(int(duration * 2) + 2)]
    # Parts before the drums enter have no beats of their own, so continue the nearest tempo.
    before = float(np.median(np.diff(beats[:8])))
    after = float(np.median(np.diff(beats[-8:])))
    while beats[0] > 0:
        beats.insert(0, beats[0] - before)
    while beats[-1] < duration + 1:
        beats.append(beats[-1] + after)
    return beats


def normalized(chroma):
    return chroma / np.maximum(np.linalg.norm(chroma, axis=0, keepdims=True), 1e-6)


def analyze(stems, only=None, grid=None):
    """Every part, or with only and the song's grid, just that part; other stems are context for its chords."""
    chromas, levels = {}, {}
    harmonic_stems = [name for name in stems if name not in ('bass', 'drums')]
    beats = grid['beats'] if grid else beat_times(stems)
    for name in [name for name in stems if name != 'drums']:
        audio, _ = librosa.load(stems[name], sr=RATE, mono=True)
        harmonic = librosa.effects.harmonic(audio, margin=2)
        chromas[name] = librosa.feature.chroma_cqt(y=harmonic, sr=RATE, hop_length=HOP, bins_per_octave=36)
        levels[name] = librosa.feature.rms(y=harmonic, hop_length=HOP)[0]
    frames = min(min(chroma.shape[1] for chroma in chromas.values()), min(map(len, levels.values())))
    loudest = np.max([levels[name][:frames] for name in harmonic_stems], axis=0)
    floor = np.percentile(loudest, 95) * 0.03
    together = sum(chromas[name][:, :frames] for name in harmonic_stems)
    bonus = key_bonus(together)
    result = {}
    for name in harmonic_stems:
        if only and name != only:
            continue
        audible = (levels[name][:frames] > loudest * BLEED_SHARE) & (levels[name][:frames] > floor)
        notes = []
        if name in MELODY_STEMS:
            events = [event for event in note_events(stems[name])
                      if audible[min(int(event[0] / SECONDS), frames - 1)]]
            notes = note_values(clear_line(events), beats)
        result[name] = {'chords': chord_changes(chord_path(chromas[name][:, :frames], bonus), audible), 'notes': notes}
    if 'bass' in stems and only in (None, 'bass'):
        # A bass mostly plays roots, so the other stems supply major or minor; it follows only the bass's sound.
        bass_chroma = normalized(chromas['bass'][:, :frames]) + normalized(together)
        audible = levels['bass'][:frames] > np.percentile(levels['bass'][:frames], 95) * 0.03
        result['bass'] = {'chords': chord_changes(chord_path(bass_chroma, bonus), audible), 'notes': bass_notes(stems['bass'], beats)}
    bar = grid['firstBar'] if grid else first_bar(result['bass']['notes'])
    return {'beats': [round(beat, 3) for beat in beats], 'firstBar': bar, 'stems': result}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('output')
    parser.add_argument('--stem', action='append', required=True, metavar='NAME=FILE')
    parser.add_argument('--only')
    parser.add_argument('--grid')
    arguments = parser.parse_args()
    grid = None
    if arguments.grid:
        with open(arguments.grid, encoding='utf-8') as file:
            grid = json.load(file)
    found = analyze(dict(item.split('=', 1) for item in arguments.stem), arguments.only, grid)
    with open(arguments.output, 'w', encoding='utf-8') as file:
        json.dump(found, file)
