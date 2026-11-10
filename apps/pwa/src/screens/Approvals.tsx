/**
 * Approvals (Doctor; PRD §8 item 7, §10): bookings waiting for approval, grouped by day, with
 * "Approve all for this day" and per-booking Approve / Reject (reject = cancel with a reason).
 */
import { utcToLocal } from '@yegna/time';
import { Screen, useAction } from '../components/ui.tsx';
import { t } from '../i18n/index.ts';
import { useApprovals } from '../lib/dayData.ts';
import { formatDate, formatTime } from '../lib/format.ts';
import { back } from '../lib/router.ts';
import { sync } from '../lib/sync.ts';

export function Approvals() {
  const data = useApprovals();
  const { busy, error, run } = useAction();
  if (!data) return null;
  const { days, patients } = data;

  const approve = (ids: string[]) =>
    void run(async () => {
      for (const id of ids) await sync.write('bookings', 'update', { status: 'approved' }, id);
    });
  const reject = (id: string) => {
    const reason = prompt(t('action.cancel.reason'))?.trim();
    if (!reason) return;
    void run(() =>
      sync
        .write('bookings', 'update', { status: 'cancelled', cancelReason: reason }, id)
        .then(() => undefined),
    );
  };

  return (
    <Screen title={t('approvals.title')} back={back}>
      {days.length === 0 ? <p class="muted">{t('approvals.empty')}</p> : null}
      {days.map((day) => (
        <section class="stack" aria-label={formatDate(day.date)}>
          <h2 class="step-title">{formatDate(day.date)}</h2>
          <button
            type="button"
            class="primary"
            disabled={busy}
            onClick={() => approve(day.bookings.map((b) => b.id))}
          >
            {t('approvals.all', { n: day.bookings.length })}
          </button>
          <ul class="list">
            {day.bookings.map((b) => {
              const patient = patients.get(b.patientId);
              return (
                <li>
                  <span class="grow">
                    <strong>{patient?.deletedAt == null ? (patient?.name ?? '…') : '…'}</strong>
                    <span class="muted small"> · {formatTime(utcToLocal(b.startAt).minutes)}</span>
                  </span>
                  <button type="button" disabled={busy} onClick={() => approve([b.id])}>
                    {t('action.approve')}
                  </button>
                  <button type="button" class="danger" disabled={busy} onClick={() => reject(b.id)}>
                    {t('approvals.reject')}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {error ? <p class="banner error">{error}</p> : null}
    </Screen>
  );
}
