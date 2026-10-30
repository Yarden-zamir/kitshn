"""Music-video pipeline: ElevenLabs audio → analysis → timeline.json → mix → render → mux.

    .venv/Scripts/python mv/mv.py voices                 list ElevenLabs voices (default marked)
    .venv/Scripts/python mv/mv.py build <slug>           gen + timeline + mix (cached, only pays for changes)
    .venv/Scripts/python mv/mv.py gen <slug> [--force id,id]
    .venv/Scripts/python mv/mv.py timeline <slug>
    .venv/Scripts/python mv/mv.py mix <slug>
    .venv/Scripts/python mv/mv.py blender <slug> [--scene mv/blender/test_scene.py] [--preview]
    .venv/Scripts/python mv/mv.py mux <frames_dir> <audio> <out.mp4> [--fps 60]

A project is public/mv/<slug>/spec.json (+ assets/ for your own recordings or tracks).
Everything generated goes in public/mv/<slug>/gen/, timeline.json included.
See mv/README.md for the spec format.
"""
import argparse
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

DEFAULT_FORMAT = "mp3_44100_128"  # voice + sfx; works on every tier, set "output_format" in spec to upgrade
MUSIC_FORMAT = "mp3_44100_128"  # "auto" picks 192 kbps for music_v2+, which needs the Creator tier


# ── project paths and caching ────────────────────────────────────────────────

class Project:
    def __init__(self, slug: str):
        self.slug = slug
        self.dir = ROOT / "public" / "mv" / slug
        self.gen = self.dir / "gen"
        spec_path = self.dir / "spec.json"
        if not spec_path.exists():
            raise SystemExit(f"No spec at {spec_path}")
        self.spec = json.loads(spec_path.read_text(encoding="utf-8"))
        self.gen.mkdir(parents=True, exist_ok=True)
        self.fps = int(self.spec.get("fps", 60))
        self.fmt = self.spec.get("output_format", DEFAULT_FORMAT)
        self.ext = self.fmt.split("_")[0].replace("pcm", "wav")

    def asset(self, rel: str) -> Path:
        p = self.dir / rel
        if not p.exists():
            raise SystemExit(f"Missing file {p}")
        return p

    def public_path(self, p: Path) -> str:
        """Path as Remotion's staticFile() wants it (relative to public/)."""
        return p.relative_to(ROOT / "public").as_posix()


def _hash(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True).encode()).hexdigest()[:16]


def cached(out: Path, request) -> bool:
    """True if `out` was produced by exactly this request (so regenerating would just burn credits)."""
    stamp = out.with_suffix(out.suffix + ".req")
    return out.exists() and stamp.exists() and stamp.read_text() == _hash(request)


def stamp(out: Path, request) -> None:
    out.with_suffix(out.suffix + ".req").write_text(_hash(request))


def write_json(p: Path, obj) -> None:
    p.write_text(json.dumps(obj, indent=1, ensure_ascii=False), encoding="utf-8")


def read_json(p: Path, default=None):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


# ── gen: everything that calls ElevenLabs ───────────────────────────────────

def gen(p: Project, force: set[str]) -> None:
    import eleven

    m = p.spec.get("music")
    if m and "script" in m:
        # Music made on the spot in code (like scripts/make-audio-drop.mjs) instead of the API.
        if "music" in force or not (p.dir / m["file"]).exists():
            print(f"music: running {m['script']}")
            subprocess.run(m["script"], shell=True, cwd=ROOT, check=True)
    elif m and "file" not in m:
        # Prompt only, no plan and no length unless you give one: the model decides the
        # structure, duration, vocals and lyrics. The sections it chose come back in the metadata.
        model = m.get("model_id", eleven.DEFAULT_MUSIC_MODEL)
        fmt = m.get("output_format", MUSIC_FORMAT)
        length_ms = int(m["length_s"] * 1000) if m.get("length_s") else None
        instrumental = bool(m.get("instrumental"))
        req = [m["prompt"], model, fmt, length_ms] + ([True] if instrumental else [])
        out = music_out(p)
        if "music" in force or not cached(out, req):
            print(f"music: composing with {model} (this takes a while)")
            audio, meta = eleven.music(m["prompt"], model, fmt, length_ms, instrumental)
            out.write_bytes(audio)
            write_json(p.gen / "music.meta.json", meta)
            stamp(out, req)
            force.add("stems")  # new song → old stems are stale
        else:
            print("music: cached")

    if m and m.get("stems"):
        src = music_path(p)
        stem_dir = p.gen / "stems"
        req = [src.name, src.stat().st_size, src.stat().st_mtime_ns, p.fmt]
        marker = stem_dir / "_done"
        if "stems" in force or not cached(marker, req):
            print("stems: separating")
            shutil.rmtree(stem_dir, ignore_errors=True)
            stem_dir.mkdir()
            with zipfile.ZipFile(io.BytesIO(eleven.stems(src, p.fmt))) as z:
                for info in z.infolist():
                    if info.is_dir():
                        continue
                    name = re.sub(r"[^a-z0-9.]+", "_", Path(info.filename).name.lower())
                    (stem_dir / name).write_bytes(z.read(info))
            marker.write_text("")
            stamp(marker, req)
        else:
            print("stems: cached")

    for v in p.spec.get("voices", []):
        vid = v["id"]
        if "file" in v:
            # A real human reading: we only need word times, via forced alignment.
            src = p.asset(v["file"])
            out = p.gen / f"voice.{vid}.align.json"
            req = [v["text"], src.stat().st_size, src.stat().st_mtime_ns]
            if vid in force or not cached(out, req):
                print(f"voice {vid}: aligning recording")
                write_json(out, eleven.align(src, v["text"]))
                stamp(out, req)
            else:
                print(f"voice {vid}: cached")
            continue
        # No voice_id → a default ElevenLabs voice; no model_id → their current default model.
        extra = {k: v[k] for k in ("voice_settings", "seed", "language_code", "previous_text", "next_text",
                                    "apply_text_normalization", "audio_effects") if k in v}
        req = [v["text"], v.get("voice_id"), v.get("model_id"), extra, p.fmt]
        out = p.gen / f"voice.{vid}.{p.ext}"
        if vid in force or not cached(out, req):
            print(f"voice {vid}: speaking")
            audio, alignment = eleven.tts(v["text"], v.get("voice_id"), v.get("model_id"), p.fmt, **extra)
            out.write_bytes(audio)
            write_json(p.gen / f"voice.{vid}.align.json", {"characters": alignment})
            stamp(out, req)
        else:
            print(f"voice {vid}: cached")

    for s in p.spec.get("sfx", []):
        sid = s["id"]
        if "file" in s:
            continue
        # Only what the spec asks for; anything left out (length included) is the model's call.
        extra = {dst: s[src] for src, dst in (("duration", "duration_seconds"), ("prompt_influence", "prompt_influence"),
                                              ("loop", "loop"), ("model_id", "model_id")) if src in s}
        req = [s["text"], extra, p.fmt]
        out = p.gen / f"sfx.{sid}.{p.ext}"
        if sid in force or not cached(out, req):
            print(f"sfx {sid}: generating")
            out.write_bytes(eleven.sfx(s["text"], p.fmt, **extra))
            stamp(out, req)
        else:
            print(f"sfx {sid}: cached")


def music_out(p: Project) -> Path:
    fmt = (p.spec.get("music") or {}).get("output_format", MUSIC_FORMAT)
    ext = "mp3" if fmt == "auto" else fmt.split("_")[0].replace("pcm", "wav")
    return p.gen / f"music.{ext}"


def music_path(p: Project) -> Path | None:
    m = p.spec.get("music")
    if not m:
        return None
    if "file" in m:
        return p.asset(m["file"])
    out = music_out(p)
    if not out.exists():
        raise SystemExit("No music yet. Run gen first.")
    return out


def voice_path(p: Project, v: dict) -> Path:
    return p.asset(v["file"]) if "file" in v else p.gen / f"voice.{v['id']}.{p.ext}"


def sfx_path(p: Project, s: dict) -> Path:
    return p.asset(s["file"]) if "file" in s else p.gen / f"sfx.{s['id']}.{p.ext}"


# ── words, lines, sections ───────────────────────────────────────────────────

def words_from_chars(al: dict) -> list[dict]:
    """TTS character alignment → words (split on whitespace)."""
    chars = al.get("characters", [])
    starts = al.get("character_start_times_seconds", [])
    ends = al.get("character_end_times_seconds", [])
    words, cur = [], None
    for c, s, e in zip(chars, starts, ends):
        if c.isspace():
            if cur:
                words.append(cur)
            cur = None
            continue
        if cur is None:
            cur = {"text": c, "start": s, "end": e}
        else:
            cur["text"] += c
            cur["end"] = e
    if cur:
        words.append(cur)
    return words


def find_words(obj) -> list[dict]:
    """Pull word timestamps out of a music/detailed metadata blob, whatever it nests them in."""
    if isinstance(obj, list) and obj and all(isinstance(x, dict) for x in obj):
        keys = set(obj[0])
        tk = next((k for k in ("word", "text") if k in keys), None)
        sk = next((k for k in sorted(keys) if k.startswith("start")), None)
        ek = next((k for k in sorted(keys) if k.startswith("end")), None)
        if tk and sk and ek:
            div = 1000.0 if sk.endswith("ms") else 1.0
            return [{"text": w[tk], "start": w[sk] / div, "end": w[ek] / div} for w in obj if str(w[tk]).strip()]
    if isinstance(obj, dict):
        for v in obj.values():
            found = find_words(v)
            if found:
                return found
    if isinstance(obj, list):
        for v in obj:
            found = find_words(v)
            if found:
                return found
    return []


def lines_from_text(text: str, words: list[dict], track: str) -> list[dict]:
    """Group words back into the lines of the original text (newline-separated)."""
    lines, i = [], 0
    for line in text.splitlines():
        n = len(line.split())
        if n == 0:
            continue
        chunk = words[i:i + n]
        if len(chunk) < n:
            break
        lines.append({"text": line.strip(), "start": chunk[0]["start"], "end": chunk[-1]["end"], "track": track})
        i += n
    return lines


def plan_sections(plan: dict) -> tuple[list[dict], list[str]]:
    """(sections with exact times, lyric lines) from either plan format."""
    sections, lyrics, t = [], [], 0.0
    if "chunks" in plan:  # music_v2 / v2.5
        for i, c in enumerate(plan["chunks"]):
            dur = (c.get("duration_ms") or (c.get("end_ms", 0) - c.get("start_ms", 0))) / 1000
            text = c.get("text", "")
            mt = re.match(r"\s*\[([^\]]+)\]", text)
            sections.append({"name": mt.group(1) if mt else f"Part {i + 1}", "start": round(t, 4), "end": round(t + dur, 4)})
            body = re.sub(r"\[[^\]]*\]|\{[^}]*\}", "", text)
            lyrics += [ln.strip() for ln in body.splitlines() if ln.strip()]
            t += dur
    else:  # music_v1
        for s in plan.get("sections", []):
            dur = s["duration_ms"] / 1000
            sections.append({"name": s["section_name"], "start": round(t, 4), "end": round(t + dur, 4)})
            lyrics += [ln for ln in s.get("lines", []) if ln.strip()]
            t += dur
    return sections, lyrics


# ── placement: "at" can be seconds or a musical reference ────────────────────

AT_RE = re.compile(r"^(section|beat|bar|marker|word):(.+?)(?:([+-]\d+(?:\.\d+)?))?$")
TAG_RE = re.compile(r"\[[^\]]*\]")  # ElevenLabs audio tags like [whispers]: performed, not spoken


class Pending(Exception):
    """The reference exists in the spec but hasn't been placed yet (try again later)."""


def clean_word(w: str) -> str:
    return re.sub(r"[^\w']+", "", w).lower()


def resolve_at(at, tl: dict, known: set[str] = frozenset()) -> float:
    """12.5 | "section:Chorus" | "beat:17" | "bar:5-0.25" | "marker:reveal+0.1" |
    "word:<voice id>:<word>[#n]+0.2" → seconds.

    Beats and bars count from 1, like a musician would. `word:` finds the n-th (default
    first) time a voice says that word, ignoring case and punctuation. `known` holds the
    ids/markers that will exist once everything is placed, so a forward reference waits
    (Pending) instead of failing.
    """
    if isinstance(at, (int, float)):
        return float(at)
    m = AT_RE.match(str(at).strip())
    if not m:
        raise SystemExit(f'Bad "at": {at!r}')
    kind, ref, off = m.group(1), m.group(2), float(m.group(3) or 0)
    if kind == "section":
        hit = next((s for s in tl["sections"] if s["name"].lower() == ref.lower()), None)
        if not hit:
            raise SystemExit(f"No section {ref!r}. Have: {[s['name'] for s in tl['sections']]}")
        return hit["start"] + off
    if kind == "marker":
        hit = next((mk for mk in tl["markers"] if mk["name"] == ref), None)
        if not hit:
            if f"marker:{ref}" in known:
                raise Pending(at)
            raise SystemExit(f"No marker {ref!r}")
        return hit["t"] + off
    if kind == "word":
        track, _, word = ref.partition(":")
        word, _, nth = word.partition("#")
        hits = [w for w in tl["words"] if w["track"] == track and clean_word(w["text"]) == clean_word(word)]
        if not hits:
            if f"voice:{track}" in known and not any(w["track"] == track for w in tl["words"]):
                raise Pending(at)
            said = " ".join(w["text"] for w in tl["words"] if w["track"] == track)
            raise SystemExit(f"Voice {track!r} never says {word!r}. It says: {said}")
        n = int(nth or 1)
        if n > len(hits):
            raise SystemExit(f"Voice {track!r} says {word!r} only {len(hits)} time(s)")
        return hits[n - 1]["start"] + off
    seq = tl["beats"] if kind == "beat" else tl["downbeats"]
    n = int(ref)
    if not 1 <= n <= len(seq):
        raise SystemExit(f"{kind}:{n} out of range (1..{len(seq)})")
    return seq[n - 1] + off


# ── timeline ─────────────────────────────────────────────────────────────────

def timeline(p: Project) -> dict:
    import analyze

    fps = p.fps
    tl = {"version": 1, "slug": p.slug, "fps": fps, "duration": 0.0, "frames": 0, "bpm": 0.0,
          "sections": [], "beats": [], "downbeats": [], "onsets": {}, "energy": {},
          "words": [], "lines": [], "clips": [], "markers": []}

    music = music_path(p)
    m = p.spec.get("music") or {}
    lyrics = []
    if music:
        stems = sorted((p.gen / "stems").glob("*.*")) if m.get("stems") else []
        stems = [s for s in stems if s.suffix not in (".req",) and s.name != "_done"]
        drums = next((s for s in stems if "drum" in s.name), None)
        _, dur = analyze.load(music)
        n = int(round(dur * fps))
        a = analyze.full(music, fps, n, beat_source=drums)
        tl.update(duration=a["duration"], bpm=a["bpm"], beats=a["beats"], downbeats=a["downbeats"],
                  onsets=a["onsets"], energy=a["energy"])
        if "grid" in m:
            # Known tempo (your own track, or a BPM you asked the model for): an exact grid
            # beats detection, which drifts by a few ms and can miss beat one.
            g = m["grid"]
            step, t0, per_bar = 60.0 / g["bpm"], float(g.get("offset", 0)), int(g.get("beats_per_bar", 4))
            k = int((a["duration"] - t0) / step) + 1
            tl["bpm"] = g["bpm"]
            tl["beats"] = [round(t0 + i * step, 4) for i in range(k)]
            tl["downbeats"] = tl["beats"][::per_bar]
        for s in stems:
            key = s.stem.replace(".", "_")
            tl["energy"][key], tl["onsets"][key] = analyze.envelope(s, fps, n)
        tl["clips"].append({"id": "music", "kind": "music", "file": p.public_path(music), "start": 0.0,
                            "end": a["duration"], "gain_db": m.get("gain_db", 0)})

        meta = read_json(p.gen / "music.meta.json", {})
        plan = meta.get("composition_plan")  # what the model chose; a report, not a constraint
        if plan:
            tl["sections"], lyrics = plan_sections(plan)
        tl["sections"] = m.get("sections", tl["sections"])  # your own track: list them by hand
        lyric_words = find_words(meta)
        if lyric_words:
            tl["words"] += [{**w, "track": "lyrics"} for w in lyric_words]
            tl["lines"] += lines_from_text("\n".join(lyrics), lyric_words, "lyrics")

    # Markers, voices and sfx can reference each other (a voice after another voice's word,
    # a marker on a word, an sfx on a marker), so place them in whatever order resolves.
    items = [("marker", x) for x in p.spec.get("markers", [])] + [("voice", x) for x in p.spec.get("voices", [])] \
        + [("sfx", x) for x in p.spec.get("sfx", [])]
    known = {f"marker:{x['name']}" for k, x in items if k == "marker"} | {f"voice:{x['id']}" for k, x in items if k == "voice"}
    end = tl["duration"]
    while items:
        left = []
        for kind, x in items:
            try:
                at = resolve_at(x.get("at", 0), tl, known)
            except Pending:
                left.append((kind, x))
                continue
            if kind == "marker":
                tl["markers"].append({"name": x["name"], "t": round(at, 4)})
                continue
            src = voice_path(p, x) if kind == "voice" else sfx_path(p, x)
            _, dur = analyze.load(src)
            if kind == "voice":
                al = read_json(p.gen / f"voice.{x['id']}.align.json", {})
                words = words_from_chars(al["characters"]) if isinstance(al.get("characters"), dict) \
                    else [w for w in al.get("words", []) if str(w.get("text", "")).strip()]
                words = [{"text": w["text"], "start": round(w["start"] + at, 4), "end": round(w["end"] + at, 4),
                          "track": x["id"]} for w in words if not TAG_RE.fullmatch(w["text"].strip())]
                tl["words"] += words
                tl["lines"] += lines_from_text(TAG_RE.sub("", x["text"]), words, x["id"])
            tl["clips"].append({"id": x["id"], "kind": kind, "file": p.public_path(src), "start": round(at, 4),
                                "end": round(at + dur, 4), "gain_db": x.get("gain_db", 0),
                                **({"mix": False} if x.get("mix") is False else {})})
            end = max(end, at + dur)
        if len(left) == len(items):
            raise SystemExit(f"Circular placement: {[x.get('at') for _, x in left]}")
        items = left
    tl["markers"].sort(key=lambda mk: mk["t"])

    tl["duration"] = round(float(p.spec.get("duration", end + p.spec.get("tail", 0))), 4)
    tl["frames"] = int(round(tl["duration"] * fps))

    # Per-clip envelopes on the global grid (voice energy for captions, lip flaps, etc.).
    for c in tl["clips"]:
        if c["kind"] != "music":
            tl["energy"][c["id"]], tl["onsets"][c["id"]] = analyze.envelope(ROOT / "public" / c["file"], fps, tl["frames"], c["start"])
    for k, v in tl["energy"].items():  # pad/trim every curve to exactly `frames`
        tl["energy"][k] = (v + [0.0] * tl["frames"])[: tl["frames"]]

    tl["words"].sort(key=lambda w: w["start"])
    tl["lines"].sort(key=lambda w: w["start"])
    tl["mix"] = p.public_path(p.gen / "mix.wav")
    write_json(p.gen / "timeline.json", tl)
    print(f"timeline: {tl['duration']:.2f}s, {tl['frames']} frames @ {fps}fps, {tl['bpm']} BPM, "
          f"{len(tl['beats'])} beats, {len(tl['sections'])} sections, {len(tl['words'])} words, {len(tl['clips'])} clips")
    return tl


# ── mix (ffmpeg) ─────────────────────────────────────────────────────────────

def mix(p: Project) -> Path:
    """One mix.wav for every renderer, so the Remotion and Blender outputs are comparable."""
    tl = read_json(p.gen / "timeline.json") or timeline(p)
    duck = float((p.spec.get("mix") or {}).get("duck_db", 8))
    inputs, chains = [], {"music": [], "voice": [], "sfx": []}
    for c in tl["clips"]:
        if c.get("mix") is False:  # played by the composition at its own cues, not baked in
            continue
        i = len(inputs) // 2  # inputs holds "-i", path pairs
        inputs += ["-i", str(ROOT / "public" / c["file"])]
        ms = int(round(c["start"] * 1000))
        chains[c["kind"]].append(f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay={ms}:all=1,volume={c['gain_db']}dB")
    if not inputs:
        raise SystemExit("Nothing to mix")

    f, buses = [], []
    for kind, items in chains.items():
        if not items:
            continue
        for j, ch in enumerate(items):
            f.append(f"{ch}[{kind}{j}]")
        ins = "".join(f"[{kind}{j}]" for j in range(len(items)))
        f.append(f"{ins}amix=inputs={len(items)}:normalize=0:duration=longest[{kind}]" if len(items) > 1 else f"{ins}anull[{kind}]")
        buses.append(kind)
    if "music" in buses and "voice" in buses and duck > 0:
        # Sidechain: the music dips by roughly `duck_db` while anyone is talking.
        ratio = max(1.5, 10 ** (duck / 20))
        f.append("[voice]asplit=2[voice_out][vkey]")
        f.append(f"[music][vkey]sidechaincompress=threshold=0.02:ratio={ratio:.2f}:attack=15:release=350[music_out]")
        buses = [{"music": "music_out", "voice": "voice_out"}.get(b, b) for b in buses]
    out_ins = "".join(f"[{b}]" for b in buses)
    # Loudness target (default -14 LUFS, where YouTube/Instagram/TikTok play back), then a
    # true-peak ceiling so the normalised mix never clips.
    lufs = float((p.spec.get("mix") or {}).get("lufs", -14))
    # Optional fade at the very end, for when `duration` cuts the music short.
    fade = float((p.spec.get("mix") or {}).get("fade_out", 0))
    tail = f",afade=t=out:st={tl['duration'] - fade:.3f}:d={fade}" if fade > 0 else ""
    f.append(f"{out_ins}amix=inputs={len(buses)}:normalize=0:duration=longest,"
             f"apad,atrim=0:{tl['duration']},loudnorm=I={lufs}:TP=-1.5:LRA=11,alimiter=limit=0.89{tail}[out]")

    out = p.gen / "mix.wav"
    cmd = ["ffmpeg", "-loglevel", "error", "-y", *inputs, "-filter_complex", ";".join(f), "-map", "[out]",
           "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", str(out)]
    subprocess.run(cmd, check=True)
    print(f"mix: {out.relative_to(ROOT)}")
    return out


# ── render helpers ───────────────────────────────────────────────────────────

def blender_exe() -> str:
    env = os.environ.get("BLENDER") or _dotenv("BLENDER")
    if env:
        return env
    found = shutil.which("blender")
    if found:
        return found
    for c in sorted(Path(os.environ.get("LOCALAPPDATA", "")).glob("Programs/blender-*/blender.exe"), reverse=True):
        return str(c)
    raise SystemExit("Blender not found. Set BLENDER=... in .env")


def _dotenv(key: str) -> str | None:
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            k, _, v = line.partition("=")
            if k.strip() == key and v.strip():
                return v.strip().strip('"')
    return None


def blender(p: Project, scene: str, preview: bool, frames: str | None, layer: bool = False) -> None:
    """Render a Blender scene against the project's timeline.

    Default: a standalone video (PNGs in out/, muxed with mix.wav). `layer`: PNGs into
    public/mv/<slug>/gen/blender/<scene>/ for a Remotion composition to composite, no mux.
    """
    tl_path = p.gen / "timeline.json"
    if not tl_path.exists():
        raise SystemExit("No timeline yet. Run build first.")
    name = Path(scene).stem + ("-preview" if preview else "")
    out_dir = (p.gen / "blender" / name) if layer else (ROOT / "out" / "mv" / p.slug / f"blender-{name}")
    out_dir.mkdir(parents=True, exist_ok=True)
    args = [blender_exe(), "--background", "--factory-startup", "--python", str(ROOT / scene), "--",
            "--timeline", str(tl_path), "--out", str(out_dir)]
    if preview:
        args.append("--preview")
    if frames:
        args += ["--frames", frames]
    subprocess.run(args, check=True)
    if not frames and not layer:
        mux(out_dir, p.gen / "mix.wav", out_dir.with_suffix(".mp4"), p.fps)


def mux(frames_dir: Path, audio: Path, out: Path, fps: int) -> None:
    """PNG sequence + audio → H.264 mp4. Detects the numbering (frame_00001.png, element-0000.png, ...)."""
    pngs = sorted(frames_dir.glob("*.png"))
    if not pngs:
        raise SystemExit(f"No PNGs in {frames_dir}")
    m = re.match(r"^(.*?)(\d+)\.png$", pngs[0].name)
    if not m:
        raise SystemExit(f"Can't read frame numbering from {pngs[0].name}")
    prefix, digits = m.group(1), m.group(2)
    cmd = ["ffmpeg", "-loglevel", "error", "-y",
           "-framerate", str(fps), "-start_number", str(int(digits)), "-i", str(frames_dir / f"{prefix}%0{len(digits)}d.png"),
           "-i", str(audio),
           "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "320k", "-shortest", "-movflags", "+faststart", str(out)]
    print(" ".join(cmd))
    subprocess.run(cmd, check=True)
    print(f"mux: {out}")


# ── CLI ──────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("voices")
    for name in ("build", "gen", "timeline", "mix"):
        s = sub.add_parser(name)
        s.add_argument("slug")
        s.add_argument("--force", default="", help="comma-separated ids to regenerate: music,stems,<voice id>,<sfx id>")
    b = sub.add_parser("blender")
    b.add_argument("slug")
    b.add_argument("--scene", default="mv/blender/test_scene.py")
    b.add_argument("--preview", action="store_true", help="half-res, fewer samples")
    b.add_argument("--frames", help="render only these frames as stills, e.g. 1,120,480")
    b.add_argument("--layer", action="store_true", help="render into gen/blender/<scene>/ for Remotion, no mux")
    x = sub.add_parser("mux")
    x.add_argument("frames_dir", type=Path)
    x.add_argument("audio", type=Path)
    x.add_argument("out", type=Path)
    x.add_argument("--fps", type=int, default=60)
    a = ap.parse_args()

    if a.cmd == "voices":
        import eleven
        for v in eleven.voices():
            labels = ", ".join(f"{k}={val}" for k, val in (v.labels or {}).items())
            mark = "  (default)" if v.voice_id == eleven.DEFAULT_VOICE else ""
            print(f"{v.voice_id}  {v.name:<28} {labels}{mark}")
        return
    if a.cmd == "mux":
        return mux(a.frames_dir, a.audio, a.out, a.fps)

    p = Project(a.slug)
    if a.cmd == "blender":
        return blender(p, a.scene, a.preview, a.frames, a.layer)
    force = {s for s in a.force.split(",") if s}
    if a.cmd in ("build", "gen"):
        gen(p, force)
    if a.cmd in ("build", "timeline"):
        timeline(p)
    if a.cmd in ("build", "mix"):
        mix(p)


if __name__ == "__main__":
    main()
