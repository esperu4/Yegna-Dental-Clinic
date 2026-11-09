/** Today (home). M1 slice 1 shows a placeholder; the timeline arrives with the booking slice. */
import { utcToLocal } from '@yegna/time';
import { t } from '../i18n/index.ts';
import { formatDate, formatTime } from '../lib/format.ts';
import { go } from '../lib/router.ts';
import { session } from '../lib/session.ts';

export function Home() {
  const now = utcToLocal(Date.now());
  return (
    <main class="screen">
      <header class="bar">
        <h1>{t('home.title')}</h1>
        <button type="button" class="icon" onClick={() => go('settings')} aria-label={t('nav.settings')}>
          ⚙
        </button>
      </header>
      <div class="content">
        <p class="lead">
          {formatDate(now.date)} · {formatTime(now.minutes)}
        </p>
        <p>{session.current.value?.user.name}</p>
        <p class="muted">{t('home.placeholder')}</p>
      </div>
    </main>
  );
}
