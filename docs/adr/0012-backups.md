# ADR 0012: Nightly encrypted backups, weekly CSV, restore

Status: accepted (built 2026-11-16, M6)

## Context

PRD §17 asks for three things:

- a nightly off-site backup to the clinic's Google Drive, encrypted, with retention;
- a weekly CSV to the Doctor;
- a tested restore.

D1 Time Travel (7 days) covers mistakes within a week, but not losing the Cloudflare account.

## Decisions

1. **The file.** Every app table is exported as raw rows (one `SELECT *` per table, skipping D1's and wrangler's own tables). The JSON is gzip'd, then encrypted with AES-256-GCM under `BACKUP_KEY`: 32 random bytes, base64, which the Doctor keeps on paper.
   - Layout: `YDB1` · 12-byte IV · ciphertext with its tag; the header is GCM additional data.
   - One module (`apps/api/src/backup/format.ts`, Web APIs only) is used by the Worker and by the Node scripts.
   - The file contains everything needed to bring the clinic back: PIN and device-token hashes too (never the secrets themselves).
2. **Drive.** The upload uses an OAuth refresh token of the clinic's own Google account, scope `drive.file`, so the app sees only the files it made.
   - Files are tagged with an `appProperties` marker and their date, and listing only ever touches those.
   - The refresh token is put into a Worker secret by `pnpm google-auth`, without being shown on screen.
3. **Retention.** After each upload, keep the newest 30 backups of that environment, plus every backup made on the 1st of a month for `MONTHLY_KEEP_MONTHS` (forever, as in the PRD, until the clinic decides; see Consequences). Delete the rest. Files are tagged with their environment, and production uses its own Google project, so environments never touch each other's backups. A retention failure only logs and does not mark the backup failed.
4. **When.** From 02:00 local, once a day (`notification_log` kind `backup`). A failure is retried every hour until it succeeds that day, and the Doctor is told once per day through the team bot. The backup runs first in the hourly cron, and does not need the team bot.
5. **CPU and budget.** The export is a single invocation: about 18 queries, then one JSON, gzip and encrypt pass, which fits a small clinic's data within the Workers limits. If it ever fails on CPU time, the Doctor's failure alert shows it, and the fix is the PRD's split: one table per invocation, joined on Drive.
6. **Weekly CSV.** On Sunday from 21:00, once, two files go to each Doctor via the team bot's `sendDocument`:
   - all live patients;
   - bookings from 8 weeks back to 8 weeks ahead, with Ethiopian and Gregorian dates.

   The files are UTF-8 with a BOM, so spreadsheet apps show Amharic. Cells starting with `= + - @` are prefixed with `'` (no formula injection).

7. **Restore.** `pnpm restore --from <file | drive:<id>> --to <local|staging|production>`:
   - decrypts the file and checks it against the **target's** live schema (every table present, no unknown column);
   - replaces all rows in one transaction (`wrangler d1 execute --file`), then compares row counts;
   - production needs `--yes-replace-production`, and `--dry-run` only validates;
   - the temporary SQL file (plain patient data) is created privately and always deleted: on exit, on Ctrl+C, and left-overs at the next start;
   - it keeps what the replaced database knew: phones revoked since stay revoked and patients erased since are erased again. It signs every phone out, so no phone keeps rows newer than the restored ones (`--keep-devices` skips that for rehearsals);
   - for production it first prints a Time Travel bookmark, to undo with. It is not yet confirmed whether a remote `--file` import is all-or-nothing, so that bookmark is the safety net;
   - secrets are typed at a hidden prompt (or read from the environment), never put on the command line.

   `pnpm backup --from <target> --out <file>` makes the same file by hand.

## Consequences

- Erased patients (ADR 0007) remain in backups made before the erasure: for 30 days in the nightly ones, and **for as long as the 1st-of-month backups are kept**, which the PRD says is indefinitely. This needs the clinic's decision (keep them all, or limit them, e.g. to 12 months).
- The weekly CSVs (with notes) stay in the Doctor's Telegram history, outside the encryption and outside ADR 0007 erasure (PRD §17.3 asks for them).
- After a production restore, every phone signs in again, and the patient bot is paused until staff have checked the bookings (runbook).
- Losing `BACKUP_KEY` makes every backup unreadable: the paper copy matters. Rotating the key makes older backups need the old key.
- Restore needs the target's migrations applied first (the check refuses otherwise).
