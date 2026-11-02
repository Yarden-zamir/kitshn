"""Audio analysis for animation: beats, downbeats, onsets and per-video-frame energy.

Everything is returned in seconds (events) or as one value per video frame (energy),
normalised to 0..1 so the same curve drives Remotion and Blender identically.
"""
import numpy as np
import librosa

SR = 22050
HOP = 512
BANDS = {"low": (20, 150), "mid": (150, 2000), "high": (2000, SR / 2)}


def _per_frame(values: np.ndarray, fps: int, n_frames: int, release_s: float = 0.12) -> list[float]:
    """Resample an STFT-rate curve onto the video frame grid, then normalise and smooth.

    Normalising to the 98th percentile keeps one loud hit from flattening the rest.
    The release smoothing gives instant attacks and soft decays, which reads as motion
    instead of flicker.
    """
    t_src = librosa.frames_to_time(np.arange(len(values)), sr=SR, hop_length=HOP)
    t_dst = np.arange(n_frames) / fps
    v = np.interp(t_dst, t_src, values, left=0.0, right=0.0)
    ref = np.percentile(v, 98) or 1.0
    v = np.clip(v / ref, 0.0, 1.0)
    k = np.exp(-1.0 / max(release_s * fps, 1e-6))
    out = np.empty_like(v)
    acc = 0.0
    for i, x in enumerate(v):
        acc = x if x > acc else acc * k + x * (1 - k)
        out[i] = acc
    return [round(float(x), 4) for x in out]


def _band(S: np.ndarray, freqs: np.ndarray, lo: float, hi: float) -> np.ndarray:
    m = (freqs >= lo) & (freqs < hi)
    return S[m].sum(axis=0) if m.any() else np.zeros(S.shape[1])


def _times(xs) -> list[float]:
    return [round(float(x), 4) for x in xs]


def load(path) -> tuple[np.ndarray, float]:
    y, _ = librosa.load(str(path), sr=SR, mono=True)
    return y, len(y) / SR


def envelope(path, fps: int, n_frames: int, offset_s: float = 0.0) -> tuple[list[float], list[float]]:
    """(per-frame energy, onsets) for a clip placed at `offset_s` on the global timeline."""
    y, _ = load(path)
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=HOP)[0]
    pad = int(round(offset_s * SR / HOP))
    rms = np.concatenate([np.zeros(max(pad, 0)), rms])
    onsets = librosa.onset.onset_detect(y=y, sr=SR, hop_length=HOP, units="time") + offset_s
    return _per_frame(rms, fps, n_frames), _times(onsets)


def full(path, fps: int, n_frames: int | None = None, beat_source=None) -> dict:
    """Full analysis of a music track. `beat_source` (e.g. the drum stem) gives cleaner beats."""
    y, dur = load(path)
    n_frames = n_frames or int(np.ceil(dur * fps))

    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=HOP)) ** 2
    freqs = librosa.fft_frequencies(sr=SR, n_fft=2048)
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=HOP)[0]

    yb = load(beat_source)[0] if beat_source else y
    tempo, beat_frames = librosa.beat.beat_track(y=yb, sr=SR, hop_length=HOP)
    beats = librosa.frames_to_time(beat_frames, sr=SR, hop_length=HOP)

    low_S = _band(S, freqs, *BANDS["low"])
    high_S = _band(S, freqs, *BANDS["high"])
    low_env = librosa.onset.onset_strength(S=librosa.power_to_db(low_S[None, :]), sr=SR, hop_length=HOP)
    high_env = librosa.onset.onset_strength(S=librosa.power_to_db(high_S[None, :]), sr=SR, hop_length=HOP)

    # Downbeats: librosa has no bar tracker, so pick the 4/4 phase whose beats carry
    # the most low-end onset strength (the kick usually lands on beat one).
    downbeats = []
    if len(beat_frames) >= 4:
        idx = np.clip(beat_frames, 0, len(low_env) - 1)
        phase = int(np.argmax([low_env[idx[p::4]].sum() for p in range(4)]))
        downbeats = beats[phase::4]

    onset = lambda env: librosa.onset.onset_detect(onset_envelope=env, sr=SR, hop_length=HOP, units="time")
    return {
        "duration": round(dur, 4),
        "bpm": round(float(np.atleast_1d(tempo)[0]), 2),
        "beats": _times(beats),
        "downbeats": _times(downbeats),
        "onsets": {
            "all": _times(librosa.onset.onset_detect(y=y, sr=SR, hop_length=HOP, units="time")),
            "low": _times(onset(low_env)),
            "high": _times(onset(high_env)),
        },
        "energy": {
            "rms": _per_frame(rms, fps, n_frames),
            **{name: _per_frame(np.sqrt(_band(S, freqs, lo, hi)), fps, n_frames) for name, (lo, hi) in BANDS.items()},
        },
    }
