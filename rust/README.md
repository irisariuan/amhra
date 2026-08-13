# amhra Rust workspace

The audio path, moving to Rust in phases. Each phase is independently useful and
independently revertable; the TypeScript bot keeps working throughout.

| crate | what it owns | phase |
| --- | --- | --- |
| `amhra-audio` | WebM/Opus demuxing, Opus TOC parsing, the `.idx` seek index | 1 ✅ |
| `amhra-fetch` | InnerTube extraction, ranged download, yt-dlp fallback | 1 ✅ |
| `amhra-voice` | voice gateway v8, UDP/RTP/AEAD ✅ · DAVE framing ⏳ | 2 |
| `amhra-sidecar` | the long-lived process: RPC, per-guild playback | 4 |

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
