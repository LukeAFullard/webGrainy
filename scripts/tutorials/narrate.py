#!/usr/bin/env python3
"""Adds a spoken voiceover to recorded tutorial videos.

For each tutorials/out/NN-name.mp4 with its NN-name.transcript.json, every caption and title
card is read aloud by Kokoro (https://huggingface.co/hexgrad/Kokoro-82M, an open-weight
text-to-speech model, Apache-2.0) and placed at the moment it appears on screen. It writes:

  NN-name.narrated.mp4   the video with the voiceover and music (the video stream is copied unchanged)
  NN-name.narration.mp3  the soundtrack alone, as long as the video (e.g. to add in a video editor)

Voices alternate between videos (--voices, by tutorial number: odd numbers get the first voice).
Intro music fades in under the title card and out as the tutorial starts, and the end of the
same piece plays under the closing card; it is lowered whenever the voice speaks. The music is
"Inspired" by Kevin MacLeod (incompetech.com), licensed under Creative Commons: By Attribution
4.0 (https://creativecommons.org/licenses/by/4.0/), downloaded once and checked by SHA-256; the
closing card of every video credits it. --music none leaves it out.

A line too long for its slot (until the next caption appears) is spoken faster, up to
--max-speed; a line that still does not fit runs on, and the report lists it. Words the voice
gets wrong can be fixed in pronunciations.json, next to this script.

  pip install kokoro soundfile          # Python 3.10-3.12; needs ffmpeg
  python scripts/tutorials/narrate.py                    # every recorded tutorial
  python scripts/tutorials/narrate.py 03 12 --voices af_heart

Voices: bf_emma, bf_isabella, bm_george, bm_lewis (British English); af_heart, af_bella,
am_michael, am_fenrir (American English); more at the model's page (VOICES.md).
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

RATE = 24000  # Kokoro's sample rate
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
OUT = ROOT / 'tutorials' / 'out'

# Intro music: "Inspired" by Kevin MacLeod (incompetech.com), CC BY 4.0. Credited on the
# closing card of every video (lib.mjs, MUSIC_CREDIT).
MUSIC_URL = 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Inspired.mp3'
MUSIC_SHA256 = '40b1af74145cedac77814d060155ad4658e04efa14d1b649decedc98fbb25f69'
MUSIC_FILE = ROOT / '.cache' / 'tutorial-music' / 'Inspired.mp3'
OUTRO_END_BEFORE = 12.5  # seconds before the piece ends where its last loud passage ends


def load_rules():
    rules = json.loads((HERE / 'pronunciations.json').read_text(encoding='utf-8'))['rules']
    return [(re.compile(a), b) for a, b in rules]


def spoken(text, rules):
    for pattern, repl in rules:
        text = pattern.sub(repl, text)
    return text.strip()


def synth(pipeline, text, voice, speed):
    parts = [np.asarray(audio, dtype=np.float32) for _, _, audio in pipeline(text, voice=voice, speed=speed)]
    return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)


def trim_silence(audio, threshold=0.004):
    """Drops near-silence at the start and end, so a line starts when its caption does."""
    loud = np.flatnonzero(np.abs(audio) > threshold)
    if loud.size == 0:
        return audio
    pad = int(0.03 * RATE)
    return audio[max(0, loud[0] - pad):loud[-1] + pad]


def music_path(arg):
    """The music file to use: a path, 'none', or the pinned default (downloaded once)."""
    if arg == 'none':
        return None
    if arg != 'default':
        return Path(arg)
    if not MUSIC_FILE.exists():
        import urllib.request
        MUSIC_FILE.parent.mkdir(parents=True, exist_ok=True)
        print(f'downloading {MUSIC_URL}', flush=True)
        req = urllib.request.Request(MUSIC_URL, headers={'User-Agent': 'webGrainy-tutorials'})
        with urllib.request.urlopen(req, timeout=120) as r:
            MUSIC_FILE.write_bytes(r.read())
    import hashlib
    got = hashlib.sha256(MUSIC_FILE.read_bytes()).hexdigest()
    if got != MUSIC_SHA256:
        sys.exit(f'{MUSIC_FILE}: SHA-256 {got}, expected {MUSIC_SHA256} (delete it to download again)')
    return MUSIC_FILE


def decode(path):
    """Any audio file as mono float32 at RATE."""
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-ac', '1', '-ar', str(RATE), '-f', 'f32le', '-'],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def ramp(n, up):
    x = np.linspace(0, 1, max(1, n), dtype=np.float32)
    w = 0.5 - 0.5 * np.cos(np.pi * x)  # smooth S-curve
    return w if up else w[::-1]


def add_music(track, music, segs, duration, level):
    """Intro music under the title card and the piece's ending under the closing card,
    lowered (ducked) while the voice speaks."""
    music = music / (np.sqrt(np.mean(music[:30 * RATE] ** 2)) + 1e-9) * level
    layer = np.zeros_like(track)
    # Intro: from the start of the piece, fading out over 2.5 s after the title card.
    intro_end = min(len(track), int((float(segs[0]['end']) + 2.0) * RATE)) if segs else 0
    n = min(intro_end, len(music))
    if n > 0:
        m = music[:n].copy()
        m[:int(0.8 * RATE)] *= ramp(min(n, int(0.8 * RATE)), True)
        f = min(n, int(2.5 * RATE))
        m[n - f:] *= ramp(f, False)
        layer[:n] += m
    # Outro: the piece's last full passage (its final 13 s are a quiet decay), fading in under the
    # closing card and out as the video ends.
    if segs and segs[-1].get('kind') == 'end':
        start = max(0, int((float(segs[-1]['start']) - 0.6) * RATE))
        n = len(track) - start
        stop = max(n, len(music) - int(OUTRO_END_BEFORE * RATE))
        tail = music[max(0, stop - n):stop]
        n = min(n, len(tail))
        if n > 0:
            m = tail[-n:].copy()
            m[:int(1.2 * RATE)] *= ramp(min(n, int(1.2 * RATE)), True)
            f = min(n, int(2.5 * RATE))
            m[n - f:] *= ramp(f, False)
            layer[start:start + n] += m
    # Duck under the voice: 30% level while speaking, easing over about 0.3 s.
    w = int(0.05 * RATE)
    blocks = np.abs(track[:len(track) // w * w]).reshape(-1, w).max(axis=1)
    speaking = (blocks > 0.02).astype(np.float32)
    k = 6  # spread 0.3 s either side so the music dips just before and after speech
    speaking = np.convolve(speaking, np.ones(2 * k + 1), mode='same') > 0
    gain = np.where(speaking, 0.3, 1.0).astype(np.float32)
    gain = np.convolve(gain, np.ones(5) / 5, mode='same')  # smooth the steps
    gain = np.repeat(gain, w)
    gain = np.concatenate([gain, np.full(len(track) - len(gain), gain[-1] if len(gain) else 1.0, dtype=np.float32)])
    return track + layer * gain


def narrate(name, pipeline, voice, args, rules, music):
    t = json.loads((OUT / f'{name}.transcript.json').read_text(encoding='utf-8'))
    segs = t['segments']
    duration = float(t['duration'])
    track = np.zeros(int((duration + 1) * RATE), dtype=np.float32)
    notes = []
    spoken_until = 0.0
    for i, seg in enumerate(segs):
        text = spoken(seg['text'], rules)
        if not text:
            continue
        start = float(seg['start']) + args.lead
        # The line may use the time until the next caption appears (or the end of the video).
        nxt = float(segs[i + 1]['start']) if i + 1 < len(segs) else duration
        slot = max(0.5, nxt - start - args.gap)
        # Never start before the previous line has finished (plus a short breath).
        if start < spoken_until + 0.15:
            slot -= spoken_until + 0.15 - start
            start = spoken_until + 0.15
        slot = max(0.5, slot)
        speed = args.speed
        audio = trim_silence(synth(pipeline, text, voice, speed))
        for _ in range(3):  # speed up until it fits (speech length is not exactly 1/speed)
            if len(audio) / RATE <= slot or speed >= args.max_speed:
                break
            speed = min(args.max_speed, speed * (len(audio) / RATE) / slot * 1.03)
            audio = trim_silence(synth(pipeline, text, voice, speed))
        length = len(audio) / RATE
        spoken_until = start + length
        if speed > args.speed + 1e-3:
            notes.append(f'  {seg["start"]:7.1f}s spoken at {speed:.2f}× to fit {slot:.1f} s')
        if length > slot + 0.05:
            notes.append(f'  {seg["start"]:7.1f}s runs {length - slot:.1f} s past its slot: "{text[:60]}…"')
        a = int(start * RATE)
        end = min(len(track), a + len(audio))
        track[a:end] += audio[:end - a] * args.volume
    track = track[:int(duration * RATE) + RATE // 2]
    if music is not None:
        track = add_music(track, music, segs, duration, args.music_level)
    track = np.clip(track, -1, 1)

    wav = OUT / f'{name}.narration.wav'
    import soundfile as sf
    sf.write(wav, track, RATE)
    mp3 = OUT / f'{name}.narration.mp3'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(wav), '-c:a', 'libmp3lame', '-b:a', '160k', str(mp3)], check=True)
    mp4 = OUT / f'{name}.narrated.mp4'
    subprocess.run([
        'ffmpeg', '-v', 'error', '-y', '-i', str(OUT / f'{name}.mp4'), '-i', str(wav),
        '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
        '-af', 'apad', '-shortest', '-movflags', '+faststart', str(mp4),
    ], check=True)
    wav.unlink()
    return mp4, notes


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('only', nargs='*', help='tutorial numbers or names to narrate (default: all recorded)')
    ap.add_argument('--voices', default='bf_emma,bm_george',
                    help='Kokoro voices, comma-separated, alternating by tutorial number (default bf_emma,bm_george: '
                         'British English, female then male); give one to use it for every video')
    ap.add_argument('--music', default='default', help="intro music file, 'none' for no music (default: the pinned track)")
    ap.add_argument('--music-level', type=float, default=0.09, help='music loudness (RMS, default 0.09)')
    ap.add_argument('--speed', type=float, default=1.0, help='speaking speed (default 1.0)')
    ap.add_argument('--max-speed', type=float, default=1.25, help='fastest speed used to fit a long line (default 1.25)')
    ap.add_argument('--lead', type=float, default=0.25, help='seconds after a caption appears before it is spoken (default 0.25)')
    ap.add_argument('--gap', type=float, default=0.2, help='silence kept before the next caption (default 0.2 s)')
    ap.add_argument('--volume', type=float, default=0.9, help='voice level, 0-1 (default 0.9)')
    args = ap.parse_args()

    names = sorted(p.name[:-len('.transcript.json')] for p in OUT.glob('*.transcript.json'))
    names = [n for n in names if (OUT / f'{n}.mp4').exists()]
    if args.only:
        names = [n for n in names if any(n.startswith(o.zfill(2)) or o in n for o in args.only)]
    if not names:
        sys.exit(f'No recorded tutorials with transcripts in {OUT}')

    from kokoro import KPipeline
    voices = [v.strip() for v in args.voices.split(',') if v.strip()]
    pipelines = {}  # one per language: a = American English, b = British English, ...
    rules = load_rules()
    mpath = music_path(args.music)
    music = decode(mpath) if mpath else None
    for name in names:
        number = int(name[:2]) if name[:2].isdigit() else 1
        voice = voices[(number - 1) % len(voices)]
        if voice[0] not in pipelines:
            pipelines[voice[0]] = KPipeline(lang_code=voice[0], repo_id='hexgrad/Kokoro-82M')
        mp4, notes = narrate(name, pipelines[voice[0]], voice, args, rules, music)
        print(f'{mp4.name} ({voice})', flush=True)
        for n in notes:
            print(n, flush=True)


if __name__ == '__main__':
    main()
