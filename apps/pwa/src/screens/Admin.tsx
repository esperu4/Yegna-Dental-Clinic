/** Doctor-only: Staff accounts and Phones (PRD §9: users, devices, revoke). */
import { useEffect, useState } from 'preact/hooks';
import { type DeviceInfo, isTrivialPin, uuidv7 } from '@yegna/shared/client';
import { Field, PinField, Screen, errorText, pinProblem, useAction } from '../components/ui.tsx';
import { t } from '../i18n/index.ts';
import { formatInstant } from '../lib/format.ts';
import { back } from '../lib/router.ts';
import { session } from '../lib/session.ts';

interface UserRow {
  id: string;
  name: string;
  role: 'doctor' | 'staff';
  disabledAt: number | null;
  telegramLinked: boolean;
}

function useList<T>(path: string) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () =>
    session
      .authed<T[]>(path)
      .then(setItems)
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    void reload();
  }, [path]);
  return { items, error, reload };
}

function pinError(pin: string): string | null {
  const problem = pinProblem(pin);
  if (problem) return t(problem);
  return isTrivialPin(pin) ? t('error.pinTrivial') : null;
}

export function Users() {
  const { items, error: loadError, reload } = useList<UserRow>('/admin/users');
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const { busy, error, setError, run } = useAction();

  function add(e: Event) {
    e.preventDefault();
    if (!name.trim()) return setError(t('error.required'));
    const problem = pinError(pin);
    if (problem) return setError(problem);
    void run(async () => {
      await session.authed('/admin/users', { body: { id: uuidv7(), name, pin } });
      setName('');
      setPin('');
      await reload();
    });
  }

  function patch(id: string, body: object) {
    void run(async () => {
      await session.authed(`/admin/users/${id}`, { method: 'PATCH', body });
      await reload();
    });
  }

  function unlinkTelegram(u: UserRow) {
    if (!confirm(t('users.unlinkTelegram.confirm', { name: u.name }))) return;
    void run(async () => {
      await session.authed(`/admin/users/${u.id}/telegram/unlink`, { method: 'POST' });
      await reload();
    });
  }

  function newPin(u: UserRow) {
    const value = prompt(t('users.newPin.prompt', { name: u.name }))?.trim();
    if (!value) return;
    const problem = pinError(value);
    if (problem) return setError(problem);
    patch(u.id, { pin: value });
  }

  return (
    <Screen title={t('settings.users')} back={back}>
      <form onSubmit={add} class="stack card">
        <Field label={t('field.name')} value={name} onInput={(e) => setName(e.currentTarget.value)} />
        <PinField label={t('field.pin')} value={pin} onInput={setPin} />
        <button type="submit" class="primary" disabled={busy}>
          {t('users.add')}
        </button>
      </form>
      {error || loadError ? <p class="banner error">{error ?? loadError}</p> : null}
      <ul class="list">
        {(items ?? []).map((u) => (
          <li key={u.id}>
            <div>
              <strong>{u.name}</strong>
              <span class="muted">
                {' '}
                · {t(u.role === 'doctor' ? 'users.role.doctor' : 'users.role.staff')}
                {u.disabledAt ? ` · ${t('users.disabled')}` : ''}
                {u.telegramLinked ? ` · ${t('users.telegramLinked')}` : ''}
              </span>
            </div>
            {u.telegramLinked && u.id !== session.current.value?.user.id ? (
              <div class="actions">
                <button type="button" disabled={busy} onClick={() => unlinkTelegram(u)}>
                  {t('users.unlinkTelegram')}
                </button>
              </div>
            ) : null}
            {u.role === 'staff' ? (
              <div class="actions">
                <button type="button" disabled={busy} onClick={() => newPin(u)}>
                  {t('users.resetPin')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => patch(u.id, { disabled: !u.disabledAt })}
                >
                  {t(u.disabledAt ? 'users.enable' : 'users.disable')}
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Screen>
  );
}

export function Devices() {
  const { items, error: loadError, reload } = useList<DeviceInfo>('/admin/devices');
  const { busy, error, run } = useAction();
  const mine = session.current.value?.deviceId;

  function revoke(d: DeviceInfo) {
    if (!confirm(t('devices.revoke.confirm', { label: d.label }))) return;
    void run(async () => {
      await session.authed(`/admin/devices/${d.id}/revoke`, { method: 'POST' });
      await reload();
    });
  }

  return (
    <Screen title={t('settings.devices')} back={back}>
      {error || loadError ? <p class="banner error">{error ?? loadError}</p> : null}
      <ul class="list">
        {(items ?? []).map((d) => (
          <li key={d.id}>
            <div>
              <strong>{d.label}</strong>
              <span class="muted"> · {d.userName}</span>
              <div class="muted small">
                {d.id === mine
                  ? t('devices.thisPhone')
                  : d.revokedAt
                    ? t('devices.revoked')
                    : d.lastSeenAt
                      ? t('devices.lastSeen', { when: formatInstant(d.lastSeenAt) })
                      : t('devices.never')}
              </div>
            </div>
            {d.id !== mine && !d.revokedAt ? (
              <div class="actions">
                <button type="button" class="danger" disabled={busy} onClick={() => revoke(d)}>
                  {t('devices.revoke')}
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Screen>
  );
}
