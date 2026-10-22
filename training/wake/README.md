# Training the wake word

The stock keyword spotter is a general English model, and "em-ha-ra" is not
an English word. It hears the name only if it is spelled the way the model
happens to split the sound (`M HARA`), and even then it misses most real
speakers. This fine-tunes that same model on recordings of the name, so it
learns the word itself.

It is icefall's own recipe for the GigaSpeech spotter
(`egs/gigaspeech/KWS`), started from the published checkpoint. It runs on a
CPU in minutes, and the result drops into the sidecar with
`--wake-model <dir>`. Nothing else changes: same runtime, same latency, same
4MB-ish int8 model.

```text
record_users ─▶ segment.py ─▶ label ─┐
synthesize.py (macOS say) ───────────┼─▶ prepare.py ─▶ finetune.py ─▶ export.sh ─▶ evaluate.py
LibriSpeech dev-clean ───────────────┘   (features)    (6 CPU procs)  (int8 ONNX)
```

Everything generated — the Python environment, icefall, the checkpoint, the
audio, features and checkpoints — lives in `training/wake/work/`, which is
gitignored. Recordings of members' voices never go in the repository.

## Steps

Run from the repository root.

1. **Environment** (once; about 1GB):

   ```bash
   training/wake/setup.sh
   ```

2. **Record the name.** Ask members to say it in a voice channel, a dozen
   times each, alone and before commands, with a second or two between:

   ```bash
   cargo run --release -p amhra-voice --example record_users -- \
     --guild <GUILD_ID> --channel <VOICE_CHANNEL_ID> --seconds 60 --keep-gaps --out data/recordings/wake
   ```

   Then cut each speaker's file into utterances, sending every other one to
   the test set:

   ```bash
   python3 training/wake/segment.py data/recordings/wake/<user>.wav training/wake/work/data/real --every-nth-test 2
   ```

   and edit `training/wake/work/data/real/{train,test}.tsv`: each line starts
   as `EMHARA`; add the command where one followed (`EMHARA SKIP THIS SONG`)
   and delete anything that is not the name.

   More speakers matter more than more takes from one: a model trained on
   one voice learns that voice.

   **Or use what the bot collected.** With `VOICE_COLLECT_WAKE_CLIPS` on
   (the default once `VOICE_COMMANDS` is), every wake in a server that turned
   voice commands on is saved to `data/recordings/wake-clips/`, one
   `<guild>-<user>-<time>.wav` per wake, labelled `EMHARA` in `clips.tsv`.
   These are the takes the current model already finds; the ones it misses
   still need recording. Listen to each: delete the ones that are not the
   name, and add the command where one followed. Copy the rest into
   `training/wake/work/data/real/`, appending their lines to `train.tsv`, or
   to `test.tsv` for a speaker you want held out.

3. **Synthesised speech and general English.**

   ```bash
   cargo build --release --manifest-path rust/Cargo.toml -p amhra-sidecar --features voice-commands --examples
   python3 training/wake/synthesize.py
   python3 training/wake/synthesize.py --eval
   ```

   and LibriSpeech dev-clean (337MB, CC BY 4.0) into
   `training/wake/work/data/LibriSpeech`:

   ```bash
   curl -L https://openslr.elda.org/resources/12/dev-clean.tar.gz | tar -xz -C training/wake/work/data
   ```

4. **Prepare, train, export.**

   ```bash
   training/wake/work/.venv/bin/python training/wake/prepare.py
   ```

   ```bash
   training/wake/work/.venv/bin/python training/wake/finetune.py --num-epochs 3
   ```

   Then export each epoch on its own (`export.sh <epoch> 1 <name>`), score
   each as in step 5, and keep the best as `kws-emhara`. With little real
   data the best is usually an early epoch: validation loss keeps falling
   while false wakes on unseen speech climb.

   ```bash
   training/wake/export.sh 1 1
   ```

5. **Score it** against the held-out recordings and the evaluation
   negatives, and the stock spotter the same way for comparison:

   ```bash
   python3 training/wake/evaluate.py --wake-model models/voice/kws-emhara --keywords training/wake/keywords.txt training/wake/work/data/eval/*.wav
   ```

   ```bash
   python3 training/wake/evaluate.py training/wake/work/data/eval/*.wav
   ```

6. **Use it**: start the sidecar with `--wake-model models/voice/kws-emhara
   --wake-keywords training/wake/keywords.txt`, or try it live with
   `wake_live --wake-model … --keywords …`.

## What the data is for

- **Real recordings** are the point. Each training clip is used in 20
  variants: as recorded, through Opus at 24, 40 and 64kbps (what Discord
  does to it), faster, slower, quieter and louder.
- **Synthesised positives** add voices. Text-to-speech mispronounces a made-up
  name more often than not, so each voice and spelling is screened first:
  SenseVoice transcribes the name alone, and only voices heard saying it go
  on to say commands. A positive that is really another word teaches the
  model to fire on that word.
- **Synthesised negatives** are what it must *not* fire on: "I'm happy",
  "I'm Harry", "Mara", "um, hello". Spelling the stock model's way into the
  name (`I'M HARA`) found 12 of 21 real takes and fired on 12 of 96 such
  sentences; this is the difference the model has to learn.
- **LibriSpeech** keeps the rest of its English. Fine-tuned on the name alone,
  a model forgets everything else and starts hearing the name everywhere.

## Why it runs this way

- **CPU, one thread per process.** On an M5 Pro a training step is *slower*
  with more threads (2.3s on one, 3.4s on ten), so `finetune.py` runs one
  data-parallel worker per performance core over gloo, as the recipe runs one
  per GPU. A 5.6-hour epoch takes about two and a half minutes.
- **The transcript is always EMHARA.** The model learns to emit the pieces
  `▁E M HA RA` for the sound, however a speaker says it, so the keywords file
  for the trained model is just `EMHARA` (`keywords.txt` here).

## Results

One member's recording, cut into 21 takes: 10 for training, 11 held out.
Negatives are `synthesize.py --eval`: 32 minutes of sentences never trained
on, in 22 English voices and Japanese, Korean and Mandarin, many of them
near misses ("I'm Hara's friend", "Tamra and Amy are in the call", "I'm
hiring"). Threshold 0.25 unless noted.

| model | held-out takes | false wakes / hour |
| --- | --- | --- |
| stock spotter, `M HARA #0.1` | 1/11 | 0 |
| 480 negatives, epoch 1 | 3/11 | 0 |
| 480 negatives, epoch 2 | 8/11 | 7.4 |
| 480 negatives, epoch 3 | 11/11 | 48 |
| 480 negatives, epoch 3, threshold 0.55 | 4/11 | 11 |
| 480 negatives, epochs 8–10 averaged | 7/11 | 257 |
| **3058 negatives + 5.4h LibriSpeech, epoch 1** (`kws-emhara`) | **9/11** | **5.6** |
| same, epoch 2 | 10/11 | 41 |
| same, epoch 5 | 11/11 | 69 |

Six times the negatives (139 sentences in all 22 voices, mostly the kinds
the first model fired on) moved the useful point from 8/11 to 9/11 and cut
false wakes. It did not stop later epochs overfitting. That comes from the
positives: ten takes from one voice, and synthetic voices for the rest. The
threshold barely matters for the chosen model: 0.15 to 0.3 give the same
9/11 and 3 false wakes.

Every number here is one speaker. Before relying on it, record a few more
members and score again; their takes are both the best training data and the
only honest test.
