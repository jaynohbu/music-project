"""Adds sounds made from free sampled instruments to the accompaniment library (licences checked in each source's own
LICENSE file: CC0 or CC BY 3.0; see web/public/accompaniment/CREDITS.txt). Run by hand; the outputs are committed.

    python tools/accompaniment/sample_sounds.py [cache folder]

For each instrument, one recorded note is taken for every pitch the library samples (every three semitones from C2):
the nearest sample at a strong but not loudest layer, retuned to the pitch by resampling (basses every three semitones from C1), three seconds long with a
quarter-second fade, all notes of a sound normalised together, mono 32 kHz FLAC, as build_assets.py makes them from
the General MIDI font. Only the samples needed are downloaded. Each sample's pitch is measured, and a library whose
note names are an octave off (some call middle C C3, others C4, or C5) is moved to match. Writes
web/public/accompaniment/sounds/<id>.flac and adds the sounds to styles.json.
"""
import json, os, re, sys, urllib.parse, urllib.request
import numpy as np, soundfile as sf

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
CACHE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, '..', '.tools', 'sounds')
OUT = os.path.join(ROOT, 'web/public/accompaniment')
RATE = 32000
PITCHES = list(range(36, 97, 3))
# Basses go down to C1 (a five-string's low B is a semitone under it) and up to C5.
BASS_PITCHES = list(range(24, 73, 3))
NOTE_SECONDS, SLOT_SECONDS, FADE_SECONDS = 3.0, 3.5, 0.25
NAMES = {'c': 0, 'c#': 1, 'db': 1, 'd': 2, 'd#': 3, 'eb': 3, 'e': 4, 'f': 5, 'f#': 6, 'gb': 6, 'g': 7, 'g#': 8, 'ab': 8,
         'a': 9, 'a#': 10, 'bb': 10, 'b': 11}

# id, name, family, repository, branch, file pattern (groups: note, octave, layer), layers to prefer in order.
# Ids from 200 keep clear of the General MIDI programs the first sounds use.
INSTRUMENTS = [
    (200, 'Salamander grand piano', 'keys', 'sfzinstruments/SalamanderGrandPiano', 'master',
     r'^Samples/([A-G]#?)(-?\d)v(\d+)\.flac$', ['11', '12', '10', '13', '9', '14', '8']),
    (201, 'Steinway B grand', 'keys', 'sgossner/VCSL', 'master',
     r'Grand Piano, Steinway B/.*JHPiano_NoSus_Close_([A-G]#?)(-?\d)_vl(\d)_rr1\.wav$', ['3', '4', '2']),
    (202, 'Yamaha upright piano', 'keys', 'sgossner/VCSL', 'master',
     r'Upright Piano, Yamaha/.*Upright1_(?:Sus_)?([A-G]#?)(-?\d)_vl(\d)_rr1\.wav$', ['3', '2', '4', '1']),
    (203, 'CP80 electric grand', 'keys', 'sfzinstruments/GregSullivan.E-Pianos', 'master',
     r'^CP80/Samples/\d+-([A-G]#?)(-?\d)-(PP|MP|F|FF)\.flac$', ['F', 'MP', 'FF']),
    (204, 'Wurlitzer electric piano', 'keys', 'sfzinstruments/GregSullivan.E-Pianos', 'master',
     r'^Wurlitzer EP200/Samples/([a-g]b?)(\d)(pp|mp|f|ff)\.flac$', ['f', 'mp', 'ff']),
    (205, 'Pianet electric piano', 'keys', 'sfzinstruments/GregSullivan.E-Pianos', 'master',
     r'^Pianet T/Samples/\d+_([A-G]#?)(-?\d)_(FF|P)\.flac$', ['FF', 'P']),
    (206, 'French harpsichord', 'keys', 'sgossner/VCSL', 'master',
     r'Harpsichord, French/.*Harpsi2_(?!Rel_)(?:[A-Za-z]+_)?([A-G]#?)(-?\d)_rr1_Main\.wav$', ['']),
    (207, 'FM piano', 'keys', 'sgossner/VCSL', 'master',
     r'TX81Z/FM Piano/.*FMPiano_([A-G]#?)(-?\d)_vl(\d)\.wav$', ['2', '3', '1']),
    (220, 'Shiny electric guitar', 'guitar', 'sfzinstruments/karoryfer.shinyguitar', 'master',
     r'^Samples/electric/([a-g]#?)(\d)_vl(\d)_rr1_2\.wav$', ['3', '4', '2', '5', '1']),
    (221, 'Shiny acoustic guitar', 'guitar', 'sfzinstruments/karoryfer.shinyguitar', 'master',
     r'^Samples/acoustic/([a-g]#?)(\d)_vl(\d)_rr1_1\.wav$', ['3', '4', '2', '5', '1']),
    (222, 'Emily electric guitar', 'guitar', 'sfzinstruments/karoryfer.emilyguitar', 'master',
     r'^notes/([a-g]#?)(\d)_(f|mf|mp|p)_rr1\.wav$', ['mf', 'f', 'mp']),
    (223, 'Green hollow-body guitar', 'guitar', 'sfzinstruments/karoryfer.black-and-green-guitars', 'main',
     r'^Samples/green/ord/twang_([a-g]#?)(\d)_(f|mf|p)_rr1\.wav$', ['mf', 'f', 'p']),
    (224, 'Black hollow-body guitar', 'guitar', 'sfzinstruments/karoryfer.black-and-green-guitars', 'main',
     r'^Samples/black/ord/twang_([a-g]#?)(\d)_(f|mf|p)_rr1\.wav$', ['mf', 'f', 'p']),
    (225, 'Spanish classical guitar', 'guitar', 'freepats/spanish-classical-guitar', 'main',
     r'^samples/([A-G]#?)(\d)\.flac$', ['']),
    (240, 'Meatbass', 'bass', 'sfzinstruments/karoryfer.meatbass', 'master',
     r'^Samples/pizz/([a-g][#b]?)(\d)_vl(\d)_rr1\.wav$', ['3', '2', '4', '1']),
    (241, 'Pastabass (fettuccine)', 'bass', 'sfzinstruments/karoryfer.pastabass', 'master',
     r'^samples/fetuccine/([a-g][#b]?)(\d)_vl(\d)_rr1\.wav$', ['3', '2', '4', '1']),
    (242, 'Pastabass (linguine)', 'bass', 'sfzinstruments/karoryfer.pastabass', 'master',
     r'^samples/linguine/([a-g][#b]?)(\d)_vl(\d)_rr1\.wav$', ['3', '2', '4', '1']),
    (243, 'Fashionbass', 'bass', 'sfzinstruments/karoryfer.fashionbass', 'master',
     r'^notes/([a-g][#b]?)(\d)_(mf|f|ff|p)_rr1\.wav$', ['mf', 'f', 'p', 'ff']),
    (244, 'Growlybass', 'bass', 'sfzinstruments/karoryfer.growlybass', 'master',
     r'^sustain/([a-g][#b]?)(\d)_(f|ff|p|pp)_rr1\.wav$', ['f', 'ff', 'p']),
    (245, 'Swagbass', 'bass', 'sfzinstruments/karoryfer.swagbass', 'master',
     r'^notes/([a-g][#b]?)(\d)_(f|fff|p)_rr1\.wav$', ['f', 'fff', 'p']),
    (246, 'Dark Black bass guitar', 'bass', 'sfzinstruments/karoryfer.black-and-blue-basses', 'main',
     r'^Samples/darkblack/reg/darkblack_([a-g][#b]?)(\d)_(f|mf|mp|p)_rr1\.wav$', ['mf', 'f', 'mp', 'p']),
    (247, 'Baby Blue bass guitar', 'bass', 'sfzinstruments/karoryfer.black-and-blue-basses', 'main',
     r'^Samples/babyblue/reg/babyblue_([a-g][#b]?)(\d)_(f|ff)_rr1\.wav$', ['f', 'ff']),
    (248, 'Big Little bass guitar', 'bass', 'sfzinstruments/karoryfer.big-little-bass', 'main',
     r'^Samples/big_little_pluck_([a-g][#b]?)(\d)_(f|p)_rr1\.wav$', ['f', 'p']),
    (249, 'Pizzicato double bass', 'bass', 'sfzinstruments/dsmolken.double-bass', 'master',
     r'^pizz/pizz_([a-g][#b]?)(\d)_(m|f|p)a\.wav$', ['m', 'f', 'p']),
    (250, 'Synth bass', 'bass', 'freepats/synth-bass-1', 'main',
     r'^samples/([A-G]#?)(\d)\.flac$', ['']),
    (251, 'Lately synth bass', 'bass', 'freepats/lately-bass', 'main',
     r'^samples/([A-G]#?)(\d)\.wav$', ['']),
]


def tree(repository, branch):
    path = os.path.join(CACHE, repository.replace('/', '_') + '.json')
    if not os.path.exists(path):
        with urllib.request.urlopen(f'https://api.github.com/repos/{repository}/git/trees/{branch}?recursive=1') as reply:
            open(path, 'wb').write(reply.read())
    return [item['path'] for item in json.load(open(path))['tree'] if item['type'] == 'blob']


def fetch(repository, branch, path):
    """A file of the repository, cached; Git LFS files through GitHub's media host."""
    local = os.path.join(CACHE, repository.replace('/', '_'), path)
    if not os.path.exists(local):
        os.makedirs(os.path.dirname(local), exist_ok=True)
        quoted = urllib.parse.quote(path)
        data = urllib.request.urlopen(f'https://raw.githubusercontent.com/{repository}/{branch}/{quoted}').read()
        if data.startswith(b'version https://git-lfs'):
            data = urllib.request.urlopen(f'https://media.githubusercontent.com/media/{repository}/{branch}/{quoted}').read()
        open(local, 'wb').write(data)
    audio, rate = sf.read(local, always_2d=True)
    return audio.mean(axis=1), rate


def measured_pitch(audio, rate):
    """The pitch of a note's steady part (MIDI, fractional), by autocorrelation over 0.1–0.6 s; None if unclear."""
    part = audio[int(0.1 * rate):int(0.6 * rate)]
    if len(part) < rate * 0.2 or np.abs(part).max() < 1e-4:
        return None
    part = part - part.mean()
    spectrum = np.fft.rfft(part, 2 * len(part))
    correlation = np.fft.irfft(spectrum * np.conj(spectrum))[:len(part)]
    low, high = int(rate / 1500), int(rate / 30)
    lag = low + int(np.argmax(correlation[low:high]))
    if correlation[lag] < 0.3 * correlation[0]:
        return None
    return 69 + 12 * np.log2(rate / lag / 440)


def note(audio, rate, shift):
    """A sample moved by `shift` semitones (resampled), NOTE_SECONDS at RATE with a fade at the end."""
    ratio = 2 ** (shift / 12) * rate / RATE
    size = int(NOTE_SECONDS * RATE)
    positions = np.arange(size) * ratio
    out = np.interp(positions, np.arange(len(audio)), audio, right=0.0)
    fade = int(FADE_SECONDS * RATE)
    out[-fade:] *= np.linspace(1, 0, fade)
    return out


def build(entry):
    sound, name, family, repository, branch, pattern, layers = entry
    found = {}
    for path in tree(repository, branch):
        match = re.search(pattern, path)
        if not match:
            continue
        groups = match.groups()
        key, octave, layer = groups[0].lower(), int(groups[1]), groups[2] if len(groups) > 2 else ''
        if layer not in layers:
            continue
        midi = 12 * (octave + 1) + NAMES[key]
        if midi not in found or layers.index(layer) < layers.index(found[midi][0]):
            found[midi] = (layer, path)
    if not found:
        raise SystemExit(f'{name}: no samples matched')
    # The library's octave numbering, from the pitches of a few of its samples.
    offsets = []
    for midi in sorted(found)[len(found) // 4::max(1, len(found) // 6)][:6]:
        pitch = measured_pitch(*fetch(repository, branch, found[midi][1]))
        if pitch is not None:
            offsets.append(round((pitch - midi) / 12) * 12)
    offset = max(set(offsets), key=offsets.count) if offsets else 0
    samples = {midi + offset: path for midi, (_, path) in found.items()}
    slots, origins = [], []
    pitches = BASS_PITCHES if family == 'bass' else PITCHES
    for pitch in pitches:
        source = min(samples, key=lambda midi: (abs(midi - pitch), midi < pitch))
        audio, rate = fetch(repository, branch, samples[source])
        slots.append(note(audio, rate, pitch - source))
        origins.append(f'{pitch}<-{source}')
    gap = np.zeros(int((SLOT_SECONDS - NOTE_SECONDS) * RATE))
    audio = np.concatenate([np.concatenate([slot, gap]) for slot in slots])
    audio = audio / max(np.abs(audio).max(), 1e-6) * 0.9
    path = os.path.join(OUT, 'sounds', f'{sound}.flac')
    sf.write(path, audio, RATE, format='FLAC', subtype='PCM_16')
    print(f'sound {sound} {name}: {len(samples)} samples, octave offset {offset:+d} (measured {offsets}), '
          f'{os.path.getsize(path) // 1024} KB; widest move {max(abs(p - s) for p, s in zip(pitches, [min(samples, key=lambda m: (abs(m - p), m < p)) for p in pitches]))} semitones',
          flush=True)
    return sound, name, family


def main():
    os.makedirs(CACHE, exist_ok=True)
    made = [build(entry) for entry in INSTRUMENTS if len(sys.argv) < 3 or str(entry[0]) in sys.argv[2:]]
    library_path = os.path.join(OUT, 'styles.json')
    library = json.load(open(library_path))
    for sound, name, family in made:
        library['sounds'][str(sound)] = {'name': name, 'family': family}
    # The basses' notes are laid out on their own pitches (the guitars and keys keep the library's `samples`).
    library.setdefault('layouts', {})['bass'] = {'rate': RATE, 'pitches': BASS_PITCHES, 'slot': SLOT_SECONDS, 'length': NOTE_SECONDS}
    json.dump(library, open(library_path, 'w'), separators=(',', ':'))
    print('styles.json:', len(library['sounds']), 'sounds')


if __name__ == '__main__':
    main()
