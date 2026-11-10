/**
 * Counts D1 queries the way Cloudflare does for its per-invocation limit: each executed
 * statement is one, and a whole `batch()` is one. The free plan allows 50 (PRD §19; verified in
 * the D1 limits docs on 2026-11-10). `/sync` uses the count to stop applying ops before the
 * limit; the device sends the rest in its next call.
 */
export const D1_QUERIES_PER_INVOCATION = 50;

const TARGET = Symbol('d1Target');
const EXECUTE = new Set(['first', 'all', 'run', 'raw']);

export interface QueryMeter {
  /** The binding to hand to Drizzle; every query through it is counted. */
  d1: D1Database;
  used(): number;
  remaining(): number;
}

export function meterD1(d1: D1Database, limit = D1_QUERIES_PER_INVOCATION): QueryMeter {
  let count = 0;

  const wrapStatement = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop) {
        if (prop === TARGET) return target;
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== 'function') return value;
        if (prop === 'bind') return (...args: unknown[]) => wrapStatement(target.bind(...args));
        const fn = value as (...a: unknown[]) => unknown;
        if (typeof prop === 'string' && EXECUTE.has(prop)) {
          return (...args: unknown[]) => {
            count++;
            return fn.apply(target, args);
          };
        }
        return fn.bind(target);
      },
    });

  const unwrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
    (stmt as unknown as Record<symbol, D1PreparedStatement | undefined>)[TARGET] ?? stmt;

  const wrapped = new Proxy(d1, {
    get(target, prop) {
      if (prop === 'prepare') return (query: string) => wrapStatement(target.prepare(query));
      if (prop === 'batch') {
        return (statements: D1PreparedStatement[]) => {
          count++;
          return target.batch(statements.map(unwrap));
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });

  return { d1: wrapped, used: () => count, remaining: () => limit - count };
}
