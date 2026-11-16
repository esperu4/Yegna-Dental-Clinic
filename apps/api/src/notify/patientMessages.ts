/**
 * Yegna Dental (patient bot) wording, PRD §14: Amharic or English as the patient chose, always the
 * Ethiopian calendar and ET time. A patient only ever sees their own approved bookings; never other
 * patients, free times or internal notes. Amharic awaits a native speaker's review.
 *
 * Telegram buttons cannot open `tel:` links, so "Call the clinic" sends the clinic as a contact
 * card (one tap to call) and the number as text, which Telegram makes tappable.
 */
import { CLINIC, displayPhone, mapsUrl } from '@yegna/shared';
import {
  type WeeklyDefaults,
  type Weekday,
  formatEthiopianDate,
  formatEtTime,
  parseIsoDate,
  toEthiopian,
  utcToLocal,
  weekdayName,
  weekdayOf,
} from '@yegna/time';
import type { OutgoingMessage } from './notifier.ts';

export type PatientLocale = 'am' | 'en';

const say = (l: PatientLocale, am: string, en: string) => (l === 'am' ? am : en);

/** Main menu buttons (a reply keyboard). The text identifies the button and its language. */
export const MENU = {
  location: { am: '📍 አድራሻ', en: '📍 Location' },
  hours: { am: '🕘 የስራ ሰዓት', en: '🕘 Hours' },
  call: { am: '📞 ወደ ክሊኒኩ ይደውሉ', en: '📞 Call the clinic' },
  services: { am: '🦷 አገልግሎቶች', en: '🦷 Services' },
  appointment: { am: '📅 ቀጠሮዬ', en: '📅 My appointment' },
  language: { am: '🌐 ቋንቋ / Language', en: '🌐 ቋንቋ / Language' },
  back: { am: '⬅️ ወደ ዋናው ማውጫ', en: '⬅️ Main menu' },
} as const;
export type MenuItem = keyof typeof MENU;

export const LANGUAGE_BUTTONS = { am: 'አማርኛ', en: 'English' } as const;

/** Which menu button (and in which language) a message's text is, if any. */
export function menuItemOf(text: string): { item: MenuItem; locale: PatientLocale } | null {
  for (const [item, labels] of Object.entries(MENU) as [MenuItem, (typeof MENU)[MenuItem]][]) {
    if (text === labels.am) return { item, locale: 'am' };
    if (text === labels.en) return { item, locale: 'en' };
  }
  return null;
}

export function languageOf(text: string): PatientLocale | null {
  if (text === LANGUAGE_BUTTONS.am) return 'am';
  if (text === LANGUAGE_BUTTONS.en) return 'en';
  return null;
}

/** Reply keyboards (Telegram `reply_markup`). */
export const keyboards = {
  language: () => ({
    keyboard: [[{ text: LANGUAGE_BUTTONS.am }, { text: LANGUAGE_BUTTONS.en }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  }),
  menu: (l: PatientLocale) => ({
    keyboard: [
      [{ text: MENU.appointment[l] }],
      [{ text: MENU.location[l] }, { text: MENU.hours[l] }],
      [{ text: MENU.call[l] }, { text: MENU.services[l] }],
      [{ text: MENU.language[l] }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  }),
  shareContact: (l: PatientLocale) => ({
    keyboard: [
      [{ text: say(l, '📱 ስልክ ቁጥሬን አጋራ', '📱 Share my phone number'), request_contact: true }],
      [{ text: MENU.back[l] }],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
  }),
};

const clinicName = (l: PatientLocale) => CLINIC.name[l];
const mainPhone = () => displayPhone(CLINIC.phones[0]);

export const patientText = {
  chooseLanguage: () => `${CLINIC.name.am} · ${CLINIC.name.en}\nቋንቋ ይምረጡ / Choose your language`,
  welcome: (l: PatientLocale) =>
    say(
      l,
      `እንኳን ወደ ${clinicName(l)} በደህና መጡ። ከታች ካለው ማውጫ ይምረጡ። ቀጠሮ ለመያዝ እባክዎ ይደውሉ: ${mainPhone()}`,
      `Welcome to ${clinicName(l)}. Choose from the menu below. To book, please call us: ${mainPhone()}`,
    ),
  address: (l: PatientLocale) => `${clinicName(l)}\n${CLINIC.address[l]}`,
  openMaps: (l: PatientLocale) => say(l, 'በGoogle Maps ይክፈቱ', 'Open in Google Maps'),
  call: (l: PatientLocale) =>
    say(
      l,
      `📞 ይደውሉልን: ${CLINIC.phones.map(displayPhone).join(', ')}`,
      `📞 Call us: ${CLINIC.phones.map(displayPhone).join(', ')}`,
    ),
  services: (l: PatientLocale) =>
    [
      say(l, '🦷 አገልግሎቶቻችን:', '🦷 Our services:'),
      ...CLINIC.services.map((s) => `• ${s.name[l]}: ${s.about[l]}`),
      '',
      say(l, `ለቀጠሮ ይደውሉ: ${mainPhone()}`, `To book, call: ${mainPhone()}`),
    ].join('\n'),
  askContact: (l: PatientLocale) =>
    say(
      l,
      'ቀጠሮዎን ለማየት ከታች ያለውን ቁልፍ ተጭነው ስልክ ቁጥርዎን ያጋሩ። ቀጠሮ ሲይዙ የሰጡትን ቁጥር መሆን አለበት።',
      'To see your appointment, tap the button below to share your phone number. It must be the number you gave when booking.',
    ),
  notOwnContact: (l: PatientLocale) =>
    say(l, 'እባክዎ የራስዎን ቁጥር በቁልፉ ያጋሩ።', 'Please share your own number with the button.'),
  notFound: (l: PatientLocale) =>
    say(
      l,
      `ቀጠሮዎን ማግኘት አልቻልንም። እባክዎ ወደ ክሊኒኩ ይደውሉ: ${mainPhone()}`,
      `We couldn't find your booking. Please call the clinic: ${mainPhone()}`,
    ),
  linked: (l: PatientLocale) =>
    say(
      l,
      'ተገናኝተዋል። ቀጠሮዎ ሲረጋገጥና ከቀጠሮዎ በፊት ባለው ቀን መልዕክት እንልክልዎታለን።',
      'You are connected. We will message you when your appointment is confirmed and the day before it.',
    ),
  noAppointment: (l: PatientLocale) =>
    say(
      l,
      `የተረጋገጠ ቀጠሮ የለዎትም። ቀጠሮ ለመያዝ ይደውሉ: ${mainPhone()}`,
      `You have no confirmed appointment coming up. To book, call: ${mainPhone()}`,
    ),
  yourAppointments: (l: PatientLocale) => say(l, '📅 ቀጠሮዎ:', '📅 Your appointment:'),
  thanksConfirmed: (l: PatientLocale) =>
    say(l, 'እናመሰግናለን! እንጠብቅዎታለን።', 'Thank you! We look forward to seeing you.'),
  willCall: (l: PatientLocale) => say(l, 'ክሊኒኩ ይደውልልዎታል።', 'The clinic will call you.'),
  notAvailable: (l: PatientLocale) =>
    say(
      l,
      `ይህ ቀጠሮ ተቀይሯል። እባክዎ ይደውሉ: ${mainPhone()}`,
      `This appointment has changed. Please call: ${mainPhone()}`,
    ),
};

/** A booking as patients see it: no notes, no internal status. */
export interface PatientBooking {
  id: string;
  startAt: number;
  procedureNameAm: string | null;
  procedureNameEn: string | null;
}

/** "Thursday, Hidar 11, 2019 · 4:00 morning · Cleaning" (Ethiopian date, ET time; PRD §14). */
export function whenAndWhat(l: PatientLocale, b: PatientBooking): string {
  const { date, minutes } = utcToLocal(b.startAt);
  const day = `${weekdayName(weekdayOf(date), l)}, ${formatEthiopianDate(toEthiopian(parseIsoDate(date)), l)}`;
  const procedure = l === 'am' ? b.procedureNameAm : b.procedureNameEn;
  return [day, formatEtTime(minutes, l), procedure].filter(Boolean).join(' · ');
}

/** The weekly hours (live from settings), ET, Monday first. */
export function hoursText(l: PatientLocale, weekly: WeeklyDefaults): string {
  const order: Weekday[] = [1, 2, 3, 4, 5, 6, 0];
  const lines = order.map((d) => {
    const day = weekly[d];
    const name = weekdayName(d, l);
    if (!day) return `${name}: ${say(l, 'ዝግ', 'closed')}`;
    return `${name}: ${formatEtTime(day.openAt, l)} – ${formatEtTime(day.closeAt, l)}`;
  });
  return [say(l, '🕘 የስራ ሰዓት (የኢትዮጵያ ሰዓት):', '🕘 Opening hours (Ethiopian time):'), ...lines].join('\n');
}

const mapsButton = (l: PatientLocale) => ({ text: patientText.openMaps(l), url: mapsUrl() });

/**
 * Callback data of the reminder buttons: `p:<c|r|x>:<booking id>:<start time>` (≤ 64 bytes). The
 * time makes an old reminder's button do nothing once the booking has moved.
 */
export const REQUEST_ACTIONS = { c: 'confirm', r: 'reschedule', x: 'cancel' } as const;
export const requestData = (action: keyof typeof REQUEST_ACTIONS, b: { id: string; startAt: number }) =>
  `p:${action}:${b.id}:${b.startAt}`;

/** When the Doctor approves (PRD §14). */
export function confirmationMessage(l: PatientLocale, b: PatientBooking): OutgoingMessage {
  return {
    text: [
      say(l, '✅ ቀጠሮዎ ተረጋግጧል:', '✅ Your appointment is confirmed:'),
      whenAndWhat(l, b),
      `📍 ${CLINIC.address[l]}`,
      patientText.call(l),
    ].join('\n'),
    buttons: [[mapsButton(l)]],
  };
}

/** The day before, at the reminder time (18:00 by default), with the three answers. */
export function reminderMessage(l: PatientLocale, b: PatientBooking): OutgoingMessage {
  return {
    text: [
      say(l, '🔔 ነገ ቀጠሮ አለዎት:', '🔔 Your appointment is tomorrow:'),
      whenAndWhat(l, b),
      `📍 ${CLINIC.address[l]}`,
    ].join('\n'),
    buttons: [
      [{ text: say(l, '✅ አረጋግጣለሁ', '✅ Confirm'), data: requestData('c', b) }],
      [{ text: say(l, '🔁 ቀኑን መቀየር እፈልጋለሁ', '🔁 Need to reschedule'), data: requestData('r', b) }],
      [{ text: say(l, '❌ ሰርዝ', '❌ Cancel'), data: requestData('x', b) }],
    ],
  };
}

/** An approved (and confirmed to the patient) booking was cancelled by the clinic. */
export function cancellationMessage(l: PatientLocale, b: PatientBooking): OutgoingMessage {
  return {
    text: [
      say(l, '❌ ይህ ቀጠሮዎ ተሰርዟል:', '❌ This appointment was cancelled:'),
      whenAndWhat(l, b),
      say(l, `አዲስ ቀጠሮ ለመያዝ ይደውሉ: ${mainPhone()}`, `To book again, please call: ${mainPhone()}`),
    ].join('\n'),
  };
}
