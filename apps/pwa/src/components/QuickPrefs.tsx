/**
 * Language and calendar switches in every screen's header (decided 2026-11-10): one tap flips
 * Amharic ⇄ English or Ethiopian ⇄ Gregorian. Works offline (lib/preferences.ts).
 */
import { calendarPref, locale, t } from '../i18n/index.ts';
import { preferences } from '../lib/preferences.ts';

export function QuickPrefs() {
  const nextLocale = locale.value === 'am' ? 'en' : 'am';
  const nextCalendar = calendarPref.value === 'ethiopian' ? 'gregorian' : 'ethiopian';
  return (
    <div class="quick-prefs">
      <button
        type="button"
        class="pill"
        aria-label={t('prefs.switchLanguage')}
        onClick={() => void preferences.set({ locale: nextLocale })}
      >
        {locale.value === 'am' ? 'አማ' : 'EN'}
      </button>
      <button
        type="button"
        class="pill"
        aria-label={t('prefs.switchCalendar')}
        onClick={() => void preferences.set({ calendar: nextCalendar })}
      >
        {t(calendarPref.value === 'ethiopian' ? 'prefs.calendar.et' : 'prefs.calendar.gc')}
      </button>
    </div>
  );
}
