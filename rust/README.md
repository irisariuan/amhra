# amhra Rust workspace

The audio path, moving to Rust in phases. Each phase is independently useful and
independently revertable; the TypeScript bot keeps working throughout.

| crate | what it owns | phase |
| --- | --- | --- |
| `amhra-audio` | WebM/Opus demuxing, Opus TOC parsing, `.idx` index, cache reader | 1, 3 ✅ |
| `amhra-fetch` | InnerTube extraction, ranged download, yt-dlp fallback | 1 ✅ |
| `amhra-voice` | gateway v8, UDP/RTP/AEAD, DAVE, player, volume, crossfade, receive | 2, 3 ✅ |
| `amhra-sidecar` | the long-lived process: RPC, per-guild playback, voice commands | 4 |

## Build

```bash
bun run build:rust
```

```bash
bun run test:rust
```

```bash
bun run lint:rust
```

Live tests talk to YouTube and are ignored by default:

```bash
cargo test --manifest-path rust/Cargo.toml -p amhra-fetch --test live -- --ignored
```

## Phase 1: fetching

Turn it on in `data/setting.json`:

```json
{ "USE_NATIVE_FETCH": true }
```

`NATIVE_FETCH_BIN` overrides the binary path; the default is
`rust/target/release/amhra-fetch`. With the flag off — or the binary missing —
`lib/voice/stream.ts` uses yt-dlp exactly as before, so this is a switch, not a
cutover.

### Why it is faster

YouTube throttles an unranged GET to roughly playback speed. Measured on one
track: **32KB/s** for a plain GET against **7MB/s** for the same bytes requested
as ranges. So `amhra-fetch` never streams — it issues 1MiB ranged requests, four
in flight, and consumes them in order so the file on disk is contiguous at every
instant and a player can follow it while it downloads.

The demuxer runs over those same buffers on their way to disk, so the seek index
costs one pass over memory that is already hot: no second read, no ffprobe, no
extra process.

### What it produces

- `<id>.music` — the container exactly as YouTube served it, byte-identical to
  what yt-dlp would have written. Still playable in any media player.
- `<id>.idx` — a sidecar index, one entry per second, memory-mapped at playback
  for O(1) seek. ~1.7KB for a 3.5-minute track.

Both are written as `.temp.*` and renamed on success, so a failed or killed
download can never be mistaken for a cache hit.

### The client ladder

`src/profiles.json` lists InnerTube client profiles, tried in order. Copy it to
`data/youtube-clients.json` to change the ladder without rebuilding — when
YouTube retires a client, that is the fix.

Probed 2026-08-13: `ANDROID_VR` and `IOS` return plain URLs with **no `n`
parameter and no `signatureCipher`**, so no player-JS descrambling is needed.
`TVHTML5` and `WEB` answer `UNPLAYABLE` without a PO token. If that changes, the
live test `a_profile_still_yields_a_direct_opus_url` fails loudly and the nsig
work becomes due.

A URL can pass the player endpoint and still be refused by the media host —
YouTube bot-checks in both places — so a rejected download resumes the ladder at
the next profile rather than giving up on the native path.

### Fallback

If every profile fails, `amhra-fetch` shells out to `yt-dlp` and indexes its
output the same way, logging why. yt-dlp is optional: a missing binary is
reported, not fatal. A non-WebM result (legacy AAC) is cached without an index
and reported as `"index": null`.

## Interface

`amhra-fetch` writes progress lines to stderr and one JSON object as the last
line of stdout:

```json
{
  "ok": true,
  "videoId": "dQw4w9WgXcQ",
  "path": "cache/dQw4w9WgXcQ.music",
  "index": "cache/dQw4w9WgXcQ.idx",
  "bytes": 3433755,
  "frames": 10653,
  "durationMs": 213061,
  "itag": 251,
  "source": "innertube",
  "profile": "android_vr",
  "elapsedMs": 236,
  "fallbackReason": null
}
```

## Phase 2: voice transport

Built and unit-tested: gateway v8 (identify/resume with `seq_ack`, heartbeat
with missed-ack death, close-code-driven reconnect policy), UDP with IP
discovery, RTP framing, and both current AEAD modes.

```text
packet = rtp_header(12) ‖ AEAD(opus, aad=rtp_header, nonce=counter_be32‖zeros) ‖ counter_be32(4)
         0x80 0x78 seq:u16 ts:u32 ssrc:u32
```

The RTP timestamp advances by the packet's *real* sample count, read from the
Opus TOC, not a hardcoded 960 — a non-20ms source would otherwise drift against
the listener's clock.

The nonce counter is refused rather than wrapped when it runs out. Under AES-GCM
a repeated nonce is a key compromise, not a dropped packet.

### Measured: DAVE is mandatory

Answered on 2026-08-13 against a real guild. Identifying with
`max_dave_protocol_version: 0` is closed with **`4017 E2EE/DAVE protocol
required`** before the session opens — not a downgrade, a refusal. Retrying is
pointless (the same identify is re-sent), so 4017 is classified fatal.

With version 1 advertised, the handshake completes: `ready`, IP discovery,
`session description` with `dave version 1`, then `op25 external sender` once
the key package is sent.

The key package must be sent **unprompted** as soon as the session exists. The
server will not announce its external sender until it has one, so a client that
only answers `op25` waits forever for a message that is waiting on it.

### The remaining gate: a second participant

The handshake now stalls after `op25`, and the reason looks structural: the bot
is alone in the channel. MLS group formation is driven by `op27` proposals —
the server proposing who to add — and with one participant there is nobody to
propose. No group, no exported media key, no audio (and nobody to hear it).

So the last step needs a human in the voice channel:

```bash
cargo run --release -p amhra-voice --example play_file -- \
  --guild <GUILD_ID> --channel <VOICE_CHANNEL_ID> \
  --file cache/<id>.music --seconds 20
```

with `DEV_TOKEN` in the environment. Expected once someone else is present:
`op27 proposals` → `op28 commit_welcome` → `op30 welcome` or `op29 announce
commit` → `dave group ready` → audible audio.

## Phase 3: playback

`CacheReader` memory-maps a `.music` file and demuxes it incrementally, so a
frame handed to the player is a slice of the page cache — playback copies
nothing. A file still downloading is picked up by `refresh`, which remaps and
parses only the bytes that arrived since last time. Completeness is only ever
taken from something that knows (a finalised index, or the renamed file); a
truncated file can be named anything, and guessing here would end tracks early.

`Player` holds an ACTIVE and a STANDBY track and switches between them *on the
same tick* — the caller asks for a frame at the seam and gets one, rather than
getting nothing and asking again 20ms later. That is what keeps the RTP clock
and the listener's jitter buffer from ever seeing a gap. Running out of
buffered audio is reported as starving, not as the track ending, so a download
falling behind stalls instead of skipping the song.

`Volume` is the goal-A win. Opus has no gain field a receiver will honour, so
changing volume means decode, scale, re-encode. At volume 100 that entire path
is skipped and the frame passes through byte-for-byte — the codec is never even
constructed. The old pipeline paid decode + re-encode on every stream
regardless of volume, plus an ffmpeg process per track.

`Crossfader` mixes the tail of one track into the head of the next with
equal-power gains — linear ones sum to an audible dip in the middle. The fade is
the one moment both tracks must exist as PCM at once, so it is the one moment
the codec cost is unavoidable; it is paid per *track change*, not per frame. A
three second fade is 150 frames of work. `crossfade_ms = 0` keeps the hard cut
and stays entirely on the passthrough path. Skips use their own, much shorter
fade, because a skip should feel immediate rather than mixed.

`Mixer` plays several tracks at once. The queue's track stays the *main*
source, and anything else (a second song, an ambience bed) is a *layer*, added
with `addLayer` under an id the bot picks. Each source has its own gain
(`setMainVolume`, `setLayerVolume`), and `setVolume` is the master over the sum.
With no layers and an overall unity gain, frames still pass through
byte-for-byte. While anything is layered, every source is decoded, summed and
encoded once per frame. Every gain change slides across one frame instead of
stepping, so layers join, leave and change level without clicks. The sum
saturates instead of limiting, so two loud tracks at full gain will clip, and
turning one down fixes it. `stop` silences the layers along with the queue.
`swapLayer` trades a layer with the queue's track on one tick: gain, position
and decoder state each go with their track, so nothing audible changes, only
which track the queue controls.

Verified live end to end:

```bash
cargo run --release -p amhra-voice --example play_file -- \
  --guild <GUILD> --channel <CHANNEL> \
  --file cache/<a>.music --next cache/<b>.music \
  --seek 205000 --crossfade 3000 --seconds 20
```

which seeks near the end of the first track, blends into the second, and
reports `Started(second)` before `Finished(first)` — the overlap, in the log.

## Streaming without the cache

```json
{ "USE_RUST_VOICE": true, "NATIVE_NO_CACHE": true }
```

The sidecar then downloads each track itself, with the same client ladder and
ranged requests as `amhra-fetch`, and hands every chunk straight to the reader
that plays it. Nothing is written to `cache/`, and `amhra-fetch` does not need
to be built.

A track is held in memory, whole, for as long as it is loaded, so it seeks
both ways like a cached file; the buffer is sized once from the download's
length. It is freed the moment the track is done with — finished, skipped,
replaced as the next track, or stopped — and dropping a reader mid-download
closes its channel, so the download stops at its next chunk.

What that costs:

- A seek past what has arrived waits for the audio to get there.
- The next track is armed by starting its stream, so crossfades still work.
- A URL refused part-way through resumes under the next client only if that
  client serves the same itag at the same size, so the bytes line up.
- There is no yt-dlp fallback, because yt-dlp only writes files.
- A track already whole in the cache is still played from there, since that
  costs nothing. A partial `.temp.music` is not trusted, because nothing is
  downloading it.
## Receiving

The first step towards voice commands: hearing the channel. Off unless the
sidecar is started with `--listen` (or `--voice-commands`, which consumes what
it hears; see below).

```text
UDP ─▶ transport open ─▶ SSRC → user ─▶ DAVE decrypt ─▶ Opus decode ─▶ 16 kHz mono PCM
        (crypto.rs)       (op 5)        (dave/decryptor.rs)            (receive.rs)
```

- **Attribution.** The server's `speaking (5)` is the only thing that ties an
  SSRC to a user, and it is sent when they start talking — so their first
  packets can arrive before it. Those are held for a second rather than
  dropped, which is what keeps the first word.
- **Transport.** Other clients send a header extension. Under the `_rtpsize`
  modes its 4-byte preamble is cleartext AAD and its body is encrypted with the
  payload, so it is cut off after decryption, along with any RTP padding.
- **DAVE.** Every member's key is exported from the group on each epoch change.
  The previous epoch, and a sender's previous generation, stay usable for ten
  seconds so frames in flight still open; replays are refused. DAVE truncates
  its GCM tag to 8 bytes, below what `aes-gcm` accepts, so the receive side
  builds GCM from `ctr` and `ghash` and checks the tag in constant time.
- **Decoding.** One decoder per SSRC, at 16 kHz mono, with loss concealment for
  gaps up to 100ms. No jitter buffer: a packet behind the stream is dropped.

Check it against a real channel, with someone talking in it:

```bash
cargo run --release -p amhra-voice --example record_users -- \
  --guild <GUILD_ID> --channel <VOICE_CHANNEL_ID> --seconds 30 --out recordings
```

with `DEV_TOKEN` in the environment. One `<user id>.wav` per speaker, plus
per-user counters of anything that failed.

## Voice commands

"Amhra, skip this song" → the song is skipped. The sidecar hears the name
and transcribes what follows into an `utterance` event; the bot reads a
command out of the text and runs it (see [In the bot](#in-the-bot)). Off
unless the bot's owner allows it and each server opts in.

```text
16 kHz PCM ─▶ keyword spotter ──"Amhra"──▶ window ─▶ end of speech ─▶ SenseVoice ─▶ utterance
per speaker   (streaming, always on)  (from the name's end) (Silero, 500ms)  (one thread)
```

Nothing anyone says is transcribed unless it follows the wake word. Only the
keyword spotter hears everything. The VAD runs only between a detection and
the end of the command, and recognition only on that window. The code is in
`amhra-sidecar/src/voice_commands/`. The gate state machine and the
per-speaker bookkeeping sit behind small traits and are tested with fakes in
the default build. Only `sherpa.rs`, the real models, needs the feature.

### Setup

The feature is off by default. It links a prebuilt sherpa-onnx static library
(about 20MB, downloaded by its build script) and needs about 260MB of models
(a 180MB download).

```bash
scripts/download-voice-models.sh
```

```bash
cargo build --release --manifest-path rust/Cargo.toml -p amhra-sidecar --features voice-commands
```

or, faster, linking sherpa-onnx's shared build, whose onnxruntime recognises
commands about 3.4 times as fast on the CPU and can use Core ML on macOS
(below). Its libraries are copied next to the binary in `target/release/`, so
keep them together:

```bash
cargo build --release --manifest-path rust/Cargo.toml -p amhra-sidecar --features shared-onnxruntime
```

Then set `VOICE_COMMANDS` in `data/setting.json` (or the dashboard) and
restart the bot: it starts the sidecar with `--voice-commands` (which implies
`--listen`), `--wake-model models/voice/kws-emhara` and `--wake-keywords
training/wake/keywords.txt`. Flags, with paths relative to where the sidecar
starts:

| flag | default | |
| --- | --- | --- |
| `--voice-models <dir>` | `models/voice` | where the download script put them (gitignored) |
| `--wake-keywords <file>` | `data/wake-keywords.txt` | the wake phrases; edit and restart, no rebuild |
| `--recogniser-threads <n>` | `2` | speech-recognition threads |
| `--recogniser-provider <p>` | `cpu` | `cpu`, or `coreml` with `shared-onnxruntime` on macOS |
| `--recogniser-language <l>` | `auto` | pin SenseVoice to one language |
| `--wake-model <dir>` | the stock spotter | a fine-tuned one from `training/wake` |
| `--wake-clips <dir>` | off | save the audio each wake was heard in (below) |
| `--wake-clips-max <n>` | `2000` | stop saving after this many clips (about 75MB) |
| `--wake-chime` | off | chime in the call when the name is heard |
| `--wake-duck <gain>` | off | lower the music to this until the command is heard |

Even started this way, the sidecar hears a guild only while the bot says it
may: `connect` carries `listen`, and `setListen` changes it mid-call. Until
then the guild's packets are read off the socket and dropped before they are
decrypted.

If a model is missing, or the build lacks the feature, the sidecar sends one
`error` event and plays on without voice commands. Loading takes about half a
second, and the process then holds about 570MB, nearly all of it SenseVoice.

The keywords file holds plain phrases. They are spelled into the spotter's word
pieces at load, using the model's own `bpe.model`, because sherpa-onnx only
reads pre-tokenised keywords. Every line is checked first: a token the model
lacks makes sherpa-onnx exit the process, and here that would end playback in
every guild. `:boost` and `#threshold` after a phrase tune it alone.

Spell how the name *sounds*. It is said "em-ha-ra", and to this model "em" is
the letter M, so the line is `M HARA`; `EMHARA` spells as `▁E M HA RA`, which
nobody says. `wake_wav --spell` prints how each line will be read.

Despite its name, that `bpe.model` is a SentencePiece *unigram* model, which
splits words differently from BPE. Spelling it as BPE produced piece sequences
the model never emits, and those keywords never fired. The spelling is now
checked against the reference keywords the model ships with, in a test that
runs whenever the models are present.

### Models

| role | model | licence |
| --- | --- | --- |
| wake word | `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` (streaming zipformer, int8) | Apache-2.0 |
| end of speech | Silero VAD (`silero_vad.onnx`) | MIT |
| speech to text | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | FunASR Model License 1.1 |

**SenseVoice attribution.** The speech recogniser is **SenseVoice-Small** by
Tongyi Lab, Alibaba Group (<https://github.com/FunAudioLLM/SenseVoice>), via
the sherpa-onnx int8 export. Its weights are under the [FunASR Model Open
Source License Agreement, version
1.1](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE), which
allows use, copying, modification and sharing, provided the source and authors
are attributed and the model names are kept. Copyright (C) 2023-2028 Alibaba
Group. The weights are downloaded, never committed.

The download script deliberately fetches the **2024-07-17** export. The newer
2025-09-09 one is a Cantonese fine-tune (WSYue) and gives up other languages
for it.

The safe `sherpa-onnx` wrapper drops SenseVoice's detected language, so the
recogniser calls the C API directly. That is the one `unsafe` block, in
`sherpa.rs`.

### Behaviour

- **Window.** It starts where the spotter says the name *ended*, not where
  it fired. The spotter fires about 300–500ms late, by which time the command
  has often begun. The window closes on 500ms of silence or at 8s. With no
  speech within 2.5s of the name, it times out quietly.
- **None of the name in the window.** It used to start 300–400ms before the
  name's end, to be sure of a command's first syllable. But whatever of the
  name SenseVoice hears throws it off the word after: live, "skip non music"
  came back as "musicic." and "skipip, no music.", and "skip this song" as
  "tip us song." and "keep us on.". Spliced after the tails of 12 live wakes,
  a synthesised "skip" was heard 16 times in 48 with 400ms of the name before
  it, 36 with 200ms, 42 with 100ms and 46 with none; said in the same breath
  as the name, 34 in 48 with 300ms and 44 with none. Loudness and how the
  name's audio ends made no difference; silence in its place fixed it.
- **Waiting for the chime.** People tend to say the name, wait for the
  chime, then go on. The VAD often hears the name's tail as speech, so before
  this the pause closed the window on the name alone ("Ahara.", "Emharra."
  live). Until something has been said after the name was heard, silence does
  not close the window; once the 2.5s wait is over, it does. The cost: a
  command said in one breath and finished before the spotter fires (about
  450ms after the name) waits out the 2.5s. `--wait-for-speech-ms`,
  `--end-silence-ms` and `--max-capture-ms` change the three timings.
- **Silence Discord does not send.** Clients stop transmitting when someone
  goes quiet, so the gate thread feeds zeros in its place, for about a second
  after someone stops and for as long as a command is open. Otherwise a command
  would never end, and a name said last would never be recognised.
- **Where the name ended.** sherpa-onnx only counts the keyword's
  timestamps from the start of the stream until its first detection; after
  the reset that follows, they come back measured from somewhere else, and
  the lag worked out from them is nonsense. A lag outside 0.1–1s is taken to
  be the typical 0.45s instead, so later wakes on a stream start their window
  in the right place too. When the spotter puts the end early, a scrap of the
  name reaches the recogniser anyway ("Ehara play expectations."); the model
  reading the command, and the fallback, allow for that.
- **Padding.** SenseVoice drops the first syllables of audio that starts
  mid-speech. Measured: a whole clip came back as "Amra, skip this song.", but
  the gate's window of it came back as "Sip this song.". Each window gets 300ms
  of silence on either side.
- **Threads.** Receive thread, then a per-guild gate thread (spotter + VAD per
  speaker), then one process-wide recogniser. The queues are bounded at 500
  frames and 4 commands, and drop when full: a backlog of voice is worthless.
  None of this runs on the 20ms send thread.
- Someone who leaves mid-command takes the command with them.

### Tuning without Discord

```bash
cargo run --release -p amhra-sidecar --features voice-commands --example wake_wav -- \
  --verbose recordings/*.wav
```

Runs the same gate over WAV files (16 kHz mono, one speaker each), printing
every wake, timeout and transcript with its position and latency.
`--threshold`, `--boost`, `--keywords`, `--preroll-ms` and
`--recogniser-threads` try settings without editing anything. `--whole`
transcribes each file ungated for comparison, and `--dump <dir>` writes each
window out. Record real voices for it with `record_users --keep-gaps`:
without that flag the file has no silences, because Discord does not send
them, and commands never end.

Live, printing as it goes:

```bash
cargo run --release -p amhra-sidecar --features voice-commands --example wake_live -- \
  --guild <GUILD_ID> --channel <VOICE_CHANNEL_ID> --seconds 300
```

with `DEV_TOKEN` set, run from the repository root.

### Measured

All on an Apple M5 Pro, release build. The corpus was synthesised with macOS
`say`: 16 English voices, 6 Japanese, 5 Korean and 5 Taiwanese Mandarin. Each
says the name followed by a command, or the name alone. There are also 25
minutes of negatives: chatter in all four languages, plus near-miss sentences
("camera", "Tamra and Amy", "Alhambra", "Omar", "Hamra street"…).

| | |
| --- | --- |
| spotter + VAD | **0.9–1.0% of one core per speaker** (about 105× real time), on continuous chatter |
| recognition | 153ms mean, 217ms max per command (2 threads); 294ms on 1, 83ms on 4 |
| end of speech → text | **median 645ms, p90 695ms, max 719ms**: 500ms of that is the silence that marks the end |
| spotter lag | 280–480ms after the keyword ends |

Detection of "em-ha-ra", with the committed `data/wake-keywords.txt` (`M
HARA #0.1`). Each voice said it before a command (6 clips) and alone (1):

| | woke | notes |
| --- | --- | --- |
| English, 7 voices that say it clearly | **39/49** | Samantha, Shelley, Rishi, Flo, Daniel 6/7 each; Eddy 5, Reed 4 |
| English, all 16 voices | 45/112 | Sandy, Rocko, Moira, Grandpa and Fred: 0/7; they say "M-ra" or "gara" |
| Japanese, Korean, Mandarin voices | 0/59 | エムハラ, 엠하라, 艾姆哈拉: no spelling found them |
| false wakes | **0 in 25 minutes** | chatter in four languages plus near-miss sentences, at every threshold down to 0.02 |

The threshold is set low because nothing false fired even at 0.02, and recall
stops climbing at 0.1. The limit is the model. It is a 3.3M-parameter English
(GigaSpeech) spotter, and it does not follow the name as the Japanese, Korean
and Mandarin voices say it. Every alternative spelling tried (`EMU HARA`,
`M HALA`, `AIM HALA`…) found none of them.

How to read these. TTS voices invent their own pronunciation of a made-up
name, so these numbers show how the pipeline behaves, not how well it hears
real people. The first fix for misses is recordings of the server's own
members, from `record_users --keep-gaps` and checked with `wake_wav`: test
spellings against how they actually say it. Every extra spelling, and every
lower threshold, buys recall with false wakes.

Transcripts of the command after the name are good in English (mean text
similarity 0.89 to the script). On the earlier corpus they were poor for
Korean from the novelty voices; Yuna's were good, Eddy's and Flo's gibberish.
Short windows are sometimes taken for the wrong language. Pinning the language
per guild would help, since SenseVoice accepts one; it is not done.

**A wake model trained on the name.** Recall above is capped by the model, so
`training/wake/` fine-tunes the same spotter on recordings of the name
(icefall's own recipe, on a CPU, in minutes) and the sidecar loads the result
with `--wake-model models/voice/kws-emhara --wake-keywords
training/wake/keywords.txt`. On one member's real Discord recording, cut into
takes with every other take held out of training:

| | held-out real takes | false wakes in 32 minutes of unseen negatives |
| --- | --- | --- |
| stock spotter, `M HARA` | 1/11 | 0 |
| fine-tuned, threshold 0.25 | **9/11** | 3 (5.6 per hour) |

Live in a Discord call, the same speaker said the name 10 times followed
by commands: it woke 9 times, with no false wakes. Text arrived 650–790ms
after they stopped talking. The commands after the name came out rough
("how, I pay this song", "Em, I pre the song", "I'm, I stop it"), so
the bot's matching tolerates that (below).

Ten training takes from one speaker is very little, and training longer
overfits: later epochs heard every take but woke 25–80 times an hour on
sentences they had not seen. Recordings from more members are what would
improve it; `training/wake/README.md` has the steps and every number.

### CPU or Core ML

Recognition time per command, over the same 15 real commands (the held-out
evaluation takes and the training takes from `training/wake`), on an M5 Pro
with `wake_wav --provider <p> --recogniser-threads <n>`:

| build | provider | threads | mean | max |
| --- | --- | --- | --- | --- |
| static (default) | cpu | 2 | 141ms | 199ms |
| static | cpu | 4 | 76ms | 105ms |
| `shared-onnxruntime` | cpu | 2 | **41ms** | 57ms |
| `shared-onnxruntime` | cpu | 4 | **26ms** | 35ms |
| `shared-onnxruntime` | coreml | 2 | 52ms | 68ms |

The shared build's onnxruntime is what makes the difference; Core ML does
not. On the int8 model most operations are ones Core ML does not run, so it
hands them back to the CPU, and it takes 2s to load against 0.5s. The model
alone, through onnxruntime 1.31 in Python, told the same story (54ms on two
CPU threads against 64ms on Core ML for a 3s window). The static library's
onnxruntime has no Core ML in it at all: asking for it there is reported and
recognition stays on the CPU. Only recognition can move; the spotter and the
VAD take 20ms at a time from every speaker, which is the worst case for
handing work to another device.

Either way, 500ms of the wait after someone stops talking is the silence
that tells the gate they have finished.

**Pinning the language.** On `auto`, four of seven live takes of the name
said in English came back as Chinese ("什么号啊？"); pinned to `en` they read
"I Har." The pin is the recogniser's: sherpa-onnx takes a per-stream
`language` option, and SenseVoice ignores it (checked on the same takes), so
a language per server would mean loading a recogniser per language, about
250MB each.

### Speaking

With `VOICE_SPEECH` on, the bot says what a voice command does as it starts
it ("Skipping.", "Volume 40 percent."), after the chime, over the music
lowered to `VOICE_DUCK_VOLUME`. A command refused afterwards (nothing
playing, another channel) says why in the chat. Play is said once its search
has found something, with the video's title as found rather than as heard
("Playing Billie Eilish - bad guy.", "Added … to the queue."), leaving out
what is in brackets ("(Official Music Video)"); a search that finds nothing
says nothing. The phrases are the `VOICE_SAY_*` strings in `data/lang`,
chosen in `lib/voice/announce.ts`. Each member can turn it off for their own
commands with `/voicefeedback enabled:false`.

A command is answered in its own language, each with its own model through
sherpa-onnx (`src/speech.rs`), all fetched by
`scripts/download-voice-models.sh --speech` into models/voice:

| language | model | voice |
| --- | --- | --- |
| English, Japanese, Korean | Supertonic 3, int8 (145MB) | the first of its ten, female |
| Mandarin | Kokoro v1.0, fp32 (330MB) | zf_xiaoxiao |
| Cantonese | `vits-cantonese-hf-xiaomaiiwn` (114MB) | its one voice |

The sidecar uses whichever are there: without Supertonic, English falls to
Kokoro (af_heart) and Japanese and Korean are not said; without the
Cantonese voice, Cantonese is read by the Mandarin one. Chinese answers are
the bot's traditional-character strings, which Kokoro reads as they are and
the Cantonese voice is given in simplified characters (its lexicon has no
others). Each model trims the silence around what it says: Supertonic pads
every phrase with nearly half a second either side.

Kokoro, on an M5 Pro, makes a second of speech in 0.8 to 0.95s on one CPU
thread (0.7 for a long sentence), and takes 727MB loaded. Core ML saves
nothing: the fp32 model ran on the same CPU, and the int8 one aborts on Core
ML and produces only NaN on the CPU. A Raspberry Pi class board, which this
is meant to run on, has several times less per core, so a new phrase takes
seconds there. So:

- **Fixed phrases are made once.** The bot sends every phrase that does not
  change (`prepareSpeech`) when the sidecar starts. Any not yet saved is
  synthesised in the background and saved under `<cache-dir>/speech`; from
  then on it is read back, and saying it costs no model time at all.
- **The rest when it is said.** A title or a number is synthesised when
  the command comes, on the one speech thread, ahead of any preparing, and
  remembered (64 phrases) but not saved, so the store never grows past the
  fixed phrases. One that is not ready within 8s is not said.
- **Each model only while it is needed.** It is loaded for the first phrase
  in its languages that is not saved and let go after a minute without
  another, so Kokoro's 700MB is not held while nothing new is said in
  Mandarin.
- **One thread** by default (`VOICE_SPEECH_THREADS`), so speech never takes
  more than a core from playback and recognition.

`examples/tts_wav.rs` speaks sentences to a WAV and times them, with no
Discord involved.

**Other languages.** Kokoro, as sherpa-onnx runs it, has no Japanese or
Korean: its Japanese voice reads kana as "Japanese letter" over and over.
`examples/tts_check.rs` speaks 13 of the bot's answers per language (10 fixed,
3 with a song's title) and hears them back through SenseVoice, which
understands all five, so a model can be judged in a language nobody here
listens to. One synthesis thread, M5 Pro; error is SenseVoice's character
error against the text, after punctuation, with Chinese compared in
simplified characters:

| model | language | per phrase | real time | error, fixed phrases | error, titles |
| --- | --- | --- | --- | --- | --- |
| Kokoro v1.0 (fp32, 330MB) | en | 859ms | 0.77 | 7.3% | 12% |
| Kokoro v1.0 | zh | 1166ms | 0.83 | 2.8% | 12% |
| Kokoro v1.0 | ja | — | — | unusable | unusable |
| Supertonic 3 (int8, 145MB) | en | 441ms | 0.26 | 2.4% | 15% |
| Supertonic 3 | ja | 460ms | 0.23 | 4.3% | 42% |
| Supertonic 3 | ko | 451ms | 0.23 | 3.6% | 36% |
| `vits-cantonese-hf-xiaomaiiwn` (114MB) | yue | 614ms | 0.54 | 11% | 15% |

Supertonic 3 is three times Kokoro's speed and as clear, but has no Chinese,
which is how the models above were chosen.
Its titles suffer from names in Latin letters read in Japanese or Korean
("BTS" came back 비스, "Lemon" レメヌ), which SenseVoice also struggles to
spell back. It speaks more slowly than Kokoro, 24s against 16s for the same
English. The Cantonese voice must be given simplified characters: its
lexicon lacks 這 and 過, and skips what it lacks; given simplified, SenseVoice
heard 12 of 13 as Cantonese. On a Pi 4, sherpa-onnx measures Kokoro at 7.6
times slower than real time on one thread, about ten times this Mac; at the
same ratio Supertonic would be about 2.4 and the Cantonese voice about 5.

### In the bot

Settings, in `data/setting.json` or the dashboard, read when the sidecar
starts:

| setting | default | |
| --- | --- | --- |
| `VOICE_COMMANDS` | off | let servers turn voice commands on; needs `USE_RUST_VOICE` |
| `VOICE_WAKE_MODEL` | `models/voice/kws-emhara` | |
| `VOICE_WAKE_KEYWORDS` | `training/wake/keywords.txt` | |
| `VOICE_COLLECT_WAKE_CLIPS` | **on** | save wake clips from servers that turned voice commands on |
| `VOICE_LOG_TRANSCRIPTS` | off | log what was heard after the name, for tuning the matching |
| `VOICE_WAKE_CHIME` | **on** | a chime in the call when the name is heard |
| `VOICE_DUCK_VOLUME` | `0.3` | the music's volume from the name until the command is heard; 1 leaves it |
| `VOICE_RECOGNISER_PROVIDER` | `cpu` | `cpu` or `coreml` |
| `VOICE_RECOGNISER_THREADS` | `2` | threads for speech recognition |
| `VOICE_LANGUAGE` | `auto` | pin recognition to `en`, `zh`, `ja`, `ko` or `yue`, for every server |
| `VOICE_WAIT_FOR_COMMAND_MS` | `2500` | how long after the name to wait for the command; a pause for the chime does not end it within this |
| `VOICE_END_SILENCE_MS` | `500` | silence that ends a command; all of it is added to the wait for an answer |
| `VOICE_MAX_COMMAND_MS` | `8000` | the longest command |
| `VOICE_INTENT_MODEL_URL` | empty | an OpenAI-compatible server whose model reads every command; empty, only command names said first are understood |
| `VOICE_INTENT_MODEL` | `mlx-community/Qwen3-4B-4bit` | the model that server uses |
| `VOICE_SPEECH` | off | say aloud what a voice command does, with the models in models/voice (see Speaking) |
| `VOICE_SPEECH_THREADS` | `1` | CPU threads for making speech |

- **Per-server opt-in.** `/voicecommands enabled:true`, by default for members
  with Manage Server, kept in `data/guildSetting.json` (gitignored). It takes
  effect in a call already under way, through `setListen`.
- **Telling people.** When the bot joins a call in a server that opted in,
  and when the server turns it on, the voice channel's chat says the bot
  listens for its name, what happens to what it hears, and how to turn it
  off. Members who join later are told too, at most every five minutes. With
  wake clips on, the notice says they are kept.
- **Reading the command** (`lib/voice/intentModel.ts`). With
  `VOICE_INTENT_MODEL_URL` set, every transcript goes to a language model on
  the same machine, which answers with any of the bot's music commands —
  play, pause, resume, skip, skipnonmusic, autoskipnonmusic, stop,
  disconnect, join, loop, queue, nowplaying, remove, volume, lyrics,
  relocate — with its options, or none. It is told each command's options
  from the slash command itself, and what it gives back is held to them:
  an option of the wrong type or out of range is left out, a command missing
  a required one is not run. To run one on a Mac:

  ```bash
  uv run --with mlx-lm mlx_lm.server --model mlx-community/Qwen3-4B-4bit --port 8085
  ```

  and set the URL to `http://127.0.0.1:8085/v1`. LM Studio and Ollama serve
  the same API. Qwen3 4B takes about 2.4GB and answers in about 175ms
  through the server, 1s for the first command.

  Asked for the other commands, it read 15 of 16 right ("set the volume to
  70", "loop this song", "remove song number two", "jump to two minutes",
  "play bad guy next") and took "I love the lyrics of this one" for lyrics.
  With all of them to choose from it also reaches for them on chatter:
  "display the queue", "what song is this" and "Mhar, that volume is 50%."
  ran queue, nowplaying and volume.

  It understands requests said any way: of 9 new phrasings ("turn it off",
  "get out of the call", "I want to hear bad guy by Billie Eilish", "A play
  expectations by Olro Drigo."), it read all but 2, and left 3 bits of
  chatter alone. What the recogniser garbles it gets wrong more often: on 82
  labelled live transcripts and near misses it got 58 right, where per-language
  word lists of names, fillers and mishearings (since removed) got 73. It took
  "live this song" and 下一首歌是什么 ("what is the next song") for commands,
  and read "play the song" as a search for a song called that. Qwen3 1.7B got
  47, and a 27B model 69 at 343ms and 15GB.
- **When there is no model** (`lib/voice/intent.ts`): no URL set, or no
  answer within 3s. A command's own slash command name, in any of the bot's
  languages ("skip", "スキップ", "일시정지", "暫停"), said first, after at most
  two words of whatever became of the bot's name. For play the rest is the
  song, and nothing means carry on. It knows play, pause, resume, skip,
  skipnonmusic, stop and disconnect, nothing misheard, and no simplified
  Chinese: the names are traditional, and the recogniser mostly writes
  simplified.
- **Answering the name.** The moment the spotter hears it, the guild's audio
  thread mixes in a half-second chime (two rising sine notes, synthesised in
  `wake_feedback.rs`), over the music or alone if nothing is playing, and
  lowers the music until the command has been transcribed or the wake comes
  to nothing. Wakes are counted, so a second speaker keeps it down, and ten
  seconds is the most one wake can hold it there.
- **Seeing what was heard.** `/transcript enabled:true` is each member's own
  choice, kept in `data/userSetting.json` (gitignored). The sidecar reports
  `woke` and `nothingHeard` as well as `utterance`; for those members the bot
  posts "listening…" on the wake and edits in their words and the command's
  answer when the text arrives. SenseVoice only transcribes a finished
  window, so there are no partial words to show while they speak.
- **Running it.** A command runs the same slash-command handler as a typed
  one, with an interaction that answers in the channel the player uses, or the
  voice channel's chat, headed with who asked for what
  (`lib/voice/voiceInteraction.ts`). So a voice command can do nothing a typed
  one could not; the skip vote still applies.

**Wake clips.** With `--wake-clips`, each wake saves a second of audio from
before where the name ended plus what had been heard by the time it fired
(about 1.3–1.5s), as 16 kHz WAV, and a line in `clips.tsv` labelling it
`EMHARA`. The bot saves them to `data/recordings/wake-clips` (gitignored).
False wakes land there too, so listen before training on them:
`training/wake/README.md` has the steps.

**Not measured:**

- Real voices, real microphones and the Opus round-trip. Every number above is
  from clean synthetic audio.
- Music bleeding into someone's microphone.
- Many simultaneous speakers through the live threads; the per-speaker cost
  above is single-threaded.
- The Linux link, which no machine here could do. The Linux build script and
  its archive were checked, and CI's voice-commands job links and tests it.
