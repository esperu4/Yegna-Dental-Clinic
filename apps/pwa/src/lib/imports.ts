/**
 * The Imports review (PRD §8 item 10, §12; ADR 0010): what the server sends, the editable draft of
 * each sheet row, and turning confirmed rows into the patient and booking ops that go through
 * `/sync` like any booking (so hours, clash and approval rules all apply).
 *
 * Pure, so it is unit-tested; the screen only renders it.
 */
import { type PatientRow, type ProcedureRow, normalizeName, normalizePhone } from '@yegna/shared/client';
import { bookingDuration, localToUtc, utcToLocal } from '@yegna/time';
import { normalizeCode } from './procedures.ts';
import type { WriteChange } from './sync.ts';

export type ImportStatus = 'queued' | 'read' | 'reviewed' | 'failed';
export type RowMatch = 'existing' | 'new' | 'duplicate' | 'unreadable';
export type Decision = 'accept' | 'skip';

/** `GET /imports` */
export interface ImportSummary {
  id: string;
  status: ImportStatus;
  template: string | null;
  sheetId: string | null;
  provider: string | null;
  createdAt: number;
  uploadedBy: string;
  rows: number;
  toCheck: number;
  /** Accepted rows with no booking on the server yet (refused, or still queued on a phone). */
  toBook: number;
}

/** One row of `GET /imports/:id`. */
export interface ImportRowView {
  id: string;
  dayText: string | null;
  timeText: string | null;
  nameText: string | null;
  phoneText: string | null;
  codeText: string | null;
  confidence: number | null;
  match: RowMatch | null;
  decision: Decision | null;
  startAt: number | null;
  patientId: string | null;
  duplicateOfId: string | null;
  needsCheck: boolean | number;
  /** The booking the server made from this row, if any. */
  bookingId: string | null;
}

export interface ImportDetail extends Omit<ImportSummary, 'uploadedBy' | 'rows' | 'toCheck' | 'toBook'> {
  rows: ImportRowView[];
}

/** A row as the reviewer is fixing it. */
export interface RowDraft {
  rowId: string;
  decision: Decision;
  /** Clinic-local date and minutes; `null` until known. */
  date: string | null;
  startMin: number | null;
  name: string;
  /** As typed (or as read). */
  phone: string;
  /** The patient the server matched, until the reviewer says it is someone else. */
  patientId: string | null;
  procedureId: string | null;
}

export function initialDraft(row: ImportRowView, procedures: readonly ProcedureRow[]): RowDraft {
  const local = row.startAt == null ? null : utcToLocal(row.startAt);
  const code = row.codeText ? normalizeCode(row.codeText) : '';
  const procedure = code
    ? procedures.find((p) => p.deletedAt == null && p.active && p.code === code)
    : undefined;
  return {
    rowId: row.id,
    // Duplicates and unreadable rows are skipped unless the reviewer takes them (PRD §12 step 5).
    decision: row.decision ?? (row.match === 'duplicate' || row.match === 'unreadable' ? 'skip' : 'accept'),
    date: local?.date ?? null,
    startMin: local?.minutes ?? null,
    name: row.nameText?.trim() ?? '',
    phone: row.phoneText?.trim() ?? '',
    patientId: row.patientId,
    procedureId: procedure?.id ?? null,
  };
}

export type RowProblem =
  | { kind: 'date' }
  | { kind: 'time' }
  | { kind: 'phoneEmpty' }
  | { kind: 'phone' }
  | { kind: 'name' }
  /** The phone is on file for someone with another name: never attach a booking silently. */
  | { kind: 'phoneBelongs'; name: string };

export interface PlannedRow {
  rowId: string;
  /** An existing patient, or a new one to create first (one per phone across the sheet). */
  patientId: string | null;
  newPatient: { name: string; phoneE164: string } | null;
  booking: { procedureId: string | null; startAt: number; durationMin: number; importRowId: string };
}

export interface Plan {
  rows: PlannedRow[];
  problems: Map<string, RowProblem>;
}

/** Checks every accepted row and plans its ops; any problem stops the whole confirmation. */
export function planRows(
  drafts: readonly RowDraft[],
  ctx: {
    patients: readonly PatientRow[];
    procedures: readonly ProcedureRow[];
    unspecifiedMin?: number | undefined;
    /** Patients deleted on this phone (a match to one of them is not used). */
    deletedPatientIds?: ReadonlySet<string>;
  },
): Plan {
  const rows: PlannedRow[] = [];
  const problems = new Map<string, RowProblem>();
  const livePatients = ctx.patients.filter((p) => p.deletedAt == null);
  const byPhone = new Map(livePatients.map((p) => [p.phoneE164, p]));
  // New patients planned earlier on this sheet, by phone (the same person twice in a week).
  const planned = new Map<string, string>();

  for (const d of drafts) {
    if (d.decision !== 'accept') continue;
    if (!d.date) {
      problems.set(d.rowId, { kind: 'date' });
      continue;
    }
    if (d.startMin == null) {
      problems.set(d.rowId, { kind: 'time' });
      continue;
    }

    // The server matched this patient (by phone, or by name on template O). It may not be on this
    // phone yet; the server checks it again (patient_not_found). Only one deleted here is dropped.
    let patientId: string | null =
      d.patientId && !ctx.deletedPatientIds?.has(d.patientId) ? d.patientId : null;
    let newPatient: PlannedRow['newPatient'] = null;
    if (!patientId) {
      const phone = normalizePhone(d.phone);
      if (!phone.ok) {
        problems.set(d.rowId, { kind: phone.error === 'empty' ? 'phoneEmpty' : 'phone' });
        continue;
      }
      const name = d.name.trim();
      const existing = byPhone.get(phone.e164);
      const otherName = existing ? existing.name : planned.get(phone.e164);
      if (otherName !== undefined && name && normalizeName(name) !== normalizeName(otherName)) {
        problems.set(d.rowId, { kind: 'phoneBelongs', name: otherName });
        continue;
      }
      if (existing) patientId = existing.id;
      else if (!name) {
        problems.set(d.rowId, { kind: 'name' });
        continue;
      } else {
        newPatient = { name, phoneE164: phone.e164 };
        planned.set(phone.e164, name);
      }
    }

    const procedure = d.procedureId ? ctx.procedures.find((p) => p.id === d.procedureId) : undefined;
    rows.push({
      rowId: d.rowId,
      patientId,
      newPatient,
      booking: {
        procedureId: procedure?.id ?? null,
        startAt: localToUtc(d.date, d.startMin),
        durationMin: bookingDuration(procedure?.durationMin, ctx.unspecifiedMin),
        importRowId: d.rowId,
      },
    });
  }
  return { rows, problems };
}

/**
 * The ops for a plan, in order: each new patient once (per phone), before its bookings. They are
 * written all or none (`sync.writeMany`), so a closed page never leaves half a sheet queued.
 */
export function planChanges(plan: readonly PlannedRow[], newId: () => string): WriteChange[] {
  const changes: WriteChange[] = [];
  const created = new Map<string, string>();
  for (const row of plan) {
    let patientId = row.patientId;
    if (!patientId && row.newPatient) {
      const phone = row.newPatient.phoneE164;
      patientId = created.get(phone) ?? null;
      if (!patientId) {
        patientId = newId();
        created.set(phone, patientId);
        changes.push({
          entity: 'patients',
          kind: 'create',
          fields: { ...row.newPatient },
          entityId: patientId,
        });
      }
    }
    changes.push({ entity: 'bookings', kind: 'create', fields: { patientId, ...row.booking } });
  }
  return changes;
}

/**
 * Rows still to book: accepted (or not yet decided), with no booking on the server and none
 * waiting on this phone. On a reviewed sheet these are rows whose booking was refused or never
 * queued; booking them again is safe (one booking per row, ADR 0010).
 */
export function rowsToBook(detail: ImportDetail, queuedRowIds: ReadonlySet<string>): ImportRowView[] {
  return detail.rows.filter(
    (r) =>
      !r.bookingId &&
      !queuedRowIds.has(r.id) &&
      (detail.status === 'read' || (detail.status === 'reviewed' && r.decision === 'accept')),
  );
}

/**
 * Drafts for the open rows: the reviewer's edits are kept (a background sync must never undo
 * them), and rows newly open start from what was read. Drafts of rows that left are kept too, so a
 * sent row that the server refuses comes back with the reviewer's corrections, not the misread
 * values. Returns `prev` itself when nothing changed. Use `openDrafts` for what is on screen.
 */
export function mergeDrafts(
  prev: ReadonlyMap<string, RowDraft>,
  open: readonly ImportRowView[],
  procedures: readonly ProcedureRow[],
): ReadonlyMap<string, RowDraft> {
  const missing = open.filter((r) => !prev.has(r.id));
  if (!missing.length) return prev;
  const next = new Map(prev);
  for (const r of missing) next.set(r.id, initialDraft(r, procedures));
  return next;
}

/** The drafts of the open rows, in sheet order. */
export function openDrafts(
  drafts: ReadonlyMap<string, RowDraft>,
  open: readonly ImportRowView[],
): RowDraft[] {
  return open.flatMap((r) => drafts.get(r.id) ?? []);
}

/** The longest side of an uploaded photo: plenty to read a sheet, and far under the 5 MB limit. */
export const UPLOAD_MAX_SIDE = 2400;

/** Shrinks a camera photo to a JPEG the server accepts (phones take 4–12 MB pictures). */
export async function shrinkPhoto(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, UPLOAD_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', 0.85),
    );
  } finally {
    bitmap.close();
  }
}
