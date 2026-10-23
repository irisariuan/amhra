#!/usr/bin/env python3
"""Listen to the collected wake clips and say what each one is.

    python3 training/wake/classifier/review.py [--port 8765]

Opens a page in the browser, served from this machine only, listing every
clip in work/data/collected/review.tsv with what SenseVoice heard in it and
screen.py's guess. Play a clip, then give it a label:

    space        play it again
    1 / 2 / 3    the name / chatter / can't tell, and on to the next
    enter        the guess is right, and on to the next
    ↑ ↓ (k j)    move without labelling

Each label is written to review.tsv at once, marked `ear`, which screen.py
keeps when it runs again. Run screen.py afterwards to rebuild the members'
test sets from what you decided. Standard library only; the clips never leave
this machine.
"""

import argparse
import json
import os
import tempfile
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
COLLECTED = HERE.parent / "work" / "data" / "collected"
REVIEW = COLLECTED / "review.tsv"
LABELS = ("name", "chatter", "unclear")
COLUMNS = ("file", "speaker", "language", "heard", "label", "by")
# One label written at a time: each is a read, a change and a whole write.
WRITING = threading.Lock()


def load():
	lines = REVIEW.read_text(encoding="utf-8").splitlines()
	rows = []
	for line in lines[1:]:
		cells = line.split("\t")
		cells += ["screen"] * (len(COLUMNS) - len(cells))
		rows.append(dict(zip(COLUMNS, cells)))
	return rows


def yours():
	"""Your own clips: the ones collected/train.tsv lists."""
	lines = (COLLECTED / "train.tsv").read_text(encoding="utf-8").splitlines()
	return {line.split("\t", 1)[0] for line in lines if line.strip()}


def save(rows):
	"""Write review.tsv whole, through a temporary file, so a crash mid-write
	never leaves half of it."""
	text = "\t".join(COLUMNS) + "\n" + "".join("\t".join(row[c] for c in COLUMNS) + "\n" for row in rows)
	handle, temporary = tempfile.mkstemp(dir=COLLECTED, suffix=".tsv")
	with os.fdopen(handle, "w", encoding="utf-8") as out:
		out.write(text)
	os.replace(temporary, REVIEW)


class Review(BaseHTTPRequestHandler):
	"""Every request reads review.tsv afresh, so a screen.py run, or a second
	page, is never written over with an old copy."""

	def log_message(self, *_):
		pass

	def send(self, status, body, kind):
		self.send_response(status)
		self.send_header("Content-Type", kind)
		self.send_header("Content-Length", str(len(body)))
		self.send_header("Cache-Control", "no-store")
		self.end_headers()
		self.wfile.write(body)

	def do_GET(self):
		if self.path == "/":
			return self.send(200, PAGE.encode(), "text/html; charset=utf-8")
		if self.path == "/clips":
			mine = yours()
			clips = [{**row, "who": "you" if row["file"] in mine else f"…{row['speaker'][-4:]}"} for row in load()]
			return self.send(200, json.dumps(clips).encode(), "application/json")
		if self.path.startswith("/audio/"):
			name = self.path.removeprefix("/audio/")
			# Only the files the review lists: nothing else on disk is served.
			if any(row["file"] == name for row in load()):
				return self.send(200, (COLLECTED / name).read_bytes(), "audio/wav")
		self.send(404, b"not found", "text/plain")

	def do_POST(self):
		if self.path != "/label":
			return self.send(404, b"not found", "text/plain")
		asked = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
		with WRITING:
			rows = load()
			row = next((row for row in rows if row["file"] == asked.get("file")), None)
			if row is None or asked.get("label") not in LABELS:
				return self.send(400, b"no such clip or label", "text/plain")
			row["label"], row["by"] = asked["label"], "ear"
			save(rows)
		self.send(200, json.dumps(row).encode(), "application/json")


PAGE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wake Clip Review</title>
<style>
:root {
	--bg: #f7f7f5; --panel: #ffffff; --text: #1c1c1a; --muted: #6b6b66; --line: #e4e3df;
	--focus: #2f5bd3; --name: #1f7a4d; --chatter: #b4462d; --unclear: #8a6d12; --ear: #1c1c1a;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #161615; --panel: #1f1f1d; --text: #ecebe6; --muted: #9b9a94; --line: #33332f;
		--focus: #7d9bff; --name: #5cc58f; --chatter: #f08a6e; --unclear: #e0c25a; --ear: #ecebe6;
	}
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, sans-serif; }
header { position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--line); padding: 12px 16px; z-index: 1; }
h1 { font-size: 17px; margin: 0 0 6px; }
.bar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; color: var(--muted); font-size: 13px; }
.progress { flex: 1 1 160px; height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; min-width: 120px; }
.progress div { height: 100%; background: var(--focus); width: 0; }
select { font: inherit; padding: 3px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text); }
.keys { font-size: 12px; color: var(--muted); margin-top: 6px; }
kbd { border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px; padding: 0 5px; font: 12px ui-monospace, monospace; background: var(--panel); }
main { max-width: 900px; margin: 0 auto; padding: 12px 16px 80px; }
.clip { display: grid; grid-template-columns: 4.2em 1fr auto; gap: 4px 12px; align-items: center; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); margin-bottom: 6px; cursor: pointer; }
.clip.current { outline: 2px solid var(--focus); outline-offset: -1px; }
.who { color: var(--muted); font-size: 13px; }
.heard { overflow-wrap: anywhere; }
.heard small { color: var(--muted); margin-left: 6px; }
.labels { display: flex; gap: 4px; }
.labels button { font: inherit; font-size: 13px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--muted); cursor: pointer; }
.labels button.on { color: var(--panel); border-color: transparent; }
.labels button.on[data-label=name] { background: var(--name); }
.labels button.on[data-label=chatter] { background: var(--chatter); }
.labels button.on[data-label=unclear] { background: var(--unclear); }
.labels button.on.guess { background: transparent; border-style: dashed; }
.labels button.on.guess[data-label=name] { color: var(--name); border-color: var(--name); }
.labels button.on.guess[data-label=chatter] { color: var(--chatter); border-color: var(--chatter); }
.labels button.on.guess[data-label=unclear] { color: var(--unclear); border-color: var(--unclear); }
.empty { color: var(--muted); text-align: center; padding: 40px 0; }
@media (max-width: 560px) {
	.clip { grid-template-columns: 1fr; }
	.keys { display: none; }
}
</style>
</head>
<body>
<header>
	<h1>Wake clips</h1>
	<div class="bar">
		<span id="count"></span>
		<div class="progress"><div id="done"></div></div>
		<label>Show <select id="show">
			<option value="todo">not heard yet</option>
			<option value="all">all</option>
			<option value="name">name</option>
			<option value="chatter">chatter</option>
			<option value="unclear">can't tell</option>
		</select></label>
		<label>Speaker <select id="who"><option value="">everyone</option></select></label>
	</div>
	<div class="keys"><kbd>space</kbd> play · <kbd>1</kbd> name · <kbd>2</kbd> chatter · <kbd>3</kbd> can't tell · <kbd>enter</kbd> guess is right · <kbd>↑</kbd><kbd>↓</kbd> move. Each clip is the second before the name ended and a little after. Dashed = guessed from the transcript; solid = heard by you.</div>
</header>
<main id="list"></main>
<audio id="player" preload="auto"></audio>
<script>
const LABELS = ["name", "chatter", "unclear"];
const NAMES = { name: "name", chatter: "chatter", unclear: "can't tell" };
let clips = [], shown = [], current = 0;
const $ = (id) => document.getElementById(id);
const player = $("player");

async function start() {
	clips = await (await fetch("/clips")).json();
	for (const who of [...new Set(clips.map((c) => c.who))]) {
		$("who").append(new Option(who, who));
	}
	render();
	if (shown.length) select(0, false);
}

function visible(clip) {
	const show = $("show").value, who = $("who").value;
	if (who && clip.who !== who) return false;
	if (show === "todo") return clip.by !== "ear";
	if (show === "all") return true;
	return clip.label === show;
}

function render() {
	const keep = shown[current]?.file;
	shown = clips.filter(visible);
	const heard = clips.filter((c) => c.by === "ear").length;
	$("count").textContent = `${heard} of ${clips.length} heard`;
	$("done").style.width = `${(100 * heard) / clips.length}%`;
	const list = $("list");
	list.replaceChildren();
	if (!shown.length) {
		list.innerHTML = '<p class="empty">Nothing here.</p>';
		return;
	}
	shown.forEach((clip, index) => {
		const row = document.createElement("div");
		row.className = "clip";
		row.dataset.index = index;
		const who = document.createElement("span");
		who.className = "who";
		who.textContent = clip.who;
		const heardText = document.createElement("span");
		heardText.className = "heard";
		heardText.textContent = clip.heard;
		const language = document.createElement("small");
		language.textContent = clip.language;
		heardText.append(language);
		const labels = document.createElement("span");
		labels.className = "labels";
		for (const label of LABELS) {
			const button = document.createElement("button");
			button.dataset.label = label;
			button.textContent = NAMES[label];
			if (clip.label === label) button.classList.add("on");
			if (clip.label === label && clip.by !== "ear") button.classList.add("guess");
			button.addEventListener("click", (event) => {
				event.stopPropagation();
				select(index, false);
				give(label);
			});
			labels.append(button);
		}
		row.append(who, heardText, labels);
		row.addEventListener("click", () => select(index, true));
		list.append(row);
	});
	const again = shown.findIndex((c) => c.file === keep);
	current = again >= 0 ? again : Math.min(current, shown.length - 1);
	mark();
}

function mark() {
	document.querySelectorAll(".clip").forEach((row) => row.classList.toggle("current", Number(row.dataset.index) === current));
	document.querySelector(".clip.current")?.scrollIntoView({ block: "nearest" });
}

function select(index, play) {
	if (!shown.length) return;
	current = Math.max(0, Math.min(index, shown.length - 1));
	mark();
	player.src = "/audio/" + encodeURIComponent(shown[current].file);
	if (play) player.play().catch(() => {});
}

async function give(label) {
	const clip = shown[current];
	if (!clip) return;
	const response = await fetch("/label", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ file: clip.file, label }),
	});
	if (!response.ok) return alert("Could not save: " + (await response.text()));
	Object.assign(clip, await response.json());
	const next = shown[current + 1]?.file;
	render();
	// On to the next clip, which may have moved now this one left the view.
	const at = next ? shown.findIndex((c) => c.file === next) : -1;
	if (at >= 0) select(at, true);
	else if (shown.length) select(current, true);
}

document.addEventListener("keydown", (event) => {
	if (event.target.tagName === "SELECT") return;
	const key = event.key;
	if (key === " ") { event.preventDefault(); player.currentTime = 0; player.play().catch(() => {}); }
	else if (key === "1" || key === "2" || key === "3") give(LABELS[Number(key) - 1]);
	else if (key === "Enter" && shown[current]) give(shown[current].label);
	else if (key === "ArrowDown" || key === "j") { event.preventDefault(); select(current + 1, true); }
	else if (key === "ArrowUp" || key === "k") { event.preventDefault(); select(current - 1, true); }
});
$("show").addEventListener("change", () => { render(); select(current, false); });
$("who").addEventListener("change", () => { render(); select(current, false); });
start();
</script>
</body>
</html>
"""


def main():
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("--port", type=int, default=8765)
	parser.add_argument("--no-browser", action="store_true")
	args = parser.parse_args()
	if not REVIEW.exists():
		raise SystemExit(f"{REVIEW} is missing: run screen.py first")
	server = ThreadingHTTPServer(("127.0.0.1", args.port), Review)
	url = f"http://127.0.0.1:{args.port}/"
	print(f"reviewing {len(load())} clips at {url} (ctrl-c to stop)")
	if not args.no_browser:
		webbrowser.open(url)
	try:
		server.serve_forever()
	except KeyboardInterrupt:
		pass


if __name__ == "__main__":
	main()
