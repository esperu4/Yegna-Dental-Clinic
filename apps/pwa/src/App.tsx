import { useEffect } from 'preact/hooks';
import { locale, t } from './i18n/index.ts';
import { preferences } from './lib/preferences.ts';
import { route } from './lib/router.ts';
import { session } from './lib/session.ts';
import { sync } from './lib/sync.ts';
import { Devices, Users } from './screens/Admin.tsx';
import { ClinicHours, Procedures, SetupWizard } from './screens/ClinicSetup.tsx';
import { Holidays } from './screens/Holidays.tsx';
import { Home } from './screens/Today.tsx';
import { Lock } from './screens/Lock.tsx';
import { Settings } from './screens/Settings.tsx';
import { Welcome } from './screens/Welcome.tsx';

export function App() {
  useEffect(() => {
    void session.init();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void session.checkIdle();
    };
    const onUse = () => void session.touch();
    document.addEventListener('visibilitychange', onVisible);
    document.addEventListener('pointerdown', onUse, { passive: true });
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('pointerdown', onUse);
    };
  }, []);

  // Sync while the app is open and unlocked (PRD §7.3; the service worker takes over in M2).
  const status = session.status.value;
  useEffect(() => (status === 'ready' ? sync.startAuto() : undefined), [status]);
  // Send a language/calendar change made offline, now and whenever the device is back online.
  useEffect(() => {
    if (status !== 'ready') return;
    const flush = () => void preferences.flush();
    flush();
    window.addEventListener('online', flush);
    return () => window.removeEventListener('online', flush);
  }, [status]);

  useEffect(() => {
    document.documentElement.lang = locale.value;
  }, [locale.value]);

  switch (session.status.value) {
    case 'loading':
      return <p class="loading">{t('common.loading')}</p>;
    case 'signedOut':
      return <Welcome />;
    case 'locked':
      return <Lock />;
  }
  const isDoctor = session.current.value?.user.role === 'doctor';
  switch (route.value) {
    case 'settings':
      return <Settings />;
    case 'users':
      return isDoctor ? <Users /> : <Home />;
    case 'devices':
      return isDoctor ? <Devices /> : <Home />;
    case 'procedures':
      return isDoctor ? <Procedures /> : <Home />;
    case 'hours':
      return isDoctor ? <ClinicHours /> : <Home />;
    case 'holidays':
      return isDoctor ? <Holidays /> : <Home />;
    case 'wizard':
      return isDoctor ? <SetupWizard /> : <Home />;
    default:
      return <Home />;
  }
}
