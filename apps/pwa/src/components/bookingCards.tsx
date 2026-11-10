/**
 * Booking cards (PRD §8 item 6): status chip, the details sheet with its actions, and the
 * notices for refused changes and clashes (PRD §7.5). Every action writes to the working copy
 * and syncs (it works offline); only actions the server accepts are offered (cardActions).
 */
import { useEffect } from 'preact/hooks';
import type { BookingRow, PatientRow, SyncRejectReason } from '@yegna/shared/client';
import { utcToLocal } from '@yegna/time';
import { type MessageKey, locale, t } from '../i18n/index.ts';
import { db } from '../lib/db.ts';
import { formatDate, formatPhone, formatTime } from '../lib/format.ts';
import { useLive } from '../lib/live.ts';
import { type CardAction, cardActions } from '../lib/schedule.ts';
import { session } from '../lib/session.ts';
import { sync } from '../lib/sync.ts';
import { useAction } from './ui.tsx';

const STATUS_KEYS: Record<BookingRow['status'], MessageKey> = {
  pending_approval: 'status.pending_approval',
  approved: 'status.approved',
  arrived: 'status.arrived',
  done: 'status.done',
  no_show: 'status.no_show',
  cancelled: 'status.cancelled',
  clash: 'status.clash',
  needs_fixing: 'status.needs_fixing',
};

export function StatusChip(props: { booking: BookingRow & { provisional?: boolean } }) {
  const { booking } = props;
  return (
    <span class={`status status-${booking.status}`}>
      {booking.provisional ? t('status.provisional') : t(STATUS_KEYS[booking.status])}
    </span>
  );
}

const ACTION_KEYS: Record<CardAction, MessageKey> = {
  approve: 'action.approve',
  arrived: 'action.arrived',
  done: 'action.done',
  noShow: 'action.noShow',
  reschedule: 'action.reschedule',
  cancel: 'action.cancel',
  call: 'action.call',
  bookNext: 'action.bookNext',
};

const STATUS_FOR: Partial<Record<CardAction, BookingRow['status']>> = {
  approve: 'approved',
  arrived: 'arrived',
  done: 'done',
  noShow: 'no_show',
};

export function BookingDetails(props: {
  bookingId: string;
  onClose: () => void;
  onMove: (booking: BookingRow, patient: PatientRow | undefined) => void;
  onBookNext: (patient: PatientRow) => void;
}) {
  const data = useLive(async () => {
    const booking = await db.bookings.get(props.bookingId);
    if (!booking) return null;
    const [patient, procedure] = await Promise.all([
      db.patients.get(booking.patientId),
      booking.procedureId ? db.procedures.get(booking.procedureId) : undefined,
    ]);
    return { booking, patient: patient?.deletedAt == null ? patient : undefined, procedure };
  }, [props.bookingId]);
  const { busy, error, run } = useAction();
  const role = session.current.value?.user.role ?? 'staff';
  // The booking vanished (e.g. a refused create was rolled back): close the sheet.
  useEffect(() => {
    if (data === null) props.onClose();
  }, [data]);
  if (!data) return null;
  const { booking, patient, procedure } = data;
  const { date, minutes } = utcToLocal(booking.startAt);

  function act(action: CardAction) {
    if (action === 'call') return;
    if (action === 'reschedule') return props.onMove(booking, patient);
    if (action === 'bookNext') return patient && props.onBookNext(patient);
    if (action === 'cancel') {
      const reason = prompt(t('action.cancel.reason'))?.trim();
      if (!reason) return;
      void run(() =>
        sync
          .write('bookings', 'update', { status: 'cancelled', cancelReason: reason }, booking.id)
          .then(props.onClose),
      );
      return;
    }
    void run(() =>
      sync.write('bookings', 'update', { status: STATUS_FOR[action] }, booking.id).then(() => undefined),
    );
  }

  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <section class="sheet stack" aria-label={patient?.name ?? t('status.clash')}>
        <h2 class="step-title">{patient?.name ?? '…'}</h2>
        <p>
          {formatDate(date)} · {formatTime(minutes)} · {t('common.minutes', { n: booking.durationMin })}
          {procedure
            ? ` · ${procedure.code} ${locale.value === 'am' ? procedure.nameAm : procedure.nameEn}`
            : ''}
        </p>
        <StatusChip booking={booking} />
        {booking.note ? <p class="muted">{booking.note}</p> : null}
        {booking.status === 'clash' ? <p class="banner warn">{t('notice.clash.move')}</p> : null}
        {booking.status === 'needs_fixing' ? <p class="banner warn">{t('notice.needsFixing.move')}</p> : null}
        <div class="actions">
          {cardActions(booking, role, Date.now())
            // Booking the next visit needs the patient; the other actions work without it.
            .filter((action) => patient || (action !== 'bookNext' && action !== 'call'))
            .map((action) =>
              action === 'call' ? (
                patient ? (
                  <a class="button" href={`tel:${patient.phoneE164}`}>
                    {t(ACTION_KEYS.call)} {formatPhone(patient.phoneE164)}
                  </a>
                ) : null
              ) : (
                <button
                  type="button"
                  class={
                    action === 'cancel'
                      ? 'danger'
                      : action === 'approve' || action === 'arrived' || action === 'done'
                        ? 'primary'
                        : undefined
                  }
                  disabled={busy}
                  onClick={() => act(action)}
                >
                  {t(ACTION_KEYS[action])}
                </button>
              ),
            )}
        </div>
        {error ? <p class="banner error">{error}</p> : null}
        <button type="button" onClick={props.onClose}>
          {t('common.close')}
        </button>
      </section>
    </div>
  );
}

const REASON_KEYS: Partial<Record<SyncRejectReason, MessageKey>> = {
  closed_day: 'sheet.error.closed',
  holiday: 'sheet.error.holiday',
  before_open: 'sheet.error.beforeOpen',
  after_close: 'sheet.error.afterClose',
  in_block: 'sheet.error.inBlock',
  forbidden: 'notice.reason.forbidden',
  invalid_transition: 'notice.reason.changed',
  not_found: 'notice.reason.gone',
  patient_not_found: 'notice.reason.gone',
  procedure_not_found: 'notice.reason.gone',
  phone_taken: 'notice.reason.phoneTaken',
  code_taken: 'procedures.error.codeTaken',
  call_outdated: 'notice.reason.callOutdated',
};

/** Refused changes and clashes (PRD §7.5, §9: "a forbidden op is rejected with a reason shown"). */
export function NoticeList(props: {
  onMove: (booking: BookingRow, patient: PatientRow | undefined) => void;
}) {
  const notices = sync.notices.value;
  const rows = useLive(
    async () =>
      Promise.all(
        notices.map(async (n) => {
          const booking = n.entity === 'bookings' ? await db.bookings.get(n.entityId) : undefined;
          const found = booking ? await db.patients.get(booking.patientId) : undefined;
          // Never show a deleted patient (its row may still be on the device until the tombstone arrives).
          const patient = found?.deletedAt == null ? found : undefined;
          return { notice: n, booking: booking?.deletedAt == null ? booking : undefined, patient };
        }),
      ),
    [notices],
  );
  if (!rows?.length) return null;
  return (
    <ul class="notices">
      {rows.map(({ notice, booking, patient }) => (
        <li class="banner warn">
          {notice.kind !== 'rejected' && booking ? (
            <button type="button" class="link" onClick={() => props.onMove(booking, patient)}>
              {t(notice.kind === 'clash' ? 'notice.clash' : 'notice.needsFixing', {
                name: patient?.name ?? '…',
                when: `${formatDate(utcToLocal(booking.startAt).date)} ${formatTime(utcToLocal(booking.startAt).minutes)}`,
                reason: t(REASON_KEYS[notice.reason!] ?? 'notice.reason.other'),
              })}
            </button>
          ) : (
            <span>
              {t('notice.rejected', { reason: t(REASON_KEYS[notice.reason!] ?? 'notice.reason.other') })}
            </span>
          )}
          <button type="button" class="link" onClick={() => void sync.dismissNotice(notice.opId)}>
            {t('notice.dismiss')}
          </button>
        </li>
      ))}
    </ul>
  );
}
