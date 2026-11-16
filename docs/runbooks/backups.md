# Runbook: set up the nightly backup (Google Drive) and the backup key

ADR 0012. Do this once per environment (staging first), in a real terminal, from `apps/api`. Never paste keys or tokens into chat, issues or commits.

## 1. The backup key

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

1. Write the value on paper and give it to the Doctor, who keeps it somewhere safe (without it no backup can be read).
2. Store it in the Worker: `npx wrangler secret put BACKUP_KEY --env staging`, and paste the value.
3. Use a different key for production.

## 2. A Google OAuth client (one per environment, in the clinic's Google account)

Use **separate projects** for staging and production ("Yegna Backup staging", "Yegna Backup"). With scope `drive.file`, each then sees only its own files. Files are also tagged with their environment.

1. Go to <https://console.cloud.google.com/>, signed in as the clinic account. Create the project.
2. **APIs & Services → Library**: enable the **Google Drive API**.
3. **OAuth consent screen**:
   - set the type to External, with the app name "Yegna Backup";
   - add the scope `.../auth/drive.file`;
   - add the clinic account as a test user;
   - then **Publish app**. While it is in "Testing", refresh tokens stop working after 7 days.
4. **Credentials → Create credentials → OAuth client ID**, type **Desktop app**. Copy the client ID and the secret.
5. Store both: `npx wrangler secret put GOOGLE_CLIENT_ID --env staging`, then `npx wrangler secret put GOOGLE_CLIENT_SECRET --env staging`.

## 3. The refresh token (signs the Worker in to Drive)

```
pnpm google-auth --env staging
```

It asks for the client ID and secret (hidden input, so they stay out of shell history).

1. Open the address it prints, sign in as the **clinic** account, and allow access.
2. The token is stored as `GOOGLE_REFRESH_TOKEN` directly; it is never shown on screen.

## 4. Check

- The next run from 02:00 (Addis Ababa) uploads `yegna-backup-staging-<date>.ydb` to the clinic's Drive (My Drive, top level).
- If it fails, the Doctor gets "Tonight's backup to Google Drive failed" on Telegram. It is retried every hour that day.
- To test without waiting, see the restore runbook. `pnpm backup` makes the same file by hand: write it **outside** the repo and OneDrive.

## Rotating

- **New key:** keep the old paper key until the last backup made with it has expired (30 days), and keep it forever for the 1st-of-month backups (or re-encrypt them).
- **New Google token:** run step 3 again.
