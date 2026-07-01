---
description: Finish this gw worktree FAST — skip the gate (tests + doc-drift check), squash-merge to main and push
---
Finish the current `gw` worktree **without running the pre-merge gate** — for small edits you know don't need testing. This skips both the per-repo test gate (`just test-fast`) and the generated-doc drift check.

```bash
GW_ROOT="__GW_ROOT__" __GW_TSX__ "__GW_TS__" done --in-claude --no-check $ARGUMENTS; rc=$?; pwd -P >/dev/null 2>&1 || cd "__GW_ROOT__"; (exit $rc)
```

It commits any pending work, squash-merges the branch into the base branch, and pushes — no gate.

The trailing `pwd -P … || cd …; (exit $rc)` matters: a successful land **deletes this worktree**, which is your shell's current directory. It must be `pwd -P` (a real `getcwd` syscall), not plain `pwd`: the `pwd` builtin just echoes the stale `$PWD` and returns 0 even after the dir is gone, so the `|| cd` recovery would never fire and the shell would stay stranded (that stray non-zero exit reads like the land failed even though it succeeded). Judge success by the printed `merged … and pushed` line, not just the exit code.

After it runs, remind the user in one line: **the gate was skipped, so tests did NOT run and any generated docs (`build-knowledge`/`build-docs`) were NOT drift-checked** — if this edit touched a skill/knowledge doc or anything that feeds those generators, a stale file may have landed and will only surface at `deploy-all`. For a genuine small edit (string, CSS, comment), that's fine.

If it stops with an error:
- **Squash conflict** (base advanced) — run the rebase commands it prints (`git fetch` + `git rebase origin/<base>`), resolve the conflicts in this worktree, then run the command again.
- **Dirty/divergent base checkout** — tell the user what it reported; don't try to force it.

Pass flags through, e.g. `/df --pr` (open a PR instead of merging to main). When it prints "merged ... and pushed" (or a PR URL), report success — and include the skipped-gate reminder above.
