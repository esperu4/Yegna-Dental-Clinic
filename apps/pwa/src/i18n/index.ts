import { computed, signal } from '@preact/signals';
import type { CalendarPref, Locale } from '@yegna/shared/client';
import { type MessageKey, am, en } from './messages.ts';

/** Per-user preferences (PRD §3): Amharic and the Ethiopian calendar by default. */
export const locale = signal<Locale>('am');
export const calendarPref = signal<CalendarPref>('ethiopian');

const dictionaries: Record<Locale, Record<MessageKey, string>> = { am, en };

export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  const template = dictionaries[locale.value][key];
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
}

/** Re-renders components that read it whenever the language changes. */
export const lang = computed(() => locale.value);

export type { MessageKey };
