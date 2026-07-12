# gw — Grove Workspace

**Give each task its own set of git worktrees — one per repo, branched together — so a coding agent can make one coherent change across several repos and land it everywhere with a single, can't-lose-work command.**

![node](https://img.shields.io/badge/node-%E2%89%A518-3c873a) ![license](https://img.shields.io/badge/license-MIT-blue) ![status](https://img.shields.io/badge/agent-Claude%20by%20default-f26522)

Coding agents are excellent inside one repo. Real changes span three — API + web + worker. The moment a task crosses repos you're back to juggling branches, keeping three checkouts in lockstep, and hoping you didn't land two of the three. `gw` removes that: every unit of work gets a parallel mirror of your workspace, with **every repo on a fresh branch off `origin/<base>`**. The agent edits across all of them in one session; `gw done` gates, squash-merges, and pushes only the repos that actually changed — atomically per repo, idempotent, and built so a failure can't strand your work.

```
gw install  →   wire the gw command into your shell (one time, idempotent)
gw init     →   detect your repos, write config, install slash commands
gw start    →   type a task; gw branches every repo and launches your agent
/done       →   gate + squash-merge + push — only the repos you changed
gw ready    →   "is anything unlanded? safe to deploy?" — one verdict
```

Your live checkouts are **only ever merged into, never edited in place** — so several sessions run side by side without colliding.

---

## 60-second start

```bash
git clone https://github.com/siverson914/gw    # clone anywhere
cd gw && npm install
npm run gw install                              # appends `source <this-clone>/gw.sh` to your rc
exec $SHELL                                     # reload — then `gw doctor` to verify
```

`gw install` writes the **absolute path of this clone** into your `~/.bashrc` or `~/.zshrc` (idempotent; `--rc <file>` to target one, `--print` to just show the line). `gw doctor` checks tools + shell wiring and tells you what's missing.

Point it at the directory that holds your repos as siblings:

```
~/Developer/MyProject/
  server/   web/   cli/
```

```bash
cd ~/Developer/MyProject
gw init          # autodetects repos, remotes, bases, deps & gates → gw.config.json
gw start         # type your task → you're now in an isolated, multi-repo session
```

…the agent edits across all repos, runs tests, iterates, then:

```
/done            # inside the agent: gate every changed repo, squash-merge, push
```

`gw status` shows where everything stands; `gw ready` tells you when it's safe to ship.

---

## Why gw

Worktree managers (grove, gwq, …) and agent-in-worktree runners stop at *"make a worktree, launch the agent."* `gw` adds the two halves they leave out:

- **One session spans many repos.** A coordinated change to API + client + worker is branched together and landed together — not three disconnected PRs you keep in lockstep by hand.
- **A real land workflow.** `done` runs each repo's gate, squash-merges to its base, and pushes — **all gates first, so one red gate lands nothing.** It lands in a throwaway worktree off `origin/<base>`, so a dirty checkout can't block it and a failed land strands nothing. It's idempotent: re-run and it picks up exactly what's left.
- **A deploy-readiness verdict.** `gw ready` answers the question you actually care about: *is anything, in any session, not yet landed — and do my checkouts match `origin`?*

## A day with gw

```text
gw start                         # "add per-clip view counts (api + web + worker)"
  → WT-007 across all three repos, agent launched in .worktrees/WT-007-per-clip-view-counts/
  …agent edits server/, web/, worker/ together, runs things, iterates…
/done
  [server]  gate: npm run test:fast … passed
  [web]     gate: npm run test:fast … passed
  [worker]  gate: pytest -q … passed
  merged + pushed: server, web, worker      # one coherent change, three repos, one step

# meanwhile a second session ran in parallel, in its own worktree set:
gw status                        # see every session + repo at a glance
gw ready                         # ✓ nothing unlanded anywhere — safe to deploy
```

Each session is named from your prompt (`WT-007-per-clip-view-counts`) and that name is set as the terminal tab title, so parallel sessions are tellable apart at a glance. Finishing a session resets the tab back to the project name.

## Commit messages that read well

`/done` composes a real squash message instead of a bare id. It shows you the net per-repo diff (`gw done --show`), then writes a Conventional-Commits message — a tight `type(scope): summary` subject that reads well in `git log --oneline`, and a body with the detail you get on open:

```
fix(server): debounce clip-count writes under burst load

- batch increments in a 250ms window instead of one write per view
- add a regression test for the burst path
Repos: server, worker
```

Run `gw done` directly (no agent) and it still builds a structured message from the branch's own commits rather than just the session id. Pass `-m` to override.

## Commands

| Command | What it does |
|---|---|
| `gw install [--rc <file>] [--print]` | Append `source <clone>/gw.sh` to your shell rc so the `gw` command exists in every shell. Idempotent; uses this clone's absolute path. Run once as `npm run gw install`. |
| `gw doctor` | Preflight: `git`/`gh`/`node ≥18`/local `tsx`/`claude`, whether the shell is wired up, and whether you're in a workspace. Run it first when something's off. |
| `gw init [--repo owner/name …] [--force]` | Detect the git repos sitting as siblings here (or clone the ones you name), autodetect each one's remote/base/deps/gate, write `gw.config.json`, install the slash commands. |
| `gw start [WT-id] [--no-continue] [--new]` | Put **every** repo on a fresh `gw/<id>` branch off `origin/<base>`, open an edit box for your prompt with a model row under it (write the prompt, Tab to the row, ←/→ to pick, Enter to Go — it opens on the last model you used), `cd` into `.worktrees/<id>/`, and launch the agent. Pass a `WT-id` — or just run it from inside a session worktree — to **resume**, which re-enters that session and **continues the prior agent conversation** by default (`--no-continue` starts a clean conversation; `--new` forces a brand-new session even from inside a worktree). |
| `gw done [--pr] [--no-check] [--quick\|--full] [-m msg]` | For every changed repo: commit, gate, squash-merge to its base, push. Untouched repos skipped; one red gate lands nothing. `--pr` opens a PR per repo instead. `--quick` runs each repo's lighter, diff-scoped `gateQuick` (falling back to the full `gate`, so never *less* safe); `--full` forces the full gate even where a repo sets `gateQuickDefault`. Without `-m`, the message is composed from the branch's own commits (the `/done` skill writes a richer one). |
| `gw done --show` | Read-only: print the net per-repo diff that would land (the session's own work, vs the merge base with `origin/<base>` — never other people's newer commits, inverted), staging/gating/merging nothing. Used by `/done` to compose the commit message before landing. |
| `gw status` | One-glance cross-repo + worktree view: branch, uncommitted/untracked, ahead/behind. |
| `gw ready` | The **done-done** check: no session holds unlanded work, every checkout sits exactly on `origin/<base>`. Exit 0 = a deploy ships exactly what landed. |
| `gw abort [WT-id] [--yes]` | Discard a session's branch work in every repo. Base branches are never touched. It first prints exactly what's unlanded; under `--in-claude` (the `/abort` skill) it **refuses** to discard unlanded work unless `--yes` is passed, so an agent can never silently destroy real work. |
| `gw prune [--older-than 2d] [--dry-run]` | Remove fully-landed, idle sessions. |
| `gw setup` | (Re)install the `/done`, `/abort`, `/donedone` slash commands and sanity-check tools/repos. |
| `/done`, `/abort`, `/donedone` | The same as `gw done` / `abort` / `ready`, but run **inside the agent** — so a red gate or conflict gets fixed and explained live, then you re-run. |

Legacy `WS-` session ids created before the `WT-` rename are still resolvable and landable.

## Safety — gw is built so you can't lose work

- **Failures never lose work.** Landing happens in a disposable worktree off `origin/<base>`: a dirty checkout can't block it, a failed land strands nothing, and `gw done` is idempotent — re-run and it finishes the rest.
- **Sessions are strictly isolated.** gw refuses to stage/commit/land in any path that isn't a genuine `gw/<id>` linked worktree, so edits can never hit a canonical checkout.
- **Catches the "wrong copy" mistake.** If a repo's canonical checkout has uncommitted edits while its session worktree is clean, `gw done` warns loudly — those edits won't silently get left behind. (For agents that support hooks, you can also add a `PreToolUse` hook that *blocks* canonical-path edits outright during a session.)
- **Canonical checkouts advance — or say why they didn't.** After a land, gw fast-forwards each shared checkout to `origin/<base>` so the next `gw start` (and any deploy) sees fresh code. It tests **content-level** dirtiness (not just `git status`, which a mtime-only-touched file can trip), so a checkout doesn't get stuck behind origin; when it genuinely can't advance it warns that deploys from there would ship stale code. (See [docs/postmortem-stale-deploy.md](docs/postmortem-stale-deploy.md).)
- **`gw ready` only ever fast-forwards** (`--ff-only`) a clean checkout — it can never clobber local work.

## How it works (the one bit of plumbing)

A script can't change your shell's directory or hand the terminal to an interactive agent — only the shell can (this is why `nvm`, `zoxide`, `direnv` are shell functions). So `gw` is a tiny shell function (`gw.sh`) that calls the real logic in `src/gw.ts`; the script does every git/gh/gate operation, then writes one directive line ("cd here", or "cd here and launch the agent with this prompt") to a temp file the function reads and acts on. Your typed prompt rides base64-encoded so quotes/`$`/`!`/backticks survive untouched, and it's never `eval`'d.

It keeps one worktree set per session under `<root>/.worktrees/<WT-id>/<repo>` — a mirror of your real root, so every repo sits side-by-side.

## Config (`gw.config.json`)

```jsonc
{
  "base": "main",                                  // default integration branch
  "launcher": "claude --permission-mode auto",     // how `gw start` launches the agent
  "resumeArgs": ["--continue"],                    // extra launcher args on resume (continue the prior convo); [] to disable
  "namer": "claude --model haiku",                 // titles each session from its prompt (fallback: plain slug)
  "brandColor": "#f26522",                         // banner + prompt-box accent
  "docker": false,                                 // write .dockerignore into session dirs (linked deps stay out of build contexts)
  "sessionGate": null,                             // optional cross-repo check (see below)
  "warnDirs": [],                                  // published-but-not-gw-managed dirs `ready` warns about
  "repos": [
    {
      "key": "server",                             // worktree subdir + display name
      "dir": "server",                             // relative to the workspace root (or absolute)
      "slug": "siverson914/MyServer",              // owner/repo, for `gh` (PRs)
      "base": "main",
      "linkPaths": ["node_modules", ".env"],       // gitignored deps/env symlinked into each worktree
      "copyPaths": [],                             // gitignored files a docker build needs as REAL files
      "gate": ["npm", "run", "test:fast"],         // fast pre-merge check; null = none
      "gateQuick": ["npm", "run", "test:changed"], // optional lighter gate for `gw done --quick`; null = fall back to gate
      "gateQuickDefault": true,                    // run gateQuick by default (no --quick); --full forces the full gate
      "nmScope": "@myproject"                      // npm workspace scope needing a per-worktree node_modules farm
    }
  ]
}
```

- **`linkPaths`** are symlinked into every worktree so gates can run without re-installing deps. **They must stay gitignored** — gw will never commit *or delete* a linkPath, and warns if one is tracked (a `.env` belongs here, never in git).
- **`sessionGate`**: `{ "repo": "server", "commands": [["npx","tsx","scripts/build-docs.ts","--check"]] }` — runs from that repo's worktree to catch cross-repo drift (e.g. a generated file) a per-repo gate would miss. Skipped when that repo itself changed (its own gate covers it).
- **`gateQuick`**: an optional lighter, diff-scoped gate used under `gw done --quick`; without it, `--quick` runs the full `gate` (never *less* safe). Every gate — full or quick — is handed `GW_BASE` (the base ref) and `GW_CHANGED_FILES` (newline-separated paths changed on the branch), so a quick gate can run just the affected tests (e.g. `jest --changedSince=$GW_BASE`).
- **`gateQuickDefault`**: set `true` to run `gateQuick` on *every* land without `--quick` (pass `--full` to force the complete gate anyway). Only safe where something downstream re-runs the full suite — e.g. a deploy that gates on tests. A repo that ships straight from a land with no later full run should leave this off so its full `gate` stays the pre-ship line.
- **`nmScope`**: set only for npm/yarn **workspace** monorepos where `node_modules/<scope>/*` symlinks back into the repo; gw rebuilds those links per-worktree so a worktree's edits to a local package are seen by its own tests.

## Testing

`npm test` runs an end-to-end suite (`test/gw.test.ts`) that drives the **real CLI** against disposable fixture workspaces — local bare repos as origins, real worktrees, real pushes; nothing mocked. It pins the safety invariants (one red gate lands nothing; a tracked linkPath never lands as a deletion; a symlinked session path is never staged or destroyed through; abort can't silently discard unlanded work; gate timeouts are reported as timeouts). `GW_GATE_TIMEOUT_MS` exists so the timeout path is testable in milliseconds. Add a test whenever a new failure mode is discovered — that's the suite's whole job.

## Requirements

`git`, `gh` (for `--pr` and `init --repo`), `node` ≥ 18, and `tsx` (installed via `npm install`). The default `launcher`/`namer` use the `claude` CLI; point them at any other agent in `gw.config.json`.

## License

MIT
