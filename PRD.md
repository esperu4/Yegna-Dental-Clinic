# Yegna Dental Clinic — Product Requirements Document (v1)

> **For Claude Code.** This PRD is the single source of truth for v1. Every decision in it is settled with the client unless it sits in §22 *Open items*. Build in milestone order (§20). A milestone is **done** only when every acceptance criterion under it passes and is demonstrated (test or recorded manual check). When something is ambiguous, check §21 and §22 first, then ask the human before inventing behaviour.

---

## 1. Context

**Clinic.** የኛ መካከለኛ የጥርስ ክሊኒክ (legal name; "medium" is the licensing category). Public brand: **Yegna Dental Clinic / የኛ የጥርስ ክሊኒክ**. Location: Yeka sub-city, near 6 Kilo (Addis Ababa University), Addis Ababa. Domain: `yegnadental.com.et`.

**People.** One doctor (owner, decision-maker). A small team (nurse, cashier, others) whose roles overlap.

**Problem.** Bookings live on a hand-drawn paper calendar with illegible names. The doctor answers most booking calls on her mobile and cannot check her schedule outside the clinic, so she promises to "call back later." Phones are mostly Android and **mobile data is usually switched off** to save money.

**Goal.** A scheduling tool that is *faster than paper*, works fully offline, and syncs silently whenever data comes on; plus Telegram bots for the team and patients, and a fast, modern, SEO-strong public website.

**Three deliverables, one repo:**
1. **Scheduling PWA**: the core. Used by the doctor and staff.
2. **Telegram bots**: *Yegna Team* (internal) and *Yegna Dental* (patients).
3. **Public website**: information only, no online booking.

---

## 2. Glossary (use these words in code, UI copy and commits)

| Term | Meaning |
|---|---|
| **Doctor** | The single user with full rights. |
| **Staff** | Any other user (nurse, cashier, …). Limited rights (§9). |
| **Booking** | One appointment for one patient at one start time. |
| **Provisional** | A booking (or any change) saved on a device but not yet accepted by the server. Shown with a dotted outline. |
| **Pending approval** | Booking accepted by the server, waiting for the doctor. Patients receive nothing yet. |
| **Approved** | Doctor approved it; patient messages are unlocked. |
| **Clash** | Two bookings overlapping in time. The first to reach the server wins; the other becomes a clash for its creator to fix. |
| **Outbox** | The on-device queue of changes waiting to sync. |
| **Sync** | One round trip: push outbox, pull changes since the device's cursor. |
| **Import** | A photo of a paper sheet, read by AI and reviewed by a human before any row becomes a booking. |
| **Template** | One of the three printable paper layouts (§11). |
| **ET time** | Ethiopian clock time (§6). |
| **Call list** | Patients the front desk must phone (no Telegram, or unapproved too close to the visit). |

---

## 3. Hard constraints

- **Cost.** Runs on Cloudflare's **free** plan. The only fixed cost is the domain (~550 Birr/yr). The only variable cost is the paid vision AI API for imports (a few USD/month). Design every feature to stay well inside free limits (§19).
- **No VPS, no always-on processes.** Everything is request-driven or cron-driven (Workers, webhooks).
- **Offline-first.** Every PWA action works with no connection. The server is the source of truth for ordering and clashes; the device is the source of truth for what the user sees right now.
- **Android first.** Background Sync must work on Android Chrome with the app closed. iPhone is supported but syncs only when opened.
- **Bilingual.** Amharic (default) and English, per user. Names may be typed in Ge'ez or Latin script.
- **Dual calendar.** Ethiopian and Gregorian display, per user. Storage is always UTC.
- **Telegram is never the only path.** Ethiopia has blocked Telegram before. The PWA must be fully usable with both bots down.
- **Minimal patient data.** Name, phone, short note, visit history. No medical records, images or payments.

---

## 4. Architecture and stack (fixed)

| Part | Tech |
|---|---|
| Language | TypeScript everywhere, `strict: true` |
| PWA | Preact + Vite, Dexie (IndexedDB), hand-written service worker (or Workbox) with Background Sync and Periodic Background Sync |
| API | Cloudflare Workers + Hono |
| Database | Cloudflare D1 via Drizzle ORM + Drizzle migrations |
| Bots | grammY on Workers, **webhooks only** |
| Website | Astro, static output, Cloudflare Pages |
| Scheduled jobs | One Workers cron trigger firing **hourly**, dispatching jobs by Addis Ababa local hour (keeps us under the free cron-trigger count) |
| Tests | Vitest (unit + integration with Miniflare/`wrangler` local D1), Playwright (PWA e2e incl. offline) |
| Package manager | pnpm workspaces |

**Repo layout**

```
/apps
  /pwa        Preact PWA (served from Cloudflare Pages at app.yegnadental.com.et)
  /api        Worker: REST + sync + bot webhooks + cron (api.yegnadental.com.et)
  /web        Astro public website (yegnadental.com.et)
/packages
  /shared     Types, zod schemas, sync protocol, permissions
  /time       Ethiopian calendar + ET clock + clinic-hours logic (pure, 100% tested)
  /db         Drizzle schema + migrations
  /ai         Vision provider interface + implementations (§12)
/scripts      backup restore, seed, admin
/docs         ADRs, runbooks (restore, revoke device, rotate keys)
```

Environments: `local`, `staging` (separate D1 + separate test bots), `production`.

---

## 5. Data model (D1)

All ids are **UUIDv7 generated on the client** (so offline creates never collide). Every syncable row has `version` (server-assigned, monotonic, from a single `sync_seq` counter), `updated_at`, `updated_by`, and `deleted_at` (soft delete / tombstone).

| Table | Key fields |
|---|---|
| `users` | id, name, role (`doctor`/`staff`), pin_hash, pin_salt, locale (`am`/`en`), calendar (`ethiopian`/`gregorian`), telegram_chat_id, disabled_at |
| `devices` | id, user_id, token_hash (SHA-256), label, last_seen_at, revoked_at |
| `patients` | id, name, phone_e164 (**unique, required**), note (≤280 chars), telegram_chat_id, telegram_linked_at |
| `procedures` | id, name_am, name_en, code (1–3 chars, unique), duration_min (multiple of 15), color, active, sort |
| `bookings` | id, patient_id, procedure_id (nullable), start_at (UTC), duration_min, status (§10), approved_by, approved_at, patient_confirmed_at, source (`app`/`import`), import_row_id, cancel_reason, clash_with_id, note |
| `day_rules` | date, open_at, close_at, lunch_start, lunch_end, closed (bool), note. Doctor-only. Absent date ⇒ weekly defaults. |
| `blocks` | id, start_at, end_at, reason. Doctor-only time blocks. |
| `holidays` | date, name_am, name_en, closed |
| `settings` | singleton: weekly defaults, default unspecified duration (60), reminder times, chosen default template |
| `patient_requests` | id, booking_id, patient_id, kind (`reschedule`/`cancel`), status (`open`/`handled`), handled_by |
| `imports` | id, telegram_file_id, uploaded_by, template, period_label, status (`queued`/`read`/`reviewed`/`failed`), provider, raw_result (JSON) |
| `import_rows` | id, import_id, time_text, name_text, phone_text, code_text, confidence, match (`existing`/`new`/`duplicate`/`unreadable`), decision (`accept`/`skip`), booking_id |
| `notification_log` | id, kind, target_chat_id, booking_id, sent_at, status. **Unique (kind, booking_id, target)** for idempotency. |
| `audit_log` | entity, entity_id, user_id, device_id, action, diff JSON, at |

**Visit history** is derived: a patient's bookings with status `done`, newest first.

**Phone normalisation** (`packages/shared`): accept `09…`, `07…`, `+2519…`, `2519…`, spaces and dashes; store E.164 (`+2519XXXXXXXX`, `+2517XXXXXXXX`); landlines (`011…`) allowed. Invalid ⇒ inline error, never a silent save.

---

## 6. Time and calendar rules (`packages/time`)

**Storage.** All instants in UTC. Clinic timezone `Africa/Addis_Ababa` (UTC+3, no DST).

**ET clock.** ET hour = local hour − 6 (12-hour cycle). Clinic examples:

| Local (Gregorian) | ET display |
|---|---|
| 09:00 | 3:00 ጠዋት |
| 12:00 | 6:00 ቀትር |
| 13:00 | 7:00 ከሰዓት |
| 18:00 | 12:00 ማታ |

Period labels (ጠዋት / ቀትር / ከሰዓት / ማታ / ሌሊት) live in one mapping table in this package. The exact boundaries are confirmed with the clinic (§22).

**Ethiopian calendar.** Implement conversion via Julian Day Number in a pure module (no network, no heavy dependency). Required test fixtures:
- 11 Sep 2026 GC = Meskerem 1, 2019 EC
- 9 Nov 2026 GC = Tikimt 30, 2019 EC
- 12 Sep 2027 GC = Meskerem 1, 2020 EC (2019 EC is a leap year, so Pagume has 6 days)
- Round-trip GC→EC→GC for every day 2020–2035.

**Display preference** is per user (`calendar`, `locale`). Paper templates always print **Ethiopian date and ET time only**, with no Gregorian time.

**Clinic hours (defaults, editable by the doctor):**
- Open Monday–Saturday, closed Sunday.
- Open 3:00 ET (09:00). Close 12:00 ET (18:00), editable per day via `day_rules` ("today I leave at 11:30").
- Lunch 6:00–7:00 ET (12:00–13:00). Lunch is **soft**: staff may book into it after a warning ("This is lunch time. Book anyway?").
- Close time and blocks are **hard**: nothing can be booked after close or inside a block. This applies to imports too; they surface as errors to fix.
- Holidays: a `holidays` table, seeded with fixed-date Ethiopian public holidays. Movable holidays (Fasika, Siklet, Eid al-Fitr, Eid al-Adha, Mawlid) are entered yearly by the doctor in Settings; the app shows a reminder in Meskerem (September) to add them. Holidays default to closed.

**Booking grid.** 15-minute steps internally. Duration = procedure default, or 60 min if unspecified.

---

## 7. Offline sync (the most important section)

### 7.1 Device storage
Dexie holds a full working copy: all patients, procedures, settings, day_rules, blocks, holidays, users (names and roles only), and bookings from **today − 30 days to today + 120 days**. Older bookings load on demand when online (patient history screen).

### 7.2 Writes
Every user action:
1. Writes the change to Dexie immediately; the UI updates instantly.
2. Appends an operation to the **outbox**: `{opId (uuidv7), entity, entityId, kind: create|update|delete, fields, baseVersion, at, userId}`.
3. Registers Background Sync (`registration.sync.register('outbox')`).

The UI marks affected bookings **provisional** until the server accepts them.

### 7.3 When sync runs
- Service worker `sync` event (Android, also with the app closed).
- `periodicsync` every ~12 h where the browser grants it (best effort).
- The `online` event, app open, `visibilitychange` to visible, and a manual pull-to-refresh.
- While the app is open and online: every 30 s (cheap: one request returning an empty delta when nothing changed).

### 7.4 Protocol: `POST /sync`
Request: `{ deviceId, cursor, ops[] }` (ops in creation order, max 200 per call; loop if more).
Server, inside one D1 transaction (batch):
1. Apply each op in order. Ops are **idempotent by opId** (a re-sent op returns its original result).
2. **Bookings:** on create, or on any change to `start_at`, `duration_min` or `status → active`, run the **clash check** against active bookings (`pending_approval`, `approved`, `arrived`). On overlap:
   - the op is still stored, with the booking set to `status = clash` and `clash_with_id` pointing at the winner;
   - the result is `{opId, outcome: 'clash', winner}`;
   - a team-bot alert goes to the creator (and to the doctor).
3. **Other entities:** last-writer-wins by server receipt order. If `baseVersion` is older than the current row, record the overwritten values in `audit_log` (nothing is ever silently lost).
4. Assign a new `version` from `sync_seq` to every touched row.

Response: `{ results[], changes[] (all rows with version > cursor), newCursor }`.

Client: drop accepted ops from the outbox, apply `changes` to Dexie, clear the provisional marks, and surface clashes.

### 7.5 Clash UX
A clash booking stays visible to its creator in red, with a banner: *"Clash: Abebe and Tigist both at Thursday 10:00 (4:00 ET). Tap to move."* Tapping opens the booking sheet pre-filtered to free slots that day. The patient receives nothing until the clash is resolved and the doctor approves.

### 7.6 Sync status pill (always visible in the header)
- 🟢 **Synced** (shows the time of the last sync on tap)
- 🟡 **N changes waiting**
- 🔴 **Offline since 09:40**
- ⚠️ **Sync problem: tap** (auth error, server error; tap shows the reason and a retry button)

### 7.7 Sync notification
After a sync in which something happened, show a local notification (via `registration.showNotification`, permission requested during onboarding):
> *Synced: 3 bookings sent · 2 new from Hana · 1 clash to fix*

No notification when nothing changed. Tapping it opens the relevant screen (clash, approvals or today).

### 7.8 Data budget
A typical sync must be **< 20 KB** over the wire. Use JSON with short keys, gzip from the Worker, and no full-table pulls after the first install.

### 7.9 Device revocation
If `/sync` returns `401 revoked`: the device wipes Dexie and the outbox and returns to enrolment. Unsynced changes are lost (accepted trade-off); show a clear message.

### 7.10 Required tests
Simulated multi-device integration tests (≥ 3 clients, random offline/online interleavings, ≥ 1,000 randomized runs) asserting:
- zero lost ops;
- exactly one winner per overlap;
- idempotent re-sends;
- convergence: all devices hold identical data after a final sync.

---

## 8. PWA screens and behaviour

**Performance targets (mid-range Android, cold start):** interactive in **< 1.5 s** from the home-screen icon, offline included. The booking sheet opens in < 100 ms. The JS bundle is < 150 KB gzipped for the initial route.

1. **Enrolment / login.** First use on a device: the doctor creates the first account (name + 4–6 digit PIN), and staff accounts are created by the doctor. A new device enrols with name + PIN while online and receives a device token. After **24 h of inactivity** the app locks and asks for the PIN, which is verified locally (works offline). Five wrong PINs ⇒ 5-minute lockout.
2. **First-run doctor setup** (wizard, skippable later): language and calendar → clinic hours check → add procedures (name in Amharic/English, code, duration) → link Telegram → enable notifications.
3. **Today** (home). A vertical timeline from open to close with the lunch band shaded, blocks hatched, and bookings as cards (patient name, procedure code, status chip). Above the timeline: a waiting/walk-in strip and counters (booked · arrived · done). A large **+** button opens the booking sheet at the next free slot. Tapping an empty slot opens the booking sheet at that time.
4. **Week.** Monday–Saturday columns, compact. Tap a day to open it. Free capacity is visible at a glance.
5. **Booking sheet** (bottom sheet, the critical path; goal ≤ 3 taps + typing):
   - The phone field has focus by default. After 4 digits it suggests matching patients (searching local Dexie). Picking one fills the name.
   - No match ⇒ type the name (Ge'ez or Latin). Search also matches names.
   - Procedure chips (optional). Duration follows the procedure and can be adjusted ±15 min.
   - Note (optional). **Save.**
   - Inline warnings for lunch, hard errors for after-close or blocked time, and live clash warnings against local data.
6. **Booking card actions:** Arrived · Done · No-show · Reschedule · Cancel (requires a reason) · Call (tel: link) · Book next visit (prefills the patient). The doctor also sees **Approve**.
7. **Approvals** (doctor). A list of pending bookings grouped by day, with **Approve all for this day** and per-item approve/reject (reject = cancel with reason).
8. **Call list** (staff + doctor). Tomorrow's patients without Telegram (📵), unapproved bookings within 24 h, and open patient requests (reschedule/cancel). Each row: Call · Mark handled.
9. **Patients.** Search, profile (name, phone, note, upcoming visits, visit history), edit. Delete is doctor-only.
10. **Imports.** A list of uploaded sheets. The review screen shows the photo (zoomable) beside the extracted rows. Each row is editable and tagged *existing patient / new patient / duplicate (reason) / unreadable*. Action: **Confirm rows** creates bookings (`source = import`, normal approval rules). Staff can also upload a photo here directly (camera), as well as via the bot.
11. **Print.** Pick template (§11) and period → a print-ready A4 landscape page → Android print / Save as PDF. Works offline.
12. **Settings.**
    - Everyone: language, calendar, notifications, Telegram link, sign out.
    - Doctor only: procedures, weekly hours, day rules, blocks, holidays, users, devices (revoke), default template, AI provider status.

**Design.** Light green + white (shared tokens with the website, §15). Large tap targets (≥ 48 px). Amharic typography via self-hosted Noto Sans Ethiopic (subset). The app stays usable one-handed on a 5.5" screen.

---

## 9. Permissions

| Action | Doctor | Staff |
|---|:-:|:-:|
| Create / edit / reschedule bookings | ✅ | ✅ |
| Mark arrived / done / no-show | ✅ | ✅ |
| Cancel booking (reason required) | ✅ | ✅ |
| Approve / reject bookings | ✅ | — |
| Create / edit patients | ✅ | ✅ |
| Delete patients | ✅ | — |
| Upload & review imports | ✅ | ✅ |
| Print templates | ✅ | ✅ |
| Procedures, hours, day rules, blocks, holidays | ✅ | — |
| Users, devices, revoke | ✅ | — |
| Settings: default template, reminder times | ✅ | — |

Permissions are enforced **on the server** (in `/sync` op validation) and mirrored in the UI. A forbidden op is rejected with a reason shown to the user.

---

## 10. Booking lifecycle

```
(created on device) → provisional ──sync──▶ pending_approval ──doctor──▶ approved ──▶ arrived ──▶ done
                                  └─overlap─▶ clash ──fixed──▶ pending_approval
pending_approval / approved ──▶ cancelled (reason)        approved ──▶ no_show
```

Rules:
- Bookings **created by the doctor** are approved automatically.
- Changing the date or time of an approved booking returns it to `pending_approval` (unless done by the doctor), and the patient is told nothing until it is re-approved. Changes to notes or procedure do not reset approval.
- `approved` unlocks patient messages (§14). Cancelling an approved booking notifies a linked patient.
- At **24 h before start**, any booking still `pending_approval` goes on the call list and triggers a team-bot alert.
- `no_show` can be set from 20 min after the start time; the slot then becomes free for walk-ins.

---

## 11. Paper templates

All three templates are generated by the PWA (HTML + print CSS, A4 **landscape**), offline-capable. Common rules:
- **Hourly rows** from 3:00 to 12:00 ET (from current settings).
- **Ethiopian date and ET time only.**
- Lunch row shaded.
- A procedure code legend at the bottom, generated from the doctor's procedures. Printing is disabled until at least one procedure exists.
- A large human-readable **sheet ID** (e.g. `YD-F-2019-T03W2` = template F, period) plus a QR code encoding the same ID. The AI reads the text ID, and the client may decode the QR if available (BarcodeDetector).
- High-contrast thin lines, no colour required (prints well on cheap B/W printers).

| Template | Code | Priority | Layout |
|---|---|---|---|
| **Familiar** | F | Zero retraining. Looks like today's paper. | 1 page per week. Monday–Saturday columns × hourly rows. Each hour cell has 3 entry lines: minute box (`:__`), name line, 10 phone digit boxes, code box. |
| **Clear** | C | Best readability and import accuracy. | 2 pages per week (Mon–Wed, Thu–Sat). Same structure with cells twice as large. |
| **Overview** | O | Lowest print cost, month at a glance. | 1 page per month. Calendar grid (Monday–Saturday × weeks). Each day cell has 6 numbered lines: hour + name only. No phone. |

The doctor picks the default in Settings, and any template can be printed at any time. Pilot plan: weeks 1–3 use F, C and O in turn (§20 M8).

---

## 12. Photo import pipeline

**Flow:**
1. A user sends a photo to **Yegna Team** (or uploads in PWA → Imports).
2. The Worker stores the Telegram `file_id` only. No image storage on our side: the review screen streams the image through an authenticated Worker endpoint that calls Telegram `getFile`.
3. The bot replies immediately: *"Got it, reading…"* Processing runs via `ctx.waitUntil`. If the AI call exceeds platform limits, the import stays `queued` and is processed when anyone opens the Imports screen (the client calls `POST /imports/:id/process`).
4. The AI returns structured rows. The bot then replies: *"9 entries read, 1 unreadable. Review in app →"* (deep link).
5. Matching (server):
   - Phone present ⇒ match patient by phone.
   - Duplicate if a booking exists for the same patient on the same date within **±30 min** ⇒ `duplicate`, default `skip`.
   - Overview template (no phone) ⇒ match by name similarity + date + hour; always flagged *needs check*.
6. A human confirms rows in the PWA. Confirmed rows become bookings through the normal sync path, so clash rules, hours rules and approval rules all apply.
7. **Skipped duplicates are reported to the doctor** via the team bot with the reason, e.g. *"Skipped Abebe K. Thu 4:00 ET: already booked in app at 4:00 ET by Hana."*

**Provider interface (`packages/ai`)**, so providers are swappable and future ideas plug in here:

```ts
interface ScheduleReader {
  id: string;                       // 'anthropic' | 'gemini' | …
  read(input: {
    image: ArrayBuffer; mime: string;
    template: 'F' | 'C' | 'O' | 'unknown';
    procedures: { code: string; name: string }[];
    locale: 'am' | 'en';
  }): Promise<{
    sheetId?: string;
    rows: { day?: string; time?: string; name?: string; phone?: string; code?: string; confidence: number }[];
  }>;
}
```

- The default implementation is a paid vision API (provider chosen at launch, §22). The key is stored as a Worker secret.
- The prompt is versioned in the repo and asks for JSON only, preserving names exactly as written (Ge'ez or Latin) and returning `null` for unreadable fields rather than guesses.
- Keep a golden set of ≥ 10 photographed sample sheets (all three templates, mixed scripts) with expected output. Report a per-field accuracy score in CI on demand (`pnpm eval:imports`).

---

## 13. Team bot: *Yegna Team* (internal)

**Access.** Only users linked from the PWA (Settings → Link Telegram creates a one-time code → `t.me/<YegnaTeamBot>?start=<code>`, valid 10 minutes). Unknown chats get a polite refusal and nothing else.

| Message | Recipient | When |
|---|---|---|
| Tomorrow's summary (count, first patient, list with ET times, button "Open day") | Doctor | 19:00 daily (Mon–Sat schedule) |
| Approval digest ("5 bookings waiting", **Approve all** + per-item buttons) | Doctor | Hourly 07:00–21:00, only if new pending items exist |
| Unapproved within 24 h / call-list items | Doctor + staff | Hourly check; each booking alerted once |
| Clash created | Creator + doctor | On sync |
| Import read / failed | Uploader | On processing |
| Skipped duplicates with reason | Doctor | On import confirmation |
| Patient reschedule / cancel request | Staff + doctor | On request |
| Weekly spreadsheet export (§17) | Doctor | Sunday 21:00 |
| Backup failure | Doctor | On failure |

**Commands:** `/today`, `/tomorrow` (read-only text schedule, for when the PWA isn't at hand). Photo messages ⇒ import (§12).

Approving from the bot writes through the same server logic as the PWA.

---

## 14. Patient bot: *Yegna Dental*

**Purpose:** information plus appointment confirmations. **No booking requests**: bookings happen only by phone.

- `/start` ⇒ language choice (አማርኛ / English) ⇒ main menu.
- **Menu:**
  - 📍 Location (sendLocation + address text)
  - 🕘 Hours (ET, Ethiopian calendar)
  - 📞 Call the clinic (tel: button)
  - 🦷 Services (text from the website content)
  - 📅 My appointment
- **Linking:** "My appointment" asks the patient to share their contact (Telegram `request_contact`). **Accept only if `contact.user_id === from.id`.** Match the normalised phone to `patients.phone_e164`. If matched, store `telegram_chat_id`. If not found: *"We couldn't find your booking. Please call the clinic."*
- **Messages to linked patients** (only for `approved` bookings, idempotent via `notification_log`):
  - **Confirmation** when the doctor approves: date (Ethiopian), ET time, procedure (public name), address, call button.
  - **Reminder** at 18:00 the day before, with buttons ✅ Confirm · 🔁 Need to reschedule · ❌ Cancel.
    - Confirm sets `patient_confirmed_at`.
    - The other two create a `patient_request` and alert the team, then reply *"The clinic will call you."*
  - **Cancellation notice** if an approved booking is cancelled by the clinic.
- Patients never see other patients, free slots, or internal notes.
- Patients without Telegram are flagged 📵 in the PWA and appear on the 18:00 call list.

---

## 15. Public website (`apps/web`)

**Goal.** Rank for local dental searches around 6 Kilo, load fast on weak 3G, and look distinctly modern. **Information only, no booking form.**

**Pages** (each in Amharic at `/` and English at `/en/`): Home · Services · About the doctor · Contact · FAQ. Content lives in `src/content/{am,en}/*.md`. Services copy is written separately from the app's procedure list (§22). **No prices anywhere** (medical prices follow consultation).

**Calls to action** on every page: tap-to-call the clinic number (sticky on mobile), and a link to the Yegna Dental Telegram bot. The doctor's personal number is shown only if she approves (§22).

**Design direction: "clinical futurism", light.**
- White space and light-green glass panels (`backdrop-filter` with a solid fallback), soft glows, precise hairline geometry, subtle CSS motion (respects `prefers-reduced-motion`).
- Dental essence through **inline SVG line motifs** (tooth outline, enamel curves). No raster images, no stock photos, no WebGL or 3D.
- The logo is a swappable placeholder wordmark until the brand kit exists.
- Text colours must meet **WCAG AA**: use a deep green for text, and keep the light green for surfaces and accents.
- Shared design tokens with the PWA live in `packages/shared/tokens.css`.

**Performance budget (hard):**
- 0 KB JS by default. Any island ≤ 15 KB gzipped.
- Total transfer per page ≤ 150 KB including fonts (subset Noto Sans Ethiopic + one Latin face, `font-display: swap`, self-hosted).
- LCP < 2.0 s on Lighthouse "Slow 4G" and usable on simulated 3G.
- Lighthouse mobile ≥ 90 in Performance, Accessibility, Best Practices and SEO, measured in CI on every page.

**SEO:**
- Per-page titles and descriptions targeting: "dental clinic 6 kilo", "dentist Addis Ababa", "dentist near Addis Ababa University", "ጥርስ ክሊኒክ 6 ኪሎ", "የጥርስ ሐኪም አዲስ አበባ".
- `hreflang` am/en + `x-default`, canonical URLs, `sitemap.xml`, `robots.txt`.
- JSON-LD: `Dentist` (name, legal name, address, geo, telephone, `openingHoursSpecification` Mo–Sa 09:00–18:00, `sameAs` Telegram), plus `FAQPage` on the FAQ page.
- NAP (name, address, phone) text is **identical** to the Google Business Profile.
- No embedded map iframe: use an "Open in Google Maps" link and address text.

---

## 16. Scheduled jobs (single hourly cron, dispatched by Addis Ababa local time)

| Local time | Job |
|---|---|
| Every hour | Unapproved-within-24 h check; approval digest (07–21 only); retry failed notifications |
| 02:00 | Nightly backup (§17) |
| 18:00 | Patient reminders for tomorrow; call list to the team |
| 19:00 | Doctor's tomorrow summary |
| Sunday 21:00 | Weekly spreadsheet (CSV) export to the doctor |
| 15 Meskerem, yearly | Reminder to the doctor to add movable holidays |

All jobs are idempotent (safe to run twice) and log to `notification_log` / `audit_log`.

---

## 17. Backups and restore

1. **Cloudflare D1 Time Travel**: built-in point-in-time restore (7 days on the free plan).
2. **Nightly off-site backup** to **Google Drive of the clinic-owned account**:
   - The Worker exports every table to gzip'd JSON, encrypted with AES-GCM using a key held as a Worker secret (the doctor keeps a printed copy of the key).
   - It uploads through the Drive API using an OAuth refresh token for the clinic account (scope `drive.file`).
   - Retention: the last 30 nightly backups plus the 1st-of-month backups kept indefinitely.
   - If an export risks the per-request CPU limit, split it per table across consecutive invocations.
3. **Weekly CSV** (patients + the last 8 weeks and next 8 weeks of bookings) sent to the doctor on Telegram.

**Restore:** `pnpm restore --from <drive-file|local-file> --to <staging|production>` decrypts, validates against the schema, and loads. Write the runbook in `docs/runbooks/restore.md`.

**Acceptance:** a full restore into staging is performed and verified (row counts + spot checks) before launch, then repeated quarterly.

---

## 18. Security and privacy

- HTTPS only. The API accepts only the PWA origin (CORS). Every request carries the device token (`Authorization: Bearer`); tokens are stored hashed (SHA-256).
- PINs are salted and hashed. PIN attempts are rate-limited on the server and lock out locally.
- The Telegram webhooks verify `X-Telegram-Bot-Api-Secret-Token`. Each bot has its own secret.
- No patient data in URLs, logs or analytics. No third-party analytics in the PWA. The website may use privacy-friendly Cloudflare Web Analytics only.
- `audit_log` records every booking or patient change with user and device.
- All secrets live in Wrangler secrets; `.dev.vars` is git-ignored. Write a key-rotation runbook in `docs/runbooks/`.
- All accounts (Cloudflare, Google, both bots via BotFather, AI provider, domain) are owned by the clinic email account; developers receive delegated access.

---

## 19. Non-functional requirements and free-tier budget

| Resource | Free limit (verify current values at build time) | Expected usage |
|---|---|---|
| Workers requests | 100,000 / day | < 5,000 / day |
| D1 rows read | 5,000,000 / day | < 200,000 / day (indexes required) |
| D1 rows written | 100,000 / day | < 2,000 / day |
| D1 size | 500 MB per DB | < 50 MB over years |
| Workers CPU per request | low (design for ≤ 10 ms) | Hashing and exports must be measured |

- Since 1 Sep 2026, D1 queries **fail** when the free daily limits are exceeded. Add a daily usage check that alerts the doctor at 50% of any limit.
- Every query has an index; `EXPLAIN QUERY PLAN` shows no full-table SCAN on hot paths (sync pull, day view, patient search).
- The PWA works completely offline after the first enrolment. Verify this with a Playwright offline suite.
- Accessibility: WCAG AA on the website, and readable contrast in sunlight on the PWA.

---

## 20. Milestones and acceptance criteria

Build in this order. Each milestone ships to staging and is demoed before the next starts.

### M0: Foundations
- [ ] Monorepo, CI (lint, typecheck, test), staging deploys of `pwa`, `api`, `web`.
- [ ] `packages/time` complete. All fixtures in §6 pass; the round-trip test passes for 2020–2035.
- [ ] Drizzle schema + migrations for §5; seed script for a demo clinic.

### M1: PWA core (online)
- [ ] Enrolment, PIN, 24 h lock, doctor and staff accounts, device list and revoke.
- [ ] Doctor setup wizard; procedures CRUD.
- [ ] Today and Week views; booking sheet; all card actions; hours, lunch warning, close and block hard errors, holidays.
- [ ] Amharic/English and Ethiopian/Gregorian toggles on every screen.
- [ ] **A test user books a returning patient by phone number in ≤ 3 taps and < 30 s** (recorded e2e test with timing).

### M2: Offline and sync
- [ ] Dexie working copy, outbox, `/sync` protocol, service worker with Background Sync and periodic sync.
- [ ] Status pill (all 4 states) and sync notifications.
- [ ] Clash handling end to end.
- [ ] §7.10 randomized multi-device tests green (≥ 1,000 runs, zero lost ops).
- [ ] Manual check on a real Android phone: book 3 patients in airplane mode, kill the app, turn data on, and the sync notification appears without opening the app.
- [ ] Revoke wipes the device.

### M3: Approval workflow and team bot
- [ ] Booking lifecycle (§10) enforced on the server, including auto-approve for the doctor and the re-approval rule.
- [ ] Telegram linking; all §13 messages and commands; approve from the bot.
- [ ] Hourly cron dispatcher with idempotent jobs (running a job twice sends nothing twice).
- [ ] Call list screen.

### M4: Paper templates and imports
- [ ] All 3 templates print correctly on A4 landscape (PDF checked on Android print).
- [ ] Import via bot and via PWA; review screen; matching; duplicate skip with the doctor notified.
- [ ] `ScheduleReader` interface with one paid provider implemented and a second stub provider.
- [ ] Golden-set eval: **average < 3 corrections per page** on templates F and C.

### M5: Patient bot
- [ ] Menu, contact linking with the `user_id` check, confirmations, 18:00 reminders, request buttons → call list.
- [ ] Nothing is ever sent for a non-approved booking (tested).

### M6: Backups
- [ ] Nightly encrypted backup to Drive with retention; weekly CSV; backup-failure alert.
- [ ] A restore into staging has been performed and documented.

### M7: Website
- [ ] All pages in both languages, with structured data and sitemap.
- [ ] Lighthouse mobile ≥ 90 in all four categories on every page (CI gate); per-page budget ≤ 150 KB.
- [ ] Visual design approved by the client.

### M8: Pilot (2 weeks, with paper in parallel)
- [ ] Weeks 1–3 rotate the templates F, C, O; the doctor picks a default.
- [ ] **Success criteria:** the doctor books phone callers from the app in < 30 s; zero bookings lost in sync; < 3 import corrections per page on average; the app is used for ≥ 50% of bookings by the end of week 2.

---

## 21. Decisions made in this PRD (not explicitly discussed; flag any you disagree with)

1. Bookings created by the doctor are approved automatically.
2. Changing the date or time of an approved booking (by staff) sends it back for approval. Note or procedure changes don't.
3. The device keeps bookings from −30 to +120 days locally; older history loads online only.
4. Photos are not stored by us: we keep only the Telegram `file_id`.
5. No-show can be marked from 20 min after the start time.
6. Unspecified procedure = 60 min.
7. Movable holidays are entered yearly by the doctor, with a reminder.
8. A daily free-tier usage alert fires at 50% of any limit.
9. The website has a light theme only; the PWA follows the system light/dark setting.

---

## 22. Open items (need the human or the clinic before or during the build)

| # | Item | Needed by |
|---|---|---|
| 1 | Exact ET period labels and their boundaries (ጠዋት / ቀትር / ከሰዓት / ማታ) | M1 |
| 2 | Default closing time confirmed (proposed 12:00 ET / 18:00) | M1 |
| 3 | AI provider choice (Claude or Gemini) and who holds the payment card | M4 |
| 4 | Clinic phone number(s); whether the doctor's number is public | M5 / M7 |
| 5 | Services list and marketing copy (Amharic + English), doctor bio, FAQ answers | M7 |
| 6 | Exact street address and map coordinates | M7 |
| 7 | **Domain DNS:** confirm Ethio Telecom lets `.com.et` use Cloudflare nameservers. If not, use CNAME records on subdomains plus an apex redirect, or reconsider the domain. | M0 |
| 8 | Bot usernames (`@…` for Yegna Dental and Yegna Team) | M3 |
| 9 | Clinic-owned Google account for Drive backups | M6 |

---

## 23. Out of scope for v1 (planned or possible v2)

Reports dashboard (bookings per week, no-shows, new vs returning) · SMS reminders · online booking · payments and billing · medical records and X-rays · multiple doctors or chairs · a Play Store wrapper (TWA), considered only if background sync proves unreliable · the brand kit (a separate design project).

---

## 24. Launch checklist (clinic tasks, not development)

- [ ] Create the clinic-owned email account. It owns all services.
- [ ] Register `yegnadental.com.et` (Ethio Telecom, ~550 Birr/yr).
- [ ] Create both bots via BotFather from the doctor's Telegram.
- [ ] Set up the AI provider account and card.
- [ ] Create and verify the **Google Business Profile** (it may require a verification video at the location). Add 5–10 real photos, matching NAP and hours.
- [ ] Doctor enters her procedures and staff accounts.
- [ ] Install the PWA on every phone; enable notifications; link Telegram.
- [ ] Print the first week's template.
