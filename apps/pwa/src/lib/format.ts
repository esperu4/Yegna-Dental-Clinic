/** Dates and times in the user's calendar and language (PRD §6). All logic lives in @yegna/time. */
import {
  formatEthiopianDate,
  formatEtTime,
  formatIsoDate,
  formatLocalTime,
  parseIsoDate,
  toEthiopian,
  utcToLocal,
} from '@yegna/time';
import { calendarPref, locale } from '../i18n/index.ts';

export function formatDate(localDate: string): string {
  if (calendarPref.value === 'ethiopian')
    return formatEthiopianDate(toEthiopian(parseIsoDate(localDate)), locale.value);
  return formatIsoDate(parseIsoDate(localDate));
}

export function formatTime(localMinutes: number): string {
  return calendarPref.value === 'ethiopian'
    ? formatEtTime(localMinutes, locale.value)
    : formatLocalTime(localMinutes);
}

export function formatInstant(utcMs: number): string {
  const l = utcToLocal(utcMs);
  return `${formatDate(l.date)} · ${formatTime(l.minutes)}`;
}

/** A stored E.164 phone as people write it: +251911234567 → 0911 23 45 67. */
export function formatPhone(e164: string | undefined): string {
  if (!e164) return '';
  const national = `0${e164.slice(4)}`;
  return national.length === 10
    ? `${national.slice(0, 4)} ${national.slice(4, 6)} ${national.slice(6, 8)} ${national.slice(8)}`
    : e164;
}
