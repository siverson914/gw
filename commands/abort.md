---
description: Discard this gw session's branch work across all repos (base branches are never touched)
---
Discard this `gw` session's work. Run this:

```bash
GW_ROOT="__GW_ROOT__" __GW_TSX__ "__GW_TS__" abort --in-claude $ARGUMENTS; rc=$?; pwd -P >/dev/null 2>&1 || cd "__GW_ROOT__"; (exit $rc)
```

This resets every repo's worktree back to a clean base and deletes the `gw/` branches. Nothing is merged or pushed; the base branches are untouched. Confirm to the user that the work was discarded.

(The trailing `pwd -P … || cd …` returns your shell to the workspace root because abort **deletes this worktree** — your current directory — and the next command would otherwise fail with `getcwd: cannot access parent directories`. It must be `pwd -P` (a real `getcwd` syscall): plain `pwd` just echoes the stale `$PWD` and returns 0 even when the dir is gone, so the `|| cd` recovery would never fire. `(exit $rc)` preserves abort's real exit code.)
