/**
 * Settings (PRD §8 item 12). Everyone: language, calendar, sign out. The Doctor also: procedures,
 * clinic hours, Staff accounts, phones, and the setup steps again.
 */
import { PreferencesPicker } from '../components/clinicConfig.tsx';
import { Screen } from '../components/ui.tsx';
import { t } from '../i18n/index.ts';
import { type Route, back, go } from '../lib/router.ts';
import { session } from '../lib/session.ts';

const DOCTOR_LINKS: readonly [Route, Parameters<typeof t>[0]][] = [
  ['procedures', 'settings.procedures'],
  ['hours', 'settings.hours'],
  ['users', 'settings.users'],
  ['devices', 'settings.devices'],
  ['wizard', 'settings.wizard'],
];

export function Settings() {
  const isDoctor = session.current.value?.user.role === 'doctor';
  return (
    <Screen title={t('settings.title')} back={back}>
      <section class="stack">
        <PreferencesPicker />

        {isDoctor
          ? DOCTOR_LINKS.map(([to, label]) => (
              <button type="button" class="row" onClick={() => go(to)}>
                {t(label)} ›
              </button>
            ))
          : null}

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
