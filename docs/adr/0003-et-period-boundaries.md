# ADR 0003: ET period boundaries

Date: 2026-11-09 · Status: accepted (resolves PRD §22 #1)

## Context

PRD §6 needs one mapping table from local time to the ET period labels shown next to ET time.
The exact boundaries were open item §22 #1. The provisional table built in M0 fits every PRD §6
example (09:00 → 3:00 ጠዋት, 12:00 → 6:00 ቀትር, 13:00 → 7:00 ከሰዓት, 18:00 → 12:00 ማታ).

## Decision

The project owner chose to keep the provisional boundaries for v1:

| Local time    | Label | English   |
| ------------- | ----- | --------- |
| 00:00 – 06:00 | ሌሊት   | night     |
| 06:00 – 12:00 | ጠዋት   | morning   |
| 12:00 – 13:00 | ቀትር   | midday    |
| 13:00 – 18:00 | ከሰዓት  | afternoon |
| 18:00 – 24:00 | ማታ    | evening   |

## Consequences

- The table lives only in `packages/time/src/etClock.ts` (`ET_PERIODS`). If the clinic wants
  different boundaries during the pilot, that one table changes and the tests show the effect.
- Period labels are display only. Storage is UTC, so changing boundaries never touches data.
