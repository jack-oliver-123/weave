#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:?missing root directory}"
CONFIG_PATH="${2:?missing config path}"
ENV_PATH="${3:?missing environment path}"
SESSION="weave-live-wsl-$$-$RANDOM"
SOCKET="weave-live-wsl-$$-$RANDOM"
RUNTIME_DIR="$(mktemp -d -t weave-live-wsl.XXXXXX)"

run_tmux() { tmux -L "$SOCKET" "$@"; }
cleanup() {
  run_tmux kill-session -t "$SESSION" >/dev/null 2>&1 || true
  run_tmux kill-server >/dev/null 2>&1 || true
  if [[ "$RUNTIME_DIR" == /tmp/weave-live-wsl.* ]]; then rm -rf -- "$RUNTIME_DIR"; fi
  unset GOOGLE_API_KEY
}
trap cleanup EXIT

key_line="$(grep -m1 '^GOOGLE_API_KEY=' "$ENV_PATH" || true)"
[[ -n "$key_line" ]] || { printf 'WSL live TUI smoke blocked: GOOGLE_API_KEY is missing.\n' >&2; exit 2; }
export GOOGLE_API_KEY="${key_line#*=}"
GOOGLE_API_KEY="${GOOGLE_API_KEY%\"}"; GOOGLE_API_KEY="${GOOGLE_API_KEY#\"}"
GOOGLE_API_KEY="${GOOGLE_API_KEY%\'}"; GOOGLE_API_KEY="${GOOGLE_API_KEY#\'}"
export GOOGLE_API_KEY

capture() { run_tmux capture-pane -p -t "$SESSION"; }
wait_text() {
  local expected="$1" timeout="${2:-120}" deadline pane=""
  deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    pane="$(capture)"
    [[ "$pane" == *"$expected"* ]] && return 0
    sleep 0.2
  done
  printf 'WSL live TUI smoke timed out waiting for expected output.\n' >&2
  return 1
}
send_literal() { run_tmux send-keys -t "$SESSION" -l "$1"; }
send_key() { run_tmux send-keys -t "$SESSION" "$1"; }

cd "$ROOT_DIR"
npm run build
cp package.json package-lock.json "$RUNTIME_DIR/"
cp -R dist "$RUNTIME_DIR/"
(
  cd "$RUNTIME_DIR"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
)

run_tmux new-session -d -s "$SESSION" -x 100 -y 30 bash
run_tmux set-option -t "$SESSION" status off
sleep 0.4
send_literal "cd '$RUNTIME_DIR' && node dist/main.js --config '$CONFIG_PATH' --profile gemini-chat && printf 'WEAVE_LIVE_EXITED\\n'"
send_key Enter
wait_text 'openai-chat-completions / gemini-3.6-flash' 20

send_literal 'Return the words ALPHA and OK joined by one underscore, with nothing else.'
send_key Enter
wait_text 'ALPHA_OK' 120
sleep 0.5

send_literal 'Using this conversation context, return the words BETA and OK joined by one underscore, with nothing else.'
send_key Enter
wait_text 'BETA_OK' 120
sleep 0.5

send_literal $'\x03'
send_literal $'\x03'
wait_text 'WEAVE_LIVE_EXITED' 5
send_literal 'exit'; send_key Enter
printf 'WSL real TUI smoke passed: profile=gemini-chat protocol=openai-chat-completions turns=2.\n'
