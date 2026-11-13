# Comparing Subvox recordings with this matcher

This fork starts from Spiro-12/silent-speech at
`5c0c84955565e77516ba61d032ce630d6da3ea7d`. The upstream motion preprocessing,
DTW matching, and confidence calculation are unchanged.

The offline adapter reads a Subvox dataset/profile JSON and passes the recorded
rotation rate (rad/s) and user acceleration (g) directly to the upstream matcher.
It never opens a microphone, camera, motion stream, browser, or action bridge.
Processing and reports stay on the local computer. It does not update Subvox's
recordings, training roles, profiles, calibrations, or installed app.

```sh
npm ci --ignore-scripts --no-audit --no-fund
node --import tsx scripts/compare-subvox.ts \
  --dataset /absolute/path/to/subvox-profile.json \
  --out .local-research/new-comparison.json
```

The output path must not exist. Reports are written with owner-only file access.
Do not put personal recordings in `data/raw/`: those files are the original
author's already published recordings, and that directory is tracked by Git.
`.local-research/` is ignored; keeping private data outside the checkout is also
supported. Publishing this fork does not authorize uploading anyone's recordings.

The two configurations are fixed before evaluation: upstream defaults and a
rotation-only ablation. Neither selects parameters using the reported test clips.
The adapter reports the earlier untagged legacy batch versus the guided batch
in both directions. Those are development batch comparisons; absent metadata
cannot establish independent days, AirPods fits, or which ear supplied motion.
All clips therefore use `loc: unknown`, with no inferred axis mirroring.

For timed training, complete rounds need at least three takes of every vocabulary
word and each control (rest, head turn, nod). Exact leave-one-out fits normalization,
reference distance, and templates anew using only the other training takes.
This avoids the upstream large-dataset LOO confidence approximation. Each complete
round is reported separately. Partial rounds, calibration takes, and final tests
are not repurposed. No timed held-out accuracy is claimed by this script.

All controls map to the upstream `none` label, while false word outputs are counted
by control subtype. Reports distinguish top-1 guesses, correct emitted words per
attempt, rejection, precision, and control false words. The borrowed confidence
threshold is **not calibrated** for a new person. Zero false words on a handful of
controls does not establish low idle false activation.

Malformed streams, duplicate IDs/content, train/test overlap, mixed fit/profile
contexts, and missing training classes stop the comparison. This is a capture
integrity check, not an exclusion based on recognition success.
Adjacent legacy captures can share pre-roll within a batch. Those recordings
remain intact and the overlap count is reported; a shared window crossing from
training to test is rejected.

The original project recognizes whole fixed sentences from one person. A result
on short Subvox words is a different task and must not be presented as reproducing
its reported sentence accuracy. Fresh calibration and a frozen forward test are
still needed before choosing a matcher for live use.
