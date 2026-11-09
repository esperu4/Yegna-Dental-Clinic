# ADR 0001: Staging runs on free workers.dev URLs; Pages means Workers static assets

Date: 2026-11-09 · Status: accepted

## Context

PRD §22 #7 (whether `yegnadental.com.et` can use Cloudflare nameservers) is unresolved, and the
domain is not registered yet. M0 still needs staging deploys of `pwa`, `api` and `web`.
Cloudflare has also folded Pages into Workers: `wrangler pages` now delegates to Workers with
static assets (and, for Astro, tried to rewrite the project with an SSR adapter).

## Decision

- Staging uses the account's free subdomain:
  - API: `https://yegna-api-staging.yegna-api.workers.dev`
  - PWA: `https://yegna-pwa-staging.yegna-api.workers.dev`
  - Website: `https://yegna-web-staging.yegna-api.workers.dev`
- The PWA and the website deploy as **Workers with static assets** (`wrangler deploy`), each with its
  own `wrangler.jsonc`. The website stays fully static (no adapter, no server code). This is the
  current form of the "Cloudflare Pages" named in PRD §4; static-asset requests are free.
- The real domain is attached later via Custom Domains on the same Workers; no code changes needed
  beyond CORS origins and `SITE_URL`.

## Consequences

- The website is `noindex` until it moves to the real domain, so staging is never indexed.
- The account subdomain is `yegna-api` (set on first deploy). It can be renamed in the dashboard
  (Workers & Pages → Subdomain); URLs above change with it.
