# ADR 0004: Default closing time

Date: 2026-11-09 · Status: accepted (resolves PRD §22 #2)

## Decision

The project owner adopted the PRD's proposed default: the clinic closes at **12:00 ET (18:00)**,
Monday to Saturday. Opening (3:00 ET / 09:00), lunch (6:00–7:00 ET / 12:00–13:00) and the
closed Sunday stay as in PRD §6.

## Consequences

- `DEFAULT_WEEKLY_HOURS` in `packages/time/src/clinicHours.ts` and the seeded `settings` row use 18:00.
- Close time stays a hard limit. The doctor changes it for one day through `day_rules`
  ("today I leave at 11:30") or for every week through the weekly defaults in Settings, so no
  code change is needed if the clinic's hours change.
