/**
 * Clinic configuration pieces shared by Settings and the setup wizard (PRD §8 items 2 and 12):
 * language and calendar, weekly clinic hours, and procedures.
 *
 * Hours and procedures are written to the working copy and synced (PRD §7.2): saving works
 * offline. Language and calendar belong to the user account and are saved online (`/me`).
 */
import { useEffect, useState } from 'preact/hooks';
import type { CalendarPref, Locale, ProcedureRow } from '@yegna/shared/client';
import { CLINIC_WEEK, type WeekdayHours, type WeeklyDefaults, weekdayName } from '@yegna/time';
import { calendarPref, locale, t } from '../i18n/index.ts';
import { db } from '../lib/db.ts';
import { formatTime } from '../lib/format.ts';
import { live, useLive } from '../lib/live.ts';
import {
  DURATION_CHOICES,
  EMPTY_PROCEDURE,
  PROCEDURE_COLORS,
  type ProcedureInput,
  nextSort,
  procedureFields,
  procedureProblems,
  sortProcedures,
} from '../lib/procedures.ts';
import { preferences } from '../lib/preferences.ts';
import { sync } from '../lib/sync.ts';
import {
  STANDARD_DAY,
  TIME_CHOICES,
  weekdayProblem,
  weeklyHoursOf,
  withWeekday,
} from '../lib/weeklyHours.ts';
import { Field, useAction } from './ui.tsx';

export function PreferencesPicker() {
  const { busy, error, run } = useAction();

  // Applies at once and works offline (lib/preferences.ts).
  function save(patch: { locale?: Locale; calendar?: CalendarPref }) {
    void run(() => preferences.set(patch));
  }

  return (
    <div class="stack">
      <h2>{t('settings.language')}</h2>
      <div class="segmented" role="group" aria-label={t('settings.language')}>
        {(['am', 'en'] as const).map((l) => (
          <button
            type="button"
            aria-pressed={locale.value === l}
            disabled={busy}
            onClick={() => save({ locale: l })}
          >
            {l === 'am' ? 'አማርኛ' : 'English'}
          </button>
        ))}
      </div>
      <h2>{t('settings.calendar')}</h2>
      <div class="segmented" role="group" aria-label={t('settings.calendar')}>
        {(['ethiopian', 'gregorian'] as const).map((c) => (
          <button
            type="button"
            aria-pressed={calendarPref.value === c}
            disabled={busy}
            onClick={() => save({ calendar: c })}
          >
            {t(c === 'ethiopian' ? 'settings.calendar.ethiopian' : 'settings.calendar.gregorian')}
          </button>
        ))}
      </div>
      {error ? <p class="banner error">{error}</p> : null}
    </div>
  );
}

function TimeSelect(props: { label: string; value: number; onChange: (minutes: number) => void }) {
  return (
    <label class="field">
      <span class="label">{props.label}</span>
      <select value={props.value} onChange={(e) => props.onChange(Number(e.currentTarget.value))}>
        {TIME_CHOICES.map((m) => (
          <option value={m}>{formatTime(m)}</option>
        ))}
      </select>
    </label>
  );
}

/** The Doctor's weekly hours (PRD §6): open days, opening and closing time, optional lunch break. */
export function HoursEditor() {
  // null = no settings row yet (the PRD defaults apply); undefined = still loading.
  const settings = useLive(async () => (await db.settings.get('settings')) ?? null, []);
  const [week, setWeek] = useState<WeeklyDefaults | null>(null);
  const [saved, setSaved] = useState(false);
  const { busy, error, setError, run } = useAction();

  // Start from the synced hours once they load (or the PRD defaults).
  useEffect(() => {
    if (week === null && settings !== undefined) setWeek(weeklyHoursOf(settings ?? undefined));
  }, [settings]);
  if (!week) return <p class="muted">{t('common.loading')}</p>;

  const change = (weekday: number, hours: WeekdayHours | null) => {
    setSaved(false);
    setWeek(withWeekday(week, weekday, hours));
  };

  function save() {
    const problem = CLINIC_WEEK.map((d) => weekdayProblem(week![d] ?? null)).find((p) => p !== null);
    if (problem) return setError(t(problem));
    void run(async () => {
      await sync.write('settings', 'update', { weeklyHours: week }, 'settings');
      setSaved(true);
    });
  }

  return (
    <div class="stack">
      {CLINIC_WEEK.map((weekday) => {
        const hours = week[weekday] ?? null;
        const problem = weekdayProblem(hours);
        return (
          <fieldset class="card stack">
            <legend>{weekdayName(weekday, locale.value)}</legend>
            <div class="segmented" role="group" aria-label={weekdayName(weekday, locale.value)}>
              <button
                type="button"
                aria-pressed={hours !== null}
                onClick={() => change(weekday, hours ?? STANDARD_DAY)}
              >
                {t('hours.open')}
              </button>
              <button type="button" aria-pressed={hours === null} onClick={() => change(weekday, null)}>
                {t('hours.closed')}
              </button>
            </div>
            {hours ? (
              <>
                <div class="pair">
                  <TimeSelect
                    label={t('hours.opens')}
                    value={hours.openAt}
                    onChange={(openAt) => change(weekday, { ...hours, openAt })}
                  />
                  <TimeSelect
                    label={t('hours.closes')}
                    value={hours.closeAt}
                    onChange={(closeAt) => change(weekday, { ...hours, closeAt })}
                  />
                </div>
                <label class="check">
                  <input
                    type="checkbox"
                    checked={hours.lunchStart !== null}
                    onChange={(e) =>
                      change(
                        weekday,
                        e.currentTarget.checked
                          ? { ...hours, lunchStart: STANDARD_DAY.lunchStart, lunchEnd: STANDARD_DAY.lunchEnd }
                          : { ...hours, lunchStart: null, lunchEnd: null },
                      )
                    }
                  />
                  {t('hours.lunch')}
                </label>
                {hours.lunchStart !== null && hours.lunchEnd !== null ? (
                  <div class="pair">
                    <TimeSelect
                      label={t('hours.lunchFrom')}
                      value={hours.lunchStart}
                      onChange={(lunchStart) => change(weekday, { ...hours, lunchStart })}
                    />
                    <TimeSelect
                      label={t('hours.lunchTo')}
                      value={hours.lunchEnd}
                      onChange={(lunchEnd) => change(weekday, { ...hours, lunchEnd })}
                    />
                  </div>
                ) : null}
                {problem ? <p class="error">{t(problem)}</p> : null}
              </>
            ) : null}
          </fieldset>
        );
      })}
      {error ? <p class="banner error">{error}</p> : null}
      {saved ? <p class="banner">{t('common.saved')}</p> : null}
      <button type="button" class="primary" disabled={busy} onClick={save}>
        {t('common.save')}
      </button>
    </div>
  );
}

type Editing = { id: string | null; input: ProcedureInput };

/** The Doctor's procedures (PRD §5, §8): add, edit, take out of use, delete. */
export function ProcedureManager() {
  const procedures = useLive(async () => sortProcedures(live(await db.procedures.toArray())), []);
  const [editing, setEditing] = useState<Editing | null>(null);
  const { busy, error, run } = useAction();

  if (!procedures) return <p class="muted">{t('common.loading')}</p>;
  const name = (p: ProcedureRow) => (locale.value === 'am' ? p.nameAm : p.nameEn);

  function remove(p: ProcedureRow) {
    if (!confirm(t('procedures.delete.confirm', { name: name(p) }))) return;
    void run(async () => {
      await sync.write('procedures', 'delete', {}, p.id);
    });
  }

  return (
    <div class="stack">
      {procedures.length === 0 && !editing ? <p class="muted">{t('procedures.empty')}</p> : null}
      <ul class="list">
        {procedures.map((p) =>
          editing?.id === p.id ? (
            <li>
              <ProcedureForm
                editing={editing}
                others={procedures.filter((o) => o.id !== p.id)}
                onDone={() => setEditing(null)}
              />
            </li>
          ) : (
            <li class={p.active ? undefined : 'inactive'}>
              <span class="chip" style={{ background: p.color }}>
                {p.code}
              </span>
              <span class="grow">
                {name(p)}
                <span class="muted small">
                  {' · '}
                  {t('common.minutes', { n: p.durationMin })}
                  {p.active ? '' : ` · ${t('procedures.inactive')}`}
                </span>
              </span>
              <div class="actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setEditing({ id: p.id, input: { ...p } })}
                >
                  {t('common.edit')}
                </button>
                <button type="button" class="danger" disabled={busy} onClick={() => remove(p)}>
                  {t('common.delete')}
                </button>
              </div>
            </li>
          ),
        )}
      </ul>
      {editing?.id === null ? (
        <ProcedureForm
          editing={editing}
          others={procedures}
          onDone={() => setEditing(null)}
          sort={nextSort(procedures)}
        />
      ) : (
        <button
          type="button"
          class="secondary"
          onClick={() => setEditing({ id: null, input: EMPTY_PROCEDURE })}
        >
          + {t('procedures.add')}
        </button>
      )}
      {error ? <p class="banner error">{error}</p> : null}
    </div>
  );
}

function ProcedureForm(props: {
  editing: Editing;
  others: ProcedureRow[];
  onDone: () => void;
  sort?: number;
}) {
  const [input, setInput] = useState<ProcedureInput>(props.editing.input);
  const [shown, setShown] = useState(false);
  const { busy, error, run } = useAction();
  const problems = procedureProblems(input, props.others);
  const problem = (field: keyof ProcedureInput) => (shown && problems[field] ? t(problems[field]!) : null);
  const set = (patch: Partial<ProcedureInput>) => setInput({ ...input, ...patch });

  function submit(e: Event) {
    e.preventDefault();
    setShown(true);
    if (Object.keys(problems).length) return;
    const { id } = props.editing;
    const original = props.editing.input as ProcedureInput & { sort?: number };
    void run(async () => {
      if (id) await sync.write('procedures', 'update', procedureFields(input, original.sort ?? 0), id);
      else await sync.write('procedures', 'create', procedureFields(input, props.sort ?? 0));
      props.onDone();
    });
  }

  return (
    <form class="card stack" onSubmit={submit} noValidate>
      <Field
        label={t('procedures.nameAm')}
        value={input.nameAm}
        error={problem('nameAm')}
        onInput={(e) => set({ nameAm: e.currentTarget.value })}
      />
      <Field
        label={t('procedures.nameEn')}
        value={input.nameEn}
        error={problem('nameEn')}
        onInput={(e) => set({ nameEn: e.currentTarget.value })}
      />
      <Field
        label={t('procedures.code')}
        hint={t('procedures.code.hint')}
        value={input.code}
        maxLength={3}
        autoCapitalize="characters"
        error={problem('code')}
        onInput={(e) => set({ code: e.currentTarget.value })}
      />
      <label class="field">
        <span class="label">{t('procedures.duration')}</span>
        <select
          value={input.durationMin}
          onChange={(e) => set({ durationMin: Number(e.currentTarget.value) })}
        >
          {DURATION_CHOICES.map((d) => (
            <option value={d}>{t('common.minutes', { n: d })}</option>
          ))}
        </select>
        {problem('durationMin') ? <span class="error">{problem('durationMin')}</span> : null}
      </label>
      <div class="field">
        <span class="label">{t('procedures.color')}</span>
        <div class="swatches" role="radiogroup" aria-label={t('procedures.color')}>
          {PROCEDURE_COLORS.map((c) => (
            <button
              type="button"
              role="radio"
              aria-checked={input.color === c}
              aria-label={c}
              class="swatch"
              style={{ background: c }}
              onClick={() => set({ color: c })}
            />
          ))}
        </div>
      </div>
      <label class="check">
        <input
          type="checkbox"
          checked={input.active}
          onChange={(e) => set({ active: e.currentTarget.checked })}
        />
        {t('procedures.active')}
      </label>
      {error ? <p class="banner error">{error}</p> : null}
      <div class="actions">
        <button type="submit" class="primary" disabled={busy}>
          {t('common.save')}
        </button>
        <button type="button" onClick={props.onDone}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}
