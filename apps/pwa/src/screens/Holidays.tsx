/**
 * Holidays (Doctor; PRD §6). Fixed-date Ethiopian public holidays can be added for the year in one
 * tap; movable ones (Fasika, Siklet, Eid al-Fitr, Eid al-Adha, Mawlid) are entered by the Doctor,
 * with a reminder during Meskerem. Holidays are closed by default.
 */
import { useState } from 'preact/hooks';
import type { HolidayRow } from '@yegna/shared/client';
import {
  fixedHolidays,
  isMovableHolidayReminderDue,
  localDateOf,
  parseIsoDate,
  toEthiopian,
} from '@yegna/time';
import { Field, Screen, useAction } from '../components/ui.tsx';
import { locale, t } from '../i18n/index.ts';
import { db } from '../lib/db.ts';
import { formatDate } from '../lib/format.ts';
import { live, useLive } from '../lib/live.ts';
import { back } from '../lib/router.ts';
import { sync } from '../lib/sync.ts';

export function Holidays() {
  const today = localDateOf(Date.now());
  const holidays = useLive(
    async () => live(await db.holidays.where('date').aboveOrEqual(today).sortBy('date')),
    [today],
  );
  const { busy, error, run } = useAction();
  const [adding, setAdding] = useState(false);
  if (!holidays) return null;
  const ecYear = toEthiopian(parseIsoDate(today)).year;

  /** Adds this Ethiopian year's fixed holidays that are not on the list yet. */
  function addFixed() {
    const have = new Set(holidays!.map((h) => h.date));
    const missing = [...fixedHolidays(ecYear), ...fixedHolidays(ecYear + 1)].filter(
      (h) => h.date >= today && !have.has(h.date),
    );
    void run(async () => {
      for (const h of missing) {
        await sync.write('holidays', 'create', {
          date: h.date,
          nameAm: h.name_am,
          nameEn: h.name_en,
          closed: true,
        });
      }
    });
  }

  return (
    <Screen title={t('holidays.title')} back={back}>
      {isMovableHolidayReminderDue(today) ? <p class="banner warn">{t('holidays.reminder')}</p> : null}
      <button type="button" class="secondary" disabled={busy} onClick={addFixed}>
        {t('holidays.addFixed')}
      </button>
      <ul class="list">
        {holidays.map((h: HolidayRow) => (
          <li>
            <span class="grow">
              <strong>{locale.value === 'am' ? h.nameAm : h.nameEn}</strong>
              <span class="muted small"> · {formatDate(h.date)}</span>
              {h.closed ? null : <span class="muted small"> · {t('holidays.open')}</span>}
            </span>
            <button
              type="button"
              class="danger"
              disabled={busy}
              onClick={() => void run(() => sync.write('holidays', 'delete', {}, h.id).then(() => undefined))}
            >
              {t('common.delete')}
            </button>
          </li>
        ))}
      </ul>
      {holidays.length === 0 ? <p class="muted">{t('holidays.empty')}</p> : null}
      {adding ? (
        <HolidayForm today={today} onDone={() => setAdding(false)} />
      ) : (
        <button type="button" class="secondary" onClick={() => setAdding(true)}>
          + {t('holidays.add')}
        </button>
      )}
      {error ? <p class="banner error">{error}</p> : null}
    </Screen>
  );
}

function HolidayForm(props: { today: string; onDone: () => void }) {
  const [date, setDate] = useState('');
  const [nameAm, setNameAm] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [closed, setClosed] = useState(true);
  const { busy, error, setError, run } = useAction();

  function save(e: Event) {
    e.preventDefault();
    if (!date || !nameAm.trim() || !nameEn.trim()) return setError(t('error.required'));
    void run(async () => {
      await sync.write('holidays', 'create', { date, nameAm: nameAm.trim(), nameEn: nameEn.trim(), closed });
      props.onDone();
    });
  }

  return (
    <form class="card stack" onSubmit={save} noValidate>
      {/* The browser's date picker is Gregorian; the date is shown below in the user's calendar. */}
      <Field
        label={t('holidays.date')}
        type="date"
        min={props.today}
        value={date}
        onInput={(e) => setDate(e.currentTarget.value)}
      />
      {date ? <p class="muted small">{formatDate(date)}</p> : null}
      <Field
        label={t('procedures.nameAm')}
        value={nameAm}
        onInput={(e) => setNameAm(e.currentTarget.value)}
      />
      <Field
        label={t('procedures.nameEn')}
        value={nameEn}
        onInput={(e) => setNameEn(e.currentTarget.value)}
      />
      <label class="check">
        <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.currentTarget.checked)} />
        {t('holidays.closed')}
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
