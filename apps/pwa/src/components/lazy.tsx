/**
 * Loads a screen's code only when it is first shown, keeping the initial bundle small (PRD §8:
 * < 150 KB). The service worker precaches every chunk, so lazy screens still open offline.
 */
import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../i18n/index.ts';

export function lazyScreen(load: () => Promise<ComponentType>): ComponentType {
  let loaded: ComponentType | null = null;
  return function LazyScreen() {
    const [Component, setComponent] = useState<ComponentType | null>(() => loaded);
    useEffect(() => {
      if (loaded) return;
      void load().then((c) => {
        loaded = c;
        setComponent(() => c);
      });
    }, []);
    return Component ? <Component /> : <p class="loading">{t('common.loading')}</p>;
  };
}
