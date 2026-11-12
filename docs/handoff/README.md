# Handoff: moving the dev machine (2026-11-12)

The developer moved from Windows to Omarchy (Arch Linux). This folder carries Claude Code's project memory so a new session can pick up where the old one stopped.

## Restore on the new machine
1. `git clone https://github.com/esperu4/Yegna-Dental-Clinic.git` and `git fetch --all`.
2. In-progress work is on branch `wip/m4-pwa-imports` (`git switch wip/m4-pwa-imports`). `main` holds finished work only (pushes to `main` deploy staging).
3. Start `claude` once in the repo folder, then copy the memory in:
   ```sh
   dir=~/.claude/projects/$(pwd | sed 's#[/.]#-#g')/memory
   mkdir -p "$dir" && cp docs/handoff/memory/*.md "$dir"/
   ```
   (Check the folder name `claude` created under `~/.claude/projects/` and use that one if it differs.)
4. `pnpm install`, then recreate local secrets in `apps/api/.dev.vars` (never committed). Wrangler: `pnpm exec wrangler login` with the clinic account.
5. Windows-only bits that do not carry over: the toast-notification hook (`~/.claude/hooks/notify.ps1`) — use `notify-send` instead if you want it.

Delete this folder once the new machine is set up.
