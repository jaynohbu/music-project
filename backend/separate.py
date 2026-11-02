import argparse
import json
import subprocess
import sys
import wave
from pathlib import Path

STEMS = ("drums", "bass", "vocals", "guitar", "piano", "other")
MAX_SECONDS = 900


def run(command: list[str]) -> None:
    subprocess.run(command, check=True, stdout=sys.stderr, stderr=sys.stderr)


def separate(source: Path, output: Path, device: str, ffmpeg: str) -> dict[str, object]:
    output.mkdir(parents=True, exist_ok=True)
    normalized = output / "normalized.wav"
    run([
        ffmpeg, "-nostdin", "-v", "error", "-y", "-i", str(source),
        "-t", str(MAX_SECONDS + 1), "-vn", "-ac", "2", "-ar", "44100",
        "-c:a", "pcm_s16le", str(normalized),
    ])
    with wave.open(str(normalized), "rb") as audio:
        duration = audio.getnframes() / audio.getframerate()
    if not 0 < duration <= MAX_SECONDS:
        raise ValueError(f"Audio must be between 0 and {MAX_SECONDS} seconds.")
    run([
        sys.executable, "-m", "demucs", "-n", "htdemucs_6s", "-d", device,
        "--shifts", "1", "--jobs", "1", "-o", str(output / "separated"), str(normalized),
    ])
    stem_directory = output / "separated" / "htdemucs_6s" / "normalized"
    files: dict[str, str] = {}
    frames: int | None = None
    for name in STEMS:
        target = output / f"{name}.wav"
        run([
            ffmpeg, "-nostdin", "-v", "error", "-y",
            "-i", str(stem_directory / f"{name}.wav"), "-map_metadata", "-1",
            "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", str(target),
        ])
        with wave.open(str(target), "rb") as audio:
            if audio.getnchannels() != 2 or audio.getframerate() != 44100:
                raise ValueError(f"Invalid stem format: {name}")
            if frames is not None and frames != audio.getnframes():
                raise ValueError("Stem lengths are not aligned.")
            frames = audio.getnframes()
        files[name] = str(target.resolve())
    if frames is None or abs(frames / 44100 - duration) > 0.05:
        raise ValueError("Stem duration does not match input.")
    return {"duration": frames / 44100, "stems": files}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--device", choices=("cpu", "mps", "cuda"), default="cpu")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()
    print(json.dumps(separate(args.source, args.output, args.device, args.ffmpeg)))
