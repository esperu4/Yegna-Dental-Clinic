/**
 * Free-tier usage check (PRD §19, §21 decision 8): since 1 Sep 2026 D1 queries fail once a free
 * daily limit is exceeded, so the Doctor is told at 50% and again at 80% of any limit.
 *
 * Every hour from 07:00 to 21:00 local, one call to the Cloudflare GraphQL Analytics API reads the
 * account's usage for the current UTC day (the free limits reset at 00:00 UTC, 03:00 in Addis
 * Ababa): Workers requests, D1 rows read and written, and the largest database's size. Each
 * metric and level is told once per UTC day (`notification_log` kind `usage`).
 *
 * Needs `CF_ACCOUNT_ID` and `CF_ANALYTICS_TOKEN` (Account Analytics Read); does nothing without
 * them. Logs carry metric names, percentages and HTTP statuses only.
 */
import { deliverOnce, markSent } from '../notify/deliver.ts';
import { type Recipient, usageAlert } from '../notify/messages.ts';
import type { JobContext } from './team.ts';

/**
 * Workers Free / D1 free limits (verify at https://developers.cloudflare.com/workers/platform/limits/
 * and https://developers.cloudflare.com/d1/platform/limits/ when they change).
 */
export const FREE_LIMITS = {
  workerRequests: 100_000,
  d1RowsRead: 5_000_000,
  d1RowsWritten: 100_000,
  d1StorageBytes: 500 * 1024 * 1024,
} as const;
export type UsageMetric = keyof typeof FREE_LIMITS;

/** Queries one delivery may use (claim, status, markSent), plus slack, as in jobs/team.ts. */
const PER_DELIVERY = 3;
const MIN_QUERIES = 10;

/** Alert levels, highest first. */
export const LEVELS = [80, 50] as const;

export type Usage = Record<UsageMetric, number>;

export interface UsageDeps {
  env: Pick<Env, 'CF_ACCOUNT_ID' | 'CF_ANALYTICS_TOKEN'>;
  fetch?: typeof fetch;
}

export class UsageError extends Error {
  override name = 'UsageError';
}

const QUERY = `query YegnaUsage($account: string!, $date: Date!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      workers: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) {
        sum { requests }
      }
      d1: d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $date, date_leq: $date }) {
        sum { rowsRead rowsWritten }
      }
      storage: d1StorageAdaptiveGroups(limit: 10000, filter: { date_geq: $date, date_leq: $date }) {
        max { databaseSizeBytes }
        dimensions { databaseId }
      }
    }
  }
}`;

interface UsageResponse {
  data?: {
    viewer?: {
      accounts?: {
        workers?: { sum?: { requests?: number } }[];
        d1?: { sum?: { rowsRead?: number; rowsWritten?: number } }[];
        storage?: { max?: { databaseSizeBytes?: number } }[];
      }[];
    };
  } | null;
  errors?: unknown[] | null;
}

/** The account's usage for the UTC day of `now` (so far). */
export async function fetchUsage(deps: UsageDeps, now: number): Promise<Usage> {
  const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const date = new Date(now).toISOString().slice(0, 10);
  const res = await doFetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    // A hung API must not hold up the rest of the hourly run.
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${deps.env.CF_ANALYTICS_TOKEN!}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: QUERY,
      variables: {
        account: deps.env.CF_ACCOUNT_ID!,
        date,
        start: `${date}T00:00:00Z`,
        end: new Date(now).toISOString(),
      },
    }),
  });
  if (!res.ok) throw new UsageError(`http_${res.status}`);
  const body = (await res.json()) as UsageResponse;
  const account = body.data?.viewer?.accounts?.[0];
  if ((body.errors && body.errors.length > 0) || !account) throw new UsageError('graphql_error');
  const sum = <T>(rows: T[] | undefined, pick: (r: T) => number | undefined) =>
    (rows ?? []).reduce((total, r) => total + (pick(r) ?? 0), 0);
  return {
    workerRequests: sum(account.workers, (r) => r.sum?.requests),
    d1RowsRead: sum(account.d1, (r) => r.sum?.rowsRead),
    d1RowsWritten: sum(account.d1, (r) => r.sum?.rowsWritten),
    // The limit is per database: the largest one counts.
    d1StorageBytes: Math.max(0, ...(account.storage ?? []).map((r) => r.max?.databaseSizeBytes ?? 0)),
  };
}

/** Each metric at or above an alert level, with its highest level crossed. */
export function overLevels(usage: Usage): { metric: UsageMetric; level: number; percent: number }[] {
  return (Object.keys(FREE_LIMITS) as UsageMetric[]).flatMap((metric) => {
    const percent = Math.floor((usage[metric] / FREE_LIMITS[metric]) * 100);
    const level = LEVELS.find((l) => percent >= l);
    return level === undefined ? [] : [{ metric, level, percent }];
  });
}

export function usageConfigured(env: UsageDeps['env']): boolean {
  return Boolean(env.CF_ACCOUNT_ID && env.CF_ANALYTICS_TOKEN);
}

export async function usageAlerts(ctx: JobContext, team: Recipient[], deps: UsageDeps): Promise<void> {
  const hour = Math.floor(ctx.local.minutes / 60);
  const doctors = team.filter((r) => r.role === 'doctor');
  if (!usageConfigured(deps.env) || hour < 7 || hour > 21 || doctors.length === 0) return;
  // Runs last in the hour; only with budget left for a few deliveries.
  if (ctx.meter.remaining() < MIN_QUERIES) return;
  let usage: Usage;
  try {
    usage = await fetchUsage(deps, ctx.now);
  } catch (err) {
    console.error(
      'usage_check_failed',
      err instanceof UsageError ? err.message : err instanceof Error ? err.name : 'unknown',
    );
    return;
  }
  const utcDate = new Date(ctx.now).toISOString().slice(0, 10);
  for (const { metric, level, percent } of overLevels(usage)) {
    console.warn('usage_high', metric, `${percent}%`);
    // Daily limits are told once a day; the size, which never resets, once a month.
    const period = metric === 'd1StorageBytes' ? `month:${utcDate.slice(0, 7)}` : `day:${utcDate}`;
    const key = (l: number) => `${period}|${metric}|${l}`;
    for (const r of doctors) {
      if (ctx.meter.remaining() < PER_DELIVERY + 2) return;
      const result = await deliverOnce(
        ctx.db,
        ctx.notifier,
        { kind: 'usage', key: key(level), chatId: r.chatId },
        () => usageAlert(r, metric, percent, FREE_LIMITS[metric]),
        ctx.now,
      );
      // Past 80% the 50% message would only repeat it: record lower levels as told.
      if (result === 'sent') {
        const lower = LEVELS.filter((l) => l < level).map(key);
        if (lower.length) await markSent(ctx.db, 'usage', r.chatId, lower, ctx.now);
      }
    }
  }
}
