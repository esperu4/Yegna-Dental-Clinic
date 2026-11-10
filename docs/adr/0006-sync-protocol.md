# ADR 0006: `/sync` protocol details

Date: 2026-11-10 · Status: accepted

PRD §7.4 defines the protocol. This ADR records the choices it leaves open. The code is in
`apps/api/src/sync/`, `apps/api/src/routes/sync.ts` and `apps/pwa/src/lib/sync.ts`.

## Versions are taken inside the write's batch

Every write runs `bumpVersion` and the row write in **one D1 batch** (`withVersion` in
`apps/api/src/lib/db.ts`), with the row's `version` set to `(SELECT value FROM sync_seq)`.
A batch is one transaction and D1 applies them one at a time, so versions become visible in
increasing order. Taking the number in an earlier request (as M1 slice 1 did) allows a smaller
version to commit after a device has already pulled a larger one, and that row is never synced.

Drizzle 0.45's `db.batch` crashes on a raw `sql` statement with bound parameters, so batches
that need one go through `rawBatch`, which compiles builders and `sql` to D1 statements.

## One op = one read batch + one guarded write batch

Each op is decided from one read batch (the row, plus the patient, procedure and clinic hours a
booking needs), then written in one batch with its version, its `audit_log` row and its
`sync_ops` result. The write is **guarded by the version that was read**: the UPDATE has
`AND version = <read version>`, and the audit and result rows are inserted only if the row now
carries the new version. If another device changed the row in between, nothing of the op is
written and it is decided again from the new row (twice at most, then it is left for the next
sync). So a decision is never applied to a row it did not see: no revived cancels, no
`approved → arrived` after a concurrent cancel, no second winner for a slot.

A booking also depends on other rows: its patient and procedure, and the settings, day rule,
holiday and blocks behind the clinic-hours check. The read batch records `sync_seq` (`seenSeq`),
and the booking write carries `bookingDependenciesUnchanged`: the patient and procedure are still
live, and none of those rows has a version above `seenSeq`. A booking is therefore never written
for a patient deleted meanwhile, or into a block or a shortened day that appeared meanwhile.

A whole request can't be one transaction because decisions need reads between writes. That is
safe: ops are applied in order, each is all-or-nothing, and a re-sent op returns its stored result.

## Idempotency

Results are stored per `(opId, device)`. Refusals are stored too, so a re-send gets the same
answer even after the data changed, **except `invalid`**: that answer follows from the op alone,
so storing it would only cost writes. An opId already used by another device is refused as
`invalid` and its result is never revealed.

## Staying inside D1's limits

- The free plan allows **50 D1 queries per Worker invocation** (a batch counts as one) and **100
  bound parameters per statement** (checked in Cloudflare's D1 limits docs, 2026-11-10).
- Every request counts its queries (`lib/queryMeter.ts`). `/sync` applies ops only while the
  budget covers the worst case for one more op (`MAX_QUERIES_PER_OP`) plus the pull. The response
  answers a **prefix** of the ops, and the device keeps the rest and calls again.
- Stored results for all sent opIds are fetched in one batch first, so re-sent ops cost nothing
  and an outbox full of already-applied ops can't stall.
- Id lists are chunked to 90 per statement.
- A device may send **2,000 ops in 24 h** (`DEVICE_DAILY_OPS`). Past that, its new ops are held
  back (left unanswered) but the pull still comes through, with `retryOpsAfterMs` (1 h). The device
  only pulls until then. This keeps one runaway or stolen device from using up the clinic's free
  daily D1 writes (PRD §19) without letting its schedule go stale.
- `MAX_QUERIES_PER_OP` is 8: read + extra hours read + write, twice, then storing a refusal found
  at the last write and reading back a concurrent copy's result.

## Clash check is one statement in the same batch

After a booking is created or moved, `UPDATE … SET status = 'clash' WHERE <overlap exists>` runs
in the same batch, and only on the row this batch wrote. Of two overlapping bookings sent at the
same moment, exactly one wins (the lower `version`). The overlap query range-scans
`bookings_status_start_idx`, bounded below by `MAX_BOOKING_MIN` (8 h).

## Booking rules enforced on the server now

`@yegna/shared/bookingLifecycle` holds the PRD §10 rules:

- the Doctor's bookings are approved automatically;
- an approved booking moved by Staff goes back for approval;
- only the Doctor approves;
- a cancel needs a reason;
- no-show is allowed from 20 minutes after the start.

The API enforces them and the PWA mirrors them. This pulls part of M3's first criterion forward
because M1's card actions need it. Hard clinic-hours limits (closed day, before open, after close,
block) are checked on the server too, and such an op is refused.

## Refusals are never silent

A refused op's values go into `audit_log` (`action = rejected:<reason>`). On the device they go
into a `notices` table (with the entered fields) until the user dismisses them, so a booking
refused because the Doctor closed the day early can be made again. Clash results are noticed the
same way (PRD §7.5).

## Wire format

- `changes` is grouped by entity (`{ patients: [...], bookings: [...] }`) instead of a flat list,
  so entity names are not repeated per row. Rows use the normal field names. Gzip makes repeated
  keys almost free: a busy day (40 patients + 40 bookings) is under 20 KB gzipped (tested).
- Changes come in pages of about 500, lowest version first, never ending a page inside a version.
  The response adds `more`.
- All tables are read in **one batch** (one snapshot). Reading them one by one could see a
  later write in one table and miss an earlier one in another.
- `initial: true` (sent until the device's first full pull finishes), and any pull from cursor 0,
  leaves out bookings older than today − 30 days (PRD §7.1). Later pulls send every changed booking, so a device never keeps
  a stale copy of a row it holds.
- Columns are listed explicitly per entity. Patients carry `telegramLinked: boolean`, never the
  chat id. Users carry id, name, role and `disabledAt` only.
- **Tombstones** (deleted rows) carry only their key and meta. A deleted patient's name and
  phone are not sent to any device again, and devices drop the row.
- For a refused op, the entity's current server row is added to `changes` whatever its version,
  so the device can replace its optimistic copy. A refused create with no server row is removed.

## Upserts and deletes

`dayRules` (keyed by date) and `settings` (one row) treat `create` on an existing key as an
update, with `INSERT … ON CONFLICT DO UPDATE`, so two devices creating the same date at once both
land (last wins). The overwritten values of the first create are not copied to `audit_log` in
that rare case (both writers are the Doctor, on the same date, at the same moment). Other entities refuse a second `create` with the same id (`exists`). Deletes
are tombstones (`deleted_at`). Bookings are never deleted; they are cancelled with a reason.

## Device side (M1)

- **Writes:** the working copy and outbox live in Dexie. A write is applied locally and queued in
  one transaction.
- **Rows from the server:**
  - Ops still in the outbox for that row are replayed on top (`applyLocally`), so a newer local
    edit is not overwritten.
  - A row is never replaced by an older version.
  - The cursor never moves back.
  - Tombstones are **kept** on the device as key + version + `deletedAt` (no content; screens skip
    them). Otherwise a late, older response could bring a deleted row back for good. Pending edits
    are never replayed onto a tombstone (the server refuses them, and they come back as notices),
    and the UI can't edit a deleted row.
  - Notices are dropped when their row is deleted, and after 30 days.
- **Network:** requests time out after 30 s. A body that can't be read is a failed sync, never a
  success.
- **When sync runs (M1):** only while the app is open: after each write, every 30 s, on `online`
  and when the app becomes visible.
- **Later (M2):** the service worker, Background Sync, the status pill, pruning bookings that have
  left the window, and the randomized multi-device tests (PRD §7.10).

## Not done yet

- `sync_ops` grows by one row per op; the hourly cron (M3) will drop rows older than 30 days.
- Two open questions for the clinic are listed in the M1 notes: whether a deleted patient's
  name and phone should also be erased from D1 (today they stay in the row and in `audit_log`),
  and whether a booking refused by a clinic-hours change should be kept as "needs fixing" instead
  of being refused (today it is refused, recorded, and shown on the device with its details).
