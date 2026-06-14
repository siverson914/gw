# gw — Grove Workspace

Parallel, isolated agent work-sessions across **many git repos**, with a safe one-shot
land and a deploy-readiness check.

Each unit of work gets its own set of git worktrees — one per repo — branched together
off `origin/<base>`. You launch your agent (Claude by default) in that isolated set,
edit any/all repos in one session, then `done` gates and squash-merges every repo you
actually changed back to its base branch in a single step. `ready` verifies nothing is
left unlanded before you deploy. Your live checkouts are never edited in place — only
merged into.

```
gw init             # in the dir holding your repos: detect them, write gw.config.json
gw start            # type a prompt → branches every repo, launches your agent in .worktrees/
   …work in the agent (edit backend + frontend + cli together)…
/done               # (inside the agent) gate + squash-merge + push — only the repos you touched
   …repeat for other sessions, which run side-by-side…
gw ready            # done-done: anything unlanded anywhere? checkouts synced? safe to deploy?
```

`gw` stands for **Grove Workspace**. It keeps one worktree set per session under
`<root>/.worktrees/<WS-id>/<repo>`, a mirror of your real root, so every repo sits
side-by-side and a coordinated cross-repo change happens in one session.

## Why not just `git worktree` / a worktree manager?

Worktree managers (grove, gwq, …) and the agent-in-worktree runners stop at "make a
worktree / launch the agent." `gw` adds the two halves they don't: it spans **multiple
repos** as one session, and it has a **land workflow** — gate → squash-merge → push,
idempotent, landing in a throwaway worktree off `origin/<base>` (so a dirty canonical
checkout can never block it) — plus a **`ready`** deploy-readiness verdict.

## Commands

| Command | What |
|---|---|
| `gw init [--repo owner/name …] [--force]` | Detect the git repos sitting as siblings in this dir (or clone the ones you name), autodetect each one's remote/base/deps/gate, write `gw.config.json`, and install the slash commands. |
| `gw start [WS-id]` | Put **every** repo on a fresh `gw/<id>` branch off `origin/<base>`, open an edit box for the starting prompt, `cd` into `.worktrees/<id>/`, and launch the agent. A bare `WS-id` **resumes** that session instead of starting a new one. |
| `gw done [--pr] [--no-check] [-m msg]` | For every repo you changed: commit, run its gate, squash-merge to its base, push. Untouched repos skipped; all gates run first, so one red gate lands nothing. `--pr` opens a PR per repo instead. |
| `gw abort [WS-id]` | Discard a session's branch work in every repo. Base branches are never touched. |
| `gw status` | One-glance cross-repo + worktree view: branch, uncommitted/untracked, ahead/behind. |
| `gw ready` | The **done-done** check: no session holds unlanded work; each canonical checkout is fast-forwarded to and sits exactly on `origin/<base>`. Exit 0 = a deploy ships exactly what landed. |
| `gw prune [--older-than 2d] [--dry-run]` | Remove fully-landed, idle sessions (nothing a `/done` would land). |
| `gw setup` | (Re)install the `/done`, `/abort`, `/donedone` slash commands and sanity-check tools/repos. |
| `/done`, `/abort`, `/donedone` | The same as `gw done` / `abort` / `ready`, but run **inside the agent** — so a red gate or conflict gets fixed/explained live, then you re-run. |

## Setup

```bash
git clone https://github.com/siverson914/gw ~/gw
cd ~/gw && npm install
echo 'source ~/gw/gw.sh' >> ~/.zshrc      # or ~/.bashrc
```

Then, in the directory that holds your repos as siblings:

```
~/Developer/MyProject/
  server/   web/   cli/
```

```bash
cd ~/Developer/MyProject
gw init          # writes gw.config.json, installs the slash commands
# review gw.config.json — the gates are best-guesses; fix any that are wrong
```

Open a new shell and run `gw start` from anywhere inside the workspace (it discovers
the root by walking up to `gw.config.json`; set `GW_ROOT` to override).

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

- **`sessionGate`**: `{ "repo": "server", "commands": [["npx","tsx","scripts/build-docs.ts","--check"]] }` — runs from that repo's worktree to catch cross-repo drift (e.g. a generated file) a per-repo gate would miss. Skipped when that repo itself was changed (its own gate already covers it).
- **`nmScope`**: set this only for npm/yarn **workspace** monorepos where `node_modules/<scope>/*` symlinks back into the repo; gw then rebuilds those links per-worktree so a worktree's edits to a local package are seen by its own tests.

## How it works (the one bit of plumbing)

A script can't change your shell's directory or hand the terminal to an interactive
agent — only the shell can (this is why `nvm`, `zoxide`, `direnv` are all shell
functions). So `gw` is a small shell function (`gw.sh`) that calls the real logic in
`src/gw.ts`; the script does every git/gh/gate operation, then writes one directive
line ("cd here", or "cd here and launch the agent with this prompt") to a temp file the
function reads and acts on. Your typed prompt rides base64-encoded so quotes/`$`/`!`/
backticks survive untouched, and it's never `eval`'d.

## Safety

- Conflicts/failures **never lose work**: landing happens in a disposable worktree off
  `origin/<base>`, so a dirty checkout never blocks it and a failed land strands
  nothing — the session is kept intact for a re-run (`gw done` is idempotent).
- Sessions are strictly isolated: gw refuses to stage/commit/land in any path that
  isn't a genuine `gw/<id>` linked worktree, so edits can never hit a canonical checkout.
- `gw ready` only ever fast-forwards (`--ff-only`) a clean checkout — it can never
  clobber local work.

## Requirements

`git`, `gh` (for `--pr` and `init --repo`), `node` ≥ 18, and `tsx` (installed via
`npm install`). The default `launcher`/`namer` assume the `claude` CLI; point them at
any other agent in `gw.config.json`.

## License

MIT
