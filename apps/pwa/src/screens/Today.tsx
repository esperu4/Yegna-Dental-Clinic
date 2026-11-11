/**
 * Today (home) and Week (PRD §8 items 3, 4, 6).
 *
 * Today: a vertical timeline from open to close, the lunch band shaded, blocks hatched, bookings as
 * cards (patient, procedure code, status). Above it: counters (booked · arrived · done) and the
 * waiting strip (arrived patients). The + button opens the booking sheet at the next free slot;
 * tapping an empty part of the timeline opens it at that time. Tapping a card shows its actions.
 *
 * Week: Monday–Saturday, how full each day is at a glance; tap a day to open it.
 */
import { useState } from 'preact/hooks';
import type { BookingRow, PatientRow, ProcedureRow } from '@yegna/shared/client';
import { GRID_STEP_MIN, addDays, localDateOf, weekdayName, weekdayOf } from '@yegna/time';
import { BookingSheet, type SheetMode } from '../components/BookingSheet.tsx';
import { QuickPrefs } from '../components/QuickPrefs.tsx';
import { SyncPill } from '../components/SyncPill.tsx';
import { BlockList, BlockSheet, DayRuleSheet } from '../components/doctorDay.tsx';
import { BookingDetails, NoticeList, StatusChip } from '../components/bookingCards.tsx';
import { locale, t } from '../i18n/index.ts';
import {
  useApprovals,
  useCallList,
  useDayPlan,
  usePatients,
  useProcedures,
  useWeekPlans,
} from '../lib/dayData.ts';
import { formatDate, formatTime } from '../lib/format.ts';
import { go } from '../lib/router.ts';
import { session } from '../lib/session.ts';
import { type DayPlan, dayRange, needsAttention, startMinOf } from '../lib/schedule.ts';

/** Timeline scale: 15 minutes = 24 px, so a 15-minute booking still has a 48 px-ish tap target with its padding. */
const PX_PER_MIN = 1.6;

export function Home() {
  const today = localDateOf(Date.now());
  const [date, setDate] = useState(today);
  const [view, setView] = useState<'day' | 'week'>('day');
  const [sheet, setSheet] = useState<SheetMode | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <main class="screen">
      <header class="bar">
        <h1>{t(view === 'week' ? 'week.title' : date === today ? 'home.title' : 'day.title')}</h1>
        <div class="segmented compact" role="group" aria-label={t('day.view')}>
          <button type="button" aria-pressed={view === 'day'} onClick={() => setView('day')}>
            {t('day.dayView')}
          </button>
          <button type="button" aria-pressed={view === 'week'} onClick={() => setView('week')}>
            {t('day.weekView')}
          </button>
        </div>
        <SyncPill />
        <QuickPrefs />
        <button type="button" class="icon" onClick={() => go('settings')} aria-label={t('nav.settings')}>
          ⚙
        </button>
      </header>
      <div class="content">
        <WorkLinks />
        <NoticeList onMove={(booking, patient) => setSheet({ kind: 'move', booking, patient })} />
        {view === 'day' ? (
          <DayView
            date={date}
            today={today}
            setDate={setDate}
            onSlot={(startMin) => setSheet({ kind: 'new', date, startMin })}
            onOpen={setOpen}
          />
        ) : (
          <WeekView
            date={date}
            onDay={(d) => {
              setDate(d);
              setView('day');
            }}
          />
        )}
      </div>
      <button
        type="button"
        class="fab"
        aria-label={t('sheet.title')}
        onClick={() => setSheet({ kind: 'new', date, startMin: null })}
      >
        +
      </button>
      {open ? (
        <BookingDetails
          bookingId={open}
          onClose={() => setOpen(null)}
          onMove={(booking, patient) => (setOpen(null), setSheet({ kind: 'move', booking, patient }))}
          onBookNext={(patient) => (
            setOpen(null),
            setSheet({ kind: 'new', date: addDays(date, 7), startMin: null, patient })
          )}
        />
      ) : null}
      {sheet ? <BookingSheet mode={sheet} onClose={() => setSheet(null)} /> : null}
    </main>
  );
}

/** Shortcuts to the call list (everyone) and approvals (Doctor), with how many are waiting. */
function WorkLinks() {
  const isDoctor = session.current.value?.user.role === 'doctor';
  const calls = useCallList();
  const approvals = useApprovals(isDoctor);
  const waiting = approvals?.days.reduce((n, d) => n + d.bookings.length, 0) ?? 0;
  return (
    <nav class="work-links">
      <button type="button" class="secondary" onClick={() => go('calls')}>
        {t('calls.nav', { n: calls?.length ?? 0 })}
      </button>
      {isDoctor ? (
        <button type="button" class="secondary" onClick={() => go('approvals')}>
          {t('approvals.nav', { n: waiting })}
        </button>
      ) : null}
      <button type="button" class="secondary" onClick={() => go('print')}>
        {t('print.nav')}
      </button>
    </nav>
  );
}

function DayView(props: {
  date: string;
  today: string;
  setDate: (d: string) => void;
  onSlot: (startMin: number) => void;
  onOpen: (bookingId: string) => void;
}) {
  const plan = useDayPlan(props.date);
  const [tool, setTool] = useState<'rule' | 'block' | null>(null);
  const patients = usePatients(plan?.bookings.map((b) => b.patientId) ?? []);
  const procedures = useProcedures();
  if (!plan || !patients || !procedures) return <p class="muted">{t('common.loading')}</p>;
  const waiting = plan.bookings.filter((b) => b.status === 'arrived');
  const attention = needsAttention(plan);
  const attentionIds = new Set(attention.map((b) => b.id));
  const isDoctor = session.current.value?.user.role === 'doctor';

  return (
    <>
      <div class="day-picker">
        <button
          type="button"
          class="icon"
          aria-label={t('day.previous')}
          onClick={() => props.setDate(addDays(props.date, -1))}
        >
          ‹
        </button>
        <span data-date={props.date}>
          {weekdayName(weekdayOf(props.date), locale.value)} · {formatDate(props.date)}
        </span>
        <button
          type="button"
          class="icon"
          aria-label={t('day.next')}
          onClick={() => props.setDate(addDays(props.date, 1))}
        >
          ›
        </button>
      </div>
      {props.date !== props.today ? (
        <button type="button" class="link" onClick={() => props.setDate(props.today)}>
          {t('day.backToToday')}
        </button>
      ) : null}

      <p class="counters">
        {t('day.counts', {
          booked: plan.counts.booked,
          arrived: plan.counts.arrived,
          done: plan.counts.done,
        })}
      </p>
      {waiting.length ? (
        <div class="waiting" aria-label={t('day.waiting')}>
          <span class="muted small">{t('day.waiting')}</span>
          {waiting.map((b) => (
            <button type="button" class="chip-button" onClick={() => props.onOpen(b.id)}>
              {patients.get(b.patientId)?.name ?? '…'}
            </button>
          ))}
        </div>
      ) : null}

      {isDoctor ? (
        <div class="actions">
          <button type="button" onClick={() => setTool('rule')}>
            {t('day.changeDay')}
          </button>
          {!plan.day.closed ? (
            <button type="button" onClick={() => setTool('block')}>
              {t('day.addBlock')}
            </button>
          ) : null}
        </div>
      ) : null}
      {isDoctor ? <BlockList blocks={plan.blocks} date={plan.date} /> : null}
      {tool === 'rule' ? (
        <DayRuleSheet
          date={plan.date}
          day={plan.day}
          rule={plan.rule ?? undefined}
          onClose={() => setTool(null)}
        />
      ) : null}
      {tool === 'block' ? <BlockSheet date={plan.date} day={plan.day} onClose={() => setTool(null)} /> : null}

      {attention.length ? (
        <section class="attention" aria-label={t('day.attention')}>
          <h2>{t('day.attention')}</h2>
          {attention.map((b) => (
            <button type="button" class="attention-row" onClick={() => props.onOpen(b.id)}>
              <span class="booking-name">{patients.get(b.patientId)?.name ?? '…'}</span>
              <span class="small">{formatTime(startMinOf(b))}</span>
              <StatusChip booking={b} />
            </button>
          ))}
        </section>
      ) : null}

      {plan.day.closed ? (
        <p class="banner warn" data-plan-date={plan.date}>
          {plan.holiday
            ? t('day.holiday', { name: locale.value === 'am' ? plan.holiday.nameAm : plan.holiday.nameEn })
            : t('day.closed')}
        </p>
      ) : (
        <Timeline
          plan={plan}
          patients={patients}
          codes={procedures}
          onSlot={props.onSlot}
          onOpen={props.onOpen}
          hidden={attentionIds}
        />
      )}
    </>
  );
}

function Timeline(props: {
  plan: DayPlan;
  patients: Map<string, PatientRow>;
  codes: Map<string, ProcedureRow>;
  onSlot: (startMin: number) => void;
  onOpen: (id: string) => void;
  /** Bookings already listed under "Needs attention" that would fall off the chart. */
  hidden: ReadonlySet<string>;
}) {
  const { plan } = props;
  if (plan.day.closed) return null;
  const { openAt, closeAt, lunchStart, lunchEnd } = plan.day;
  const y = (min: number) => (min - openAt) * PX_PER_MIN;
  const hours: number[] = [];
  for (let m = Math.ceil(openAt / 60) * 60; m <= closeAt; m += 60) hours.push(m);
  const columns = clashColumns(plan.bookings);

  function slotAt(e: MouseEvent) {
    const top = (e.currentTarget as HTMLElement).getBoundingClientRect().top;
    const min = openAt + Math.floor((e.clientY - top) / PX_PER_MIN / GRID_STEP_MIN) * GRID_STEP_MIN;
    if (min >= openAt && min < closeAt) props.onSlot(min);
  }

  return (
    <div
      class="timeline"
      data-plan-date={plan.date}
      style={{ height: `${y(closeAt)}px` }}
      onClick={slotAt}
      aria-label={t('day.timeline')}
    >
      {hours.map((m) => (
        <div class="hour" style={{ top: `${y(m)}px` }} aria-hidden="true">
          <span>{formatTime(m)}</span>
        </div>
      ))}
      {lunchStart !== null && lunchEnd !== null ? (
        <div
          class="band lunch"
          style={{ top: `${y(lunchStart)}px`, height: `${(lunchEnd - lunchStart) * PX_PER_MIN}px` }}
        >
          <span>{t('hours.lunch')}</span>
        </div>
      ) : null}
      {plan.blocks.map((b) => {
        // A block may start before this day or end after it: clip it to the open hours.
        const from = Math.max(openAt, minuteOnDay(b.startAt, plan.date));
        const to = Math.min(closeAt, minuteOnDay(b.endAt, plan.date));
        return to > from ? (
          <div class="band block" style={{ top: `${y(from)}px`, height: `${(to - from) * PX_PER_MIN}px` }}>
            <span>{b.reason ?? t('day.blocked')}</span>
          </div>
        ) : null;
      })}
      {plan.bookings.map((b) => {
        const start = startMinOf(b);
        if (props.hidden.has(b.id) && (start < openAt || start + b.durationMin > closeAt)) return null;
        const patient = props.patients.get(b.patientId);
        const procedure = b.procedureId ? props.codes.get(b.procedureId) : undefined;
        const col = columns.get(b.id) ?? 0;
        return (
          <button
            type="button"
            class={`booking status-${b.status}${(b as { provisional?: boolean }).provisional ? ' provisional' : ''}`}
            style={{
              top: `${y(start)}px`,
              height: `${Math.max(b.durationMin * PX_PER_MIN, 40)}px`,
              left: col ? '55%' : undefined,
              ...(procedure ? { borderLeftColor: procedure.color } : {}),
            }}
            onClick={(e) => {
              e.stopPropagation();
              props.onOpen(b.id);
            }}
          >
            <span class="booking-name">{patient?.name ?? '…'}</span>
            <span class="small">
              {formatTime(start)}
              {procedure ? ` · ${procedure.code}` : ''}
            </span>
            <StatusChip booking={b} />
          </button>
        );
      })}
    </div>
  );
}

/** Minutes since midnight of `utcMs` on `date`: below 0 if earlier, 1440 or more if later. */
function minuteOnDay(utcMs: number, date: string): number {
  return (utcMs - dayRange(date).start) / 60_000;
}

/** Overlapping bookings (clashes) are drawn side by side: the later one in a second column. */
function clashColumns(bookings: readonly BookingRow[]): Map<string, number> {
  const columns = new Map<string, number>();
  bookings.forEach((b, i) => {
    const overlaps = bookings
      .slice(0, i)
      .some(
        (o) =>
          columns.get(o.id) === 0 &&
          o.startAt < b.startAt + b.durationMin * 60_000 &&
          b.startAt < o.startAt + o.durationMin * 60_000,
      );
    columns.set(b.id, overlaps ? 1 : 0);
  });
  return columns;
}

function WeekView(props: { date: string; onDay: (date: string) => void }) {
  // The week (Monday–Saturday) containing the selected date.
  const monday = addDays(props.date, -((weekdayOf(props.date) + 6) % 7));
  const plans = useWeekPlans(monday, 6);
  if (!plans) return <p class="muted">{t('common.loading')}</p>;
  return (
    <>
      <div class="day-picker">
        <button
          type="button"
          class="icon"
          aria-label={t('week.previous')}
          onClick={() => props.onDay(addDays(monday, -7))}
        >
          ‹
        </button>
        <span>
          {formatDate(monday)} – {formatDate(addDays(monday, 5))}
        </span>
        <button
          type="button"
          class="icon"
          aria-label={t('week.next')}
          onClick={() => props.onDay(addDays(monday, 7))}
        >
          ›
        </button>
      </div>
      <ul class="week">
        {plans.map((plan) => {
          const fill = fullness(plan);
          return (
            <li>
              <button type="button" onClick={() => props.onDay(plan.date)}>
                <span class="week-day">
                  <strong>{weekdayName(weekdayOf(plan.date), locale.value)}</strong>
                  <span class="muted small">{formatDate(plan.date)}</span>
                </span>
                {needsAttention(plan).length ? (
                  <span class="attention-count">
                    {t('week.attention', { n: needsAttention(plan).length })}
                  </span>
                ) : null}
                {plan.day.closed ? (
                  <span class="muted">{t('day.closed')}</span>
                ) : (
                  <span class="week-fill">
                    <span class="meter" aria-hidden="true">
                      <span style={{ width: `${Math.round(fill * 100)}%` }} />
                    </span>
                    <span class="small">
                      {t('week.booked', { n: plan.counts.booked, free: Math.round((1 - fill) * 100) })}
                    </span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Share of the open minutes (lunch excluded) taken by active or done bookings. */
function fullness(plan: DayPlan): number {
  if (plan.day.closed) return 1;
  const lunch =
    plan.day.lunchStart !== null && plan.day.lunchEnd !== null ? plan.day.lunchEnd - plan.day.lunchStart : 0;
  const open = plan.day.closeAt - plan.day.openAt - lunch;
  // Clash and needs-fixing bookings take no time until they are fixed.
  const used = plan.bookings
    .filter((b) => b.status !== 'no_show' && b.status !== 'clash' && b.status !== 'needs_fixing')
    .reduce((sum, b) => sum + b.durationMin, 0);
  return open > 0 ? Math.min(1, used / open) : 1;
}
