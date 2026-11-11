import { describe, expect, it } from 'vitest';
import { DEFAULT_WEEKLY_HOURS } from '@yegna/time';
import {
  DURATION_CHOICES,
  EMPTY_PROCEDURE,
  nextSort,
  normalizeCode,
  procedureFields,
  procedureProblems,
  sortProcedures,
} from '../src/lib/procedures.ts';
import {
  STANDARD_DAY,
  TIME_CHOICES,
  weekdayProblem,
  weeklyHoursOf,
  withWeekday,
} from '../src/lib/weeklyHours.ts';

const valid = { ...EMPTY_PROCEDURE, nameAm: 'ጽዳት', nameEn: 'Cleaning', code: 'c' };

describe('procedures', () => {
  it('accepts a complete procedure', () => {
    expect(procedureProblems(valid, [])).toEqual({});
  });

  it('requires both names and a code', () => {
    expect(procedureProblems({ ...valid, nameAm: ' ', nameEn: '', code: '  ' }, [])).toEqual({
      nameAm: 'error.required',
      nameEn: 'error.required',
      code: 'error.required',
    });
  });

  it('keeps codes to 1–3 characters and unique (ignoring case and spaces)', () => {
    expect(procedureProblems({ ...valid, code: 'ABCD' }, [])).toEqual({
      code: 'procedures.error.codeLength',
    });
    expect(procedureProblems({ ...valid, code: ' c ' }, [{ code: 'C' }])).toEqual({
      code: 'procedures.error.codeTaken',
    });
  });

  it('allows only 15-minute-grid durations', () => {
    expect(procedureProblems({ ...valid, durationMin: 20 }, [])).toEqual({
      durationMin: 'procedures.error.duration',
    });
    expect(DURATION_CHOICES[0]).toBe(15);
    expect(DURATION_CHOICES.at(-1)).toBe(240);
    for (const d of DURATION_CHOICES) expect(procedureProblems({ ...valid, durationMin: d }, [])).toEqual({});
  });

  it('sends trimmed fields with the code upper-cased', () => {
    expect(procedureFields({ ...valid, nameEn: ' Cleaning ', code: ' ex ' }, 4)).toEqual({
      nameAm: 'ጽዳት',
      nameEn: 'Cleaning',
      code: 'EX',
      durationMin: 30,
      color: valid.color,
      active: true,
      sort: 4,
    });
    expect(normalizeCode(' ጽ ')).toBe('ጽ');
  });

  it('lists active procedures first, then by sort and code', () => {
    const list = [
      { code: 'B', sort: 1, active: true },
      { code: 'Z', sort: 0, active: false },
      { code: 'A', sort: 1, active: true },
      { code: 'C', sort: 0, active: true },
    ];
    expect(sortProcedures(list).map((p) => p.code)).toEqual(['C', 'A', 'B', 'Z']);
    expect(nextSort(list)).toBe(2);
    expect(nextSort([])).toBe(0);
  });
});

describe('weekly hours', () => {
  it('uses the synced settings, or the PRD defaults before they exist', () => {
    const custom = withWeekday(DEFAULT_WEEKLY_HOURS, 0, STANDARD_DAY);
    expect(weeklyHoursOf(undefined)).toBe(DEFAULT_WEEKLY_HOURS);
    expect(weeklyHoursOf({ weeklyHours: custom, deletedAt: null })).toBe(custom);
    // A settings row made locally by another change (e.g. the default template) before the
    // weekly hours were ever saved has no hours yet: the defaults apply.
    expect(weeklyHoursOf({ deletedAt: null } as unknown as Parameters<typeof weeklyHoursOf>[0])).toBe(
      DEFAULT_WEEKLY_HOURS,
    );
    expect(custom[0]).toEqual(STANDARD_DAY);
    expect(DEFAULT_WEEKLY_HOURS[0]).toBeNull();
  });

  it('offers times on the 15-minute grid from 05:00 to 22:00', () => {
    expect(TIME_CHOICES[0]).toBe(300);
    expect(TIME_CHOICES.at(-1)).toBe(1320);
    expect(TIME_CHOICES.every((m) => m % 15 === 0)).toBe(true);
  });

  it('checks one weekday’s hours', () => {
    expect(weekdayProblem(null)).toBeNull();
    expect(weekdayProblem(STANDARD_DAY)).toBeNull();
    expect(weekdayProblem({ ...STANDARD_DAY, closeAt: 540 })).toBe('hours.error.closeBeforeOpen');
    expect(weekdayProblem({ ...STANDARD_DAY, lunchEnd: null })).toBe('hours.error.lunch');
    expect(weekdayProblem({ ...STANDARD_DAY, lunchStart: 780, lunchEnd: 720 })).toBe('hours.error.lunch');
    expect(weekdayProblem({ ...STANDARD_DAY, lunchStart: 480, lunchEnd: 540 })).toBe(
      'hours.error.lunchOutside',
    );
    expect(weekdayProblem({ ...STANDARD_DAY, lunchStart: null, lunchEnd: null })).toBeNull();
  });
});
