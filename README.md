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
provider settings also apply. Qwen3-ASR 0.6B (`"qwen3-0.6B"`) remains the default;
`"qwen3-1.7B"` is the larger one, fetched with
`scripts/download-voice-models.sh --qwen3-1.7B` (2.4GB, and about that much memory).

`"gemma-4-E2B"` and `"gemma-4-E4B"` hear commands with Gemma 4, a language model
that takes audio, instead. The bot starts llama.cpp's `llama-server` for it
(install llama.cpp first), which fetches the model itself: about 3.5GB for E2B and
5.5GB for E4B, and about that much memory. Set `VOICE_INTENT_MODEL_URL` to
`http://127.0.0.1:8085/v1` as well and the same model also reads the command. See
[rust/README.md](rust/README.md#gemma-4).

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
3. **`/voicelanguage`** opens a panel only the member can see, where they put the
   languages they speak in order, likeliest first (such as English > Cantonese >
   Mandarin), and choose the one they are answered in, with Mandarin and Cantonese
   separate in both. Each click is saved as it is made.
   The recogniser still guesses, as told one language it can translate what is said
   in another. The model is given the order to decide what to hear them in again, and
   a command in a language they did not list goes to it rather than running at once.
   Listing just one language tells the recogniser that language, which only Qwen3-ASR
   can be told per member. The answer language works with any recogniser, and left
   automatic follows the language heard.
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
