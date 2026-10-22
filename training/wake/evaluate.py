#!/usr/bin/env python3
"""Score a spotter: how many held-out names it hears, how often it fires on
anything else.

    python3 training/wake/evaluate.py --wake-model models/voice/kws-emhara \\
        --keywords training/wake/keywords.txt [--threshold 0.25] [--echo] [negatives.wav …]

The held-out recordings are the clips listed in work/data/real/test.tsv,
which training never sees, or in `--held-out <dir>`'s test.tsv. They are joined into one recording with 4s of
silence between them, and the `wake_wav` harness runs over it: recall is
wakes over the number of times EMHARA appears in those labels. The gap is
longer than the gate waits for a command after the name (2.5s), so each
name is listened for on its own rather than heard while a window is open.
Every negative recording given is run too; any wake in one is a false one,
reported per hour of audio.

`--echo` scores everything as heard across a room: each held-out clip and
each negative goes through its own simulated room first, the same rooms on
every run. They are not the rooms prepare.py trains with (lhotse's
generator); these are plain decaying noise, with up to 12dB more of the
room than of the speaker, so a model trained on echo is not scored
on the echo it learned. It needs numpy, which the training environment has.

Without `--wake-model`, the stock spotter is scored the same way, for
comparison. Otherwise standard library only.
"""

import argparse
import array
import re
import subprocess
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
REAL = HERE / "work" / "data" / "real"
ECHO = HERE / "work" / "data" / "echo-eval"
GAP = array.array("h", [0] * 64000)
RATE = 16000


class Rooms:
	"""Simulated rooms, the same sequence on every run."""

	def __init__(self):
		import numpy

		self.np = numpy
		self.rng = numpy.random.default_rng(2026)

	def apply(self, samples):
		"""`samples` (int16) as heard in the next room, at the same loudness."""
		np = self.np
		t60 = self.rng.uniform(0.3, 0.9)
		length = int(RATE * t60)
		tail = self.rng.standard_normal(length) * np.exp(-6.9 * np.arange(length) / length)
		tail[: int(RATE * 0.003)] = 0.0
		# How much louder the echo is than the speaker: the further from the
		# microphone, the more of the room it hears.
		ratio = self.rng.uniform(0.0, 12.0)
		tail *= np.sqrt(10 ** (ratio / 10) / np.sum(tail**2))
		tail[0] = 1.0
		dry = np.asarray(samples, dtype=np.float64)
		size = 1 << int(np.ceil(np.log2(len(dry) + length)))
		wet = np.fft.irfft(np.fft.rfft(dry, size) * np.fft.rfft(tail, size), size)[: len(dry)]
		wet *= np.sqrt(np.mean(dry**2) / max(np.mean(wet**2), 1e-9))
		return array.array("h", np.clip(wet, -32768, 32767).astype(np.int16).tobytes())


def write(path, samples):
	path.parent.mkdir(parents=True, exist_ok=True)
	with wave.open(str(path), "wb") as out:
		out.setnchannels(1)
		out.setsampwidth(2)
		out.setframerate(RATE)
		out.writeframes(samples.tobytes())


def read(path):
	with wave.open(str(path)) as clip:
		return array.array("h", clip.readframes(clip.getnframes()))


def join_test_clips(held_out=REAL, rooms=None):
	"""The held-out clips as one recording, and how many names are in it."""
	samples, names = array.array("h"), 0
	for line in (held_out / "test.tsv").read_text(encoding="utf-8").splitlines():
		if not line.strip():
			continue
		file, text = line.split("\t", 1)
		names += text.split().count("EMHARA")
		clip = read(held_out / file)
		samples.extend(rooms.apply(clip) if rooms else clip)
		samples.extend(GAP)
	path = (ECHO / held_out.name if rooms else held_out) / "test-joined.wav"
	write(path, samples)
	return path, names


def wakes(harness, options, paths):
	"""Wakes per file, and the audio's total length in seconds."""
	output = subprocess.run(
		[harness, *options, *map(str, paths)], check=True, capture_output=True, text=True, cwd=ROOT
	).stdout
	found, current, seconds = {}, None, 0.0
	for line in output.splitlines():
		header = re.match(r"^(\S+\.wav) \(([0-9.]+)s\)", line)
		if header:
			current = header.group(1)
			found[current] = 0
			seconds += float(header.group(2))
		elif current and "woke on" in line:
			found[current] += 1
	return found, seconds


def main():
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("--wake-model", type=Path)
	parser.add_argument("--keywords", type=Path, default=ROOT / "data" / "wake-keywords.txt")
	parser.add_argument("--threshold", type=float)
	parser.add_argument("--harness", default=str(ROOT / "rust/target/release/examples/wake_wav"))
	parser.add_argument("--echo", action="store_true", help="score everything as heard across a room")
	parser.add_argument("--held-out", type=Path, default=REAL, help="a directory of recordings with a test.tsv")
	parser.add_argument("negatives", nargs="*", type=Path)
	args = parser.parse_args()

	options = ["--keywords", str(args.keywords.resolve()), "--tail-ms", "1500"]
	if args.wake_model:
		options += ["--wake-model", str(args.wake_model.resolve())]
	if args.threshold is not None:
		options += ["--threshold", str(args.threshold)]

	rooms = Rooms() if args.echo else None
	test, names = join_test_clips(args.held_out.resolve(), rooms)
	found, _ = wakes(args.harness, options, [test])
	heard = sum(found.values())
	print(f"held-out names: {heard}/{names} woke ({100 * min(heard, names) / max(names, 1):.0f}%)")

	if args.negatives:
		negatives = [path.resolve() for path in args.negatives]
		if rooms:
			for index, path in enumerate(negatives):
				negatives[index] = ECHO / path.name
				write(negatives[index], rooms.apply(read(path)))
		found, seconds = wakes(args.harness, options, negatives)
		false = sum(found.values())
		print(f"false wakes: {false} in {seconds / 60:.1f} minutes of negatives ({false / max(seconds, 1) * 3600:.1f} per hour)")
		for path, count in sorted(found.items()):
			if count:
				print(f"  {count} in {Path(path).name}")


if __name__ == "__main__":
	main()
