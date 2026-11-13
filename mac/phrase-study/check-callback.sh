#!/bin/zsh
set -euo pipefail
TASK_SPEC_DIR="${0:A:h}"
TASK_REPO="${TASK_SPEC_DIR:h:h}"
TASK_CHECK="${TASK_REPO:h}/phrase-study-callback-check"
TASK_CACHE="${TASK_REPO:h}/phrase-study-callback-cache"
mkdir -p "$TASK_CACHE"
xcrun swiftc -swift-version 6 -strict-concurrency=complete -parse-as-library -module-cache-path "$TASK_CACHE" \
  "$TASK_SPEC_DIR/Sources/HeadphoneReading.swift" \
  "$TASK_SPEC_DIR/Sources/MotionCallback.swift" \
  "$TASK_SPEC_DIR/Tests/MotionCallbackCheck.swift" \
  -o "$TASK_CHECK"
"$TASK_CHECK"
