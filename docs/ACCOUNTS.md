# Amhra Account System

Two account types share one `Account` table, distinguished by `type`:

| Type        | Created by                        | Auth credential                        | Scope                    |
| ----------- | --------------------------------- | -------------------------------------- | ------------------------ |
| `anonymous` | Discord `/dashboard` command      | one-time token in the dashboard link   | its `guildScope`, 6h TTL |
| `web`       | dashboard passkey registration    | WebAuthn passkey → server session      | Discord-linked guilds; all guilds if admin |

Permissions are a bitfield on the account: `User = 1`, `Admin = 2`, `HasSettings = 4`.
The old shared admin password is gone — admin is now a per-account flag, granted with
`bun tools/grantAdmin.ts <accountId>`.

## Security properties

- **Passkeys (WebAuthn):** public-key credentials only; no passwords stored. Uses
  `@simplewebauthn/server`. Registration/authentication challenges are single-use, stored
  server-side, and expire in 5 minutes.
- **Sessions:** the raw session token is returned once and never stored — only its SHA-256
  hash is persisted, so a DB leak cannot be replayed. 30-day sliding expiry. The token lives
  in an httpOnly, SameSite cookie set by the dashboard; the browser never sees it in JS and
  only ever talks to the dashboard origin (the dashboard proxies to the bot).
- **Anonymous tokens** are likewise stored only as SHA-256 hashes with a hard expiry, and are
  scoped to the guild(s) they were minted for.
- Expired sessions, challenges, and anonymous accounts are garbage-collected every 30 minutes.

## Authorization header schemes (dashboard proxy → bot)

- `Session <token>` — web account session
- `Anon <token>` — anonymous account

## Endpoints (bot server)

### Auth
| Endpoint | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/api/auth/passkey/register/begin` | POST | — | Start passkey registration → `{ challengeId, options }` |
| `/api/auth/passkey/register/finish` | POST | — | Finish registration → `{ token }` (session) |
| `/api/auth/passkey/login/begin` | POST | — | Start passkey login → `{ challengeId, options }` |
| `/api/auth/passkey/login/finish` | POST | — | Finish login → `{ token }` (session) |
| `/api/auth/passkey/add/begin` | POST | Session | Add another passkey to the current account |
| `/api/auth/passkey/add/finish` | POST | Session | Finish adding a passkey |
| `/api/auth/session` | GET | Session/Anon | Current account (`me`) |
| `/api/auth/logout` | POST | Session | Revoke the current session |
| `/api/auth/discord/callback` | POST | optional Session | Log in via Discord, or link Discord to the current account → `{ token, account }` |
| `/api/auth/discord/unlink` | POST | Session | Unlink Discord from the current account |

### Player & data (auth via Session or Anon)
`/api/song/get/:guildId`, `/api/song/edit`, `/api/live`, `/api/search`, `/api/getVideoDetail`,
`/api/getPlaylistDetail`, `/api/suggestions/:guildId`, `/api/playingGuildIds`, `/api/setting` (GET/POST).

`/api/getPlaylistDetail` takes `{ url }` (a YouTube playlist link, including a
`watch?v=…&list=…` one) and returns `{ url, title, videos[] }` so the dashboard can
show a playlist before queueing it. To queue it, POST `/api/song/edit` with
`{ action: "addPlaylist", guildId, detail: { url, next?, force? } }` — every video is
added, and playback starts if the guild was idle.
Admin-only (`Session`, admin bit): `/api/log`, `/api/action`, `/api/admin/settings` (GET/POST), `/api/guildIds/all`.

`/api/admin/settings` exposes and updates the non-secret global `data/setting.json` configuration. Bot, OAuth, and API tokens remain server-only and are preserved when other settings are updated.

Guild access is enforced by `accountCanAccessGuild`: admins → any guild; anonymous → their
scope; Discord-linked web accounts → guilds they are a member of.

## Environment

- `WEBAUTHN_RP_ID` — registrable domain of the dashboard (no scheme/port). Falls back to
  `WEBSITE` from `setting.json`, else `localhost`.
- `WEBAUTHN_ORIGIN` — full dashboard origin the browser reports (e.g. `https://amhra.xyz`).
  Falls back to the site in `setting.json`, else `http://localhost:3000`.

## Auto song suggestions (radio)

`AccountSetting.autoSuggest` and the per-player `autoSuggest` flag enable radio mode: when a
player's queue empties, a suggested track is auto-appended (source: YouTube search,
excluding recent history). The dashboard also lists clickable suggestions from
`/api/suggestions/:guildId`. Toggle radio from the dashboard (`autoSuggest` song action).
