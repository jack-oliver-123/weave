#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:?missing root directory}"
SESSION="weave-wsl-$$-$RANDOM"
SOCKET="weave-wsl-$$-$RANDOM"
RUNTIME_DIR="$(mktemp -d -t weave-wsl-e2e.XXXXXX)"

run_tmux() { tmux -L "$SOCKET" "$@"; }
cleanup() {
  run_tmux kill-session -t "$SESSION" >/dev/null 2>&1 || true
  run_tmux kill-server >/dev/null 2>&1 || true
  if [[ "$RUNTIME_DIR" == /tmp/weave-wsl-e2e.* ]]; then
    rm -rf -- "$RUNTIME_DIR"
  fi
}
trap cleanup EXIT

capture() { run_tmux capture-pane -p -t "$SESSION"; }
wait_text() {
  local expected="$1"
  local timeout="${2:-15}"
  local deadline=$((SECONDS + timeout))
  local pane=""
  while (( SECONDS < deadline )); do
    pane="$(capture)"
    [[ "$pane" == *"$expected"* ]] && { printf '%s' "$pane"; return 0; }
    sleep 0.15
  done
  printf 'waiting for pane text timed out: %s\n%s\n' "$expected" "$pane" >&2
  return 1
}
send_literal() { run_tmux send-keys -t "$SESSION" -l "$1"; }
send_key() {
  run_tmux send-keys -t "$SESSION" "$1"
  if [[ "$1" == Enter ]]; then
    sleep 0.2
    run_tmux send-keys -t "$SESSION" Enter
  fi
}

cd "$ROOT_DIR"
npm run build:e2e
cp package.json package-lock.json "$RUNTIME_DIR/"
cp -R .e2e-dist "$RUNTIME_DIR/"
(
  cd "$RUNTIME_DIR"
  npm ci --ignore-scripts --no-audit --no-fund
)
run_tmux new-session -d -s "$SESSION" -x 100 -y 30 bash
run_tmux set-option -t "$SESSION" status off
sleep 0.4
send_literal "cd '$RUNTIME_DIR' && node .e2e-dist/tests/fixtures/tui-app.js && printf 'WEAVE_E2E_EXITED\\n'"
run_tmux send-keys -t "$SESSION" Enter

pane="$(wait_text 'Weave ve2e')"
[[ "$(grep -Fo 'Weave ve2e' <<<"$pane" | wc -l)" -eq 1 ]]
[[ "$pane" == *'openai-responses / fixture-model'* ]]
# Ink's Kitty capability query has a 200 ms timeout. Let negotiation settle
# before injecting deterministic input so the harness cannot race its buffer.
sleep 0.3
send_literal $'\e[<0;55;6M'
send_literal $'\e[<0;55;6m'

send_literal 'first-question'; send_key Enter
partial="$(wait_text 'first-chunk')"
[[ "$partial" != *'second-chunk'* ]]
send_literal 'queued-one'; send_key Enter
wait_text '已排队 1' >/dev/null
send_literal 'queued-two'; send_key Enter
wait_text '已排队 2' >/dev/null
markdown_pane="$(wait_text 'queue-ok')"
[[ "$markdown_pane" != *'queue-missing'* ]]
[[ "$markdown_pane" == *'Weave'* ]]
[[ "$markdown_pane" != *'```'* ]]
[[ "$markdown_pane" != *'**second-chunk**'* ]]

send_literal 'line-one'
send_literal $'\e[13;2u'
send_literal 'line-two'
draft="$(wait_text 'line-two')"
[[ "$draft" == *'line-one'* ]]
send_key Enter
wait_text 'history-ok' >/dev/null
long_pane="$(wait_text 'long-line-32')"
[[ "$long_pane" != *'history-missing'* ]]

for _ in {1..8}; do send_literal $'\e[<64;10;10M'; done
sleep 0.2
scrolled="$(capture)"
[[ "$scrolled" != *'long-line-32'* ]]
[[ "$scrolled" == *'正在查看上文'* ]]
send_literal $'\e[1;5F'
wait_text 'long-line-32' >/dev/null

run_tmux resize-window -t "$SESSION" -x 79 -y 23
wait_text '终端窗口过小' >/dev/null
run_tmux resize-window -t "$SESSION" -x 100 -y 30
wait_text 'long-line-32' >/dev/null

send_literal 'cancel-me'; send_key Enter
wait_text 'cancel-partial' >/dev/null
send_literal 'after-cancel'; send_key Enter
wait_text '已排队 1' >/dev/null
send_key C-c
cancelled="$(wait_text '队列已暂停' 2)"
[[ "$cancelled" != *'late-event-must-not-render'* ]]
send_key Enter
resumed="$(wait_text 'resume-ok' 5)"
[[ "$resumed" != *'resume-missing'* ]]
sleep 2.1
send_key C-c
send_key C-c

wait_text 'WEAVE_E2E_EXITED' 5 >/dev/null
send_literal 'exit'
run_tmux send-keys -t "$SESSION" Enter
printf 'WSL tmux TUI E2E passed.\n'
