import { describe, expect, it } from 'vitest';
import type { PatientRow } from '@yegna/shared/client';
import { filterPatients } from '../src/screens/Patients.tsx';

const patient = (
  id: string,
  name: string,
  phoneE164: string,
  deletedAt: number | null = null,
): PatientRow => ({
  id,
  name,
  phoneE164,
  note: null,
  telegramLinked: false,
  version: 1,
  updatedAt: 0,
  updatedBy: null,
  deletedAt,
});

const all = [
  patient('1', 'Abebe Kebede', '+251911223344'),
  patient('2', 'ሐና ታደሰ', '+251922334455'),
  patient('3', 'Meseret Alemu', '+251933445566'),
  patient('4', 'Gone Person', '+251911000000', 5),
];

describe('patient list search (PRD §8 item 9)', () => {
  it('lists everyone alive, alphabetically, without a query', () => {
    expect(filterPatients(all, '').map((p) => p.id)).toEqual(['1', '3', '2']);
  });
  it('matches part of a name in either script, ignoring case', () => {
    expect(filterPatients(all, 'kebe').map((p) => p.id)).toEqual(['1']);
    expect(filterPatients(all, 'ታደሰ').map((p) => p.id)).toEqual(['2']);
  });
  it('matches phone digits as people type them', () => {
    expect(filterPatients(all, '0922').map((p) => p.id)).toEqual(['2']);
    expect(filterPatients(all, '+251 93').map((p) => p.id)).toEqual(['3']);
    expect(filterPatients(all, '0911').map((p) => p.id)).toEqual(['1']); // the deleted one is not listed
  });
});
