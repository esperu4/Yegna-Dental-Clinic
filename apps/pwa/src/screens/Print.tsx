/**
 * Print (PRD §8 item 11, §11): pick a template and a period, then print on A4 landscape (Android
 * print / Save as PDF). Built from the working copy, so it works offline. Printing waits until at
 * least one procedure exists (the code legend would be empty).
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { type SheetTemplate } from '@yegna/shared/client';
import {
  type Weekday,
  addDays,
  daysInEthiopianMonth,
  formatIsoDate,
  localDateOf,
  parseIsoDate,
  toEthiopian,
  toGregorian,
  weekdayName,
} from '@yegna/time';
import { renderSVG } from 'uqr';
import { Screen, useAction } from '../components/ui.tsx';
import { locale, t } from '../i18n/index.ts';
import { db } from '../lib/db.ts';
import { useLive } from '../lib/live.ts';
import { type HourRow, type SheetLayout, type WeekPage, sheetLayout } from '../lib/printSheet.ts';
import { back } from '../lib/router.ts';
import { session } from '../lib/session.ts';
import { sync } from '../lib/sync.ts';
import { weeklyHoursOf } from '../lib/weeklyHours.ts';

const TEMPLATES: readonly SheetTemplate[] = ['F', 'C', 'O'];

/** The same day one Ethiopian month later or earlier (day clamped to the month's length). */
function shiftEtMonth(iso: string, by: 1 | -1): string {
  const et = toEthiopian(parseIsoDate(iso));
  let month = et.month + by;
  let year = et.year;
  if (month > 13) [month, year] = [1, year + 1];
  if (month < 1) [month, year] = [13, year - 1];
  const day = Math.min(et.day, daysInEthiopianMonth(year, month));
  return formatIsoDate(toGregorian({ year, month, day }));
}

export function Print() {
  const isDoctor = session.current.value?.user.role === 'doctor';
  const settings = useLive(async () => (await db.settings.get('settings')) ?? null, []);
  const procedures = useLive(
    async () => (await db.procedures.toArray()).filter((p) => p.deletedAt == null && p.active),
    [],
  );
  const [template, setTemplate] = useState<SheetTemplate | null>(null);
  const [date, setDate] = useState(() => localDateOf(Date.now()));
  const { busy, error, run } = useAction();

  const defaultTemplate = (settings?.defaultTemplate as SheetTemplate | null | undefined) ?? 'F';
  useEffect(() => {
    if (template === null && settings !== undefined) setTemplate(defaultTemplate);
  }, [settings]);

  const layout = useMemo(
    () =>
      template && procedures && settings !== undefined
        ? sheetLayout({
            template,
            date,
            weeklyHours: weeklyHoursOf(settings ?? undefined),
            procedures,
            locale: locale.value,
          })
        : null,
    [template, date, procedures, settings, locale.value],
  );

  if (!layout || !template || !procedures) {
    return (
      <Screen title={t('print.title')} back={back}>
        <p class="muted">{t('common.loading')}</p>
      </Screen>
    );
  }

  const step = (by: 1 | -1) => setDate(template === 'O' ? shiftEtMonth(date, by) : addDays(date, 7 * by));
  const canPrint = procedures.length > 0;

  return (
    <Screen title={t('print.title')} back={back}>
      <section class="stack no-print">
        <div class="segmented" role="group" aria-label={t('print.template')}>
          {TEMPLATES.map((code) => (
            <button type="button" aria-pressed={template === code} onClick={() => setTemplate(code)}>
              {t(`print.template.${code}`)}
            </button>
          ))}
        </div>
        <p class="muted">{t(`print.template.${template}.about`)}</p>
        <div class="pair">
          <button type="button" class="secondary" onClick={() => step(-1)} aria-label={t('print.previous')}>
            ‹
          </button>
          <strong class="print-period">{layout.title}</strong>
          <button type="button" class="secondary" onClick={() => step(1)} aria-label={t('print.next')}>
            ›
          </button>
        </div>
        {canPrint ? (
          <button type="button" class="primary" onClick={() => window.print()}>
            {t('print.print')}
          </button>
        ) : (
          <p class="banner">{t('print.noProcedures')}</p>
        )}
        {isDoctor ? (
          template === defaultTemplate ? (
            <p class="muted">{t('print.isDefault')}</p>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await sync.write('settings', 'update', { defaultTemplate: template }, 'settings');
                })
              }
            >
              {t('print.makeDefault')}
            </button>
          )
        ) : null}
        {error ? <p class="banner error">{error}</p> : null}
      </section>
      {canPrint ? <Sheets layout={layout} /> : null}
    </Screen>
  );
}

function Qr(props: { value: string }) {
  // The SVG is generated locally from our own sheet ID (no user input), so it is safe to inline.
  return <span class="qr" dangerouslySetInnerHTML={{ __html: renderSVG(props.value, { border: 1 }) }} />;
}

function SheetHeader(props: { id: string; title: string; template: SheetTemplate }) {
  return (
    <header class="paper-head">
      <div>
        <div class="paper-clinic">{t('print.clinic')}</div>
        <div class="paper-title">
          {props.title} · {t(`print.template.${props.template}`)}
        </div>
      </div>
      <div class="paper-id">{props.id}</div>
      <Qr value={props.id} />
    </header>
  );
}

function Legend(props: { legend: { code: string; name: string }[] }) {
  return (
    <footer class="paper-legend">
      <strong>{t('print.legend')}:</strong>{' '}
      {props.legend.map((p) => (
        <span>
          <b>{p.code}</b> {p.name}
        </span>
      ))}
    </footer>
  );
}

function EntryLine() {
  return (
    <div class="entry">
      <span class="minute">:__</span>
      <span class="name" />
      <span class="digits">
        {Array.from({ length: 10 }, () => (
          <span class="box" />
        ))}
      </span>
      <span class="code" />
    </div>
  );
}

/** Height left for the hour rows on an A4 landscape page, after header, day row and legend. */
const ROWS_MM = 146;

function WeekSheet(props: { page: WeekPage; layout: Extract<SheetLayout, { template: 'F' | 'C' }> }) {
  const { page, layout } = props;
  const hourMm = Math.min(24, ROWS_MM / Math.max(1, layout.hours.length));
  const style = { '--hour-h': `${hourMm}mm`, '--entry-h': `${hourMm / layout.linesPerHour}mm` };
  return (
    <article class={`paper paper-${layout.template}`} style={style}>
      <SheetHeader id={page.id} title={layout.title} template={layout.template} />
      <table class="grid">
        <thead>
          <tr>
            <th class="hour-col" />
            {page.days.map((d) => (
              <th>{d.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {layout.hours.map((h: HourRow) => (
            <tr class={h.lunch ? 'lunch' : undefined}>
              <th class="hour-col">
                {h.label.split(' ').map((part) => (
                  <div>{part}</div>
                ))}
              </th>
              {page.days.map((d) =>
                d.closed ? (
                  <td class="closed" />
                ) : (
                  <td>
                    {Array.from({ length: layout.linesPerHour }, () => (
                      <EntryLine />
                    ))}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <Legend legend={layout.legend} />
    </article>
  );
}

function MonthSheet(props: { layout: Extract<SheetLayout, { template: 'O' }> }) {
  const { layout } = props;
  const weekMm = ROWS_MM / layout.weeks.length;
  const style = { '--week-h': `${weekMm}mm`, '--line-h': `${(weekMm - 4) / layout.linesPerDay}mm` };
  return (
    <article class="paper paper-O" style={style}>
      <SheetHeader id={layout.id} title={layout.title} template="O" />
      <table class="grid month">
        <thead>
          <tr>
            {([1, 2, 3, 4, 5, 6] as Weekday[]).map((d) => (
              <th>{weekdayName(d, locale.value)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {layout.weeks.map((week) => (
            <tr>
              {week.map((cell) =>
                cell === null ? (
                  <td class="outside" />
                ) : (
                  <td class={cell.closed ? 'closed' : undefined}>
                    <div class="day-no">{cell.etDay}</div>
                    {cell.closed
                      ? null
                      : Array.from({ length: layout.linesPerDay }, (_, i) => (
                          <div class="month-line">
                            <span>{i + 1}</span>
                            <span class="at">:</span>
                            <span class="name" />
                          </div>
                        ))}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <Legend legend={layout.legend} />
    </article>
  );
}

function Sheets(props: { layout: SheetLayout }) {
  const { layout } = props;
  return (
    <div class="papers">
      {layout.template === 'O' ? (
        <MonthSheet layout={layout} />
      ) : (
        layout.pages.map((page) => <WeekSheet page={page} layout={layout} />)
      )}
    </div>
  );
}
