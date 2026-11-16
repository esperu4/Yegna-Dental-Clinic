# Runbook: set up (or rotate) the Yegna Dental patient bot

The patient bot (PRD §14, ADR 0011) needs three values per environment. Use a **separate test bot for staging**, like the team bot; the clinic's real bot is created at launch from the doctor's Telegram.

| Value                        | Where                                         | Secret? |
| ---------------------------- | --------------------------------------------- | ------- |
| `PATIENT_BOT_TOKEN`          | `wrangler secret put`                         | yes     |
| `PATIENT_BOT_WEBHOOK_SECRET` | `wrangler secret put`                         | yes     |
| `PATIENT_BOT_USERNAME`       | `vars` in `apps/api/wrangler.jsonc` (per env) | no      |

Never paste a token into chat, an issue, a commit or a log.

## 1. Create the bot (Telegram, phone app)

1. Open **@BotFather** and send `/newbot`.
2. Name: `Yegna Dental (test)` for staging, `Yegna Dental` for production.
3. Username: it must end in `bot` (e.g. `YegnaDentalTestBot`). Note it.
4. `/setjoingroups` → **Disable**.
5. Optional: `/setdescription` and `/setuserpic` with the clinic's wording and logo.

## 2. Store the secrets (from the repo root, in a real terminal)

```
cd apps/api
npx wrangler secret put PATIENT_BOT_TOKEN --env staging
openssl rand -hex 32 | npx wrangler secret put PATIENT_BOT_WEBHOOK_SECRET --env staging
```

As with the team bot, `wrangler secret put` run where it cannot prompt stores an **empty** secret. Use a real terminal, or pipe the value in.

## 3. Set the username and deploy

Add `"PATIENT_BOT_USERNAME": "<username without @>"` to the environment's `vars`, then deploy (push to `main` for staging).

## 4. Connect

The Doctor opens **Settings → Patient bot (Yegna Dental)** and taps **Connect the patient bot to the server**. This sets the webhook (with the secret) and the `/start` command. Repeat it after rotating the secret.

## 5. Check

1. Open the bot and send `/start`. Choose a language; the menu appears.
2. Book yourself as a patient in the app with your own phone number, as Staff. Nothing should arrive yet: it is waiting for approval.
3. Tap **📅 My appointment** and share your contact. It says you are connected, with no confirmed appointment.
4. Approve the booking as the Doctor. The ✅ confirmation should arrive within a minute (or by the next hour at the latest).
5. Cancel it as the Doctor. The ❌ notice should arrive.

## Rotating

Store a new `PATIENT_BOT_WEBHOOK_SECRET`, deploy, then tap **Connect** again. To change the token (BotFather `/revoke`), store the new one and tap **Connect**.
