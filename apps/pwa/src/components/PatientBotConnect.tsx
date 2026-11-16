/**
 * The Yegna Dental patient bot (PRD §14), shown to the Doctor only (Settings): connect it to the server once
 * after its secrets are stored (docs/runbooks/patient-bot.md), and its public link to share.
 */
import { useEffect, useState } from 'preact/hooks';
import { t } from '../i18n/index.ts';
import { session } from '../lib/session.ts';
import { useAction } from './ui.tsx';

type Status = { available: boolean; url: string | null };

export function PatientBotConnect() {
  const [status, setStatus] = useState<Status | null>(null);
  const [connected, setConnected] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(
    () => void run(async () => setStatus(await session.authed<Status>('/admin/telegram/patient'))),
    [],
  );

  return (
    <section class="stack" aria-label={t('patientBot.title')}>
      <h2 class="step-title">{t('patientBot.title')}</h2>
      {status === null ? (
        <p class="muted">{error ?? t('common.loading')}</p>
      ) : !status.available ? (
        <p class="muted">{t('patientBot.notAvailable')}</p>
      ) : (
        <>
          <p class="muted">{t('patientBot.help')}</p>
          {status.url ? (
            <p>
              <a href={status.url} target="_blank" rel="noopener">
                {status.url}
              </a>
            </p>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await session.authed('/admin/telegram/patient/connect', { method: 'POST' });
                setConnected(true);
              })
            }
          >
            {connected ? t('patientBot.connected') : t('patientBot.connect')}
          </button>
        </>
      )}
      {status !== null && error ? <p class="banner error">{error}</p> : null}
    </section>
  );
}
