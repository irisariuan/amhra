#!/usr/bin/env python3
"""Score the classifier on the same test audio evaluate.py scores the spotter on.

    training/wake/work/.venv/bin/python training/wake/classifier/score.py

Run evaluate.py first, with and without --echo, for the held-out takes with
the evaluation negatives, and for --held-out work/data/members-name and
work/data/members-chatter (from screen.py): this reads the joined recordings
and the room copies it wrote, so both models hear the very same audio.

A name counts as heard per clip: no more wakes than the clip has names, and
none in the silence between clips, so double wakes cannot make up for missed
names. A chatter clip counts if the model wakes in it at all. The headline
threshold is the one validation chose; the sweep under it is for reading
only, since choosing from it would be tuning on the test.
"""

import argparse
from pathlib import Path

import numpy as np
import torch

from common import DATA, RATE, Detector, WakeNet, device, joined_clips, read, stream_scores, wakes

ECHO = DATA / "echo-eval"


def recall(scores, ends, threshold, spans):
	found = wakes(scores, ends, threshold)
	names = sum(count for _, _, count in spans)
	capped = sum(min(sum(start <= at <= end + 0.5 for at in found), count) for start, end, count in spans)
	return len(found), capped, names


def main():
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("--model", type=Path, default=DATA.parent / "classifier" / "best.pt")
	args = parser.parse_args()

	saved = torch.load(args.model, map_location="cpu")
	net = WakeNet()
	net.load_state_dict(saved["net"])
	detector = Detector(net).to(device()).eval()
	chosen = saved["threshold"]
	print(f"model from step {saved['step']}, threshold {chosen:.2f} (chosen on validation)")

	tests = {"takes": "real", "members": "members-name", "chatter": "members-chatter"}
	sets = {}
	for room, base in (("clean", DATA), ("room", ECHO)):
		scored = {key: stream_scores(detector, read(base / folder / "test-joined.wav")) for key, folder in tests.items()}
		paths = sorted((DATA / "eval").glob("*.wav")) if room == "clean" else sorted(ECHO.glob("eval-*.wav"))
		negatives = [stream_scores(detector, read(path)) for path in paths]
		seconds = sum(len(read(path)) for path in paths) / RATE
		sets[room] = (scored, negatives, seconds)
	spans = {key: joined_clips(DATA / folder) for key, folder in tests.items()}

	def row(threshold):
		cells = []
		for room in ("clean", "room"):
			scored, negatives, seconds = sets[room]
			_, takes, names = recall(*scored["takes"], threshold, spans["takes"])
			_, members, member_names = recall(*scored["members"], threshold, spans["members"])
			fired = sum(any(start <= at <= end + 0.5 for at in wakes(*scored["chatter"], threshold)) for start, end, _ in spans["chatter"])
			false = sum(len(wakes(scores, ends, threshold)) for scores, ends in negatives)
			cells.append(
				f"{room}: takes {takes}/{names}, members {members}/{member_names}, "
				f"chatter {fired}/{len(spans['chatter'])}, {false / seconds * 3600:.1f} false/h"
			)
		return "  ".join(cells)

	print(f"\nat {chosen:.2f}: {row(chosen)}")
	print("\nsweep (for reading only):")
	for threshold in np.arange(0.5, 1.0, 0.05):
		print(f"  {threshold:.2f}  {row(threshold)}")


if __name__ == "__main__":
	main()
