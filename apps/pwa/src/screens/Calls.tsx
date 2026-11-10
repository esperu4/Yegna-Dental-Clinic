/**
 * Call list (Staff and Doctor; PRD §8 item 8, ADR 0008). Each row: Call, then Confirmed,
 * No answer (the row stays, marked tried) or Mark handled. Works offline like every write.
 */
import type { CallOutcome } from '@yegna/shared/client';
import { utcToLocal } from '@yegna/time';
import { Screen, useAction } from '../components/ui.tsx';
import { t } from '../i18n/index.ts';
import { useCallList } from '../lib/dayData.ts';
import { formatDate, formatInstant, formatPhone, formatTime } from '../lib/format.ts';
import { back } from '../lib/router.ts';
import { sync } from '../lib/sync.ts';

export function Calls() {
  const items = useCallList();
  const { busy, error, run } = useAction();
  if (!items) return null;

  const record = (bookingId: string, call: CallOutcome) =>
    void run(() => sync.write('bookings', 'update', { call }, bookingId).then(() => undefined));

  return (
    <Screen title={t('calls.title')} back={back}>
      {items.length === 0 ? <p class="muted">{t('calls.empty')}</p> : null}
      <ul class="list">
        {items.map(({ booking, patient, reasons }) => {
          const { date, minutes } = utcToLocal(booking.startAt);
          return (
            <li class="stack">
              <span>
                <strong>{patient?.name ?? '…'}</strong>
                <span class="muted small">
                  {' '}
                  · {formatDate(date)} {formatTime(minutes)}
                </span>
              </span>
              {reasons.map((reason) => (
                <span class="small">
                  {reason === 'noTelegram' ? '📵 ' : '⏳ '}
                  {t(reason === 'noTelegram' ? 'calls.noTelegram' : 'calls.unapproved')}
                </span>
              ))}
              {booking.callTriedAt ? (
                <span class="muted small">
                  {t('calls.tried', { time: formatInstant(booking.callTriedAt) })}
                </span>
              ) : null}
              <div class="actions">
                {patient ? (
                  <a class="button" href={`tel:${patient.phoneE164}`}>
                    {t('action.call')} {formatPhone(patient.phoneE164)}
                  </a>
                ) : null}
                {reasons.includes('noTelegram') ? (
                  <>
                    <button
                      type="button"
                      class="primary"
                      disabled={busy}
                      onClick={() => record(booking.id, 'confirmed')}
                    >
                      {t('calls.confirmed')}
                    </button>
                    <button type="button" disabled={busy} onClick={() => record(booking.id, 'no_answer')}>
                      {t('calls.noAnswer')}
                    </button>
                  </>
                ) : null}
                <button type="button" disabled={busy} onClick={() => record(booking.id, 'handled')}>
                  {t('calls.handled')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {error ? <p class="banner error">{error}</p> : null}
    </Screen>
  );
}
