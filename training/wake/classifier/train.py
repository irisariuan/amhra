#!/usr/bin/env python3
"""Train a dedicated wake word classifier, for comparison with the spotter.

    training/wake/work/.venv/bin/python training/wake/classifier/train.py [--steps 12000]

Run align.py first. Everything is read from work/data and the model written
to work/classifier/:

- positives: the synthesised takes, your recorded takes and those of your
  collected clips screen.py found to be the name, each a window ending just
  after the name (from align.tsv);
- negatives: the synthesised near misses, LibriSpeech, your collected clips
  that screen.py found to be conversation, and windows from the positives
  that end before the name is finished or well after it;
- hard negatives: every few thousand steps the training negatives are scored
  as a stream, and the windows the model is surest of are trained on again.

Validation, which chooses the threshold and the checkpoint, is held-out
synthetic voices, held-out LibriSpeech speakers and some of your collected
clips, the negatives both as they are and across simulated rooms (lhotse's,
with their own seed). The test sets (your held-out takes, the other members' clips, the
evaluation negatives) are not read here at all: score.py scores them once.
"""

import argparse
import json
import random
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from common import DATA, RATE, WINDOW, Detector, WakeNet, device, read, stream_scores, wakes

OUT = DATA.parent / "classifier"
# The most a window is stretched or squeezed, as a speed change.
SPEED = 0.12
SOURCE = int(WINDOW * (1 + SPEED)) + 2
# A positive window ends this long after the name.
AFTER = (0.02, 0.15)
# Windows from a positive that are not it: ending before the name is over…
EARLY = (0.2, 0.5)
# …or with the name well back in the window.
LATE = (0.45, 1.2)
# Silence between files strung together into one pool.
GAP = np.zeros(RATE, np.int16)


class Pool:
	"""Files strung together, to cut windows from by where they end."""

	def __init__(self, paths, gap=GAP):
		parts, self.starts = [np.zeros(SOURCE, np.int16)], []
		at = SOURCE
		for path in paths:
			samples = read(path)
			self.starts.append(at)
			parts += [samples, gap]
			at += len(samples) + len(gap)
		parts.append(np.zeros(SOURCE, np.int16))
		self.samples = np.concatenate(parts)

	def __len__(self):
		return len(self.samples)

	def seconds(self):
		return len(self.samples) / RATE

	def window(self, end):
		"""The SOURCE samples ending at sample `end`."""
		end = int(np.clip(end, SOURCE, len(self.samples)))
		return self.samples[end - SOURCE : end]

	def random_end(self, rng):
		return rng.integers(SOURCE, len(self.samples))


def voice(name):
	"""The synthesised voice a file is in: pos-<voice>-…, neg-<voice>-…"""
	return name.split("-")[1]


def screened():
	"""Each collected clip's label from screen.py: name, chatter or unclear."""
	rows = (DATA / "collected" / "review.tsv").read_text(encoding="utf-8").splitlines()[1:]
	return {row.split("\t")[0]: row.split("\t")[4] for row in rows}


def splits(seed):
	rng = random.Random(seed)
	labels = screened()
	aligned = []
	for line in (DATA / "align.tsv").read_text(encoding="utf-8").splitlines():
		file, end = line.split("\t")
		end = float(end)
		# The aligner sometimes hears the command instead; those are dropped.
		if file.startswith("collected/") and not 0.8 <= end <= 1.3:
			continue
		# Only clips that sound like the name: a fifth are conversation the
		# deployed spotter woke on.
		if file.startswith("collected/") and labels.get(Path(file).name) != "name":
			continue
		if not file.startswith("collected/") and end > 1.5:
			continue
		aligned.append((file, end))

	voices = sorted({voice(Path(file).name) for file, _ in aligned if file.startswith("tts/")})
	held_voices = set(voices[3::7])
	collected = sorted(file for file, _ in aligned if file.startswith("collected/"))
	rng.shuffle(collected)
	held_clips = set(collected[: len(collected) // 6])

	def held(file):
		return (file.startswith("tts/") and voice(Path(file).name) in held_voices) or file in held_clips

	positives = {"train": [], "valid": []}
	for file, end in aligned:
		positives["valid" if held(file) else "train"].append((DATA / file, end))

	negatives = {"train": [], "valid": []}
	for line in (DATA / "tts" / "transcripts.tsv").read_text(encoding="utf-8").splitlines():
		file = line.split("\t", 1)[0]
		if file.startswith("neg-"):
			negatives["valid" if voice(file) in held_voices else "train"].append(DATA / "tts" / file)

	# Your clips that are conversation: real call audio of just what it must
	# not wake on. The other members' are kept for the test.
	chatter = sorted(file for file, got in labels.items() if got == "chatter" and file in train_clips())
	rng.shuffle(chatter)
	calls = {"train": [], "valid": []}
	for index, file in enumerate(chatter):
		calls["valid" if index % 6 == 0 else "train"].append(DATA / "collected" / file)

	speakers = sorted(p for p in (DATA / "LibriSpeech" / "dev-clean").iterdir() if p.is_dir())
	held_speakers = set(speakers[::7])
	libri = {"train": [], "valid": []}
	for speaker in speakers:
		libri["valid" if speaker in held_speakers else "train"] += sorted(speaker.glob("*/*.flac"))
	return positives, negatives, libri, calls, sorted(held_voices)


def train_clips():
	"""The collected clips that are yours, and so may be trained on."""
	lines = (DATA / "collected" / "train.tsv").read_text(encoding="utf-8").splitlines()
	return {line.split("\t", 1)[0] for line in lines if line.strip()}


class Rooms:
	"""Simulated rooms from lhotse, as prepare.py trains the spotter with; not
	the rooms evaluate.py scores with."""

	def __init__(self, count, seed, dev):
		from lhotse.augmentation.utils import FastRandomRIRGenerator

		generator = FastRandomRIRGenerator(sr=RATE, room_seed=seed, source_seed=seed + 1)
		rirs = [np.asarray(generator(nsource=1), dtype=np.float32).reshape(-1) for _ in range(count)]
		length = min(max(len(r) for r in rirs), RATE)
		bank = np.zeros((count, length), np.float32)
		for index, rir in enumerate(rirs):
			rir = rir[:length]
			bank[index, : len(rir)] = rir / (np.abs(rir).max() + 1e-9)
		self.bank = torch.from_numpy(bank).to(dev)

	def apply(self, audio, which):
		"""`audio` (batch x samples) through the rooms numbered `which`, at the same loudness."""
		rir = self.bank[which]
		size = 1 << int(np.ceil(np.log2(audio.shape[1] + rir.shape[1])))
		# MPS has no FFT for every size; the CPU does this quickly enough.
		wet = torch.fft.irfft(torch.fft.rfft(audio.cpu(), size) * torch.fft.rfft(rir.cpu(), size), size)
		wet = wet[:, : audio.shape[1]].to(audio.device)
		scale = audio.pow(2).mean(1, keepdim=True).sqrt() / wet.pow(2).mean(1, keepdim=True).sqrt().clamp_min(1e-7)
		return wet * scale


def in_rooms(stream, rooms, piece=10 * RATE):
	"""`stream` heard through a different room every ten seconds."""
	out = []
	for index, start in enumerate(range(0, len(stream), piece)):
		audio = torch.from_numpy(stream[start : start + piece].astype(np.float32)[None] / 32768.0)
		which = torch.tensor([index % rooms.bank.shape[0]])
		wet = rooms.apply(audio, which)[0].numpy()
		out.append(np.clip(wet * 32768.0, -32768, 32767).astype(np.int16))
	return np.concatenate(out)


class Batches:
	def __init__(self, positives, negatives, libri, calls, dev, seed):
		self.rng = np.random.default_rng(seed)
		self.dev = dev
		self.positives = Pool([path for path, _ in positives])
		self.ends = np.array([start + int(end * RATE) for start, (_, end) in zip(self.positives.starts, positives)])
		self.negatives = Pool(negatives)
		self.libri = Pool(libri, gap=np.zeros(0, np.int16))
		# A few dozen seconds, so drawn from on purpose, or it would hardly be.
		self.calls = Pool(calls)
		self.hard = []  # (pool, end)
		self.rooms = Rooms(400, seed, dev)

	def _cut(self, pool, end):
		return pool.window(end)

	def make(self, size):
		"""Raw windows and labels: a quarter positives."""
		rng = self.rng
		windows, labels = [], []
		positives = size // 4
		for _ in range(positives):
			end = rng.choice(self.ends) + int(rng.uniform(*AFTER) * RATE)
			windows.append(self.positives.window(end))
			labels.append(1.0)
		kinds = rng.choice(
			["libri", "tts", "call", "early", "late", "hard"], size=size - positives, p=[0.29, 0.28, 0.05, 0.07, 0.11, 0.2]
		)
		for kind in kinds:
			if kind == "hard" and not self.hard:
				kind = "libri"
			if kind == "libri":
				windows.append(self.libri.window(self.libri.random_end(rng)))
			elif kind == "tts":
				windows.append(self.negatives.window(self.negatives.random_end(rng)))
			elif kind == "call":
				windows.append(self.calls.window(self.calls.random_end(rng)))
			elif kind == "early":
				windows.append(self.positives.window(rng.choice(self.ends) - int(rng.uniform(*EARLY) * RATE)))
			elif kind == "late":
				windows.append(self.positives.window(rng.choice(self.ends) + int(rng.uniform(*LATE) * RATE)))
			else:
				pool, end = self.hard[rng.integers(len(self.hard))]
				windows.append(pool.window(end + int(rng.uniform(-0.03, 0.03) * RATE)))
			labels.append(0.0)
		audio = torch.from_numpy(np.stack(windows).astype(np.float32) / 32768.0).to(self.dev)
		return self.augment(audio), torch.tensor(labels, device=self.dev)

	def augment(self, audio):
		"""Speed, rooms, other voices, noise and loudness, on the whole batch."""
		rng, dev = self.rng, self.dev
		size = audio.shape[0]
		# Speed: read the last WINDOW * factor samples of each source at WINDOW
		# points, so the end of the window stays where the name ended.
		factor = torch.from_numpy(rng.uniform(1 - SPEED, 1 + SPEED, size).astype(np.float32)).to(dev)
		steps = torch.arange(WINDOW, device=dev, dtype=torch.float32)
		position = SOURCE - 1 - (WINDOW - 1 - steps)[None, :] * factor[:, None]
		grid_x = position / (SOURCE - 1) * 2 - 1
		grid = torch.stack([grid_x, torch.zeros_like(grid_x)], -1)[:, None]
		audio = F.grid_sample(audio[:, None, None, :], grid, align_corners=True)[:, 0, 0]

		room = torch.from_numpy(rng.random(size) < 0.4).to(dev)
		if room.any():
			which = torch.from_numpy(rng.integers(0, self.rooms.bank.shape[0], int(room.sum()))).to(dev)
			audio[room] = self.rooms.apply(audio[room], which)

		loudness = audio.pow(2).mean(1, keepdim=True).sqrt().clamp_min(1e-5)
		babble = torch.from_numpy(rng.random(size) < 0.25).to(dev)
		if babble.any():
			others = np.stack([self.libri.window(self.libri.random_end(rng))[-WINDOW:] for _ in range(int(babble.sum()))])
			others = torch.from_numpy(others.astype(np.float32) / 32768.0).to(dev)
			snr = torch.from_numpy(rng.uniform(5, 20, int(babble.sum())).astype(np.float32)).to(dev)[:, None]
			level = others.pow(2).mean(1, keepdim=True).sqrt().clamp_min(1e-5)
			audio[babble] += others / level * loudness[babble] * 10 ** (-snr / 20)
		noisy = torch.from_numpy(rng.random(size) < 0.5).to(dev)
		if noisy.any():
			noise = torch.randn(int(noisy.sum()), WINDOW, device=dev)
			# Brown, half the time: most room noise is low.
			brown = torch.from_numpy(rng.random(int(noisy.sum())) < 0.5).to(dev)
			if brown.any():
				walk = torch.cumsum(noise[brown], 1)
				walk = walk - walk.mean(1, keepdim=True)
				noise[brown] = walk / walk.std(1, keepdim=True).clamp_min(1e-5)
			snr = torch.from_numpy(rng.uniform(10, 45, int(noisy.sum())).astype(np.float32)).to(dev)[:, None]
			audio[noisy] += noise * loudness[noisy] * 10 ** (-snr / 20)
		gain = torch.from_numpy(rng.uniform(-18, 6, size).astype(np.float32)).to(dev)[:, None]
		return (audio * 10 ** (gain / 20)).clamp(-1, 1)


@torch.no_grad()
def mine(detector, batches, count=3000):
	"""The negative windows the model is surest are the name."""
	detector.eval()
	found = []
	for pool in (batches.negatives, batches.libri, batches.calls):
		scores, ends = stream_scores(detector, pool.samples)
		order = np.argsort(-scores)
		taken = []
		for index in order[: count * 4]:
			if scores[index] < 0.05:
				break
			end = int(ends[index] * RATE)
			if all(abs(end - other) > RATE // 2 for other in taken):
				taken.append(end)
				if len(taken) >= count // 2:
					break
		found += [(pool, end) for end in taken]
	detector.train()
	return found


@torch.no_grad()
def validate(detector, positives, streams):
	"""Each positive's best score near where its name ends, and the scores of
	the negative streams."""
	detector.eval()
	best = []
	for path, end in positives:
		scores, ends = stream_scores(detector, read(path))
		near = (ends >= end - 0.2) & (ends <= end + 0.5)
		best.append(float(scores[near].max()) if near.any() else 0.0)
	negatives = [stream_scores(detector, samples) for samples in streams]
	detector.train()
	return np.array(best), negatives


#: Thresholds tried, finer towards one: a confident model's scores crowd up
#: against it, and 0.99 can be far from the threshold it needs.
THRESHOLDS = np.round(np.concatenate([np.arange(0.30, 0.99, 0.01), np.arange(0.990, 0.999, 0.001), np.arange(0.9990, 0.99995, 0.0001)]), 4)


def operating_point(best, negatives, seconds, per_hour):
	"""The lowest threshold with no more than `per_hour` false wakes, and the
	recall there; with none, the highest tried and nan for the rate."""
	for threshold in THRESHOLDS:
		false = sum(len(wakes(scores, ends, threshold)) for scores, ends in negatives)
		if false / seconds * 3600 <= per_hour:
			return float(threshold), float((best >= threshold).mean()), false / seconds * 3600
	return float(THRESHOLDS[-1]), float((best >= THRESHOLDS[-1]).mean()), float("nan")


def main():
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("--steps", type=int, default=12000)
	parser.add_argument("--batch", type=int, default=256)
	parser.add_argument("--mine-every", type=int, default=3000)
	parser.add_argument("--valid-every", type=int, default=1000)
	parser.add_argument("--per-hour", type=float, default=2.0, help="false wakes an hour allowed on validation")
	parser.add_argument("--seed", type=int, default=2026)
	args = parser.parse_args()

	torch.manual_seed(args.seed)
	dev = device()
	OUT.mkdir(parents=True, exist_ok=True)
	started = time.time()
	positives, negatives, libri, calls, held_voices = splits(args.seed)
	print(f"positives: {len(positives['train'])} train, {len(positives['valid'])} valid; held-out voices: {', '.join(held_voices)}")
	batches = Batches(positives["train"], negatives["train"], libri["train"], calls["train"], dev, args.seed)
	print(
		f"training negatives: {batches.negatives.seconds() / 3600:.1f}h synthesised, {batches.libri.seconds() / 3600:.1f}h LibriSpeech, "
		f"{len(calls['train'])} clips of call chatter"
	)
	valid_streams = [
		Pool(negatives["valid"] + calls["valid"]).samples,
		Pool(libri["valid"], gap=np.zeros(0, np.int16)).samples,
	]
	# And the same across rooms: false wakes climb with echo, and a threshold
	# chosen on clean speech alone does not see it.
	valid_streams += [in_rooms(stream, Rooms(64, args.seed + 7, torch.device("cpu"))) for stream in valid_streams]
	valid_seconds = sum(len(s) for s in valid_streams) / RATE
	print(f"validation negatives: {valid_seconds / 3600:.2f}h; loaded in {time.time() - started:.0f}s")

	detector = Detector(WakeNet()).to(dev)
	print(f"{sum(p.numel() for p in detector.net.parameters())} parameters")
	optimiser = torch.optim.AdamW(detector.net.parameters(), lr=2e-3, weight_decay=1e-3)
	schedule = torch.optim.lr_scheduler.OneCycleLR(optimiser, max_lr=2e-3, total_steps=args.steps, pct_start=0.05)

	history, best_recall = [], -1.0
	for step in range(1, args.steps + 1):
		audio, labels = batches.make(args.batch)
		loss = F.binary_cross_entropy_with_logits(detector(audio), labels)
		optimiser.zero_grad()
		loss.backward()
		optimiser.step()
		schedule.step()

		if step % args.mine_every == 0 and step < args.steps:
			batches.hard = mine(detector, batches)
			print(f"step {step}: mined {len(batches.hard)} hard negatives")
		if step % args.valid_every == 0 or step == args.steps:
			best, scored = validate(detector, positives["valid"], valid_streams)
			threshold, recall, per_hour = operating_point(best, scored, valid_seconds, args.per_hour)
			history.append({"step": step, "loss": float(loss), "threshold": threshold, "recall": recall, "per_hour": per_hour})
			print(
				f"step {step}: loss {float(loss):.4f}, valid recall {recall:.2f} at threshold {threshold:g} "
				f"({per_hour:.1f} false wakes/h), {time.time() - started:.0f}s"
			)
			saved = {"net": detector.net.state_dict(), "threshold": threshold, "step": step}
			torch.save(saved, OUT / f"step-{step}.pt")
			# A checkpoint no threshold keeps within the limit is never the best.
			if not np.isnan(per_hour) and recall >= best_recall:
				best_recall = recall
				torch.save(saved, OUT / "best.pt")
	(OUT / "history.json").write_text(json.dumps(history, indent=1))
	print(f"best valid recall {best_recall:.2f}; saved to {OUT / 'best.pt'}")


if __name__ == "__main__":
	main()
