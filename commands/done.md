---
description: Finish this gw session — gate, then squash-merge each changed repo to its base branch and push
---
Finish this `gw` session. Land every repo you changed **with a real, descriptive commit message you compose from the actual diff** — don't let gw fall back to the auto-generated message (which is what happens when no message is passed). This is the only documentation the squashed change gets, so it matters.

**Step 1 — see exactly what will land (read-only).** Run:

```bash
GW_ROOT="__GW_ROOT__" __GW_TSX__ "__GW_TS__" done --show --in-claude $ARGUMENTS
```

This prints, per changed repo, the net diff (committed work plus uncommitted edits) vs that repo's base branch. It stages, gates, and merges **nothing**. If it reports `no changes to land`, stop — there's nothing to finish.

**Step 2 — compose the commit message** from that diff and what you did this session, in Conventional-Commits form. The subject must read well in `git log --oneline`; the body carries the detail someone gets on open:
- **Subject** ≤ 72 chars, imperative mood: `type(scope): summary` (e.g. `fix(gw): survive a deleted cwd`, `feat(cli): add --json output`). One scope; pick the dominant one.
- A blank line, then a **body** of 2–5 bullets on *what changed and why* — capture intent, don't restate the diff line by line. Omit the body only for a genuinely trivial one-liner.
- If the session changed **more than one repo**, end the body with a `Repos: <a>, <b>` line so the squash on each repo records the full cross-repo scope.

**Step 3 — land it, passing your message** via a heredoc (the quoted `'EOF'` keeps backticks/`$` in the body literal):

```bash
GW_ROOT="__GW_ROOT__" __GW_TSX__ "__GW_TS__" done --in-claude -m "$(cat <<'EOF'
<subject line>

- <body bullet>
- <body bullet>
EOF
)" $ARGUMENTS; rc=$?; pwd -P >/dev/null 2>&1 || cd "__GW_ROOT__"; (exit $rc)
```

The trailing `pwd -P … || cd …; (exit $rc)` matters: a successful land **deletes this worktree**, which is your shell's current directory. Without it your next command fails with `getcwd: cannot access parent directories` — which reads like the land failed even though it succeeded. It **must** be `pwd -P` (a real `getcwd` syscall), not plain `pwd`: the `pwd` builtin just echoes the stale `$PWD` and returns 0 even after the directory is gone, so `|| cd` would never fire and the shell would stay stranded (that stray non-zero exit is exactly this bug). `pwd -P` lands you back at the workspace root while preserving gw's real exit code. Judge success by the printed `merged + pushed: …` line, not just the exit code.

`$ARGUMENTS` comes **last on purpose**: a `-m` the user typed in their own `/done` invocation then overrides yours, and other flags (`--pr`, `--no-check`) still pass through.

For **every repo you actually changed**, Step 3 commits pending work, **merges `origin/<base>` into the worktree** (so the gate validates the integrated result, not a stale branch — this is on by default; `--no-sync` skips it), runs that repo's fast pre-merge gate, squash-merges the branch into the base branch (with your message), and pushes. Untouched repos are skipped, and all gates run before any merge — so one red gate lands nothing.

**Run Step 3 directly — do NOT pipe through `grep`/`head`/`tail`.** Those can hide the final `merged + pushed: …` / `did NOT land: …` line, which is the only thing that tells you what happened.

If it stops with a **non-zero exit**, the session is kept ON PURPOSE for recovery — nothing is lost. The command is idempotent: **run the exact same Step 3 command again** (reuse your message). Repos that already landed produce an empty squash (a no-op success); only un-landed repos are retried. A non-zero exit is most often a transient **push race** (origin advanced mid-push — common when other sessions land concurrently), which a re-run clears. Do NOT hand-recover, cherry-pick, or go spelunking local refs — re-running is the fix. The error names the repo (e.g. `[cli] …`):
- **Pre-gate merge conflict** (`origin/<base>` advanced and conflicts with the branch) — gw stops before gating. `cd` into the named worktree, run `git merge origin/<base>`, resolve the conflicts, commit, then run Step 3 again. This is the staleness that used to slip through as a green gate on un-integrated code.
- **Gate failed** — read the failing output, fix the code in that repo's worktree, then run Step 3 again.
- **Squash conflict** (base advanced) — run the rebase commands it prints (`git fetch` + `git rebase origin/<base>`) in the named worktree, resolve the conflicts, then run Step 3 again.
- **Session gate failed** (a configured cross-repo `--check`) — run the regenerate step it names, commit the regenerated files, then run Step 3 again.

**Verifying success — check `origin/<base>`, NOT the local checkout:**
```bash
git -C <repo> log -1 --oneline origin/<base>
```
`gw` deliberately does **not** fast-forward a local checkout that holds your own uncommitted or unpushed work (it uses `--ff-only`, which can never clobber). So after a successful land, a local base branch that still shows the old content is **expected and correct** — the merge is on `origin/<base>`. If gw prints a `WARNING: canonical checkout … left N commit(s) behind origin/<base>`, that checkout will deploy stale code until reconciled — `git -C <repo> pull --rebase`. Don't read either as "the work was lost". (Landing happens in a disposable worktree off `origin/<base>`, so a dirty checkout never stops it.)

Pass flags through, e.g. `/done --pr` (open a PR per changed repo instead of merging — your message becomes the PR title + body) or `/done --no-check` (skip the gates). When it prints "merged + pushed: …" (or PR URLs), report success — listing which repos landed.
