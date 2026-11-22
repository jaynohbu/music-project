"""Builds the live accompaniment's assets. Run by hand when styles or sounds change; the outputs are committed.

    MMA=<mma folder> SOUNDFONT=<MuseScore_General.sf3> python tools/accompaniment/build_assets.py

Needs MMA (Musical MIDI Accompaniment, GPL; only run here, never shipped), FluidSynth, ffmpeg, and for the
sound fingerprints torch, transformers and librosa. Writes:
  web/public/accompaniment/styles.json  genre groups, each style's comping rhythm per bar, the sounds' sample index
  web/public/accompaniment/sounds/<program>.flac  one note every three semitones of each sound, mono 32 kHz
  backend/accompaniment_sounds.json  a CLAP fingerprint of each sound, for choosing the one closest to a song
  backend/accompaniment_styles.json  the genre groups and each style's comping as a sixteen-step profile
"""
import glob, json, os, re, subprocess, sys, tempfile
import numpy as np, mido, soundfile as sf

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
MMA = os.environ['MMA']
SOUNDFONT = os.environ['SOUNDFONT']
OUT = os.path.join(ROOT, 'web/public/accompaniment')
RATE = 32000
PITCHES = list(range(36, 97, 3))  # Each sample covers a semitone either side.
NOTE_SECONDS, SLOT_SECONDS = 3.0, 3.5

SOUNDS = {
    24: 'Nylon guitar', 25: 'Steel guitar', 26: 'Jazz guitar', 27: 'Clean electric guitar', 28: 'Muted electric guitar',
    29: 'Overdrive guitar', 30: 'Distortion guitar',
    0: 'Grand piano', 1: 'Bright piano', 2: 'Electric grand', 3: 'Honky-tonk piano', 4: 'Electric piano 1', 5: 'Electric piano 2',
    16: 'Drawbar organ', 17: 'Percussive organ', 18: 'Rock organ', 19: 'Church organ', 48: 'Strings', 50: 'Synth strings',
    81: 'Saw lead', 89: 'Warm pad',
}
GUITARS = [24, 25, 26, 27, 28, 29, 30]
# Genre → MMA style files, guitar sounds and keyboard sounds; the song picks within its genre's group.
GROUPS = {
    'metal': (['rock-128', 'basicrock', '60srock', '50srock', 'bubblerock'], [30, 29], [18, 50, 81, 48]),
    'rock': (['basicrock', 'rock-128', 'softrock', '60srock', '50srock', 'folkrock', 'rockballad', '8beat'], [29, 27, 30, 25], [18, 4, 0, 1, 16]),
    'pop': (['8beat', 'popballad', 'softrock', 'bubblerock', 'rb', 'dsoul'], [27, 25, 28], [4, 5, 0, 89, 50]),
    'worship': (['popspiritual', 'spiritual', 'slowspiritual', 'hymn', 'popballad', 'pianoballad', 'guitarballad', 'ballad', '8beat', 'softrock'],
                [25, 27, 24], [0, 48, 89, 19, 4]),
    'ballad': (['ballad', 'popballad', 'pianoballad', 'guitarballad', 'rockballad', 'stringballad', 'rb-ballad'], [25, 24, 27], [0, 4, 48, 89]),
    'jazz': (['jazzcombo', 'swing', 'bebop', 'mellowjazz', 'modernjazz', 'jazzguitar', 'nitejazz', 'slowjazz', 'easyswing'], [26, 27], [0, 4, 5]),
    'blues': (['blues', 'slowblues', 'fastblues', 'shuffleboggie', 'countryblues', 'boggiewoggie'], [29, 27, 26], [0, 16, 18, 3]),
    'country': (['folk', 'folkballad', 'folkrock', 'countryswing', 'slowcountry', 'bluegrass', 'hillcountry', 'westernswing'], [25, 24, 27], [0, 3, 1]),
    'rnb': (['rb', 'rb-ballad', 'dsoul', 'bvfunk', 'strut'], [27, 28], [4, 5, 16, 17]),
    'electronic': (['trance', '8beat', 'bubblerock'], [28, 27, 30], [81, 89, 50, 4]),
    'latin': (['bossanova', 'samba', 'salsa', 'rhumba', 'chacha', 'mambo', 'tango', 'bolero'], [24, 25], [0, 4]),
}
SKIP = re.compile(r'(intro|end|fill|break|walk|ending)', re.I)
BARS = 8


def run_mma(text):
    with tempfile.TemporaryDirectory() as folder:
        source, midi = os.path.join(folder, 'song.mma'), os.path.join(folder, 'song.mid')
        open(source, 'w').write(text)
        subprocess.run(['python3', os.path.join(MMA, 'mma.py'), source, '-f', midi], capture_output=True, cwd=MMA)
        return mido.MidiFile(midi) if os.path.exists(midi) else None


def family(program, name):
    if program is None or name.startswith(('Drum', 'Bass', 'Walk')):
        return None
    if 24 <= program <= 31:
        return 'guitar'
    if program <= 7 or 16 <= program <= 23:
        return 'keys'
    return 'other'


def comping(groove):
    """Each family's comping over eight bars of one chord: per bar, [beat, length in beats, velocity] per stroke.
    Strummed notes are gathered into one stroke, since the player voices every chord itself."""
    midi = run_mma(f'Tempo 120\nGroove {groove}\n' + '\n'.join(f'{bar} C' for bar in range(1, BARS + 1)))
    if not midi:
        return None
    ppq = midi.ticks_per_beat
    found = {}
    span = 0
    for track in midi.tracks:
        name, program, now, starts, strokes = '', None, 0, {}, {}
        for msg in track:
            now += msg.time
            if msg.type == 'track_name':
                name = msg.name
            elif msg.type == 'program_change':
                program = msg.program
            elif msg.type == 'note_on' and msg.velocity:
                starts[msg.note] = (now, msg.velocity)
            elif msg.type in ('note_off', 'note_on') and msg.note in starts:
                start, velocity = starts.pop(msg.note)
                span = max(span, now)
                slot = round(start / (ppq / 8))
                old = strokes.get(slot)
                strokes[slot] = (min(start, old[0]) if old else start, max(now - start, old[1] if old else 0), max(velocity, old[2] if old else 0))
        kind = family(program, name)
        if not kind or not strokes:
            continue
        bars = [[] for _ in range(BARS)]
        for start, length, velocity in sorted(strokes.values()):
            bar = int(start // (ppq * 4))
            if bar < BARS:
                bars[bar].append([round(start / ppq - bar * 4, 3), round(length / ppq, 3), velocity])
        # Several tracks of a family (two guitars) are kept together.
        if kind in found:
            for bar, more in zip(found[kind], bars):
                bar.extend(more)
        else:
            found[kind] = bars
    # Strokes closer than an eighth of a beat are one stroke; notes with no length are dropped.
    for bars in found.values():
        for index, bar in enumerate(bars):
            merged = []
            for beat, length, velocity in sorted(stroke for stroke in bar if stroke[1] > 0):
                if merged and beat - merged[-1][0] < 0.125:
                    merged[-1][1], merged[-1][2] = max(merged[-1][1], length), max(merged[-1][2], velocity)
                else:
                    merged.append([beat, length, velocity])
            bars[index] = [[min(beat, 3.99), length, velocity] for beat, length, velocity in merged]
    if abs(span / ppq - BARS * 4) > 2.5:
        return None  # Not four beats to the bar.
    return found


def styles():
    result, groups = {}, {}
    for group, (files, guitars, keys) in GROUPS.items():
        names = []
        for file in files:
            for line in open(os.path.join(MMA, 'lib/stdlib', file + '.mma'), errors='ignore'):
                match = re.match(r'\s*DefGroove\s+(\S+)', line, re.I)
                if match and not SKIP.search(match.group(1)):
                    names.append(match.group(1))
        kept = []
        for name in dict.fromkeys(names):
            if name not in result:
                pattern = comping(name)
                if not pattern:
                    continue
                # A style without a guitar or keyboard part lends its other comping to both.
                any_part = pattern.get('guitar') or pattern.get('keys') or pattern.get('other')
                if not any_part:
                    continue
                result[name] = {'guitar': pattern.get('guitar') or any_part, 'keys': pattern.get('keys') or any_part}
            kept.append(name)
        groups[group] = {'styles': kept, 'guitar': guitars, 'keys': keys}
        print(group, len(kept), 'styles', flush=True)
    return result, groups


def render(notes, program, seconds):
    """notes: (start, end, pitch, velocity) in seconds. Mono at RATE."""
    midi = mido.MidiFile(ticks_per_beat=1000)
    track = mido.MidiTrack()
    midi.tracks.append(track)
    track.append(mido.MetaMessage('set_tempo', tempo=1_000_000))
    track.append(mido.Message('program_change', program=program))
    events = sorted([(s, 1, p, v) for s, e, p, v in notes] + [(e, 0, p, 0) for s, e, p, v in notes], key=lambda x: (x[0], x[1]))
    now = 0
    for time, on, pitch, velocity in events:
        tick = round(time * 1000)
        track.append(mido.Message('note_on', note=pitch, velocity=velocity, time=tick - now))
        now = tick
    with tempfile.TemporaryDirectory() as folder:
        path, wav = os.path.join(folder, 'x.mid'), os.path.join(folder, 'x.wav')
        midi.save(path)
        subprocess.run(['fluidsynth', '-ni', '-g', '0.8', '-F', wav, '-r', str(RATE), SOUNDFONT, path], capture_output=True, check=True)
        audio, _ = sf.read(wav, always_2d=True)
    audio = audio.mean(axis=1)
    size = int(seconds * RATE)
    return np.pad(audio, (0, max(0, size - len(audio))))[:size]


def samples(programs):
    os.makedirs(os.path.join(OUT, 'sounds'), exist_ok=True)
    for program in programs:
        notes = [(i * SLOT_SECONDS, i * SLOT_SECONDS + NOTE_SECONDS, pitch, 100) for i, pitch in enumerate(PITCHES)]
        audio = render(notes, program, len(PITCHES) * SLOT_SECONDS)
        audio = audio / max(np.abs(audio).max(), 1e-6) * 0.9
        path = os.path.join(OUT, 'sounds', f'{program}.flac')
        sf.write(path, audio, RATE, format='FLAC', subtype='PCM_16')
        print('sound', program, SOUNDS[program], os.path.getsize(path) // 1024, 'KB', flush=True)


def fingerprints(programs):
    """A CLAP embedding of each sound playing chords and a line, to compare a song's Harmonic stem with."""
    import torch, librosa
    from transformers import ClapModel, ClapProcessor
    model = ClapModel.from_pretrained('laion/clap-htsat-unfused').eval()
    processor = ClapProcessor.from_pretrained('laion/clap-htsat-unfused')
    chords = [[52, 59, 64, 68, 71], [57, 64, 69, 72, 76], [55, 62, 67, 71, 74], [50, 57, 62, 66, 69]]
    demo = []
    for bar, chord in enumerate(chords * 2):
        for beat in range(4):
            t = bar * 2.0 + beat * 0.5
            demo += [(t + k * 0.008, t + 0.45, pitch, 90 if beat % 2 == 0 else 70) for k, pitch in enumerate(chord)]
        demo += [(bar * 2.0 + 0.25 * i, bar * 2.0 + 0.25 * i + 0.24, 72 + [0, 2, 4, 7, 9, 7, 4, 2][i], 100) for i in range(8)]
    result = {}
    for program in programs:
        audio = render(demo, program, 16.0)
        clip = librosa.resample(audio.astype(np.float32), orig_sr=RATE, target_sr=48000)
        with torch.no_grad():
            embedding = model.get_audio_features(**processor(audio=[clip[:48000 * 10]], sampling_rate=48000, return_tensors='pt'))
        embedding = getattr(embedding, 'pooler_output', embedding)
        result[str(program)] = [round(float(x), 5) for x in torch.nn.functional.normalize(embedding, dim=-1)[0]]
        print('fingerprint', program, flush=True)
    return result


def profiles(patterns):
    """How often each style strikes on each sixteenth of the bar, per family, for matching a song's playing."""
    result = {}
    for name, families in patterns.items():
        result[name] = {}
        for kind, bars in families.items():
            steps = [0] * 16
            for bar in bars:
                for beat, _, _ in bar:
                    steps[int(round(beat * 4)) % 16] += 1
            result[name][kind] = [round(count / len(bars), 3) for count in steps]
    return result


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    programs = sorted({p for _, guitars, keys in GROUPS.values() for p in guitars + keys})
    patterns, groups = styles()
    json.dump({'version': 1, 'groups': groups, 'styles': patterns,
               'sounds': {str(p): {'name': SOUNDS[p], 'family': 'guitar' if p in GUITARS else 'keys'} for p in programs},
               'samples': {'rate': RATE, 'pitches': PITCHES, 'slot': SLOT_SECONDS, 'length': NOTE_SECONDS}},
              open(os.path.join(OUT, 'styles.json'), 'w'), separators=(',', ':'))
    json.dump({'groups': groups, 'profiles': profiles(patterns)}, open(os.path.join(ROOT, 'backend/accompaniment_styles.json'), 'w'),
              separators=(',', ':'))
    if '--no-samples' not in sys.argv:
        samples(programs)
    if '--no-fingerprints' not in sys.argv:
        json.dump(fingerprints(programs), open(os.path.join(ROOT, 'backend/accompaniment_sounds.json'), 'w'))
