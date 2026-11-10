/**
 * Team bot messages (PRD §13), in the recipient's language and calendar (PRD §3, §6). Patient
 * names appear only in the messages themselves, never in logs. Amharic wording awaits a native
 * speaker's review, like the PWA's.
 */
import {
  formatEthiopianDate,
  formatEtTime,
  formatIsoDate,
  formatLocalTime,
  parseIsoDate,
  toEthiopian,
  utcToLocal,
} from '@yegna/time';
import type { MessageButton, OutgoingMessage } from './notifier.ts';

export interface Recipient {
  chatId: string;
  role: 'doctor' | 'staff';
  locale: 'am' | 'en';
  calendar: 'ethiopian' | 'gregorian';
}

/** A booking as a message line needs it. */
export interface BookingLine {
  id: string;
  patientName: string;
  startAt: number;
  procedureCode: string | null;
}

const dateOf = (r: Recipient, localDate: string) =>
  r.calendar === 'ethiopian'
    ? formatEthiopianDate(toEthiopian(parseIsoDate(localDate)), r.locale)
    : formatIsoDate(parseIsoDate(localDate));

const timeOf = (r: Recipient, minutes: number) =>
  r.calendar === 'ethiopian' ? formatEtTime(minutes, r.locale) : formatLocalTime(minutes);

/** "Tue 17 … 3:00 morning · Abebe (CU)" */
function line(r: Recipient, b: BookingLine, withDate: boolean): string {
  const { date, minutes } = utcToLocal(b.startAt);
  const when = withDate ? `${dateOf(r, date)} ${timeOf(r, minutes)}` : timeOf(r, minutes);
  return `${when} · ${b.patientName}${b.procedureCode ? ` (${b.procedureCode})` : ''}`;
}

const say = (r: Recipient, am: string, en: string) => (r.locale === 'am' ? am : en);

const openApp = (r: Recipient, pwaUrl: string, am: string, en: string): MessageButton => ({
  text: say(r, am, en),
  url: pwaUrl,
});

/** At most this many bookings get their own Approve button in a digest. */
export const DIGEST_BUTTONS = 8;

export function approvalDigest(r: Recipient, pending: BookingLine[]): OutgoingMessage {
  const n = pending.length;
  const listed = pending.slice(0, 20).map((b) => `• ${line(r, b, true)}`);
  if (n > listed.length)
    listed.push(say(r, `…እና ሌሎች ${n - listed.length}`, `…and ${n - listed.length} more`));
  return {
    text: [say(r, `${n} ቀጠሮዎች ማጽደቅ ይጠብቃሉ:`, `${n} bookings waiting for approval:`), ...listed].join('\n'),
    buttons: [
      [{ text: say(r, 'ሁሉንም አጽድቅ', 'Approve all'), data: 'approve_all' }],
      ...pending
        .slice(0, DIGEST_BUTTONS)
        .map((b) => [{ text: `✓ ${line(r, b, true)}`.slice(0, 60), data: `approve:${b.id}` }]),
    ],
  };
}

export function unapprovedAlert(r: Recipient, b: BookingLine): OutgoingMessage {
  return {
    text: say(
      r,
      `⏳ ገና ያልጸደቀ ቀጠሮ (ከ24 ሰዓት በታች): ${line(r, b, true)}`,
      `⏳ Not approved yet, less than 24 h away: ${line(r, b, true)}`,
    ),
    ...(r.role === 'doctor'
      ? { buttons: [[{ text: say(r, 'አጽድቅ', 'Approve'), data: `approve:${b.id}` }]] }
      : {}),
  };
}

export function tomorrowSummary(
  r: Recipient,
  localDate: string,
  bookings: BookingLine[],
  pwaUrl: string,
): OutgoingMessage {
  const head =
    bookings.length === 0
      ? say(r, `ነገ (${dateOf(r, localDate)}) ቀጠሮ የለም።`, `Tomorrow (${dateOf(r, localDate)}): no bookings.`)
      : say(
          r,
          `ነገ (${dateOf(r, localDate)}): ${bookings.length} ቀጠሮዎች፤ የመጀመሪያው ${line(r, bookings[0]!, false)}`,
          `Tomorrow (${dateOf(r, localDate)}): ${bookings.length} bookings; first ${line(r, bookings[0]!, false)}`,
        );
  return {
    text: [head, ...bookings.map((b) => `• ${line(r, b, false)}`)].join('\n'),
    buttons: [[openApp(r, pwaUrl, 'ቀኑን ክፈት', 'Open day')]],
  };
}

export function callListMessage(
  r: Recipient,
  items: { booking: BookingLine; noTelegram: boolean; unapproved: boolean }[],
  pwaUrl: string,
): OutgoingMessage {
  const lines = items.map(
    ({ booking, noTelegram, unapproved }) =>
      `• ${noTelegram ? '📵 ' : ''}${unapproved ? '⏳ ' : ''}${line(r, booking, true)}`,
  );
  return {
    text: [say(r, `📞 የስልክ ዝርዝር: ${items.length}`, `📞 Call list: ${items.length}`), ...lines].join('\n'),
    buttons: [[openApp(r, `${pwaUrl}/#/calls`, 'የስልክ ዝርዝር ክፈት', 'Open call list')]],
  };
}

export function movableHolidayReminder(r: Recipient, pwaUrl: string): OutgoingMessage {
  return {
    text: say(
      r,
      'ተንቀሳቃሽ በዓላትን (ፋሲካ፣ ስቅለት፣ ዒድ አል-ፈጥር፣ ዒድ አል-አድሐ፣ መውሊድ) ለዚህ ዓመት ያስገቡ።',
      "Add this year's movable holidays (Fasika, Siklet, Eid al-Fitr, Eid al-Adha, Mawlid).",
    ),
    buttons: [[openApp(r, `${pwaUrl}/#/holidays`, 'በዓላት', 'Holidays')]],
  };
}
