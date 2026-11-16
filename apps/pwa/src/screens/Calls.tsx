/**
 * Call list (Staff and Doctor; PRD §8 item 8, ADR 0008). Each row: Call, then Confirmed,
 * No answer (the row stays, marked tried) or Mark handled. A patient's reschedule or cancel
 * request from the patient bot (PRD §14) is closed by Mark handled. Works offline like every write.
 */
import type { CallItem, CallOutcome, CallReason } from '@yegna/shared/client';
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

  // The call is about the time shown: if the booking was moved meanwhile, the server refuses it.
  const record = (booking: { id: string; startAt: number }, call: CallOutcome) =>
    void run(() =>
      sync.write('bookings', 'update', { call, callFor: booking.startAt }, booking.id).then(() => undefined),
    );

  // Mark handled closes the row: the booking's call (if it is listed for one) and its requests.
  // Mark handled closes the row in one change (PRD §7.2): the booking's call, if it is listed for
  // one, and each of its open patient requests.
  const markHandled = ({ booking, reasons, requests }: CallItem) =>
    void run(() =>
      sync
        .writeMany([
          ...(reasons.some((r) => !REQUEST_REASONS.has(r))
            ? [
                {
                  entity: 'bookings' as const,
                  kind: 'update' as const,
                  fields: { call: 'handled', callFor: booking.startAt },
                  entityId: booking.id,
                },
              ]
            : []),
          ...requests.map((request) => ({
            entity: 'patientRequests' as const,
            kind: 'update' as const,
            fields: { status: 'handled' },
            entityId: request.id,
          })),
        ])
        .then(() => undefined),
    );

  return (
    <Screen title={t('calls.title')} back={back}>
      {items.length === 0 ? <p class="muted">{t('calls.empty')}</p> : null}
      <ul class="list">
        {items.map((item) => {
          const { booking, patient, reasons } = item;
          const { date, minutes } = utcToLocal(booking.startAt);
          return (
            <li class="stack call-card">
              <span>
                <strong>{patient?.name ?? '…'}</strong>
                <span class="muted small">
                  {' '}
                  · {formatDate(date)} {formatTime(minutes)}
                </span>
              </span>
              {reasons.map((reason) => (
                <span class="small">
                  {REASON_ICONS[reason]} {t(`calls.${reason}`)}
                </span>
              ))}
              {booking.callTriedAt ? (
                <span class="muted small">
                  {t('calls.tried', { time: formatInstant(booking.callTriedAt) })}
                </span>
              ) : null}
              {patient ? (
                <a class="button primary call-now" href={`tel:${patient.phoneE164}`}>
                  {t('action.call')} {formatPhone(patient.phoneE164)}
                </a>
              ) : null}
              <div class="outcomes">
                {reasons.includes('noTelegram') ? (
                  <>
                    <button type="button" disabled={busy} onClick={() => record(booking, 'confirmed')}>
                      {t('calls.confirmed')}
                    </button>
                    <button type="button" disabled={busy} onClick={() => record(booking, 'no_answer')}>
                      {t('calls.noAnswer')}
                    </button>
                  </>
                ) : null}
                <button type="button" disabled={busy} onClick={() => markHandled(item)}>
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

const REQUEST_REASONS: ReadonlySet<CallReason> = new Set(['rescheduleRequest', 'cancelRequest']);

const REASON_ICONS: Record<CallReason, string> = {
  noTelegram: '📵',
  unapproved: '⏳',
  rescheduleRequest: '🔁',
  cancelRequest: '❌',
};
