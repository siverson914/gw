# gw-launch.sh <launch-file>: run the agent launch that `gw start --herdr` staged.
#
# `gw start --herdr` opens a new Herdr tab whose shell may not have the gw function
# sourced, then types ONE constant command into it: `sh <this file> <launch-file>`.
# The launch file (written by gw.ts, mode 600, in the session dir) holds two lines:
# the base64 newline-joined launcher argv and the base64 prompt (empty for none).
# Decoding here instead of shell-quoting the prompt into `herdr pane run` means
# multi-line text, quotes, $ and backticks reach the agent untouched: the prompt is
# ONE argv word and is never eval'd. Same decode as gw.sh's CD_AND_LAUNCH branch.
# The file is removed before exec so a stale launch can never replay.

f="$1"
if [ -z "$f" ] || [ ! -f "$f" ]; then
  printf 'gw: launch file %s is missing (already used?). Resume with: gw start <session-id>\n' "$f" >&2
  exit 1
fi
{ IFS= read -r b64l; IFS= read -r b64p; } < "$f"
rm -f "$f"

launcher="$(printf '%s' "$b64l" | base64 -d 2>/dev/null)"
if [ -z "$launcher" ]; then
  printf 'gw: launch file %s holds no launcher\n' "$f" >&2
  exit 1
fi
set --
while IFS= read -r word; do set -- "$@" "$word"; done <<EOF
$launcher
EOF

# exec: the agent replaces this sh, so it is the pane's foreground process (Herdr
# detects it) and quitting it drops back to the tab's shell in the session dir.
if [ -n "$b64p" ]; then
  prompt="$(printf '%s' "$b64p" | base64 -d)"
  exec "$@" -- "$prompt"
fi
exec "$@"
