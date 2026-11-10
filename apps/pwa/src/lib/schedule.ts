/**
 * The schedule as the Today and Week views and the booking sheet see it (PRD §6, §8 items 3–6).
 * Pure functions over working-copy rows; all calendar and hours rules come from @yegna/time.
 */
import {
  type BookingRow,
  type BlockRow,
  type DayRuleRow,
  type HolidayRow,
  type Role,
  checkStatusChange,
  isActiveStatus,
  statusAfterReschedule,
} from '@yegna/shared/client';
import {
  type BookingError,
  type BookingWarning,
  type ResolvedDay,
  type WeeklyDefaults,
  checkBooking,
  gridSlots,
  localToUtc,
  resolveDay,
  utcToLocal,
} from '@yegna/time';

const MS_PER_MIN = 60_000;

/** Everything about one clinic day the views need. */
export interface DayPlan {
  date: string;
  day: ResolvedDay;
  /** The closed holiday on this date, if any (for its name). */
  holiday: HolidayRow | null;
  /** The Doctor's rule for this date, if any. */
  rule: DayRuleRow | null;
  blocks: BlockRow[];
  /** Bookings starting this day, by start time; cancelled ones left out. */
  bookings: BookingRow[];
  counts: { booked: number; arrived: number; done: number };
}

/** UTC range of a clinic-local day. */
export function dayRange(date: string): { start: number; end: number } {
  return { start: localToUtc(date, 0), end: localToUtc(date, 24 * 60) };
}

export function planDay(input: {
  date: string;
  weekly: WeeklyDefaults;
  dayRule: DayRuleRow | undefined;
  holidays: readonly HolidayRow[];
  blocks: readonly BlockRow[];
  bookings: readonly BookingRow[];
}): DayPlan {
  const { date } = input;
  const { start, end } = dayRange(date);
  const holiday = input.holidays.find((h) => h.date === date && h.closed && h.deletedAt == null) ?? null;
  const rule = input.dayRule && input.dayRule.deletedAt == null ? input.dayRule : null;
  const day = resolveDay(date, input.weekly, rule, holiday);
  const blocks = input.blocks.filter((b) => b.deletedAt == null && b.startAt < end && b.endAt > start);
  const bookings = input.bookings
    .filter((b) => b.deletedAt == null && b.status !== 'cancelled' && b.startAt >= start && b.startAt < end)
    .sort((a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id));
  return {
    date,
    day,
    holiday,
    rule,
    blocks,
    bookings,
    counts: {
      booked: bookings.length,
      arrived: bookings.filter((b) => b.status === 'arrived').length,
      done: bookings.filter((b) => b.status === 'done').length,
    },
  };
}

export interface DraftCheck {
  /** Hard errors: Save is not possible (PRD §6: close time and blocks are hard). */
  errors: BookingError[];
  /** Soft: ask "Book anyway?" (lunch). */
  warnings: BookingWarning[];
  /** An active booking on this device that overlaps (a live clash warning; the server decides). */
  clashWith: BookingRow | null;
}

/** Checks a proposed booking against the plan, as the booking sheet types (PRD §8 item 5). */
export function checkDraft(
  plan: DayPlan,
  draft: { startMin: number; durationMin: number; bookingId?: string },
): DraftCheck {
  const { errors, warnings } = checkBooking(plan.day, draft.startMin, draft.durationMin, plan.blocks);
  const start = localToUtc(plan.date, draft.startMin);
  const end = start + draft.durationMin * MS_PER_MIN;
  const clashWith =
    plan.bookings.find(
      (b) =>
        b.id !== draft.bookingId &&
        isActiveStatus(b.status) &&
        b.startAt < end &&
        start < b.startAt + b.durationMin * MS_PER_MIN,
    ) ?? null;
  return { errors, warnings, clashWith };
}

/**
 * Bookings that need someone's attention this day: clashes, needs-fixing bookings, and active
 * bookings that fall outside the day's hours (the day was closed or shortened after they were
 * made). Listed above the timeline, so none is hidden by a "Closed" banner or drawn off the chart.
 */
export function needsAttention(plan: DayPlan): BookingRow[] {
  return plan.bookings.filter((b) => {
    if (b.status === 'clash' || b.status === 'needs_fixing') return true;
    if (!isActiveStatus(b.status)) return false;
    if (plan.day.closed) return true;
    const start = utcToLocal(b.startAt).date === plan.date ? startMinOf(b) : -1;
    return start < plan.day.openAt || start + b.durationMin > plan.day.closeAt;
  });
}

/** The first slot from `fromMin` where a booking of `durationMin` fits with no error or clash. */
export function nextFreeSlot(plan: DayPlan, durationMin: number, fromMin = 0): number | null {
  return (
    gridSlots(plan.day).find((m) => {
      if (m < fromMin) return false;
      const check = checkDraft(plan, { startMin: m, durationMin });
      return check.errors.length === 0 && check.clashWith === null;
    }) ?? null
  );
}

/** Minutes since local midnight of a booking's start. */
export function startMinOf(booking: Pick<BookingRow, 'startAt'>): number {
  return utcToLocal(booking.startAt).minutes;
}

export type CardAction =
  'approve' | 'arrived' | 'done' | 'noShow' | 'reschedule' | 'cancel' | 'call' | 'bookNext';

/**
 * The actions a booking card offers this user now (PRD §8 item 6, §9, §10). Mirrors the server's
 * rules, so every button shown is one the server accepts. Call and Book next visit are always
 * there. No-show appears from 20 minutes after the start.
 */
export function cardActions(
  booking: Pick<BookingRow, 'status' | 'startAt'>,
  role: Role,
  now: number,
): CardAction[] {
  const can = (to: BookingRow['status']) =>
    checkStatusChange({
      from: booking.status,
      to,
      role,
      startAt: booking.startAt,
      now,
      cancelReason: 'reason',
    }) === null;
  const actions: CardAction[] = [];
  if (can('approved')) actions.push('approve');
  if (can('arrived')) actions.push('arrived');
  if (can('done')) actions.push('done');
  if (can('no_show')) actions.push('noShow');
  if (statusAfterReschedule(booking.status, role) !== null) actions.push('reschedule');
  if (can('cancelled')) actions.push('cancel');
  actions.push('call', 'bookNext');
  return actions;
}
