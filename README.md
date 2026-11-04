# Amhra

**Amhra**, a bot designed for smooth music playing experience in Discord

## Installation and building the project
### Bun
```
bun install
bunx tsc
```
### NPM
```
npm install
npx tsc
```

## Setting Up

### Setup with CLI

#### Node
`node dist/tools/setting.js`

#### Bun
`bun tools/setting.ts`

Follow instructions and finish setup

---

### Manual Setup (Not recommended)

Put `TOKEN` in `.env` (see `.env.example`) and set `PORT` in `data/setting.json`
> If you want to tweak it and run it on your testing bot, you may also set `TESTING_TOKEN` in `.env` and `TEST_CLIENT_ID` in `data/setting.json`

> Credentials live in `.env` only. `data/setting.json` is served to the dashboard, so nothing bearer-shaped belongs in it.

Set `CLIENT_ID` to your bot application ID for command registration, then run `node tools/register.js` or `bun tools/register.js` to register commands

Reference `data/settingSchema.json` for more options

If you want to limit API usage, you may enable rate limit for the `ENABLE_RATE_LIMIT` option

### Whisper large-v3-turbo for voice commands

Build the sidecar with voice commands enabled, then download the optional int8
Whisper model (about 1GB):

```sh
cargo build --release --manifest-path rust/Cargo.toml --features voice-commands
scripts/download-voice-models.sh --whisper-v3-turbo
```

Set `VOICE_RECOGNISER` to `"whisper-v3-turbo"` in `data/setting.json` and restart
the bot. Voice commands require `USE_RUST_VOICE` and `VOICE_COMMANDS` to be enabled.
`VOICE_LANGUAGE` supports `auto`, `en`, `zh`, `ja`, `ko`, or `yue`;
Whisper transcribes in the source language. The existing recogniser thread and
provider settings also apply. Qwen3 remains the default.

Each Whisper transcription takes about 1.5s on 4 threads of an M5 Pro however short
the command, since it needs a stretch of silence after the audio not to repeat
itself. On synthesised speech it also heard Cantonese as Mandarin, which Qwen3 and
SenseVoice told apart.

For the sidecar directly, use `--recogniser whisper-v3-turbo`. The download flag
can be combined with `--speech` to include the models for spoken answers.

### How a voice command is read

1. **Plain phrases run at once**, with no model: `play <song>`, `skip`, `次の曲`,
   `<song>を再生して`, `볼륨 40`, `播放<song>`. They are all data, under
   `voicePatterns` in `data/lang/*.json`, so a phrase or a language is added there:
   `{option}` stands for that option of the command, wherever the language puts it.
   What was said has to fit a phrase whole; anything else goes to the model.
2. **The model reads the rest.** With Qwen3-ASR it may answer
   `{"command": "retranscribe", "language": "en"}` when the recogniser guessed the
   wrong language. The window is kept in memory until the bot has read it, 30s at
   most, and heard again with the same model, so this takes no extra memory.
3. **`/voicelanguage`** lets each member choose separately the language they speak
   (`input`) and the one they are answered in (`output`), with Mandarin and Cantonese
   separate in both. Only Qwen3-ASR can be told `input` per member; SenseVoice and
   Whisper fix their language at load and keep guessing. `output` works with any of
   them, and left automatic follows the language heard.
4. **`/transcript`** also shows the words as they are said, re-recognised about once
   a second, only for members who turned it on and only when the recogniser is idle.

### Misc
This project is built with [Amhra Dashboard](https://github.com/irisariuan/amhraDashboard), make sure you check out the dashboard there!

The API is **NOT** built for security, **DO NOT** expose it to public, use a reverse proxy or firewall to restrict access

Amhra Dashboard has a built-in proxy for the API, please refer to the dashboard documentation for more information

If you find any bugs or want to contribute, please open an issue!

## Start
### Node
Node 22.22.2 or later in 22, 24.15.0 or later in 24, or 26 and up: what `@distube/ytdl-core` 5 needs. The build is CommonJS and loads it, an ES module, through Node's `require`.

`node dist/main.js`
### Bun
`bun dist/main.js`

---
# Enjoy your bot!
