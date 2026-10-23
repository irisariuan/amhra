#!/usr/bin/env python3
"""Export the classifier for the sidecar's `--wake-classifier`.

    training/wake/work/.venv/bin/python training/wake/classifier/export.py [--model …] [--out models/voice/wake-classifier]

Writes, into the output directory (under the gitignored models/):

- net.onnx: the network alone, one window of log-mel frames in
  (1 x 40 x 148), the logit out. The sidecar makes the frames itself, a few
  at a time as audio arrives, rather than redoing the whole window each hop.
- features.json: how those frames are made, which the sidecar checks
  against its own before it loads anything, so the two cannot drift apart.
- threshold.txt: the score at which it wakes, chosen on validation.
- check.json: a test signal's frames and logits at a few points, as PyTorch
  makes them, for the sidecar's own tests to compare with.

Then it checks, with onnxruntime where installed, that the exported network
gives PyTorch's answers.
"""

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from common import DATA, FRAME_HOP, FRAMES, HOP, MELS, N_FFT, RATE, WAKE, WINDOW, Detector, WakeNet

# What the trained positives' windows end after the name, at their middle:
# the sidecar's best guess at how long ago the name ended when it wakes.
AFTER_MS = 85


def check_signal():
	"""Three seconds that are not silence and not speech: two tones and a
	sweep, the same in Python and Rust."""
	t = np.arange(3 * RATE) / RATE
	signal = 0.2 * np.sin(2 * np.pi * 440 * t) + 0.1 * np.sin(2 * np.pi * 1750 * t) + 0.05 * np.sin(2 * np.pi * (200 + 900 * t) * t)
	return np.round(signal * 32767).astype(np.int16)


def main():
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("--model", type=Path, default=DATA.parent / "classifier" / "best.pt")
	parser.add_argument("--out", type=Path, default=WAKE.parent.parent / "models" / "voice" / "wake-classifier")
	args = parser.parse_args()

	saved = torch.load(args.model, map_location="cpu")
	net = WakeNet()
	net.load_state_dict(saved["net"])
	net.eval()
	args.out.mkdir(parents=True, exist_ok=True)
	for stale in ("model.onnx",):
		(args.out / stale).unlink(missing_ok=True)

	path = args.out / "net.onnx"
	example = torch.randn(1, MELS, FRAMES)
	torch.onnx.export(net, (example,), str(path), input_names=["frames"], output_names=["logit"], opset_version=18, dynamo=False)

	features = Detector(net).features
	mel = features.mel
	(args.out / "features.json").write_text(
		json.dumps(
			{
				"sample_rate": RATE,
				"n_fft": N_FFT,
				"frame_hop": FRAME_HOP,
				"frames": FRAMES,
				"mels": MELS,
				"f_min": mel.mel_scale.f_min,
				"f_max": mel.mel_scale.f_max,
				"mel_scale": mel.mel_scale.mel_scale,
				"window": "hann, periodic",
				"power": mel.spectrogram.power,
				"log_floor": 1e-6,
				"score_hop": HOP // FRAME_HOP,
				"keyword": "EMHARA",
				"after_ms": AFTER_MS,
			},
			indent=1,
		)
		+ "\n"
	)
	(args.out / "threshold.txt").write_text(f"{saved['threshold']:g}\n")

	# A known signal's frames and logits, for the Rust side's tests. Indexes
	# count frames of the signal with a window of silence before it, as a
	# stream starts: frame i begins at sample i * frame_hop of that.
	signal = check_signal()
	with torch.no_grad():
		padded = np.concatenate([np.zeros(WINDOW, np.int16), signal]).astype(np.float32) / 32768.0
		frames = features(torch.from_numpy(padded)[None])[0]
		starts = [30, 150, 300]
		logits = [float(net(frames[None, :, start : start + FRAMES])[0]) for start in starts]
	(args.out / "check.json").write_text(
		json.dumps(
			{
				"signal": "0.2 sin 440Hz + 0.1 sin 1750Hz + 0.05 sweep from 200Hz, 3s, int16",
				"frames": [{"index": i, "values": [float(v) for v in frames[:, i]]} for i in (150, 200, 400)],
				"logits": [{"first_frame": start, "logit": logit} for start, logit in zip(starts, logits)],
			},
			indent=1,
		)
		+ "\n"
	)
	print(f"wrote {args.out}: net.onnx ({path.stat().st_size // 1024} KB), threshold {saved['threshold']:g}")

	try:
		import onnxruntime
	except ImportError:
		print("onnxruntime is not installed here; not checked")
		return
	session = onnxruntime.InferenceSession(str(path))
	test = np.random.default_rng(1).standard_normal((1, MELS, FRAMES)).astype(np.float32)
	ours = net(torch.from_numpy(test)).detach().numpy()
	theirs = session.run(None, {"frames": test})[0]
	print(f"onnxruntime agrees to {np.abs(ours - theirs).max():.2e}")


if __name__ == "__main__":
	main()
