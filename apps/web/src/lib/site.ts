/** Pages, their addresses in both languages, and the site's own short texts (PRD §15). */
export const LOCALES = ['am', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const PAGES = ['home', 'services', 'about', 'contact', 'faq'] as const;
export type Page = (typeof PAGES)[number];

/** Amharic at `/`, English at `/en/`; every address ends with a slash. */
export function pathOf(locale: Locale, page: Page): string {
  const base = locale === 'am' ? '/' : '/en/';
  return page === 'home' ? base : `${base}${page}/`;
}

export const NAV: Record<Page, Record<Locale, string>> = {
  home: { am: 'መነሻ', en: 'Home' },
  services: { am: 'አገልግሎቶች', en: 'Services' },
  about: { am: 'ስለ ሐኪሟ', en: 'About the doctor' },
  contact: { am: 'አድራሻ', en: 'Contact' },
  faq: { am: 'ጥያቄዎች', en: 'FAQ' },
};

export const TEXT = {
  callLong: { am: 'ለቀጠሮ ይደውሉ', en: 'Call to book' },
  telegram: { am: 'በቴሌግራም ማስታወሻ ያግኙ', en: 'Get reminders on Telegram' },
  maps: { am: 'በGoogle Maps ይክፈቱ', en: 'Open in Google Maps' },
  hours: { am: 'የስራ ሰዓት', en: 'Opening hours' },
  days: { am: 'ከሰኞ እስከ ቅዳሜ', en: 'Monday to Saturday' },
  address: { am: 'አድራሻ', en: 'Address' },
  phone: { am: 'ስልክ', en: 'Phone' },
  otherLanguage: { am: 'English', en: 'አማርኛ' },
  skip: { am: 'ወደ ይዘቱ ይዝለሉ', en: 'Skip to content' },
  mainNav: { am: 'ዋና ማውጫ', en: 'Main' },
  noPrices: { am: 'ዋጋ ከምርመራ በኋላ ይነገራል።', en: 'Prices are discussed after an examination.' },
  ourServices: { am: 'አገልግሎቶቻችን', en: 'Our services' },
  notFound: { am: 'ገጹ አልተገኘም', en: 'Page not found' },
  backHome: { am: 'ወደ መነሻ ገጽ', en: 'Back to the home page' },
} satisfies Record<string, Record<Locale, string>>;
