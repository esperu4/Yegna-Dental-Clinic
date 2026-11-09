# Runbook: unlock enrolment

Use when someone cannot enrol a new phone because of a lockout (the app says "Too many wrong tries")
and waiting is not an option, for example the Doctor lost their only phone.

## Staff member locked out

The Doctor opens **Settings → Staff accounts** and sets a **New PIN** for that person. That lifts the
lockout on their **name** immediately. Give them the new PIN privately.

If it still says "Too many wrong tries", the lock is on the **network** (several wrong tries from the
same Wi-Fi or mobile network). Either wait (5 minutes at first), switch networks (e.g. from Wi-Fi to
mobile data), or clear the locks as below.

## Doctor locked out (no enrolled phone available)

Run from the repo root, with Wrangler logged in to the clinic account. Replace `staging` with
`production` as needed.

1. Check what is locked (keys are hashes; nothing personal is shown):

   ```sh
   pnpm --filter @yegna/api exec wrangler d1 execute DB --remote --env staging \
     --command "SELECT key, failures, locks, locked_until FROM auth_attempts WHERE locked_until > unixepoch() * 1000"
   ```

2. Clear the lockouts:

   ```sh
   pnpm --filter @yegna/api exec wrangler d1 execute DB --remote --env staging \
     --command "DELETE FROM auth_attempts"
   ```

3. The Doctor enrols the new phone straight away with name + PIN.
4. If the locks come back within minutes, someone is guessing the Doctor's PIN. After enrolling,
   the Doctor should change their PIN (6 digits) and revoke any device they don't recognise in
   **Settings → Phones**. `audit_log` rows with `action = 'lockout'` show when it happened.
