# gw — guide for agents working on this repo

## What gw is for

`gw` (Grove Workspace) gives each coding task its own **set of git worktrees, one per repo, all on one branch** (`gw/<WT-id>`), so an agent can make one coherent change across several repos. It then lands that change everywhere with a single safe command. A "workspace" is a directory holding sibling repos plus a `gw.config.json`. Sessions live under `<workspace>/.worktrees/<WT-id>/<repo>/`.

The lifecycle:

```
gw start   → branch every repo off origin/<base> into .worktrees/<id>/, launch an agent there
(work)     → edit across repos inside the session
gw done    → commit → merge origin/<base> in → run every changed repo's gate → squash-merge → push → remove worktrees
gw abort   → discard the session (base branches never touched)
gw ready   → "is anything unlanded, and does every checkout match origin?" (exit 0 = safe to deploy)
```

It has two audiences:
- **A human in a terminal.** `gw start` opens a prompt box, then cd's into the session and launches Claude, Codex, Grok, or agy.
- **An agent.** Inside a session it uses `/done` / `/abort`. From outside it manages sessions with `/gw-sessions`: `start --prompt … --name … --json`, `status --json`, `done <id> --in-agent`, `ready --json`. See README → "Driving gw from an agent".

## Layout

| Path | Role |
|---|---|
| `gw.sh` | The `gw` shell function. It exists only because a child process can't `cd` your shell or hand it the terminal. It runs `src/gw.ts`, reads **one directive line** from the file `$GW_OUT` names (`CD` / `CD_AND_LAUNCH` / `NONE` + dir + base64 prompt + base64 launcher argv), and acts on it. It exports `GW_HOME` when sourced, which is required for shells rebuilt from a snapshot, such as Claude Code's Bash tool. |
| `gw-launch.sh` | Used only by `gw start --herdr`. The new Herdr tab runs `sh gw-launch.sh <session>/.gw-launch`, which decodes the staged launcher argv and prompt, deletes the file, and `exec`s the agent. This keeps the prompt out of `herdr pane run` and needs no `gw` function in the tab's shell. |
| `src/gw.ts` | Every subcommand: flag parsing, start/done/abort/status/ready/prune/init/setup/install/doctor. |
| `src/lib/worktrees.ts` | git plumbing: session ids (`allocateId`, `parseId`), worktree creation and removal, isolation checks, locks, namer (`smartSlug`). |
| `src/lib/prompt-box.ts` | The TTY prompt editor and agent/model/effort picker. |
| `src/config.ts` | Loads `gw.config.json` and holds the built-in agent presets (`DEFAULT_AGENTS`). |
| `commands/*.md` | Agent instructions. `gw setup` installs them to `~/.claude/commands/`, and as Codex/agy `SKILL.md`s, replacing `__GW_TSX__` / `__GW_TS__` with this machine's paths. They must never contain a workspace path, and must call gw as `env -u GW_ROOT … gw.ts` (a test enforces this). |
| `templates/workspace-agents.md` | The block `gw setup`/`gw init` keeps up to date between `<!-- gw:begin -->` / `<!-- gw:end -->` markers in a workspace's `CLAUDE.md` and `AGENTS.md`. |
| `test/gw.test.ts`, `test/fixture.ts` | End-to-end suite: the real CLI against throwaway workspaces with local bare-repo "origins". Nothing is mocked. |
| `docs/` | Postmortems. Read `postmortem-stale-deploy.md` before touching the post-land fast-forward. |

## Working on it

```bash
npm install
npm run typecheck      # tsc --noEmit
npm test               # full e2e suite, ~1 min
npm run gw -- <sub>    # run the CLI without the shell function (set GW_ROOT to a workspace)
```

- Add a test for every new flag and every newly discovered failure mode. That's the suite's job.
- stdout is reserved for command results (`--json` records, `--show` diffs, `status`/`ready` lines). Logs go to stderr via `log()`. Never print incidental output to stdout, or you break `--json` consumers.
- Every command must call `emit(...)` (usually `emit('NONE')`) or leave `$GW_OUT` empty. `gw.sh` treats an empty directive as a no-op.
- Unknown flags are a hard error. Add new flags to `Flags`, `parseFlags`, `HELP`, and the README command table.
- Changes land by committing straight to `main` and pushing. After changing `commands/` or `templates/`, run `gw setup` from a workspace so the installed copies update.

## Invariants — don't break these

These exist because each was violated once:
- **All gates run before any merge.** One red gate lands nothing.
- **Landing happens in a throwaway worktree off `origin/<base>`.** A dirty canonical checkout never blocks a land, and a failed land strands nothing. `done` is idempotent: re-running finishes what's left.
- **gw only stages, commits, or removes inside a real `gw/<id>` linked worktree** (`assertIsolatedSession`). It never works through a symlink into a canonical checkout.
- **`linkPaths` are never committed or deleted.** A tracked one would otherwise land as a deletion (the `.env` wipe).
- **`abort --in-agent` refuses to discard unlanded work without `--yes`.** Agents must ask the user first.
- **Canonical checkouts only ever move with `--ff-only`,** and gw warns loudly when one is left behind origin.
- **The prompt is never `eval`'d.** It travels base64-encoded as one argv word. The launcher argv is newline-joined, because model names can contain spaces.
- **A scripted start (`--prompt`/`--name`) always creates a new session.** A non-TTY `gw.sh` never `cd`s or launches.
