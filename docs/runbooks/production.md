# Runbook: launch production

ADR 0013. Do these steps in order, once, after the test day is clean. Use a real terminal from `apps/api` for every `wrangler secret put` (see the team bot runbook for why). The production D1 database `yegna-production` already exists.

## 1. GitHub

1. Repository → Settings → Environments → **New environment** `production`.
2. Add the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, the same values as the staging environment.
3. Optional but recommended: **Required reviewers** → yourself.

## 2. First deploy (creates the Workers)

1. Actions → **Deploy production** → Run workflow on `main`, and type `deploy`.
2. Check that <https://yegna-api.yegna-api.workers.dev/health> answers `{"ok":true,"env":"production"}`.

## 3. Production secrets

| Secret                                                             | How                                                                   | Runbook          |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- | ---------------- |
| `SETUP_CODE`                                                       | a new random value (`openssl rand -hex 24`), given to the Doctor only | ADR 0005         |
| `TEAM_BOT_TOKEN`, `TEAM_BOT_WEBHOOK_SECRET`                        | the clinic's real **Yegna Team** bot (from the Doctor's Telegram)     | `team-bot.md`    |
| `PATIENT_BOT_TOKEN`, `PATIENT_BOT_WEBHOOK_SECRET`                  | the clinic's real **Yegna Dental** bot                                | `patient-bot.md` |
| `BACKUP_KEY`                                                       | a **new** key, on paper for the Doctor (not the staging one)          | `backups.md`     |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | the production Google project; `pnpm google-auth --env production`    | `backups.md`     |
| `CF_ANALYTICS_TOKEN` (and account id)                              | for the free-tier usage alert                                         | `usage-alert.md` |
| Reader keys (optional)                                             | `GROQ_API_KEY`, `MISTRAL_API_KEY`, …                                  | ADR 0009         |

Each one is `npx wrangler secret put <NAME> --env production`.

Then add the bot usernames to `env.production.vars` in `apps/api/wrangler.jsonc` (`TEAM_BOT_USERNAME`, `PATIENT_BOT_USERNAME`) and in `packages/shared/src/clinic.ts` (`patientBot`), commit, and deploy again (step 2).

## 4. The clinic's own details

Before the website is shown to anyone, replace the placeholders, then set `CLINIC_DETAILS_CONFIRMED = true` and deploy:

- in `packages/shared/src/clinic.ts`: name, address, coordinates, phone(s) and services;
- in `apps/web/src/content/{am,en}/*.md`: the page copy, the doctor's bio and the FAQ answers.

## 5. Set up the clinic (the Doctor, on her phone)

1. Open <https://yegna-pwa.yegna-api.workers.dev>, then **Set up the clinic (Doctor)** with the setup code. Choose the Doctor's PIN.
2. Go through the setup steps: hours, procedures, link Telegram (this also connects the team bot), notifications.
3. Settings → Patient bot → **Connect the patient bot**.
4. Add the Staff accounts; each Staff phone signs in.
5. **Add to Home screen** on each phone.

## 6. Check (the same day)

- Book one test patient as Staff, approve it as the Doctor from Telegram, then cancel it.
- The next morning, check the Drive has `yegna-backup-production-<date>.ydb`.
- In the first week, do a restore rehearsal of a production backup **into staging** (`restore.md`).

## Later: the real domain

Follow ADR 0013 "Consequences": Custom Domains on the three Workers, update `PWA_ORIGIN`, the PWA's production API URL, and the website's `--site`, then build the website with `PUBLIC_INDEXABLE=1`.
