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
}
