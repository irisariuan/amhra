#!/usr/bin/env python3
"""Build the fine-tuning data: lhotse manifests of labelled speech.

    training/wake/work/.venv/bin/python training/wake/prepare.py

Reads, all under training/wake/work/data:

- `real/train.tsv`: recordings of the server's members, from segment.py.
  The most valuable data by far, and the scarcest, so each clip is used in
  several variants: through Opus at a few bitrates (what Discord does to
  voice), faster, slower, quieter and louder, and as heard across a room.
  `real/test.tsv` is never read here; it is for scoring the result.
  `--extra <dir>` adds another directory laid out the same way, such as
  wake clips the bot collected (README.md), read from its `train.tsv`.
- `tts/transcripts.tsv`: synthesised positives and negatives, from
  synthesize.py. Half again go through Opus.
- `LibriSpeech/dev-clean`: 5.4 hours of ordinary read English (CC BY 4.0),
  mixed in so the model keeps recognising speech in general while it learns
  the name. A model fine-tuned on the name alone fires on everything.

Room echo: someone speaking away from their microphone is heard with the
room's echo, which the spotter trained on close voices misses. `--echo`
(default 0.5) is the share of synthesised speech copied through a simulated
room and of LibriSpeech heard through one instead, each in its own random
room from lhotse (an echo of 0.1–0.8s, 0.2–12m from the microphone); every
real clip gets two echo variants. Echo goes on the negatives and ordinary
speech too, or the model would learn that echo means the name.

Writes `manifests/{wake_train,wake_valid,general}.jsonl.gz` under `--out`
(default work/data), with 80-bin fbank features computed up front under
`fbank/` beside them (the recipe trains on precomputed features), and the
Opus copies under work/data/opus. Rerun after adding recordings; existing
Opus copies are reused.
"""

import argparse
import random
import re
import subprocess
from pathlib import Path

import torch
from lhotse import (
	CutSet,
	Fbank,
	FbankConfig,
	LilcomChunkyWriter,
	Recording,
	RecordingSet,
	SupervisionSegment,
	SupervisionSet,
)

WORK = Path(__file__).resolve().parent / "work"
DATA = WORK / "data"
# Discord's voice bitrate is 64kbps by default and lower on boosted servers'
# lowest settings; the model should not care which.
OPUS_BITRATES = ["24k", "40k", "64k"]


def clean(text):
	"""Upper-case words, as the model's vocabulary is written."""
	return re.sub(r"\s+", " ", re.sub(r"[^A-Z' ]", " ", text.upper())).strip()


def opus(source, bitrate):
	"""`source` after an Opus round trip, cached under data/opus."""
	target = DATA / "opus" / bitrate / f"{source.parent.name}-{source.stem}.wav"
	if not target.exists():
		target.parent.mkdir(parents=True, exist_ok=True)
		subprocess.run(
			[
				"ffmpeg", "-loglevel", "error", "-y", "-i", str(source),
				"-c:a", "libopus", "-b:a", bitrate, "-application", "voip", str(target.with_suffix(".ogg")),
			],
			check=True,
		)
		subprocess.run(
			["ffmpeg", "-loglevel", "error", "-y", "-i", str(target.with_suffix(".ogg")), "-ar", "16000", "-ac", "1", str(target)],
			check=True,
		)
		target.with_suffix(".ogg").unlink()
	return target


def labelled(directory, tsv):
	"""(path, transcript) pairs from a `<file><TAB><text>` list."""
	pairs = []
	for line in (directory / tsv).read_text(encoding="utf-8").splitlines():
		if line.strip():
			name, text = line.split("\t", 1)
			pairs.append((directory / name, clean(text)))
	return pairs


def cuts(pairs, prefix):
	recordings, supervisions = [], []
	for number, (path, text) in enumerate(pairs):
		recording_id = f"{prefix}-{number:05d}-{path.stem}"
		recording = Recording.from_file(path, recording_id=recording_id)
		recordings.append(recording)
		supervisions.append(
			SupervisionSegment(
				id=recording_id, recording_id=recording_id, start=0.0,
				duration=recording.duration, channel=0, text=text, language="English",
			)
		)
	return CutSet.from_manifests(
		recordings=RecordingSet.from_recordings(recordings),
		supervisions=SupervisionSet.from_segments(supervisions),
	)


def save(cutset, name, jobs, out):
	"""Compute features for `cutset` and write its manifest."""
	storage = out / "fbank" / name
	storage.mkdir(parents=True, exist_ok=True)
	with_features = cutset.compute_and_store_features(
		extractor=Fbank(FbankConfig(num_mel_bins=80)),
		storage_path=storage,
		num_jobs=jobs,
		storage_type=LilcomChunkyWriter,
	)
	with_features.to_file(out / "manifests" / f"{name}.jsonl.gz")
	return with_features


def main():
	# Feature extraction runs in worker processes; threads within each only
	# contend (and can deadlock, lhotse warns).
	torch.set_num_threads(1)
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("--general-hours", type=float, default=5.4, help="how much LibriSpeech to mix in (all of dev-clean)")
	parser.add_argument("--real-repeat", type=int, default=4, help="times each real variant appears per epoch")
	parser.add_argument("--extra", type=Path, action="append", default=[], help="another directory of recordings with a train.tsv")
	parser.add_argument("--echo", type=float, default=0.5, help="share of synthesised and ordinary speech heard through a simulated room")
	parser.add_argument("--out", type=Path, default=DATA, help="where manifests/ and fbank/ go")
	parser.add_argument("--seed", type=int, default=7)
	parser.add_argument("--jobs", type=int, default=8)
	args = parser.parse_args()
	rng = random.Random(args.seed)
	out = args.out.resolve()
	(out / "manifests").mkdir(parents=True, exist_ok=True)

	# Real recordings, each in every variant.
	real = labelled(DATA / "real", "train.tsv")
	for directory in args.extra:
		real += labelled(directory.resolve(), "train.tsv")
	real_pairs = list(real)
	for path, text in real:
		real_pairs += [(opus(path, bitrate), text) for bitrate in OPUS_BITRATES]
	real_cuts = cuts(real_pairs, "real")
	variants = [real_cuts]
	for factor in (0.9, 1.1):
		variants.append(real_cuts.perturb_speed(factor))
	for factor in (0.5, 1.8):
		variants.append(real_cuts.perturb_volume(factor))
	if args.echo > 0:
		variants.append(real_cuts.reverb_rir())
		variants.append(real_cuts.reverb_rir().perturb_volume(0.5))
	real_all = CutSet.from_cuts(cut for variant in variants for cut in variant)

	# Synthesised speech: a validation slice held out, half the rest via Opus.
	tts = labelled(DATA / "tts", "transcripts.tsv")
	rng.shuffle(tts)
	held = max(20, len(tts) // 20)
	valid, train = tts[:held], tts[held:]
	train += [(opus(path, rng.choice(OPUS_BITRATES)), text) for path, text in train if rng.random() < 0.5]
	tts_cuts = cuts(train, "tts")
	tts_all = list(tts_cuts) + list(tts_cuts.perturb_speed(rng.choice((0.9, 1.1))))
	tts_all += [cut.reverb_rir() for cut in tts_cuts if rng.random() < args.echo]
	tts_all = CutSet.from_cuts(tts_all)

	wake = CutSet.from_cuts([cut for _ in range(args.real_repeat) for cut in real_all] + list(tts_all)).shuffle(rng)
	save(wake, "wake_train", args.jobs, out)
	save(cuts(valid, "valid"), "wake_valid", args.jobs, out)

	# Ordinary speech, so the rest of the vocabulary is not forgotten.
	libri = []
	for transcript in sorted((DATA / "LibriSpeech" / "dev-clean").glob("*/*/*.trans.txt")):
		for line in transcript.read_text().splitlines():
			utterance, text = line.split(" ", 1)
			libri.append((transcript.parent / f"{utterance}.flac", clean(text)))
	rng.shuffle(libri)
	general = cuts(libri, "libri")
	kept, seconds = [], 0.0
	for cut in general:
		if seconds >= args.general_hours * 3600:
			break
		kept.append(cut.reverb_rir() if rng.random() < args.echo else cut)
		seconds += cut.duration
	save(CutSet.from_cuts(kept), "general", args.jobs, out)

	hours = lambda cutset: sum(cut.duration for cut in cutset) / 3600
	print(
		f"wake: {len(wake)} cuts ({hours(wake):.2f}h; {len(real)} real clips in {len(real_all)} variants x{args.real_repeat}), "
		f"valid: {held} cuts, general: {len(kept)} cuts ({seconds / 3600:.2f}h)"
	)


if __name__ == "__main__":
	main()
