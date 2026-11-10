# Runbook: set up (or rotate) the Yegna Team bot

The team bot (PRD §13) needs three values per environment. Use a **separate test bot for staging**
(decided 2026-11-10); the clinic's real bot is created at launch.

| Value                     | Where                                         | Secret? |
| ------------------------- | --------------------------------------------- | ------- |
| `TEAM_BOT_TOKEN`          | `wrangler secret put`                         | yes     |
| `TEAM_BOT_WEBHOOK_SECRET` | `wrangler secret put`                         | yes     |
| `TEAM_BOT_USERNAME`       | `vars` in `apps/api/wrangler.jsonc` (per env) | no      |

Never paste a token into chat, an issue, a commit or a log.

## 1. Create the bot (Telegram, phone app)

1. Open **@BotFather**, send `/newbot`.
2. Name: `Yegna Team (test)` for staging (`Yegna Team` for production).
3. Username: must end in `bot`, e.g. `YegnaTeamTestBot`. Note it.
4. BotFather replies with the token. Keep it for step 2 only.
5. `/setjoingroups` → **Disable** (the bot serves private chats only; it ignores groups anyway).

## 2. Store the secrets (from the repo root)

```
cd apps/api
npx wrangler secret put TEAM_BOT_TOKEN --env staging          # paste the token from BotFather
npx wrangler secret put TEAM_BOT_WEBHOOK_SECRET --env staging # paste a new random value, ≥ 32 characters
```

A random value: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.

## 3. Set the username

Add `"TEAM_BOT_USERNAME": "<username without @>"` to the environment's `vars` in
`apps/api/wrangler.jsonc`, commit, and let CI deploy.

## 4. Connect

In the PWA, as the Doctor: **Settings → Telegram → Connect the bot to the server**. This points the
bot's webhook at the API with the webhook secret and sets the `/today` and `/tomorrow` commands.

## 5. Link the team

Each team member: **Settings → Telegram → Link Telegram** → Telegram opens → **Start**. The link
code works once, for 10 minutes.

## Transfer to the clinic's account

BotFather → `/mybots` → the bot → _Bot Settings_ → _Transfer Ownership_ (phone app only; the
current owner needs two-step verification on for 7 days, and the new owner must have messaged the
bot once). Then rotate the token: BotFather → _API Token_ → _Revoke_, and repeat step 2 for
`TEAM_BOT_TOKEN` and step 4.

## Rotate a leaked secret

- Token: revoke in BotFather, then steps 2 and 4.
- Webhook secret: step 2 with a new value, then step 4.
