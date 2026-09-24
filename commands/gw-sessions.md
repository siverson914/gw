---
description: Start, inspect, land, or discard gw sessions from THIS agent session without entering them — for running several isolated multi-repo worktrees in parallel from one conversation. Inside Herdr it can also hand a session to its own agent in a new Herdr tab
---
Manage `gw` sessions **from the outside**: create isolated multi-repo worktree sessions, do (or delegate) work in them by absolute path, then land or discard each one — all without leaving this conversation or moving your shell into a worktree. What the user asked for: $ARGUMENTS

Call the gw engine **directly by path** (never the `gw` shell function — it exists to `cd` an interactive terminal and launch an agent, which is the opposite of what you want here). Run every command from the workspace root (the directory holding `gw.config.json`) or anywhere inside it; from elsewhere, wrap it in a subshell: `(cd <root> && …)`. Don't pipe these through `head`/`tail`/`grep` — the last lines carry the verdict.

## 1. Start a session

```bash
env -u GW_ROOT __GW_TSX__ "__GW_TS__" start --prompt "<one-line task description>" --name <short-kebab-slug> --json
```

- `--prompt` replaces the interactive prompt box; `--name` sets the label directly (skips the model-based namer, so it's instant). Pick a slug that says what the session is for.
- `--json` means: create the worktrees, **don't** cd, **don't** launch an agent, and print one JSON record on stdout:
  `{"id", "dir", "branch", "root", "repos": [{"key", "dir", "base"}], "agent", "model", "effort", "launcher"}`.
- Every repo is on a fresh `gw/<id>` branch off `origin/<base>`. A scripted start is always a **new** session, even if your shell is inside another worktree.
- Add `--agent`/`--model`/`--effort` only if the user wants the session labelled for a specific agent (it's recorded for a later human `gw start <id>` resume).
- **Inside Herdr** (`HERDR_ENV=1`), add `--herdr` to also launch an agent for the session in a new, unfocused Herdr tab named after the session (see step 2). The prompt then becomes that agent's full brief, so write all of it, not one line: pass it as `--prompt "$(cat <brief file>)"`. The JSON record gains `"herdr": {"workspace", "tab", "pane"}`. Outside Herdr, `--herdr` fails; don't retry without it unless the user agrees.

Remember the `id` and the per-repo `dir`s — everything below uses them.

## 2. Do the work

Pick one:

- **Hand it to its own agent in a Herdr tab** (only when you're in Herdr and the user wants sessions worked by separate agents they can watch or step into): start it with `--herdr` as above, with `--agent`/`--model`/`--effort` as the user wants. That agent runs inside the session like a human-started one, so decide who lands it and say so in the brief: either it runs `/done` itself when finished, or it stops and you land it by id (step 4). Follow it with the pane id from the JSON: `herdr agent wait <pane> --timeout <ms>` returns when it goes idle or blocked, and `herdr agent read <pane> --source recent-unwrapped --lines 120` shows what it said. If it's `blocked` on a question or approval, show the user; don't answer for them. Don't close its tab unless the user asks.

- **Yourself:** edit files by their absolute paths under the session's `dir`, and run commands with `git -C <repo dir> …` or in a subshell `(cd <repo dir> && …)`. Never edit the canonical checkouts at `<root>/<repo>` — only paths under `<root>/.worktrees/<id>/`.
- **Delegate to a subagent** (best for parallel sessions): spawn one agent per session, and give it the task, the session `dir`, and the per-repo dirs from the JSON. Tell it: *work only under `<dir>`, use absolute paths or `(cd <repo dir> && …)`, commit or leave edits uncommitted as it likes, and do NOT run `/done`, `/abort`, or any `gw` command* — landing stays with you.

## 3. Check on sessions

```bash
env -u GW_ROOT __GW_TSX__ "__GW_TS__" status --json
```

This prints `{"root", "sessions": [{"id", "dir", "hasUnlandedWork", "unlanded", "lastActivityAt", "idleSeconds", "herdr", "repos": [{"key", "dir", "branch", "uncommitted", "untracked", "unlandedCommits"}]}]}`. A session with `hasUnlandedWork: false` has nothing to land. `herdr` is `null` unless the session was opened with `--herdr`; then it's `{"workspace", "tab", "pane", "openedAt", "open"}`, where `open` says whether that pane still exists (`null` when you're outside Herdr). Use it to find a tab's agent again if you've lost the ids from the start record.

## 4. Land a session

First look at exactly what would land (read-only):

```bash
env -u GW_ROOT __GW_TSX__ "__GW_TS__" done <id> --show --in-agent
```

Then compose a Conventional-Commits message from that diff: a subject of 72 characters or fewer (`type(scope): summary`), a blank line, 2–5 bullets on what changed and why, and a `Repos: a, b` line if more than one repo changed. Land it:

```bash
env -u GW_ROOT __GW_TSX__ "__GW_TS__" done <id> --in-agent -m "$(cat <<'EOF'
<subject>

- <bullet>
EOF
)"
```

- It commits pending edits, merges `origin/<base>` in, runs every changed repo's gate, squash-merges, pushes, and removes the session's worktrees. One red gate lands nothing.
- Success is the printed `merged + pushed: …` line.
- A non-zero exit keeps the session for recovery, and the command is **idempotent**: fix what it names (a gate failure → fix the code under that repo's worktree dir; a merge conflict → resolve it in the named worktree and commit), then re-run the **same** command. A push race just needs a re-run.
- Several sessions can be landed one after another. Gates are serialized per workspace automatically.

## 5. Discard a session

```bash
env -u GW_ROOT __GW_TSX__ "__GW_TS__" abort <id> --in-agent
```

If it refuses because the session has unlanded work, **do not** add `--yes` on your own. Show the user what it listed and ask whether to land it instead or really discard it. Only after they explicitly confirm, re-run with `--yes`.

## 6. Before a deploy

```bash
env -u GW_ROOT __GW_TSX__ "__GW_TS__" ready --json
```

This prints `{"ready", "sessions": [...], "repos": [{"key", "branch", "notes", "blocking"}], "warnings", "problems"}` and exits 0 only when nothing is unlanded and every canonical checkout sits exactly on `origin/<base>`.

Report back to the user per session: its id, what was done, and whether it landed (and to which repos), was discarded, or is still open.
