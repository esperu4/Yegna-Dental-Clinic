// Secrets set with `wrangler secret put` (never in wrangler.jsonc or git).
interface Env {
  /** One-time code for creating the first doctor (docs/adr/0005-first-doctor-setup-code.md). */
  SETUP_CODE?: string;
}
