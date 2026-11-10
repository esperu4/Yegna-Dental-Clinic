import type { ComponentChildren, InputHTMLAttributes } from 'preact';
import { useState } from 'preact/hooks';
import type { ApiErrorCode } from '@yegna/shared/client';
import { type MessageKey, locale, t } from '../i18n/index.ts';
import { ApiError } from '../lib/api.ts';
import { session } from '../lib/session.ts';
import { QuickPrefs } from './QuickPrefs.tsx';

export function Screen(props: { title: string; children: ComponentChildren; back?: () => void }) {
  return (
    <main class="screen">
      <header class="bar">
        {props.back ? (
          <button type="button" class="icon" onClick={props.back} aria-label={t('common.back')}>
            ‹
          </button>
        ) : null}
        <h1>{props.title}</h1>
        {session.status.value === 'ready' ? <QuickPrefs /> : null}
      </header>
      <div class="content">{props.children}</div>
    </main>
  );
}

export function Field(
  props: { label: string; hint?: string; error?: string | null } & InputHTMLAttributes<HTMLInputElement>,
) {
  const { label, hint, error, ...input } = props;
  return (
    <label class="field">
      <span class="label">{label}</span>
      <input {...input} aria-invalid={error ? true : undefined} />
      {error ? <span class="error">{error}</span> : hint ? <span class="hint">{hint}</span> : null}
    </label>
  );
}

export function PinField(props: {
  label: string;
  value: string;
  onInput: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <Field
      label={props.label}
      type="password"
      inputMode="numeric"
      autoComplete="off"
      pattern="[0-9]*"
      maxLength={6}
      value={props.value}
      autoFocus={props.autoFocus}
      onInput={(e) => props.onInput(e.currentTarget.value.replace(/\D/g, ''))}
    />
  );
}

const ERROR_KEYS: Partial<Record<ApiErrorCode | 'offline' | 'server_error', MessageKey>> = {
  invalid_credentials: 'error.invalidCredentials',
  already_set_up: 'error.alreadySetUp',
  setup_disabled: 'error.setupDisabled',
  offline: 'error.offline',
  revoked: 'error.revoked',
  name_taken: 'error.nameTaken',
};

/** A translated message for any error thrown by the API client. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'locked')
      return t('error.locked', { minutes: Math.ceil((err.retryAfterMs ?? 60_000) / 60_000) });
    const key = ERROR_KEYS[err.code];
    if (key) return t(key);
  }
  return t('error.server');
}

/** Runs an async action, tracking busy state and a translated error. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

export function LanguageSwitch(props: { onChange?: (l: 'am' | 'en') => void }) {
  const next = locale.value === 'am' ? 'en' : 'am';
  return (
    <button
      type="button"
      class="link"
      onClick={() => {
        locale.value = next;
        props.onChange?.(next);
      }}
    >
      {next === 'en' ? 'English' : 'አማርኛ'}
    </button>
  );
}

export function pinProblem(pin: string, repeat?: string): MessageKey | null {
  if (!/^\d{4,6}$/.test(pin)) return 'error.pinFormat';
  if (repeat !== undefined && pin !== repeat) return 'error.pinMismatch';
  return null;
}
