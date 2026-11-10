/**
 * The booking sheet (PRD §8 item 5), the critical path: ≤ 3 taps + typing for a returning patient.
 * Phone has focus; from 4 digits it suggests patients from the working copy; picking one fills the
 * name. No match: type the name (Ge'ez or Latin; names are searched too). Procedure chips are
 * optional; duration follows the procedure and moves in 15-minute steps. Hard errors (closed,
 * after close, block) stop Save; lunch asks "Book anyway?"; an overlap on this device is warned.
 *
 * Also used to move a booking (reschedule) and to book a patient's next visit.
 */
import { useEffect, useState } from 'preact/hooks';
import {
  type BookingRow,
  MAX_BOOKING_MIN,
  type PatientRow,
  type ProcedureRow,
  normalizeName,
  normalizePhone,
} from '@yegna/shared/client';
import { GRID_STEP_MIN, addDays, bookingDuration, gridSlots, localToUtc, utcToLocal } from '@yegna/time';
import { locale, t } from '../i18n/index.ts';
import { useAllPatients, useDayPlan, useProcedures } from '../lib/dayData.ts';
import { db } from '../lib/db.ts';
import { formatDate, formatPhone, formatTime } from '../lib/format.ts';
import { searchByName, searchByPhone } from '../lib/patientSearch.ts';
import { sortProcedures } from '../lib/procedures.ts';
import { checkDraft, freeSlots, nextFreeSlot } from '../lib/schedule.ts';
import { sync } from '../lib/sync.ts';
import { Field, useAction } from './ui.tsx';

export type SheetMode =
  | { kind: 'new'; date: string; startMin: number | null; patient?: PatientRow }
  | { kind: 'move'; booking: BookingRow; patient: PatientRow | undefined };

const BOOKING_ERRORS = {
  invalid_duration: 'sheet.error.duration',
  off_grid: 'sheet.error.duration',
  closed_day: 'sheet.error.closed',
  holiday: 'sheet.error.holiday',
  before_open: 'sheet.error.beforeOpen',
  after_close: 'sheet.error.afterClose',
  in_block: 'sheet.error.inBlock',
} as const;

export function BookingSheet(props: { mode: SheetMode; onClose: () => void }) {
  const { mode } = props;
  const moving = mode.kind === 'move' ? mode.booking : null;
  const [date, setDate] = useState(
    moving ? utcToLocal(moving.startAt).date : (mode as { date: string }).date,
  );
  const [startMin, setStartMin] = useState<number | null>(
    moving ? utcToLocal(moving.startAt).minutes : (mode as { startMin: number | null }).startMin,
  );
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<PatientRow | null>(
    mode.kind === 'new' ? (mode.patient ?? null) : null,
  );
  const [procedureId, setProcedureId] = useState<string | null>(moving?.procedureId ?? null);
  const [durationMin, setDurationMin] = useState<number | null>(moving?.durationMin ?? null);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const plan = useDayPlan(date);
  const procedures = useProcedures();
  const patients = useAllPatients();
  const unspecified = useUnspecifiedDuration();

  const procedure = procedureId ? procedures?.get(procedureId) : undefined;
  const duration = durationMin ?? bookingDuration(procedure?.durationMin, unspecified);

  // Fixing a clash or a booking that needs fixing: only free times are offered (PRD §7.5), and the
  // sheet opens at the first free one from the booking's current time.
  const fixing = moving !== null && (moving.status === 'clash' || moving.status === 'needs_fixing');
  const free = plan && fixing ? freeSlots(plan, duration, moving.id) : null;
  useEffect(() => {
    if (!free || (startMin !== null && free.includes(startMin))) return;
    setStartMin(free.find((m) => m >= (startMin ?? 0)) ?? free[0] ?? null);
  }, [free?.join(), startMin]);

  // Open at the next free slot when no time was given (the + button).
  useEffect(() => {
    if (plan && startMin === null) {
      const nowMin = date === utcToLocal(Date.now()).date ? utcToLocal(Date.now()).minutes : 0;
      setStartMin(nextFreeSlot(plan, duration, nowMin));
    }
  }, [plan, startMin]);

  if (!plan || !procedures || !patients) return null;

  const suggestions = picked
    ? []
    : [...searchByPhone(patients, phone), ...searchByName(patients, name)].filter(
        (p, i, all) => all.findIndex((q) => q.id === p.id) === i,
      );
  const check =
    startMin === null
      ? null
      : checkDraft(plan, { startMin, durationMin: duration, ...(moving ? { bookingId: moving.id } : {}) });
  const slots = free ?? gridSlots(plan.day);
  const patientShown = moving ? mode.patient : picked;

  function pick(p: PatientRow) {
    setPicked(p);
    setPhone(formatPhone(p.phoneE164));
    setName(p.name);
    setProblem(null);
  }

  function save(e: Event) {
    e.preventDefault();
    setProblem(null);
    if (startMin === null || !check) return setProblem(t('sheet.error.noTime'));
    if (check.errors.length) return setProblem(t(BOOKING_ERRORS[check.errors[0]!]));
    if (check.warnings.includes('lunch') && !confirm(t('sheet.lunchConfirm'))) return;
    const startAt = localToUtc(date, startMin);

    if (moving) {
      void run(async () => {
        await sync.write('bookings', 'update', { startAt, durationMin: duration }, moving.id);
        props.onClose();
      });
      return;
    }

    let patientId = picked?.id ?? null;
    let newPatient: Record<string, unknown> | null = null;
    if (!patientId) {
      const normalized = normalizePhone(phone);
      if (!normalized.ok)
        return setProblem(t(normalized.error === 'empty' ? 'sheet.error.phoneEmpty' : 'sheet.error.phone'));
      // The phone is the patient's key: an existing patient with this number is reused.
      const existing = patients!.find((p) => p.phoneE164 === normalized.e164);
      if (existing && name.trim() && normalizeName(name) !== normalizeName(existing.name)) {
        // The phone belongs to someone else on file: never attach the booking silently.
        pick(existing);
        return setProblem(t('sheet.error.phoneBelongs', { name: existing.name }));
      }
      if (existing) patientId = existing.id;
      else if (!name.trim()) return setProblem(t('sheet.error.name'));
      else newPatient = { name: name.trim(), phoneE164: normalized.e164 };
    }
    void run(async () => {
      if (newPatient) patientId = (await sync.write('patients', 'create', newPatient)).entityId;
      await sync.write('bookings', 'create', {
        patientId,
        procedureId,
        startAt,
        durationMin: duration,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      props.onClose();
    });
  }

  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <form
        class="sheet stack"
        onSubmit={save}
        noValidate
        aria-label={t(moving ? 'sheet.moveTitle' : 'sheet.title')}
      >
        <h2 class="step-title">{t(moving ? 'sheet.moveTitle' : 'sheet.title')}</h2>

        {patientShown ? (
          <p class="picked">
            <strong>{patientShown.name}</strong> · {formatPhone(patientShown.phoneE164)}
            {!moving ? (
              <button type="button" class="link" onClick={() => (setPicked(null), setPhone(''), setName(''))}>
                {t('sheet.changePatient')}
              </button>
            ) : null}
          </p>
        ) : (
          <>
            <Field
              autoFocus
              label={t('sheet.phone')}
              type="tel"
              inputMode="tel"
              autoComplete="off"
              value={phone}
              onInput={(e) => setPhone(e.currentTarget.value)}
            />
            <Field
              label={t('sheet.name')}
              autoComplete="off"
              value={name}
              onInput={(e) => setName(e.currentTarget.value)}
            />
            {suggestions.length ? (
              <ul class="suggestions" aria-label={t('sheet.suggestions')}>
                {suggestions.map((p) => (
                  <li>
                    <button type="button" onClick={() => pick(p)}>
                      <strong>{p.name}</strong> <span class="muted">{formatPhone(p.phoneE164)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}

        {!moving ? (
          <div class="chips" role="group" aria-label={t('sheet.procedure')}>
            {sortProcedures([...procedures.values()].filter((p) => p.active)).map((p: ProcedureRow) => (
              <button
                type="button"
                aria-pressed={procedureId === p.id}
                style={
                  procedureId === p.id ? { background: p.color, borderColor: p.color, color: '#fff' } : {}
                }
                onClick={() => {
                  setProcedureId(procedureId === p.id ? null : p.id);
                  setDurationMin(null);
                }}
              >
                {p.code} · {locale.value === 'am' ? p.nameAm : p.nameEn}
              </button>
            ))}
          </div>
        ) : null}

        <div class="day-picker">
          <button
            type="button"
            class="icon"
            aria-label={t('day.previous')}
            onClick={() => (setDate(addDays(date, -1)), setStartMin(null))}
          >
            ‹
          </button>
          <span>{formatDate(date)}</span>
          <button
            type="button"
            class="icon"
            aria-label={t('day.next')}
            onClick={() => (setDate(addDays(date, 1)), setStartMin(null))}
          >
            ›
          </button>
        </div>

        <div class="pair">
          <label class="field">
            <span class="label">{t('sheet.time')}</span>
            <select
              value={startMin ?? ''}
              onChange={(e) =>
                setStartMin(e.currentTarget.value === '' ? null : Number(e.currentTarget.value))
              }
            >
              {startMin === null ? <option value="">{t('sheet.noFreeTime')}</option> : null}
              {slots.map((m) => (
                <option value={m}>{formatTime(m)}</option>
              ))}
            </select>
          </label>
          <div class="field">
            <span class="label">{t('sheet.duration')}</span>
            <div class="stepper">
              <button
                type="button"
                aria-label={t('sheet.shorter')}
                disabled={duration <= GRID_STEP_MIN}
                onClick={() => setDurationMin(duration - GRID_STEP_MIN)}
              >
                −
              </button>
              <span>{t('common.minutes', { n: duration })}</span>
              <button
                type="button"
                aria-label={t('sheet.longer')}
                disabled={duration >= MAX_BOOKING_MIN}
                onClick={() => setDurationMin(duration + GRID_STEP_MIN)}
              >
                +
              </button>
            </div>
          </div>
        </div>

        {!moving ? (
          <Field
            label={t('sheet.note')}
            autoComplete="off"
            value={note}
            maxLength={280}
            onInput={(e) => setNote(e.currentTarget.value)}
          />
        ) : null}

        {plan.day.closed ? (
          <p class="banner error">{t(plan.holiday ? 'sheet.error.holiday' : 'sheet.error.closed')}</p>
        ) : null}
        {check?.errors.length && !plan.day.closed ? (
          <p class="banner error">{t(BOOKING_ERRORS[check.errors[0]!])}</p>
        ) : null}
        {check?.warnings.includes('lunch') ? <p class="banner warn">{t('sheet.lunchWarning')}</p> : null}
        {check?.clashWith ? <p class="banner warn">{t('sheet.clashWarning')}</p> : null}
        {problem || error ? <p class="banner error">{problem ?? error}</p> : null}

        <div class="actions spread">
          <button type="button" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" class="primary" disabled={busy}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </div>
  );
}

/** The default length for a booking without a procedure (settings; 60 min by default, PRD §21 #6). */
function useUnspecifiedDuration(): number {
  const [value, setValue] = useState<number | undefined>(undefined);
  useEffect(() => {
    void db.settings
      .get('settings')
      .then((s) => setValue(s && s.deletedAt == null ? s.unspecifiedDurationMin : undefined));
  }, []);
  return value ?? bookingDuration(undefined);
}
