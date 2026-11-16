/**
 * The clinic's public details: one source for the patient bot (PRD §14) and the website (§15), so
 * the name, address and phone (NAP) are written the same everywhere, as the Google Business
 * Profile needs.
 *
 * PLACEHOLDERS until the clinic confirms them (PRD §22 #4 phone, #5 services copy, #6 address and
 * coordinates). `CLINIC_DETAILS_CONFIRMED` stays false until then; the launch checklist checks it.
 */
export const CLINIC_DETAILS_CONFIRMED = false;

type Text = { am: string; en: string };

export interface ClinicService {
  name: Text;
  about: Text;
}

export const CLINIC = {
  name: { am: 'የኛ የጥርስ ክሊኒክ', en: 'Yegna Dental Clinic' } satisfies Text,
  legalName: 'Yegna Medium Dental Clinic',
  address: {
    am: '6 ኪሎ፣ ከአዲስ አበባ ዩኒቨርሲቲ አጠገብ፣ አዲስ አበባ',
    en: '6 Kilo, near Addis Ababa University, Addis Ababa',
  } satisfies Text,
  /** For "Open in Google Maps" and the bot's location pin. */
  geo: { latitude: 9.0415, longitude: 38.7625 },
  /** The Yegna Dental patient bot's @username (PRD §14, §22 #8). */
  patientBot: 'YegnaDentalBot',
  /** E.164; the first is the main line (tap-to-call). */
  phones: ['+251110000000'],
  /** Opening hours as published (JSON-LD, website); the bot shows the live weekly hours. */
  openingHours: { days: ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'], opens: '09:00', closes: '18:00' },
  services: [
    {
      name: { am: 'ምርመራ', en: 'Check-up' },
      about: { am: 'የጥርስና የድድ ምርመራ፣ ምክር።', en: 'Teeth and gum examination and advice.' },
    },
    {
      name: { am: 'ማጽዳት', en: 'Cleaning' },
      about: { am: 'የጥርስ ማጽዳትና የድድ እንክብካቤ።', en: 'Professional cleaning and gum care.' },
    },
    {
      name: { am: 'መሙላት', en: 'Fillings' },
      about: { am: 'የተቦረቦረ ጥርስ መሙላት።', en: 'Fillings for decayed teeth.' },
    },
    {
      name: { am: 'መንቀል', en: 'Extractions' },
      about: { am: 'ጥርስ መንቀል።', en: 'Tooth extraction.' },
    },
  ] satisfies ClinicService[],
} as const;

/** `https://www.google.com/maps/search/?api=1&query=<lat>,<lng>` (no embedded map, PRD §15). */
export function mapsUrl(geo: { latitude: number; longitude: number } = CLINIC.geo): string {
  return `https://www.google.com/maps/search/?api=1&query=${geo.latitude},${geo.longitude}`;
}

export const telegramUrl = (username: string = CLINIC.patientBot) => `https://t.me/${username}`;

/** `+251 11 000 0000` style, for display. */
export function displayPhone(e164: string): string {
  const m = /^\+251(\d{2})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+251 ${m[1]} ${m[2]} ${m[3]}` : e164;
}
