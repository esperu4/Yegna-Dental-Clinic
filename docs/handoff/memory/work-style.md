---
name: work-style
description: 'User wants autonomous building with best-practice engineering quality, and Windows toast notifications when input is needed'
metadata:
  node_type: memory
  type: feedback
  originSessionId: 9d25f0a7-a5e6-4979-9816-cc8cb7da0f79
  modified: 2026-11-10T08:34:08.715Z
---

Keep building autonomously through the milestones; the user works on another project meanwhile. Priority is a perfectly maintained codebase following software-engineering best practices (tests first, small reviewed commits, reviewers per CLAUDE.md) — not speed.

**Why:** said 2026-11-10: "what i mainly want is a perfectly maintained and coded following best practices... notify me through the windows notifications because i am doing another project".

**How to apply:** only stop when genuinely blocked on the user (decisions, secrets, "push"). A user-level Notification + Stop hook (~/.claude/settings.json → ~/.claude/hooks/notify.ps1) shows a Windows toast whenever a turn ends, so batch questions into one stop. Don't push without the user's "push". Related: [[m1-progress]]
