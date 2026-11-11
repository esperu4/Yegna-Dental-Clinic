# ADR 0009: Free schedule readers with fallbacks (no paid AI)

Status: accepted (project owner, 2026-11-11)

## Context

PRD §12 and §22 #3 planned a paid vision API (Claude or Gemini, a few USD a month) to read photos of the paper templates. The project owner does not want any payment tied to reading imports. The free tiers available in November 2026 differ in quality, limits and, above all, in what they do with the photos, which carry patient names and phone numbers (PRD §18).

| Reader                               | Free allowance (approx.)                                   | Photos used for training?                                                                                |
| ------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers AI (binding `AI`) | 10,000 neurons/day, shared by all models                   | No; runs on the clinic's own Cloudflare account                                                          |
| Mistral (OCR and vision chat)        | ~1 request/s                                               | Yes by default on the free plan; the clinic **must turn it off** in the Admin Console (privacy settings) |
| Groq (vision chat)                   | ~30 requests/min, ~1,000/day                               | Groq states it does not train on API data (check at setup)                                               |
| OpenRouter (`:free` vision models)   | 50 requests/day (1,000 once $10 of credit was ever bought) | Depends on the upstream provider; no control on free models                                              |
| Gemini free tier                     | generous                                                   | **Yes**: Google may use free-tier prompts to improve its products, and human reviewers may read them     |

## Decision

1. Only free readers. Every reader implements `ScheduleReader` (`packages/ai`); the API tries them **in order** and moves to the next one when a reader is not configured, fails, times out, hits its limit or returns nothing usable.
2. Order: the readers that keep data private come first (Workers AI, then Mistral, Groq, OpenRouter; their exact order is set from the golden-set evaluation). **Gemini free is always last**: a photo reaches Google only when every other reader failed on it. The project owner accepted Gemini's free-tier terms for that case.
3. When every reader fails, the import is `failed` and the rows are typed by hand on the review screen (manual entry is always possible).
4. The import records which reader produced the rows (`imports.provider`).
5. If the free readers miss the M4 accuracy target (< 3 corrections per page on templates F and C), the target is relaxed and the measured accuracy recorded in `docs/milestones/M4.md`, instead of switching to a paid provider.
6. Keys are Worker secrets. Logs carry the reader id and an error kind only, never photo content or extracted text.

## Consequences

- PRD §1 "the only variable cost is the paid vision API" no longer applies: imports cost nothing.
- Accuracy is likely lower than a paid model on handwriting, especially Ge'ez script; the review screen is where staff fix it.
- Five accounts (Cloudflare already exists) under the clinic email; free limits change often, so the chain must tolerate any reader disappearing.
- PRD §22 #3 is resolved by this ADR.
