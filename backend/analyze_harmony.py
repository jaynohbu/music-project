#!/usr/bin/env python3
"""Finds the song's chords and melody from its harmonic stems, and the bass and drum parts, as JSON.

The harmonic stems (other, which holds guitars, keys and the rest) are heard as one ensemble: one key, one
chord progression (bass supplies the roots), and every note the guitars and keys play that belongs to the chord
of the moment, written as chords on one staff. Output is approximate."""
import argparse
import bisect
import json
import os
import re
import sys

import librosa
import numpy as np

from scipy.signal import find_peaks

from note_lines import (BEAT_DRUMS, LEGATO_UNITS, clear_line, drum_units, first_bar, grid_position, grid_shift,
                        note_values, struck_line)
from repeats import unify

RATE = 22050
HOP = 2048
SECONDS = HOP / RATE
BEAT_HOP = 512
NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
# Names in the song's key: sharp keys write G#m, flat keys Db; C major and A minor keep the common mix above.
SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
SHARP_KEYS = {False: {2, 4, 6, 7, 9, 11}, True: {1, 4, 6, 8, 11}}
KEY_NAMES = {False: ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'],
             True: ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm']}
PITCH_CLASS = {name: index for names in (SHARP_NAMES, FLAT_NAMES) for index, name in enumerate(names)}
CHORD_NAME = re.compile(r'^([A-G][#b]?)(.*?)(?:/([A-G][#b]?))?$')
# Written where the harmonic stems fall silent for SILENCE seconds or more, and after the last chord, so the
# accompaniment stops with the song.
NO_CHORD = 'N.C.'
SILENCE = 0.6
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
# The top line guides the chords; lower notes are mostly accompaniment (arpeggios, bass doubling).
MELODY_LOWEST = 55  # G3
# The written notes: chord tones from a guitar's low E up, at most this many at once, the strongest kept.
LOWEST_CHORD_NOTE = 40
MOST_AT_ONCE = 6
# A chord's strongest note must reach this share of the median of the chords within NEIGHBOURHOOD seconds,
# and LEAST_ATTACK; its notes weaker than IN_CHORD_SHARE of that strongest are dropped.
NEIGHBOURHOOD = 4.0
ATTACK_SHARE = 0.85
LEAST_ATTACK = 0.38
IN_CHORD_SHARE = 0.7
JOIN_GAP = 0.12
CHORD_SPREAD = 0.07
# The stems this far below their loud level around that moment are resting: no chord is written, so the
# accompaniment rests too.
QUIET_DB = 20
LOCAL_SECONDS = 16
SHORTEST_CHORD_NOTE = 0.06
# A note an octave, a twelfth or two octaves above one at least as strong, sounding as it starts, is that
# note's overtone: distorted guitars especially sound them, and the detector hears them as notes.
OVERTONES = (12, 19, 24)
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
# Progression rules for the ensemble's chords (harmony version 6). Chords whose notes all sit in the key's scale
# come first; common borrowed chords and secondary dominants cost a little, anything else more, so a chord
# outside the key needs clearly stronger evidence than one inside it.
MAJOR_SCALE = (0, 2, 4, 5, 7, 9, 11)
MINOR_SCALE = (0, 2, 3, 5, 7, 8, 10, 11)  # Natural minor with the raised seventh, so V and V7 are in the key.
BORROWED = {False: {(10, ''), (10, '7'), (5, 'm'), (8, ''), (3, ''), (2, ''), (2, '7'), (4, ''), (4, '7'), (9, ''), (9, '7'), (0, '7')},
            True: {(5, ''), (0, ''), (2, ''), (2, '7'), (1, ''), (10, '7')}}
OUTSIDE_COST = {'borrowed': 0.05, 'other': 0.15}
# Log bonuses for a chord change by how the root moves, in semitones up: up a fourth (V-I, ii-V) is the
# strongest, then up a fifth (I-V, IV-I), steps and thirds; a tritone or a major/minor flip on one root is rare.
ROOT_MOTION = {5: 0.8, 7: 0.4, 2: 0.3, 10: 0.3, 3: 0.2, 4: 0.2, 8: 0.2, 9: 0.2, 1: -0.3, 11: -0.1, 6: -0.3, 0: -0.5}
RESOLUTION = 0.5  # A dominant (V or vii) going home to the tonic, or deceptively to vi.
# Chords change on the first beat of a bar or half bar; a change elsewhere costs this much (log).
OFF_BEAT_CHANGE = 2.0
WEAK_BEAT_CHANGE = 1.0
# The melody is evidence too: the share of its notes a chord holds, against half, at this weight.
MELODY_FIT = 0.15
# The third decides major or minor when the profile fits both: one this many times the other wins.
THIRD_RATIO = 2.0
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


def note_key(events):
    """The key from the notes heard, as (root, minor), or None without notes. Notes rather than the sound: a
    distorted power chord's overtones sound a major third that is not played. The Krumhansl-Schmuckler profile
    finds the key; where the third clearly says the other mode on the same root, the third wins."""
    total = np.zeros(12)
    for start, end, pitch, strength in events:
        total[pitch % 12] += (end - start) * strength
    if not total.any():
        return None
    _, root, minor = max((np.corrcoef(total, np.roll(profile, root))[0, 1], root, minor)
                         for minor, profile in enumerate((MAJOR_PROFILE, MINOR_PROFILE)) for root in range(12))
    minor_third, major_third = total[(root + 3) % 12], total[(root + 4) % 12]
    if minor and major_third > THIRD_RATIO * minor_third:
        minor = 0
    elif not minor and minor_third > THIRD_RATIO * major_third:
        minor = 1
    return root, minor


def spelling(root, minor):
    """Note names for chords in this key."""
    if (root, minor) in ((0, 0), (9, 1)):
        return NOTES
    return SHARP_NAMES if root in SHARP_KEYS[bool(minor)] else FLAT_NAMES


def key_name(root, minor):
    return KEY_NAMES[bool(minor)][root]


def spell_chord(name, names):
    """A chord name written with these note names (Abm/Eb as G#m/D#)."""
    match = CHORD_NAME.match(name)
    if not match or match[1] not in PITCH_CLASS:
        return name
    bass = f'/{names[PITCH_CLASS[match[3]]]}' if match[3] in PITCH_CLASS else ''
    return names[PITCH_CLASS[match[1]]] + match[2] + bass


def tones_of(name):
    """The pitch classes of a chord name, its slash bass included; None for no chord."""
    match = CHORD_NAME.match(name)
    if not match or match[1] not in PITCH_CLASS:
        return None
    root = PITCH_CLASS[match[1]]
    tones = {(root + step) % 12 for step in RICH_SHAPES.get(match[2], RICH_SHAPES[''])}
    if match[3] in PITCH_CLASS:
        tones.add(PITCH_CLASS[match[3]])
    return tones


def key_bonus(key, amount=0.08, shapes=SHAPES):
    """Favors chords of the song's key, which settles major or minor when a stem barely plays the third."""
    root, minor = key
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


def chord_shapes(shapes=RICH_SHAPES):
    """Root and suffix of each template, in chord_templates order."""
    return [(root, suffix) for root in range(12) for suffix in shapes]


def chord_tones(root, suffix):
    return {(root + step) % 12 for step in RICH_SHAPES[suffix]}


def key_scale(key_root, minor):
    return {(key_root + step) % 12 for step in (MINOR_SCALE if minor else MAJOR_SCALE)}


def outside_cost(chords, key_root, minor):
    """What naming each chord costs in this key: nothing inside the scale, a little for common borrowings."""
    scale = key_scale(key_root, minor)
    costs = []
    for root, suffix in chords:
        if chord_tones(root, suffix) <= scale:
            costs.append(0.0)
        elif ((root - key_root) % 12, suffix) in BORROWED[minor]:
            costs.append(OUTSIDE_COST['borrowed'])
        else:
            costs.append(OUTSIDE_COST['other'])
    return np.array(costs)[:, None]


def progression_moves(chords, key_root, minor):
    """Log bonus for each change from one chord to another, by root motion and resolution."""
    count = len(chords)
    moves = np.zeros((count, count))
    tonic, deceptive = (0, 8) if minor else (0, 9)
    for i, (from_root, _) in enumerate(chords):
        from_degree = (from_root - key_root) % 12
        for j, (to_root, _) in enumerate(chords):
            if i == j:
                continue
            to_degree = (to_root - key_root) % 12
            moves[i, j] = ROOT_MOTION[(to_root - from_root) % 12]
            if from_degree in (7, 11) and to_degree in (tonic, deceptive):
                moves[i, j] += RESOLUTION
    return moves


def change_costs(frames, beats, bar):
    """Log cost of a chord change at each frame: free on a bar's first or third beat, more elsewhere."""
    costs = np.full(frames, OFF_BEAT_CHANGE)
    for index, beat in enumerate(beats):
        frame = int(round(beat / SECONDS))
        if 0 <= frame < frames:
            cost = 0.0 if (index - bar) % 2 == 0 else WEAK_BEAT_CHANGE
            costs[max(frame - 1, 0):frame + 2] = np.minimum(costs[max(frame - 1, 0):frame + 2], cost)
    return costs


def melody_chroma(line, frames):
    """The melody's pitch classes per frame."""
    chroma = np.zeros((12, frames))
    for note in line:
        chroma[note['pitch'] % 12, int(note['start'] / SECONDS):min(int(note['end'] / SECONDS) + 1, frames)] = 1
    return chroma


def progression_path(chroma, melody, key_root, minor, beats, bar, weight=8, stay=0.985):
    """Viterbi over the key's chords: sound and melody say which chord, progression rules say which follows."""
    chords = chord_shapes()
    _, templates = chord_templates(RICH_SHAPES)
    frames = chroma.shape[1]
    sound = templates @ (chroma / np.maximum(np.linalg.norm(chroma, axis=0, keepdims=True), 1e-6))
    held = templates > 0
    sung = melody.sum(axis=0)
    fit = np.where(sung > 0, (held.astype(float) @ melody) / np.maximum(sung, 1e-6) - 0.5, 0)
    richer = np.array([[0 if suffix in SHAPES else -RICH_PENALTY] for _, suffix in chords])
    scores = (sound + MELODY_FIT * fit + richer - outside_cost(chords, key_root, minor)) * weight
    count = len(chords)
    moves = np.log((1 - stay) / (count - 1)) + progression_moves(chords, key_root, minor)
    np.fill_diagonal(moves, np.log(stay))
    changing = ~np.eye(count, dtype=bool)
    costs = change_costs(frames, beats, bar)
    best = scores[:, 0]
    back = np.zeros((count, frames), dtype=int)
    for frame in range(1, frames):
        step = best[:, None] + moves - changing * costs[frame]
        back[:, frame] = step.argmax(axis=0)
        best = step.max(axis=0) + scores[:, frame]
    path = np.zeros(frames, dtype=int)
    path[-1] = best.argmax()
    for frame in range(frames - 1, 0, -1):
        path[frame - 1] = back[path[frame], frame]
    return [chords[index] for index in path]


def chord_name(root, suffix, names=NOTES):
    return names[root] + suffix


def without_overtones(events):
    """Events less what are overtones of a stronger note sounding as they start."""
    kept = []
    for event in events:
        start, _, pitch, strength = event
        if not any(other[2] == pitch - interval and other[0] <= start + 0.05 and other[1] >= start + 0.05 and other[3] >= strength
                   for interval in OVERTONES for other in events):
            kept.append(event)
    return kept


def chord_notes(events, chords, beats):
    """The notes that matter among those belonging to the chord playing as they start, snapped to sixteenths.
    Notes starting on the same sixteenth are one chord on the staff. A chord is kept when its strongest note is
    a real attack: at least ATTACK_SHARE of the chords around it (so quiet verses keep theirs) and LEAST_ATTACK;
    inside it, notes much weaker than its strongest are dropped. Its written length is how long its notes
    sound, up to the next chord, which it reaches when the gap is a sixteenth or less."""
    starts = [chord['start'] for chord in chords]
    heard = []
    for event in events:
        start, end, pitch, _ = event
        index = bisect.bisect_right(starts, start + 0.05) - 1
        tones = tones_of(chords[index]['name']) if index >= 0 else None
        if tones and pitch >= LOWEST_CHORD_NOTE and end - start >= SHORTEST_CHORD_NOTE and pitch % 12 in tones:
            heard.append(event)
    if not heard:
        return []
    heard = joined_repeats(heard)
    shift = grid_shift([{'start': event[0]} for event in heard], beats)
    stacks = {}
    first = previous = None
    for event in sorted(heard):
        # A note starting within CHORD_SPREAD of the one before is part of its chord, as a strum spreads them,
        # up to twice that from the chord's first.
        if first is None or event[0] - previous > CHORD_SPREAD or event[0] - first > 2 * CHORD_SPREAD:
            first = event[0]
            unit = max(0, round(grid_position(first, beats) - shift))
        previous = event[0]
        stack = stacks.setdefault(unit, {})
        if event[2] not in stack or event[3] > stack[event[2]][3]:
            stack[event[2]] = event
    units = sorted(stacks)
    peaks = [max(event[3] for event in stacks[unit].values()) for unit in units]
    times = [min(event[0] for event in stacks[unit].values()) for unit in units]
    kept = []
    for index, unit in enumerate(units):
        low = bisect.bisect_left(times, times[index] - NEIGHBOURHOOD / 2)
        high = bisect.bisect_right(times, times[index] + NEIGHBOURHOOD / 2)
        if peaks[index] >= max(LEAST_ATTACK, ATTACK_SHARE * float(np.median(peaks[low:high]))):
            kept.append((unit, [event for event in stacks[unit].values() if event[3] >= IN_CHORD_SHARE * peaks[index]]))
    notes = []
    for index, (unit, stack) in enumerate(kept):
        stack = sorted(stack, key=lambda event: -event[3])[:MOST_AT_ONCE]
        end = max(round(grid_position(event[1], beats) - shift) for event in stack)
        following = kept[index + 1][0] if index + 1 < len(kept) else None
        if following is not None and (end > following or following - end <= 1):
            end = following
        for start, finish, pitch, strength in sorted(stack, key=lambda event: event[2]):
            # How surely the note was heard, for choosing the clearest of repeated passages (dropped from the result).
            notes.append({'start': round(start, 2), 'end': round(finish, 2), 'pitch': pitch, 'unit': unit,
                          'length': max(1, end - unit), 'sure': strength})
    return notes


def joined_repeats(events):
    """The same pitch starting again within JOIN_GAP of a note's end is that note held: one long note, not a new
    attack (detection splits a held note, and back-to-back repeats sound busy)."""
    joined = []
    for event in sorted(events, key=lambda event: (event[2], event[0])):
        if joined and joined[-1][2] == event[2] and event[0] <= joined[-1][1] + JOIN_GAP:
            start, end, pitch, strength = joined[-1]
            joined[-1] = (start, max(end, event[1]), pitch, max(strength, event[3]))
        else:
            joined.append(tuple(event))
    return sorted(joined)


def quiet_frames(level):
    """Frames where the stems are QUIET_DB or more below their own loud level around that moment (LOCAL_SECONDS):
    a soft intro is loud for itself, a stop in a loud riff is quiet."""
    from scipy.ndimage import percentile_filter
    local = percentile_filter(level, 95, size=max(3, int(LOCAL_SECONDS / SECONDS)), mode='nearest')
    return level < local * 10 ** (-QUIET_DB / 20)


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
    """Audible chord spans, ignoring any too brief to be a real change or to read while scrolling. A long silence
    and the end of the last chord are written as no chord."""
    spans = []
    for frame, name in enumerate(names):
        if not audible[frame]:
            continue
        if spans and spans[-1][2] == name and spans[-1][1] == frame:
            spans[-1][1] = frame + 1
        else:
            spans.append([frame, frame + 1, name])
    changes = []
    heard_until = None
    for start, end, name in spans:
        if heard_until is not None and (start - heard_until) * SECONDS >= SILENCE and changes[-1]['name'] != NO_CHORD:
            changes.append({'start': round(heard_until * SECONDS, 2), 'name': NO_CHORD})
        if (end - start) * SECONDS >= SHORTEST_CHORD and (not changes or changes[-1]['name'] != name):
            changes.append({'start': round(start * SECONDS, 2), 'name': name})
        if changes:
            heard_until = end
    if heard_until is not None and (len(names) - heard_until) * SECONDS >= SILENCE and changes[-1]['name'] != NO_CHORD:
        changes.append({'start': round(heard_until * SECONDS, 2), 'name': NO_CHORD})
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


def slash_chords(chords, bass_chroma, bass_level, frames, names=NOTES):
    """Writes the bass note under a chord (C/E) where the bass clearly plays a note other than the root."""
    audible = bass_level[:frames] > np.percentile(bass_level[:frames], 95) * 0.03
    named = []
    for index, chord in enumerate(chords):
        first = int(chord['start'] / SECONDS)
        last = int(chords[index + 1]['start'] / SECONDS) if index + 1 < len(chords) else frames
        name = chord['name']
        span = slice(first, max(first + 1, min(last, frames)))
        if name != NO_CHORD and audible[span].mean() > 0.5:
            mean = bass_chroma[:, span].mean(axis=1)
            low = int(mean.argmax())
            root = PITCH_CLASS[name[:2] if name[1:2] in ('#', 'b') else name[:1]]
            if low != root and mean[low] / max(mean.sum(), 1e-9) >= SLASH_SHARE:
                name = f'{name}/{names[low]}'
        named.append({'start': chord['start'], 'name': name})
    return named


def ensemble_part(stems, names, chromas, levels, frames, loudest, floor, beats, bar):
    """The harmonic stems heard together: one key, a chord progression that follows the key and the top line,
    and every note played that belongs to its chord."""
    import soundfile
    import tempfile
    harmony = sum(normalized(chromas[name][:, :frames]) for name in names)
    together = sum(chromas[name][:, :frames] for name in names)
    chroma = harmony + (0.6 * normalized(chromas['bass'][:, :frames]) if 'bass' in chromas else 0)
    # Rests inside the song count as silence too, for the chords; notes are read wherever anything sounds.
    audible = (loudest > floor)
    playing = audible & ~quiet_frames(loudest)
    mix = None
    for name in names:
        audio, rate = librosa.load(stems[name], sr=22050, mono=True)
        mix = audio if mix is None else mix[:len(audio)] + audio[:len(mix)]
    with tempfile.NamedTemporaryFile(suffix='.wav') as file:
        soundfile.write(file.name, mix / max(float(np.abs(mix).max()), 1e-6) * 0.95, rate)
        events = [event for event in note_events(file.name) if audible[min(int(event[0] / SECONDS), frames - 1)]]
    events = without_overtones([event for event in events if event[3] >= ENSEMBLE_STRENGTH])
    melody = clear_line([event for event in events if event[2] >= MELODY_LOWEST], ENSEMBLE_STRENGTH)
    root, minor = note_key(events) or song_key(together)
    spelled = spelling(root, minor)
    path = progression_path(chroma, melody_chroma(melody, frames), root, minor, beats, bar)
    chords = chord_changes([chord_name(*chord, spelled) for chord in path], playing)
    if 'bass' in chromas:
        chords = slash_chords(chords, chromas['bass'], levels['bass'], frames, spelled)
    # Repeated passages are written the same each time, from their clearest playing.
    notes, _, chords, found = unify(chord_notes(events, chords, beats), [], chords, beats, bar)
    return {'key': key_name(root, minor), 'chords': chords, 'notes': notes, 'second': [], 'repeats': found}


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
    result = {}
    bass = 'bass' in stems and only in (None, 'bass')
    plucks = bass_notes(stems['bass'], beats) if bass else None
    if grid:
        bar = grid['firstBar']
    else:
        bar = first_bar(plucks, drum_units(drum_times(activity), beats)[0])
        result['drums'] = drum_part(activity, beats, stems['drums'])
    # The ensemble's chords change on bars, so it needs the bar found from bass and drums.
    ensemble = ensemble_part(stems, harmonic_stems, chromas, levels, frames, loudest, floor, beats, bar) if only in (None, 'other') else None
    if only == 'other':
        # Redone alone, the ensemble is other's part on the song's grid.
        result['other'] = ensemble
    if bass:
        # A bass mostly plays roots, so the other stems supply major or minor; it follows only the bass's sound.
        # The key the ensemble's notes found is surer than the sound's, and names the chords the same way.
        key = (PITCH_CLASS[ensemble['key'].rstrip('m')], int(ensemble['key'].endswith('m'))) if ensemble else song_key(together)
        bass_chroma = normalized(chromas['bass'][:, :frames]) + normalized(together)
        audible = levels['bass'][:frames] > np.percentile(levels['bass'][:frames], 95) * 0.03
        names = spelling(*key)
        chords = chord_changes(chord_path(bass_chroma, key_bonus(key)), audible)
        result['bass'] = {'chords': [{**chord, 'name': spell_chord(chord['name'], names)} for chord in chords], 'notes': plucks}
    found = {'beats': [round(beat, 3) for beat in beats], 'firstBar': bar, 'stems': result}
    if ensemble and only is None:
        found['ensemble'] = ensemble
    return found


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('output')
    parser.add_argument('--stem', action='append', required=True, metavar='NAME=FILE')
    parser.add_argument('--only')
    parser.add_argument('--grid')
    parser.add_argument('--vocals')
    parser.add_argument('--title', default='')
    arguments = parser.parse_args()
    grid = None
    if arguments.grid:
        with open(arguments.grid, encoding='utf-8') as file:
            grid = json.load(file)
    stems = dict(item.split('=', 1) for item in arguments.stem)
    found = analyze(stems, arguments.only, grid)
    if arguments.only is None and 'other' in stems:
        # The accompaniment's choices are a bonus: the score stands without them.
        try:
            from accompaniment import choose
            heard = {**stems, **({'vocals': arguments.vocals} if arguments.vocals else {})}
            found['accompaniment'] = choose(heard, found['beats'], found['firstBar'], arguments.title)
        except Exception as error:  # noqa: BLE001
            print('Accompaniment choice failed:', error, file=sys.stderr)
    with open(arguments.output, 'w', encoding='utf-8') as file:
        json.dump(found, file)
