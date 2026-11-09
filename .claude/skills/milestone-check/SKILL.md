---
name: milestone-check
description: Verify a PRD milestone (M0–M8) against its acceptance criteria. Maps each checkbox to evidence, runs the suites, and reports what is still missing.
disable-model-invocation: true
argument-hint: M0..M8
---

# Milestone check: $ARGUMENTS

A milestone counts as **done** only when every acceptance criterion passes and has been shown working, either by a test or by a recorded manual check (PRD §20).

## Steps

1. **Read the criteria.** Open `PRD.md` §20 and copy every checkbox under milestone `$ARGUMENTS`. If no milestone was given, ask which one. Also read the PRD sections the criteria point to (for example §6 fixtures and §7.10 tests).

2. **Find evidence for each criterion.** Search the repo for:
   - automated tests that cover it (Vitest, Playwright), and
   - a recorded manual check in `docs/milestones/$ARGUMENTS.md` (date, who checked, device, result).

   A criterion with no evidence is **not met**, even if the code looks finished.

3. **Run the checks.** Run lint, typecheck, and the relevant test suites using the commands in `CLAUDE.md`. For thresholds the PRD names, check the actual numbers: ≥ 1,000 randomized sync runs, the 2020–2035 round-trip, < 30 s booking timing, Lighthouse ≥ 90, ≤ 150 KB per page, < 3 corrections per page. Don't stop at "tests pass".

4. **Report** as a table:

   | Criterion | Status (✅ met / ⚠️ partial / ❌ missing) | Evidence (test file:line, doc, or command output) | What's left |

   Then list:
   - manual checks the human still has to perform and record (for example the real Android airplane-mode test, or Android print);
   - open items from PRD §22 that block this milestone.

5. **Don't tick boxes in `PRD.md`** and don't call the milestone done yourself. The human decides after the staging demo.
