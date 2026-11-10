/**
 * Link Telegram (PRD §13, Settings): a one-time code opens the Yegna Team bot in Telegram, valid
 * 10 minutes. Needs the internet; the rest of the app does not depend on Telegram.
 */
import { useEffect, useState } from 'preact/hooks';
import { t } from '../i18n/index.ts';
import { session } from '../lib/session.ts';
import { useAction } from './ui.tsx';

type Status = { linked: boolean; available: boolean };

export function TelegramLink() {
  const [status, setStatus] = useState<Status | null>(null);
  const [opened, setOpened] = useState(false);
  const [connected, setConnected] = useState(false);
  const { busy, error, run } = useAction();

  const load = () => run(async () => setStatus(await session.authed<Status>('/me/telegram')));
  useEffect(() => void load(), []);
  // Back from Telegram: show the new state.
  useEffect(() => {
    const onShow = () => document.visibilityState === 'visible' && opened && void load();
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, [opened]);

  return (
    <section class="stack" aria-label={t('telegram.title')}>
      <h2 class="step-title">{t('telegram.title')}</h2>
      {status === null ? (
        <p class="muted">{error ?? t('common.loading')}</p>
      ) : !status.available ? (
        <p class="muted">{t('telegram.notAvailable')}</p>
      ) : status.linked ? (
        <>
          <p>{t('telegram.linked')}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await session.authed('/me/telegram', { method: 'DELETE' });
                setStatus((s) => (s ? { ...s, linked: false } : s));
              })
            }
          >
            {t('telegram.unlink')}
          </button>
        </>
      ) : (
        <>
          <p class="muted">{t('telegram.help')}</p>
          <button
            type="button"
            class="primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const { url } = await session.authed<{ url: string }>('/me/telegram/link', {
                  method: 'POST',
                });
                setOpened(true);
                window.open(url, '_blank', 'noopener');
              })
            }
          >
            {t('telegram.link')}
          </button>
        </>
      )}
      {status?.available && session.current.value?.user.role === 'doctor' ? (
        <button
          type="button"
          class="link"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await session.authed('/admin/telegram/connect', { method: 'POST' });
              setConnected(true);
            })
          }
        >
          {connected ? t('telegram.connected') : t('telegram.connect')}
        </button>
      ) : null}
      {status !== null && error ? <p class="banner error">{error}</p> : null}
    </section>
  );
}
