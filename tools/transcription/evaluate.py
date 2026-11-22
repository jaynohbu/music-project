"""Measures the Harmonic transcription against songs whose notes are known (design section 7 of
docs/repetition_aware_polyphonic_transcription_proposal.docx).

A song is rendered from the website's sampled sounds: an eight-bar progression comped with chords of two to
four notes, played four times, the third time with two bars really varied. As a separated stem would be, it is
spoiled: some notes are played so softly they are easily missed, faint stray notes outside the chord are
added (bleed), and noise. Then three ways of transcribing are compared:
  A  the notes as detected (chord-tone filter and repeat vote off),
  B  with the repeat vote,
  C  with the repeat vote and the chords.
Measured: note onset F1 (same pitch, onset within 50 ms), onset + offset F1 (offset within 20% of the note or
50 ms), event pitch-set precision and recall (notes sounding together), chord accuracy per beat (root and major or minor), how many
played bars the repeat families cover, and seconds taken.

Run inside the worker image (it has Basic Pitch):
  docker run --rm --entrypoint /opt/stems/bin/python -v $PWD/backend:/src -v $PWD/tools/transcription:/tool \
    -v $PWD/web/public/accompaniment:/sounds IMAGE /tool/evaluate.py [--seed N] [--sound 0]
"""
import argparse
import json
import os
import sys
import tempfile
import time

import numpy as np
import soundfile

sys.path.insert(0, os.environ.get('HARMONY_SOURCE', '/src'))
import analyze_harmony as h  # noqa: E402
import repeats  # noqa: E402

RATE = 22050
BEAT = 0.6  # 100 bpm.
PROGRESSION = [('C', (0, 4, 7)), ('G', (7, 11, 2)), ('Am', (9, 0, 4)), ('F', (5, 9, 0)),
               ('C', (0, 4, 7)), ('Em', (4, 7, 11)), ('F', (5, 9, 0)), ('G', (7, 11, 2))]
# (beat in the bar, length in beats, how many chord notes): a pop comping figure.
FIGURE = [(0, 1.5, 4), (1.5, 0.5, 2), (2, 1, 3), (3, 0.5, 2), (3.5, 0.5, 3)]
VARIED = [(0, 2, 4), (2, 0.5, 1), (2.5, 0.5, 1), (3, 1, 3)]
PLAYINGS = 4
LEAD_IN = 1  # Silent bars first, as a song's count-in.
SOFT_SHARE, SOFT_LEVEL = 0.15, 0.22
BLEED_PER_BAR, BLEED_LEVEL = 0.6, 0.2
NOISE_DB = -38


def voiced(tones, count, rng, low=52, high=76):
    """count chord tones, close together under high, each pitch class once."""
    pitches = sorted({high - ((high - tone) % 12) for tone in tones})
    while len(pitches) < count:
        pitches.append(pitches[len(pitches) - 3] + 12 if pitches[-1] + 12 <= high + 5 else pitches[0] - 12)
        pitches = sorted(set(pitches))
    return sorted(pitches)[-count:]


def song(rng):
    """The known notes (start, end, pitch), the chords per beat, the bars that are each passage, and the stray
    notes that are not part of it."""
    notes, chords, bleed = [], [], []
    for playing in range(PLAYINGS):
        for index, (name, tones) in enumerate(PROGRESSION):
            bar = LEAD_IN + playing * len(PROGRESSION) + index
            figure = VARIED if playing == 2 and index in (2, 5) else FIGURE
            for beat in range(4):
                chords.append((round((bar * 4 + beat) * BEAT, 3), name))
            for beat, length, count in figure:
                start = (bar * 4 + beat) * BEAT
                for pitch in voiced(tones, count, rng):
                    notes.append((round(start, 3), round(start + length * BEAT * 0.95, 3), pitch))
            if rng.random() < BLEED_PER_BAR:
                outside = [pc for pc in range(12) if pc not in tones]
                start = (bar * 4 + rng.integers(0, 8) / 2) * BEAT
                bleed.append((round(start, 3), round(start + 0.2, 3), int(60 + rng.choice(outside))))
    return notes, chords, bleed


def render(notes, bleed, sound, rng, seconds):
    library = json.load(open('/sounds/styles.json'))['samples']
    sample, sample_rate = soundfile.read(f'/sounds/sounds/{sound}.flac', dtype='float32')
    sample = sample.mean(axis=1) if sample.ndim > 1 else sample
    audio = np.zeros(int(seconds * RATE) + RATE)
    for (start, end, pitch), level in [(note, SOFT_LEVEL if rng.random() < SOFT_SHARE else 0.8 + 0.2 * rng.random()) for note in notes] + \
                                      [(note, BLEED_LEVEL) for note in bleed]:
        index = int(np.argmin([abs(p - pitch) for p in library['pitches']]))
        rate = 2 ** ((pitch - library['pitches'][index]) / 12)
        offset = int(index * library['slot'] * sample_rate)
        source = sample[offset:offset + int(library['length'] * sample_rate)]
        length = min(int((end - start + 0.08) * RATE), int(len(source) / rate * RATE / sample_rate))
        positions = np.arange(length) * rate * sample_rate / RATE
        tone = np.interp(positions, np.arange(len(source)), source)
        release = min(len(tone), int(0.08 * RATE))
        tone[-release:] *= np.linspace(1, 0, release)
        at = int(start * RATE)
        audio[at:at + len(tone)] += level * tone[:len(audio) - at]
    audio /= max(float(np.abs(audio).max()), 1e-6)
    return audio + rng.normal(0, 10 ** (NOISE_DB / 20), len(audio))


def matched(truth, found, offsets=False):
    """F1 of found notes against the truth: same pitch, onset within 50 ms (and offset close, with offsets)."""
    used, hits = set(), 0
    for start, end, pitch in truth:
        for index, (other_start, other_end, other_pitch) in enumerate(found):
            if index in used or other_pitch != pitch or abs(other_start - start) > 0.05:
                continue
            if offsets and abs(other_end - end) > max(0.05, 0.2 * (end - start)):
                continue
            used.add(index)
            hits += 1
            break
    precision, recall = hits / max(len(found), 1), hits / max(len(truth), 1)
    return round(2 * precision * recall / max(precision + recall, 1e-9), 3)


def pitch_sets(truth, found):
    """Precision and recall of the pitches sounding together at each true onset."""
    onsets = sorted({start for start, _, _ in truth})
    right = wrong = missed = 0
    for onset in onsets:
        real = {pitch for start, _, pitch in truth if abs(start - onset) < 1e-3}
        heard = {pitch for start, _, pitch in found if abs(start - onset) <= 0.05}
        right += len(real & heard)
        wrong += len(heard - real)
        missed += len(real - heard)
    return round(right / max(right + wrong, 1), 3), round(right / max(right + missed, 1), 3)


def chord_accuracy(truth, chords):
    def at(seconds):
        return repeats.chord_at(chords, seconds + 0.05)
    # Root and major or minor, as MIREX's majmin compares: Cmaj7 is C, Am7 is Am.
    def triad(name):
        match = h.CHORD_NAME.match(name or '')
        if not match or name == h.NO_CHORD:
            return None
        suffix = match.group(2)
        return h.PITCH_CLASS[match.group(1)], h.TRIAD_OF.get(suffix, 'm' if suffix.startswith('m') and not suffix.startswith('maj') else '')
    same = lambda one, two: triad(one) is not None and triad(one) == triad(two)
    return round(sum(same(at(start), name) for start, name in truth) / max(len(truth), 1), 3)


def transcribe(path, beats, variant):
    """The ensemble's notes and chords with parts of the method switched off."""
    original_tones, original_voted = h.tones_of, h.voted
    if variant in ('A', 'B'):
        h.tones_of = lambda name: None if name == h.NO_CHORD else set(range(12))
    if variant == 'A':
        h.voted = lambda notes, candidates, evidence, chords, beats, bar: (notes, chords, [], {'added': 0, 'removed': []})
    try:
        started = time.time()
        found = h.analyze({'other': path}, 'other', {'beats': beats, 'firstBar': LEAD_IN})['stems']['other']
        return found, round(time.time() - started, 1)
    finally:
        h.tones_of, h.voted = original_tones, original_voted


def main():
    global PLAYINGS
    parser = argparse.ArgumentParser()
    parser.add_argument('--seed', type=int, default=1)
    parser.add_argument('--sound', type=int, default=0)
    parser.add_argument('--playings', type=int, default=PLAYINGS)
    arguments = parser.parse_args()
    PLAYINGS = arguments.playings
    rng = np.random.default_rng(arguments.seed)
    truth, chords, bleed = song(rng)
    bars = LEAD_IN + PLAYINGS * len(PROGRESSION) + 1
    beats = [round(beat * BEAT, 3) for beat in range(bars * 4 + 1)]
    audio = render(truth, bleed, arguments.sound, rng, bars * 4 * BEAT)
    played_bars = set(range(LEAD_IN, LEAD_IN + PLAYINGS * len(PROGRESSION)))
    results = {}
    with tempfile.NamedTemporaryFile(suffix='.wav') as file:
        soundfile.write(file.name, audio, RATE)
        for variant in ('A', 'B', 'C'):
            found, seconds = transcribe(file.name, beats, variant)
            notes = [(note['start'], note['end'], note['pitch']) for note in found['notes']]
            covered = {member + step for family in found.get('repeats', []) for member in family['members'] for step in range(family['bars'])}
            precision, recall = pitch_sets(truth, notes)
            results[variant] = {
                'onset F1': matched(truth, notes), 'onset+offset F1': matched(truth, notes, offsets=True),
                'pitch-set precision': precision, 'pitch-set recall': recall,
                'chord accuracy': chord_accuracy(chords, found['chords']),
                'bars in repeats': round(len(covered & {bar - LEAD_IN for bar in played_bars}) / len(played_bars), 3),
                'added by vote': found.get('corrections', {}).get('added', 0),
                'removed by vote': len(found.get('corrections', {}).get('removed', [])), 'seconds': seconds,
            }
    print('RESULT', json.dumps({'seed': arguments.seed, 'sound': arguments.sound, 'notes': len(truth), 'bleed': len(bleed), 'results': results}))


if __name__ == '__main__':
    main()
