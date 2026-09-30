"""Transcribe a local voice recording for the Codex Custom composer."""

import sys

from faster_whisper import WhisperModel


def main() -> int:
    if len(sys.argv) != 2:
        print("Expected an audio file path.", file=sys.stderr)
        return 2

    model = WhisperModel("base.en", device="cpu", compute_type="int8")
    segments, _ = model.transcribe(sys.argv[1], beam_size=5, vad_filter=True)
    transcript = " ".join(segment.text.strip() for segment in segments).strip()
    if not transcript:
        print("No speech was detected. Try recording again.", file=sys.stderr)
        return 2
    print(transcript)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
