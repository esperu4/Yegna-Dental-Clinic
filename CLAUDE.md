# Yegna Dental Clinic

`PRD.md` is the single source of truth for v1. Read the relevant section before building a feature. Do not copy it here.

## What we're building
One pnpm monorepo, three deliverables: an offline-first scheduling **PWA**, two Telegram **bots** (*Yegna Team* internal, *Yegna Dental* patients), and a static public **website**. Stack is fixed (PRD §4): TypeScript strict · Preact + Vite + Dexie · Cloudflare Workers + Hono · D1 + Drizzle · grammY (webhooks only) · Astro · Vitest + Playwright.

```
apps/pwa  apps/api  apps/web
packages/shared  packages/time  packages/db  packages/ai
scripts/  docs/ (ADRs, runbooks)
```

## How to work
- Build in milestone order (PRD §20). A milestone is done only when every criterion passes and is shown working. Use `/milestone-check M<n>`.
- Ambiguous? Check PRD §21 (decisions) and §22 (open items), then **ask** before inventing behaviour.
- Use glossary terms (PRD §2) in code, UI copy and commits.
- Project rules that apply everywhere are in the `yegna-conventions` skill.
- Changes to sync (PRD §7) go through the `sync-reviewer` agent. Changes to auth, bots, CORS, logging or patient data go through the `privacy-reviewer` agent.

## Guard rails (enforced by hooks in `.claude/settings.json`)
- `.dev.vars*`, `.env*` and `pnpm-lock.yaml` cannot be edited. Use `wrangler secret` and `pnpm install`.
- Existing files in `packages/db/migrations/` cannot be edited. Generate a new migration instead.
- Editing `packages/time/**` runs that package's tests automatically.

## Commands
<!-- Fill in once M0 scaffolding exists: install, dev, test, typecheck, lint, deploy staging. -->
