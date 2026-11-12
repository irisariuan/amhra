#!/usr/bin/env bash
# Fetch the models voice commands need into models/voice (gitignored).
#
#   scripts/download-voice-models.sh [--speech] [--qwen3-1.7B] [--whisper-v3-turbo] [target dir]
#
# Idempotent: anything already in place is left alone, so rerunning after a
# partial download only fetches what is missing. About 1.2GB to download and
# unpacked, nearly all of it Qwen3-ASR, then SenseVoice. `--speech` also fetches the
# speech models for VOICE_SPEECH: about 380MB more to download, 600MB unpacked.
# `--qwen3-1.7B` also fetches Qwen3-ASR 1.7B, for VOICE_RECOGNISER qwen3-1.7B:
# 2.4GB more.
#
# The sidecar finds them with `--voice-models <dir>` (default models/voice,
# relative to the directory it is started in).
set -euo pipefail

SPEECH=0
WHISPER=0
QWEN3_LARGE_WANTED=0
while [[ "${1:-}" == --* ]]; do
	case "$1" in
		--speech) SPEECH=1 ;;
		--whisper-v3-turbo) WHISPER=1 ;;
		--qwen3-1.7B | --qwen3-1.7b) QWEN3_LARGE_WANTED=1 ;;
		*) echo "unknown option: $1" >&2; exit 1 ;;
	esac
	shift
done
TARGET="${1:-models/voice}"
RELEASES="https://github.com/k2-fsa/sherpa-onnx/releases/download"

# Wake word: a 3.3M-parameter streaming zipformer trained on GigaSpeech. Its
# BPE vocabulary lets keywords be written as plain text and encoded at load.
KWS="sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
# Speech to text: SenseVoice-Small, int8. zh, en, ja, ko and Cantonese, with
# the language detected per utterance. The 2024-07-17 export is FunASR's own
# weights; the later 2025-09-09 one is a Cantonese fine-tune (WSYue) and
# trades the other languages away for it. The smaller of the two recognisers
# (`--recogniser sensevoice`), and what tts_check listens with.
STT="sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
# Speech to text, the default: Qwen3-ASR 0.6B, int8. From Hugging Face, file
# by file: the same export as the asr-models release's tarball, which GitHub
# served here at a thirtieth of the speed.
QWEN3="sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25"
QWEN3_FILES=(conv_frontend.onnx encoder.int8.onnx decoder.int8.onnx
	tokenizer/vocab.json tokenizer/merges.txt tokenizer/tokenizer_config.json)
HUGGING_FACE="https://huggingface.co/csukuangfj2"
# Optional Qwen3-ASR 1.7B, int8 (`--recogniser qwen3-1.7B`): 2.4GB. sherpa-onnx
# publishes no export of this size, so this is a third party's, made with the
# same script and laid out the same. It is fetched at one fixed revision and
# its weights checked against the SHA-256 that revision had.
QWEN3_LARGE="sherpa-onnx-qwen3-asr-1.7B-int8"
QWEN3_LARGE_SOURCE="https://huggingface.co/thieunv-asilla/$QWEN3_LARGE/resolve/69eb686fd94a4a865bb5340a3d6ac0d7f1fec0d5"
QWEN3_LARGE_SHA256=(
	"3cb27a9fe94d95c938e476f2012b21aba2ec0bfceef33b0e58acd208946bafdd  conv_frontend.onnx"
	"a5deedae034ece715de8ed204378d8c77f889af3a60c2566581135e84cced7cd  encoder.int8.onnx"
	"c43c853fa6e97d08365cb8a5502b360b595cd43c00dc60e4d8ca7cc18cad460b  decoder.int8.onnx"
)
# Optional Whisper large-v3-turbo, int8: about 1GB extra. The encoder's
# full-precision export uses external weights; these int8 files are standalone.
WHISPER_TURBO="sherpa-onnx-whisper-turbo"
WHISPER_FILES=(turbo-encoder.int8.onnx turbo-decoder.int8.onnx turbo-tokens.txt)
# End of speech.
VAD="silero_vad.onnx"
# Speech, for answering aloud (see the sidecar's speech::models). English,
# Japanese and Korean: Supertonic 3, int8.
TTS_SUPERTONIC="sherpa-onnx-supertonic-3-tts-int8-2026-05-11"
# Mandarin: Kokoro, the fp32 export; the int8 one produces only NaN on Apple
# silicon.
TTS_KOKORO="kokoro-multi-lang-v1_0"
# Cantonese: the one Cantonese voice sherpa-onnx has.
TTS_CANTONESE="vits-cantonese-hf-xiaomaiiwn"

mkdir -p "$TARGET"
cd "$TARGET"

# Download to a `.part` file first: curl can resume one of those after a
# dropped connection, which a stream piped into tar cannot.
download() {
	local url="$1" out="$2"
	if [[ -f "$out" ]]; then
		return
	fi
	curl --fail --location --retry 5 --retry-all-errors --continue-at - \
		--progress-bar -o "$out.part" "$url"
	mv "$out.part" "$out"
}

fetch_archive() {
	local release="$1" name="$2"
	if [[ -d "$name" ]]; then
		echo "have $name"
		return
	fi
	echo "fetching $name"
	download "$RELEASES/$release/$name.tar.bz2" "$name.tar.bz2"
	# Unpacked under a temporary name, then renamed, so an interrupted run
	# never leaves a half-extracted model that looks complete.
	local staging
	staging="$(mktemp -d ./.staging.XXXXXX)"
	tar -xjf "$name.tar.bz2" -C "$staging"
	mv "$staging/$name" "$name"
	rm -rf "$staging" "$name.tar.bz2"
}

fetch_archive kws-models "$KWS"
fetch_archive asr-models "$STT"

# Qwen3-ASR, either size: `name` from `source`, file by file. Any further
# arguments are `sha256sum` lines the files must match.
fetch_qwen3() {
	local name="$1" source="$2"
	shift 2
	if [[ -d "$name" ]]; then
		echo "have $name"
		return
	fi
	echo "fetching $name"
	# Into a staging directory, renamed when complete, as the archives are.
	mkdir -p ".staging.$name/tokenizer"
	local file
	for file in "${QWEN3_FILES[@]}"; do
		download "$source/$file" ".staging.$name/$file"
	done
	if [[ $# -gt 0 ]]; then
		local sum=(sha256sum)
		command -v sha256sum >/dev/null || sum=(shasum -a 256)
		if ! (cd ".staging.$name" && printf '%s\n' "$@" | "${sum[@]}" -c -); then
			echo "$name is not the files expected; left in .staging.$name" >&2
			exit 1
		fi
	fi
	mv ".staging.$name" "$name"
}

fetch_qwen3 "$QWEN3" "$HUGGING_FACE/$QWEN3/resolve/main"
if [[ "$QWEN3_LARGE_WANTED" == 1 ]]; then
	fetch_qwen3 "$QWEN3_LARGE" "$QWEN3_LARGE_SOURCE" "${QWEN3_LARGE_SHA256[@]}"
fi

if [[ "$WHISPER" == 1 ]]; then
	if [[ -d "$WHISPER_TURBO" ]]; then
		echo "have $WHISPER_TURBO"
	else
		echo "fetching $WHISPER_TURBO"
		mkdir -p ".staging.$WHISPER_TURBO"
		for file in "${WHISPER_FILES[@]}"; do
			download "https://huggingface.co/csukuangfj/$WHISPER_TURBO/resolve/main/$file" ".staging.$WHISPER_TURBO/$file"
		done
		mv ".staging.$WHISPER_TURBO" "$WHISPER_TURBO"
	fi
fi

if [[ -f "$VAD" ]]; then
	echo "have $VAD"
else
	echo "fetching $VAD"
	download "$RELEASES/asr-models/$VAD" "$VAD"
fi

if [[ "$SPEECH" == 1 ]]; then
	fetch_archive tts-models "$TTS_SUPERTONIC"
	fetch_archive tts-models "$TTS_KOKORO"
	fetch_archive tts-models "$TTS_CANTONESE"
fi

# The test clips and the full-precision weights are not used at runtime.
rm -rf "$KWS/test_wavs" "$STT/test_wavs"

echo "voice models are in $(pwd)"
