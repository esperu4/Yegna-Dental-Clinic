# ADR 0007: Erase deleted patients, keep "needs fixing" bookings, header switches

Date: 2026-11-10 · Status: accepted (decided by the product owner)

These questions came up while building M1 slices 2–3. The PRD did not answer them.

## 1. Deleting a patient erases their details

**Decision:** when the Doctor deletes a patient (PRD §9), nothing that identifies them is kept.

- The row keeps only its id and sync metadata. Name, phone, note and Telegram link are cleared.
- Their bookings lose their free text: note and cancel reason (decided after review). Times,
  procedures and statuses stay.
- The values kept in the audit history are cleared:
  - all of the patient's rows;
  - the free text in their bookings' rows;
  - refused bookings made for them.
    Who changed what kind of thing, and when, is kept.
- The phone number becomes free for a new patient.

**How:**

- `apps/api/src/sync/apply.ts`: `ERASED_PATIENT` and `erasePatientTraces`, run in the delete's write
  batch, only if the delete lands. Changed bookings get the new version, so devices pull the cleared
  notes. No separate audit row is written for these booking changes; the delete's own audit row
  covers them. Pulls never split a version, even one shared by more rows than a page.
- A refused patient op only ever stores the field **names** in `audit_log`, never values. Such a row
  is keyed by the op's id, not the existing patient's, so it couldn't be found and cleared later.
  The same goes for an edit that arrives after the delete. The device keeps no patient details on
  its notices either.
- Ops that reach the server after the delete (a phone that was offline) can't bring text back:
  - a booking update for an erased patient still changes the status (for example a cancel), but its
    note and cancel reason are stored empty, and a refusal keeps only field names;
  - a booking refused because its patient is gone keeps only field names;
  - a booking write decided while the patient was live lands only if the patient is still live, and
    is otherwise decided again.
- Migrations:
  - `0003_erase_deleted_patients`: makes `patients_phone_uq` unique among live patients only
    (`WHERE deleted_at IS NULL`) and erases patients deleted earlier.
  - `0004_erase_deleted_patient_traces`: their booking notes, booking audit values, and refused
    patient values.
- Devices receive deleted rows as content-free tombstones (ADR 0006).

**Consequences and obligations:**

- Past bookings of a deleted patient remain (visit counts, schedule history) but no longer show who
  the patient was.
- A lookup by phone must say `AND deleted_at IS NULL` to use the index. The patient bot's contact
  linking (M5) must do this.
- Later milestones must extend the erase when they add data:
  - `notification_log.target_chat_id` for the patient's bookings (M3/M5): clear it, and cancel
    pending messages to them;
  - `import_rows.name_text` / `phone_text` linked to their bookings (M4);
  - a retention limit for `imports.raw_result`.
- Not erased:
  - backups made before the deletion, until they expire (M6 retention);
  - phones that have not synced since the deletion, until they next sync (or are revoked).
- If a new patient with the same number is created on a device before the delete reaches the server,
  it is refused (`phone_taken`) and has to be entered again afterwards.

## 2. New bookings that break clinic hours are kept as "needs fixing"

**Decision:** a **new** booking that breaks a hard clinic-hours rule is stored with status
`needs_fixing` instead of being refused. Examples: a time after the closing time the Doctor set for
that day after the booking was made offline, inside a new block, or on a day now closed. Nothing
promised to a patient disappears.

**Moves are refused instead** (decided after review): moving an existing booking into such a time is
refused, and the booking keeps its confirmed time and approval.

**Behaviour:**

- It shows in red with the reason. It is listed under "Needs attention" on its day, even on a closed
  day, and counted in the Week view.
- Staff fix it by moving it, or by saving its own time again once the Doctor has restored the hours
  (it is re-checked in place). Staff's fix → `pending_approval`, the Doctor's → `approved`.
- It can be cancelled with a reason, but not approved directly.
- It takes no time in the clash check and is never approved as is, so patients receive nothing for
  it (PRD §14).
- The sync result is `{ outcome: 'needs_fixing', reason }`. The device turns it into a notice, which
  goes away once the booking is fixed.

The device still blocks such a time when it knows the rule (the booking sheet's hard errors), so this
only happens when the hours changed while a device was offline.

Existing bookings that a later change of hours puts outside the day (an approved booking on a day the
Doctor then closes) are not changed. They are listed under "Needs attention" so someone sees them.

## 3. Language and calendar switches on every screen

**Decision:** every signed-in screen has a header switch for Amharic ⇄ English and Ethiopian ⇄
Gregorian, as well as Settings (M1: "toggles on every screen").

**How:** a change applies on the device at once and works offline. It is saved to the account via
`PATCH /me`, or later if offline or after a server error (`apps/pwa/src/lib/preferences.ts`).
