/**
 * `pnpm eval:imports` (PRD §12, §20 M4): reads every golden page with each configured reader and
 * reports per-field accuracy and corrections per page. Readers come from the same keys the API
 * uses, read from the environment (never committed):
 *   CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (Workers AI), MISTRAL_API_KEY, GROQ_API_KEY,
 *   or `--workers-ai` to reach Workers AI through your `wrangler login` (remote binding),
 *   OPENROUTER_API_KEY, GEMINI_API_KEY; model overrides WORKERS_AI_MODEL, GROQ_MODEL, …
 * Options: `--reader <id-prefix>` (only that reader), `--case <name-prefix>`, `--out <file.json>`.
 * Exits 1 when any reader averages ≥ 3 corrections per page on templates F and C (the M4 target).
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  type AiBinding,
  type ReadInput,
  type ReadResult,
  type ScheduleReader,
  chatReader,
  geminiReader,
  mistralOcrReader,
  workersAiReader,
} from '../src/index.ts';
import { PROMPT_VERSION } from '../src/prompt.ts';
import { type PageScore, scorePage, summarise } from '../src/score.ts';

/** Same defaults as `apps/api/src/imports/readers.ts`. */
const MODELS = {
  workersAi: '@cf/meta/llama-4-scout-17b-16e-instruct',
  groq: 'qwen/qwen3.8-27b',
  openRouter: 'openrouter/free',
  gemini: 'gemini-3-flash-preview',
};

interface GoldenCase {
  name: string;
  image: string;
  mime: string;
  template: ReadInput['template'];
  locale: ReadInput['locale'];
  procedures: ReadInput['procedures'];
  expected: ReadResult;
}

const GOLDEN_DIR = join(import.meta.dirname, '..', 'golden');

function workersAiRest(accountId: string, token: string): AiBinding {
  return {
    async run(model, inputs, options) {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(inputs),
        signal: (options?.signal as AbortSignal | undefined) ?? null,
      });
      const body = (await res.json()) as { result?: unknown; errors?: { message: string }[] };
      if (!res.ok) throw new Error(`${res.status} ${body.errors?.map((e) => e.message).join('; ') ?? ''}`);
      return body.result;
    },
  };
}

/** The Workers AI binding through `wrangler login` (remote; nothing runs on this machine). */
async function workersAiProxy(): Promise<{ ai: AiBinding; dispose: () => Promise<void> }> {
  const { getPlatformProxy } = await import('wrangler');
  const proxy = await getPlatformProxy<{ AI: AiBinding }>({
    configPath: join(import.meta.dirname, 'eval.wrangler.jsonc'),
    persist: false,
  });
  // The proxy cannot pass an AbortSignal (the deployed binding can); the reader's timeout is lost.
  return { ai: { run: (model, inputs) => proxy.env.AI.run(model, inputs) }, dispose: proxy.dispose };
}

function readers(env: NodeJS.ProcessEnv, ai?: AiBinding): ScheduleReader[] {
  const list: ScheduleReader[] = [];
  const binding =
    ai ??
    (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN
      ? workersAiRest(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN)
      : undefined);
  if (binding) {
    list.push(workersAiReader({ ai: binding, model: env.WORKERS_AI_MODEL ?? MODELS.workersAi }));
  }
  if (env.MISTRAL_API_KEY) list.push(mistralOcrReader({ apiKey: env.MISTRAL_API_KEY }));
  if (env.GROQ_API_KEY) {
    list.push(
      chatReader({
        id: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: env.GROQ_API_KEY,
        model: env.GROQ_MODEL ?? MODELS.groq,
        jsonMode: true,
      }),
    );
  }
  if (env.OPENROUTER_API_KEY) {
    list.push(
      chatReader({
        id: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: env.OPENROUTER_API_KEY,
        model: env.OPENROUTER_MODEL ?? MODELS.openRouter,
      }),
    );
  }
  if (env.GEMINI_API_KEY) {
    list.push(geminiReader({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL ?? MODELS.gemini }));
  }
  return list;
}

async function loadCases(dir = GOLDEN_DIR): Promise<GoldenCase[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  return Promise.all(
    files.map(async (f) => ({
      name: f.replace(/\.json$/, ''),
      ...(JSON.parse(await readFile(join(dir, f), 'utf8')) as Omit<GoldenCase, 'name'>),
    })),
  );
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5);

async function main() {
  const { values } = parseArgs({
    options: {
      reader: { type: 'string' },
      case: { type: 'string' },
      out: { type: 'string' },
      'workers-ai': { type: 'boolean' },
    },
  });
  const proxy = values['workers-ai'] ? await workersAiProxy() : undefined;
  try {
    await evaluate(values, proxy?.ai);
  } finally {
    await proxy?.dispose();
  }
}

async function evaluate(values: { reader?: string; case?: string; out?: string }, ai: AiBinding | undefined) {
  const cases = (await loadCases()).filter((c) => !values.case || c.name.startsWith(values.case));
  const list = readers(process.env, ai).filter((r) => !values.reader || r.id.startsWith(values.reader));
  if (cases.length === 0) throw new Error(`No golden cases in ${GOLDEN_DIR}`);
  if (list.length === 0) {
    console.log('No reader configured: set at least one key (see the top of this script).');
    return;
  }

  console.log(
    `Prompt ${PROMPT_VERSION} · ${cases.length} golden pages · readers: ${list.map((r) => r.id).join(', ')}`,
  );
  const report: Record<string, unknown> = { prompt: PROMPT_VERSION, at: new Date().toISOString() };
  let failed = false;
  for (const reader of list) {
    const scores: (PageScore & { name: string; template: string })[] = [];
    for (const c of cases) {
      const image = await readFile(join(GOLDEN_DIR, c.image));
      const input: ReadInput = {
        image: image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength),
        mime: c.mime,
        template: c.template,
        procedures: c.procedures,
        locale: c.locale,
      };
      let answer: ReadResult = { rows: [] };
      let error: string | undefined;
      try {
        answer = await reader.read(input, AbortSignal.timeout(60_000));
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      const score = scorePage(c.expected, answer);
      scores.push({ name: c.name, template: c.template, ...score });
      console.log(
        `  ${reader.id.padEnd(24)} ${c.name.padEnd(14)} corrections ${String(score.corrections).padStart(3)}` +
          ` · missed ${score.missed} · extra ${score.extra} · id ${score.sheetIdCorrect ? 'ok' : 'wrong'}` +
          (error ? ` · error: ${error}` : ''),
      );
    }
    const all = summarise(scores);
    const fc = summarise(scores.filter((s) => s.template === 'F' || s.template === 'C'));
    const acc = all.fieldAccuracy;
    console.log(
      `${reader.id}: F+C average ${fc.averageCorrections.toFixed(2)} corrections/page (target < 3) · all ${all.averageCorrections.toFixed(2)}` +
        ` · day${pct(acc.day)} time${pct(acc.time)} name${pct(acc.name)} phone${pct(acc.phone)} code${pct(acc.code)} id${pct(all.sheetIdAccuracy)}`,
    );
    if (fc.pages > 0 && fc.averageCorrections >= 3) failed = true;
    report[reader.id] = { summary: all, fc, pages: scores };
  }
  if (values.out) await writeFile(values.out, JSON.stringify(report, null, 2));
  if (failed) process.exitCode = 1;
}

await main();
