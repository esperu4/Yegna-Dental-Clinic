# ADR 0008: Call list outcomes on the booking

Date: 2026-11-10 · Status: accepted (decided by the project owner, 2026-11-10)

## Context

PRD §8 item 8 gives each call-list row "Call · Mark handled", but the data model (§5) has nowhere to
keep "handled" for booking rows (only `patient_requests` has a status). The call list is shared by
the front desk and the Doctor, and works offline like every other screen.

## Decision

- Three synced columns on `bookings`: `call_handled_at`, `call_handled_by`, `call_tried_at`
  (migration 0005), sent to devices as `callHandledAt`, `callHandledBy`, `callTriedAt`.
- A booking update may carry `call: 'confirmed' | 'no_answer' | 'handled'`, sent alone (not with a
  status change or an edit), and only for a booking still coming up (`pending_approval` or
  `approved`); otherwise it is refused (`invalid` / `invalid_transition`).
  - `confirmed`: the patient confirmed on the phone. Sets `patient_confirmed_at`, and handles the row.
  - `no_answer`: sets `call_tried_at`; the row stays on the list, marked "No answer at …".
  - `handled`: handles the row (`call_handled_at`, `call_handled_by`).
- A handled booking leaves everyone's call list. Moving the booking (new date, time or length)
  clears the confirmation and all call marks, so it comes back on the list for the new time.
- The list itself is computed on the device (`apps/pwa/src/lib/callList.ts`): tomorrow's bookings
  whose patient has no Telegram, and bookings still `pending_approval` within 24 h of their start
  (§10). Open patient requests join it with the patient bot (M5).

## Consequences

- Both phones and the Doctor see the same list; a call made on one phone shows on the others.
- `patient_confirmed_at` is now also set by the front desk; the patient bot (M5) sets it the same way.
- Every outcome is an op, so it is audited and idempotent like any other change.
