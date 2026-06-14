# gw — Grove Workspace shell function.
#
# A child process can't change your shell's directory or hand the terminal to an
# interactive agent — only the shell can. So this thin function calls the TypeScript
# helper (src/gw.ts) for all git/gh/gate work, then performs the `cd` + agent launch
# itself, based on one directive line the helper writes to a temp file ($GW_OUT).
# Same pattern as nvm / zoxide / direnv.
#
# Install: add this line to your ~/.bashrc (or ~/.zshrc):
#     source /path/to/gw/gw.sh
# then run `gw init` in the directory that holds your repos (once per workspace).
#
# GW_HOME  = where gw is installed (this file's dir) — holds tsx + src/gw.ts.
# GW_ROOT  = the workspace (the dir with gw.config.json). Auto-discovered by walking
#            up from $PWD; set GW_ROOT yourself to override.

gw() {
  local home out kind dir b64 b64l rc tsx root prompt launcher d

  # The launcher default (`claude --permission-mode auto`) is word-split below by leaving
  # ${launcher:-...} unquoted — bash does this automatically, zsh does not. Enable it for
  # zsh, scoped to this function (local_options restores it on return).
  [ -n "${ZSH_VERSION:-}" ] && setopt local_options sh_word_split

  # GW_HOME: dir of this script (resolve symlinks for the common `source ~/link` case).
  if [ -n "${BASH_SOURCE[0]:-}" ]; then home="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

  tsx="$home/node_modules/.bin/tsx"
  out="$(mktemp)"
  if [ -x "$tsx" ]; then
    GW_OUT="$out" GW_ROOT="$root" "$tsx" "$home/src/gw.ts" "$@"; rc=$?
  else
    GW_OUT="$out" GW_ROOT="$root" npx --yes tsx "$home/src/gw.ts" "$@"; rc=$?
  fi

  # Read the single directive (tab-separated). Done before the rc check so a partial
  # run still can't leave a stale directive around.
  IFS=$'\t' read -r kind dir b64 b64l < "$out" 2>/dev/null
  rm -f "$out"
  if [ "$rc" -ne 0 ]; then return "$rc"; fi

  case "$kind" in
    CD)
      cd "$dir" || return 1
      ;;
    CD_AND_LAUNCH)
      cd "$dir" || return 1
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
        # shellcheck disable=SC2086
        ${launcher:-claude --permission-mode auto} "$prompt"   # $prompt is ONE argv word; never eval'd
      else
        # shellcheck disable=SC2086
        ${launcher:-claude --permission-mode auto}
      fi
      ;;
    *) : ;;  # NONE / empty: nothing to do
  esac

  # `gw done`/`gw abort` delete the session worktree we may be sitting in. The CD
  # directive normally moves us out, but the --in-claude path emits NONE — leaving the
  # shell in a deleted cwd, where the next `pwd` fails. Land somewhere real.
  if ! pwd -P >/dev/null 2>&1; then cd "$root" || return 1; fi
}
