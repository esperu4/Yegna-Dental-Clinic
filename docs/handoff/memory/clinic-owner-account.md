---
name: clinic-owner-account
description: "Clinic services are owned by a dedicated clinic Gmail (created 2026-11-09); repo stays on dev's personal GitHub until the build is finished"
metadata:
  node_type: memory
  type: project
  originSessionId: ff7d4fd6-4fc1-4e91-83a2-106bad749975
  modified: 2026-11-09T16:03:19.725Z
---

The clinic Gmail was created on 2026-11-09 as the owner account for every service (PRD §18: Cloudflare, Google Drive backups, BotFather bots, AI provider, domain). Developers get invited access. The GitHub repo is esperu4/Yegna-Dental-Clinic (public, on the developer's personal account).

**Why:** the clinic must keep control of its accounts if the developer leaves. Drive backups need a clinic-owned Google account (PRD §22 item 9).
**How to apply:** create every external service under the clinic Gmail and invite the developer. Don't use the developer's own accounts. The user decided the repo moves to a clinic organisation only after the build is finished, so don't bring up the repo transfer again before then. Domain DNS question: [[domain-dns-open-item]].
