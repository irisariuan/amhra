#!/usr/bin/env python3
"""Sort the collected wake clips by what SenseVoice heard in them.

    python3 training/wake/classifier/screen.py

Every collected clip is something the deployed spotter woke on, labelled
EMHARA without anyone listening. Many are not the name: a fifth or so are
Cantonese and Mandarin conversation it woke on. This sorts them by the
transcript work/data/collected/transcripts.tsv holds (from `wake_wav
--whole`), using lists of transcripts written by hand in
work/data/collected/screen-rules.json, into

- name: an English-ish rendering of the name ("I'm Har", "Emra", "Mhar skip"),
- chatter: plainly something else, such as everyday conversation in Cantonese
  or Mandarin, or "Thanks.",
- unclear: too short or too odd to tell ("How.", "Para."),

and writes work/data/collected/review.tsv, for a person to check by ear with
review.py. It is a screen by text, not by ear: the labels are a best guess,
marked `screen` in the last column. A label someone gave by ear is marked
`ear` and is kept when this runs again.

What the sidecar noted beside the clips comes before the transcript, if
outcomes.tsv and near-misses.tsv were copied in with them:

- a wake the bot found a command after is the name, marked `outcome`;
- a near miss (`…-near.wav`, a try the classifier did not wake on) just
  before such a wake is the name too, marked `repeat`: the speaker said it
  again because it went unheard.

Both are still guesses, shown as such in review.py.

It also lays out the other members' clips for evaluate.py and score.py:
work/data/members-name/ and work/data/members-chatter/, each with a test.tsv.
"""

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "work" / "data"
COLLECTED = DATA / "collected"

# What the transcripts that are not the name say is people's conversation, so
# the lists of them live with the clips, in the gitignored workspace, not here:
# {"name": […], "chatter": […], "unclear": […]} of transcripts, written by hand.
RULES = COLLECTED / "screen-rules.json"


def rules():
	"""The hand-made lists: transcript to label."""
	if not RULES.exists():
		return {}
	loaded = json.loads(RULES.read_text(encoding="utf-8"))
	return {text: kind for kind in ("name", "chatter", "unclear") for text in loaded.get(kind, [])}


def yours():
	"""The clips that are yours: the ones collected/train.tsv lists, and the near
	misses saved beside them."""
	lines = (COLLECTED / "train.tsv").read_text(encoding="utf-8").splitlines()
	listed = {line.split("\t", 1)[0] for line in lines if line.strip()}
	return listed | {file.removesuffix(".wav") + "-near.wav" for file in listed}


def label(text, lang, listed):
	"""A transcript's label: from the lists when it is in them, otherwise a
	name if the recogniser heard English, which is how it mostly hears the
	name, and unclear if not."""
	return listed.get(text, "name" if lang == "en" else "unclear")


def sidecar_notes():
	"""Labels from what the sidecar noted, by file: `outcome` for wakes the bot
	found a command after, `repeat` for the near misses before them."""
	outcomes = COLLECTED / "outcomes.tsv"
	if not outcomes.exists():
		return {}
	commanded = set()
	for line in outcomes.read_text(encoding="utf-8").splitlines():
		file, outcome = line.split("\t")[:2]
		if outcome == "command":
			commanded.add(file)
	notes = {file: "outcome" for file in commanded}
	near = COLLECTED / "near-misses.tsv"
	if near.exists():
		for line in near.read_text(encoding="utf-8").splitlines():
			file, wake = line.split("\t")[:2]
			if wake in commanded:
				notes[file] = "repeat"
	return notes


def by_ear():
	"""Labels someone has already given by listening, by file."""
	path = COLLECTED / "review.tsv"
	if not path.exists():
		return {}
	kept = {}
	for line in path.read_text(encoding="utf-8").splitlines()[1:]:
		cells = line.split("\t")
		if len(cells) >= 6 and cells[5] == "ear":
			kept[cells[0]] = cells[4]
	return kept


def main():
	heard = by_ear()
	noted = sidecar_notes()
	listed = rules()
	mine = yours()
	rows = []
	for line in (COLLECTED / "transcripts.tsv").read_text(encoding="utf-8").splitlines():
		file, lang, text = line.split("\t")
		if file == "test-joined.wav":
			continue
		if file in heard:
			rows.append((file, file.split("-")[1], lang, text, heard[file], "ear"))
		elif file in noted:
			rows.append((file, file.split("-")[1], lang, text, "name", noted[file]))
		else:
			rows.append((file, file.split("-")[1], lang, text, label(text, lang, listed), "screen"))
	with (COLLECTED / "review.tsv").open("w", encoding="utf-8") as out:
		out.write("file\tspeaker\tlanguage\theard\tlabel\tby\n")
		for row in sorted(rows):
			out.write("\t".join(row) + "\n")

	for name, wanted, text in (("members-name", "name", "EMHARA"), ("members-chatter", "chatter", "CHATTER")):
		folder = DATA / name
		folder.mkdir(exist_ok=True)
		lines = []
		for file, _, _, _, got, _ in sorted(rows):
			if file not in mine and got == wanted:
				link = folder / file
				if not link.exists():
					link.symlink_to(COLLECTED / file)
				lines.append(f"{file}\t{text}\n")
		(folder / "test.tsv").write_text("".join(lines), encoding="utf-8")

	for speaker in sorted({row[1] for row in rows}):
		counts = {kind: sum(1 for row in rows if row[1] == speaker and row[4] == kind) for kind in ("name", "chatter", "unclear")}
		who = "you" if any(row[1] == speaker and row[0] in mine for row in rows) else f"…{speaker[-4:]}"
		ears = sum(1 for row in rows if row[1] == speaker and row[5] == "ear")
		print(f"{who}: {counts}, {ears} by ear")


if __name__ == "__main__":
	main()
