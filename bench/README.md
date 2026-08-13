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

**The volume path is where the CPU went.** Both stacks decode and re-encode at
roughly the same speed, because both are libopus — 165µs against 179µs per
frame. The difference is that the old pipeline pays it on every stream whether
or not anyone changed the volume, and the new one skips the codec entirely at
volume 100. That is the 0.003µs column: not a faster codec, an absent one.
