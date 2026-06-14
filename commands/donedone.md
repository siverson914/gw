---
description: Done-done check — verify every gw session has landed, fast-forward canonical checkouts to origin/<base>, and confirm it's safe to deploy
---
Check whether ALL `gw` work is done-done — every session landed, every canonical checkout synced — so a deploy would ship exactly what's on `origin/<base>`. Run this:

```bash
GW_ROOT="__GW_ROOT__" __GW_TSX__ "__GW_TS__" ready
```

**Run it directly — do NOT pipe through `grep`/`head`/`tail`.** The verdict is the last lines.

It checks and prints one verdict:

1. **Open sessions** — any session worktree anywhere (not just this one) that still holds uncommitted files or commits not on `origin/<base>` is unlanded work.
2. **Canonical checkouts** — fetches each, fast-forwards the local base branch to `origin/<base>` where safe (`--ff-only`, can never clobber), and flags anything left: stale, dirty, diverged, or on the wrong branch. Deploys run from these checkouts, so they must be exactly `origin/<base>`.
3. **Warn dirs** (if configured) — warning only (not gw-managed): uncommitted/unpushed state there usually means a forgotten manual sync.

**Exit 0 / `READY`** — report that everything is landed and synced; deploying is safe. Do NOT deploy to prod yourself — that stays user-initiated.

**Exit 1 / `NOT done-done`** — this is a report, not an error; do NOT just re-run it. Relay the printed list and help resolve each item:
- An **unlanded session** → finish it (`gw start <WS-id>` then `/done` inside it) or discard it (`gw abort <WS-id>`) — ask the user which, if it isn't this session.
- A **canonical checkout** that is dirty/diverged/on another branch → it holds work outside the gw flow; show the user `git -C <repo> status` and decide together (commit, stash, or drop) before deploying.
