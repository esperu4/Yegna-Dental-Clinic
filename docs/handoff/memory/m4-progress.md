---
name: m4-progress
description: 'M4 (paper templates + imports) plan and status, started 2026-11-11'
metadata:
  node_type: memory
  type: project
  originSessionId: 50970d29-26f3-40d6-8a67-a8d5e85ab31c
  modified: 2026-11-11T19:25:23.748Z
---

M4 started 2026-11-11 (user: "continue to the next milestone, set your goals"). M3 awaits only the user's approve-from-Telegram check (approval message comes with the hourly cron).

Goals (in order):

1. packages/ai — DONE, committed af5ba67 (local, not pushed): ScheduleReader, prompt v1, strict parser, readers (workersAi, chat for Groq/OpenRouter/Mistral chat, mistralOcr, gemini, stub), readSchedule chain (primary then lastResort), ADR 0009.
2. Print templates — DONE, committed e85e897 (local): sheetId in packages/shared (YD-F-2019-T03W2; C -1/-2; O month), lib/printSheet.ts, lazy Print screen (route #/print, link on Today), uqr 0.1.3 pinned, e2e print.spec (PDF pages + no clipping on phone and desktop; PRINT_SHOTS=<dir> saves screenshots). Lesson: print CSS must be scoped (.paper-*) — a global .sheet broke the booking bottom sheets. Manual check still needed: print on Android (user).
3. API import pipeline — BUILT 2026-11-11 (uncommitted, under sync + privacy review): ADR 0010; packages/shared importMatch.ts; apps/api/src/imports/{readers,process,photo,report}.ts; routes/imports.ts (GET list/detail/photo, POST upload/process/confirm); bot photo handler; sync bookingCreate importRowId + migration 0008 (import_rows columns, bookings_import_row_uq). TELEGRAM_CLIENT makes grammY use global fetch (tests never hit Telegram). Original goal text: bot photo → imports row (file_id only), waitUntil read via chain, POST /imports/:id/process fallback, image stream endpoint via getFile, matching (phone; duplicate ±30 min; O by name, needs check), bot replies.
4. PWA Imports list + review screen; confirm rows → bookings via sync (source=import); skipped duplicates → Doctor via team bot.
5. pnpm eval:imports over golden set (needs user's ~10 photos), docs/milestones/M4.md.

DECIDED 2026-11-11: PWA upload → server has the Team bot post the photo into the uploader's own linked chat to get a file_id (uploader must have Telegram linked; otherwise the app says link Telegram first).

Related: [[m4-ai-provider]] [[m3-progress]] [[work-style]]

2026-11-11: CI run 43095394117 (templates push) stuck queued with 0 jobs (GitHub glitch); deployed PWA staging BY HAND from a clean worktree of e85e897 (Print screen live). Next push will start a fresh CI run (cancel-in-progress).

PAUSED 2026-11-11 evening (user: "continue tomorrow"). State: goal 3 + review fixes UNCOMMITTED in working tree; last job/sync/import tests green.
Done from reviews: sync race guard importRowStillFree + import_row_used mapping + concurrency test; chain skips lastResort unless a primary really tried; photo types/size 5MB, nosniff+CSP, Content-Length 411 + magic bytes; daily caps (imports/limits.ts: 30/user/day, 20 Gemini/day); raw_result trimmed; confirm only from 'read', bookingId derived from bookings.import_row_id; booked-by = createdBy; 30-day import retention in housekeeping. Router params (#/imports/<id>) + test added in PWA.
RESUME TODO: (1) add index imports(uploaded_by, created_at) in schema, regenerate 0008 (rm 0008 sql+snapshot, git checkout journal, generate --name import_row_matching); (2) PWA REASON_KEYS for import_row_used/import_row_not_found (bookingCards.tsx) + am/en copy; (3) update tests for removed confirm bookingId + new 411/magic-byte upload rules (imports.test.ts upload sends 3 bytes ff d8 ff — ok; add Content-Length? app.request may not set it → check); (4) full pnpm test/lint/typecheck/format, ADR 0010 note: rows with any booking can't be re-imported, retention 30 days, caps; (5) commit; then goal 4 PWA Imports screens. CI run 43095394117 stuck; next push retriggers.

2026-11-12: user has NO time for real sheet photos — build the goal-5 golden set from SAMPLE images (synthetic filled sheets made by us), do not ask for photos again. Goal 3 resume steps 1-4 done (0008 regenerated with imports_uploader_created_idx; PWA reason keys; tests fixed; ADR limits section).

2026-11-12 (handoff before switching to Omarchy/Linux): goal 3 committed b662839 and pushed to main. Goal 4 (PWA Imports list + review screen) is WORK IN PROGRESS on branch `wip/m4-pwa-imports` (one WIP commit, NOT reviewed, NOT on main). Known state of that WIP: `pnpm --filter @yegna/pwa typecheck` has ~10 errors (test/imports.test.ts:167 implicit any on the fake write callback params, others), and 2 failing tests in apps/pwa/test/imports.test.ts ("refuses rows that cannot become a booking, and ignores skipped ones" — expected [] got a 'gone' row; "queues a new patient once, then every booking pointing at it"). Files: apps/pwa/src/{lib/imports.ts,screens/Imports.tsx}, e2e/imports.spec.ts, api.ts/sync.ts/localOps.ts changes, i18n copy, styles. RESUME: fix typecheck + 2 tests, run full test/lint/format + e2e, sync-reviewer + privacy-reviewer, squash the WIP into a proper "M4: PWA imports" commit, merge to main. Then goal 5 (golden set from sample images, eval:imports, docs/milestones/M4.md).

2026-11-12 later: goal 4 fixed on wip/m4-pwa-imports (uncommitted on top of c82df71): screen/tests moved to rowsToBook + planChanges + sync.writeMany; deletedPatientIds from Dexie tombstones, queued row ids from outbox; reviewed sheets re-book open rows without calling /confirm (409). Imports e2e moved to the Monday after next (it clashed with schedule.spec's 3rd open day = same D1). All green: typecheck, lint, format, unit (pwa 120), e2e 10/10. Sync + privacy reviews running. Pushes are blocked by the auto-mode classifier — user pushes by hand (`! git push ...`).

2026-11-12 night: goal 4 DONE and committed on wip/m4-pwa-imports ("M4: PWA imports list and review screen", on top of b662839). Two sync-review rounds + privacy review addressed (atomic guarded confirm, toBook count, writeMany, refused-patient cleanup only on recorded refusal, drafts survive syncs and refusals, UUID-only route ids). ADR 0010 "Review screen" section lists follow-ups (skip on reviewed sheet not recorded; no CSP yet; sim lacks writeMany batches). NOT YET RUN after the last fixes: `pnpm --filter @yegna/pwa test:sim` and `pnpm --filter @yegna/pwa e2e` (killed for low memory) — run both first. Then merge to main (deploys staging) and start goal 5 (golden set from sample images, eval:imports, docs/milestones/M4.md).
