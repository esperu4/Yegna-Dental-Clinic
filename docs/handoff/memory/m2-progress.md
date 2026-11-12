---
name: m2-progress
description: "M2 (offline and sync) plan and status, started 2026-11-10; M1 awaits the user's staging demo"
metadata:
  node_type: memory
  type: project
  originSessionId: 9d25f0a7-a5e6-4979-9816-cc8cb7da0f79
  modified: 2026-11-10T14:22:37.215Z
---

M1 finished and pushed 2026-11-10 (39aad6a, CI green); sign-off waits for the user's staging demo (steps in docs/milestones/M1.md). User chose to start M2 meanwhile.

M2 criteria (PRD §20): service worker + Background Sync + periodic sync; status pill (4 states) + sync notifications; clash handling end to end; §7.10 randomized multi-device tests ≥1,000 runs zero lost ops; manual Android airplane-mode check (user); revoke wipes device (done in M1).

Done and PUSHED (CI green, staging live, df3f8f9): slice 1 pill+summary; slice 2 service worker (offline shell, Background Sync, periodic, offline e2e on wrangler dev incl. CDP sync test); fixes for preference saves (ordered, write-ahead). Staging /index.html 307s — SW caches '/'. User decision 2026-11-10: notify only when the app isn't on screen. Slice 3 DONE and pushed (c1051d7, CI run 42857141840 green incl. sync-sim 1,000 runs; staging deployed 2026-11-10). Fixes along the way: step-back guard for provisional rows, re-pull instead of trusting stuck provisional rows, move sheet offers only free times, e2e openDay waits for data-plan-date. Remaining for M2: user's Android airplane check (steps in docs/milestones/M2.md). Old unfixed clashes: user chose 'let them disappear' after 30 days. Unexplained once-seen CI audit mismatch (16 rows/14 ops): sim now reports details if it recurs.

Plan (slices): (1) status pill + in-app sync summary; (2) service worker: offline app shell + sync engine runnable in the SW (Web Locks for one sync at a time across window/SW), Background Sync 'outbox', periodicsync, showNotification summary; (3) randomized multi-device sync tests (likely a separate CI job); (4) Playwright offline suite (PRD §19). Each slice through sync-reviewer.

Related: [[m1-progress]] [[work-style]] [[ask-interactively]]
