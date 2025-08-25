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

Set `TOKEN` to your custom token and `PORT` to desired port
> If you want to run tweak it and run it on your testing bot, you may also set `TESTING_TOKEN` and `TEST_CLIENT_ID`

Set `CLIENT_ID` to your bot application ID for command registration, then run `node tools/register.js` or `bun tools/register.js` to register commands

Reference `data/settingSchema.json` for more options

If you want to limit API usage, you may enable rate limit for the `ENABLE_RATE_LIMIT` option

You may replace `AUTH_TOKEN` with `tool/hash.js`

> The default token for `AUTH_TOKEN` is `amhraBotDashboard`

### Misc
This project is built with [Amhra Dashboard](https://github.com/irisariuan/amhraDashboard), make sure you check out the dashboard there!

The API is **NOT** built for security, **DO NOT** expose it to public, use a reverse proxy or firewall to restrict access

Amhra Dashboard has a built-in proxy for the API, please refer to the dashboard documentation for more information

If you find any bugs or want to contribute, please open an issue!

## Start
### Node
`node dist/main.js`
### Bun
`bun dist/main.js`

---
# Enjoy your bot!
