#!/bin/zsh
set -euo pipefail
TASK_SPEC_DIR="${0:A:h}"
TASK_REPO="${TASK_SPEC_DIR:h:h}"
TASK_BUILD="${TASK_REPO:h}/phrase-study-build"
cd "$TASK_SPEC_DIR"
xcodegen generate
xcodebuild -project PhraseMotionBridge.xcodeproj -scheme PhraseMotionBridge -configuration Debug \
  -derivedDataPath "$TASK_BUILD" CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= build
printf '\nBuilt %s\n' "$TASK_BUILD/Build/Products/Debug/PhraseMotionBridge.app"
