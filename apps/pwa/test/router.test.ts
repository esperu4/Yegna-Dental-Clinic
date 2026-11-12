import { describe, expect, it } from 'vitest';
import { parseHash } from '../src/lib/router.ts';

describe('hash routes', () => {
  it('reads a route and its optional parameter', () => {
    expect(parseHash('')).toEqual({ route: 'home', param: null });
    expect(parseHash('#/print')).toEqual({ route: 'print', param: null });
    expect(parseHash('#/imports/0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b')).toEqual({
      route: 'imports',
      param: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    });
  });

  it('falls back to home for unknown routes, dropping their parameter', () => {
    expect(parseHash('#/nope/123')).toEqual({ route: 'home', param: null });
  });
});
