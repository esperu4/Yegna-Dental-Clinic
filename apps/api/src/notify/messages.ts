/**
 * Team bot messages (PRD §13), in the recipient's language and calendar (PRD §3, §6). Patient
 * names appear only in the messages themselves, never in logs; phones and notes are never sent.
 * Amharic wording awaits a native speaker's review, like the PWA's.
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
  /** Approve buttons carry it: a booking changed since the message is not approved from it. */
  version: number;
  patientName: string;
  startAt: number;
  procedureCode: string | null;
}

/** Lines listed in one message (keeps it well under Telegram's 4,096 characters). */
export const MAX_LINES = 20;
/** At most this many bookings get their own Approve button in a digest. */
export const DIGEST_BUTTONS = 8;

/** Callback data of an Approve button: the booking and the version that was shown. */
export const approveData = (b: Pick<BookingLine, 'id' | 'version'>) => `approve:${b.id}:${b.version}`;
/** Callback data of "Approve listed": the digest, so only what it listed is approved. */
export const approveAllData = (digestKey: string) => `all:${digestKey}`;

const dateOf = (r: Recipient, localDate: string) =>
  r.calendar === 'ethiopian'
    ? formatEthiopianDate(toEthiopian(parseIsoDate(localDate)), r.locale)
    : formatIsoDate(parseIsoDate(localDate));

const timeOf = (r: Recipient, minutes: number) =>
  r.calendar === 'ethiopian' ? formatEtTime(minutes, r.locale) : formatLocalTime(minutes);

/** "<date> 3:00 morning · Abebe (CU)" */
function line(r: Recipient, b: BookingLine, withDate: boolean): string {
  const { date, minutes } = utcToLocal(b.startAt);
  const when = withDate ? `${dateOf(r, date)} ${timeOf(r, minutes)}` : timeOf(r, minutes);
  return `${when} · ${b.patientName}${b.procedureCode ? ` (${b.procedureCode})` : ''}`;
}

const say = (r: Recipient, am: string, en: string) => (r.locale === 'am' ? am : en);

/** Bullet lines, at most `MAX_LINES`, then "…and N more". */
function bullets(r: Recipient, items: string[]): string[] {
  const shown = items.slice(0, MAX_LINES).map((t) => `• ${t}`);
  const more = items.length - shown.length;
  return more > 0 ? [...shown, say(r, `…እና ሌሎች ${more}`, `…and ${more} more`)] : shown;
}

const openApp = (r: Recipient, url: string, am: string, en: string): MessageButton => ({
  text: say(r, am, en),
  url,
});

/**
 * The approval digest (Doctor). `pending` is everything waiting; the first `MAX_LINES` are listed,
 * and "Approve listed" (keyed by `digestKey`) approves only those, and only if unchanged since.
 */
export function approvalDigest(r: Recipient, pending: BookingLine[], digestKey: string): OutgoingMessage {
  const n = pending.length;
  const listed = Math.min(n, MAX_LINES);
  return {
    text: [
      say(r, `${n} ቀጠሮዎች ማጽደቅ ይጠብቃሉ:`, `${n} bookings waiting for approval:`),
      ...bullets(
        r,
        pending.map((b) => line(r, b, true)),
      ),
    ].join('\n'),
    buttons: [
      [
        {
          text: say(r, `የተዘረዘሩትን አጽድቅ (${listed})`, `Approve listed (${listed})`),
          data: approveAllData(digestKey),
        },
      ],
      ...pending
        .slice(0, DIGEST_BUTTONS)
        .map((b) => [{ text: `✓ ${line(r, b, true)}`.slice(0, 60), data: approveData(b) }]),
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
      ? { buttons: [[{ text: say(r, 'አጽድቅ', 'Approve'), data: approveData(b) }]] }
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
    text: [
      head,
      ...bullets(
        r,
        bookings.map((b) => line(r, b, false)),
      ),
    ].join('\n'),
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
      `${noTelegram ? '📵 ' : ''}${unapproved ? '⏳ ' : ''}${line(r, booking, true)}`,
  );
  return {
    text: [
      say(r, `📞 የስልክ ዝርዝር: ${items.length}`, `📞 Call list: ${items.length}`),
      ...bullets(r, lines),
    ].join('\n'),
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

/** `/today` or `/tomorrow` (PRD §13): a read-only text schedule. */
export function daySchedule(
  r: Recipient,
  which: 'today' | 'tomorrow',
  localDate: string,
  bookings: BookingLine[],
): string {
  const title =
    which === 'today'
      ? say(r, `ዛሬ (${dateOf(r, localDate)})`, `Today (${dateOf(r, localDate)})`)
      : say(r, `ነገ (${dateOf(r, localDate)})`, `Tomorrow (${dateOf(r, localDate)})`);
  if (bookings.length === 0) return `${title}: ${say(r, 'ቀጠሮ የለም።', 'no bookings.')}`;
  return [
    `${title}: ${bookings.length}`,
    ...bullets(
      r,
      bookings.map((b) => line(r, b, false)),
    ),
  ].join('\n');
}

/** Replies of the team bot. Before linking, the chat's language is unknown: both languages. */
export const botText = {
  linked: (r: Recipient, name: string) =>
    say(r, `✓ ${name}፣ ቴሌግራም ከየኛ ጋር ተገናኝቷል።`, `✓ ${name}, Telegram is now linked to Yegna.`),
  linkFailed:
    'ይህ የማገናኛ ኮድ ጊዜው አልፎበታል ወይም ጥቅም ላይ ውሏል። በመተግበሪያው ማስተካከያ አዲስ ይፍጠሩ።\n' +
    'This link code has expired or was already used. Create a new one in the app’s Settings.',
  notLinked: 'ይህ ቦት ለየኛ የጥርስ ክሊኒክ ሠራተኞች ብቻ ነው።\nThis bot is only for the Yegna Dental Clinic team.',
  help: (r: Recipient) => say(r, 'ትዕዛዞች: /today (ዛሬ) · /tomorrow (ነገ)', 'Commands: /today · /tomorrow'),
  /** "3 approved", plus how many were skipped because they changed (names are not repeated). */
  approved: (r: Recipient, done: number, skipped: number) =>
    skipped === 0
      ? say(r, `✓ ${done} ጸድቋል`, `✓ ${done} approved`)
      : say(
          r,
          `✓ ${done} ጸድቋል፤ ${skipped} ተቀይረዋል፦ መተግበሪያውን ይክፈቱ`,
          `✓ ${done} approved; ${skipped} changed since: open the app`,
        ),
  approvedMore: (r: Recipient, done: number) =>
    say(r, `✓ ${done} ጸድቋል፤ ለቀሪዎቹ እንደገና ይንኩ`, `✓ ${done} approved; tap again for the rest`),
  /** For anyone the bot does not serve: the same generic text, confirming nothing. */
  refused: 'ይህን ማድረግ አይቻልም።\nThis can’t be done.',
};
