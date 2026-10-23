# A dedicated wake word classifier (experiment)

The sidecar hears the name with a keyword spotter: a small streaming speech
recogniser that fires when the word pieces it hears spell `EMHARA`. This is
the other way to do it: a classifier that looks at the last 1.5 seconds of
sound and gives one score, "the name has just been said". It is an
experiment, scored on the same audio as the spotter, and the sidecar can use
it in the spotter's place (see [Using it](#using-it)).

```text
align.py ─▶ screen.py ─▶ train.py ─▶ score.py ─▶ export.py
(where the   (which clips   (12k steps,   (same audio as    (the network, and
 name ends)   are the name)  ~20 min MPS)  evaluate.py)      how its frames are made)
```

Everything is read from and written to `training/wake/work/` (gitignored), the
spotter's own training workspace: run the spotter's steps 1–3 first.

## Steps

From the repository root, with the training environment's Python
(`training/wake/work/.venv/bin/python`):

1. `training/wake/classifier/align.py`: finds where the name ends in every
   training positive, using a fine-tuned spotter at a low threshold. A
   classifier must learn to fire just after the name, so it needs that point;
   positives the spotter cannot place are left out.
2. Collected clips (`VOICE_COLLECT_WAKE_CLIPS`) into `work/data/collected/`,
   with `train.tsv` for your own and `test.tsv` for everyone else's, then
   `wake_wav --whole` over them into `transcripts.tsv`, then
   `training/wake/classifier/screen.py` (see below). Check its guesses by ear
   with `python3 training/wake/classifier/review.py`, which opens a page on
   this machine: play each clip, press `1` name, `2` chatter, `3` can't tell,
   or `enter` if the guess is right. Then run `screen.py` again, which keeps
   what you decided and rebuilds the members' test sets from it.
3. `training/wake/classifier/train.py`.
4. `evaluate.py` for the spotter, with and without `--echo`, over the
   held-out takes with the evaluation negatives and over
   `--held-out work/data/members-name` and `work/data/members-chatter`; then
   `training/wake/classifier/score.py` for the classifier, which reads the
   recordings evaluate.py joined and the room copies it wrote.
5. `training/wake/classifier/export.py`, for `models/voice/wake-classifier/`.

## The model

- **Input**: 40 log-mel bands every 10ms over 1.5s (148 frames), scored every
  30ms over a stream.
- **Network**: a convolution, four depthwise-separable blocks each halving
  time, then a dense head over what is left of time, 72k parameters. The head
  flattens rather than pools, so the model knows *where* in the window the
  name is and fires only once it has ended, where the gate needs the command
  to start.
- **Positives**: windows ending 20–150ms after the name.
- **Negatives**: LibriSpeech, the synthesised near misses ("I'm Harry", "Tamra
  and Amy"), your collected clips that are conversation, windows from the
  positives that end before the name is over or with it well back in the
  window, and hard negatives: every 3000 steps the training negatives are
  scored as a stream and the windows it is surest of are trained on again.
- **Augmentation**: speed ±12%, lhotse's simulated rooms (not the rooms
  evaluate.py scores with), another voice under it, noise, and loudness from
  −18 to +6dB.
- **Threshold and checkpoint**: chosen on held-out synthetic voices, held-out
  LibriSpeech speakers and a sixth of your chatter, at no more than two false
  wakes an hour there. The test sets are not read in training.

## The collected clips are not all the name

Every collected clip is something the deployed spotter woke on, labelled
`EMHARA` without anyone listening. Transcribed with SenseVoice, about a fifth
are plainly conversation it woke on, most of it everyday Cantonese and
Mandarin, and some short English replies ("Thanks.", "No."). The spotter's
false wakes in a real call are this, not the English near misses it is scored
on.
`screen.py` sorts them by that transcript into name, chatter and unclear, and
writes `work/data/collected/review.tsv`. Which transcripts count as which is
listed by hand in `work/data/collected/screen-rules.json`, in the workspace
rather than here, since it quotes what people said; anything unlisted is a
name if the recogniser heard English and unclear otherwise. It is a screen by text, not by ear:
check it with `review.py` before trusting it. Labels given there are marked
`ear` in the file's last column, and win over the screen's guess.

This also explains the spotter's last result in `../README.md`: training on the
collected clips "raised false wakes without raising recall", because a fifth
of what it was taught as the name was conversation.

Of the other members' 19 clips, only 4 screen as the name (3 from one member, 1
from another) and 10 as chatter. Four clips are too few to say much about
voices neither model trained on; they are the best there is until more
members record the name.

## Results

Three runs, each 12,000 steps (about 20 minutes on an M5 Pro's GPU). The
spotter is `kws-emhara`, as deployed. Both are scored on the same audio:
your 11 held-out takes, the other members' 4 clips that screen as the name
and 10 that screen as chatter, and the 32 minutes of evaluation negatives,
each as recorded and through evaluate.py's simulated rooms. A takes or
members cell is names heard; chatter is clips woken on; false wakes are per
hour of the evaluation negatives (one is 1.9).

| model | your takes | members' names | chatter | false wakes / h | your takes, room | members, room | chatter, room | false wakes / h, room |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `kws-emhara` | 8/11 | **4/4** | 2/10 | 5.6 | 5/11 | 2/4 | 0/10 | **1.9** |
| v1: clips as collected | 11/11 | 3/4 | 1/10 | 0.0 | 11/11 | 3/4 | 0/10 | 3.7 |
| v2: screened clips, chatter as negatives | 11/11 | 3/4 | 0/10 | 0.0 | 10/11 | 3/4 | 0/10 | 7.4 |
| **v3**: and validation through rooms | **11/11** | 3/4 | **0/10** | **0.0** | **11/11** | **3/4** | **0/10** | 3.7 |

- v2's threshold (0.87) was chosen on clean validation audio only, and let
  echo through; v3 validates on room copies too (lhotse's rooms, its own
  seed) and chose 0.96. A checkpoint that no threshold keeps within two
  false wakes an hour on validation is never chosen.
- The member clip every classifier misses is the one name from the second
  member (scored 0.000); the spotter hears it. The first member's three score
  1.000.
- On your takes the classifier has the advantage of having trained on 85 of
  your clips, where the spotter saw 10 of your takes.
- The chatter clips were chosen by the spotter firing on them live, which
  tilts that column against it.
- Room false wakes are 2 against 1 in 32 minutes: one event, too few to call.

**Cost.** In the sidecar, which keeps each speaker's mel frames and adds the
three new ones each hop, the classifier and the VAD together take 0.32% of one
M5 Pro core per speaker, against the spotter and VAD's 0.59%.

**What it means.** On the one voice it has heard plenty of, and on the
conversation the spotter wakes on, the classifier is clearly better. On
voices it has not heard, four clips from two people say nothing either way.
More members recording the name, and the screened labels checked by ear with
`review.py`, would make this a real comparison.

## Using it

`export.py` writes `models/voice/wake-classifier/`, which stays out of git
like every model:

- `net.onnx`: the network alone, 40 log-mel bands by 148 frames in, the logit
  out;
- `features.json`: how those frames are made, which the sidecar checks against
  its own before loading;
- `threshold.txt`: the score it wakes at, chosen on validation;
- `check.json`: a test signal's frames and logits, which the sidecar's tests
  compare with (`cargo test -p amhra-sidecar --features voice-commands
  classifier`; skipped where there is no export).

Set `VOICE_WAKE_CLASSIFIER` to `models/voice/wake-classifier` and restart the
bot: the sidecar starts with `--wake-classifier` in place of `--wake-model` and
`--wake-keywords`, and hears the name with the classifier
(`rust/amhra-sidecar/src/voice_commands/classifier.rs`, the network through
tract, the frames made as audio arrives). Unset it to go back to the spotter.
Wake clips are still saved, so the classifier's own false wakes can be
screened and trained on.

`wake_wav --wake-classifier models/voice/wake-classifier` runs the sidecar's
gate with it over WAV files. Over the same audio as `score.py` it gives the
same results as the v3 row above, waking about 100ms after the name ends.
