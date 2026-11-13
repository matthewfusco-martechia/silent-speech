#!/bin/zsh
set -euo pipefail
TASK_REPO="${0:A:h:h}"
TASK_APP="${TASK_REPO:h}/phrase-study-build/Build/Products/Debug/PhraseMotionBridge.app"
TASK_URL='http://127.0.0.1:5173/silent-speech/study.html'
TASK_LOG_DIR="${TASK_REPO:h}/phrase-study-runtime"
if [[ ! -d "$TASK_APP" ]]; then
  print -u2 -- "Build the motion bridge first: $TASK_REPO/mac/phrase-study/build.sh"
  exit 1
fi
if [[ ! -d "$TASK_REPO/node_modules" ]]; then
  print -u2 -- 'Install this checkout’s locked dependencies with npm ci first.'
  exit 1
fi
mkdir -p "$TASK_LOG_DIR"
chmod 700 "$TASK_LOG_DIR"
TASK_OWNER_PID="$(lsof -nP -tiTCP:5173 -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$TASK_OWNER_PID" ]]; then
  TASK_HTML="$(curl --fail --silent --max-time 3 "$TASK_URL" || true)"
  if [[ "$TASK_HTML" != *'name="phrase-study-local"'* ]]; then
    print -u2 -- 'Port 5173 is already in use by another app. This launcher leaves that app running.'
    exit 1
  fi
else
  cd "$TASK_REPO"
  nohup node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort \
    > "$TASK_LOG_DIR/web.log" 2>&1 < /dev/null &
  print -- $! > "$TASK_LOG_DIR/web.pid"
  chmod 600 "$TASK_LOG_DIR/web.log" "$TASK_LOG_DIR/web.pid"
  TASK_READY=false
  for TASK_ATTEMPT in {1..30}; do
    if curl --fail --silent --max-time 1 "$TASK_URL" | /usr/bin/grep -q 'name="phrase-study-local"'; then
      TASK_READY=true
      break
    fi
    sleep 0.2
  done
  if [[ "$TASK_READY" != true ]]; then
    print -u2 -- "The local study page did not start. See $TASK_LOG_DIR/web.log"
    exit 1
  fi
fi
open "$TASK_APP"
open "$TASK_URL"
print -- "Opened local silent phrase study: $TASK_URL"
