"""Repeated passages in the ensemble's melody, found the way BLAST finds similar sequences.

Bars are the letters. A seed is a pair of bars that sound alike; it is extended a bar at a time in both
directions, crossing a weaker bar or two as BLAST's drop-off does, and the longest reach that keeps the whole
passage at least 70% alike is kept. Passages that match one another form a family (a chorus heard three
times, a riff heard eight). The clearest member of each family is copied over the others, melody and chords
both, and the second line is dropped inside every member: a repeat is played the same way, and the faint
notes under it are what the detection is least sure of.

Detection hears a repeat a little differently each time, so passages are compared on what sounds rather than
note by note: for each eighth of a bar, the pitch classes of the melody and the second line that are sounding
there. Only the melody is copied.
"""
import numpy as np

SIMILAR = 0.7
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
    """What sounds in each eighth of each bar, and how many notes start in each bar."""
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
            if 0 <= (note['unit'] - origin) // BAR < count:
                self.onsets[(note['unit'] - origin) // BAR] += 1

    def __len__(self):
        return self.count


def similarity(heard, first, second, length):
    """How alike two passages sound: shared sounding pitch classes over all (Dice), eighth by eighth."""
    one = heard.grid[first * SLOTS:(first + length) * SLOTS]
    two = heard.grid[second * SLOTS:(second + length) * SLOTS]
    total = one.sum() + two.sum()
    return 2 * float((one & two).sum()) / total if total else 0.0


def busy(heard, start, length):
    """Enough notes start in the passage to tell it apart from a held chord, and most of its bars are played:
    a passage that is mostly rests matches any other mostly made of rests."""
    onsets = heard.onsets[start:start + length]
    return onsets.sum() >= LEAST_ONSETS * length and (onsets > 0).sum() >= PLAYED * length


def alignments(bars):
    """Seeds of one bar, extended both ways while the passages stay alike and apart: (first, second, length, score)."""
    count = len(bars)
    found = {}
    for first in range(count):
        if not busy(bars, first, 1):
            continue
        for second in range(first + 1, count):
            if not busy(bars, second, 1) or similarity(bars, first, second, 1) < SIMILAR:
                continue
            start_one, start_two, length = first, second, 1
            # Forward, then backward, as BLAST does with its drop-off: a weaker bar may be crossed, and the
            # longest reach that keeps the whole passage alike is kept.
            reach = 1
            for step in range(2, LONGEST + 1):
                if start_two + step > count or start_one + step > start_two:
                    break
                if similarity(bars, start_one, start_two, step) >= SIMILAR:
                    reach = step
                elif step - reach >= DROP_OFF:
                    break
            length = reach
            back = 0
            for step in range(1, LONGEST - length + 1):
                # Extending back moves the later passage back too; the two must not overlap.
                if start_one - step < 0 or start_one + length > start_two - step:
                    break
                if similarity(bars, start_one - step, start_two - step, length + step) >= SIMILAR:
                    back = step
                elif step - back >= DROP_OFF:
                    break
            start_one, start_two, length = start_one - back, start_two - back, length + back
            # Silent bars change nothing in the comparison, so a passage never starts or ends on one.
            while length > 1 and not (bars.onsets[start_one] and bars.onsets[start_two]):
                start_one, start_two, length = start_one + 1, start_two + 1, length - 1
            while length > 1 and not (bars.onsets[start_one + length - 1] and bars.onsets[start_two + length - 1]):
                length -= 1
            if busy(bars, start_one, length) and busy(bars, start_two, length):
                key = (start_one, start_two, length)
                found[key] = similarity(bars, *key)
    return [(*key, score) for key, score in found.items()]


def families(bars):
    """Families of alike passages, longest first; a bar belongs to one family at most."""
    covered = set()
    groups = []
    for first, second, length, _ in sorted(alignments(bars), key=lambda item: (-item[2], -item[3])):
        span = lambda start: set(range(start, start + length))
        if span(first) & covered or span(second) & covered:
            continue
        # Every other place the passage comes back, not overlapping one another or an earlier family.
        members = [first]
        for start in range(len(bars) - length + 1):
            if start == first or span(start) & covered or any(abs(start - member) < length for member in members):
                continue
            if busy(bars, start, length) and similarity(bars, first, start, length) >= SIMILAR:
                members.append(start)
        if len(members) < 2:
            continue
        members.sort()
        groups.append((length, members))
        for member in members:
            covered |= span(member)
    return groups


def clearest(bars, length, members):
    """The member most like the others, then the one whose notes were heard most surely."""
    def score(member):
        alike = np.mean([similarity(bars, member, other, length) for other in members if other != member])
        sure = [note.get('sure', 0.5) for index in range(member, member + length) for _, _, note in bars.notes[index]]
        return alike + 0.5 * (np.mean(sure) if sure else 0)
    return max(members, key=score)


def unit_seconds(unit, beats):
    return float(np.interp(unit / 4, np.arange(len(beats)), beats))


def beat_of(seconds, beats):
    return float(np.interp(seconds, beats, np.arange(len(beats))))


def copy_chords(chords, beats, source, target, origin, length):
    """The chords over the target passage become the source's, moved by the bars between them."""
    def chord_at(seconds):
        current = None
        for chord in chords:
            if chord['start'] <= seconds + 1e-6:
                current = chord['name']
        return current
    start, end = unit_seconds(origin + target * BAR, beats), unit_seconds(origin + (target + length) * BAR, beats)
    source_start = unit_seconds(origin + source * BAR, beats)
    source_end = unit_seconds(origin + (source + length) * BAR, beats)
    shift = (target - source) * 4  # In beats.
    moved = [{'start': round(unit_seconds((beat_of(chord['start'], beats) + shift) * 4, beats), 2), 'name': chord['name']}
             for chord in chords if source_start < chord['start'] < source_end - 1e-6]
    opening = chord_at(source_start)
    following = chord_at(end)
    kept = [chord for chord in chords if not start <= chord['start'] < end]
    added = ([{'start': round(start, 2), 'name': opening}] if opening else []) + moved
    if following and not any(abs(chord['start'] - end) < 1e-3 for chord in kept):
        added.append({'start': round(end, 2), 'name': following})
    merged = sorted(kept + added, key=lambda chord: chord['start'])
    # A change to the chord already playing is no change.
    result = []
    for chord in merged:
        if not result or result[-1]['name'] != chord['name']:
            result.append(chord)
    return result


def unify(notes, second, chords, beats, first_bar):
    """Copies each family's clearest passage over the rest; returns notes, second line, chords and the repeats found."""
    origin = first_bar * 4
    count = max(0, (len(beats) * 4 - origin) // BAR)
    heard = Heard(notes + second, origin, count)
    bars = bar_notes(notes, origin, count)
    repeats = []
    for family, (length, members) in enumerate(families(heard)):
        source = clearest(heard, length, members)
        repeats.append({'family': family, 'bars': length, 'members': members, 'source': source})
    for repeat in repeats:
        length, source = repeat['bars'], repeat['source']
        source_notes = [note for index in range(source, source + length) for _, _, note in bars[index]]
        for target in repeat['members']:
            low, high = origin + target * BAR, origin + (target + length) * BAR
            second = [note for note in second if not low <= note['unit'] < high]
            if target == source:
                continue
            shift = (target - source) * BAR
            # Notes from before the passage stop where it starts.
            notes = [note if note['unit'] >= low or note['unit'] + note['length'] <= low else {**note, 'length': low - note['unit']}
                     for note in notes if not low <= note['unit'] < high]
            for note in source_notes:
                unit = note['unit'] + shift
                length_units = min(note['length'], high - unit)
                notes.append({**note, 'unit': unit, 'length': length_units, 'start': round(unit_seconds(unit, beats), 2),
                              'end': round(unit_seconds(unit + length_units, beats), 2)})
            chords = copy_chords(chords, beats, source, target, origin, length)
    strip = lambda line: [{key: value for key, value in note.items() if key != 'sure'} for note in line]
    notes = sorted(strip(notes), key=lambda note: note['unit'])
    second = sorted(strip(second), key=lambda note: note['unit'])
    return notes, second, chords, repeats
