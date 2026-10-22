#!/usr/bin/env bash
# Build the wake-word training environment in training/wake/work (gitignored):
# a Python 3.12 venv with PyTorch, k2 and lhotse, icefall at a pinned commit,
# and the pretrained GigaSpeech keyword-spotter checkpoint to fine-tune from.
#
#   training/wake/setup.sh
#
# CPU only, macOS arm64 or Linux x86_64. Idempotent.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$HERE/work"
mkdir -p "$WORK"
cd "$WORK"

TORCH=2.9.1
K2=1.24.4.dev20260625
ICEFALL=bfde1030136ffc6770857d3e92bd6762497a8f54
CHECKPOINT=https://github.com/pkufool/keyword-spotting-models/releases/download/v0.11/icefall-kws-zipformer-gigaspeech-20240219.tar.gz

case "$(uname -s)-$(uname -m)" in
	Darwin-arm64) K2_WHEEL="https://huggingface.co/csukuangfj2/k2/resolve/main/macos/$K2/k2-$K2+cpu.torch$TORCH-cp312-cp312-macosx_11_0_arm64.whl" ;;
	Linux-x86_64) K2_WHEEL="https://huggingface.co/csukuangfj2/k2/resolve/main/cpu/$K2/linux-x64/k2-$K2+cpu.torch$TORCH-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl" ;;
	*) echo "no k2 wheel for $(uname -s)-$(uname -m)"; exit 1 ;;
esac

if [[ ! -x .venv/bin/python ]]; then
	uv venv --python 3.12 .venv
fi
uv pip install --python .venv/bin/python \
	"torch==$TORCH" "torchaudio==$TORCH" "$K2_WHEEL" \
	lhotse sentencepiece kaldialign tensorboard typeguard dill \
	onnx onnxruntime onnxconverter_common soundfile numpy urllib3 \
	pypinyin==0.50.0 num2words kaldifst lilcom

if [[ ! -d icefall ]]; then
	git clone --quiet https://github.com/k2-fsa/icefall.git icefall
fi
git -C icefall checkout --quiet "$ICEFALL"

if [[ ! -f pretrained/exp/pretrained.pt ]]; then
	echo "fetching the pretrained checkpoint"
	mkdir -p pretrained
	curl --fail --location --retry 5 --progress-bar "$CHECKPOINT" | tar -xz -C pretrained --strip-components 1
fi

echo "ready: $WORK"
