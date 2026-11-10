/**
 * Doctor-only clinic configuration (PRD §8 items 2 and 12): procedures, weekly hours, and the
 * first-run setup wizard (language and calendar → hours → procedures → Telegram → notifications).
 */
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { HoursEditor, PreferencesPicker, ProcedureManager } from '../components/clinicConfig.tsx';
import { Screen } from '../components/ui.tsx';
import { type MessageKey, t } from '../i18n/index.ts';
import { back, go } from '../lib/router.ts';

export function Procedures() {
  return (
    <Screen title={t('procedures.title')} back={back}>
      <ProcedureManager />
    </Screen>
  );
}

export function ClinicHours() {
  return (
    <Screen title={t('hours.title')} back={back}>
      <HoursEditor />
    </Screen>
  );
}

type NotificationState = 'default' | 'granted' | 'denied' | 'unsupported';

function notificationState(): NotificationState {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

const NOTIFICATION_MESSAGES: Record<Exclude<NotificationState, 'default'>, MessageKey> = {
  granted: 'wizard.notifications.granted',
  denied: 'wizard.notifications.denied',
  unsupported: 'wizard.notifications.unsupported',
};

/** Permission is asked during onboarding, for the sync notifications (PRD §7.7). */
function NotificationStep() {
  const [state, setState] = useState<NotificationState>(notificationState());
  return (
    <div class="stack">
      <p>{t('wizard.notifications.body')}</p>
      {state === 'default' ? (
        <button
          type="button"
          class="secondary"
          onClick={() => void Notification.requestPermission().then((p) => setState(p))}
        >
          {t('wizard.notifications.allow')}
        </button>
      ) : (
        <p class="banner">{t(NOTIFICATION_MESSAGES[state])}</p>
      )}
    </div>
  );
}

interface Step {
  title: MessageKey;
  body?: MessageKey;
  content?: () => JSX.Element;
}

const STEPS: readonly Step[] = [
  { title: 'wizard.language.title', content: () => <PreferencesPicker /> },
  { title: 'hours.title', body: 'wizard.hours.body', content: () => <HoursEditor /> },
  { title: 'procedures.title', body: 'wizard.procedures.body', content: () => <ProcedureManager /> },
  // Linking the team bot arrives with M3; the step says so instead of hiding it.
  { title: 'wizard.telegram.title', body: 'wizard.telegram.body' },
  { title: 'wizard.notifications.title', content: () => <NotificationStep /> },
];

/** Shown after the Doctor sets up the clinic; reachable again from Settings. Every step can be skipped. */
export function SetupWizard() {
  const [index, setIndex] = useState(0);
  const step = STEPS[index]!;
  const last = index === STEPS.length - 1;
  const finish = () => go('home');
  return (
    <Screen title={t('wizard.title')} {...(index > 0 ? { back: () => setIndex(index - 1) } : {})}>
      <p class="muted small">{t('wizard.step', { n: index + 1, total: STEPS.length })}</p>
      <h2 class="step-title">{t(step.title)}</h2>
      {step.body ? <p>{t(step.body)}</p> : null}
      {step.content?.()}
      <div class="actions spread">
        <button type="button" class="link" onClick={finish}>
          {t('wizard.skip')}
        </button>
        <button type="button" class="primary" onClick={last ? finish : () => setIndex(index + 1)}>
          {last ? t('wizard.finish') : t('common.next')}
        </button>
      </div>
    </Screen>
  );
}
