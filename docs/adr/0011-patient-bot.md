# ADR 0011: The Yegna Dental patient bot

Status: accepted (built 2026-11-16, M5)

## Context

PRD §14 defines a patient bot for information and appointment messages, with no booking requests. It must never tell a patient about a booking the Doctor has not approved (§20 M5), and patients must never see other patients, free times or internal notes (§14, §18).

## Decisions

1. **One webhook, its own secrets.** `POST /telegram/patient` checks `PATIENT_BOT_WEBHOOK_SECRET` before reading the body. `PATIENT_BOT_TOKEN` and `PATIENT_BOT_USERNAME` are separate from the team bot's. The Doctor connects the bot once from Settings (`POST /admin/telegram/patient/connect`).
2. **Nothing is stored about strangers.** The menu's language travels in the button texts (a reply keyboard per language), so an unlinked chat leaves no row. Strangers get Amharic unless their Telegram is set to English.
3. **Linking:** the patient shares their own contact. It is accepted only if `contact.user_id === from.id` and the normalised phone matches a live patient. A chat links to one patient; linking again moves it. Linking bumps the patient's version, so the PWA's 📵 flag clears. `patients.telegram_locale` keeps the language the patient last used, for the messages they receive.
4. **A new phone number ends the link** (privacy review M5). If staff mistype a number and a stranger who owns it links, correcting the number unlinks the stranger. Residual risk: until the correction, that stranger receives the patient's confirmations. Staff should read the number back to the patient on the phone.
5. **Only approved bookings are messaged.** Confirmations and reminders read `approved` bookings that are still ahead, and nothing else. A cancellation notice goes only if the patient was sent a confirmation **for the booking's current time**, so a time moved and never approved again is never revealed.
6. **When messages go out:**
   - Right after a `/sync` that changed the booking, within the request's leftover query budget. These run one after another, after any clash alerts.
   - Otherwise the hourly run sends them: it catches up on bookings updated in the last 48 h, and sends reminders from the reminder time (18:00 by default) until midnight.
   - Each message goes once per booking, start time and chat (`notification_log` kinds `patient_confirm`, `patient_reminder`, `patient_cancel`).
7. **Reminder buttons** carry the booking id **and its start time** (`p:<c|r|x>:<id>:<startAt>`), so an old reminder does nothing once the booking has moved.
   - **Confirm** sets `patient_confirmed_at`.
   - **Need to reschedule** and **Cancel** create one `patient_request` per booking and kind, ever, and alert the linked team through the team bot. The request then reaches the PWA Call list through sync, where staff mark it handled.
8. **"Call the clinic"** sends the clinic as a contact card plus the number as text, because Telegram buttons cannot open `tel:` links.
9. **Erasing a patient** (ADR 0007) also clears their chat, their language and the `notification_log` rows that tie their chat to their bookings.
10. **One source for the clinic's details.** Name, address, coordinates, phone and services live in `packages/shared/src/clinic.ts`, shared with the website so the name, address and phone match everywhere. They are **placeholders** until the clinic confirms them (PRD §22 #4–#6); `CLINIC_DETAILS_CONFIRMED` is false until then.

## Consequences

- An approval made from the team bot is confirmed to the patient by the next hourly run, not instantly.
- Staff must take care when typing phone numbers (decision 4).
- The Amharic wording needs a native speaker's review, like the rest of the app.
