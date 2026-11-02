"""Turns raw note events into one clear melody line, then into note values on a beat grid.

Events are (start, end, pitch, strength). Positions are in sixteenth notes from the first beat.
"""
import bisect
import cmath
import math

CLEAR_STRENGTH = 0.5
SHORTEST_EVENT = 0.12
SHORTEST_NOTE = 0.15
CONNECT_GAP = 1.0  # Same-pitch notes closer than this, with nothing between, become one.
STROKE_REPEAT = 0.11  # The same pitch attacked again sooner than this is one pluck flickering.
LEGATO_UNITS = 2  # A silence up to an eighth before the next note is playing style, not a written rest.
BEATS_PER_BAR = 4
BEAT_DRUMS = ('kick', 'snare', 'hihat')  # These keep time; toms and cymbals mostly mark changes.
LEAST_BACKBEAT = 16  # Fewer hits than this say little about where bars start.


def connected(line):
    joined = []
    for note in line:
        if joined and joined[-1][2] == note[2] and note[0] - joined[-1][1] <= CONNECT_GAP:
            joined[-1][1] = note[1]
        else:
            joined.append(list(note))
    return joined


def clear_line(events):
    """One voice of clear notes: the highest sounding."""
    clear = sorted(event for event in events
                   if event[3] >= CLEAR_STRENGTH and event[1] - event[0] >= SHORTEST_EVENT)
    line = []
    for start, end, pitch, _ in clear:
        if line and start < line[-1][1]:
            if pitch == line[-1][2]:
                line[-1][1] = max(line[-1][1], end)
                continue
            if pitch < line[-1][2]:
                continue
            line[-1][1] = start
        line.append([start, end, pitch])
    # Connect before dropping blips, so short repeats survive; again after, across removed blips.
    kept = [note for note in connected(line) if note[1] - note[0] >= SHORTEST_NOTE]
    return [{'start': round(start, 2), 'end': round(end, 2), 'pitch': pitch} for start, end, pitch in connected(kept)]


def struck_line(strokes):
    """One note per pluck of (start, end, pitch). Repeats stay apart, and each pluck ends the one before."""
    line = []
    for start, end, pitch in sorted(strokes):
        if line and pitch == line[-1][2] and start - line[-1][0] < STROKE_REPEAT:
            line[-1][1] = max(line[-1][1], end)
            continue
        if line:
            line[-1][1] = min(line[-1][1], start)
        line.append([start, end, pitch])
    return [{'start': round(start, 2), 'end': round(end, 2), 'pitch': pitch} for start, end, pitch in line]


def grid_position(time, beats):
    """Position in sixteenths, following the tempo between beats."""
    index = min(max(bisect.bisect_right(beats, time) - 1, 0), len(beats) - 2)
    return (index + (time - beats[index]) / (beats[index + 1] - beats[index])) * 4


def grid_shift(notes, beats):
    """How far detected notes sit from the grid, in sixteenths; note detection runs slightly early."""
    if not notes:
        return 0.0
    total = sum(cmath.exp(2j * math.pi * grid_position(note['start'], beats)) for note in notes)
    return cmath.phase(total) / (2 * math.pi)


def note_values(line, beats, every=False):
    """Snaps a line to sixteenths, giving each note a written position and length.

    A sixteenth holds one note: a later one is dropped, or with every moves to the next free sixteenth.
    """
    shift = grid_shift(line, beats)
    placed = []
    for note in line:
        unit = max(0, round(grid_position(note['start'], beats) - shift))
        end = round(grid_position(note['end'], beats) - shift)
        if placed and placed[-1][0] >= unit:
            if not every:
                continue
            unit = placed[-1][0] + 1
        placed.append((unit, end, note))
    written = []
    for index, (unit, end, note) in enumerate(placed):
        following = placed[index + 1][0] if index + 1 < len(placed) else None
        if following is not None and (end > following or following - end <= LEGATO_UNITS):
            end = following
        written.append({**note, 'unit': unit, 'length': max(1, end - unit)})
    return written


def drum_units(times, beats):
    """Snaps each drum's hit times to sixteenths, returning the hits and how far hits sit from the grid."""
    shift = grid_shift([{'start': time} for drum in BEAT_DRUMS for time in times.get(drum, [])], beats)
    hits = {(max(0, round(grid_position(time, beats) - shift)), drum) for drum, found in times.items() for time in found}
    return [{'unit': unit, 'drum': drum} for unit, drum in sorted(hits)], shift


def backbeat_scores(hits):
    """How well each first beat fits a kick on 1 and 3 and a snare on 2 and 4."""
    scores = [0] * BEATS_PER_BAR
    for hit in hits:
        if hit['unit'] % 4 == 0 and hit['drum'] in ('kick', 'snare'):
            beat = hit['unit'] // 4
            for first in range(BEATS_PER_BAR):
                strong = (beat - first) % 2 == 0
                scores[first] += 1 if strong == (hit['drum'] == 'kick') else -1
    return scores


def first_bar(notes, hits=()):
    """Which beat bars start on. Assumes four beats to a bar.

    Drums tell beats 1 and 3 from 2 and 4; low notes, which most often begin on 1, tell the rest.
    """
    weights = [0] * BEATS_PER_BAR
    for note in notes:
        if note['unit'] % 4 == 0:
            weights[note['unit'] // 4 % BEATS_PER_BAR] += note['length']
    scores = backbeat_scores(hits)
    if max(scores) - min(scores) >= LEAST_BACKBEAT:
        fitting = [first for first, score in enumerate(scores) if score * 2 > max(scores) + min(scores)]
        return max(fitting, key=lambda first: (weights[first], -first))
    return weights.index(max(weights))
