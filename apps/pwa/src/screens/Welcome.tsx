/** First screen on a new device: enrol, or set up the clinic (Doctor, with the setup code). */
import { useEffect, useState } from 'preact/hooks';
import { DOCTOR_PIN_LENGTH, isTrivialPin } from '@yegna/shared/client';
import { Field, LanguageSwitch, PinField, Screen, pinProblem, useAction } from '../components/ui.tsx';
import { calendarPref, locale, t } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { session } from '../lib/session.ts';

type Mode = 'choose' | 'setup' | 'enrol';

export function Welcome() {
  const [mode, setMode] = useState<Mode>('choose');
  const [setupNeeded, setSetupNeeded] = useState(false);

  useEffect(() => {
    api<{ needed: boolean }>('/setup')
      .then((r) => setSetupNeeded(r.needed))
      .catch(() => setSetupNeeded(false));
  }, []);

  if (mode === 'setup') return <SetupForm back={() => setMode('choose')} />;
  if (mode === 'enrol') return <EnrolForm back={() => setMode('choose')} />;
  return (
    <Screen title={t('app.name')}>
      {session.notice.value === 'revoked' ? <p class="banner warn">{t('error.revoked')}</p> : null}
      <p class="lead">{t('welcome.title')}</p>
      <button type="button" class="primary" onClick={() => setMode('enrol')}>
        {t('welcome.enrol')}
      </button>
      {setupNeeded ? (
        <button type="button" class="secondary" onClick={() => setMode('setup')}>
          {t('welcome.setup')}
        </button>
      ) : null}
      <LanguageSwitch />
    </Screen>
  );
}

function SetupForm(props: { back: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [repeat, setRepeat] = useState('');
  const [label, setLabel] = useState('');
  const { busy, error, setError, run } = useAction();

  function submit(e: Event) {
    e.preventDefault();
    if (!code.trim() || !name.trim() || !label.trim()) return setError(t('error.required'));
    const problem = pinProblem(pin, repeat);
    if (problem) return setError(t(problem));
    if (pin.length !== DOCTOR_PIN_LENGTH) return setError(t('error.pinDoctorLength'));
    if (isTrivialPin(pin)) return setError(t('error.pinTrivial'));
    void run(() =>
      session.setup({
        code: code.trim(),
        name,
        pin,
        deviceLabel: label,
        locale: locale.value,
        calendar: calendarPref.value,
      }),
    );
  }

  return (
    <Screen title={t('setup.title')} back={props.back}>
      <form onSubmit={submit} class="stack">
        <p>{t('setup.body')}</p>
        <Field
          label={t('field.setupCode')}
          value={code}
          autoComplete="off"
          onInput={(e) => setCode(e.currentTarget.value)}
        />
        <Field
          label={t('field.name')}
          value={name}
          autoComplete="name"
          onInput={(e) => setName(e.currentTarget.value)}
        />
        <PinField label={t('field.doctorPin')} value={pin} onInput={setPin} />
        <PinField label={t('field.pinRepeat')} value={repeat} onInput={setRepeat} />
        <Field
          label={t('field.deviceLabel')}
          hint={t('field.deviceLabel.hint')}
          value={label}
          onInput={(e) => setLabel(e.currentTarget.value)}
        />
        {error ? <p class="banner error">{error}</p> : null}
        <button type="submit" class="primary" disabled={busy}>
          {busy ? t('common.loading') : t('common.continue')}
        </button>
      </form>
    </Screen>
  );
}

function EnrolForm(props: { back: () => void }) {
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [label, setLabel] = useState('');
  const { busy, error, setError, run } = useAction();

  function submit(e: Event) {
    e.preventDefault();
    if (!name.trim() || !label.trim()) return setError(t('error.required'));
    const problem = pinProblem(pin);
    if (problem) return setError(t(problem));
    void run(() => session.enrol({ name, pin, deviceLabel: label }));
  }

  return (
    <Screen title={t('enrol.title')} back={props.back}>
      <form onSubmit={submit} class="stack">
        <p>{t('enrol.body')}</p>
        <Field
          label={t('field.name')}
          value={name}
          autoComplete="name"
          onInput={(e) => setName(e.currentTarget.value)}
        />
        <PinField label={t('field.pin')} value={pin} onInput={setPin} />
        <Field
          label={t('field.deviceLabel')}
          hint={t('field.deviceLabel.hint')}
          value={label}
          onInput={(e) => setLabel(e.currentTarget.value)}
        />
        {error ? <p class="banner error">{error}</p> : null}
        <button type="submit" class="primary" disabled={busy}>
          {busy ? t('common.loading') : t('common.continue')}
        </button>
      </form>
    </Screen>
  );
}
