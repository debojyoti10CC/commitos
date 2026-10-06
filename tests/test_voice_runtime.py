"""Run with .voice/venv/Scripts/python.exe -m unittest discover -s tests -p test_voice_runtime.py."""
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

APP = Path(__file__).resolve().parent.parent
SCRIPT = APP / "scripts" / "transcribe-audio.py"
spec = importlib.util.spec_from_file_location("voice_runtime", SCRIPT)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def wav(seconds=1, sample=0):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(16000)
        writer.writeframes(int(sample).to_bytes(2, "little", signed=True) * int(seconds * 16000))
    return buffer.getvalue()


def request(audio, language="en", vocabulary=""):
    return json.dumps({"audio": base64.b64encode(audio).decode("ascii"), "language": language, "vocabulary": vocabulary}).encode()


class VoiceRuntimeTests(unittest.TestCase):
    def test_valid_request_and_controlled_vocabulary(self):
        audio, language, prompt = runtime.parse_request(request(b"audio", "hi", "IIT Patna; IIT Patna\nRavi <tag>"))
        self.assertEqual(audio, b"audio")
        self.assertEqual(language, "hi")
        self.assertEqual(prompt, "IIT Patna, Ravi tag")
        self.assertLessEqual(len(runtime.controlled_vocabulary("name, " * 1000)), 500)

    def test_rejects_malformed_request_and_unsupported_language(self):
        for payload in [b"bad json", b"[]", request(b"audio", "fr"), b'{"audio":"YQ==","extra":true}', b'{"audio":"YQ==","vocabulary":3}']:
            with self.subTest(payload=payload[:40]), self.assertRaisesRegex(runtime.VoiceError, "INVALID_INPUT"):
                runtime.parse_request(payload)

    def test_rejects_invalid_base64_and_empty_audio(self):
        for encoded in ["!invalid!", "", "data:audio/wav;base64,YQ=="]:
            with self.assertRaisesRegex(runtime.VoiceError, "INVALID_AUDIO"):
                runtime.parse_request(json.dumps({"audio": encoded}).encode())

    def test_bounds_transport_and_decoded_audio_bytes(self):
        with self.assertRaisesRegex(runtime.VoiceError, "AUDIO_TOO_LARGE"):
            runtime.parse_request(b" " * (runtime.MAX_INPUT_BYTES + 1))
        with self.assertRaisesRegex(runtime.VoiceError, "AUDIO_TOO_LARGE"):
            runtime.parse_request(request(b"a" * (runtime.MAX_AUDIO_BYTES + 1)))

    def test_bounds_actual_decoded_duration_before_model_inference(self):
        with patch("faster_whisper.WhisperModel") as model:
            with self.assertRaisesRegex(runtime.VoiceError, "AUDIO_TOO_LONG"):
                runtime.transcribe_request(request(wav(120.01)))
            model.assert_not_called()

    def test_invalid_container_is_safe(self):
        with self.assertRaisesRegex(runtime.VoiceError, "INVALID_AUDIO"):
            runtime.transcribe_request(request(b"not an audio container"))

    def test_playlist_cannot_fetch_network_media(self):
        requested = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requested.append(self.path)
                self.send_response(404)
                self.end_headers()

            def log_message(self, *_):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            playlist = f"#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:{server.server_port}/segment.wav\n#EXT-X-ENDLIST\n".encode()
            with self.assertRaisesRegex(runtime.VoiceError, "INVALID_AUDIO"):
                runtime.transcribe_request(request(playlist))
            self.assertEqual(requested, [])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_silence_does_not_load_model_or_emit_vocabulary(self):
        with patch("faster_whisper.WhisperModel") as model:
            result = runtime.transcribe_request(request(wav(2), vocabulary="Submit IIT Patna assignment"))
            self.assertEqual(result, {"text": "", "language": "en", "duration": 2.0})
            model.assert_not_called()

    def test_vad_rejects_non_speech_before_model_load(self):
        with patch("faster_whisper.WhisperModel") as model, patch("faster_whisper.vad.get_speech_timestamps", return_value=[]):
            result = runtime.transcribe_request(request(wav(1, 5000)))
            self.assertEqual(result["text"], "")
            model.assert_not_called()

    def test_local_model_and_transcription_parameters_are_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in ["model.bin", "config.json", "tokenizer.json"]:
                Path(directory, name).touch()
            fake = SimpleNamespace(transcribe=lambda *args, **kwargs: None)
            with patch.dict(os.environ, {"VOICE_MODEL_DIR": directory}), patch("faster_whisper.vad.get_speech_timestamps", return_value=[{"start": 0, "end": 16000}]), patch("faster_whisper.WhisperModel", return_value=fake) as loader:
                with patch.object(fake, "transcribe", return_value=(iter([SimpleNamespace(text=" Submit IIT Patna assignment. ")]), SimpleNamespace(language="en"))) as transcribe:
                    result = runtime.transcribe_request(request(wav(1, 5000), vocabulary="IIT Patna"))
                    self.assertEqual(result, {"text": "Submit IIT Patna assignment.", "language": "en", "duration": 1.0})
                    self.assertEqual(loader.call_args.kwargs["compute_type"], "int8")
                    self.assertTrue(loader.call_args.kwargs["local_files_only"])
                    self.assertEqual(loader.call_args.kwargs["device"], "cpu")
                    self.assertIsInstance(transcribe.call_args.args[0], io.BytesIO)
                    self.assertEqual(transcribe.call_args.kwargs["beam_size"], 5)
                    self.assertTrue(transcribe.call_args.kwargs["vad_filter"])
                    self.assertEqual(transcribe.call_args.kwargs["vad_parameters"]["min_silence_duration_ms"], 500)
                    self.assertFalse(transcribe.call_args.kwargs["condition_on_previous_text"])
                    self.assertEqual(transcribe.call_args.kwargs["initial_prompt"], "IIT Patna")
                    self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")

    def test_transcript_limit_is_not_silently_truncated(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in ["model.bin", "config.json", "tokenizer.json"]:
                Path(directory, name).touch()
            fake = SimpleNamespace(transcribe=lambda *args, **kwargs: (iter([SimpleNamespace(text="x" * 20001)]), SimpleNamespace(language="en")))
            with patch.dict(os.environ, {"VOICE_MODEL_DIR": directory}), patch("faster_whisper.vad.get_speech_timestamps", return_value=[{"start": 0, "end": 16000}]), patch("faster_whisper.WhisperModel", return_value=fake):
                with self.assertRaisesRegex(runtime.VoiceError, "TRANSCRIPT_TOO_LONG"):
                    runtime.transcribe_request(request(wav(1, 5000)))
                fake.transcribe = lambda *args, **kwargs: (iter([SimpleNamespace(text="x" * 20000)]), SimpleNamespace(language="en"))
                self.assertEqual(len(runtime.transcribe_request(request(wav(1, 5000)))["text"]), 20000)

    def test_stdout_is_one_safe_json_value_on_failure(self):
        child = subprocess.run([sys.executable, str(SCRIPT)], input=b'{"audio":"!!"}', capture_output=True, timeout=15)
        self.assertEqual(child.returncode, 0)
        self.assertEqual(json.loads(child.stdout), {"error": "INVALID_AUDIO"})
        self.assertNotIn(b"Traceback", child.stdout)
        self.assertEqual(child.stdout.count(b"\n"), 1)


if __name__ == "__main__":
    unittest.main()
