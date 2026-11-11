/**
 * The paper templates' layout (PRD §11), as data: pages, day columns, hourly rows in ET, the lunch
 * row, the procedure code legend and the sheet ID. `screens/Print.tsx` only draws it.
 */
import { type SheetTemplate, sheetIdFor } from '@yegna/shared/client';
import {
  type EDate,
  type WeeklyDefaults,
  addDays,
  daysInEthiopianMonth,
  formatEthiopianDate,
  formatEtTime,
  formatIsoDate,
  parseIsoDate,
  toEthiopian,
  toGregorian,
  weekdayName,
  weekdayOf,
} from '@yegna/time';

type Locale = 'am' | 'en';

export interface SheetDay {
  iso: string;
  /** Weekday name and Ethiopian date, e.g. `Monday · Hidar 14`. */
  label: string;
  /** Closed that weekday (no entry lines are printed). */
  closed: boolean;
}

export interface HourRow {
  /** Local minutes of the hour's start. */
  minutes: number;
  /** ET time label, e.g. `3:00 morning`. */
  label: string;
  lunch: boolean;
}

export interface WeekPage {
  id: string;
  days: SheetDay[];
}

export interface MonthCell {
  iso: string;
  etDay: number;
  closed: boolean;
}

export type SheetLayout =
  | {
      template: 'F' | 'C';
      title: string;
      pages: WeekPage[];
      hours: HourRow[];
      /** Entry lines per hour cell (PRD §11: 3). */
      linesPerHour: number;
      legend: { code: string; name: string }[];
    }
  | {
      template: 'O';
      title: string;
      id: string;
      /** Weeks × Monday–Saturday; `null` outside the month. */
      weeks: (MonthCell | null)[][];
      /** Numbered lines per day cell (PRD §11: 6). */
      linesPerDay: number;
      legend: { code: string; name: string }[];
    };

export interface SheetInput {
  template: SheetTemplate;
  /** Any date in the week (F, C) or the Ethiopian month (O) to print. */
  date: string;
  weeklyHours: WeeklyDefaults;
  procedures: { code: string; nameAm: string; nameEn: string }[];
  locale: Locale;
}

/** The Monday of the week holding `iso` (the clinic week runs Monday–Saturday). */
export function mondayOf(iso: string): string {
  const weekday = weekdayOf(iso);
  return addDays(iso, weekday === 0 ? -6 : 1 - weekday);
}

/**
 * Hourly rows from the earliest opening to the latest closing of the week (PRD §11: "3:00 to
 * 12:00 ET from current settings"); an hour overlapping a lunch break is shaded.
 */
export function hourRows(weekly: WeeklyDefaults, locale: Locale): HourRow[] {
  const open = weekly.filter((d) => d !== null);
  if (open.length === 0) return [];
  const from = Math.floor(Math.min(...open.map((d) => d.openAt)) / 60) * 60;
  const to = Math.ceil(Math.max(...open.map((d) => d.closeAt)) / 60) * 60;
  const rows: HourRow[] = [];
  for (let minutes = from; minutes < to; minutes += 60) {
    rows.push({
      minutes,
      label: formatEtTime(minutes, locale),
      lunch: open.some(
        (d) =>
          d.lunchStart !== null && d.lunchEnd !== null && d.lunchStart < minutes + 60 && d.lunchEnd > minutes,
      ),
    });
  }
  return rows;
}

function etShort(e: EDate, locale: Locale): string {
  return formatEthiopianDate(e, locale).replace(/, \d+$/, '');
}

function dayOf(iso: string, weekly: WeeklyDefaults, locale: Locale): SheetDay {
  const et = toEthiopian(parseIsoDate(iso));
  return {
    iso,
    label: `${weekdayName(weekdayOf(iso), locale)} · ${etShort(et, locale)}`,
    closed: weekly[weekdayOf(iso)] === null,
  };
}

export function sheetLayout(input: SheetInput): SheetLayout {
  const legend = input.procedures
    .map((p) => ({ code: p.code, name: input.locale === 'am' ? p.nameAm : p.nameEn }))
    .sort((a, b) => a.code.localeCompare(b.code));

  if (input.template === 'O') {
    const et = toEthiopian(parseIsoDate(input.date));
    const last = daysInEthiopianMonth(et.year, et.month);
    const cells: (MonthCell | null)[] = [];
    for (let day = 1; day <= last; day++) {
      const iso = formatIsoDate(toGregorian({ year: et.year, month: et.month, day }));
      if (weekdayOf(iso) === 0) continue; // the sheet has Monday–Saturday columns only
      if (cells.length === 0) for (let i = 1; i < weekdayOf(iso); i++) cells.push(null);
      cells.push({ iso, etDay: day, closed: input.weeklyHours[weekdayOf(iso)] === null });
    }
    while (cells.length % 6 !== 0) cells.push(null);
    const weeks: (MonthCell | null)[][] = [];
    for (let i = 0; i < cells.length; i += 6) weeks.push(cells.slice(i, i + 6));
    return {
      template: 'O',
      title: formatEthiopianDate({ ...et, day: 1 }, input.locale).replace(/ 1,/, ''),
      id: sheetIdFor({ template: 'O', etYear: et.year, etMonth: et.month }),
      weeks,
      linesPerDay: 6,
      legend,
    };
  }

  const monday = mondayOf(input.date);
  const days = [0, 1, 2, 3, 4, 5].map((i) => dayOf(addDays(monday, i), input.weeklyHours, input.locale));
  const pages: WeekPage[] =
    input.template === 'F'
      ? [{ id: sheetIdFor({ template: 'F', monday }), days }]
      : [
          { id: sheetIdFor({ template: 'C', monday, page: 1 }), days: days.slice(0, 3) },
          { id: sheetIdFor({ template: 'C', monday, page: 2 }), days: days.slice(3) },
        ];
  const first = toEthiopian(parseIsoDate(monday));
  const lastDay = toEthiopian(parseIsoDate(addDays(monday, 5)));
  return {
    template: input.template,
    title: `${etShort(first, input.locale)} – ${formatEthiopianDate(lastDay, input.locale)}`,
    pages,
    hours: hourRows(input.weeklyHours, input.locale),
    linesPerHour: 3,
    legend,
  };
}
