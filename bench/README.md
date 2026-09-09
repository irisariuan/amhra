# Benchmarks

Compares the Rust audio path against the pipeline it replaces, on the same
inputs, in one command:

```bash
bun run bench            # audio path only, no network
bun run bench -- --fetch # also compare the downloaders
bun run bench -- --file cache/<id>.music
```

Numbers are not portable across machines and are not meant to be: what is being
compared is two implementations, not two computers. Run it yourself before
believing any of them.

## Method

- **Median, not mean.** One descheduled run should not move the answer. p95 is
  measured alongside, because a tail far from the median is itself a finding —
  an audio path is only as good as its worst tick.
- **One untimed warm-up pass.** Timing the first run of a JIT-compiled function
  measures the compiler.
- **Results are observed.** The Rust benches pass counts through
  `std::hint::black_box`, because the optimiser is otherwise free to delete work
  whose only effect is a local nothing reads. An earlier version of this suite
  reported chunked demuxing as four times faster than whole-file demuxing, which
  is exactly what that bug looks like.
- **Per-frame costs are reported per frame**, with the share of a 20ms tick one
  stream consumes. That share is what decides how many streams fit on a core.

## What is not measured

- **The voice handshake.** Connecting needs a real guild and a real channel, so
  it is exercised by `amhra-voice`'s `play_file` example rather than timed here.
- **DAVE framing on the TypeScript side.** `@snazzah/davey` is itself Rust, so
  there is nothing to compare against.
- **Seeking on the TypeScript side.** The current player has no seek index; it
  re-reads and re-demuxes. That absence is the difference the index exists to
  remove, so it is reported as "no equivalent" rather than as a ratio.

## Findings this suite produced

**Hardware AES was off.** The `aes` crate uses ARMv8 intrinsics only behind an
opt-in cfg; without it the build got a software implementation, and transport
encryption was measured at 2.9µs per frame against node's 0.8µs — the Rust path
losing, four times over, on work paid fifty times a second per guild. With
`--cfg aes_armv8` (now set in `.cargo/config.toml`) it is 0.83µs, and DAVE frame
encryption went from 2.2µs to 0.47µs. On x86_64 the crate detects AES-NI at
runtime and needs nothing.

**Demuxing a whole file was memory-latency bound, not parse bound.** Feeding
the demuxer one 60MiB buffer took 11ms while feeding the same bytes in 256KiB
chunks took 2.4ms — the chunked path does strictly more work, since it copies
every byte into its staging buffer first. The parser reads a few header bytes
and then jumps over a ~370 byte Opus packet, which no hardware prefetcher
recognises as a stream, so every block header was a fresh DRAM access; the
chunked path was accidentally fast because it walked a small, hot copy.
Requesting the next 4KiB by hand (`prfm`/`_mm_prefetch`, only when the buffer is
too big to be cached) took whole-file demuxing to 3.5ms. Playback and the
`.idx` builder both feed whole mappings, so this is the path that mattered.

**Opening a track was mostly page faults.** 12.5ms, of which the parse is 3.5ms:
the rest was one minor fault per page, taken from inside the parse loop, plus
the frame table reallocating its way up to 166k entries. One `madvise(WILLNEED)`
and a reserve sized from the average frame seen so far: 4.1ms.

**Re-encoding was paying for analysis the source no longer had.** The volume
path is 28µs of decode and 81µs of encode at libopus' default complexity. The
curve bends at 6 — 10, 9 and 8 are within a few microseconds of each other, 6 is
50µs — and what is being encoded is an already-lossy 128kbps stream that has
been decoded and scaled. `volume_scaled` went from ~131µs to ~106µs.

**The volume path is where the CPU went.** Both stacks decode and re-encode at
roughly the same speed, because both are libopus — 165µs against 179µs per
frame. The difference is that the old pipeline pays it on every stream whether
or not anyone changed the volume, and the new one skips the codec entirely at
volume 100. That is the 0.003µs column: not a faster codec, an absent one.
