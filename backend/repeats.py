"""Repeated passages in the Harmonic score, found the way BLAST finds similar sequences, and corrected by vote.

Bars are the letters. A seed is a pair of bars that sound alike; it is extended a bar at a time in both
directions, crossing a weaker bar or two as BLAST's drop-off does, and the longest reach that keeps the whole
passage at least 70% alike is kept. Passages that match one another form a family (a chorus heard three
times, a riff heard eight).

A repeat is not copied: each playing may really vary. Every note the family's playings write is put to a vote.
A note most of the other playings have is added where it is missing, if this playing's own sound has some of
it (the model hears that pitch there, if too faintly to write). A note no other playing has, not even faintly,
is dropped when it was heard weakly and there are at least three playings to tell; a clearly heard one is a
variation and stays. Chords are voted beat by beat the same way, and each playing keeps its own rests.

Detection hears a repeat a little differently each time, so passages are found on what sounds rather than
note by note: for each eighth of a bar, the pitch classes of the notes sounding there. A passage may come back
moved to another key (a riff on the fourth); such a playing must be more alike (SIMILAR_MOVED) and at least two
bars, and it is compared with the others moved back.

Before the vote, each pair of playings is lined up onset by onset with dynamic time warping, so a chord pushed
ahead or held back a little in one playing still meets its counterpart in another.
"""
import numpy as np

NO_CHORD = 'N.C.'

SIMILAR = 0.7
SIMILAR_MOVED = 0.85
BAR = 16  # Sixteenths in a bar.
SLOTS = 8  # Eighths in a bar, the grid passages are compared on.
LEAST_ONSETS = 2  # Notes that must start in each bar of a passage, on average, for it to be compared.
PLAYED = 0.75  # Share of a passage's bars that must have notes.
LONGEST = 16  # Bars a passage may reach.
DROP_OFF = 2  # Bars an extension may go without staying alike before it stops.


def bar_notes(notes, origin, count):
    """Each bar's notes as (position in the bar, pitch class, note)."""
    bars = [[] for _ in range(count)]
    for note in notes:
        index = (note['unit'] - origin) // BAR
        if 0 <= index < count:
            bars[index].append(((note['unit'] - origin) % BAR, note['pitch'] % 12, note))
    return bars


class Heard:
    """What sounds in each eighth of each bar, and on how many sixteenths notes start in each bar (a chord's
    notes start together, so a held chord counts once)."""
    def __init__(self, notes, origin, count):
        self.count = count
        self.grid = np.zeros((count * SLOTS, 12), bool)
        self.onsets = np.zeros(count, int)
        self.notes = bar_notes(notes, origin, count)
        per_slot = BAR // SLOTS
        for note in notes:
            first = (note['unit'] - origin) // per_slot
            last = max(first + 1, (note['unit'] + note['length'] - origin + per_slot - 1) // per_slot)
            self.grid[max(0, first):min(len(self.grid), last), note['pitch'] % 12] = True
        for unit in {note['unit'] for note in notes}:
            if 0 <= (unit - origin) // BAR < count:
                self.onsets[(unit - origin) // BAR] += 1

    def __len__(self):
        return self.count


def similarity(heard, first, second, length, shift=0):
    """How alike two passages sound: shared sounding pitch classes over all (Dice), eighth by eighth; with shift,
    the second moved down that many semitones first."""
    one = heard.grid[first * SLOTS:(first + length) * SLOTS]
    two = heard.grid[second * SLOTS:(second + length) * SLOTS]
    if shift:
        two = np.roll(two, -shift, axis=1)
    total = one.sum() + two.sum()
    return 2 * float((one & two).sum()) / total if total else 0.0


def alike(heard, first, second, length, shift):
    return similarity(heard, first, second, length, shift) >= (SIMILAR_MOVED if shift else SIMILAR) and (length >= 2 or not shift)


def moved(heard, first, second, length, seed=False):
    """How far the second passage is moved from the first: 0 when alike as it is, else the move that makes it
    most alike, or None. A single-bar seed may only be moved when the passage is long enough to grow."""
    if similarity(heard, first, second, length) >= SIMILAR:
        return 0
    scores = [(similarity(heard, first, second, length, shift), shift) for shift in range(1, 12)]
    score, shift = max(scores)
    return shift if score >= SIMILAR_MOVED and (length >= 2 or seed) else None


def busy(heard, start, length):
    """Enough notes start in the passage to tell it apart from a held chord, and most of its bars are played:
    a passage that is mostly rests matches any other mostly made of rests."""
    onsets = heard.onsets[start:start + length]
    return onsets.sum() >= LEAST_ONSETS * length and (onsets > 0).sum() >= PLAYED * length


def alignments(bars):
    """Seeds of one bar, extended both ways while the passages stay alike and apart: (first, second, length,
    score, shift)."""
    count = len(bars)
    found = {}
    for first in range(count):
        if not busy(bars, first, 1):
            continue
        for second in range(first + 1, count):
            if not busy(bars, second, 1):
                continue
            shift = moved(bars, first, second, 1, seed=True)
            if shift is None:
                continue
            start_one, start_two, length = first, second, 1
            # Forward, then backward, as BLAST does with its drop-off: a weaker bar may be crossed, and the
            # longest reach that keeps the whole passage alike is kept.
            reach = 1
            for step in range(2, LONGEST + 1):
                if start_two + step > count or start_one + step > start_two:
                    break
                if alike(bars, start_one, start_two, step, shift):
                    reach = step
                elif step - reach >= DROP_OFF:
                    break
            length = reach
            back = 0
            for step in range(1, LONGEST - length + 1):
                # Extending back moves the later passage back too; the two must not overlap.
                if start_one - step < 0 or start_one + length > start_two - step:
                    break
                if alike(bars, start_one - step, start_two - step, length + step, shift):
                    back = step
                elif step - back >= DROP_OFF:
                    break
            start_one, start_two, length = start_one - back, start_two - back, length + back
            # Silent bars change nothing in the comparison, so a passage never starts or ends on one.
            while length > 1 and not (bars.onsets[start_one] and bars.onsets[start_two]):
                start_one, start_two, length = start_one + 1, start_two + 1, length - 1
            while length > 1 and not (bars.onsets[start_one + length - 1] and bars.onsets[start_two + length - 1]):
                length -= 1
            if busy(bars, start_one, length) and busy(bars, start_two, length) and alike(bars, start_one, start_two, length, shift):
                key = (start_one, start_two, length, shift)
                found[key] = similarity(bars, start_one, start_two, length, shift)
    return [(*key[:3], score, key[3]) for key, score in found.items()]


def families(bars):
    """Families of alike passages, longest first, then those heard as they are before moved ones: (length,
    members, shifts), each member's move from the first. A bar belongs to one family at most."""
    covered = set()
    groups = []
    for first, second, length, _, _ in sorted(alignments(bars), key=lambda item: (-item[2], bool(item[4]), -item[3])):
        span = lambda start: set(range(start, start + length))
        if span(first) & covered or span(second) & covered:
            continue
        # Every other place the passage comes back, not overlapping one another or an earlier family.
        # The most alike first, unmoved before moved, so a near miss a bar off does not take a playing's place.
        found = []
        for start in range(len(bars) - length + 1):
            if start == first or span(start) & covered or not busy(bars, start, length):
                continue
            shift = moved(bars, first, start, length)
            if shift is not None:
                found.append((bool(shift), -similarity(bars, first, start, length, shift), start, shift))
        members, shifts = [first], [0]
        for _, _, start, shift in sorted(found):
            if all(abs(start - member) >= length for member in members):
                members.append(start)
                shifts.append(shift)
        if len(members) < 2:
            continue
        order = sorted(range(len(members)), key=lambda index: members[index])
        groups.append((length, [members[index] for index in order], [shifts[index] for index in order]))
        for member in members:
            covered |= span(member)
    return groups


def unit_seconds(unit, beats):
    return float(np.interp(unit / 4, np.arange(len(beats)), beats))


def chord_at(chords, seconds):
    current = None
    for chord in chords:
        if chord['start'] <= seconds + 1e-6:
            current = chord['name']
        else:
            break
    return current


def overridden(chords, start, end, name):
    """The chords with name playing from start to end, and what played before coming back at end."""
    following = chord_at(chords, end)
    kept = [chord for chord in chords if not start - 1e-6 <= chord['start'] < end - 1e-6]
    added = [{'start': round(start, 2), 'name': name}]
    if following and not any(abs(chord['start'] - end) < 1e-3 for chord in kept):
        added.append({'start': round(end, 2), 'name': following})
    result = []
    for chord in sorted(kept + added, key=lambda chord: chord['start']):
        if not result or result[-1]['name'] != chord['name']:
            result.append(chord)
    return result


def voted_chords(chords, beats, origin, length, members):
    """Each beat of each playing takes the chord most playings have there, when more than half agree. A beat
    with a rest in it keeps its own chords: rests belong to each playing."""
    beat_seconds = lambda member, beat: unit_seconds(origin + member * BAR + beat * 4, beats)
    for beat in range(length * 4):
        names = [chord_at(chords, beat_seconds(member, beat) + 0.05) for member in members]
        counted = {name: names.count(name) for name in names if name and name != NO_CHORD}
        if not counted:
            continue
        winner, votes = max(counted.items(), key=lambda item: item[1])
        if 2 * votes <= len(members):
            continue
        for member, name in zip(members, names):
            start, end = beat_seconds(member, beat), beat_seconds(member, beat + 1)
            rest = any(chord['name'] == NO_CHORD and start - 0.05 <= chord['start'] < end for chord in chords)
            if name != winner and name != NO_CHORD and not rest:
                chords = overridden(chords, start, end, winner)
    return chords


# A note no other playing has is dropped below this confidence (with at least three playings to tell).
KEEP_ALONE = 0.6
# How much of a pitch the model must hear where a note is missing for the vote to add it.
EVIDENCE = 0.25
NEAR = 1  # Sixteenths a note may be off in another playing and still be the same note.
# Time warping: onsets more than WARP sixteenths apart never match; an onset left unmatched costs SKIP, so two
# onsets are matched when their pitch classes share enough and they are close.
WARP = 2
SKIP = 0.6


def warped(one, two):
    """Lines up two playings' onsets (dicts of position in the passage -> pitch classes) by dynamic time warping,
    each onset matched once at most, in order. Returns where each of two's onsets falls in one."""
    first, second = sorted(one), sorted(two)
    if not first or not second:
        return {}
    def cost(a, b):
        apart = abs(first[a] - second[b])
        if apart > WARP:
            return None
        shared = len(one[first[a]] & two[second[b]]) / max(len(one[first[a]] | two[second[b]]), 1)
        return 0.25 * apart / WARP + (1 - shared)
    rows, columns = len(first) + 1, len(second) + 1
    total = np.full((rows, columns), np.inf)
    step = np.zeros((rows, columns), int)
    total[0, :] = SKIP * np.arange(columns)
    total[:, 0] = SKIP * np.arange(rows)
    step[0, 1:], step[1:, 0] = 2, 1
    for a in range(1, rows):
        for b in range(1, columns):
            options = [(total[a - 1, b] + SKIP, 1), (total[a, b - 1] + SKIP, 2)]
            matched = cost(a - 1, b - 1)
            if matched is not None:
                options.append((total[a - 1, b - 1] + matched, 0))
            total[a, b], step[a, b] = min(options)
    found = {}
    a, b = rows - 1, columns - 1
    while a and b:
        if step[a, b] == 0:
            found[second[b - 1]] = first[a - 1]
            a, b = a - 1, b - 1
        elif step[a, b] == 1:
            a -= 1
        else:
            b -= 1
    return found


def voted(notes, candidates, evidence, chords, beats, first_bar):
    """Corrects each family of repeated passages by vote; returns notes, chords, the families and what changed.
    candidates: every note heard, also those too faint to write; evidence(pitch, seconds): how much of that
    pitch the model hears there, 0 to 1."""
    origin = first_bar * 4
    count = max(0, (len(beats) * 4 - origin) // BAR)
    heard = Heard(notes, origin, count)
    repeats, added, removed = [], [], []
    notes = list(notes)
    for family, (length, members, shifts) in enumerate(families(heard)):
        repeats.append({'family': family, 'bars': length, 'members': members, 'shifts': shifts})
        span = length * BAR
        moves = dict(zip(members, shifts))
        def playing(line, member):
            low = origin + member * BAR
            return {(note['unit'] - low, note['pitch']): note for note in line if low <= note['unit'] < low + span}
        written = {member: playing(notes, member) for member in members}
        faint = {member: playing(candidates, member) for member in members}
        def onsets(member):
            found = {}
            for offset, pitch in written[member]:
                found.setdefault(offset, set()).add((pitch - moves[member]) % 12)
            return found
        has = lambda line, offset, pitch: any((offset + step, pitch) in line for step in range(-NEAR, NEAR + 1))
        for member in members:
            others = [other for other in members if other != member]
            low = origin + member * BAR
            # Every other playing as this one would play it: lined up onset by onset, moved to its key.
            mine = onsets(member)
            seen, near = {}, {}
            for other in others:
                lined = warped(mine, onsets(other))
                # The nearer way: moved up eleven semitones is moved down one.
                move = (moves[member] - moves[other] + 6) % 12 - 6
                at = lambda line: {(lined.get(offset, offset), pitch + move): note for (offset, pitch), note in line.items()}
                seen[other], near[other] = at(written[other]), at(faint[other])
            keys = sorted(set(written[member]) | {key for other in others for key in seen[other]})
            for offset, pitch in keys:
                if not 0 <= offset < span:
                    continue
                votes = sum(has(seen[other], offset, pitch) for other in others)
                if (offset, pitch) in written[member]:
                    note = written[member][(offset, pitch)]
                    if len(members) >= 3 and note.get('sure', 1) < KEEP_ALONE and not votes \
                            and not any(has(near[other], offset, pitch) for other in others):
                        notes.remove(note)
                        removed.append(note)
                        del written[member][(offset, pitch)]
                elif not has(written[member], offset, pitch) and 2 * votes > len(others):
                    seconds = unit_seconds(low + offset, beats)
                    sure = evidence(pitch, seconds)
                    if sure < EVIDENCE:
                        continue
                    like = [seen[other][key] for other in others for key in seen[other] if key[1] == pitch and abs(key[0] - offset) <= NEAR]
                    lengths = sorted(note['length'] for note in like)
                    size = min(lengths[len(lengths) // 2], span - offset)
                    note = {'start': round(seconds, 2), 'end': round(unit_seconds(low + offset + size, beats), 2), 'pitch': pitch,
                            'unit': low + offset, 'length': size, 'sure': round(sure, 2), 'voted': True}
                    velocities = sorted(other['velocity'] for other in like if 'velocity' in other)
                    if velocities:
                        note['velocity'] = velocities[len(velocities) // 2]
                    notes.append(note)
                    written[member][(offset, pitch)] = note
                    added.append(note)
        # Chords are voted among the playings in one key.
        for shift in sorted(set(shifts)):
            same = [member for member in members if moves[member] == shift]
            if len(same) >= 2:
                chords = voted_chords(chords, beats, origin, length, same)
    notes.sort(key=lambda note: (note['unit'], note['pitch']))
    return notes, chords, repeats, {'added': len(added), 'removed': [{key: note[key] for key in ('unit', 'pitch', 'length')} for note in removed]}
