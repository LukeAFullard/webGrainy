#!/usr/bin/env python3
"""Adds a spoken voiceover to recorded tutorial videos.

For each tutorials/out/NN-name.mp4 with its NN-name.transcript.json, every caption and title
card is read aloud by Kokoro (https://huggingface.co/hexgrad/Kokoro-82M, an open-weight
text-to-speech model, Apache-2.0) and placed at the moment it appears on screen. It writes:

  NN-name.narrated.mp4   the video with the voiceover (the video stream is copied unchanged)
  NN-name.narration.mp3  the voiceover alone, as long as the video (e.g. to add in a video editor)

A line too long for its slot (until the next caption appears) is spoken faster, up to
--max-speed; a line that still does not fit runs on, and the report lists it. Words the voice
gets wrong can be fixed in pronunciations.json, next to this script.

  pip install kokoro soundfile          # Python 3.10-3.12; needs ffmpeg
  python scripts/tutorials/narrate.py                    # every recorded tutorial
  python scripts/tutorials/narrate.py 03 12 --voice af_heart

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
OUT = HERE.parent.parent / 'tutorials' / 'out'


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


def narrate(name, pipeline, voice, args, rules):
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
    track = np.clip(track[:int(duration * RATE) + RATE // 2], -1, 1)

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
    ap.add_argument('--voice', default='bf_emma', help='Kokoro voice (default bf_emma, British English)')
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
    lang = args.voice[0]  # a = American English, b = British English, ...
    pipeline = KPipeline(lang_code=lang, repo_id='hexgrad/Kokoro-82M')
    rules = load_rules()
    for name in names:
        mp4, notes = narrate(name, pipeline, args.voice, args, rules)
        print(f'{mp4.name}', flush=True)
        for n in notes:
            print(n, flush=True)


if __name__ == '__main__':
    main()
