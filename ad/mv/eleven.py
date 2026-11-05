"""ElevenLabs calls for the pipeline, through the official SDK (`elevenlabs` on PyPI).

The SDK reads ELEVENLABS_API_KEY from the environment. `npx @elevenlabs/cli onboard` stores it
in .env.local, so load that (and .env) into the environment first. The key never appears in code.

Every call here costs credits, so mv.py caches on a hash of the request and only comes here
when the spec actually changed.
"""
import base64
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# George, one of ElevenLabs' default voices. Used when a voice entry has no voice_id.
DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb"
DEFAULT_TTS_MODEL = "eleven_v4"
DEFAULT_MUSIC_MODEL = "music_v2_5"


def _load_env() -> None:
    for name in (".env.local", ".env"):
        f = ROOT / name
        if not f.exists():
            continue
        for line in f.read_text(encoding="utf-8").splitlines():
            k, sep, v = line.partition("=")
            k = k.strip()
            if sep and k and not k.startswith("#") and k not in os.environ:
                os.environ[k] = v.strip().strip('"').strip("'")


_client = None


def client():
    global _client
    if _client is None:
        _load_env()
        if not os.environ.get("ELEVENLABS_API_KEY"):
            raise SystemExit("ELEVENLABS_API_KEY is not set. Run: npx -y @elevenlabs/cli@latest onboard init")
        from elevenlabs import ElevenLabs
        _client = ElevenLabs()
    return _client


def _snake(obj):
    """The SDK's music metadata is camelCase (compositionPlan, durationMs); the rest of the
    pipeline reads snake_case."""
    if isinstance(obj, dict):
        return {re.sub(r"(?<!^)(?=[A-Z])", "_", k).lower(): _snake(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_snake(v) for v in obj]
    return obj


def voices() -> list:
    return client().voices.get_all().voices


# ── music ────────────────────────────────────────────────────────────────────

def music(prompt: str, model_id: str, output_format: str, length_ms: int | None = None,
          instrumental: bool = False) -> tuple[bytes, dict]:
    """Prompt-only composition: the model chooses structure, length, vocals and lyrics.
    Returns (audio, metadata) where metadata holds the plan the model chose and word timestamps."""
    kwargs = {"prompt": prompt, "model_id": model_id, "with_timestamps": True, "output_format": output_format}
    if length_ms:
        kwargs["music_length_ms"] = length_ms
    if instrumental:  # under a voice-over: guaranteed no vocals
        kwargs["force_instrumental"] = True
    r = client().music.compose_detailed(**kwargs)
    return strip_boundary(r.audio), {**_snake(r.json or {}), "song_id": r.song_id, "filename": r.filename}


def strip_boundary(audio: bytes) -> bytes:
    """The SDK's multipart parser (2.75) leaves the closing CRLF "--boundary--" on the audio."""
    cut = audio.rfind(CRLF_DASHES, max(0, len(audio) - 512))
    return audio[:cut] if cut != -1 else audio


CRLF_DASHES = bytes([13, 10]) + b"--"


def stems(audio_path: Path, output_format: str) -> bytes:
    """Zip bytes, one file per stem."""
    with open(audio_path, "rb") as f:
        return b"".join(client().music.separate_stems(file=f, output_format=output_format))


# ── voice ────────────────────────────────────────────────────────────────────

def tts(text: str, voice_id: str | None, model_id: str | None, output_format: str, **extra) -> tuple[bytes, dict]:
    """Speech + per-character timing."""
    r = client().text_to_speech.convert_with_timestamps(
        voice_id=voice_id or DEFAULT_VOICE,
        text=text,
        model_id=model_id or DEFAULT_TTS_MODEL,
        output_format=output_format,
        **extra,
    )
    al = r.alignment or r.normalized_alignment
    alignment = {
        "characters": list(al.characters),
        "character_start_times_seconds": list(al.character_start_times_seconds),
        "character_end_times_seconds": list(al.character_end_times_seconds),
    } if al else {}
    return base64.b64decode(r.audio_base_64), alignment


def align(audio_path: Path, text: str) -> dict:
    """A real recorded reading + its transcript → word and character times."""
    with open(audio_path, "rb") as f:
        r = client().forced_alignment.create(file=f, text=text)
    return {
        "words": [{"text": w.text, "start": w.start, "end": w.end, "loss": getattr(w, "loss", None)} for w in r.words],
        "loss": getattr(r, "loss", None),
    }


# ── sound effects ────────────────────────────────────────────────────────────

def sfx(text: str, output_format: str, **extra) -> bytes:
    """`extra`: duration_seconds, prompt_influence, loop, model_id. Leave them out and the
    model decides."""
    return b"".join(client().text_to_sound_effects.convert(text=text, output_format=output_format, **extra))
