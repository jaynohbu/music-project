"""Chooses a song's live accompaniment: its genre, then within that genre's group the comping styles closest to
how the Harmonic stem is played and the sounds closest to how it sounds.

The players play the chords and melody of the score themselves (web/src/accompaniment.ts); this only ranks.
Genre and sound use CLAP (LAION, Apache 2.0): audio is compared with sentences per genre, and with a
fingerprint of each sound (backend/accompaniment_sounds.json, made by tools/accompaniment/build_assets.py).
Sound alone hardly tells worship from pop, so a title with sacred words counts too.
"""
import json
import os

import librosa
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RATE = 48000
CLIP = 10  # Seconds per clip CLAP hears.
MODEL = 'laion/clap-htsat-unfused'
GENRES = {
    'metal': ['heavy metal music with heavily distorted guitars and aggressive drums', 'a thrash metal song', 'hard rock with crunchy power chords'],
    'rock': ['a rock song with electric guitars, bass and drums', 'classic rock music', 'alternative rock with a band'],
    'pop': ['a modern pop song', 'catchy mainstream pop music with a singer', 'pop rock radio hit'],
    'worship': ['contemporary christian worship music', 'a praise and worship song sung in church', 'an uplifting gospel worship anthem'],
    'ballad': ['a slow emotional ballad', 'a gentle love song ballad with piano', 'a soft acoustic ballad'],
    'jazz': ['jazz music with swing rhythm', 'a jazz combo with saxophone and piano', 'smooth jazz'],
    'blues': ['a blues song with a shuffle', 'electric blues guitar music'],
    'country': ['country music with acoustic guitar', 'an american folk song', 'bluegrass and country'],
    'rnb': ['rhythm and blues soul music', 'a funk groove with slap bass', 'neo soul r&b song'],
    'electronic': ['electronic dance music with synthesizers', 'a techno or house track', 'synth pop with drum machines'],
    'latin': ['latin music with salsa rhythm', 'bossa nova', 'reggaeton and latin pop'],
}
SACRED = ['god', 'lord', 'jesus', 'christ', 'praise', 'hallelujah', 'alleluia', 'worship', 'holy', 'savior', 'saviour', 'glory',
          '하나님', '주님', '예수', '찬양', '할렐루야', '거룩', '구주', '영광']


def load_clap():
    import torch
    from transformers import ClapModel, ClapProcessor
    return torch, ClapModel.from_pretrained(MODEL).eval(), ClapProcessor.from_pretrained(MODEL)


def unit(vectors):
    return vectors / np.maximum(np.linalg.norm(vectors, axis=-1, keepdims=True), 1e-9)


def audio_embedding(clap, clips):
    torch, model, processor = clap
    with torch.no_grad():
        # The feature extractor and tokenizer are called directly: the processor's arguments differ between versions.
        embedding = model.get_audio_features(**processor.feature_extractor(clips, sampling_rate=RATE, return_tensors='pt'))
    return unit(getattr(embedding, 'pooler_output', embedding).numpy())


def text_embedding(clap, texts):
    torch, model, processor = clap
    with torch.no_grad():
        embedding = model.get_text_features(**processor.tokenizer(texts, return_tensors='pt', padding=True))
    return unit(getattr(embedding, 'pooler_output', embedding).numpy())


def clips(audio, count=12):
    """Up to count ten-second clips spread over the song, skipping silence."""
    size = CLIP * RATE
    if len(audio) <= size:
        return [audio]
    starts = np.linspace(0, len(audio) - size, count).astype(int)
    taken = [audio[start:start + size] for start in starts]
    loud = [clip for clip in taken if np.sqrt(np.mean(clip ** 2)) > 0.01]
    return loud or taken


def genre_scores(clap, mix, title=''):
    heard = audio_embedding(clap, clips(mix)).mean(axis=0)
    scores = {group: float((text_embedding(clap, sentences) @ heard).mean()) for group, sentences in GENRES.items()}
    words = (title or '').lower()
    if sum(words.count(term) for term in SACRED):
        scores['worship'] += 0.05
    return sorted(scores.items(), key=lambda item: -item[1])


def playing(path, beats, first_bar):
    """How the Harmonic stem is played: its onset strength on each sixteenth of the bar, averaged over the song."""
    audio, rate = librosa.load(path, sr=22050, mono=True)
    hop = 256
    onset = librosa.onset.onset_strength(y=audio, sr=rate, hop_length=hop)
    steps = np.zeros(16)
    bars = (len(beats) - first_bar) // 4
    for bar in range(bars):
        for step in range(16):
            position = first_bar + bar * 4 + step / 4
            frame = int(np.interp(position, np.arange(len(beats)), beats) * rate / hop)
            if frame + 2 < len(onset):
                steps[step] += onset[max(0, frame - 2):frame + 3].max()
    return steps / max(steps.max(), 1e-9)


def rank_styles(names, profiles, target, family):
    scored = []
    for name in names:
        steps = np.array(profiles.get(name, {}).get(family) or [])
        if steps.size and steps.max() > 0:
            scored.append((float(np.abs(steps / steps.max() - target).sum()), name))
    return [name for _, name in sorted(scored)]


def choose(stems, beats, first_bar, title=''):
    """stems: other (Harmonic), and for the genre the bass, drums and vocals when given."""
    styles = json.load(open(os.path.join(HERE, 'accompaniment_styles.json')))
    fingerprints = json.load(open(os.path.join(HERE, 'accompaniment_sounds.json')))
    clap = load_clap()
    other, _ = librosa.load(stems['other'], sr=RATE, mono=True)
    mix = other.copy()
    for name in ('bass', 'drums', 'vocals'):
        if name in stems:
            audio, _ = librosa.load(stems[name], sr=RATE, mono=True)
            size = min(len(mix), len(audio))
            mix = mix[:size] + audio[:size]
    genres = genre_scores(clap, mix, title)
    group = styles['groups'][genres[0][0]]
    heard = audio_embedding(clap, clips(other, 8)).mean(axis=0)
    target = playing(stems['other'], beats, first_bar)
    result = {'genre': genres[0][0], 'genres': [[name, round(score, 3)] for name, score in genres[:4]]}
    nearest = {}
    for family in ('guitar', 'keys'):
        sounds = sorted(group[family], key=lambda program: -float(np.array(fingerprints[str(program)]) @ heard))
        result[family] = {'styles': rank_styles(group['styles'], styles['profiles'], target, family), 'sounds': sounds}
        nearest[family] = float(np.array(fingerprints[str(sounds[0])]) @ heard) if sounds else -1.0
    # The family whose closest sound is nearer the stem: what a part playing the score starts with.
    result['closest'] = max(nearest, key=nearest.get)
    return result
