# ADR 0010: The import pipeline (online review, bookings through sync)

Status: accepted (2026-11-11)

## Context

PRD §12 describes the flow: a photo of a paper sheet is read by AI, matched, reviewed by a person, and confirmed rows become bookings "through the normal sync path". It leaves open how imports reach the phones, how an upload from the app is stored when we keep only Telegram `file_id`s, and the exact matching rules.

## Decision

1. **Imports are online only.** `imports` and `import_rows` are served by `/imports` routes and are not synced to devices. The review needs the photo, which is streamed from Telegram, so it needs the network anyway; keeping them out of `/sync` saves D1 reads and device storage.
2. **Bookings still go through `/sync`.** On confirmation, the PWA queues the patient and booking ops in its outbox like any booking, with `importRowId` set. The server stores `source = import` and `import_row_id`, applies every booking rule (hours, clashes, approval), and accepts **one booking per row** (`import_row_used` otherwise; a partial unique index backs it). `POST /imports/:id/confirm` then records the decisions and marks the import reviewed.
3. **App uploads** (decided by the project owner, 2026-11-11): the server has the Team bot post the photo into the uploader's own Telegram chat and keeps the returned `file_id`. The uploader must have linked Telegram (`telegram_not_linked` otherwise). No photo bytes are ever stored by us.
4. **Reading** runs in the background after the webhook or upload answers, stopped after 25 s. If time runs out the import stays `queued` and is read when someone opens it (`POST /imports/:id/process`). A claim (`updated_at` lease of 90 s) keeps two runs from reading one photo.
5. **Matching** (`packages/shared/src/importMatch.ts`, `apps/api/src/imports/process.ts`):
   - Dates come from the sheet ID (`YD-F-2019-T03W2`, see `sheetId.ts`). Without a readable ID, rows have no date and are `unreadable` until fixed on the review screen.
   - An ET time is read as the reading that falls inside that day's opening hours, then snapped to the 15-minute grid. A snapped time is flagged to check.
   - The patient is matched by phone (E.164). On template O (no phones), by name similarity ≥ 0.85 against all patients, never when two are equally close, and always flagged to check.
   - A row is a duplicate when the same patient has an active booking within ±30 min; it defaults to **skip**, and skipped duplicates are reported to the Doctor with the existing booking's time and who made it.
   - Rows read with confidence < 0.6 are flagged to check.

## Consequences

- The Imports screens need a connection; the rest of the app stays offline-first.
- A row confirmed on two phones still becomes one booking.
- `imports.raw_result` keeps the reader's output for evaluating readers (PRD §12 golden set); it holds patient names and phones, like the rows themselves.

## Limits (added after the sync and privacy reviews, 2026-11-11)

- **One booking per sheet row, ever.** A row whose booking was later cancelled or deleted is not imported again; the review screen shows it as already used (`import_row_used`). Two phones confirming the same row race on the unique index; one wins, the other gets the refusal.
- **A review is recorded once.** `POST /imports/:id/confirm` is accepted only while the import is `read`; the booking IDs are not sent by the phone but found from `bookings.import_row_id`.
- **Daily caps** (`apps/api/src/imports/limits.ts`): 30 new imports per person per clinic day, and 20 last-resort (Gemini free) reads per clinic day for the whole clinic. Past the cap, uploads get `locked` and the last resort is skipped (manual entry still works).
- **Uploads** are JPEG, PNG or WebP only, at most 5 MB, with the size declared up front (`411` otherwise) and checked against the file's first bytes.
- **Retention:** imports and their rows are deleted 30 days after review by the daily housekeeping job. Bookings made from them stay.

## Review screen (added after the second sync and privacy reviews, 2026-11-12)

- **Confirming is atomic.** The confirm batch moves the import out of `read` with a guarded update; the row decisions and the audit row are written only if that update landed. Of two phones confirming at once, one gets `409 conflict`. On a conflict the phone reloads the sheet and, if it is now reviewed, books only the rows still open there.
- **The phone syncs before it plans**, so a patient added on another phone a moment ago is matched rather than refused with `phone_taken`.
- **A sheet's patients and bookings are queued all or none** (`sync.writeMany`), in order: each new patient before its bookings. If the patient is refused, its bookings are refused too (`patient_not_found`) and the phone removes the provisional rows, even when the answers come in different rounds. A provisional patient is removed only on a recorded refusal of its create, never because one of its bookings was refused.
- **Refused rows come back.** A reviewed sheet offers its accepted rows that have no booking and none waiting in this phone's outbox. The list shows "N not booked yet" (`toBook`), and a refused import booking's notice links to the sheet photos.
- **The reviewer's edits survive background syncs**: drafts are kept per row and only rows newly open start from what was read. While the screen stays open, a sent row that comes back refused keeps the reviewer's corrections.
- **Route ids**: the review screen only opens a UUIDv7 import id from the URL.

Known follow-ups (not blocking M4): a second phone may be offered rows the first has queued but not yet sent (the unique index keeps it to one booking; whichever arrives first wins); skipping a still-open row on a reviewed sheet is not recorded (it keeps being offered); the PWA has no Content-Security-Policy yet (rendering relies on Preact's escaping); the randomized sync simulation does not yet send `writeMany` batches.
