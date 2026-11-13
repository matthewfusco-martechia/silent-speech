# Local AirPods phrase study

This fork includes a dedicated, silent study screen at
`http://127.0.0.1:5173/silent-speech/study.html` and a separate **Phrase Motion
Bridge** app. The bridge reads public AirPods motion through
`CMHeadphoneMotionManager`. Its local endpoint has no actions, simulation,
speech, microphone, camera, calendar, or automation features.

Build the bridge once and launch the study from this checkout:

```sh
npm ci --ignore-scripts --no-audit --no-fund
./mac/phrase-study/build.sh
./scripts/launch-phrase-study.sh
```

The launcher starts a loopback-only development server and opens the bridge and
local page. It leaves unrelated applications using port 5173 running. The page
accepts only this dedicated bridge on port 8766. It never loads the original
project's public demo, replay, other people's recordings, or model.

## Take the study

Wear the AirPods and choose them as the Mac's audio output. Allow Motion if
macOS asks. The page enables Start only after fresh real motion arrives. Sit
comfortably with your head supported; keep the AirPods fit unchanged for all
three rounds. If you reseat them, use **Start a separate study**.

The five phrases are:

- Make a note for later
- I need a moment to think
- That sounds good to me
- Please go to the next item
- Let us come back to this tomorrow

Every round mixes these with three controls: rest, a gentle head turn, and a nod.
Control trials should produce no phrase. Cue order is randomized in balanced
blocks. Each take has 1.5 seconds to settle, a one-second quiet baseline, a
four-second action cue, and 0.3 seconds of recovery. Mouth the displayed phrase
once, without sound, then relax. No key holding is needed. A moving baseline is
rejected before revealing the action cue. A disconnect, changed ear, hidden tab,
stalled stream, timing error, or invalid capture pauses on the same cue.

1. **Training:** eight repetitions of each phrase/control, 64 takes, about eight
   minutes. Only these recordings become matcher templates.
2. **Calibration:** two repetitions of each, 16 new takes, about two minutes.
   These select a confidence threshold from a fixed grid. They never become
   templates.
3. **Freeze matcher & prepare final test:** saves the selected threshold and
   training-only model before the first test take.
4. **Final test:** three repetitions of each, 24 fresh takes, about three minutes.
   Predictions receive motion and reporting-ear information, never the cue label.
   Test recordings never retrain the model or alter the threshold.

Pause whenever needed. After reconnecting or restoring a saved study, continue
only with the same fit. Ear locking and the quiet baseline are integrity checks;
they do not establish that the physical AirPods fit is unchanged.

## Saving and results

The page saves each take atomically in a separate IndexedDB database in this
browser on this Mac. Keep using the same browser, profile, and local address.
If saving fails, the cue does not advance: keep the tab open, retry saving, or
export the pending study. A separate study preserves previous records in the
database. **Export study** downloads the current study, raw captures, frozen
model and results for local backup and analysis. Browser data is separate from
the existing Subvox app's profile files. No recording is uploaded.

Final results show correct phrases per attempt, rejected phrases, wrong emitted
phrases, and false phrase outputs on each control. Rejections count as failures.
Calibration can choose reject-all; the screen states that recognition has not
been demonstrated. Passing software tests or receiving live motion does not
demonstrate useful phrase recognition. Compare the fresh final-test results
before expanding the vocabulary or collecting later-day sessions.

## Verification

```sh
npm run typecheck
npm test -- --maxWorkers=2
node node_modules/playwright/cli.js test --config playwright.study.config.ts
node mac/phrase-study/check-wire.mjs
```

Browser tests use invented motion only in disposable test-browser profiles.
Production has no synthetic source or replay option. The wire check reads
connection metadata and checks action rejection; it does not collect labeled
training takes. Live hardware checks must be reported separately from the
software tests and from human recognition results.
