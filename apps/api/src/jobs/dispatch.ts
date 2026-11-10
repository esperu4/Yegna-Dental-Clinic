/**
 * The single hourly cron (PRD §16, §19: one trigger, dispatched by Addis Ababa local time). Each
 * job checks for itself whether it is due at this local time, so a missed or failed hour is caught
 * up by the next one; `notification_log` keeps every message to one send.
 */
import { utcToLocal } from '@yegna/time';
import { getDb } from '../lib/db.ts';
import { meterD1 } from '../lib/queryMeter.ts';
import { type Notifier, telegramNotifier } from '../notify/notifier.ts';
import {
  type JobContext,
  approvalDigests,
  callListMessages,
  linkedTeam,
  movableHolidayReminders,
  tomorrowSummaries,
  unapprovedAlerts,
} from './team.ts';

/** Most important first: if the run's query budget runs out, the rest waits for the next hour. */
const TEAM_JOBS = [
  ['tomorrow_summary', tomorrowSummaries],
  ['call_list', callListMessages],
  ['unapproved_24h', unapprovedAlerts],
  ['approval_digest', approvalDigests],
  ['holiday_reminder', movableHolidayReminders],
] as const;

export async function runHourly(env: Env, now = Date.now(), notifier?: Notifier): Promise<void> {
  const send = notifier ?? (env.TEAM_BOT_TOKEN ? telegramNotifier(env.TEAM_BOT_TOKEN) : null);
  if (!send) {
    console.warn('cron', 'team bot not configured; team jobs skipped');
    return;
  }
  const meter = meterD1(env.DB);
  const ctx: JobContext = {
    db: getDb(meter.d1),
    meter,
    notifier: send,
    now,
    local: utcToLocal(now),
    pwaUrl: env.PWA_ORIGIN,
  };
  const team = await linkedTeam(ctx.db);
  for (const [name, job] of TEAM_JOBS) {
    try {
      await job(ctx, team);
    } catch (err) {
      // The job's name and the error type only (PRD §18: no patient data in logs).
      console.error('cron_job_failed', name, err instanceof Error ? err.name : 'unknown');
    }
  }
}
