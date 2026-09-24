## gw (Grove Workspace) — how agents work here

This directory is a **gw workspace**. Each task runs in its own **session**: one git worktree per repo, all on branch `gw/<WT-id>`, under `.worktrees/<WT-id>/<repo>/`. When the work is done, a session is landed with a gate, squash-merged into each changed repo, and pushed.

**Rule #1: the canonical checkouts ({{REPOS}}) are READ-ONLY.** Make every edit in a session worktree, e.g. `.worktrees/<WT-id>/<repo>/path/file`, never `<repo>/path/file`. `gw done` only sees changes inside the worktree, so edits to the canonical copy silently never land. This applies whether you're inside a session or managing sessions from this root.

**Which command to use:**

| Situation | Use |
|---|---|
| You were launched inside `.worktrees/<WT-id>/` and the work is finished | `/done` (Codex: `$gw-done`). Use `/df` to skip the gate. |
| You were launched inside a session and the work should be thrown away | `/abort` (`$gw-abort`). It never discards unlanded work without the user's OK. |
| You're at the workspace root and want to run one or more tasks in isolated sessions (in parallel, or delegated to subagents) without leaving this conversation | `/gw-sessions` (`$gw-sessions`). It covers `start --prompt … --name … --json`, `status --json`, `done <id> --in-agent`, `abort <id> --in-agent`, and `ready --json`. |
| Inside Herdr (`HERDR_ENV=1`), the user wants a task handed to its own agent in a separate tab they can watch | `/gw-sessions` with `start --herdr … --json`: it opens the session in a new Herdr tab, launches the agent there with the prompt as its brief, and returns the tab and pane ids. |
| "Is everything landed? Safe to deploy?" | `/donedone` (`$gw-donedone`), or `gw ready --json` |

From an agent's shell, call gw through those commands (they run `gw.ts` by path), not the interactive `gw` shell function. Never run `gw start` without `--json`/`--no-launch` from an agent: it's meant for a human at a terminal. The one exception is `--herdr`, which launches the agent in a new Herdr tab instead of your shell.

**Tell the user whether each session landed.** The `merged + pushed: …` line is the proof. A failed `done` keeps the session, and re-running the same command is the fix.
