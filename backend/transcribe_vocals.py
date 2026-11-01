#!/usr/bin/env python3
"""Transcribe a separated vocal stem into timed words, written as JSON."""
import argparse
import json
import re

import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

RATE = 16000
HOP_SECONDS = 0.05
# Whisper invents these credits from its subtitle training data, mostly over sustained notes.
INVENTED = re.compile(r'©|\btranscri|\bsubtitle|\bcaptions?\b|thanks? (you )?for watching', re.IGNORECASE)


def sung_regions(audio, max_gap=1.5, min_length=0.4, pad=0.3):
    """Finds where the stem has sound. Silero VAD rejects singing, but a vocal stem is quiet elsewhere."""
    hop = int(HOP_SECONDS * RATE)
    count = len(audio) // hop
    if not count:
        return []
    levels = np.sqrt(np.mean(audio[:count * hop].reshape(count, hop) ** 2, axis=1))
    decibels = 20 * np.log10(np.maximum(levels, 1e-7))
    threshold = float(np.clip(np.percentile(decibels, 95) - 25, -55, -40))
    regions = []
    start = None
    for index, voiced in enumerate(np.append(decibels > threshold, False)):
        if voiced and start is None:
            start = index
        elif not voiced and start is not None:
            begin, end = start * HOP_SECONDS, index * HOP_SECONDS
            if regions and begin - regions[-1][1] <= max_gap:
                regions[-1][1] = end
            else:
                regions.append([begin, end])
            start = None
    duration = count * HOP_SECONDS
    return [[max(0, begin - pad), min(duration, end + pad)]
            for begin, end in regions if end - begin >= min_length]


def transcribe(source, threads):
    audio = decode_audio(source, sampling_rate=RATE)
    regions = sung_regions(audio)
    if not regions:
        return {'language': None, 'lines': []}
    model = WhisperModel('large-v3', device='cpu', compute_type='int8', cpu_threads=threads)
    # Detect from sung audio only; the song's opening is often silent in this stem.
    sung = np.concatenate([audio[int(begin * RATE):int(end * RATE)] for begin, end in regions])
    language = model.detect_language(audio=sung)[0]
    segments, _ = model.transcribe(
        audio,
        language=language,
        word_timestamps=True,
        vad_filter=False,
        condition_on_previous_text=False,
        clip_timestamps=[round(value, 2) for region in regions for value in region],
    )
    lines = []
    for segment in segments:
        words = [{'start': round(word.start, 2), 'end': round(word.end, 2), 'text': word.word.strip()}
                 for word in segment.words or [] if word.word.strip()]
        if words and not INVENTED.search(segment.text):
            lines.append({'start': words[0]['start'], 'end': words[-1]['end'], 'words': words})
    return {'language': language, 'lines': lines}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('input')
    parser.add_argument('output')
    parser.add_argument('--threads', type=int, default=4)
    arguments = parser.parse_args()
    with open(arguments.output, 'w', encoding='utf-8') as file:
        json.dump(transcribe(arguments.input, arguments.threads), file, ensure_ascii=False)
