# Runbook: restore a backup

ADR 0012, PRD §17. A restore **replaces all data** in the target with the backup's. Rehearse it on staging before launch, then every quarter. Write down each rehearsal at the bottom of this page.

## Before you start

- You need the backup key: the Doctor's paper copy for that environment's backups. The scripts ask for it with hidden input. Don't put it on the command line, where shell history keeps it.
- The target must have every migration applied: `pnpm db:migrate:staging` (or `db:migrate:local`). The restore refuses a backup that does not fit the target's tables.
- Restoring **production**:
  - First tell the team to stop using the app. Every change made after the backup was taken will be lost.
  - Consider D1 Time Travel first (`npx wrangler d1 time-travel restore DB --env production --timestamp …`) if the problem happened within the last 7 days.
  - **Pause the patient bot** (`npx wrangler secret delete PATIENT_BOT_TOKEN --env production`) until staff have checked the restored bookings. Otherwise a booking cancelled after the backup could be confirmed or reminded again.
  - The script prints a Time Travel bookmark first: write it down, it is how you undo the restore.

## 1. Get the backup

Either:

- **From Drive in the browser:** download `yegna-backup-<env>-<date>.ydb` from the clinic's Drive.
- **Or by id:** use `--from drive:<file id>`, with `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN` set in your terminal. These are the same values as in the backup runbook; you need the refresh token again, so for staging rehearsals the downloaded file is simpler.

## 2. Check it (changes nothing)

From `apps/api`:

```
pnpm restore --from C:\path\yegna-backup-staging-2026-11-20.ydb --to staging --dry-run
```

It prints each table's row count. A wrong key says `wrong_key_or_damaged`.

## 3. Restore

```
pnpm restore --from C:\path\yegna-backup-staging-2026-11-20.ydb --to staging
```

Production also needs `--yes-replace-production`. It ends with a ✓ per table when the row counts match.

What the restore keeps from the database it replaces:

- **Phones revoked since the backup stay revoked**, and **patients deleted since stay erased** (ADR 0007).
- **Every phone is signed out**: each one wipes itself and must sign in again. This keeps a phone from holding rows newer than the restored ones. For staging rehearsals, `--keep-devices` skips it.
- If the old database cannot be read at all (account lost), redo by hand any phone revocations and patient deletions made after the backup.

If a restore is interrupted (Ctrl+C, a crash), the next run deletes the leftover plain-text file. Check that `%TEMP%` holds no `yegna-restore-*` folder if you do not run it again.

## 4. Spot-check

1. Sign in again on each phone (the Doctor first, with the PIN; then add Staff phones as usual). With `--keep-devices`, phones enrolled before the backup stay signed in.
2. Compare three patients and three bookings (name, phone, time, status) with the backup's day.
3. Check Settings → hours and procedures.
4. Settings → Devices: no lost or old phone is listed as active.
5. Restore the patient bot token if you paused it (patient-bot runbook §2).

## Rehearsal log

| Date       | From                       | To    | Rows OK         | Spot-check                          | By                   |
| ---------- | -------------------------- | ----- | --------------- | ----------------------------------- | -------------------- |
| 2026-11-16 | `pnpm backup --from local` | local | ✓ all 18 tables | seed data (8 patients, 12 bookings) | Claude (development) |
