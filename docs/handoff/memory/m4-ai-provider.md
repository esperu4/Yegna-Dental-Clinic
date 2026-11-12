---
name: m4-ai-provider
description: "User's M4 decision 2026-11-11 — no paid AI; free chain Workers AI → 2nd Workers AI model → Gemini free (last AI fallback) → manual entry"
metadata:
  node_type: memory
  type: project
  originSessionId: 50970d29-26f3-40d6-8a67-a8d5e85ab31c
  modified: 2026-11-11T19:16:06.024Z
---

Decided 2026-11-11 (AskUserQuestion): NO payment for photo reading. Fallback chain: Cloudflare Workers AI (free 10k neurons/day) → a second Workers AI vision model → Gemini free tier as LAST AI fallback (user accepted that Google may train on / humans may review those photos) → manual entry on the review screen. If free models miss the M4 target (<3 corrections/page), RELAX the target and record measured accuracy.

**Why:** user doesn't want any payment tied to reading; accepts Gemini free-tier data terms only as a last resort.

**How to apply:** record as an ADR (PRD §12 says "paid vision API", §22 #3 now resolved); ScheduleReader impls for workers-ai + gemini; privacy-reviewer must check the Gemini path (only send when earlier readers failed; key as Worker secret; log nothing). Golden set of ~10 real sheets still needed from the user. Related: [[m3-progress]] [[ask-interactively]]

Update 2026-11-11: user also chose to add Mistral OCR (clinic must switch training OFF in Mistral admin console), Groq (only if its free tier still has a vision model — verify), and OpenRouter (:free vision models; 50 req/day; no provider privacy control — told user). Gemini free stays the LAST AI fallback. Order among the private-ish readers is set by the golden-set eval. GitHub Models excluded (reportedly retired July 2026). Each needs an account under the clinic email + Worker secret.
