#!/usr/bin/env bash
# Fetch the models voice commands need into models/voice (gitignored).
#
#   scripts/download-voice-models.sh [--speech] [target dir]
#
# Idempotent: anything already in place is left alone, so rerunning after a
# partial download only fetches what is missing. About 180MB to download and
# 260MB unpacked, nearly all of it SenseVoice. `--speech` also fetches Kokoro,
# for VOICE_SPEECH: another 330MB or so.
#
# The sidecar finds them with `--voice-models <dir>` (default models/voice,
# relative to the directory it is started in).
set -euo pipefail

SPEECH=0
if [[ "${1:-}" == "--speech" ]]; then
	SPEECH=1
	shift
fi
TARGET="${1:-models/voice}"
RELEASES="https://github.com/k2-fsa/sherpa-onnx/releases/download"

# Wake word: a 3.3M-parameter streaming zipformer trained on GigaSpeech. Its
# BPE vocabulary lets keywords be written as plain text and encoded at load.
KWS="sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
# Speech to text: SenseVoice-Small, int8. zh, en, ja, ko and Cantonese, with
# the language detected per utterance. The 2024-07-17 export is FunASR's own
# weights; the later 2025-09-09 one is a Cantonese fine-tune (WSYue) and
# trades the other languages away for it.
STT="sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
# End of speech.
VAD="silero_vad.onnx"
# Speech, for answering aloud: English and Chinese, 24 kHz. The fp32 export:
# the int8 one produces only NaN on Apple silicon.
TTS="kokoro-multi-lang-v1_0"

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

if [[ -f "$VAD" ]]; then
	echo "have $VAD"
else
	echo "fetching $VAD"
	download "$RELEASES/asr-models/$VAD" "$VAD"
fi

if [[ "$SPEECH" == 1 ]]; then
	fetch_archive tts-models "$TTS"
fi

# The test clips and the full-precision weights are not used at runtime.
rm -rf "$KWS/test_wavs" "$STT/test_wavs"

echo "voice models are in $(pwd)"
