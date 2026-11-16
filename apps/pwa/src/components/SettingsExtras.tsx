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
import { PinField, useAction } from './ui.tsx';
import { isTrivialPin } from '@yegna/shared/client';

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

/** One's own PIN (the Doctor's is 6 digits, ADR 0005); the Doctor can also reset Staff PINs. */
export function ChangeMyPin() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const { busy, error, setError, run } = useAction();
  if (!open) {
    return (
      <button type="button" class="row" onClick={() => setOpen(true)}>
        {t('settings.changePin')} ›
      </button>
    );
  }
  function save(e: Event) {
    e.preventDefault();
    setMessage(null);
    const doctor = session.current.value?.user.role === 'doctor';
    if (doctor ? !/^\d{6}$/.test(next) : !/^\d{4,6}$/.test(next)) {
      return setError(t(doctor ? 'error.doctorPinFormat' : 'error.pinFormat'));
    }
    if (next !== repeat) return setError(t('error.pinMismatch'));
    if (isTrivialPin(next)) return setError(t('error.pinTrivial'));
    void run(async () => {
      const result = await session.changePin(current, next);
      if (!result.ok) {
        throw new Error(
          result.reason === 'locked'
            ? t('settings.changePin.locked', { minutes: Math.ceil(result.retryAfterMs / 60_000) })
            : t('settings.changePin.wrong'),
        );
      }
      setOpen(false);
      setCurrent('');
      setNext('');
      setRepeat('');
      setMessage(t('settings.changePin.done'));
    });
  }
  return (
    <form class="stack" onSubmit={save} aria-label={t('settings.changePin')}>
      <h2 class="step-title">{t('settings.changePin')}</h2>
      <PinField label={t('settings.changePin.current')} value={current} onInput={setCurrent} />
      <PinField label={t('settings.changePin.next')} value={next} onInput={setNext} />
      <PinField label={t('settings.changePin.repeat')} value={repeat} onInput={setRepeat} />
      <div class="actions spread">
        <button type="button" disabled={busy} onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </button>
        <button type="submit" class="primary" disabled={busy}>
          {t('common.save')}
        </button>
      </div>
      {error ? <p class="banner error">{error}</p> : null}
      {message ? <p class="banner">{message}</p> : null}
    </form>
  );
}
