---
name: m3-progress
description: M3 (approval workflow + Yegna Team bot) plan and status, started 2026-11-10
metadata:
  type: project
---

M3 started 2026-11-10 while the user tests M1/M2 on staging.

Done and PUSHED (staging, CI green e2de085): Call list + Approvals screens (ADR 0008 call outcomes with callFor guard).
Cron + team bot + clash alerts + privacy fixes PUSHED 2026-11-10 (0022f0e, CI green, staging live). Staging bot username YengaTeamTestBot (user's spelling) in wrangler.jsonc staging vars.

User decisions 2026-11-10: user creates a TEST bot on their own Telegram now (separate staging bot), transfers ownership to clinic later (BotFather Transfer Ownership; needs 2FA ≥7 days). Never paste token in chat; user runs `wrangler secret put TEAM_BOT_TOKEN/TEAM_BOT_WEBHOOK_SECRET --env staging`; I add TEAM_BOT_USERNAME var once told.

2026-11-11: staging team bot WORKS — secrets stored, Doctor tapped Connect (webhook set). Gotcha: `wrangler secret put` from the `!` prompt stores an EMPTY secret (no tty); user must use a real terminal or pipe the value (runbook updated). User `!` shell is Bash. Open: M3 evidence doc + milestone check; privacy L-1 (rate-limit refusals to strangers) and Doctor-only 'Unlink Telegram' in Users screen; procedure codes stay in Telegram messages (user decided). Remote Control blocked by org policy (Owner toggle at claude.ai/admin-settings/claude-code).
Bot fully working on staging 2026-11-11 (connect + link + /today verified; user confirmed "works perfectly"). User plans an extensive visual design pass LATER — keep current UI functional, no polish now. UX TODO: the Doctor-only "Connect the bot to the server" link in Settings → Telegram is easy to miss — make it prominent or automatic.
Next session (user plan 2026-11-11): finish the project, then front-end designs. M4 needs AI provider decision (PRD §22 #3); M6 needs clinic Google account; M7 needs clinic content.

2026-11-11 later: L-1 (stranger/wrong-code replies once a day, housekeeping job), Doctor unlink in Staff accounts, Doctor's Link auto-connects — committed 7818f82 + runbook 45d0d27, PUSHED, CI green + staging deployed (run 43084512738), all tests + e2e green, privacy review clean. docs/milestones/M3.md written. Remaining for M3 sign-off: user approves a booking from Telegram on staging; then sign-off. M4 AI provider DECIDED — see [[m4-ai-provider]].
