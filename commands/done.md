---
description: Finish this gw session — gate, then squash-merge each changed repo to its base branch and push
---
Finish this `gw` session. Run this:

```bash
GW_ROOT="__GW_ROOT__" __GW_TSX__ "__GW_TS__" done --in-claude $ARGUMENTS
```

For **every repo you actually changed**, it commits pending work, runs that repo's fast pre-merge gate, squash-merges the branch into the base branch, and pushes. Untouched repos are skipped, and all gates run before any merge — so one red gate lands nothing.

**Run it directly — do NOT pipe through `grep`/`head`/`tail`.** Those can hide the final `merged + pushed: …` / `did NOT land: …` line, which is the only thing that tells you what happened.

If it stops with a **non-zero exit**, the session is kept ON PURPOSE for recovery — nothing is lost. The command is idempotent: **run the exact same command again.** Repos that already landed produce an empty squash (a no-op success); only un-landed repos are retried. A non-zero exit is most often a transient **push race** (origin advanced mid-push — common when other sessions land concurrently), which a re-run clears. Do NOT hand-recover, cherry-pick, or go spelunking local refs — re-running is the fix. The error names the repo (e.g. `[cli] …`):
- **Gate failed** — read the failing output, fix the code in that repo's worktree, then run the command again.
- **Squash conflict** (base advanced) — run the rebase commands it prints (`git fetch` + `git rebase origin/<base>`) in the named worktree, resolve the conflicts, then run the command again.
- **Session gate failed** (a configured cross-repo `--check`) — run the regenerate step it names, commit the regenerated files, then run the command again.

**Verifying success — check `origin/<base>`, NOT the local checkout:**
```bash
git -C <repo> log -1 --oneline origin/<base>
```
`gw` deliberately does **not** fast-forward a local checkout that holds your own uncommitted or unpushed work (it uses `--ff-only`, which can never clobber). So after a successful land, a local base branch that still shows the old content is **expected and correct** — the merge is on `origin/<base>`. Don't read this as "the work was lost"; reconcile the local copy later with `git -C <repo> pull --rebase`. (Landing happens in a disposable worktree off `origin/<base>`, so a dirty checkout never stops it.)

Pass flags through, e.g. `/done --pr` (open a PR per changed repo instead of merging) or `/done --no-check` (skip the gates). When it prints "merged + pushed: …" (or PR URLs), report success — listing which repos landed.
