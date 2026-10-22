#!/usr/bin/env python3
"""Cut a recording into utterances and start a labels file for them.

    python3 training/wake/segment.py <recording.wav> <out dir> [--every-nth-test 2]

The recording is what `record_users --keep-gaps` writes: one speaker, 16 kHz
mono, with the quiet between utterances kept. Each stretch of speech followed
by at least 0.6s of quiet becomes `<out dir>/<stem>-NN.wav`, with 0.3s of
context either side, and a line in `<out dir>/train.tsv` (or `test.tsv`):

    <stem>-NN.wav<TAB>EMHARA

Every line starts as the bare name. Edit the ones where a command followed it
(`EMHARA SKIP THIS SONG`), and delete lines for anything that was not the name
at all. Transcripts are upper-case English words; the name is always written
EMHARA, whatever it sounded like, because that is the word the model is
being taught.

`--every-nth-test N` sends every Nth utterance to test.tsv instead, so the
model is scored on recordings it never trained on.

Standard library only, so it runs with any Python 3.
"""

import argparse
import array
import math
import wave
from pathlib import Path

FRAME = 320  # 20ms at 16 kHz
LOUD = 300  # RMS, on 16-bit samples
QUIET_FRAMES = 30  # 0.6s ends an utterance
CONTEXT_FRAMES = 15  # 0.3s kept either side


def main():
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("recording", type=Path)
	parser.add_argument("out", type=Path)
	parser.add_argument("--every-nth-test", type=int, default=0)
	args = parser.parse_args()

	with wave.open(str(args.recording)) as source:
		if (source.getframerate(), source.getnchannels(), source.getsampwidth()) != (16000, 1, 2):
			raise SystemExit(f"{args.recording}: expected 16 kHz mono 16-bit, as record_users writes")
		samples = array.array("h", source.readframes(source.getnframes()))

	loud = []
	for start in range(0, len(samples) - FRAME + 1, FRAME):
		frame = samples[start : start + FRAME]
		loud.append(math.sqrt(sum(sample * sample for sample in frame) / FRAME) > LOUD)

	spans, start, quiet = [], None, 0
	for index, is_loud in enumerate(loud):
		if is_loud:
			start = index if start is None else start
			quiet = 0
		elif start is not None:
			quiet += 1
			if quiet >= QUIET_FRAMES:
				spans.append((start, index - quiet + 1))
				start = None
	if start is not None:
		spans.append((start, len(loud)))

	args.out.mkdir(parents=True, exist_ok=True)
	stem = args.recording.stem
	lines = {"train": [], "test": []}
	for number, (first, last) in enumerate(spans):
		first = max(0, first - CONTEXT_FRAMES)
		last = min(len(loud), last + CONTEXT_FRAMES)
		name = f"{stem}-{number:02d}.wav"
		with wave.open(str(args.out / name), "wb") as clip:
			clip.setnchannels(1)
			clip.setsampwidth(2)
			clip.setframerate(16000)
			clip.writeframes(samples[first * FRAME : last * FRAME].tobytes())
		split = "test" if args.every_nth_test and number % args.every_nth_test == args.every_nth_test - 1 else "train"
		lines[split].append(f"{name}\tEMHARA\n")

	for split, entries in lines.items():
		if entries:
			with open(args.out / f"{split}.tsv", "a", encoding="utf-8") as labels:
				labels.writelines(entries)
	print(f"{len(spans)} utterances: {len(lines['train'])} to train.tsv, {len(lines['test'])} to test.tsv in {args.out}")


if __name__ == "__main__":
	main()
