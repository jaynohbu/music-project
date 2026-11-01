#!/usr/bin/env python3
"""Conservative stereo spectral restoration for a Demucs stem.

Reference stems identify bleed: where another stem is much louder than the
target at the same time and frequency, the target is turned down.
This is deterministic DSP, not a trained ML encoder-decoder.
"""
from __future__ import annotations
import argparse
from pathlib import Path
import numpy as np
import soundfile as sf
from scipy.signal import stft, istft
from scipy.ndimage import median_filter, gaussian_filter


def reference_gain(mag: np.ndarray, references: list[np.ndarray], sr: int, strength: float,
                   n_fft: int, hop: int) -> np.ndarray:
    """Return a gain that lowers the target where the references dominate it."""
    power = np.zeros_like(mag)
    for reference in references:
        for ch in range(reference.shape[1]):
            _, _, z = stft(reference[:, ch], fs=sr, nperseg=n_fft,
                           noverlap=n_fft-hop, boundary='zeros', padded=True)
            power += np.abs(z)**2 / reference.shape[1]
    # Equal levels keep most of the target, since instruments can truly share a frequency.
    dominance = mag**2 / (mag**2 + 0.25 * power + 1e-12)
    dominance = gaussian_filter(dominance, sigma=(0.7, 1.1))
    min_gain = 1.0 - 0.9 * strength
    return min_gain + (1.0 - min_gain) * dominance


def restore_audio(audio: np.ndarray, sr: int, strength: float = 0.45,
                  n_fft: int = 2048, hop: int = 512,
                  references: list[np.ndarray] | None = None) -> np.ndarray:
    """Process stereo channels using one shared time-frequency attenuation mask.

    strength in [0, 1] controls how much low-confidence spectral energy is reduced.
    This cannot reconstruct information missing from the separated stem.
    """
    if not 0 <= strength <= 1:
        raise ValueError('strength must be between 0 and 1')
    if audio.ndim != 2:
        raise ValueError('audio must have shape (samples, channels)')
    if n_fft <= 0 or hop <= 0 or hop > n_fft:
        raise ValueError('require 0 < hop <= n_fft')
    n = len(audio)
    for reference in references or []:
        if reference.ndim != 2 or len(reference) != n:
            raise ValueError('reference stems must be aligned with the target')
    specs = []
    for ch in range(audio.shape[1]):
        _, _, z = stft(audio[:, ch], fs=sr, nperseg=n_fft,
                       noverlap=n_fft-hop, boundary='zeros', padded=True)
        specs.append(z)
    z = np.stack(specs, axis=-1)  # [frequency, time, channel]
    mag = np.sqrt(np.mean(np.abs(z)**2, axis=-1))

    # Local median favors persistent musical energy over isolated spectral spikes.
    stable = median_filter(mag, size=(3, 5), mode='nearest')
    # Per-frequency low percentile estimates a conservative local background floor.
    floor = np.percentile(mag, 12, axis=1, keepdims=True)
    floor = gaussian_filter(floor, sigma=(2, 0))

    # A soft Wiener-like confidence mask; retain a high minimum gain to protect tone.
    signal_est = np.maximum(stable - 0.55 * floor, 0.0)
    confidence = signal_est**2 / (signal_est**2 + (0.85*floor)**2 + 1e-12)
    confidence = gaussian_filter(confidence, sigma=(0.7, 1.1))
    min_gain = 1.0 - 0.48 * strength
    gain = min_gain + (1.0 - min_gain) * confidence
    if references:
        gain = gain * reference_gain(mag, references, sr, strength, n_fft, hop)

    # Protect attack frames from excessive smoothing.
    flux = np.maximum(np.diff(mag, axis=1, prepend=mag[:, :1]), 0).sum(axis=0)
    threshold = np.percentile(flux, 88)
    if threshold > 0:
        transient = np.clip(flux / (threshold + 1e-12), 0, 1)
        gain = gain + (1 - gain) * (0.45 * transient[None, :])

    restored = np.empty_like(audio, dtype=np.float64)
    for ch in range(audio.shape[1]):
        _, y = istft(z[:, :, ch] * gain, fs=sr, nperseg=n_fft,
                     noverlap=n_fft-hop, input_onesided=True, boundary=True)
        restored[:, ch] = y[:n]
    # Avoid clipping while preserving input loudness as much as possible.
    peak = np.max(np.abs(restored))
    if peak > 0.999:
        restored *= 0.999 / peak
    return restored


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('input', type=Path)
    p.add_argument('output', type=Path)
    p.add_argument('--strength', type=float, default=0.45,
                   help='0=no attenuation; 1=strongest attenuation (default: 0.45)')
    p.add_argument('--n-fft', type=int, default=2048)
    p.add_argument('--hop', type=int, default=512)
    p.add_argument('--reference', type=Path, action='append', default=[],
                   help='another stem of the same song; repeat for each one')
    args = p.parse_args()
    audio, sr = sf.read(args.input, dtype='float32', always_2d=True)
    references = []
    for path in args.reference:
        reference, reference_sr = sf.read(path, dtype='float32', always_2d=True)
        if reference_sr != sr:
            raise ValueError('reference stems must match the target sample rate')
        references.append(reference)
    out = restore_audio(audio, sr, args.strength, args.n_fft, args.hop, references)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(args.output, out, sr, subtype='PCM_16')
    print(f'Wrote {args.output} | {len(out)/sr:.2f}s | {sr} Hz | {out.shape[1]} channels')

if __name__ == '__main__':
    main()
