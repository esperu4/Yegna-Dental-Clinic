---
name: yegna-conventions
description: Project rules for the Yegna Dental Clinic codebase (data model, time, sync, privacy, i18n, free-tier budget). Use whenever writing or reviewing code, schema, UI copy or commits in this repo.
user-invocable: false
---

# Yegna conventions

These rules come from `PRD.md`. If a rule here and the PRD disagree, the PRD wins. Then tell the human that this file needs fixing.

## Before inventing behaviour
Check PRD §21 (decisions already made) and §22 (open items). If the answer depends on an open item, **stop and ask**. Don't guess clinic facts such as ET period boundaries, closing time, phone numbers, address, bot usernames or the AI provider.

## Words
Use the PRD §2 glossary terms exactly, in identifiers, UI copy and commit messages: Doctor, Staff, Booking, Call list, etc. Don't add synonyms (for example, not "appointment" in one place and "booking" in another).

## Data model (PRD §5)
- All ids are **UUIDv7 generated on the client**. Never use autoincrement ids, and never generate ids on the server for syncable rows.
- Every syncable row has `version` (assigned by the server from `sync_seq`), `updated_at`, `updated_by` and `deleted_at`. Deletes are soft (tombstones).
- Phones are stored in E.164 only, using the normaliser in `packages/shared`. An invalid phone shows an inline error and is never silently saved.
- Patient data is limited to name, phone, a note of up to 280 chars, and visit history. No medical records, images or payments.
- Every booking or patient change writes `audit_log` with the user and device.

## Time (PRD §6)
- Store every instant in **UTC**. Clinic timezone is `Africa/Addis_Ababa` (UTC+3, no DST).
- All calendar, ET clock and clinic-hours logic lives in `packages/time`, which stays pure and fully tested. Never do date arithmetic inline in apps.
- Close time and blocks are **hard** limits. Lunch is **soft** (warn, then allow). The booking grid uses 15-minute steps.
- Paper templates print the Ethiopian date and ET time only.

## Sync (PRD §7)
- Every PWA write goes to Dexie, then the outbox, then registers Background Sync. The UI never waits for the network.
- Server ops are idempotent by `opId`. Clash checks consider only `pending_approval`, `approved` and `arrived`. Other entities use last-writer-wins, and overwritten values go to `audit_log`.
- A typical sync stays **< 20 KB**: short keys, gzip, no full-table pulls after first install.

## Privacy and security (PRD §18)
- **No patient data in URLs, logs or analytics.** Log ids, never names or phones.
- Device tokens are hashed with SHA-256. PINs are salted and hashed, and attempts are rate-limited.
- Telegram webhooks verify `X-Telegram-Bot-Api-Secret-Token`, with a separate secret per bot.
- Secrets go only in Wrangler secrets / `.dev.vars` (git-ignored).
- Nothing is sent to a patient for a booking that isn't approved.

## Language
- Amharic (`am`) is the default and English (`en`) is the second language. Every user-facing string goes through i18n with both translations. Names may be in Ge'ez or Latin script, so search and matching must handle both.

## Free-tier budget (PRD §19)
- Every query needs an index, and hot paths (sync pull, day view, patient search) must show no full-table `SCAN` in `EXPLAIN QUERY PLAN`.
- Aim for ≤ 10 ms CPU per Worker request. Stay on one hourly cron that dispatches by Addis Ababa local hour. Don't add cron triggers.
- No always-on processes. Bots run on webhooks only.

## Telegram is optional
The PWA must stay fully usable with both bots down. Never make a bot the only way to do something.
