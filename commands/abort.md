---
description: Discard this gw session's branch work across all repos (base branches are never touched)
---
Discard this `gw` session's work. Run this:

```bash
GW_ROOT="__GW_ROOT__" __GW_TSX__ "__GW_TS__" abort --in-claude $ARGUMENTS
```

This resets every repo's worktree back to a clean base and deletes the `gw/` branches. Nothing is merged or pushed; the base branches are untouched. Confirm to the user that the work was discarded.
