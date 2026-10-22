#!/usr/bin/env bash
# Turn fine-tuned checkpoints into the ONNX spotter the sidecar loads.
#
#   training/wake/export.sh <epoch> [avg] [name]
#
# Averages the last `avg` (default 2) epochs' weights up to `epoch` (plain
# averaging: the fine-tune's checkpoints do not carry the running average the
# recipe's other mode needs), exports a
# streaming int8 encoder, decoder and joiner with icefall's own exporter, and
# lays them out as models/voice/<name> (default kws-emhara) next to the
# tokens and bpe.model they were trained with. Point the sidecar at it with
# `--wake-model models/voice/<name>`, and `wake_wav --wake-model` the same way.
#
# Checkpoints are read from training/wake/work/exp, or from $EXP if set (as
# finetune.py's --exp-dir).
#
# Chunk size and left context match the stock spotter (16 and 64 frames), so
# the latency measured for it still holds.
set -euo pipefail

EPOCH="${1:?usage: export.sh <epoch> [avg] [name]}"
AVG="${2:-2}"
NAME="${3:-kws-emhara}"

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$HERE/work"
ROOT="$(cd "$HERE/../.." && pwd)"
RECIPE="$WORK/icefall/egs/gigaspeech/KWS/zipformer"
LANG="$WORK/pretrained/data/lang_bpe_500"
OUT="$ROOT/models/voice/$NAME"
EXP="${EXP:-$WORK/exp}"

PYTHONPATH="$WORK/icefall:$RECIPE" "$WORK/.venv/bin/python" "$RECIPE/export-onnx-streaming.py" \
	--exp-dir "$EXP" \
	--tokens "$LANG/tokens.txt" \
	--epoch "$EPOCH" \
	--avg "$AVG" \
	--use-averaged-model 0 \
	--chunk-size 16 \
	--left-context-frames 64 \
	--decoder-dim 320 \
	--joiner-dim 320 \
	--num-encoder-layers 1,1,1,1,1,1 \
	--feedforward-dim 192,192,192,192,192,192 \
	--encoder-dim 128,128,128,128,128,128 \
	--encoder-unmasked-dim 128,128,128,128,128,128 \
	--causal 1

mkdir -p "$OUT"
STEM="epoch-$EPOCH-avg-$AVG-chunk-16-left-64"
for part in encoder decoder joiner; do
	cp "$EXP/$part-$STEM.int8.onnx" "$OUT/$part.int8.onnx"
done
cp "$LANG/tokens.txt" "$LANG/bpe.model" "$OUT/"
echo "exported to $OUT"
