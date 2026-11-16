# Runbook: rotate keys, tokens and PINs

PRD §18: every secret is a Wrangler secret, owned by the clinic's accounts. Rotate a secret when it may have leaked, when someone who knew it leaves, and once a year anyway.

General rules:

- Run `wrangler secret put` from `apps/api`, in a **real terminal**. Where it cannot ask for the value (Claude Code's `!` prompt, CI), it stores an empty secret (see `team-bot.md` §2).
- Use `--env staging` or `--env production`. Each environment has its own values.
- Never paste a secret into chat, an issue, a commit or a log. To make a random value: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. It prints the value: clear the terminal after pasting it, and don't do this in a recorded or shared session.
- After changing any secret, check the matching "Check" step of its runbook.

| Secret                                                                    | What breaks if it leaks                                                                                                | How to rotate                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SETUP_CODE`                                                              | Anyone could create the first Doctor while no Doctor exists                                                            | It is only needed once: after setup, **delete** it with `npx wrangler secret delete SETUP_CODE --env <env>` (ADR 0005). To set up again, put a new one (≥ 32 characters)                                                                    |
| `TEAM_BOT_TOKEN`                                                          | Someone can send messages as the team bot                                                                              | BotFather → `/mybots` → the bot → _API Token_ → _Revoke_. Then store the new token and tap **Connect the bot** in Settings (`team-bot.md`, "Rotate a leaked secret")                                                                        |
| `TEAM_BOT_WEBHOOK_SECRET`                                                 | Someone can fake updates to the team bot                                                                               | Store a new random value, then tap **Connect the bot** in Settings                                                                                                                                                                          |
| `PATIENT_BOT_TOKEN`, `PATIENT_BOT_WEBHOOK_SECRET`                         | The same, for the patient bot                                                                                          | `patient-bot.md`, "Rotating"                                                                                                                                                                                                                |
| `BACKUP_KEY`                                                              | Every backup made with it can be decrypted                                                                             | Make and print a new key, then store it (`backups.md` §1). **Keep the old key** for the backups already made with it: 30 days for nightly backups, 12 months for the 1st-of-month ones (ADR 0012). Old backups do not re-encrypt themselves |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                | Someone can request access to the clinic's Drive as the app                                                            | Google Cloud console → Credentials → reset the secret (or a new client). Store both, then run `pnpm google-auth --env <env>` again (`backups.md` §2–3)                                                                                      |
| `GOOGLE_REFRESH_TOKEN`                                                    | Someone can read and delete the app's backup files on Drive                                                            | Clinic Google account → Security → Third-party connections → remove "Yegna Backup". Then `pnpm google-auth --env <env>`                                                                                                                     |
| `MISTRAL_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY` | Someone can use the clinic's free reading allowance                                                                    | Revoke the key in that provider's console, create a new one, and store it (ADR 0009). Imports keep working with the other readers meanwhile                                                                                                 |
| `CF_ACCOUNT_ID`, `CF_ANALYTICS_TOKEN`                                     | Someone can read the account's analytics (all of it, read-only; no write access). No patient data is in them (PRD §18) | `usage-alert.md`, "Rotating"                                                                                                                                                                                                                |
| Wrangler login / Cloudflare API tokens used for deploys                   | Someone can change the Workers and databases                                                                           | Cloudflare dashboard → My Profile → API Tokens → roll or delete. CI tokens are GitHub repository secrets: update them there                                                                                                                 |

## Phones and PINs (no secret to store)

- **A lost or stolen phone:** the Doctor opens **Settings → Phones** and taps **Sign out this phone** on it. The next time it is online, it wipes its copy of the schedule (PRD §7.9). Device tokens are stored only as hashes, so nothing needs rotating.
- **Someone left the clinic:** the Doctor taps **Disable** on their account in **Settings → Staff accounts**. That signs out all their phones and unlinks their Telegram.
- **A Staff PIN may be known:** the Doctor taps **New PIN** for that person in **Settings → Staff accounts**.
- **The Doctor's own PIN may be known:** the app has no screen for this yet. The API accepts it (`PATCH /admin/users/<doctor id>` with a new 6-digit `pin`, from a signed-in Doctor phone), but until a screen exists, ask the technical person. If the Doctor is locked out, see `unlock-enrolment.md`.

## After a leak

1. Rotate the secret, as above.
2. Check `audit_log` for changes you do not recognise, made by a device or bot during that time.
3. Write down what happened and when, at the bottom of this page.

## Rotation log

| Date | Secret | Environment | Why | By  |
| ---- | ------ | ----------- | --- | --- |
