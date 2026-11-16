/**
 * Patients (PRD §8 item 9): search by name or phone, a profile with upcoming visits and visit
 * history (bookings marked done, newest first, §5), edit name, phone and note. Delete is the
 * Doctor's only (§9) and erases the patient's details (ADR 0007). All from the working copy, so it
 * works offline; changes go through `sync.write` like every other change.
 */
import { useMemo, useState } from 'preact/hooks';
import { type BookingRow, type PatientRow, normalizePhone } from '@yegna/shared/client';
import { utcToLocal } from '@yegna/time';
import { StatusChip } from '../components/bookingCards.tsx';
import { Screen, useAction } from '../components/ui.tsx';
import { t } from '../i18n/index.ts';
import { useAllPatients, useProcedures } from '../lib/dayData.ts';
import { db } from '../lib/db.ts';
import { formatDate, formatPhone, formatTime } from '../lib/format.ts';
import { live, useLive } from '../lib/live.ts';
import { phoneDigits } from '../lib/patientSearch.ts';
import { back, go, routeParam } from '../lib/router.ts';
import { session } from '../lib/session.ts';
import { sync } from '../lib/sync.ts';
import { normalizeName } from '@yegna/shared/client';

/** Rows shown before the list asks for a search (keeps a long list fast on cheap phones). */
const LIST_LIMIT = 50;
const NOTE_MAX = 280;

export function Patients() {
  const id = routeParam.value;
  return id ? <PatientProfile id={id} /> : <PatientList />;
}

/** Everyone whose name or phone matches, alphabetically. */
export function filterPatients(patients: readonly PatientRow[], query: string): PatientRow[] {
  const q = query.trim();
  const digits = phoneDigits(q);
  const name = normalizeName(q);
  const matches =
    q === ''
      ? [...patients]
      : patients.filter(
          (p) =>
            (digits.length >= 2 && /\d/.test(q) && p.phoneE164.slice(4).includes(digits)) ||
            (name.length > 0 && normalizeName(p.name).includes(name)),
        );
  return matches.filter((p) => p.deletedAt == null).sort((a, b) => a.name.localeCompare(b.name));
}

function PatientList() {
  const patients = useAllPatients();
  const [query, setQuery] = useState('');
  const found = useMemo(() => (patients ? filterPatients(patients, query) : []), [patients, query]);
  return (
    <Screen title={t('patients.title')} back={back}>
      <label class="field">
        <span class="label">{t('patients.search')}</span>
        <input
          type="search"
          value={query}
          autoFocus
          inputMode="search"
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
      </label>
      {!patients ? <p class="muted">{t('common.loading')}</p> : null}
      {patients && found.length === 0 ? (
        <p class="muted">{query ? t('patients.none') : t('patients.empty')}</p>
      ) : null}
      <ul class="list patient-list" aria-label={t('patients.title')}>
        {found.slice(0, LIST_LIMIT).map((p) => (
          <li>
            <button type="button" class="row" onClick={() => go('patients', p.id)}>
              <span class="grow">
                <strong>{p.name}</strong>
                <span class="muted small"> {formatPhone(p.phoneE164)}</span>
              </span>
              {p.telegramLinked ? null : (
                <span title={t('patients.noTelegram')} aria-label={t('patients.noTelegram')}>
                  📵
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {found.length > LIST_LIMIT ? (
        <p class="muted small">{t('patients.more', { n: found.length - LIST_LIMIT })}</p>
      ) : null}
    </Screen>
  );
}

function PatientProfile(props: { id: string }) {
  const patient = useLive(async () => (await db.patients.get(props.id)) ?? null, [props.id]);
  const bookings = useLive(
    async () => live(await db.bookings.where('patientId').equals(props.id).toArray()),
    [props.id],
  );
  const procedures = useProcedures();
  const [editing, setEditing] = useState(false);
  const { busy, error, run } = useAction();
  const isDoctor = session.current.value?.user.role === 'doctor';

  if (patient === undefined || !bookings || !procedures) {
    return (
      <Screen title={t('patients.title')} back={back}>
        <p class="muted">{t('common.loading')}</p>
      </Screen>
    );
  }
  if (patient === null || patient.deletedAt != null) {
    return (
      <Screen title={t('patients.title')} back={() => go('patients')}>
        <p class="muted">{t('patients.gone')}</p>
      </Screen>
    );
  }

  const now = Date.now();
  const upcoming = bookings
    .filter((b) => b.startAt >= now && !['cancelled', 'no_show', 'done'].includes(b.status))
    .sort((a, b) => a.startAt - b.startAt);
  // Visit history: bookings marked done, newest first (PRD §5).
  const history = bookings.filter((b) => b.status === 'done').sort((a, b) => b.startAt - a.startAt);
  const line = (b: BookingRow) => {
    const { date, minutes } = utcToLocal(b.startAt);
    const code = b.procedureId ? procedures.get(b.procedureId)?.code : undefined;
    return `${formatDate(date)} ${formatTime(minutes)}${code ? ` · ${code}` : ''}`;
  };

  function remove() {
    if (!confirm(t('patients.delete.confirm', { name: patient!.name }))) return;
    void run(async () => {
      await sync.write('patients', 'delete', {}, patient!.id);
      go('patients');
    });
  }

  return (
    <Screen title={patient.name} back={() => go('patients')}>
      {editing ? (
        <PatientForm patient={patient} onDone={() => setEditing(false)} />
      ) : (
        <section class="stack">
          <a class="button primary call-now" href={`tel:${patient.phoneE164}`}>
            {t('action.call')} {formatPhone(patient.phoneE164)}
          </a>
          <p class="muted small">
            {patient.telegramLinked ? t('patients.telegramLinked') : `📵 ${t('patients.noTelegram')}`}
          </p>
          {patient.note ? <p class="banner">{patient.note}</p> : null}
          <div class="actions">
            <button type="button" disabled={busy} onClick={() => setEditing(true)}>
              {t('common.edit')}
            </button>
            {isDoctor ? (
              <button type="button" class="danger" disabled={busy} onClick={remove}>
                {t('common.delete')}
              </button>
            ) : null}
          </div>
        </section>
      )}

      <section class="stack" aria-label={t('patients.upcoming')}>
        <h2>{t('patients.upcoming')}</h2>
        {upcoming.length === 0 ? <p class="muted">{t('patients.noUpcoming')}</p> : null}
        <ul class="list">
          {upcoming.map((b) => (
            <li>
              <span class="grow">{line(b)}</span>
              <StatusChip booking={b} />
            </li>
          ))}
        </ul>
      </section>

      <section class="stack" aria-label={t('patients.history')}>
        <h2>{t('patients.history')}</h2>
        {history.length === 0 ? <p class="muted">{t('patients.noHistory')}</p> : null}
        <ul class="list">
          {history.map((b) => (
            <li>
              <span class="grow">{line(b)}</span>
            </li>
          ))}
        </ul>
      </section>
      {error ? <p class="banner error">{error}</p> : null}
    </Screen>
  );
}

function PatientForm(props: { patient: PatientRow; onDone: () => void }) {
  const [name, setName] = useState(props.patient.name);
  const [phone, setPhone] = useState(formatPhone(props.patient.phoneE164));
  const [note, setNote] = useState(props.patient.note ?? '');
  const [shown, setShown] = useState(false);
  const { busy, error, run } = useAction();
  const allPatients = useAllPatients();

  const normalized = normalizePhone(phone);
  const taken =
    normalized.ok &&
    allPatients?.some(
      (p) => p.id !== props.patient.id && p.deletedAt == null && p.phoneE164 === normalized.e164,
    );
  const problems = {
    name: name.trim() === '' ? t('patients.error.name') : null,
    phone: !normalized.ok ? t('patients.error.phone') : taken ? t('patients.error.phoneTaken') : null,
    note: note.length > NOTE_MAX ? t('patients.error.note', { n: NOTE_MAX }) : null,
  };
  const invalid = Object.values(problems).some(Boolean);

  function save(e: Event) {
    e.preventDefault();
    setShown(true);
    if (invalid || !normalized.ok) return;
    const fields: Record<string, unknown> = {};
    if (name.trim() !== props.patient.name) fields.name = name.trim();
    if (normalized.e164 !== props.patient.phoneE164) fields.phoneE164 = normalized.e164;
    const nextNote = note.trim() === '' ? null : note.trim();
    if (nextNote !== (props.patient.note ?? null)) fields.note = nextNote;
    void run(async () => {
      if (Object.keys(fields).length) await sync.write('patients', 'update', fields, props.patient.id);
      props.onDone();
    });
  }

  return (
    <form class="stack" onSubmit={save}>
      <label class="field">
        <span class="label">{t('sheet.name')}</span>
        <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        {shown && problems.name ? <span class="error">{problems.name}</span> : null}
      </label>
      <label class="field">
        <span class="label">{t('sheet.phone')}</span>
        <input
          type="tel"
          inputMode="tel"
          value={phone}
          onInput={(e) => setPhone((e.target as HTMLInputElement).value)}
        />
        {shown && problems.phone ? (
          <span class="error">{problems.phone}</span>
        ) : (
          <span class="hint">{t('patients.phoneHint')}</span>
        )}
      </label>
      <label class="field">
        <span class="label">{t('patients.note')}</span>
        <textarea rows={3} value={note} onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} />
        {shown && problems.note ? <span class="error">{problems.note}</span> : null}
      </label>
      <div class="actions spread">
        <button type="button" disabled={busy} onClick={props.onDone}>
          {t('common.cancel')}
        </button>
        <button type="submit" class="primary" disabled={busy}>
          {t('common.save')}
        </button>
      </div>
      {error ? <p class="banner error">{error}</p> : null}
    </form>
  );
}
