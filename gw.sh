# gw — Grove Workspace shell function.
#
# A child process can't change your shell's directory or hand the terminal to an
# interactive agent — only the shell can. So this thin function calls the TypeScript
# helper (src/gw.ts) for all git/gh/gate work, then performs the `cd` + agent launch
# itself, based on one directive line the helper writes to a temp file ($GW_OUT).
# Same pattern as nvm / zoxide / direnv.
#
# Install: from the cloned repo, `npm install` then `npm run gw install` — that appends
#     source /path/to/gw/gw.sh
# to your shell rc for you (idempotent; --rc <file> to target one, --print to just show
# the line). Then open a new shell, `gw doctor` to verify, and `gw init` in the directory
# that holds your repos (once per workspace).
#
# GW_HOME  = where gw is installed (this file's dir) — holds tsx + src/gw.ts.
# GW_ROOT  = the workspace (the dir with gw.config.json). Auto-discovered by walking
#            up from $PWD; set GW_ROOT yourself to override.

gw() {
  local home out kind dir b64 b64l rc tsx root prompt launcher d line

  # The launcher default (`claude --permission-mode auto`) is word-split below by leaving
  # ${launcher:-...} unquoted — bash does this automatically, zsh does not. Enable it for
  # zsh, scoped to this function (local_options restores it on return).
  [ -n "${ZSH_VERSION:-}" ] && setopt local_options sh_word_split

  # GW_HOME: prefer an already-exported value — self-location via BASH_SOURCE/%x
  # assumes we're being sourced fresh from the real file on disk, which breaks
  # when a caller recreates this function from a dumped shell-snapshot file
  # instead (e.g. Claude Code's Bash tool re-sourcing a cached function dump in
  # every fresh shell): zsh then reports the snapshot file as %x, not gw.sh.
  # Exported vars survive that recreation intact, so an rc file that sets
  # GW_HOME explicitly sidesteps the problem entirely.
  if [ -n "$GW_HOME" ]; then home="$GW_HOME"
  elif [ -n "${BASH_SOURCE[0]:-}" ]; then home="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  elif [ -n "${(%):-%x}" ]; then home="$(cd "$(dirname "${(%):-%x}")" && pwd)"   # zsh
  else home="$(cd "$(dirname "$0")" && pwd)"; fi

  # GW_ROOT: explicit env wins; else walk up from $PWD looking for gw.config.json.
  if [ -n "$GW_ROOT" ]; then root="$GW_ROOT"
  else
    d="$PWD"
    while [ "$d" != "/" ]; do
      if [ -f "$d/gw.config.json" ]; then root="$d"; break; fi
      d="$(dirname "$d")"
    done
    # `gw init`/`gw setup`/help can run without a config — fall back to $PWD.
    [ -z "$root" ] && root="$PWD"
  fi

  # If we're stranded in a deleted worktree (e.g. a prior in-agent `done`/`abort`
  # removed the worktree we were sitting in), land somewhere real BEFORE invoking
  # node — tsx/esbuild call process.cwd() at startup and would otherwise die with
  # `uv_cwd ENOENT` before any gw.ts logic runs. Root resolution above is pure
  # shell (dirname on the $PWD string), so it survives a dead cwd to get us here.
  if ! pwd -P >/dev/null 2>&1; then cd "$root" 2>/dev/null || cd "$HOME" || return 1; fi

  tsx="$home/node_modules/.bin/tsx"
  out="$(mktemp)"
  if [ -x "$tsx" ]; then
    GW_OUT="$out" GW_ROOT="$root" "$tsx" "$home/src/gw.ts" "$@"; rc=$?
  else
    GW_OUT="$out" GW_ROOT="$root" npx --yes tsx "$home/src/gw.ts" "$@"; rc=$?
  fi

  # Read the single directive: four tab-separated fields (kind, dir, b64-prompt,
  # b64-launcher), ANY of which may be empty — notably the prompt on a resume or a
  # promptless start. Do NOT use `IFS=$'\t' read kind dir b64 b64l`: tab is an IFS
  # *whitespace* char, so read collapses a run of tabs (an empty interior field) into
  # one delimiter and shifts every field left — the launcher then lands in $b64 and
  # $b64l comes back empty, so gw launches the DEFAULT agent with the launcher string
  # as its prompt. Split by hand on literal tabs to preserve empty fields. Done before
  # the rc check so a partial run can't leave a stale directive around.
  IFS= read -r line < "$out" 2>/dev/null
  kind="${line%%$'\t'*}"; line="${line#*$'\t'}"
  dir="${line%%$'\t'*}";  line="${line#*$'\t'}"
  b64="${line%%$'\t'*}";  b64l="${line#*$'\t'}"
  rm -f "$out"
  if [ "$rc" -ne 0 ]; then return "$rc"; fi

  case "$kind" in
    CD)
      cd "$dir" || return 1
      # done/abort land us back at the workspace root — reset the tab from the now-gone
      # session name to the project name so a finished tab doesn't read as still-active.
      if [ -t 1 ]; then printf '\033]0;%s\007' "$(basename "$dir")"; fi
      ;;
    CD_AND_LAUNCH)
      cd "$dir" || return 1
      # Rename the terminal tab to the worktree/session name gw just picked (the
      # worktree dir's basename, e.g. WT-NNN-slug). Tabby — and any xterm/iTerm —
      # honor the OSC 0 escape, so parallel sessions are tellable apart at a glance.
      # TTY-only: writing the escape into a pipe/log would just be garbage bytes.
      if [ -t 1 ]; then printf '\033]0;%s\007' "$(basename "$dir")"; fi
      # Decode the launcher argv (e.g. "claude --permission-mode auto") and word-split
      # it. The prompt rides as ONE argv word (never eval'd) so quotes/$/!/backticks in
      # it survive untouched.
      launcher="$(printf '%s' "$b64l" | base64 -d 2>/dev/null)"
      if [ ! -t 0 ] || [ ! -t 1 ]; then
        # Non-interactive caller (an agent's shell, a script): launching an interactive
        # agent here just dies. The worktree is ready — report it and let the caller drive.
        printf 'gw: session ready at %s (no TTY - not launching agent)\n' "$dir"
        if [ -n "$b64" ]; then printf 'gw: prompt: %s\n' "$(printf '%s' "$b64" | base64 -d)"; fi
      elif [ -n "$b64" ]; then
        prompt="$(printf '%s' "$b64" | base64 -d)"
        # `--` ends option parsing so a prompt starting with `-`/`---` (a markdown rule,
        # a diff, a flag-like first line) is taken as the positional prompt, not parsed
        # as a launcher flag. $prompt stays ONE argv word; never eval'd.
        # shellcheck disable=SC2086
        ${launcher:-claude --permission-mode auto} -- "$prompt"
      else
        # shellcheck disable=SC2086
        ${launcher:-claude --permission-mode auto}
      fi
      ;;
    *) : ;;  # NONE / empty: nothing to do
  esac

  # `gw done`/`gw abort` delete the session worktree we may be sitting in. The CD
  # directive normally moves us out, but an --in-agent path emits NONE — leaving the
  # shell in a deleted cwd, where the next `pwd` fails. Land somewhere real.
  if ! pwd -P >/dev/null 2>&1; then cd "$root" || return 1; fi
}
