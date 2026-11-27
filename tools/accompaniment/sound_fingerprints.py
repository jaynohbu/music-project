"""CLAP fingerprints for sounds made by sample_sounds.py, so a song's analysis can rank them against its Harmonic stem
(backend/accompaniment.py). Each sound plays the same chords and line build_assets.py plays the General MIDI
sounds with, from its own samples as the website and the app play them. Run in the stem image, which has the model:

    docker run --rm -v "$PWD:/repo" -w /repo <stem image> /opt/stems/bin/python tools/accompaniment/sound_fingerprints.py 200 201 …

Adds the sounds to backend/accompaniment_sounds.json, and each to every genre group of its family, in
web/public/accompaniment/styles.json and backend/accompaniment_styles.json (the analysis ranks within the group).
"""
import json, os, sys
import numpy as np, soundfile as sf

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
WEB = os.path.join(ROOT, 'web/public/accompaniment/styles.json')
library = json.load(open(WEB))
samples = library['samples']


def play(sound, notes, seconds):
    """notes: (start, end, pitch, velocity); mixed at the samples' rate, a fade at each end. A drum kit's pitch is
    the drum's slot."""
    samples = library.get('layouts', {}).get(library['sounds'][sound]['family'], library['samples'])
    audio, rate = sf.read(os.path.join(ROOT, f'web/public/accompaniment/sounds/{sound}.flac'))
    out = np.zeros(int(seconds * rate))
    for start, end, pitch, velocity in notes:
        index = min(range(len(samples['pitches'])), key=lambda i: abs(samples['pitches'][i] - pitch))
        ratio = 2 ** ((pitch - samples['pitches'][index]) / 12)
        slot = audio[int(index * samples['slot'] * rate):int((index * samples['slot'] + samples['length']) * rate)]
        size = int((end - start + 0.12) * rate)
        part = np.interp(np.arange(size) * ratio, np.arange(len(slot)), slot, right=0.0)
        part[-int(0.12 * rate):] *= np.linspace(1, 0, int(0.12 * rate))
        at = int(start * rate)
        out[at:at + size] += part[:len(out) - at] * (velocity / 127) ** 1.5
    return out, rate


def main():
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
    # A bass line over the same chords, and a rock beat (kick, snare, hi-hat eighths, a crash and a tom fill), for
    # basses and kits; ranked against the song's bass and drum stems.
    line = []
    for bar, chord in enumerate(chords * 2):
        root = chord[0] - 24
        line += [(bar * 2.0 + 0.5 * beat, bar * 2.0 + 0.5 * beat + 0.45, root + (7 if beat == 2 else 0), 100 if beat % 2 == 0 else 80) for beat in range(4)]
    beat = []
    for bar in range(8):
        t = bar * 2.0
        beat += [(t + 0.25 * i, t + 0.25 * i + 0.2, 3, 70) for i in range(8)]
        beat += [(t, t + 0.4, 0, 110), (t + 1.0, t + 1.4, 0, 100), (t + 0.5, t + 0.9, 1, 105), (t + 1.5, t + 1.9, 1, 105)]
        if bar % 4 == 0:
            beat.append((t, t + 1.5, 4, 100))
        if bar % 4 == 3:
            beat += [(t + 1.5, t + 1.7, 2, 100), (t + 1.75, t + 1.95, 2, 100)]
    demos = {'bass': line, 'drums': beat}
    sounds_path = os.path.join(ROOT, 'backend/accompaniment_sounds.json')
    fingerprints = json.load(open(sounds_path))
    for sound in sys.argv[1:]:
        audio, rate = play(sound, demos.get(library['sounds'][sound]['family'], demo), 16.0)
        clip = librosa.resample(audio.astype(np.float32) / max(np.abs(audio).max(), 1e-6) * 0.8, orig_sr=rate, target_sr=48000)
        with torch.no_grad():
            # The feature extractor is called directly: the processor's arguments differ between versions.
            embedding = model.get_audio_features(**processor.feature_extractor([clip[:48000 * 10]], sampling_rate=48000, return_tensors='pt'))
        embedding = getattr(embedding, 'pooler_output', embedding)
        fingerprints[sound] = [round(float(x), 5) for x in torch.nn.functional.normalize(embedding, dim=-1)[0]]
        print('fingerprint', sound, library['sounds'][sound]['name'], flush=True)
    json.dump(fingerprints, open(sounds_path, 'w'))
    backend_path = os.path.join(ROOT, 'backend/accompaniment_styles.json')
    backend = json.load(open(backend_path))
    for groups in (library['groups'], backend['groups']):
        for group in groups.values():
            for sound in sys.argv[1:]:
                family = library['sounds'][sound]['family']
                # The basses and kits keep the groups they were given (sample_drums.py and by hand).
                if family in ('guitar', 'keys') and int(sound) not in group[family]:
                    group[family].append(int(sound))
    json.dump(library, open(WEB, 'w'), separators=(',', ':'))
    json.dump(backend, open(backend_path, 'w'), separators=(',', ':'))


if __name__ == '__main__':
    main()
