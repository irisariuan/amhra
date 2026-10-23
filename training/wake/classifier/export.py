#!/usr/bin/env python3
"""Export the classifier as one ONNX model: 1.5s of 16kHz samples in, the
score out, features included, so whatever runs it needs no mel code.

    training/wake/work/.venv/bin/python training/wake/classifier/export.py [--out models/voice/wake-classifier]

Writes model.onnx and threshold.txt, then checks that onnxruntime, where
installed, gives the scores PyTorch does.
"""

import argparse
from pathlib import Path

import numpy as np
import torch

from common import DATA, FRAME_HOP, N_FFT, WAKE, WINDOW, Detector, Features, WakeNet


class RealFeatures(torch.nn.Module):
	"""`Features` without complex numbers, which the ONNX exporter cannot
	take: frames, the window, and the power spectrum as two real matrix
	products, then the same mel filters."""

	def __init__(self, features):
		super().__init__()
		spectrogram = features.mel.spectrogram
		bins = torch.arange(N_FFT // 2 + 1, dtype=torch.float64)[:, None]
		time = torch.arange(N_FFT, dtype=torch.float64)[None, :]
		angle = 2 * torch.pi * bins * time / N_FFT
		window = spectrogram.window.to(torch.float64)[None, :]
		self.register_buffer("cos", (torch.cos(angle) * window).to(torch.float32))
		self.register_buffer("sin", (torch.sin(angle) * window).to(torch.float32))
		self.register_buffer("filters", features.mel.mel_scale.fb.clone())

	def forward(self, samples):
		# Each basis row as a kernel, a frame hop apart: batch x bins x time.
		audio = samples[:, None, :]
		real = torch.nn.functional.conv1d(audio, self.cos[:, None, :], stride=FRAME_HOP)
		imaginary = torch.nn.functional.conv1d(audio, self.sin[:, None, :], stride=FRAME_HOP)
		power = real**2 + imaginary**2
		return torch.log(torch.einsum("bft,fm->bmt", power, self.filters) + 1e-6)


class Scored(torch.nn.Module):
	def __init__(self, net, features):
		super().__init__()
		self.features = features
		self.net = net

	def forward(self, samples):
		return torch.sigmoid(self.net(self.features(samples)))


def main():
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("--model", type=Path, default=DATA.parent / "classifier" / "best.pt")
	parser.add_argument("--out", type=Path, default=WAKE.parent.parent / "models" / "voice" / "wake-classifier")
	args = parser.parse_args()

	saved = torch.load(args.model, map_location="cpu")
	net = WakeNet()
	net.load_state_dict(saved["net"])
	model = Scored(net, RealFeatures(Features())).eval()
	reference = Detector(net).eval()
	check = torch.randn(4, WINDOW) * 0.1
	with torch.no_grad():
		drift = (model(check) - torch.sigmoid(reference(check))).abs().max().item()
	assert drift < 1e-4, f"the real-valued features differ from the trained ones by {drift}"
	args.out.mkdir(parents=True, exist_ok=True)
	path = args.out / "model.onnx"
	example = torch.randn(4, WINDOW) * 0.1
	torch.onnx.export(
		model, (example,), str(path), input_names=["samples"], output_names=["score"],
		dynamic_axes={"samples": {0: "batch"}, "score": {0: "batch"}}, opset_version=18, dynamo=False,
	)
	(args.out / "threshold.txt").write_text(f"{saved['threshold']:.2f}\n")
	print(f"wrote {path} ({path.stat().st_size // 1024} KB), threshold {saved['threshold']:.2f}")

	try:
		import onnxruntime
	except ImportError:
		print("onnxruntime is not installed here; not checked")
		return
	session = onnxruntime.InferenceSession(str(path))
	test = (np.random.default_rng(1).standard_normal((8, WINDOW)) * 0.1).astype(np.float32)
	ours = model(torch.from_numpy(test)).detach().numpy()
	theirs = session.run(None, {"samples": test})[0]
	print(f"onnxruntime agrees to {np.abs(ours - theirs).max():.2e}")


if __name__ == "__main__":
	main()
