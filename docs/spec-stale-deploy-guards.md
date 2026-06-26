# Spec: stop `gw done` from leaving a stale canonical checkout (+ related rough edges)

**Status:** proposed — ready for an implementer to pick up
**Repo:** `gw` (this repo). One companion change lives in the `platform` repo (called out in §5).
**Audience:** an AI/engineer who has not seen the original incident. Everything needed to implement is below.

---

## 0. TL;DR

`gw done` lands a session's work to `origin/<base>` via a disposable worktree, then tries to fast-forward each **canonical checkout** so the next person/deploy sees fresh code (`fastForwardCanonical` in `src/gw.ts`). In a real incident that fast-forward **silently did not happen**, the canonical `platform/` checkout stayed 5 commits behind `origin/main`, and the next deploy built and shipped **stale code** — for ~8 hours prod ran code everyone believed was patched.

Root cause: the "is the checkout dirty?" guard uses `git status --porcelain`, which reports a file as modified when only its **mtime** changed (content identical). A workspace sync-hook rewrites `server/src/public/client/v1/gipity.js` byte-for-byte and bumps its mtime, so the canonical checkout looks permanently dirty and the safe fast-forward is permanently skipped — silently.

This spec fixes that (P1), makes the skip loud when it legitimately can't advance (P2), and documents three smaller rough edges found along the way (P3–P5).

---

## 1. Background: what `gw done` does today

`gw done`:
1. For each repo the session changed, lands the branch into `origin/<base>` from an ephemeral worktree off `origin/<base>` (the canonical checkout is **never** the merge surface — its dirty state can't block a land).
2. After a successful land, calls `fastForwardCanonical(mainDir, base)` to advance the canonical checkout's local `<base>` to `origin/<base>`, "so `gw start` and humans browsing it see fresh code."

The relevant code (`src/gw.ts`, ~L381–392):

```js
// After a successful land, advance the shared canonical checkout's local <base> to
// origin/<base> so `gw start` and humans browsing it see fresh code. Best-effort:
// `--ff-only` can never clobber uncommitted work, and the whole thing is swallowed so
// it can never fail a land.
async function fastForwardCanonical(mainDir, base) {
  try {
    if (await gitOut(mainDir, ['status', '--porcelain'])) return;                  // (A) bails here
    if ((await gitOut(mainDir, ['symbolic-ref', '--short', 'HEAD'])) !== base) return;
    await git(mainDir, ['fetch', 'origin', base]);
    await git(mainDir, ['merge', '--ff-only', `origin/${base}`]);
  } catch { /* best-effort; never block a land */ }
}
```

The intent is right. The bug is in the dirtiness test at `(A)` and in the silence of the early `return`s.

---

## 2. P1 (primary bug): phantom stat-dirty defeats the canonical fast-forward

### Symptom
After `gw done`, the canonical checkout is left behind `origin/<base>`. A deploy that builds from that checkout ships old code, with every deploy gate passing green. The operator gets no signal.

### Reproduction (observed 2026-06-26, WS-00311)
```
$ git -C platform status --porcelain
 M server/src/public/client/v1/gipity.js
$ git -C platform diff server/src/public/client/v1/gipity.js
            # ← EMPTY. content is identical to HEAD.
$ git -C platform update-index -q --refresh
$ git -C platform status --porcelain
            # ← now EMPTY. the "M" was purely a stale stat-cache entry.
$ git -C platform merge --ff-only origin/main
            # ← succeeds cleanly.
```

### Root cause
`git status --porcelain` compares the working tree against the index using cached `stat()` data. A file whose **mtime/size** changed but whose **content** is identical shows as `M` until the index stat-cache is refreshed. In this workspace, file-sync hooks rewrite `gipity.js` identically on activity, bumping its mtime — so the canonical checkout is *perpetually* phantom-dirty, and `fastForwardCanonical` bails at `(A)` every single time.

So gw never advances the checkout, not because there is real work to protect, but because of a false positive.

### Fix (P1)
Refresh the stat cache, then test for **content-level** dirtiness instead of stat-level. Keep the safety property (never `--ff-only` over genuine uncommitted/untracked work).

```js
async function fastForwardCanonical(mainDir, base) {
  try {
    if ((await gitOut(mainDir, ['symbolic-ref', '--short', 'HEAD'])) !== base) return;

    // Drop stale stat-cache entries so a content-identical, mtime-touched file
    // (e.g. a sync-hook-rewritten artifact) is not reported as modified.
    await git(mainDir, ['update-index', '-q', '--refresh']).catch(() => {});

    // Content-level dirtiness only. diff-index --quiet exits non-zero iff a TRACKED
    // file actually differs from HEAD; ls-files --others surfaces real untracked files.
    const trackedDirty  = (await runExitCode(mainDir, ['diff-index', '--quiet', 'HEAD', '--'])) !== 0;
    const untracked     = !!(await gitOut(mainDir, ['ls-files', '--others', '--exclude-standard']));
    if (trackedDirty || untracked) { warnCanonicalBehind(mainDir, base, 'uncommitted changes'); return; } // P2

    await git(mainDir, ['fetch', 'origin', base]);
    await git(mainDir, ['merge', '--ff-only', `origin/${base}`]);
  } catch { /* best-effort; never block a land */ }
}
```

Notes for the implementer:
- `runExitCode` = a helper that runs git and returns the exit code without throwing (gw likely already has a variant of this; if not, add one — `git diff-index --quiet` *signals via exit code*, so a throw-on-nonzero wrapper would mis-handle it).
- Keep the untracked-files skip. `--ff-only` won't clobber untracked files, but silently advancing `<base>` under a checkout someone is mid-edit in is surprising; skip + warn (P2) is the safer contract.
- Do **not** drop the `symbolic-ref HEAD == base` check — advancing while a different branch is checked out is wrong.

---

## 3. P2: the skip is silent — make it loud

Every early `return` in `fastForwardCanonical` is invisible. When gw lands work but cannot advance the canonical checkout, the operator should be told, because **a deploy from that checkout will ship stale code.**

Add a warning emitted at the end of `done` (after the land summary) whenever a canonical checkout is left behind `origin/<base>`:

```
⚠️  platform: canonical checkout left at <short-sha> — behind origin/main by 5 commit(s).
    Reason: uncommitted changes in the working tree.
    A deploy from here will ship STALE code. Sync before deploying:
      git -C platform stash && git -C platform pull --rebase origin main && git -C platform stash pop
```

Implementation:
- `warnCanonicalBehind(mainDir, base, reason)` computes behind-count with `git rev-list --count HEAD..origin/<base>` (after a fetch) and emits via gw's existing `emit`/warn channel. Include repo name, current short sha, behind count, and the concrete fix command.
- Call it from every non-advancing branch of `fastForwardCanonical` (dirty, wrong-branch, ff failed), and also after a *successful* land where, post-attempt, the checkout still isn't at `origin/<base>` (belt-and-suspenders).
- Keep it non-fatal — it must never change the land's exit status.

---

## 4. Smaller rough edges (found while diagnosing — fix if cheap)

### P3 — subcommands run instead of showing help on `--help`
`gw start --help` **started a session** (created `WS-00321`) instead of printing usage. Unknown/ignored flags fall through to executing the command. This is dangerous for `start`/`done`/`abort`.
- Fix: detect `-h`/`--help` for every subcommand and print usage with **no side effects**.
- Stronger: reject unknown flags with a usage error rather than silently ignoring them (silent-ignore is exactly why `--help` became a no-op that still ran). Confirm this doesn't break the `--in-claude`/`--no-check`/`--pr` pass-through paths.

### P4 — `gw done --in-claude` can exit non-zero on success
Observed: a successful `done` printed `merged + pushed: platform`, then — because it deleted the session worktree that was the shell's cwd — the trailing shell step failed with `getcwd: cannot access parent directories` and the overall invocation surfaced **exit 1**. A non-zero exit is indistinguishable from a real failure without parsing stdout (the `done` command doc has to tell callers "if it says merged+pushed, it actually succeeded").
- Investigate whether the non-zero status comes from `gw` itself or the `gw.sh` wrapper / shell-cwd deletion (`finishCd` handles the `--in-claude` cwd case but the exit code still ended up 1).
- Goal: exit code reliably reflects the **land outcome** — 0 when everything merged+pushed, non-zero only when a repo did not land. The cwd-deletion side effect must not leak into the exit status. Consider emitting a final machine-readable result line (e.g. `RESULT: ok repos=platform`) callers can key on.

### P5 — root irritant: the perpetually stat-dirty artifact (not gw's code)
`server/src/public/client/v1/gipity.js` sitting permanently `M` (content unchanged) is what tripped P1, and it likely confuses other tooling. This is a **platform/workspace** concern, not gw, but worth recording so someone closes it at the source:
- Option A: make the file-sync hooks skip rewriting a file whose content is unchanged (don't bump mtime for a no-op write).
- Option B: stop tracking the generated artifact, or regenerate-on-build instead of committing it.

P1 makes gw robust to this regardless, but fixing P5 removes the underlying surprise.

---

## 5. Companion change in the `platform` repo (not gw, but part of the same defense)

gw can only do so much; the **deploy** is where stale code becomes a prod incident, and it should refuse to build from a checkout behind origin. Add a gate to `platform/scripts/deploy_server.py` alongside the existing migration/drift/lockfile gates (runs even in `--fast`):

```python
# Build-source freshness gate. Building from a checkout behind origin/<base> ships
# code nobody reviewed/landed — the WS-00311 stale-deploy bug. ~1s; runs in --fast too.
base = "main"
run(f'cd "{GIT_ROOT}" && git fetch -q origin {base}')
behind = subprocess.check_output(
    f'cd "{GIT_ROOT}" && git rev-list --count HEAD..origin/{base}', shell=True, text=True).strip()
if behind != "0":
    raise SystemExit(f"FATAL: checkout is {behind} commit(s) behind origin/{base}; "
                     f"run `git pull --rebase origin {base}` before deploying.")
```

Provide an `--allow-behind` (or env) escape hatch for the rare intentional case (deploying a hotfix branch not yet on `main`). Default: refuse. This guard is independent of gw and catches staleness from *any* cause.

> A platform-side write-up of this same companion gate may also exist at
> `platform/docs/feature-backlog/deploy-stale-checkout-guards.md`. Keep them in sync or
> consolidate; this gw spec is the authoritative home for the gw-side P1–P4 work.

---

## 6. Why NOT "just always pull/rebase the canonical checkout"

The naive fix — force the canonical checkout to `origin/<base>` unconditionally on every land — can **destroy uncommitted or unpushed work**, and this workspace runs many concurrent gw sessions against the same canonical checkouts. `--ff-only` is the correct primitive (it can never clobber); the bug was only that the *dirtiness test gating it* was too coarse. P1 preserves the safety and removes the false positive. P2 + §5 handle the genuinely-dirty / can't-ff case without ever overwriting work.

---

## 7. Acceptance criteria

1. After a `gw done` where the canonical checkout is a clean fast-forward — including the case where a tracked file is **stat-dirty but content-identical** — the checkout's local `<base>` is advanced to `origin/<base>` automatically.
2. When the canonical checkout has **real** uncommitted/untracked changes (or HEAD is off `<base>`, or the ff fails), gw does **not** touch it and emits a loud, actionable warning naming the repo, sha, behind-count, and fix command.
3. `gw <subcommand> --help` prints usage and performs **no** side effects; unknown flags produce a usage error.
4. `gw done --in-claude` exits `0` on a fully successful land regardless of cwd-deletion; non-zero only when a repo failed to land.
5. (Companion) `deploy_server.py` aborts when the build checkout is behind `origin/<base>`, with an `--allow-behind` override.

## 8. Test plan

- **P1 unit/integration over `fastForwardCanonical`:**
  - clean checkout behind origin → fast-forwards (HEAD advances to `origin/<base>`).
  - tracked file mtime-touched but content-identical (simulate: `touch` a tracked file, or rewrite identical bytes) → still fast-forwards. **This is the regression guard.**
  - tracked file with a real content edit → skipped, HEAD unmoved, warning emitted.
  - untracked file present → skipped, HEAD unmoved, warning emitted.
  - HEAD on a non-base branch → skipped (no warning needed, or a distinct message).
- **P2:** warning text includes repo, short sha, correct behind-count; not emitted on a successful advance.
- **P3:** `start/done/abort --help` exit 0, create/modify nothing; unknown flag → non-zero usage error.
- **P4:** `done --in-claude` success path returns exit 0 in a harness where the cwd worktree is removed.
- **P5/§5:** covered in the platform repo's tests.

## 9. File map (gw repo)

- `src/gw.ts` — `fastForwardCanonical` (P1), new `warnCanonicalBehind` + call sites (P2), subcommand arg/`--help` parsing (P3), `done`/`finishCd` exit-status handling (P4).
- `gw.sh` — wrapper exit-code propagation, relevant to P4.
- `commands/done.md` / `README.md` — update docs once P2/P4 change the observable behavior (note: both are currently modified in the working tree by unrelated in-progress edits; coordinate before committing).
