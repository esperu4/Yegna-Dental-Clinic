---
name: m1-progress
description: 'Where M1 stands as of 2026-11-10 and what to do next (slice 1 live on staging; slice 2 sync built, under re-review, uncommitted)'
metadata:
  node_type: memory
  type: project
  originSessionId: 9d25f0a7-a5e6-4979-9816-cc8cb7da0f79
  modified: 2026-11-10T11:46:44.890Z
---

M0 signed off 2026-11-09. M1 (PWA core, online) in 4 slices: (1) accounts/devices, (2) POST /sync used online, (3) screens: setup wizard + procedures CRUD first, then Today/Week/booking sheet/card actions, am/en + ET/Gregorian toggles, (4) ≤3 taps / <30 s Playwright timing test.

Slice 1 DONE, pushed (2d3d56d), CI green, live on staging; staging re-seeded (empty users); log check: Authorization header not captured.

Slice 2 (2026-11-10): built and passing (232 unit/integration tests + e2e), ADR docs/adr/0006-sync-protocol.md. First reviews (sync-reviewer, privacy-reviewer) found real bugs, all fixed: version allocated inside write batch; version-guarded writes + retry; 50-queries/invocation budget (lib/queryMeter.ts, prefix answers); window only on `initial`; tombstones key+meta only; per-device 2000 ops/day; notices table on device. Three review rounds, all clean. Committed locally as 1c70bcd, NOT pushed (wait for "push"; after pushing, run `db:migrate:staging` is done by CI — check migration 0002 applied). Slice 3a (wizard, procedures, weekly hours) committed 8bd4d44; slice 3b (Today/Week, booking sheet, card actions, day rules/blocks/holidays, 3-tap timing e2e = slice 4) committed 29297bc. None pushed (3 commits ahead + 2d3d56d pushed). Remaining for M1 sign-off: language/calendar toggle "on every screen" (only in Settings now — clarify with user), Approvals list screen?, push + staging check, /milestone-check M1. Amharic UI copy written by Claude: flag for native-speaker review. Screens must skip tombstone rows (deletedAt set) and read from Dexie via sync.write for changes.

User decisions 2026-11-10 (answered interactively): (a) ERASE deleted patients' name/phone/note in D1 (phone freed for reuse; needs partial unique index migration; record as ADR); (b) bookings that hit hours/blocks get a "needs fixing" status (stored in red like a clash, Staff move them) instead of being refused; (c) add a small language + calendar switch to every screen header; (d) pushed the 3 local commits (CI green, staging live). Follow-up decisions: moves into a now-invalid time are REFUSED (needs_fixing only for new bookings); booking notes/cancel reasons of a deleted patient are erased too. All implemented in 4c6f345 (pushed, CI green, migrations 0003/0004 on staging). M1 evidence record docs/milestones/M1.md + schedule e2e committed 39aad6a (local, not pushed). All 5 M1 criteria have automated evidence; waiting for the user's staging demo + sign-off (demo steps listed in M1.md). Amharic copy needs native review.

Tips: the `!` shell is PowerShell — wrap bash in `bash -c '...'`. Drizzle 0.45 db.batch crashes on raw `sql` with params → use rawBatch/withVersion or query builders. The tool may turn typed `\u202x` escapes into raw chars — build them in Python with chr(92).

User decisions 2026-11-09: free workers.dev domain; ET period boundaries and 18:00 close (ADR 0003/0004); one-time setup code (ADR 0005); Doctor PIN 6 digits (Claude's choice, told user).

Related: [[clinic-owner-account]] [[work-style]]
