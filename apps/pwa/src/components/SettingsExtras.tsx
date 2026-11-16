/**
 * Settings sections (PRD §8 item 12): notifications (everyone); the times patient reminders and the
 * Doctor's summary go out, and which photo readers are set up (Doctor only).
 */
import { useEffect, useState } from 'preact/hooks';
import { t } from '../i18n/index.ts';
import { db } from '../lib/db.ts';
import { formatTime } from '../lib/format.ts';
import { useLive } from '../lib/live.ts';
import { session } from '../lib/session.ts';
import { sync } from '../lib/sync.ts';
import { useAction } from './ui.tsx';

/** Local hours offered for evening messages: 15:00–21:00 (9:00–3:00 ET). */
const MESSAGE_HOURS = [15, 16, 17, 18, 19, 20, 21];

export function MessageTimes() {
  const settings = useLive(async () => (await db.settings.get('settings')) ?? null, []);
  const { busy, error, run } = useAction();
  if (settings === undefined) return null;
  const reminder = settings?.patientReminderAt ?? 18 * 60;
  const summary = settings?.doctorSummaryAt ?? 19 * 60;
  const save = (field: 'patientReminderAt' | 'doctorSummaryAt', minutes: number) =>
    void run(async () => {
      await sync.write('settings', 'update', { [field]: minutes }, 'settings');
    });
  const picker = (field: 'patientReminderAt' | 'doctorSummaryAt', value: number, label: string) => (
    <label class="field">
      <span class="label">{label}</span>
      <select
        value={String(value)}
        disabled={busy}
        onChange={(e) => save(field, Number((e.target as HTMLSelectElement).value))}
      >
        {MESSAGE_HOURS.map((h) => (
          <option value={String(h * 60)}>{formatTime(h * 60)}</option>
        ))}
      </select>
    </label>
  );
  return (
    <section class="stack" aria-label={t('settings.messageTimes')}>
      <h2 class="step-title">{t('settings.messageTimes')}</h2>
      {picker('patientReminderAt', reminder, t('settings.reminderAt'))}
      {picker('doctorSummaryAt', summary, t('settings.summaryAt'))}
      {error ? <p class="banner error">{error}</p> : null}
    </section>
  );
}

type Permission = 'default' | 'granted' | 'denied' | 'unsupported';
const permission = (): Permission =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

export function NotificationsSetting() {
  const [state, setState] = useState<Permission>(permission());
  return (
    <section class="stack" aria-label={t('wizard.notifications.title')}>
      <h2 class="step-title">{t('wizard.notifications.title')}</h2>
      {state === 'default' ? (
        <button
          type="button"
          class="secondary"
          onClick={() => void Notification.requestPermission().then((p) => setState(p))}
        >
          {t('wizard.notifications.allow')}
        </button>
      ) : (
        <p class="muted">
          {t(
            state === 'granted'
              ? 'wizard.notifications.granted'
              : state === 'denied'
                ? 'wizard.notifications.denied'
                : 'wizard.notifications.unsupported',
          )}
        </p>
      )}
    </section>
  );
}

export function ReaderStatus() {
  const [readers, setReaders] = useState<{ primary: string[]; lastResort: string[] } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    session
      .authed<{ primary: string[]; lastResort: string[] }>('/imports/readers')
      .then(setReaders)
      .catch(() => setFailed(true));
  }, []);
  const all = readers ? [...readers.primary, ...readers.lastResort] : [];
  return (
    <section class="stack" aria-label={t('settings.readers')}>
      <h2 class="step-title">{t('settings.readers')}</h2>
      {failed ? (
        <p class="muted">{t('settings.readers.offline')}</p>
      ) : !readers ? (
        <p class="muted">{t('common.loading')}</p>
      ) : all.length === 0 ? (
        <p class="muted">{t('settings.readers.none')}</p>
      ) : (
        <p>
          {t('settings.readers.list', { list: all.map((id) => id.split(':')[0]).join(', ') })}
          {readers.lastResort.length ? ` ${t('settings.readers.lastResort')}` : ''}
        </p>
      )}
    </section>
  );
}
