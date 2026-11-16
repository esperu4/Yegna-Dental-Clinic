# ADR 0013: Production environment and hand-triggered deploys

Status: accepted (2026-11-16)

## Context

Staging deploys on every push to `main` (ADR 0001). Production holds the clinic's real patients, so it must change only when someone decides to. The domain (PRD §22 #7) is still undecided.

## Decision

1. **Production runs on the free `workers.dev` subdomain** until the domain is ready, like staging:
   - API `https://yegna-api.yegna-api.workers.dev`
   - App `https://yegna-pwa.yegna-api.workers.dev`
   - Website `https://yegna-web.yegna-api.workers.dev`

   Each app's `wrangler.jsonc` has an `env.production`. The API's has its own D1 database, `yegna-production`, and its own cron. The PWA's production build points at the production API (`vite.config.ts`).

2. **Deploys are by hand.** The GitHub workflow "Deploy production" runs only from `main`, only when the person types `deploy`, and only in the GitHub `production` environment (whose secrets it uses; add a required reviewer there). Before migrating and deploying, it reruns lint, typecheck and tests.
3. **Every secret is per environment.** Production has its own setup code, bots, backup key, Google project and analytics token (`docs/runbooks/production.md`). Nothing is shared with staging.
4. **The website stays `noindex` on `workers.dev`.** It becomes indexable (`PUBLIC_INDEXABLE=1`) only on the real domain, so search engines never learn a temporary address.
5. **Production is never seeded** (CLAUDE.md). The Doctor sets the clinic up with the one-time setup code (ADR 0005).

## Consequences

- Moving to the real domain later means adding Custom Domains to the three Workers, changing `PWA_ORIGIN`, the PWA's API URL and the website's `--site`, and turning on indexing.
- A deploy is a deliberate act with a written runbook; rollback is the previous commit deployed the same way, and D1 Time Travel for data.
