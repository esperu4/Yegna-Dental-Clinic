/**
 * Imports (PRD §8 item 10, §12; ADR 0010): the sheet photos sent from the app or the Team bot, and
 * the review screen: the photo (tap to zoom) beside the rows read from it, each editable and tagged
 * existing patient / new patient / duplicate / unreadable. Confirming records the decisions on the
 * server, then queues the bookings through `/sync` (source = import), so every booking rule applies.
 *
 * Online only: the photo stays on Telegram and is streamed through the API.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  type BookingRow,
  type PatientRow,
  type ProcedureRow,
  isUuidv7,
  parseSheetId,
  uuidv7,
  sheetPeriod,
} from '@yegna/shared/client';
import { addDays, gridSlots, localDateOf, utcToLocal } from '@yegna/time';
import { useUnspecifiedDuration } from '../components/BookingSheet.tsx';
import { Field, Screen, ShownError, errorText, useAction } from '../components/ui.tsx';
import { type MessageKey, locale, t } from '../i18n/index.ts';
import { ApiError } from '../lib/api.ts';
import { useAllPatients, useDayPlan, useProcedures } from '../lib/dayData.ts';
import { db } from '../lib/db.ts';
import { formatDate, formatInstant, formatPhone, formatTime } from '../lib/format.ts';
import {
  type ImportDetail,
  type ImportRowView,
  type ImportSummary,
  type RowDraft,
  type RowProblem,
  mergeDrafts,
  openDrafts,
  planChanges,
  planRows,
  rowsToBook,
  shrinkPhoto,
} from '../lib/imports.ts';
import { live, useLive } from '../lib/live.ts';
import { sortProcedures } from '../lib/procedures.ts';
import { back, go, routeParam } from '../lib/router.ts';
import { session } from '../lib/session.ts';
import { sync } from '../lib/sync.ts';

export function Imports() {
  const id = routeParam.value;
  // Only an import id goes into an API path: a crafted link must not reach another route.
  return id && isUuidv7(id) ? <ImportReview id={id} key={id} /> : <ImportList />;
}

/**
 * Sheet rows whose booking is still waiting in this phone's outbox, and patients deleted here:
 * neither may be booked again from the review.
 */
function useLocalImportState():
  { queuedRowIds: ReadonlySet<string>; deletedPatientIds: ReadonlySet<string> } | undefined {
  return useLive(async () => {
    const queued = new Set<string>();
    for (const { op } of await db.outbox.toArray()) {
      const rowId = op.entity === 'bookings' ? op.fields.importRowId : undefined;
      if (typeof rowId === 'string') queued.add(rowId);
    }
    const deleted = new Set<string>();
    for (const p of await db.patients.toArray()) if (p.deletedAt != null) deleted.add(p.id);
    return { queuedRowIds: queued, deletedPatientIds: deleted };
  }, []);
}

const PHOTO_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

/** Errors this screen explains better than the generic message. */
function importErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    const keys: Partial<Record<string, MessageKey>> = {
      telegram_not_linked: 'imports.notLinked',
      too_large: 'imports.tooLarge',
      locked: 'imports.limit',
      not_configured: 'imports.notConfigured',
      conflict: 'imports.conflict',
    };
    const key = keys[err.code];
    if (key) return t(key);
    if (err.code === 'bad_request' && err.status === 400) return t('imports.notPhoto');
  }
  return errorText(err);
}

/** While a sheet is being read, the list looks again this often (for at most READ_POLL_FOR_MS). */
const READ_POLL_MS = 5_000;
const READ_POLL_FOR_MS = 3 * 60_000;

function ImportList() {
  const [list, setList] = useState<ImportSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { busy, error, setError, run } = useAction();
  const [since] = useState(() => Date.now());
  const picker = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      setList(await session.authed<ImportSummary[]>('/imports'));
      setLoadError(null);
    } catch (err) {
      setLoadError(importErrorText(err));
    }
  }
  useEffect(() => void load(), []);
  const reading = list?.some((i) => i.status === 'queued') ?? false;
  useEffect(() => {
    if (!reading || Date.now() - since > READ_POLL_FOR_MS) return;
    const timer = setTimeout(() => void load(), READ_POLL_MS);
    return () => clearTimeout(timer);
  }, [list]);

  function upload(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) return setError(t('imports.notPhoto'));
    void run(async () => {
      let photo: Blob;
      try {
        photo = await shrinkPhoto(file);
      } catch {
        // A photo this phone cannot open (e.g. HEIC on older Android).
        throw new ShownError(t('imports.notPhoto'));
      }
      try {
        const { id } = await session.authed<{ id: string }>('/imports', { raw: photo, timeoutMs: 60_000 });
        go('imports', id);
      } catch (err) {
        // Shown here rather than by useAction, with the import-specific reasons.
        throw new ShownError(importErrorText(err));
      }
    });
  }

  return (
    <Screen title={t('imports.title')} back={() => go('home')}>
      <p class="muted small">{t('imports.online')}</p>
      <button type="button" class="primary" disabled={busy} onClick={() => picker.current?.click()}>
        {busy ? t('imports.uploading') : t('imports.upload')}
      </button>
      <input
        ref={picker}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        hidden
        data-testid="import-photo"
        onChange={upload}
      />
      <p class="muted small">{t('imports.botHint')}</p>
      {error ? <p class="banner error">{error}</p> : null}
      {loadError ? <p class="banner error">{loadError}</p> : null}
      {list && list.length === 0 ? <p class="muted">{t('imports.empty')}</p> : null}
      {list && list.length ? (
        <ul class="list">
          {list.map((i) => (
            <li>
              <button type="button" class="link import-open" onClick={() => go('imports', i.id)}>
                <strong>{i.sheetId ?? t('imports.noSheetId')}</strong>
                <span class="muted small">
                  {' '}
                  · {formatInstant(i.createdAt)} · {t('imports.by', { name: i.uploadedBy })}
                </span>
                <br />
                <span class={`small${i.status === 'failed' ? ' error' : ''}`}>
                  {t(`imports.status.${i.status}`)}
                  {i.status === 'read' || i.status === 'reviewed'
                    ? ` · ${t('imports.summary', { rows: i.rows, check: i.toCheck })}`
                    : ''}
                </span>
                {i.status === 'reviewed' && i.toBook > 0 ? (
                  <>
                    <br />
                    <span class="small error">{t('imports.toBook', { n: i.toBook })}</span>
                  </>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {list ? (
        <button type="button" class="secondary" onClick={() => void load()}>
          {t('imports.refresh')}
        </button>
      ) : null}
    </Screen>
  );
}

function ImportReview(props: { id: string }) {
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<ReadonlyMap<string, RowDraft>>(new Map());
  const [problems, setProblems] = useState<Map<string, RowProblem>>(new Map());
  const [done, setDone] = useState<string | null>(null);
  // Rows sent from this screen whose booking the loaded detail does not show yet.
  const [sent, setSent] = useState<ReadonlySet<string>>(new Set());
  const { busy, error, run } = useAction();
  const procedures = useProcedures();
  const patients = useAllPatients();
  const unspecified = useUnspecifiedDuration();
  const local = useLocalImportState();

  async function fetchDetail(processQueued: boolean): Promise<ImportDetail> {
    let next = await session.authed<ImportDetail>(`/imports/${props.id}`);
    // PRD §12 step 3: a sheet the background could not finish is read when someone opens it.
    if (next.status === 'queued' && processQueued) {
      setDetail(next);
      await session.authed(`/imports/${props.id}/process`, { method: 'POST', timeoutMs: 90_000 });
      next = await session.authed<ImportDetail>(`/imports/${props.id}`);
    }
    return next;
  }
  // Only the newest load may set the detail (an older answer arriving late must not win).
  const loads = useRef(0);
  async function load(processQueued: boolean) {
    const mine = ++loads.current;
    try {
      const next = await fetchDetail(processQueued);
      if (mine === loads.current) {
        setDetail(next);
        setLoadError(null);
      }
    } catch (err) {
      if (mine === loads.current) setLoadError(importErrorText(err));
    }
  }
  useEffect(() => void load(true), [props.id]);

  const waiting = useMemo(() => (local ? new Set([...local.queuedRowIds, ...sent]) : null), [local, sent]);
  const open = useMemo(() => (detail && waiting ? rowsToBook(detail, waiting) : []), [detail, waiting]);

  // Drafts follow the open rows, keeping the reviewer's edits (PRD §12 step 5).
  useEffect(() => {
    if (!procedures || !waiting) return;
    const list = [...procedures.values()];
    setDrafts((prev) => mergeDrafts(prev, open, list));
  }, [open, procedures]);

  // When a row's booking leaves this phone's outbox (answered by the server), reload the sheet:
  // the row then shows as booked, or comes back to book again if it was refused.
  const lastQueued = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!local) return;
    const left = [...lastQueued.current].some((id) => !local.queuedRowIds.has(id));
    lastQueued.current = local.queuedRowIds;
    if (left && !busy) void load(false);
  }, [local]);

  // A reviewed sheet still offers rows whose booking was refused or never queued (ADR 0010).
  const editable = detail?.status === 'read' || (detail?.status === 'reviewed' && open.length > 0);
  const shown = openDrafts(drafts, open);
  const accepted = shown.filter((d) => d.decision === 'accept').length;

  function update(rowId: string, change: Partial<RowDraft>) {
    setDrafts((prev) => new Map(prev).set(rowId, { ...prev.get(rowId)!, ...change }));
    setProblems((prev) => {
      if (!prev.has(rowId)) return prev;
      const next = new Map(prev);
      next.delete(rowId);
      return next;
    });
  }

  function confirmRows() {
    if (!detail || !procedures || !local) return;
    setDone(null);
    const list = shown;
    void run(async () => {
      // Check against the freshest patients: one added on another phone a moment ago would
      // otherwise refuse this sheet's new patient (phone_taken) after the review is recorded.
      await sync.syncNow().catch(() => undefined);
      const plan = planRows(list, {
        patients: live(await db.patients.toArray()),
        procedures: [...procedures.values()],
        unspecifiedMin: unspecified,
        deletedPatientIds: local.deletedPatientIds,
      });
      setProblems(plan.problems);
      if (plan.problems.size) throw new ShownError(t('imports.problems'));

      let rows = plan.rows;
      // Decisions first, once: of two phones confirming the same sheet, the second gets a conflict.
      if (detail.status === 'read') {
        try {
          await session.authed(`/imports/${props.id}/confirm`, {
            body: { rows: list.map((d) => ({ id: d.rowId, decision: d.decision })) },
          });
        } catch (err) {
          if (!(err instanceof ApiError && err.code === 'conflict'))
            throw new ShownError(importErrorText(err));
          // Reviewed meanwhile (by another phone, or this confirm's answer was lost): book only the
          // rows that sheet still has open, as recorded on the server.
          const fresh = await fetchDetail(false);
          loads.current++;
          setDetail(fresh);
          if (fresh.status !== 'reviewed') throw new ShownError(importErrorText(err));
          const stillOpen = new Set(rowsToBook(fresh, waiting ?? new Set()).map((r) => r.id));
          rows = rows.filter((r) => stillOpen.has(r.rowId));
        }
      }
      // All or none, so a closed page never leaves half a sheet queued.
      await sync.writeMany(planChanges(rows, () => uuidv7()));
      setSent((prev) => new Set([...prev, ...rows.map((r) => r.rowId)]));
      setDone(t('imports.confirmed', { n: rows.length }));
      // Wait for the server's answer, then show the sheet as it now stands.
      await sync.syncNow().catch(() => undefined);
      await load(false);
      setSent(new Set());
    });
  }

  return (
    <Screen title={t('imports.review.title')} back={back}>
      {loadError ? <p class="banner error">{loadError}</p> : null}
      {detail ? (
        <p class="muted small">
          <strong>{detail.sheetId ?? t('imports.noSheetId')}</strong> · {formatInstant(detail.createdAt)} ·{' '}
          {t(`imports.status.${detail.status}`)}
        </p>
      ) : null}
      <SheetPhoto id={props.id} />
      {detail?.status === 'queued' ? <p class="muted">{t('imports.review.reading')}</p> : null}
      {detail?.status === 'failed' ? <p class="banner error">{t('imports.review.failed')}</p> : null}
      {detail?.status === 'reviewed' ? <p class="muted">{t('imports.review.reviewed')}</p> : null}
      {detail && detail.status === 'read' && detail.rows.length === 0 ? (
        <p class="muted">{t('imports.review.empty')}</p>
      ) : null}
      {done ? <p class="banner">{done}</p> : null}

      {detail && procedures && patients ? (
        <ol class="stack import-rows">
          {detail.rows.map((row) => {
            const draft = drafts.get(row.id);
            return editable && draft && open.includes(row) ? (
              <RowEditor
                row={row}
                draft={draft}
                problem={problems.get(row.id)}
                sheetId={detail.sheetId}
                patients={patients}
                procedures={procedures}
                onChange={(change) => update(row.id, change)}
              />
            ) : (
              <RowDone row={row} patients={patients} />
            );
          })}
        </ol>
      ) : null}

      {error ? <p class="banner error">{error}</p> : null}
      {editable && open.length ? (
        <button type="button" class="primary" disabled={busy} onClick={confirmRows}>
          {t('imports.confirm', { n: accepted, s: shown.length - accepted })}
        </button>
      ) : null}
    </Screen>
  );
}

/** The photo, fetched with the device's token (an <img src> cannot send it). Tap to zoom. */
function SheetPhoto(props: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    let objectUrl: string | null = null;
    let live = true;
    session
      .authed<Blob>(`/imports/${props.id}/photo`, { as: 'blob', timeoutMs: 60_000 })
      .then((blob) => {
        if (!live) return;
        // The blob URL is on the app's own origin: only ever show it as one of the photo types.
        if (!PHOTO_TYPES.includes(blob.type)) throw new Error('not a photo');
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [props.id]);
  if (failed) return <p class="muted small">{t('imports.review.photoGone')}</p>;
  if (!url) return null;
  return (
    <figure class="sheet-photo">
      <div class={`sheet-photo-frame${zoomed ? ' zoomed' : ''}`}>
        <img src={url} alt={t('imports.review.photo')} onClick={() => setZoomed(!zoomed)} />
      </div>
      <figcaption class="muted small">{t('imports.review.zoom')}</figcaption>
    </figure>
  );
}

const PROBLEM_KEYS: Record<Exclude<RowProblem['kind'], 'phoneBelongs'>, MessageKey> = {
  date: 'imports.problem.date',
  time: 'imports.problem.time',
  phoneEmpty: 'sheet.error.phoneEmpty',
  phone: 'sheet.error.phone',
  name: 'sheet.error.name',
};

function problemText(p: RowProblem): string {
  return p.kind === 'phoneBelongs'
    ? t('sheet.error.phoneBelongs', { name: p.name })
    : t(PROBLEM_KEYS[p.kind]);
}

/** What was written on paper, so the reviewer can compare it with the photo. */
function readText(row: ImportRowView): string {
  return [row.dayText, row.timeText, row.nameText, row.phoneText, row.codeText]
    .filter((x) => x && x.trim())
    .join(' · ');
}

function MatchTag(props: { row: ImportRowView }) {
  const { row } = props;
  const duplicateOf = useLive(
    async () => (row.duplicateOfId ? await db.bookings.get(row.duplicateOfId) : undefined),
    [row.duplicateOfId],
  ) as BookingRow | undefined;
  const tags: string[] = [];
  if (row.match === 'existing') tags.push(t('imports.match.existing'));
  if (row.match === 'new') tags.push(t('imports.match.new'));
  if (row.match === 'unreadable') tags.push(t('imports.match.unreadable'));
  if (row.match === 'duplicate') {
    tags.push(
      duplicateOf && duplicateOf.deletedAt == null
        ? t('imports.match.duplicate', { time: formatInstant(duplicateOf.startAt) })
        : t('imports.match.duplicateNoTime'),
    );
  }
  if (row.needsCheck) tags.push(t('imports.needsCheck'));
  return (
    <span class={`small${row.match === 'duplicate' || row.needsCheck ? ' import-warn' : ''}`}>
      {tags.join(' · ')}
    </span>
  );
}

/** Dates a row can be on: the sheet's own days, or (without a sheet ID) a free date. */
function sheetDates(sheetId: string | null): string[] | null {
  const sheet = parseSheetId(sheetId);
  if (!sheet) return null;
  const { from, to } = sheetPeriod(sheet);
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  return dates;
}

function RowEditor(props: {
  row: ImportRowView;
  draft: RowDraft;
  problem: RowProblem | undefined;
  sheetId: string | null;
  patients: PatientRow[];
  procedures: Map<string, ProcedureRow>;
  onChange: (change: Partial<RowDraft>) => void;
}) {
  const { row, draft, onChange } = props;
  const dates = useMemo(() => sheetDates(props.sheetId), [props.sheetId]);
  const plan = useDayPlan(draft.date ?? localDateOf(Date.now()));
  const slots = plan && draft.date ? gridSlots(plan.day) : [];
  // A time read outside the day's hours stays choosable; the server marks it to fix.
  if (draft.startMin != null && !slots.includes(draft.startMin)) slots.unshift(draft.startMin);
  const patient = draft.patientId ? props.patients.find((p) => p.id === draft.patientId) : undefined;
  const take = draft.decision === 'accept';
  const choices = sortProcedures(
    [...props.procedures.values()].filter((p) => p.active && p.deletedAt == null),
  );

  return (
    <li class={`card stack${props.problem ? ' has-error' : ''}${take ? '' : ' muted'}`}>
      <label class="import-take">
        <input
          type="checkbox"
          checked={take}
          onChange={(e) => onChange({ decision: e.currentTarget.checked ? 'accept' : 'skip' })}
        />
        <strong class="grow">{t('imports.take')}</strong>
      </label>
      <MatchTag row={row} />
      {readText(row) ? <span class="muted small">{t('imports.read', { text: readText(row) })}</span> : null}
      {take ? (
        <>
          <div class="import-pair">
            <label class="field grow">
              <span class="label">{t('imports.field.date')}</span>
              {dates ? (
                <select
                  value={draft.date ?? ''}
                  onChange={(e) => onChange({ date: e.currentTarget.value || null })}
                >
                  <option value="">{t('imports.choose')}</option>
                  {dates.map((d) => (
                    <option value={d}>{formatDate(d)}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="date"
                  value={draft.date ?? ''}
                  onInput={(e) => onChange({ date: e.currentTarget.value || null })}
                />
              )}
            </label>
            <label class="field grow">
              <span class="label">{t('imports.field.time')}</span>
              <select
                value={draft.startMin == null ? '' : String(draft.startMin)}
                disabled={!draft.date}
                onChange={(e) =>
                  onChange({ startMin: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) })
                }
              >
                <option value="">{t('imports.choose')}</option>
                {slots.map((m) => (
                  <option value={String(m)}>{formatTime(m)}</option>
                ))}
              </select>
            </label>
          </div>
          {patient ? (
            <p class="import-pair">
              <span class="grow">
                <strong>{patient.name}</strong> · {formatPhone(patient.phoneE164)}
              </span>
              <button
                type="button"
                class="link"
                onClick={() =>
                  onChange({
                    patientId: null,
                    name: row.nameText?.trim() ?? '',
                    phone: row.phoneText?.trim() ?? '',
                  })
                }
              >
                {t('imports.notThisPatient')}
              </button>
            </p>
          ) : (
            <div class="import-pair">
              <Field
                label={t('imports.field.phone')}
                value={draft.phone}
                inputMode="tel"
                onInput={(e) => onChange({ phone: e.currentTarget.value })}
              />
              <Field
                label={t('imports.field.name')}
                value={draft.name}
                onInput={(e) => onChange({ name: e.currentTarget.value })}
              />
            </div>
          )}
          <label class="field">
            <span class="label">{t('imports.field.procedure')}</span>
            <select
              value={draft.procedureId ?? ''}
              onChange={(e) => onChange({ procedureId: e.currentTarget.value || null })}
            >
              <option value="">{t('imports.noProcedure')}</option>
              {choices.map((p) => (
                <option value={p.id}>
                  {p.code} · {locale.value === 'am' ? p.nameAm : p.nameEn}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : null}
      {props.problem ? <p class="error">{problemText(props.problem)}</p> : null}
    </li>
  );
}

function RowDone(props: { row: ImportRowView; patients: PatientRow[] }) {
  const { row } = props;
  const patient = row.patientId ? props.patients.find((p) => p.id === row.patientId) : undefined;
  const local = row.startAt == null ? null : utcToLocal(row.startAt);
  return (
    <li class="card">
      <strong>{patient?.name ?? row.nameText ?? '…'}</strong>
      {local ? (
        <span class="muted small">
          {' '}
          · {formatDate(local.date)} {formatTime(local.minutes)}
        </span>
      ) : null}
      <br />
      <span class="small">
        {row.bookingId
          ? t('imports.booked')
          : row.decision === 'skip'
            ? t('imports.skipped')
            : row.decision === 'accept'
              ? t('imports.sent')
              : ''}
      </span>{' '}
      <MatchTag row={row} />
    </li>
  );
}
