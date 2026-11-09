/** PIN lock after 24 h without use. Checked on the device, so it works offline. */
import { useState } from 'preact/hooks';
import { PinField, Screen } from '../components/ui.tsx';
import { t } from '../i18n/index.ts';
import { session } from '../lib/session.ts';

export function Lock() {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    const res = await session.unlock(pin);
    setBusy(false);
    setPin('');
    if (res.ok) return;
    setError(
      res.reason === 'locked'
        ? t('error.locked', { minutes: Math.ceil(res.retryAfterMs / 60_000) })
        : t('error.wrongPin'),
    );
  }

  return (
    <Screen title={t('lock.title')}>
      <form onSubmit={submit} class="stack">
        <p class="lead">{t('lock.hello', { name: session.current.value?.user.name ?? '' })}</p>
        <PinField label={t('field.pin')} value={pin} onInput={setPin} autoFocus />
        {error ? <p class="banner error">{error}</p> : null}
        <button type="submit" class="primary" disabled={busy || pin.length < 4}>
          {t('lock.unlock')}
        </button>
        <button
          type="button"
          class="link"
          onClick={() => {
            if (confirm(t('settings.signOut.confirm'))) void session.wipe();
          }}
        >
          {t('lock.signOut')}
        </button>
      </form>
    </Screen>
  );
}
