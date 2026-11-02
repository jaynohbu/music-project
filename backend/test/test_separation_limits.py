import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


spec = importlib.util.spec_from_file_location(
    "separate", Path(__file__).resolve().parents[1] / "separate.py"
)
separation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(separation)


class SeparationDurationTests(unittest.TestCase):
    def separate_frames(self, frames):
        audio = MagicMock()
        audio.__enter__.return_value = audio
        audio.getnframes.return_value = frames
        audio.getframerate.return_value = 44100
        audio.getnchannels.return_value = 2
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(separation.wave, "open", return_value=audio):
                with patch.object(separation, "run") as run:
                    result = separation.separate(
                        Path("source.flac"), Path(directory), "cpu", "ffmpeg"
                    )
                    return result, run.call_args_list

    def test_exactly_twelve_minutes_is_accepted(self):
        self.assertEqual(separation.MAX_SECONDS, 720)
        result, calls = self.separate_frames(720 * 44100)
        self.assertEqual(result["duration"], 720)
        self.assertEqual(len(result["stems"]), 6)
        normalization = calls[0].args[0]
        self.assertEqual(normalization[normalization.index("-t") + 1], "721")

    def test_one_sample_over_twelve_minutes_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "720 seconds"):
            self.separate_frames(720 * 44100 + 1)

    def test_empty_audio_is_rejected(self):
        with self.assertRaises(ValueError):
            self.separate_frames(0)


if __name__ == "__main__":
    unittest.main()
