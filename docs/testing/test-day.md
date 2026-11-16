# Test day: checking the whole product on staging

Work top to bottom; tick each box, and note anything odd in the **Findings** table at the end, with the step number. You need two Android phones (Doctor and Staff) and your own Telegram.

**Addresses (staging):**

- App: <https://yegna-pwa-staging.yegna-api.workers.dev>
- API health: <https://yegna-api-staging.yegna-api.workers.dev/health>
- Website: <https://yegna-web-staging.yegna-api.workers.dev>

**Setup before you start (once):**

- [ ] The Team test bot works already (M3). Create the **patient** test bot and store its secrets: `docs/runbooks/patient-bot.md` steps 1–3.
- [ ] Backups: backup key, Google project and `pnpm google-auth --env staging` (`docs/runbooks/backups.md`). This can wait until section 9.

## 1. Accounts and phones (M1)

- [ ] 1.1 The Doctor phone opens the app, signs in with the Doctor PIN, and Today shows.
- [ ] 1.2 Settings → Staff accounts: add a Staff user. On the second phone, "Sign in on this phone" with that name and PIN.
- [ ] 1.3 Leave a phone for 24 h (or test the lock with a wrong PIN 5 times): it locks, and the PIN unlocks it even in airplane mode.
- [ ] 1.4 Settings → Phones: revoke the Staff phone. Within a minute it is signed out and its data is wiped.

## 2. Booking (M1)

- [ ] 2.1 Book a new patient (phone + name). As the Doctor it shows "✓ Approved"; as Staff it shows "Waiting for approval".
- [ ] 2.2 Book the same patient again by typing 4 digits of the phone and tapping the suggestion: 3 taps, under 30 s.
- [ ] 2.3 Lunch time shows a warning; after closing time and in a blocked time it refuses.
- [ ] 2.4 Card actions: Arrived (appears in the waiting strip), Done, No-show (only from 20 min after start), Reschedule, Cancel (asks for a reason), Call, Book next visit.
- [ ] 2.5 The language (EN/አማ) and calendar (ET/GC) switches in the header change every screen.
- [ ] 2.6 Week view: tap a day to open it.

## 3. Offline and sync (M2)

- [ ] 3.1 Airplane mode: the pill says "Offline since …". Book 3 patients; they show "Not sent yet".
- [ ] 3.2 Close the app completely. Turn data back on. The sync notification appears **without opening the app** (it can take a few minutes).
- [ ] 3.3 Two phones offline book the same time. When both are online, one wins; the other shows the clash in red and is told to move it.

## 4. Approvals and team bot (M3)

- [ ] 4.1 Staff book; the Doctor's Telegram receives the approval digest (hourly, 07:00–21:00). **Approve** from Telegram, and the app shows Approved.
- [ ] 4.2 `/today` and `/tomorrow` in the team bot list the bookings.
- [ ] 4.3 At 19:00 the Doctor gets tomorrow's summary. At 18:00 the team gets the call list.
- [ ] 4.4 Call list screen: Call opens the phone dialler; Confirmed, No answer and Mark handled each remove or update the row.

## 5. Paper sheets and imports (M4)

- [ ] 5.1 Print sheets: each template (F, C, O) → Print → Save as PDF on Android. One A4 landscape page per sheet, nothing cut off.
- [ ] 5.2 Write a few bookings by hand on a printed sheet, take a photo, and send it to the team bot. The bot replies "Got it, reading…", then reports.
- [ ] 5.3 App → Sheet photos → open it. The rows are there (fix any misread ones), then Confirm. The bookings appear. Duplicates are skipped and the Doctor is told.
- [ ] 5.4 Upload a photo from the app (camera) as well.

## 6. Patients screen

- [ ] 6.1 Patients: search by part of a name, and by 4 digits of a phone.
- [ ] 6.2 A profile shows upcoming visits and visit history (bookings marked Done).
- [ ] 6.3 Edit the phone and note. A wrong phone is refused. The Doctor can delete; Staff cannot.

## 7. Patient bot (M5)

- [ ] 7.1 Open the patient test bot and send `/start`: choose a language, and the menu appears. Try Location, Hours, Call, Services.
- [ ] 7.2 In the app (as Staff), book yourself with your own phone number. In the bot, My appointment → share contact: "connected", with no confirmed appointment yet.
- [ ] 7.3 The Doctor approves it: the ✅ confirmation arrives within a minute.
- [ ] 7.4 Book one for tomorrow: at 18:00 the reminder arrives. Confirm sets ✓ in the app. Reschedule or Cancel replies "The clinic will call you", the team gets an alert, and the request shows on the Call list.
- [ ] 7.5 The Doctor cancels an approved booking: the ❌ notice arrives. Moving a booking as Staff sends nothing until it is approved again.

## 8. Settings

- [ ] 8.1 Message times (Doctor): change the reminder time, and the next reminder follows it.
- [ ] 8.2 Notifications: allowed. Sheet photo reading lists the readers set up.
- [ ] 8.3 Procedures, Clinic hours, Holidays, Setup steps all open and save.

## 9. Backups (M6)

- [ ] 9.1 After 02:00, the clinic's Drive has `yegna-backup-staging-<date>.ydb`.
- [ ] 9.2 Sunday after 21:00, the Doctor gets two CSV files on Telegram. They open in a spreadsheet, and Amharic reads correctly.
- [ ] 9.3 Restore rehearsal into staging: `docs/runbooks/restore.md`, then add a line to its log.

## 10. Website (M7)

- [ ] 10.1 All five pages in Amharic and English on a phone and a computer. The language switch keeps you on the same page.
- [ ] 10.2 The sticky Call bar dials. "Open in Google Maps" opens the map. The Telegram link opens the patient bot.
- [ ] 10.3 The clinic details are placeholders: list the real address, phone, services text and doctor's bio to replace them (`packages/shared/src/clinic.ts`, `apps/web/src/content/`).

## Findings

| Step | What happened | Phone / browser | Severity (blocker / annoying / cosmetic) |
| ---- | ------------- | --------------- | ---------------------------------------- |
|      |               |                 |                                          |
