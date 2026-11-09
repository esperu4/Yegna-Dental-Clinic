# ADR 0005: First doctor setup code, enrolment and PIN lockout

Date: 2026-11-09 · Status: accepted (revised after the privacy review the same day)

## Context

PRD §8 says the doctor creates the first account on first use. The PWA is on a public URL, so
"whoever opens it first becomes the doctor" would let anyone who finds the link take over the clinic.
New devices enrol with name + PIN, and the doctor's name will be public (website, bot), so a
4–6 digit PIN must be protected by the server's lockout, not by hashing.

## Decision: setup code (chosen by the project owner)

- `POST /setup` requires a code matching the Worker secret `SETUP_CODE`, at least 32 characters
  (generate with `openssl rand -hex 16`). Missing or shorter ⇒ setup is disabled (503).
- Setup works only while the `users` table is completely empty, not merely "no live doctor",
  so a lost or deleted doctor row can never reopen it. A conditional insert makes racing setups
  create one user.
- After setup, delete the secret: `wrangler secret delete SETUP_CODE --env <env>`.

## Decision: lockout

- Every attempt is counted atomically **before** the PIN or code is checked, so parallel requests
  cannot get extra guesses (tested with 20 simultaneous guesses). It is done in two phases: if any
  of the request's counters is already locked, the request is refused **and counts nothing**, so a
  client that is locked out cannot push anyone else's counter.
- Counters, each locking when its limit is reached:

  | Key                            | Limit per round | Why                              |
  | ------------------------------ | --------------- | -------------------------------- |
  | name (`enrol:<sha256>`)        | 5               | PRD: five wrong PINs ⇒ lockout   |
  | client network (`ip:<sha256>`) | 10              | one PIN tried against many names |
  | setup code (`setup`)           | 5               | brute force of the code          |

  The network is the IPv4 /24 or IPv6 /64 (one IPv6 client controls a whole /64). There is
  deliberately **no clinic-wide lock**: anyone could keep it shut for everyone.

- Lockouts double while there is no success: 5, 10, 20, 40, then 80 minutes.
- **The Doctor's PIN must be 6 digits** (within PRD §8's 4–6). The Doctor's name is public and the
  account has full rights: at the 80-minute cap a 4-digit PIN could be guessed in about two months,
  a 6-digit one in decades. Staff PINs stay 4–6 digits.
- Success clears the name's counter. The network counter gets the attempt back and its escalation
  reset; its lock is lifted only if this very request set it.
- Trivial PINs (one repeated digit, or a straight run such as 1234 or 9876) are refused when a PIN
  is chosen. Existing PINs still work at sign-in.
- Each lockout writes an `audit_log` row (`entity = 'auth'`, `action = 'lockout'`) with the
  key only. **The M3 team bot must alert the Doctor from these rows.**
- Keys are hashes. For names this only keeps keys short (staff names are in `users` anyway). For
  addresses only the truncated network is hashed, so no individual address is stored.

### Trade-off: a stranger can delay enrolment

Anyone who knows a user's name can keep that name locked, which blocks enrolling a **new** phone for
that user. Phones that are already enrolled keep working. Recovery:
`docs/runbooks/unlock-enrolment.md`.

## Related choices

- **Enrolment** is name + PIN (PRD §8), so active names are unique (trimmed, case-insensitive,
  spaces collapsed), including when a user is re-enabled. Unknown names and wrong PINs get the same
  answer and the same hashing time.
- **PIN hashes**: PBKDF2-SHA256, per-user salt, 5,000 iterations (≈ 4.6 ms on a laptop; 20,000 took
  ≈ 16 ms, over the Workers free-plan CPU budget, PRD §19). The format records the iteration count.
  With at most a million PINs, any leaked hash falls to offline guessing whatever the cost, so the
  lockout is the protection. Server PIN hashes are never sent to devices; the offline lock screen
  keeps its own verifier on the device.
- **Device tokens**: 32 random bytes, sent once; only the SHA-256 is stored. `401 revoked` for revoked
  devices and disabled users tells the PWA to wipe itself (PRD §7.9).
- **Admin routes** live under `/admin` behind one doctor-only guard; a test checks every route.
- A deployed Worker refuses to serve if `PWA_ORIGIN` is a localhost address.
- `last_seen_at` is updated at most every 5 minutes per device to save D1 writes.
