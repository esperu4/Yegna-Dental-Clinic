# ADR 0002: D1 storage conventions

Date: 2026-11-09 · Status: accepted

| Kind              | Stored as                                                       | Example                 |
| ----------------- | --------------------------------------------------------------- | ----------------------- |
| ids               | UUIDv7 text, generated on the client (`@yegna/shared` `uuidv7`) | `019a6f…`               |
| instants (`*_at`) | INTEGER epoch milliseconds, UTC                                 | `start_at`              |
| calendar dates    | TEXT `YYYY-MM-DD`, clinic-local Gregorian                       | `day_rules.date`        |
| times of day      | INTEGER minutes since local midnight                            | `open_at = 540` (09:00) |
| booleans          | INTEGER 0/1                                                     | `closed`                |

Why integers for instants: compact on the wire (PRD §7.8 budget), cheap range scans, and no timezone
parsing. All conversion lives in `@yegna/time` (Addis Ababa is fixed UTC+3).

Sync tables not listed in PRD §5 but required by §7.4:

- `sync_seq`: single row (`id = 1`) holding the last version handed out. The API creates it on first
  use with an upsert, so no data migration is needed.
- `sync_ops`: one row per applied op (`op_id` primary key) with its stored result, so a re-sent op
  returns the original result.

`notification_log.booking_id` is `''` (not NULL) for messages not tied to a booking, so the unique
(kind, booking_id, target) key still deduplicates them; such kinds should embed the date
(e.g. `digest:2026-11-09`).

Precedence when resolving a day's hours: `day_rules` entry, then holiday, then weekly default
(`resolveDay` in `@yegna/time`).
