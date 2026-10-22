#!/usr/bin/env python3
"""Fine-tune the GigaSpeech keyword spotter on the wake word.

    training/wake/work/.venv/bin/python training/wake/finetune.py --num-epochs 3

Runs icefall's own fine-tuning (egs/gigaspeech/KWS/zipformer/finetune.py)
unchanged, from the published checkpoint, with its data swapped for ours:
prepare.py's wake manifests in place of the commands dataset it was written
for, and LibriSpeech in place of GigaSpeech as the general speech mixed in.
Settings are the recipe's own (learning rate, model shape, causal chunking),
except what a CPU needs: no fp16, and one thread per process with several
processes training in parallel. On an M5 Pro a step runs slower with more
threads, not faster (2.3s on one, 3.4s on ten), so the cores are used the
way the recipe uses GPUs, one data-parallel worker each, over gloo instead
of NCCL.

Checkpoints land in training/wake/work/exp; export.sh turns one into the ONNX
files the sidecar loads; with little real data an early epoch is usually
best (see README.md). Any further arguments are passed through,
for example `--max-duration 200` if memory is short, or `--start-epoch 4
--continue-finetune 1` to resume.
"""

import os
import sys
from pathlib import Path

WORK = Path(__file__).resolve().parent / "work"
RECIPE = WORK / "icefall" / "egs" / "gigaspeech" / "KWS" / "zipformer"
MANIFESTS = WORK / "data" / "manifests"
sys.path[:0] = [str(WORK / "icefall"), str(RECIPE)]
os.environ.setdefault("PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION", "python")

import torch  # noqa: E402
import torch.distributed as dist  # noqa: E402
from asr_datamodule import GigaSpeechAsrDataModule  # noqa: E402
from lhotse import load_manifest  # noqa: E402

import finetune as recipe  # noqa: E402

# One thread per worker process. Set here, at import, because the workers are
# spawned processes that import this file but never run main().
torch.set_num_threads(1)


class WakeData(GigaSpeechAsrDataModule):
	"""The recipe's data module, reading our manifests instead."""

	def train_cuts(self):
		return load_manifest(MANIFESTS / "general.jsonl.gz")

	def fsc_train_cuts(self):
		return load_manifest(MANIFESTS / "wake_train.jsonl.gz")

	def fsc_valid_cuts(self):
		return load_manifest(MANIFESTS / "wake_valid.jsonl.gz")


def setup_cpu_dist(rank, world_size, master_port=None, use_ddp_launch=False):
	"""icefall's setup_dist, for CPUs: gloo rather than NCCL, no CUDA device."""
	os.environ.setdefault("MASTER_ADDR", "localhost")
	os.environ.setdefault("MASTER_PORT", str(master_port or 12354))
	dist.init_process_group("gloo", rank=rank, world_size=world_size)


def cpu_ddp(model, device_ids=None, **options):
	"""DistributedDataParallel without the GPU ids the recipe passes."""
	return torch.nn.parallel.DistributedDataParallel(model, **options)


# Applied at import so the spawned workers see them too.
recipe.GigaSpeechAsrDataModule = WakeData
recipe.setup_dist = setup_cpu_dist
recipe.DDP = cpu_ddp


# The pretrained model's shape, from the recipe's run.sh. Fine-tuning must
# match it exactly.
MODEL = [
	"--decoder-dim", "320",
	"--joiner-dim", "320",
	"--num-encoder-layers", "1,1,1,1,1,1",
	"--feedforward-dim", "192,192,192,192,192,192",
	"--encoder-dim", "128,128,128,128,128,128",
	"--encoder-unmasked-dim", "128,128,128,128,128,128",
	"--causal", "1",
]


def main():
	performance_cores = os.popen("sysctl -n hw.perflevel0.physicalcpu 2>/dev/null").read().strip()
	workers = int(performance_cores) if performance_cores.isdigit() else max(1, (os.cpu_count() or 2) // 2)
	sys.argv = [
		"finetune.py",
		"--world-size", str(workers),
		"--num-epochs", "3",
		"--start-epoch", "1",
		"--exp-dir", str(WORK / "exp"),
		"--bpe-model", str(WORK / "pretrained" / "data" / "lang_bpe_500" / "bpe.model"),
		"--finetune-ckpt", str(WORK / "pretrained" / "exp" / "pretrained.pt"),
		"--use-fp16", "0",
		"--use-mux", "1",
		# The recipe's fine-tuning schedule.
		"--base-lr", "0.0005",
		"--lr-epochs", "100",
		"--lr-batches", "100000",
		"--max-duration", "300",
		"--on-the-fly-feats", "0",
		"--enable-musan", "0",
		"--num-workers", "1",
		*MODEL,
		*sys.argv[1:],
	]
	recipe.main()


if __name__ == "__main__":
	main()
