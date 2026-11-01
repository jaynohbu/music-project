"""Turns raw note events into one clear melody line. Events are (start, end, pitch, strength)."""

STRUM_SPREAD = 0.09  # A strummed or struck chord starts within this many seconds.
STRUM_PITCHES = 3
STRUM_HITS = 3  # This many chord hits inside STRUM_WINDOW seconds means strumming, not one stray chord.
STRUM_WINDOW = 4.0
STRUM_LINK = 2.5  # Strummed hits this close belong to one blank passage.
CLEAR_STRENGTH = 0.5
CLEAR_BASS_STRENGTH = 0.35  # Basic Pitch rates low notes weaker; 0.5 missed most of a known bass line.
SHORTEST_EVENT = 0.12
SHORTEST_NOTE = 0.15
CONNECT_GAP = 1.0  # Same-pitch notes closer than this, with nothing between, become one.
HIGHEST_BASS = 67


def strum_regions(events):
    """Where several pitches keep starting together, so there is no single melody to write."""
    ordered = sorted(events)
    hits = []
    index = 0
    while index < len(ordered):
        group = [ordered[index]]
        while index + len(group) < len(ordered) and ordered[index + len(group)][0] - group[0][0] <= STRUM_SPREAD:
            group.append(ordered[index + len(group)])
        if len({event[2] for event in group}) >= STRUM_PITCHES:
            hits.append((group[0][0], max(event[1] for event in group)))
        index += len(group)
    strummed = set()
    for first in range(len(hits)):
        last = first + STRUM_HITS - 1
        if last < len(hits) and hits[last][0] - hits[first][0] <= STRUM_WINDOW:
            strummed.update(range(first, last + 1))
    regions = []
    for start, end in (hits[index] for index in sorted(strummed)):
        if regions and start - regions[-1][1] <= STRUM_LINK:
            regions[-1][1] = max(regions[-1][1], end)
        else:
            regions.append([start, end])
    return regions


def connected(line):
    joined = []
    for note in line:
        if joined and joined[-1][2] == note[2] and note[0] - joined[-1][1] <= CONNECT_GAP:
            joined[-1][1] = note[1]
        else:
            joined.append(list(note))
    return joined


def clear_line(events, bass=False):
    """One voice of clear notes: the highest sounding, or the lowest for bass."""
    regions = [] if bass else strum_regions(events)
    strength = CLEAR_BASS_STRENGTH if bass else CLEAR_STRENGTH
    clear = sorted(event for event in events
                   if event[3] >= strength and event[1] - event[0] >= SHORTEST_EVENT
                   and not any(start <= event[0] <= end for start, end in regions)
                   and (not bass or event[2] <= HIGHEST_BASS))
    line = []
    for start, end, pitch, _ in clear:
        if line and start < line[-1][1]:
            if pitch == line[-1][2]:
                line[-1][1] = max(line[-1][1], end)
                continue
            if not (pitch < line[-1][2] if bass else pitch > line[-1][2]):
                continue
            line[-1][1] = start
        line.append([start, end, pitch])
    if bass:
        # A short note an octave from its neighbor is an overtone of that neighbor.
        for index, note in enumerate(line):
            for other in line[max(0, index - 1):index] + line[index + 1:index + 2]:
                if abs(note[2] - other[2]) == 12 and note[1] - note[0] < other[1] - other[0] and \
                        max(note[0], other[0]) - min(note[1], other[1]) <= CONNECT_GAP:
                    note[2] = other[2]
                    break
    # Connect before dropping blips, so short repeats survive; again after, across removed blips.
    kept = [note for note in connected(line) if note[1] - note[0] >= SHORTEST_NOTE]
    return [{'start': round(start, 2), 'end': round(end, 2), 'pitch': pitch} for start, end, pitch in connected(kept)]
