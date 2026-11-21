#!/usr/bin/env python3
"""Finds the song's chords and melody from its harmonic stems together, and the bass and drum parts, as JSON.

Guitar, piano and other are heard as one ensemble: one chord progression (bass supplies the roots), a
melody line (the highest clear voice) and a second line under it. Output is approximate."""
import argparse
import json
import os

import librosa
import numpy as np

from scipy.signal import find_peaks

from note_lines import BEAT_DRUMS, clear_line, drum_units, first_bar, note_values, struck_line

RATE = 22050
HOP = 2048
SECONDS = HOP / RATE
BEAT_HOP = 512
NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
# Triads for the bass part, which hears one stem. The ensemble hears every harmonic stem at once, so it can
# also name sevenths, suspensions and added notes: the inner lines it does not write as notes.
SHAPES = {'': (0, 4, 7), 'm': (0, 3, 7)}
RICH_SHAPES = {'': (0, 4, 7), 'm': (0, 3, 7), '7': (0, 4, 7, 10), 'maj7': (0, 4, 7, 11), 'm7': (0, 3, 7, 10),
               'sus2': (0, 2, 7), 'sus4': (0, 5, 7), 'add9': (0, 2, 4, 7), 'dim': (0, 3, 6), 'aug': (0, 4, 8)}
# The triad each chord type belongs to, for the key bonus; None when it fits no key family on its own.
TRIAD_OF = {'': '', 'm': 'm', '7': '', 'maj7': '', 'm7': 'm', 'add9': '', 'sus2': None, 'sus4': None, 'dim': None, 'aug': None}
# A richer chord must match this much better than a triad to be named, so plain chords stay plain.
RICH_PENALTY = 0.05
# A bass note this dominant in its chroma, other than the root, is written as a slash chord (C/E).
SLASH_SHARE = 0.35
# Missing hi-hats: a slot inside a running pattern is filled when the hi-hat band has a hit within this share
# of the slot's note length, at least HIHAT_LEVEL as strong as the hi-hats played around it.
HIHAT_FILL_SHARE = 0.12
HIHAT_LEVEL = 0.5
HIHAT_BAND = (6000, 16000)
HIHAT_HOP = 128  # About 3 ms at the drum rate; the drum model only sees 10 ms steps.
# Lower notes in the ensemble are accompaniment (arpeggios, bass doubling), not the tune.
MELODY_LOWEST = 55  # G3
# The second line, under the melody: a counter-melody or the top of the accompaniment.
SECOND_LOWEST = 48  # C3
# Several instruments together blur each note's onset, so the ensemble accepts softer notes than one stem.
ENSEMBLE_STRENGTH = 0.35
# Quieter than this share of the loudest stem at that moment is treated as bleed from that stem.
SHORTEST_CHORD = 0.75
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
# ADTOF model output, in its order, with the authors' peak thresholds.
DRUMS = ('kick', 'snare', 'tom', 'hihat', 'cymbal')
DRUM_THRESHOLDS = (0.22, 0.24, 0.32, 0.22, 0.30)
DRUM_RATE = 44100
DRUM_FRAMES = 100  # Output frames per second.
SHORTEST_HIT_GAP = 3  # Frames.


def chord_templates(shapes=SHAPES):
    names, rows = [], []
    for root, note in enumerate(NOTES):
        for suffix, shape in shapes.items():
            row = np.zeros(12)
            row[[(root + step) % 12 for step in shape]] = 1
            names.append(note + suffix)
            rows.append(row / np.linalg.norm(row))
    return names, np.array(rows)


def song_key(chroma):
    """The key whose Krumhansl-Schmuckler profile best fits the whole song, as (root, minor)."""
    total = chroma.sum(axis=1)
    fits = [(np.corrcoef(total, np.roll(profile, root))[0, 1], root, minor)
            for minor, profile in enumerate((MAJOR_PROFILE, MINOR_PROFILE)) for root in range(12)]
    _, root, minor = max(fits)
    return root, minor


def key_bonus(chroma, amount=0.08, shapes=SHAPES):
    """Favors chords of the song's key, which settles major or minor when a stem barely plays the third."""
    root, minor = song_key(chroma)
    family = MINOR_FAMILY if minor else MAJOR_FAMILY
    fitting = {NOTES[(root + step) % 12] + suffix for step, suffix in family}
    bonus = []
    for note in NOTES:
        for suffix in shapes:
            triad = TRIAD_OF.get(suffix)
            bonus.append([amount if triad is not None and note + triad in fitting else 0])
    return np.array(bonus)


def chord_path(chroma, bonus, weight=8, stay=0.985, shapes=SHAPES):
    """Viterbi: chords persist, so changing must beat a momentary better match."""
    names, templates = chord_templates(shapes)
    penalty = np.array([[0 if suffix in SHAPES else -RICH_PENALTY] for _ in NOTES for suffix in shapes])
    scores = templates @ (chroma / np.maximum(np.linalg.norm(chroma, axis=0, keepdims=True), 1e-6)) + bonus + penalty
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


def drum_activity(path):
    """Per-frame strength of each drum, from a model trained on real recordings."""
    import onnxruntime
    session = onnxruntime.InferenceSession(os.environ['DRUM_MODEL'], providers=['CPUExecutionProvider'])
    audio, _ = librosa.load(path, sr=DRUM_RATE, mono=True)
    return session.run(None, {'waveform': audio[None].astype(np.float32)})[0][0]


def drum_times(activity):
    return {drum: (find_peaks(activity[:, column], height=DRUM_THRESHOLDS[column], distance=SHORTEST_HIT_GAP)[0] / DRUM_FRAMES).tolist()
            for column, drum in enumerate(DRUMS)}


def beat_times(stems, activity):
    """Beats from what the drums play when they play enough, else from everything, extended to cover the song."""
    duration = len(activity) / DRUM_FRAMES
    times = drum_times(activity)
    if sum(len(times[drum]) for drum in BEAT_DRUMS) >= duration / 4:
        envelope = activity[:, [DRUMS.index(drum) for drum in BEAT_DRUMS]].sum(axis=1)
        _, frames = librosa.beat.beat_track(onset_envelope=envelope, sr=DRUM_FRAMES, hop_length=1, tightness=100, trim=False)
        beats = (frames / DRUM_FRAMES).tolist()
    else:
        def onsets(path):
            audio, _ = librosa.load(path, sr=RATE, mono=True)
            return librosa.onset.onset_strength(y=audio, sr=RATE, hop_length=BEAT_HOP)

        envelopes = [onsets(path) for path in stems.values()]
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


def unit_time(unit, shift, beats):
    """The song time of a sixteenth on the grid that drum_units snapped to."""
    return float(np.interp((unit + shift) / 4, np.arange(len(beats)), beats))


def hihat_band(path):
    """How sharply sound rises in the hi-hat band, about every 3 ms."""
    from scipy.signal import butter, sosfiltfilt
    audio, _ = librosa.load(path, sr=DRUM_RATE, mono=True)
    band = sosfiltfilt(butter(4, HIHAT_BAND, btype='band', fs=DRUM_RATE, output='sos'), audio)
    flux = librosa.onset.onset_strength(y=band, sr=DRUM_RATE, hop_length=HIHAT_HOP, n_fft=512)
    return librosa.frames_to_time(np.arange(len(flux)), sr=DRUM_RATE, hop_length=HIHAT_HOP), flux


def fill_hihats(hits, shift, beats, band):
    """Fills hi-hats the model missed inside a steady pattern, where the hi-hat band shows a hit in time."""
    times, flux = band
    hats = sorted(hit['unit'] for hit in hits if hit['drum'] == 'hihat')
    taken = {(hit['unit'], hit['drum']) for hit in hits}

    def peak(time, window):
        inside = (times >= time - window) & (times <= time + window)
        return float(flux[inside].max()) if inside.any() else 0.0

    added = []
    for before, after in zip(hats, hats[1:]):
        steps = [later - earlier for earlier, later in zip(hats, hats[1:]) if abs(earlier - before) <= 32 and 0 < later - earlier <= 4]
        if len(steps) < 4:
            continue
        step = max(set(steps), key=steps.count)
        gap = after - before
        # Only a slot or a few missing inside a running pattern; longer silences are the drummer resting.
        if gap <= step or gap % step or gap > step * 4:
            continue
        near = [unit for unit in hats if abs(unit - before) <= 16]
        reference = float(np.median([peak(unit_time(unit, shift, beats), 0.01) for unit in near]))
        for unit in range(before + step, after, step):
            if (unit, 'cymbal') in taken:
                continue
            time = unit_time(unit, shift, beats)
            window = HIHAT_FILL_SHARE * (unit_time(unit + step, shift, beats) - time)
            # A snare on the same sixteenth also rings in this band, so it must reach a full hi-hat's level.
            needed = reference * (1.0 if (unit, 'snare') in taken else HIHAT_LEVEL)
            if reference > 0 and peak(time, window) >= needed:
                added.append({'unit': unit, 'drum': 'hihat'})
    return sorted(hits + added, key=lambda hit: (hit['unit'], hit['drum']))


def drum_part(activity, beats, path):
    hits, shift = drum_units(drum_times(activity), beats)
    return {'chords': [], 'notes': [], 'hits': fill_hihats(hits, shift, beats, hihat_band(path))}


def slash_chords(chords, bass_chroma, bass_level, frames):
    """Writes the bass note under a chord (C/E) where the bass clearly plays a note other than the root."""
    audible = bass_level[:frames] > np.percentile(bass_level[:frames], 95) * 0.03
    named = []
    for index, chord in enumerate(chords):
        first = int(chord['start'] / SECONDS)
        last = int(chords[index + 1]['start'] / SECONDS) if index + 1 < len(chords) else frames
        name = chord['name']
        span = slice(first, max(first + 1, min(last, frames)))
        if audible[span].mean() > 0.5:
            mean = bass_chroma[:, span].mean(axis=1)
            low = int(mean.argmax())
            root = NOTES.index(name[:2] if name[1:2] in ('#', 'b') else name[:1])
            if low != root and mean[low] / max(mean.sum(), 1e-9) >= SLASH_SHARE:
                name = f'{name}/{NOTES[low]}'
        named.append({'start': chord['start'], 'name': name})
    return named


def ensemble_part(stems, names, chromas, levels, frames, loudest, floor, beats):
    """Guitar, piano and other heard together: one key, one chord progression, a melody and a second line."""
    import soundfile
    import tempfile
    harmony = sum(normalized(chromas[name][:, :frames]) for name in names)
    together = sum(chromas[name][:, :frames] for name in names)
    chroma = harmony + (0.6 * normalized(chromas['bass'][:, :frames]) if 'bass' in chromas else 0)
    audible = (loudest > floor)
    chords = chord_changes(chord_path(chroma, key_bonus(together, shapes=RICH_SHAPES), shapes=RICH_SHAPES), audible)
    if 'bass' in chromas:
        chords = slash_chords(chords, chromas['bass'], levels['bass'], frames)
    mix = None
    for name in names:
        audio, rate = librosa.load(stems[name], sr=22050, mono=True)
        mix = audio if mix is None else mix[:len(audio)] + audio[:len(mix)]
    with tempfile.NamedTemporaryFile(suffix='.wav') as file:
        soundfile.write(file.name, mix / max(float(np.abs(mix).max()), 1e-6) * 0.95, rate)
        events = [event for event in note_events(file.name) if audible[min(int(event[0] / SECONDS), frames - 1)]]
    melody = clear_line([event for event in events if event[2] >= MELODY_LOWEST], ENSEMBLE_STRENGTH)
    second = clear_line(under(melody, [event for event in events if event[2] >= SECOND_LOWEST]), ENSEMBLE_STRENGTH)
    root, minor = song_key(together)
    return {'key': f"{NOTES[root]}{'m' if minor else ''}", 'chords': chords,
            'notes': note_values(melody, beats), 'second': note_values(second, beats)}


def under(line, events):
    """Events that sound below the line at their start, or where the line is silent: what the second voice may use."""
    kept = []
    for event in events:
        above = [note['pitch'] for note in line if note['start'] <= event[0] < note['end']]
        if not above or event[2] < min(above):
            kept.append(event)
    return kept


def normalized(chroma):
    return chroma / np.maximum(np.linalg.norm(chroma, axis=0, keepdims=True), 1e-6)


def analyze(stems, only=None, grid=None):
    """Every part, or with only and the song's grid, just that part; other stems are context for its chords."""
    if only == 'drums':
        part = drum_part(drum_activity(stems['drums']), grid['beats'], stems['drums'])
        return {'beats': grid['beats'], 'firstBar': grid['firstBar'], 'stems': {'drums': part}}
    chromas, levels = {}, {}
    harmonic_stems = [name for name in stems if name not in ('bass', 'drums')]
    activity = None if grid else drum_activity(stems['drums'])
    beats = grid['beats'] if grid else beat_times(stems, activity)
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
    ensemble = ensemble_part(stems, harmonic_stems, chromas, levels, frames, loudest, floor, beats) if only is None else None
    if 'bass' in stems and only in (None, 'bass'):
        # A bass mostly plays roots, so the other stems supply major or minor; it follows only the bass's sound.
        bass_chroma = normalized(chromas['bass'][:, :frames]) + normalized(together)
        audible = levels['bass'][:frames] > np.percentile(levels['bass'][:frames], 95) * 0.03
        result['bass'] = {'chords': chord_changes(chord_path(bass_chroma, bonus), audible), 'notes': bass_notes(stems['bass'], beats)}
    if grid:
        bar = grid['firstBar']
    else:
        bar = first_bar(result['bass']['notes'], drum_units(drum_times(activity), beats)[0])
        result['drums'] = drum_part(activity, beats, stems['drums'])
    found = {'beats': [round(beat, 3) for beat in beats], 'firstBar': bar, 'stems': result}
    if ensemble:
        found['ensemble'] = ensemble
    return found


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
