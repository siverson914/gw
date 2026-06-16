# gw — Grove Workspace

**Parallel, isolated agent sessions across many git repos — with a one-command, can't-lose-work land.**

![node](https://img.shields.io/badge/node-%E2%89%A518-3c873a) ![license](https://img.shields.io/badge/license-MIT-blue) ![status](https://img.shields.io/badge/agent-Claude%20by%20default-f26522)

Coding agents are great in one repo. Real changes span three. `gw` gives every unit of
work its own set of git worktrees — **one per repo, branched together** off
`origin/<base>` — so your agent can edit backend + web + cli in a single coherent
session. When you're done, **one command** gates, squash-merges, and pushes every repo
you actually touched. Run several sessions side-by-side; your live checkouts are never
edited in place, only merged into.

```
gw install  →   wire the gw command into your shell (one time, idempotent)
gw init     →   detect your repos, write config, install slash commands
gw start    →   type a prompt; gw branches every repo and launches your agent
/done       →   gate + squash-merge + push — only the repos you changed
gw ready    →   "is anything unlanded? safe to deploy?" — one verdict
```

No worktree juggling. No "which branch was I on?" No half-landed cross-repo change.

---

## 60-second start

```bash
git clone https://github.com/siverson914/gw    # clone anywhere
cd gw && npm install
npm run gw install                              # appends `source <this-clone>/gw.sh` to your rc
exec $SHELL                                     # reload — then `gw doctor` to verify
```

`gw install` writes the **absolute path of this clone** into your `~/.bashrc` or
`~/.zshrc` (idempotent; `--rc <file>` to target one, `--print` to just show the line).
`gw doctor` checks tools + shell wiring and tells you what's missing.

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

…edit anything across all repos in the agent, then:

```
/done            # inside the agent: gate every changed repo, squash-merge, push
```

That's it. `gw status` shows where everything stands; `gw ready` tells you when it's safe to ship.

---

## Why gw

Worktree managers (grove, gwq, …) and agent-in-worktree runners stop at *"make a
worktree, launch the agent."* `gw` adds the two halves they leave out:

- **One session spans many repos.** A coordinated change to API + client + worker happens
  together, branched together, landed together — not as three disconnected PRs you have
  to keep in lockstep by hand.
- **A real land workflow.** `done` runs each repo's gate, squash-merges to its base, and
  pushes — **all gates first, so one red gate lands nothing.** It's idempotent and lands
  in a throwaway worktree off `origin/<base>`, so a dirty checkout can't block it and a
  failed land strands nothing. Re-run and it picks up exactly what's left.
- **A deploy-readiness verdict.** `gw ready` answers the question you actually care about:
  *is anything, in any session, not yet landed — and do my checkouts match `origin`?*

## Commands

| Command | What it does |
|---|---|
| `gw install [--rc <file>] [--print]` | Append `source <clone>/gw.sh` to your shell rc so the `gw` command exists in every shell. Idempotent; uses this clone's absolute path. Run once as `npm run gw install`. |
| `gw doctor` | Preflight: `git`/`gh`/`node ≥18`/local `tsx`/`claude`, whether the shell is wired up, and whether you're in a workspace. Run it first when something's off. |
| `gw init [--repo owner/name …] [--force]` | Detect the git repos sitting as siblings here (or clone the ones you name), autodetect each one's remote/base/deps/gate, write `gw.config.json`, install the slash commands. |
| `gw start [WS-id]` | Put **every** repo on a fresh `gw/<id>` branch off `origin/<base>`, open an edit box for your prompt, `cd` into `.worktrees/<id>/`, and launch the agent. Pass a `WS-id` to **resume** that session. |
| `gw done [--pr] [--no-check] [-m msg]` | For every changed repo: commit, gate, squash-merge to its base, push. Untouched repos skipped; one red gate lands nothing. `--pr` opens a PR per repo instead. |
| `gw status` | One-glance cross-repo + worktree view: branch, uncommitted/untracked, ahead/behind. |
| `gw ready` | The **done-done** check: no session holds unlanded work, every checkout sits exactly on `origin/<base>`. Exit 0 = a deploy ships exactly what landed. |
| `gw abort [WS-id]` | Discard a session's branch work in every repo. Base branches are never touched. |
| `gw prune [--older-than 2d] [--dry-run]` | Remove fully-landed, idle sessions. |
| `gw setup` | (Re)install the `/done`, `/abort`, `/donedone` slash commands and sanity-check tools/repos. |
| `/done`, `/abort`, `/donedone` | The same as `gw done` / `abort` / `ready`, but run **inside the agent** — so a red gate or conflict gets fixed and explained live, then you re-run. |

## A day with gw

```text
gw start                         # "add per-clip view counts (api + web + worker)"
  → gw/WS-00007 across all three repos, agent launched in .worktrees/WS-00007/
  …agent edits server/, web/, worker/ together, runs things, iterates…
/done
  [server]  gate: npm run test:fast … passed
  [web]     gate: npm run test:fast … passed
  [worker]  gate: pytest -q … passed
  merged + pushed: server, web, worker      # one coherent change, three repos, one step

# meanwhile, a second session was running in parallel:
gw status                        # see every session + repo at a glance
gw ready                         # ✓ nothing unlanded anywhere — safe to deploy
```

## Config (`gw.config.json`)

```jsonc
{
  "base": "main",                                  // default integration branch
  "launcher": "claude --permission-mode auto",     // how `gw start` launches the agent
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
      "nmScope": "@myproject"                      // npm workspace scope needing a per-worktree node_modules farm
    }
  ]
}
```

- **`linkPaths`** are symlinked into every worktree so gates can run without re-installing
  deps. **They must stay gitignored** — gw will never commit *or delete* a linkPath, and
  warns if one is tracked (a `.env` belongs here, never in git).
- **`sessionGate`**: `{ "repo": "server", "commands": [["npx","tsx","scripts/build-docs.ts","--check"]] }`
  — runs from that repo's worktree to catch cross-repo drift (e.g. a generated file) a
  per-repo gate would miss. Skipped when that repo itself changed (its own gate covers it).
- **`nmScope`**: set only for npm/yarn **workspace** monorepos where `node_modules/<scope>/*`
  symlinks back into the repo; gw rebuilds those links per-worktree so a worktree's edits
  to a local package are seen by its own tests.

## Safety — gw is built so you can't lose work

- **Failures never lose work.** Landing happens in a disposable worktree off
  `origin/<base>`: a dirty checkout can't block it, a failed land strands nothing, and
  `gw done` is idempotent — re-run and it finishes the rest.
- **Sessions are strictly isolated.** gw refuses to stage/commit/land in any path that
  isn't a genuine `gw/<id>` linked worktree, so edits can never hit a canonical checkout.
- **Catches the "wrong copy" mistake.** If a repo's canonical checkout has uncommitted
  edits while its session worktree is clean, `gw done` warns loudly — those edits won't
  silently get left behind. (For agents that support hooks, you can also add a
  `PreToolUse` hook that *blocks* canonical-path edits outright during a session.)
- **`gw ready` only ever fast-forwards** (`--ff-only`) a clean checkout — it can never
  clobber local work.

## How it works (the one bit of plumbing)

A script can't change your shell's directory or hand the terminal to an interactive agent
— only the shell can (this is why `nvm`, `zoxide`, `direnv` are shell functions). So `gw`
is a tiny shell function (`gw.sh`) that calls the real logic in `src/gw.ts`; the script
does every git/gh/gate operation, then writes one directive line ("cd here", or "cd here
and launch the agent with this prompt") to a temp file the function reads and acts on.
Your typed prompt rides base64-encoded so quotes/`$`/`!`/backticks survive untouched, and
it's never `eval`'d.

It keeps one worktree set per session under `<root>/.worktrees/<WS-id>/<repo>` — a mirror
of your real root, so every repo sits side-by-side.

## Requirements

`git`, `gh` (for `--pr` and `init --repo`), `node` ≥ 18, and `tsx` (installed via
`npm install`). The default `launcher`/`namer` use the `claude` CLI; point them at any
other agent in `gw.config.json`.

## License

MIT
