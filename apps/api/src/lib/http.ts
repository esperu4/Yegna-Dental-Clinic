import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import type { ApiErrorCode, SessionUser } from '@yegna/shared';
import type { Db } from './db.ts';

export interface Session {
  user: SessionUser;
  deviceId: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { db: Db; session: Session };
};

export function fail(c: Context, status: ContentfulStatusCode, error: ApiErrorCode, extra?: object) {
  return c.json({ error, ...extra }, status);
}

/** Parse a JSON body with a zod schema. Returns null on failure; never echoes the body back. */
export async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | null> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return null;
  }
  const result = schema.safeParse(raw);
  return result.success ? result.data : null;
}
