import { describe, expect, it } from 'vitest';
import { formatEtTime } from '@yegna/time';

describe('pwa wiring', () => {
  it('resolves workspace packages', () => {
    expect(formatEtTime(540, 'am')).toBe('3:00 ጠዋት');
  });
});
