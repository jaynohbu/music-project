"""Adds the drum kits and the General MIDI basses that play a song's drum and bass scores to the accompaniment library
(licences in each source's own LICENSE file: CC0, CC BY 4.0, or MIT for the General MIDI font; see
web/public/accompaniment/CREDITS.txt). Run by hand; the outputs are committed.

    SOUNDFONT=<MuseScore_General.sf3> python tools/accompaniment/sample_drums.py [cache folder] [ids…]

A kit is one hit of each drum the drum score writes (kick, snare, tom, hi-hat, cymbal: DRUMS, as the drum
transcription names them), at a strong but not loudest layer, every microphone of a multi-microphone kit mixed as
recorded, three seconds each with a quarter-second fade, in the slots the library's drum layout gives, each drum as
loud as BALANCE gives (the same in every kit); mono 32 kHz FLAC. The General MIDI kits and basses are rendered
from the font with FluidSynth (the basses on the bass layout's pitches, as sample_sounds.py lays out the sampled
ones). Writes web/public/accompaniment/sounds/<id>.flac and adds the sounds and the drum layout to styles.json.
"""
import json, os, re, subprocess, sys, tempfile
import numpy as np, soundfile as sf

from sample_sounds import CACHE as DEFAULT_CACHE, OUT, RATE, NOTE_SECONDS, SLOT_SECONDS, FADE_SECONDS, BASS_PITCHES, fetch, tree

CACHE = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CACHE
DRUMS = ['kick', 'snare', 'tom', 'hihat', 'cymbal']
# General MIDI percussion keys for each drum: bass drum 1, acoustic snare, low-mid tom, closed hi-hat, crash 1.
GM_KEYS = [36, 38, 47, 42, 49]
# Each drum's peak in every kit, as a drum set is usually mixed, so kits sampled with different microphones (or one
# very loud drum) sound alike in balance.
BALANCE = [0.9, 0.85, 0.75, 0.45, 0.55]
GM_KITS = [(128, 'Standard kit', 0), (129, 'Room kit', 8), (130, 'Power kit', 16), (131, 'Electronic kit', 24),
           (132, 'Drum machine kit', 25), (133, 'Jazz kit', 32), (134, 'Brush kit', 40)]
GM_BASSES = [(32, 'Acoustic bass'), (33, 'Finger bass'), (34, 'Picked bass'), (35, 'Fretless bass'), (36, 'Slap bass'),
             (38, 'Synth bass 1'), (39, 'Synth bass 2')]

VIRTUOSITY = r'^Samples/(?:kickmic|snaremic|oh|room|mid)/'
DRS = 'DrumGizmo/DRSKit/Samples/'
MULDJORD = 'DrumGizmo/MuldjordKit/Samples/'
# id, name, repository, branch, a pattern per drum: every file of one hit (its microphones), the layer as group `v`.
KITS = [
    (135, 'Virtuosity drums', 'sfzinstruments/virtuosity_drums', 'master', [
        VIRTUOSITY + r'kick/\w+?_kick_snoff_vl(?P<v>\d+)_rr1\.flac$',
        VIRTUOSITY + r'snare/\w+?_snare_center_vl(?P<v>\d+)\.flac$',
        VIRTUOSITY + r'ltom/\w+?_ltom_center_vl(?P<v>\d+)\.flac$',
        VIRTUOSITY + r'hh/\w+?_hh_closed_vl(?P<v>\d+)_rr1\.flac$',
        VIRTUOSITY + r'crash/\w+?_crash_crash_vl(?P<v>\d+)_rr1\.flac$']),
    (136, 'Swirly drums', 'sfzinstruments/karoryfer.swirly-drums', 'main', [
        r'^Samples/marching_kick/marching_kick_vl(?P<v>\d+)_rr1_(?:beater|reso)\.wav$',
        r'^Samples/snare_main/snare_hit_vl(?P<v>\d+)_rr1_(?:top|btm)\.wav$',
        r'^Samples/tom_floor/tom_floor_vl(?P<v>\d+)_rr1\.wav$',
        r'^Samples/hat_closed/hh_closed_vl(?P<v>\d+)_rr1\.wav$',
        r'^Samples/crash/crash_vl(?P<v>\d+)_rr1\.wav$']),
    (137, 'Big Rusty drums', 'sfzinstruments/karoryfer.big-rusty-drums', 'main', [
        r'^Samples/kick_24/kick/(?:kick|oh|sn)/k_vl(?P<v>\d+)_rr1\.flac$',
        r'^Samples/snare_14/center/(?:top|btm|oh)/sn_center_vl(?P<v>\d+)_rr1\.flac$',
        r'^Samples/tom_18/center/(?:cl|oh|sn)/t18_vl(?P<v>\d+)_rr1\.flac$',
        r'^Samples/hihat_14/tc/(?:cl|oh)/ht_tc_vl(?P<v>\d+)_rr1\.flac$',
        r'^Samples/crash_17/cr/(?:cl|oh)/cr_vl(?P<v>\d+)_rr1\.flac$']),
    (138, 'DRS kit', 'sfzinstruments/DrumGizmo.DRSKit', 'master', [
        DRS + r'Kdrum_without_contact/(?P<v>\d+)-Kdrum_without_contact-[^/]+\.flac$',
        DRS + r'Snare/(?P<v>\d+)-Snare-[^/]+\.flac$',
        DRS + r'Tom3/(?P<v>\d+)-Tom3-[^/]+\.flac$',
        DRS + r'Hihat_closed/(?P<v>\d+)-Hihat_closed-[^/]+\.flac$',
        DRS + r'Crash_right_tip/(?P<v>\d+)-Crash_right_tip-[^/]+\.flac$']),
    (139, 'Muldjord kit', 'sfzinstruments/DrumGizmo.MuldjordKit', 'master', [
        MULDJORD + r'KdrumR/(?P<v>\d+)-KdrumR-(?!Trigger)[^/]+\.flac$',
        MULDJORD + r'Snare/(?P<v>\d+)-Snare-(?!Trigger)[^/]+\.flac$',
        MULDJORD + r'Tom3/(?P<v>\d+)-Tom3-(?!Trigger)[^/]+\.flac$',
        MULDJORD + r'HihatClosed/(?P<v>\d+)-HihatClosed-(?!Trigger)[^/]+\.flac$',
        MULDJORD + r'CrashR/(?P<v>\d+)-CrashR-(?!Trigger)[^/]+\.flac$']),
    (140, 'Synthesizer percussion', 'freepats/synthesizer-percussion', 'main', [
        r'^samples/Kick04\.flac$', r'^samples/Snare09\.flac$', r'^samples/MidTom02-01\.flac$',
        r'^samples/ClosedHiHat01-01\.flac$', r'^samples/Cymbal01-01\.flac$']),
]


def fitted(audio, rate):
    """A hit at RATE, NOTE_SECONDS long with a fade at the end."""
    if rate != RATE:
        audio = np.interp(np.arange(int(len(audio) * RATE / rate)) * rate / RATE, np.arange(len(audio)), audio)
    out = np.zeros(int(NOTE_SECONDS * RATE))
    out[:min(len(out), len(audio))] = audio[:len(out)]
    fade = int(FADE_SECONDS * RATE)
    out[-fade:] *= np.linspace(1, 0, fade)
    return out


def hit(repository, branch, pattern):
    """One hit: the files of the layer three quarters of the way up (all its microphones), summed."""
    layers = {}
    for path in tree(repository, branch):
        match = re.search(pattern, path)
        if match:
            layers.setdefault(int(match.group('v')) if 'v' in match.groupdict() else 0, []).append(path)
    if not layers:
        raise SystemExit(f'{repository}: nothing matched {pattern}')
    order = sorted(layers)
    paths = layers[order[round(0.75 * (len(order) - 1))]]
    mixed = None
    for path in paths:
        audio, rate = fetch(repository, branch, path)
        one = fitted(audio, rate)
        mixed = one if mixed is None else mixed + one
    return mixed, len(paths)


def write(sound, slots, balance=None):
    if balance:
        slots = [slot / max(np.abs(slot).max(), 1e-6) * peak for slot, peak in zip(slots, balance)]
    gap = np.zeros(int((SLOT_SECONDS - NOTE_SECONDS) * RATE))
    audio = np.concatenate([np.concatenate([slot, gap]) for slot in slots])
    audio = audio / max(np.abs(audio).max(), 1e-6) * 0.9
    path = os.path.join(OUT, 'sounds', f'{sound}.flac')
    sf.write(path, audio, RATE, format='FLAC', subtype='PCM_16')
    return os.path.getsize(path) // 1024


def gm_render(program, notes, drums=False):
    """notes: (slot, key) played one per slot, from the General MIDI font; mono at RATE."""
    import mido
    midi = mido.MidiFile(ticks_per_beat=1000)
    track = mido.MidiTrack()
    midi.tracks.append(track)
    track.append(mido.MetaMessage('set_tempo', tempo=1_000_000))
    channel = 9 if drums else 0
    track.append(mido.Message('program_change', channel=channel, program=program))
    now = 0
    for slot, key in notes:
        for time, velocity in ((slot * SLOT_SECONDS, 100), (slot * SLOT_SECONDS + NOTE_SECONDS - FADE_SECONDS, 0)):
            tick = round(time * 1000)
            track.append(mido.Message('note_on', channel=channel, note=key, velocity=velocity, time=tick - now))
            now = tick
    with tempfile.TemporaryDirectory() as folder:
        path, wav = os.path.join(folder, 'x.mid'), os.path.join(folder, 'x.wav')
        midi.save(path)
        subprocess.run(['fluidsynth', '-ni', '-g', '0.8', '-F', wav, '-r', str(RATE), os.environ['SOUNDFONT'], path],
                       capture_output=True, check=True)
        audio, _ = sf.read(wav, always_2d=True)
    audio = audio.mean(axis=1)
    size = int(SLOT_SECONDS * RATE)
    slots = []
    for slot, _ in notes:
        part = audio[slot * size:slot * size + int(NOTE_SECONDS * RATE)]
        slots.append(fitted(part, RATE))
    return slots


def main():
    os.makedirs(CACHE, exist_ok=True)
    wanted = set(sys.argv[2:])
    made = []
    for sound, name, repository, branch, patterns in KITS:
        if wanted and str(sound) not in wanted:
            continue
        slots, mics = [], []
        for pattern in patterns:
            audio, count = hit(repository, branch, pattern)
            slots.append(audio)
            mics.append(count)
        print(f'kit {sound} {name}: microphones per drum {mics}, {write(sound, slots, BALANCE)} KB', flush=True)
        made.append((sound, name, 'drums'))
    if 'SOUNDFONT' in os.environ:
        for sound, name, program in GM_KITS:
            if wanted and str(sound) not in wanted:
                continue
            print(f'kit {sound} {name}: {write(sound, gm_render(program, list(enumerate(GM_KEYS)), drums=True), BALANCE)} KB', flush=True)
            made.append((sound, name, 'drums'))
        for program, name in GM_BASSES:
            if wanted and str(program) not in wanted:
                continue
            print(f'bass {program} {name}: {write(program, gm_render(program, list(enumerate(BASS_PITCHES))))} KB', flush=True)
            made.append((program, name, 'bass'))
    library_path = os.path.join(OUT, 'styles.json')
    library = json.load(open(library_path))
    for sound, name, family in made:
        library['sounds'][str(sound)] = {'name': name, 'family': family}
    layouts = library.setdefault('layouts', {})
    layouts['bass'] = {'rate': RATE, 'pitches': BASS_PITCHES, 'slot': SLOT_SECONDS, 'length': NOTE_SECONDS}
    # A kit's slots hold its drums in DRUMS order, played at their own speed (pitch i is drum i).
    layouts['drums'] = {'rate': RATE, 'pitches': list(range(len(DRUMS))), 'slot': SLOT_SECONDS, 'length': NOTE_SECONDS, 'drums': DRUMS}
    json.dump(library, open(library_path, 'w'), separators=(',', ':'))
    print('styles.json:', len(library['sounds']), 'sounds')


if __name__ == '__main__':
    main()
