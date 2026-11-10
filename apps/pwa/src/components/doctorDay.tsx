/**
 * The Doctor's tools for one day (PRD §6, §9): a day rule ("today I leave at 11:30", or closed)
 * and time blocks. Both are hard limits for bookings. Written to the working copy and synced.
 */
import { useState } from 'preact/hooks';
import type { BlockRow, DayRuleRow } from '@yegna/shared/client';
import { type ResolvedDay, gridSlots, localToUtc } from '@yegna/time';
import { t } from '../i18n/index.ts';
import { formatDate, formatTime } from '../lib/format.ts';
import { sync } from '../lib/sync.ts';
import { TIME_CHOICES, weekdayProblem } from '../lib/weeklyHours.ts';
import { Field, useAction } from './ui.tsx';

function TimeSelect(props: {
  label: string;
  value: number;
  choices: readonly number[];
  onChange: (m: number) => void;
}) {
  return (
    <label class="field">
      <span class="label">{props.label}</span>
      <select value={props.value} onChange={(e) => props.onChange(Number(e.currentTarget.value))}>
        {props.choices.map((m) => (
          <option value={m}>{formatTime(m)}</option>
        ))}
      </select>
    </label>
  );
}

function Sheet(props: { title: string; onClose: () => void; children: preact.ComponentChildren }) {
  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <section class="sheet stack" aria-label={props.title}>
        <h2 class="step-title">{props.title}</h2>
        {props.children}
      </section>
    </div>
  );
}

/** Change one date's hours, or close it. `day` is the day as it resolves now. */
export function DayRuleSheet(props: {
  date: string;
  day: ResolvedDay;
  rule: DayRuleRow | undefined;
  onClose: () => void;
}) {
  const base = props.day.closed ? { openAt: 540, closeAt: 1080, lunchStart: 720, lunchEnd: 780 } : props.day;
  const [closed, setClosed] = useState(props.rule?.closed ?? props.day.closed);
  const [openAt, setOpenAt] = useState(base.openAt);
  const [closeAt, setCloseAt] = useState(base.closeAt);
  const [note, setNote] = useState(props.rule?.note ?? '');
  const { busy, error, setError, run } = useAction();
  // Lunch is kept only if it still fits ("today I leave at 11:30" drops it for the day).
  const lunchFits =
    base.lunchStart !== null &&
    base.lunchEnd !== null &&
    base.lunchStart >= openAt &&
    base.lunchEnd <= closeAt;
  const hours = {
    openAt,
    closeAt,
    lunchStart: lunchFits ? base.lunchStart : null,
    lunchEnd: lunchFits ? base.lunchEnd : null,
  };

  function save() {
    const problem = closed ? null : weekdayProblem(hours);
    if (problem) return setError(t(problem));
    void run(async () => {
      await sync.write(
        'dayRules',
        'create',
        closed
          ? {
              closed: true,
              openAt: null,
              closeAt: null,
              lunchStart: null,
              lunchEnd: null,
              note: note.trim() || null,
            }
          : { closed: false, ...hours, note: note.trim() || null },
        props.date,
      );
      props.onClose();
    });
  }

  function reset() {
    void run(async () => {
      await sync.write('dayRules', 'delete', {}, props.date);
      props.onClose();
    });
  }

  return (
    <Sheet title={t('dayRule.title', { date: formatDate(props.date) })} onClose={props.onClose}>
      <div class="segmented" role="group" aria-label={t('dayRule.title', { date: formatDate(props.date) })}>
        <button type="button" aria-pressed={!closed} onClick={() => setClosed(false)}>
          {t('hours.open')}
        </button>
        <button type="button" aria-pressed={closed} onClick={() => setClosed(true)}>
          {t('hours.closed')}
        </button>
      </div>
      {!closed ? (
        <div class="pair">
          <TimeSelect label={t('hours.opens')} value={openAt} choices={TIME_CHOICES} onChange={setOpenAt} />
          <TimeSelect
            label={t('hours.closes')}
            value={closeAt}
            choices={TIME_CHOICES}
            onChange={setCloseAt}
          />
        </div>
      ) : null}
      <Field
        label={t('dayRule.note')}
        value={note}
        maxLength={200}
        onInput={(e) => setNote(e.currentTarget.value)}
      />
      <p class="muted small">{t('dayRule.hint')}</p>
      {error ? <p class="banner error">{error}</p> : null}
      <div class="actions spread">
        {props.rule && props.rule.deletedAt == null ? (
          <button type="button" class="link" disabled={busy} onClick={reset}>
            {t('dayRule.reset')}
          </button>
        ) : (
          <span />
        )}
        <button type="button" class="primary" disabled={busy} onClick={save}>
          {t('common.save')}
        </button>
      </div>
    </Sheet>
  );
}

/** Block part of an open day: nothing can be booked inside it. */
export function BlockSheet(props: { date: string; day: ResolvedDay; onClose: () => void }) {
  const slots = gridSlots(props.day);
  const ends = props.day.closed ? [] : [...slots.slice(1), props.day.closeAt];
  const [from, setFrom] = useState(slots[0] ?? 540);
  const [to, setTo] = useState(ends[0] ?? 555);
  const [reason, setReason] = useState('');
  const { busy, error, setError, run } = useAction();

  function save() {
    if (to <= from) return setError(t('block.error.order'));
    void run(async () => {
      await sync.write('blocks', 'create', {
        startAt: localToUtc(props.date, from),
        endAt: localToUtc(props.date, to),
        reason: reason.trim() || null,
      });
      props.onClose();
    });
  }

  return (
    <Sheet title={t('block.title', { date: formatDate(props.date) })} onClose={props.onClose}>
      <div class="pair">
        <TimeSelect label={t('block.from')} value={from} choices={slots} onChange={setFrom} />
        <TimeSelect label={t('block.to')} value={to} choices={ends} onChange={setTo} />
      </div>
      <Field
        label={t('block.reason')}
        value={reason}
        maxLength={200}
        onInput={(e) => setReason(e.currentTarget.value)}
      />
      {error ? <p class="banner error">{error}</p> : null}
      <div class="actions spread">
        <button type="button" onClick={props.onClose}>
          {t('common.cancel')}
        </button>
        <button type="button" class="primary" disabled={busy} onClick={save}>
          {t('common.save')}
        </button>
      </div>
    </Sheet>
  );
}

/** The day's blocks, each removable by the Doctor. */
export function BlockList(props: { blocks: readonly BlockRow[]; date: string }) {
  const { busy, run } = useAction();
  if (!props.blocks.length) return null;
  const minute = (ms: number) => Math.round((ms - localToUtc(props.date, 0)) / 60_000);
  return (
    <ul class="list">
      {props.blocks.map((b) => (
        <li>
          <span>
            {t('day.blocked')}: {formatTime(Math.max(0, minute(b.startAt)))}–
            {formatTime(Math.min(1439, minute(b.endAt)))}
            {b.reason ? ` · ${b.reason}` : ''}
          </span>
          <button
            type="button"
            class="danger"
            disabled={busy}
            onClick={() => void run(() => sync.write('blocks', 'delete', {}, b.id).then(() => undefined))}
          >
            {t('common.delete')}
          </button>
        </li>
      ))}
    </ul>
  );
}
