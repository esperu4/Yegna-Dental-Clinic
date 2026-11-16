# Runbook: set up the free-tier usage alert

PRD §19: since 1 Sep 2026, D1 queries **fail** once a free daily limit is exceeded. Every hour from 07:00 to 21:00, the API reads the account's usage for the current day from Cloudflare's analytics. It tells the Doctor on Telegram (team bot) at **50%** and again at **80%** of any limit, once per day each (the database size, which does not reset, once a month).

The limits it checks are in `apps/api/src/jobs/usage.ts` (`FREE_LIMITS`). Check them against Cloudflare's pricing pages when the plan changes:

- Workers requests: 100,000 a day;
- D1 rows read: 5,000,000 a day;
- D1 rows written: 100,000 a day;
- database size: 500 MB.

The daily limits reset at 00:00 UTC (03:00 in Addis Ababa).

It needs two values per environment, and does nothing without them:

| Value                | Where                 | Secret?                     |
| -------------------- | --------------------- | --------------------------- |
| `CF_ACCOUNT_ID`      | `wrangler secret put` | no, but kept with the token |
| `CF_ANALYTICS_TOKEN` | `wrangler secret put` | yes                         |

The message reaches the Doctor only if the team bot is set up and the Doctor linked Telegram (`docs/runbooks/team-bot.md`).

## 1. Create the token (clinic Cloudflare account)

1. Sign in to <https://dash.cloudflare.com/> with the **clinic** account.
2. Prefer an **account-owned** token: **Manage Account → Account API Tokens → Create Token → Custom token**. It keeps working if a person's login is removed. Otherwise use **My Profile → API Tokens** while signed in as the clinic account.
3. Name it `Yegna usage alert (<env>)`.
4. Permissions: **Account → Account Analytics → Read**. Nothing else.
5. Account resources: **Include → the clinic's account**.
6. Set an expiry of about a year (the yearly rotation in `key-rotation.md`).
7. Create the token and copy it, for step 2 only.

The account ID is on the right of the account's **Workers & Pages** overview, or in the dashboard URL (`dash.cloudflare.com/<account id>/…`).

## 2. Store both (from `apps/api`, in a real terminal)

```
npx wrangler secret put CF_ACCOUNT_ID --env staging
npx wrangler secret put CF_ANALYTICS_TOKEN --env staging
```

Run them in a terminal window where wrangler asks "Enter a secret value:". Where it cannot ask (Claude Code's `!` prompt, CI), it stores an **empty** secret (see `team-bot.md` §2).

## 3. Check

From 07:00, the job runs every hour. If usage is low, nothing is sent. To see that the token works without waiting for high usage, check the Worker's logs (Workers & Pages → yegna-api-staging → Logs):

- no `usage_check_failed` line means it worked;
- `usage_check_failed http_403` (or `http_401`) means the token is wrong, or lacks Account Analytics Read;
- `graphql_error` means the account ID is wrong.

## If an alert comes

- **Rows read** usually means a query without an index, or a phone stuck re-syncing. Run `npx wrangler d1 insights --sort-by=reads --time-period=1d` to see the top queries.
- **Rows written** usually means a burst of imports or a loop. Look at the same command with `--sort-by=writes`.
- **Requests** means many phones syncing every 30 s, or someone hammering the API.
- **Size**: export old data, or move to a paid plan.

## Rotating

Create a new token (step 1), store it (step 2), then delete the old one in **API Tokens**.
