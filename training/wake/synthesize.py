#!/usr/bin/env python3
"""Synthesise wake-word training speech with macOS `say`.

    python3 training/wake/synthesize.py [--out training/wake/work/data/tts]

Run from the repository root, after building the harness:

    cargo build --release --manifest-path rust/Cargo.toml -p amhra-sidecar \\
        --features voice-commands --examples

Writes `<out>/*.wav` (16 kHz mono) and `<out>/transcripts.tsv`, one
`<file><TAB><TRANSCRIPT>` per clip, in two kinds:

- **Positives**: the name, alone or before a command, transcribed EMHARA.
  Text-to-speech voices invent their own reading of a made-up name, and many
  clip it to "M" or say something else entirely. So every voice and spelling
  is first tried on the name alone and transcribed by SenseVoice (through the
  `wake_wav` harness). Only the pairs heard as the name ("Mharra",
  "EMM Harah", エムハラ…) go on to say commands. A positive the model is
  taught from must actually be the name, or it learns to fire on other words.
- **Negatives**: sentences that are *not* the name but come close ("I'm
  happy", "I'm Harry", "um, hello", "Mara"…), and ordinary chatter, with
  their real transcripts. They are what teaches the model where the name
  ends, which the pretrained model alone gets wrong: spelled as I'M HARA, it
  fired on 12 of 96 "I'm h…" sentences.

`--eval` writes the evaluation negatives to `<out>/../eval` instead:
different sentences from the training negatives, in English, Japanese,
Korean and Mandarin voices, for evaluate.py to count false wakes on. They are
the corpus behind the numbers in rust/README.md.
"""

import argparse
import concurrent.futures
import re
import subprocess
from pathlib import Path

ENGLISH = [
	"Samantha", "Daniel", "Karen", "Moira", "Rishi", "Tessa", "Fred", "Aman", "Tara",
	"Eddy (English (US))", "Eddy (English (UK))", "Flo (English (UK))", "Flo (English (US))",
	"Reed (English (US))", "Reed (English (UK))", "Sandy (English (UK))", "Sandy (English (US))",
	"Shelley (English (US))", "Shelley (English (UK))", "Grandpa (English (US))",
	"Grandma (English (US))", "Rocko (English (US))",
]
# Ways of writing the name that coax different voices into saying it.
SPELLINGS = ["Em-ha-ra", "Em hah rah", "Emm, hah, rah", "Em harra", "Ehm hara"]
# How speakers of the bot's other languages would write it.
NATIVE = {
	"Kyoko": "エムハラ",
	"Eddy (Japanese (Japan))": "エムハラ",
	"Flo (Japanese (Japan))": "エムハラ",
	"Yuna": "엠하라",
	"Flo (Korean (South Korea))": "엠하라",
	"Meijia": "艾姆哈拉",
	"Reed (Chinese (Taiwan))": "艾姆哈拉",
	"Flo (Chinese (Taiwan))": "艾姆哈拉",
}
COMMANDS = [
	"skip", "skip this song", "pause", "pause the music", "resume", "stop", "next song",
	"play some music", "play Bohemian Rhapsody", "play the next one", "turn it up",
	"turn the volume down", "shuffle the queue", "what is playing", "loop this song",
	"go back", "leave the channel", "play something by Queen",
]
NEGATIVES = [
	"I'm hoping we win tonight", "I'm headed to bed soon", "I'm here", "I'm hearing an echo",
	"I'm hosting the next game", "I'm hopeless at this level", "I'm hurt, heal me",
	"I'm hiding behind the wall", "I'm heavy on ammo", "I'm holding the left side",
	"um, hello?", "mm, okay", "hmm, hang on", "em, hold on a second", "M, H, R, A",
	"Mara is online", "Emma, are you there?", "Amara joined the call", "the camera is off",
	"Hara is my friend", "that was a horror movie", "a hammer and nails", "the harbor is busy",
	"emerald armor is rare", "embarrassing, honestly", "emergency, help me", "I am here now",
	"I'm a harder worker", "M and M's are great", "mhm, right", "aha, I see",
	"let's play another round", "can you hear me now", "my mic keeps cutting out",
	"who wants to queue for ranked", "the music is too loud", "we need one more player",
	"good game everyone", "I'll be back in five minutes", "turn on your camera",
	# The first round of training fired on "I'm h…", "-ara" names and
	# "um/em" fillers it had seen too few of, so more of each.
	"I'm hot", "I'm home", "I'm heading in", "I'm healing you", "I'm half asleep",
	"I'm hyped for this", "I'm helping Sam", "I'm honest with you", "I'm humming along",
	"I'm hitting the boss", "I'm hosting tonight", "I'm hearing things", "I'm happy for you",
	"I'm harmless, I promise", "I'm hard stuck in silver", "I'm halfway there", "I'm Harold",
	"I'm Hamid", "I'm Harriet", "I'm Hiro", "I'm Hana", "I'm Hamza", "I'm Haruka",
	"I am Hala", "Ahmed is here", "Akira is late", "Sahara desert", "Tiara looks nice",
	"Clara is muted", "Laura left the call", "Kiara can hear you", "Sarah is streaming",
	"Tamara said hi", "Samara is typing", "Ramadan starts soon", "Mohammed joined",
	"Emir is online", "Emil, can you hear me", "Amir and Hara are here", "Omar is back",
	"Harambe was a gorilla", "Hamburgers are ready", "Ham radio is cool", "Hammer time",
	"Mahara is a word", "Maharaja palace", "Mahjong night", "Makarena dance", "Marimba solo",
	"em, I forgot", "erm, what was that", "um, I'm here", "uh, hold on", "um, Harry, wait",
	"hmm, Hara, maybe", "oh my", "oh man, really", "ah, right", "mm hmm, sure",
	"emm, no thanks", "amen to that", "mate, come on", "Monster Hunter is a game", "ask me anything",
	"the camera angle is weird", "the mirror is broken", "a hamster ran away",
	"the hammock is comfy", "the harmonica is loud", "the hammer broke", "the horror game",
	"this map is huge", "the armor is gone", "I'll harass them later",
	"am I muted", "am I hearing this right", "am I late", "and hurry up", "and harder",
	"I'm muting myself", "I'm making dinner", "I'm mad at you", "I'm marking the target",
	"anyone have a charger", "the stream is lagging", "pass me the controller",
	"what time is it", "I need a break", "who is talking", "nice shot", "watch out behind you",
	"we lost again", "does anyone want pizza", "the server is down", "restart the game",
	"I can't see anything", "let me share my screen", "where are you guys", "sounds good to me",
]

# Evaluation only: never trained on.
EVAL_ENGLISH = [
	"I bought a new camera yesterday.", "Andrea is coming over later.", "Um, right, okay.",
	"The amber light was on.", "Have you been to the Alhambra?", "Omar said he would join.",
	"Panorama mode is broken.", "I'm right here.", "Ma'am, are you okay?", "Ambra is a nice name.",
	"Hamra street is busy.", "Tamra and Amy are in the call.", "Grandma, rap something.",
	"The drama was amazing.", "I am ready.", "I'm happy with that.", "I'm hungry, let's eat.",
	"I'm heading out now.", "I'm Harry, nice to meet you.", "I'm hardly ever online.",
	"I'm having a great time.", "I'm Hannah.", "Uh, I'm hiring next month.", "I'm a huge fan.",
	"Mm, hmm, okay.", "I'm heroic.", "I'm Hara's friend.",
	"Did you see the match last night? It was unbelievable.",
	"I think we should push mid and then rotate to the dragon.",
	"Can someone queue the next track, this one is getting old.",
	"My internet is lagging so badly right now.", "Okay, everyone ready? Three, two, one, go.",
	"Turn it up, I love this part of the song.", "Honestly the remix is better than the original.",
]
EVAL_OTHER = {
	"Kyoko": "昨日の試合見た？すごかったね。ちょっとご飯食べてくるね。この曲めっちゃ好き。マイク聞こえてる？次のラウンドで終わりにしよう。",
	"Yuna": "어제 경기 봤어? 진짜 대박이었어. 잠깐 밥 먹고 올게. 이 노래 너무 좋다. 내 목소리 들려? 한 판만 더 하고 자자.",
	"Meijia": "你昨天有看比賽嗎？太誇張了。我先去吃個飯。這首歌好好聽。你聽得到我嗎？再打一場就睡覺。",
}


def evaluation(out, pool):
	"""Negatives to score against, one file per voice."""
	out.mkdir(parents=True, exist_ok=True)
	jobs = []
	for voice in ENGLISH:
		text = " [[slnc 500]] ".join(EVAL_ENGLISH)
		jobs.append((voice, text, out / f"eval-{slug(voice)}.wav"))
	for voice, text in EVAL_OTHER.items():
		jobs.append((voice, text, out / f"eval-{slug(voice)}.wav"))
	list(pool.map(lambda job: say(*job), jobs))
	print(f"{len(jobs)} evaluation recordings in {out}")


# Heard as the name: a vowel or two, an m or n, an h, a vowel, then r.
NAME_LIKE = re.compile(r"[aei]{0,2}[mn]{1,2}h?[aeiu]+r+[aeiou]?h?|[aei]{0,2}h[aeiu]r+[aeiou]?h?")


def say(voice, text, path):
	if not path.exists():
		subprocess.run(
			["say", "-v", voice, "-o", str(path), "--data-format=LEI16@16000", f"[[slnc 300]] {text} [[slnc 400]]"],
			check=True,
		)


def transcribe(harness, paths):
	"""SenseVoice's reading of each file, through the wake_wav harness."""
	output = subprocess.run(
		[harness, "--whole", "--tail-ms", "0", *map(str, paths)], check=True, capture_output=True, text=True
	).stdout
	heard, current = {}, None
	for line in output.splitlines():
		match = re.match(r"^(/\S+\.wav) \(", line)
		if match:
			current = match.group(1)
		found = re.search(r'whole file: \[[^\]]*\] "(.*)"$', line)
		if found and current:
			heard[current] = found.group(1)
	return heard


def slug(voice):
	return re.sub(r"[^a-z]+", "_", voice.lower()).strip("_")


def normalise(text):
	return re.sub(r"\s+", " ", re.sub(r"[^A-Z' ]", " ", text.upper())).strip()


def main():
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("--out", type=Path, default=Path("training/wake/work/data/tts"))
	parser.add_argument("--harness", default="rust/target/release/examples/wake_wav")
	parser.add_argument("--jobs", type=int, default=8)
	parser.add_argument("--eval", action="store_true", help="write the evaluation negatives instead")
	args = parser.parse_args()
	# Absolute, so the harness prints back the same paths it was given.
	args.out = args.out.resolve()
	args.out.mkdir(parents=True, exist_ok=True)
	pool = concurrent.futures.ThreadPoolExecutor(args.jobs)
	if args.eval:
		evaluation(args.out.parent / "eval", pool)
		return

	# 1. Which voice says which spelling as the name.
	probes = {}
	for voice in ENGLISH:
		for number, spelling in enumerate(SPELLINGS):
			probes[args.out / f"probe-{slug(voice)}-{number}.wav"] = (voice, spelling, False)
	for voice, spelling in NATIVE.items():
		probes[args.out / f"probe-{slug(voice)}-native.wav"] = (voice, spelling, True)
	list(pool.map(lambda item: say(item[1][0], item[1][1] + ".", item[0]), probes.items()))
	heard = transcribe(args.harness, list(probes))

	kept = []
	for path, (voice, spelling, native) in probes.items():
		reading = heard.get(str(path), "")
		if native:
			good = spelling in reading
		else:
			good = NAME_LIKE.fullmatch(re.sub(r"[^a-z]", "", reading.lower())) is not None
		if good:
			kept.append((voice, spelling, native, path))
	print(f"{len(kept)} of {len(probes)} voice and spelling pairs say the name")

	# 2. The kept pairs, alone and before commands; and the negatives.
	clips = []
	for voice, spelling, native, probe in kept:
		clips.append((probe, "EMHARA", None))
		if native:
			continue
		for number, command in enumerate(COMMANDS):
			path = args.out / f"pos-{probe.stem[6:]}-{number:02d}.wav"
			clips.append((path, f"EMHARA {normalise(command)}", (voice, f"{spelling}, {command}.")))
	for voice in ENGLISH:
		for number, sentence in enumerate(NEGATIVES):
			path = args.out / f"neg-{slug(voice)}-{number:03d}.wav"
			clips.append((path, normalise(sentence), (voice, sentence + ".")))
	list(pool.map(lambda clip: clip[2] and say(clip[2][0], clip[2][1], clip[0]), clips))

	with open(args.out / "transcripts.tsv", "w", encoding="utf-8") as transcripts:
		for path, text, _ in clips:
			transcripts.write(f"{path.name}\t{text}\n")
	positives = sum(1 for _, text, _ in clips if text.startswith("EMHARA"))
	print(f"{positives} positives and {len(clips) - positives} negatives in {args.out}")


if __name__ == "__main__":
	main()
