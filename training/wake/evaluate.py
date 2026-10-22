#!/usr/bin/env python3
"""Score a spotter: how many held-out names it hears, how often it fires on
anything else.

    python3 training/wake/evaluate.py --wake-model models/voice/kws-emhara \\
        --keywords training/wake/keywords.txt [--threshold 0.25] [negatives.wav …]

The held-out recordings are the clips listed in work/data/real/test.tsv,
which training never sees. They are joined into one recording with 1.5s of
silence between them, which is how the sidecar hears a call, and the
`wake_wav` harness runs over it: recall is wakes over the number of times
EMHARA appears in those labels. Every negative recording given is run too;
any wake in one is a false one, reported per hour of audio.

Without `--wake-model`, the stock spotter is scored the same way, for
comparison. Standard library only.
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
GAP = array.array("h", [0] * 24000)


def join_test_clips():
	"""The held-out clips as one recording, and how many names are in it."""
	samples, names = array.array("h"), 0
	for line in (REAL / "test.tsv").read_text(encoding="utf-8").splitlines():
		if not line.strip():
			continue
		file, text = line.split("\t", 1)
		names += text.split().count("EMHARA")
		with wave.open(str(REAL / file)) as clip:
			samples.extend(array.array("h", clip.readframes(clip.getnframes())))
		samples.extend(GAP)
	path = REAL / "test-joined.wav"
	with wave.open(str(path), "wb") as joined:
		joined.setnchannels(1)
		joined.setsampwidth(2)
		joined.setframerate(16000)
		joined.writeframes(samples.tobytes())
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
	parser.add_argument("negatives", nargs="*", type=Path)
	args = parser.parse_args()

	options = ["--keywords", str(args.keywords.resolve()), "--tail-ms", "1500"]
	if args.wake_model:
		options += ["--wake-model", str(args.wake_model.resolve())]
	if args.threshold is not None:
		options += ["--threshold", str(args.threshold)]

	test, names = join_test_clips()
	found, _ = wakes(args.harness, options, [test])
	heard = sum(found.values())
	print(f"held-out names: {heard}/{names} woke ({100 * min(heard, names) / max(names, 1):.0f}%)")

	if args.negatives:
		found, seconds = wakes(args.harness, options, [path.resolve() for path in args.negatives])
		false = sum(found.values())
		print(f"false wakes: {false} in {seconds / 60:.1f} minutes of negatives ({false / max(seconds, 1) * 3600:.1f} per hour)")
		for path, count in sorted(found.items()):
			if count:
				print(f"  {count} in {Path(path).name}")


if __name__ == "__main__":
	main()
