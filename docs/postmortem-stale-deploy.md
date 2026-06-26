# Postmortem: `gw done` left a stale canonical checkout → an 8-hour stale deploy

**Date:** 2026-06-26 · **Session:** WS-00311 · **Status:** gw-side fixes landed (see "Resolution").

## What happened

`gw done` lands a session's work to `origin/<base>` from a disposable worktree, then
fast-forwards each **canonical checkout** so the next person/deploy sees fresh code
(`fastForwardCanonical` in `src/gw.ts`). In this incident the fast-forward **silently
did not happen**: the canonical `platform/` checkout stayed 5 commits behind
`origin/main`, and the next deploy built and shipped **stale code**. For ~8 hours prod
ran code everyone believed was patched — every deploy gate green the whole time.

## Root cause

The "is the checkout dirty?" guard used `git status --porcelain`, which reports a file
as modified when only its **mtime** changed (content identical). A workspace sync-hook
rewrites `server/src/public/client/v1/gipity.js` byte-for-byte and bumps its mtime, so
the canonical checkout looked *perpetually* dirty and the safe fast-forward was skipped
every time — a false positive, not real work being protected.

```
$ git -C platform status --porcelain
 M server/src/public/client/v1/gipity.js
$ git -C platform diff server/src/public/client/v1/gipity.js    # ← EMPTY: identical to HEAD
$ git -C platform update-index -q --refresh
$ git -C platform status --porcelain                            # ← now EMPTY: it was a stale stat-cache entry
$ git -C platform merge --ff-only origin/main                   # ← succeeds cleanly
```

## Resolution (gw side — landed)

All four gw-side issues found while diagnosing are fixed:

- **P1 — phantom stat-dirty defeated the fast-forward.** `fastForwardCanonical` now runs
  `git update-index -q --refresh` and tests **content-level** dirtiness
  (`git diff-index --quiet HEAD` exit code + `git ls-files --others --exclude-standard`)
  instead of `git status --porcelain`. A content-identical, mtime-touched file no longer
  blocks the advance; genuine uncommitted/untracked work still does. (`src/gw.ts`)
- **P2 — the skip was silent.** When gw lands but can't advance a canonical checkout, it
  now logs a loud warning naming the repo, the behind-count, the reason, and the
  `git pull --rebase` fix — because a deploy from there ships stale code. (`src/gw.ts`)
- **P3 — `gw start --help` started a session.** Unknown flags fell through to execution.
  `-h`/`--help` now print usage with no side effects, and unknown flags are a hard
  usage error. (`src/gw.ts`)
- **P4 — `gw done --in-claude` looked like it exited non-zero on success.** gw itself
  exits 0 on a successful land; the confusion came from the shell being stranded in the
  just-deleted worktree (its cwd), making the *next* command fail. The `/done` and
  `/abort` slash commands now cd back to the workspace root in the same invocation while
  preserving gw's real exit code. (`commands/done.md`, `commands/abort.md`)

## Still open (outside this repo — defense in depth)

- **P5 — the perpetually stat-dirty artifact.** `gipity.js` sitting permanently `M`
  (content unchanged) is what tripped P1 and likely confuses other tooling. Fix at the
  source: make the sync hooks skip a no-op rewrite, or stop tracking the generated
  artifact / regenerate on build. (platform/workspace concern, not gw.)
- **Deploy-freshness gate.** The deploy is where stale code becomes a prod incident, so
  it should refuse to build from a checkout behind `origin/<base>` (a ~1s
  `git rev-list --count HEAD..origin/<base>` check in `deploy_server.py`, with an
  `--allow-behind` escape hatch). Independent of gw; catches staleness from any cause.

## Why not "just always pull/rebase the canonical checkout"

Forcing the checkout to `origin/<base>` unconditionally can **destroy uncommitted or
unpushed work**, and this workspace runs many concurrent gw sessions against the same
canonical checkouts. `--ff-only` is the correct primitive (it can never clobber); the bug
was only that the dirtiness test gating it was too coarse. P1 keeps the safety and removes
the false positive.
