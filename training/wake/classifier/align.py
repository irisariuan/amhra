#!/usr/bin/env python3
"""Where the name ends in each training positive.

A classifier learns to fire on the second of audio that ends just after the
name, so every positive needs that point. The fine-tuned spotter already
knows the name; run over each positive with a low threshold, it says where
it heard the name end. Positives it does not hear are left out rather than
guessed at.

    python3 training/wake/classifier/align.py

Writes work/data/align.tsv: file, then the seconds at which the name ends.
"""

import argparse
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
WAKE = HERE.parent
ROOT = WAKE.parent.parent
DATA = WAKE / "work" / "data"
BATCH = 200


def positives():
	"""Every training positive: synthesised, recorded and collected."""
	files = []
	for line in (DATA / "tts" / "transcripts.tsv").read_text(encoding="utf-8").splitlines():
		name, text = line.split("\t", 1)
		if text.split()[:1] == ["EMHARA"]:
			files.append(DATA / "tts" / name)
	for split in ("real", "collected"):
		for line in (DATA / split / "train.tsv").read_text(encoding="utf-8").splitlines():
			if line.strip():
				files.append(DATA / split / line.split("\t", 1)[0])
	return files


def main():
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("--wake-model", type=Path, default=ROOT / "models/voice/kws-echo-e1")
	parser.add_argument("--threshold", default="0.15")
	parser.add_argument("--harness", default=str(ROOT / "rust/target/release/examples/wake_wav"))
	args = parser.parse_args()

	files = positives()
	ends = {}
	for start in range(0, len(files), BATCH):
		batch = files[start : start + BATCH]
		output = subprocess.run(
			[
				args.harness,
				"--verbose",
				"--wake-model", str(args.wake_model.resolve()),
				"--keywords", str(WAKE / "keywords.txt"),
				"--threshold", args.threshold,
				"--tail-ms", "1500",
				*map(str, batch),
			],
			check=True, capture_output=True, text=True, cwd=ROOT,
		).stdout
		current = None
		for line in output.splitlines():
			header = re.match(r"^(\S+\.wav) \(", line)
			if header:
				current = Path(header.group(1)).resolve()
				continue
			ended = re.search(r"says it ended at ([0-9.]+)s", line)
			# The first time it is heard is the name at the start.
			if current and ended and current not in ends:
				ends[current] = float(ended.group(1))
	with (DATA / "align.tsv").open("w", encoding="utf-8") as out:
		for path in files:
			if path.resolve() in ends:
				out.write(f"{path.relative_to(DATA)}\t{ends[path.resolve()]:.2f}\n")
	print(f"aligned {len(ends)} of {len(files)} positives")
	for group in ("tts/pos", "tts/probe", "real/", "collected/"):
		total = sum(1 for path in files if str(path.relative_to(DATA)).startswith(group))
		found = sum(1 for path in ends if str(path.relative_to(DATA.resolve())).startswith(group))
		print(f"  {group}: {found}/{total}")


if __name__ == "__main__":
	main()
