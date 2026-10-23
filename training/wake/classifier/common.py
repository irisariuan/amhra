"""What training and scoring share: the audio, the features, the model, and
how a stream is scored the way the sidecar would hear it.

The classifier sees the last WINDOW of sound and says how sure it is that the
name has just been said. Run every HOP over a stream, it wakes when that
reaches a threshold, and then not again for REFRACTORY, standing in for the
gate, which listens for a command rather than for the name after a wake.
"""

import wave
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torchaudio

HERE = Path(__file__).resolve().parent
WAKE = HERE.parent
DATA = WAKE / "work" / "data"
RATE = 16000
WINDOW = 24000  # 1.5s: the name, said slowly, and what came just before it
HOP = 480  # 30ms between scores in a stream
REFRACTORY = 2.0  # seconds after a wake in which another is not counted
MELS = 40
N_FFT = 400  # 25ms
FRAME_HOP = 160  # 10ms
FRAMES = 1 + (WINDOW - N_FFT) // FRAME_HOP


def read(path):
	"""A 16kHz mono WAV or FLAC as int16."""
	path = Path(path)
	if path.suffix == ".flac":
		import soundfile

		samples, rate = soundfile.read(str(path), dtype="int16")
	else:
		with wave.open(str(path)) as clip:
			rate = clip.getframerate()
			samples = np.frombuffer(clip.readframes(clip.getnframes()), dtype=np.int16)
	assert rate == RATE, f"{path}: {rate}Hz"
	return np.asarray(samples, dtype=np.int16)


def device():
	return torch.device("mps" if torch.backends.mps.is_available() else "cpu")


class Features(nn.Module):
	"""Log mel energies, 40 bands every 10ms, from float samples in -1..1."""

	def __init__(self):
		super().__init__()
		self.mel = torchaudio.transforms.MelSpectrogram(
			sample_rate=RATE, n_fft=N_FFT, hop_length=FRAME_HOP, n_mels=MELS, f_min=20, f_max=7600, center=False
		)

	def forward(self, samples):
		return torch.log(self.mel(samples) + 1e-6)


class Separable(nn.Module):
	"""A depthwise then pointwise convolution over time, with a shortcut."""

	def __init__(self, channels, stride):
		super().__init__()
		self.depthwise = nn.Conv1d(channels, channels, 5, stride=stride, padding=2, groups=channels, bias=False)
		self.pointwise = nn.Conv1d(channels, channels, 1, bias=False)
		self.norm = nn.BatchNorm1d(channels)
		self.shortcut = nn.AvgPool1d(stride, stride, ceil_mode=True) if stride > 1 else nn.Identity()

	def forward(self, x):
		y = self.norm(self.pointwise(self.depthwise(x)))
		return torch.relu(y + self.shortcut(x)[..., : y.shape[-1]])


class WakeNet(nn.Module):
	"""Mel frames of one window in, one logit out.

	The head flattens what is left of time rather than pooling it, so the
	model knows *where* in the window the name is, and can learn to fire only
	when it has just ended.
	"""

	def __init__(self, width=64):
		super().__init__()
		self.input = nn.BatchNorm1d(MELS)
		self.stem = nn.Sequential(nn.Conv1d(MELS, width, 5, padding=2, bias=False), nn.BatchNorm1d(width), nn.ReLU())
		self.blocks = nn.Sequential(*(Separable(width, 2) for _ in range(4)))
		steps = FRAMES
		for _ in range(4):
			steps = (steps + 1) // 2
		self.head = nn.Sequential(nn.Flatten(), nn.Dropout(0.2), nn.Linear(width * steps, 64), nn.ReLU(), nn.Linear(64, 1))

	def forward(self, frames):
		return self.head(self.blocks(self.stem(self.input(frames)))).squeeze(-1)


class Detector(nn.Module):
	"""Features and model together: one window of samples in, a logit out."""

	def __init__(self, net):
		super().__init__()
		self.features = Features()
		self.net = net

	def forward(self, samples):
		return self.net(self.features(samples))


#: Stream audio scored at once: ten minutes, so hours of it fit in memory.
CHUNK = RATE * 600


@torch.no_grad()
def stream_scores(detector, samples, batch=2048):
	"""The score at every HOP of an int16 stream, and the second each ends at.

	The stream starts with a window of silence, as a call's does, and is
	scored in chunks that overlap by a window, each hop scored once.
	"""
	dev = next(detector.parameters()).device
	padded = np.concatenate([np.zeros(WINDOW, np.int16), samples])
	per_hop = HOP // FRAME_HOP
	span = (FRAMES - 1) * FRAME_HOP + N_FFT
	scores, ends = [], []
	for offset in range(0, max(len(padded) - span, 0) + 1, CHUNK):
		piece = padded[offset : offset + CHUNK + span]
		if len(piece) < span:
			break
		audio = torch.from_numpy(piece.astype(np.float32) / 32768.0).to(dev)
		frames = detector.features(audio.unsqueeze(0))[0]  # mels x time
		# Windows that start in this chunk; the next chunk starts the rest.
		starts = torch.arange(0, min(frames.shape[1] - FRAMES + 1, CHUNK // FRAME_HOP), per_hop, device=dev)
		for part in starts.split(batch):
			windows = frames.unfold(1, FRAMES, 1)[:, part].permute(1, 0, 2)
			scores.append(torch.sigmoid(detector.net(windows)).cpu().numpy())
		# Where each window's last frame ends, less the silence put before.
		ends.append((offset + starts.cpu().numpy() * FRAME_HOP + span - WINDOW) / RATE)
	return np.concatenate(scores), np.concatenate(ends)


def wakes(scores, ends, threshold):
	"""The seconds at which a stream with these scores wakes."""
	found, quiet_until = [], -1.0
	for score, at in zip(scores, ends):
		if score >= threshold and at >= quiet_until:
			found.append(float(at))
			quiet_until = at + REFRACTORY
	return found


def joined_clips(held_out):
	"""The clips evaluate.py joins for `held_out`: their spans, and the names in each."""
	spans, at = [], 0
	for line in (held_out / "test.tsv").read_text(encoding="utf-8").splitlines():
		if not line.strip():
			continue
		file, text = line.split("\t", 1)
		length = len(read(held_out / file))
		spans.append((at / RATE, (at + length) / RATE, text.split().count("EMHARA")))
		at += length + 64000
	return spans
