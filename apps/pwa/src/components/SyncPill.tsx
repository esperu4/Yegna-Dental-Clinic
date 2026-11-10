/**
 * The sync status pill, always in the header (PRD §7.6):
 * 🟢 Synced (tap: time of the last sync) · 🟡 N changes waiting · 🔴 Offline since 09:40 ·
 * ⚠️ Sync problem (tap: the reason and a retry button).
 */
import { useState } from 'preact/hooks';
import { utcToLocal } from '@yegna/time';
import { type MessageKey, t } from '../i18n/index.ts';
import { formatTime } from '../lib/format.ts';
import { sync } from '../lib/sync.ts';
import { pillState } from '../lib/syncStatus.ts';

const PROBLEM_KEYS: Record<string, MessageKey> = {
  server_error: 'pill.problem.server',
  offline: 'pill.problem.server',
};

export function SyncPill() {
  const [open, setOpen] = useState(false);
  const state = pillState({
    state: sync.state.value,
    lastError: sync.lastError.value,
    offlineSince: sync.offlineSince.value,
    pendingCount: sync.pendingCount.value,
    lastSyncedAt: sync.lastSyncedAt.value,
    heldUntil: sync.heldUntil.value,
  });
  const time = (ms: number) => formatTime(utcToLocal(ms).minutes);

  const label =
    state.kind === 'synced'
      ? t('pill.synced')
      : state.kind === 'starting'
        ? t('pill.starting')
        : state.kind === 'waiting'
          ? t('pill.waiting', { n: state.count })
          : state.kind === 'offline'
            ? t('pill.offline', { time: time(state.since) })
            : t('pill.problem');

  return (
    <div class="pill-wrap">
      <button
        type="button"
        class={`sync-pill pill-${state.kind}`}
        aria-expanded={open}
        aria-label={`${t('pill.title')}: ${label}`}
        onClick={() => setOpen(!open)}
      >
        <span class="dot" aria-hidden="true" />
        {label}
      </button>
      {open ? (
        <div class="pill-details" role="status">
          {state.kind === 'synced' ? <p>{t('pill.lastSync', { time: time(state.at) })}</p> : null}
          {state.kind === 'starting' ? <p>{t('pill.neverSynced')}</p> : null}
          {state.kind === 'waiting' ? (
            <p>
              {state.heldUntil ? t('pill.heldHelp', { time: time(state.heldUntil) }) : t('pill.waitingHelp')}
            </p>
          ) : null}
          {state.kind === 'offline' ? <p>{t('pill.offlineHelp')}</p> : null}
          {state.kind === 'problem' ? <p>{t(PROBLEM_KEYS[state.reason] ?? 'pill.problem.server')}</p> : null}
          {state.kind !== 'synced' ? (
            <button type="button" class="primary" onClick={() => void sync.syncNow()}>
              {t('pill.retry')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
