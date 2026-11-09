/** Settings (PRD §8 item 12). Everyone: language, calendar, sign out. Doctor: staff accounts, phones. */
import type { CalendarPref, Locale, SessionUser } from '@yegna/shared/client';
import { Screen, useAction } from '../components/ui.tsx';
import { calendarPref, locale, t } from '../i18n/index.ts';
import { back, go } from '../lib/router.ts';
import { session } from '../lib/session.ts';

export function Settings() {
  const user = session.current.value?.user;
  const { busy, error, run } = useAction();

  function save(patch: { locale?: Locale; calendar?: CalendarPref }) {
    void run(async () => {
      const res = await session.authed<{ user: SessionUser }>('/me', { method: 'PATCH', body: patch });
      await session.updateUser(res.user);
    });
  }

  return (
    <Screen title={t('settings.title')} back={back}>
      <section class="stack">
        <h2>{t('settings.language')}</h2>
        <div class="segmented" role="group" aria-label={t('settings.language')}>
          {(['am', 'en'] as const).map((l) => (
            <button
              type="button"
              aria-pressed={locale.value === l}
              disabled={busy}
              onClick={() => save({ locale: l })}
            >
              {l === 'am' ? 'አማርኛ' : 'English'}
            </button>
          ))}
        </div>

        <h2>{t('settings.calendar')}</h2>
        <div class="segmented" role="group" aria-label={t('settings.calendar')}>
          {(['ethiopian', 'gregorian'] as const).map((c) => (
            <button
              type="button"
              aria-pressed={calendarPref.value === c}
              disabled={busy}
              onClick={() => save({ calendar: c })}
            >
              {t(c === 'ethiopian' ? 'settings.calendar.ethiopian' : 'settings.calendar.gregorian')}
            </button>
          ))}
        </div>
        {error ? <p class="banner error">{error}</p> : null}

        {user?.role === 'doctor' ? (
          <>
            <button type="button" class="row" onClick={() => go('users')}>
              {t('settings.users')} ›
            </button>
            <button type="button" class="row" onClick={() => go('devices')}>
              {t('settings.devices')} ›
            </button>
          </>
        ) : null}

        <button
          type="button"
          class="danger"
          onClick={() => {
            if (confirm(t('settings.signOut.confirm'))) void session.wipe();
          }}
        >
          {t('settings.signOut')}
        </button>
      </section>
    </Screen>
  );
}
