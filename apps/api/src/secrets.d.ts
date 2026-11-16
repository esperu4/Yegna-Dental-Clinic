// Secrets set with `wrangler secret put` (never in wrangler.jsonc or git).
interface Env {
  /** One-time code for creating the first doctor (docs/adr/0005-first-doctor-setup-code.md). */
  SETUP_CODE?: string;
  /** Yegna Team bot token from @BotFather (PRD §13). Without it, team messages are not sent. */
  TEAM_BOT_TOKEN?: string;
  /** Checked against `X-Telegram-Bot-Api-Secret-Token` on the team bot's webhook (PRD §18). */
  TEAM_BOT_WEBHOOK_SECRET?: string;
  /** The team bot's @username without the @ (a var, set per environment once the bot exists). */
  TEAM_BOT_USERNAME?: string;
  /** Yegna Dental (patient) bot token from @BotFather (PRD §14). Without it, patients get nothing. */
  PATIENT_BOT_TOKEN?: string;
  /** Checked against `X-Telegram-Bot-Api-Secret-Token` on the patient bot's webhook (PRD §18). */
  PATIENT_BOT_WEBHOOK_SECRET?: string;
  /** The patient bot's @username without the @ (a var; shown on the website and in the PWA). */
  PATIENT_BOT_USERNAME?: string;
  /** Nightly backup (PRD §17, ADR 0012): AES-256 key, base64 of 32 bytes; the Doctor keeps a printed copy. */
  BACKUP_KEY?: string;
  /** OAuth client and refresh token of the clinic's Google account (scope drive.file). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  /** Free-tier usage alert (PRD §19): the Cloudflare account id and an Account Analytics Read token. */
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
  /** Free schedule readers (ADR 0009); each is used only when its key is set. */
  MISTRAL_API_KEY?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  /** Gemini free tier: always the last reader (its terms let Google use the photos). */
  GEMINI_API_KEY?: string;
  /** Workers AI binding (staging and production only; local dev has none). */
  AI?: Ai;
  /** Optional model overrides (vars); defaults in src/imports/readers.ts. */
  WORKERS_AI_MODEL?: string;
  GROQ_MODEL?: string;
  OPENROUTER_MODEL?: string;
  GEMINI_MODEL?: string;
  /** `1` in local dev / e2e: a stub reader returns a fixed row. Ignored outside `local`. */
  IMPORT_STUB_READER?: string;
}
