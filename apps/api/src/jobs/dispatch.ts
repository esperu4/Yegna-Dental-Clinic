/**
 * The single hourly cron (PRD §16, §19: one trigger, dispatched by Addis Ababa local time). Each
 * job checks for itself whether it is due at this local time, so a missed or failed hour is caught
 * up by the next one; `notification_log` keeps every message to one send.
 */
import { utcToLocal } from '@yegna/time';
import { getDb } from '../lib/db.ts';
import { meterD1 } from '../lib/queryMeter.ts';
import { type Notifier, telegramNotifier } from '../notify/notifier.ts';
import { PATIENT_JOBS, type PatientJobContext } from './patient.ts';
import {
  type JobContext,
  approvalDigests,
  clashAlerts,
  housekeeping,
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
  ['clash', clashAlerts],
  ['unapproved_24h', unapprovedAlerts],
  ['approval_digest', approvalDigests],
  ['holiday_reminder', movableHolidayReminders],
  ['housekeeping', housekeeping],
] as const;

/**
 * `teamNotifier` / `patientNotifier` replace the bots in tests; otherwise each bot's jobs run only
 * when its token is set.
 */
export async function runHourly(
  env: Env,
  now = Date.now(),
  teamNotifier?: Notifier,
  patientNotifier?: Notifier,
): Promise<void> {
  const meter = meterD1(env.DB);
  const db = getDb(meter.d1);
  const local = utcToLocal(now);

  const team = teamNotifier ?? (env.TEAM_BOT_TOKEN ? telegramNotifier(env.TEAM_BOT_TOKEN) : null);
  if (team) await runTeamJobs({ db, meter, notifier: team, now, local, pwaUrl: env.PWA_ORIGIN });
  else console.warn('cron', 'team bot not configured; team jobs skipped');

  const patient = patientNotifier ?? (env.PATIENT_BOT_TOKEN ? telegramNotifier(env.PATIENT_BOT_TOKEN) : null);
  if (patient) await runPatientJobs({ db, meter, notifier: patient, now, local });
}

async function runTeamJobs(ctx: JobContext) {
  let team;
  try {
    team = await linkedTeam(ctx.db);
  } catch (err) {
    console.error('cron_job_failed', 'team', err instanceof Error ? err.name : 'unknown');
    return;
  }
  for (const [name, job] of TEAM_JOBS) {
    try {
      await job(ctx, team);
    } catch (err) {
      // The job's name and the error type only (PRD §18: no patient data in logs).
      console.error('cron_job_failed', name, err instanceof Error ? err.name : 'unknown');
    }
  }
}

async function runPatientJobs(ctx: PatientJobContext) {
  for (const [name, job] of PATIENT_JOBS) {
    try {
      await job(ctx);
    } catch (err) {
      console.error('cron_job_failed', name, err instanceof Error ? err.name : 'unknown');
    }
  }
}
