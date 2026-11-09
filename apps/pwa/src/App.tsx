import { useEffect } from 'preact/hooks';
import { locale, t } from './i18n/index.ts';
import { route } from './lib/router.ts';
import { session } from './lib/session.ts';
import { Devices, Users } from './screens/Admin.tsx';
import { Home } from './screens/Home.tsx';
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
    default:
      return <Home />;
  }
}
