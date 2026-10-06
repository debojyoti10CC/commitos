"""One bounded stdin request, one JSON response. No records, files or network writes."""
from __future__ import annotations

import base64
import binascii
import contextlib
import io
import json
import logging
import os
from pathlib import Path
import re
import sys

MAX_AUDIO_BYTES = 8 * 1024 * 1024
MAX_INPUT_BYTES = 12 * 1024 * 1024
MAX_DURATION_SECONDS = 120
MAX_TRANSCRIPT_CHARACTERS = 20_000
SAMPLE_RATE = 16_000
APP_DIRECTORY = Path(__file__).resolve().parent.parent

# An installed model is mandatory; inference must never fetch assets or use tokens.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
logging.disable(logging.CRITICAL)


class VoiceError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def controlled_vocabulary(value: str) -> str | None:
    """Keep only a short list of vocabulary terms, never instructions or transcripts."""
    terms: list[str] = []
    for part in re.split(r"[,;\n\r]", value):
        term = re.sub(r"[^\w .&'’\-]", " ", part, flags=re.UNICODE)
        term = " ".join(term.split())[:80]
        if term and term.casefold() not in {existing.casefold() for existing in terms}:
            terms.append(term)
        if len(terms) >= 30:
            break
    return ", ".join(terms)[:500] or None


def parse_request(raw: bytes) -> tuple[bytes, str | None, str | None]:
    if len(raw) > MAX_INPUT_BYTES:
        raise VoiceError("AUDIO_TOO_LARGE")
    try:
        request = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError):
        raise VoiceError("INVALID_INPUT") from None
    if not isinstance(request, dict) or set(request) - {"audio", "language", "vocabulary"}:
        raise VoiceError("INVALID_INPUT")
    encoded = request.get("audio")
    language = request.get("language")
    vocabulary = request.get("vocabulary", "")
    if not isinstance(encoded, str) or language not in ("en", "hi", None):
        raise VoiceError("INVALID_INPUT")
    if not isinstance(vocabulary, str) or len(vocabulary) > 2000:
        raise VoiceError("INVALID_INPUT")
    if len(encoded) > 4 * ((MAX_AUDIO_BYTES + 2) // 3):
        raise VoiceError("AUDIO_TOO_LARGE")
    try:
        audio = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise VoiceError("INVALID_AUDIO") from None
    if not audio:
        raise VoiceError("INVALID_AUDIO")
    if len(audio) > MAX_AUDIO_BYTES:
        raise VoiceError("AUDIO_TOO_LARGE")
    return audio, language, controlled_vocabulary(vocabulary)


def decode_bounded(audio: bytes):
    """Bound decoded samples, not untrusted container duration metadata."""
    import av
    import numpy as np

    av.logging.set_level(av.logging.PANIC)
    chunks = []
    total_samples = 0
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)

    def append(frame):
        nonlocal total_samples
        samples = frame.to_ndarray().reshape(-1)
        total_samples += len(samples)
        if total_samples > MAX_DURATION_SECONDS * SAMPLE_RATE:
            raise VoiceError("AUDIO_TOO_LONG")
        chunks.append(samples)

    def reject_external_media(*_):
        raise VoiceError("INVALID_AUDIO")

    try:
        with av.open(io.BytesIO(audio), mode="r", metadata_errors="ignore",
                     options={"protocol_whitelist": "pipe"}, io_open=reject_external_media) as container:
            # Recordings must be self-contained. Reject playlists/concat formats
            # which can otherwise make FFmpeg open network or local resources.
            supported = {"wav", "matroska", "webm", "ogg", "mov", "mp4", "m4a", "3gp", "3g2", "mj2", "mp3", "flac", "aac"}
            if not supported.intersection(container.format.name.split(",")):
                raise VoiceError("INVALID_AUDIO")
            if not container.streams.audio:
                raise VoiceError("INVALID_AUDIO")
            for frame in container.decode(audio=0):
                frame.pts = None
                for decoded in resampler.resample(frame):
                    append(decoded)
            for decoded in resampler.resample(None):
                append(decoded)
    except VoiceError:
        raise
    except Exception:
        raise VoiceError("INVALID_AUDIO") from None
    if not total_samples:
        raise VoiceError("INVALID_AUDIO")
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def transcribe_request(raw: bytes) -> dict:
    audio, language, prompt = parse_request(raw)
    try:
        import numpy as np
        from faster_whisper import WhisperModel
        from faster_whisper.vad import get_speech_timestamps
    except ImportError:
        raise VoiceError("MODEL_UNAVAILABLE") from None

    samples = decode_bounded(audio)
    duration = round(len(samples) / SAMPLE_RATE, 3)
    # Exact silence/near-zero recordings never reach the speech model or prompt.
    if float(np.max(np.abs(samples))) < 0.0001:
        return {"text": "", "language": language, "duration": duration}
    vad_parameters = {"min_silence_duration_ms": 500, "min_speech_duration_ms": 250}
    try:
        if not get_speech_timestamps(samples, sampling_rate=SAMPLE_RATE, **vad_parameters):
            return {"text": "", "language": language, "duration": duration}
    except Exception:
        raise VoiceError("TRANSCRIPTION_FAILED") from None

    directory = Path(os.environ.get("VOICE_MODEL_DIR") or APP_DIRECTORY / ".voice" / "model").resolve()
    if not all((directory / filename).is_file() for filename in ("model.bin", "config.json", "tokenizer.json")):
        raise VoiceError("MODEL_UNAVAILABLE")
    try:
        model = WhisperModel(str(directory), device="cpu", compute_type="int8",
                             cpu_threads=8, num_workers=1, local_files_only=True)
    except Exception:
        raise VoiceError("MODEL_UNAVAILABLE") from None
    try:
        segments, info = model.transcribe(
            io.BytesIO(audio), language=language, beam_size=5, temperature=0.0,
            vad_filter=True, vad_parameters=vad_parameters,
            condition_on_previous_text=False, initial_prompt=prompt,
            no_speech_threshold=0.6, log_prob_threshold=-1.0,
            compression_ratio_threshold=2.4,
        )
        pieces: list[str] = []
        length = 0
        for segment in segments:
            text = segment.text.strip()
            if not text:
                continue
            length += len(text) + (1 if pieces else 0)
            if length > MAX_TRANSCRIPT_CHARACTERS:
                raise VoiceError("TRANSCRIPT_TOO_LONG")
            pieces.append(text)
        return {"text": " ".join(pieces), "language": info.language, "duration": duration}
    except VoiceError:
        raise
    except Exception:
        raise VoiceError("TRANSCRIPTION_FAILED") from None


def main() -> None:
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        # Dependencies may log; stdout remains a single machine-readable JSON value.
        with contextlib.redirect_stdout(sys.stderr):
            result = transcribe_request(raw)
    except VoiceError as error:
        result = {"error": error.code}
    except Exception:
        result = {"error": "TRANSCRIPTION_FAILED"}
    sys.stdout.write(json.dumps(result, ensure_ascii=True, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
