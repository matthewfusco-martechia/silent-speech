# Reproducing the public AirPods results

The fork adds a read-only runner for the author's published motion recordings. It uses the upstream model unchanged, reads no personal Subvox data, starts no sensor capture, and runs no Mac actions.

Run from the checkout, after `npm ci`:

```sh
node --import tsx scripts/reproduce-public.ts --help
node --import tsx scripts/reproduce-public.ts --out ../public-reproduction.json
```

`--out` is required. Choose a new file outside the checkout, with an existing parent directory. The runner creates it with owner-only permissions and refuses to overwrite an existing path. The report contains aggregate scores, recording and source hashes, model options, and the checkout commit. Raw motion is not copied into it. It needs no network access after dependencies are installed.

## Results reproduced on 13 November 2026

Model/data reference: upstream commit `5c0c84955565e77516ba61d032ce630d6da3ea7d`. The data contains 600 recorded takes from one person; the author's exclusion list removes 18 mislabeled rest takes, leaving 582. The task is seven predefined whole sentences plus rest, recorded across five sessions on two days with AirPods Pro 3, controlled head posture, and Spacebar segmentation.

| Evaluation | Reproduced result | Interpretation |
|---|---:|---|
| Original three-session LOSO with upstream defaults | 94.2% | Those sessions also selected the default options. |
| Left-ear-only LOSO across the four left-ear sessions | 97.3% (464/477) | Includes sessions used during tuning and later sessions sharing a recording day. |
| Saved nested-winning options, replayed on their held-out folds | 88.2% (301.5/342) | Exactly matches the saved report, but the 768-configuration selection search was **not rerun**. Fractional counts average two tied configurations. |

At the 0.70 threshold, the left-ear-only model correctly emits a sentence on 345/420 attempts (82.1%), with zero accepted wrong sentence labels and zero accepted words from 57 rest clips. That threshold was chosen after inspecting all five sessions, so these are descriptive results rather than independent threshold calibration. [Original results](results.md) and [technical report](technical-report.md) explain the task and other limitations.

## Earlier-day training only

The additional chronological comparison fixes the upstream defaults, trains on sessions 1–3 only, and scores both next-day sessions without training on either:

| Training | Test | Top label correct | Correct sentence outputs at the default 0.85 threshold |
|---|---|---:|---:|
| s1–s3 | s4 | 98/120 (81.7%) | 59/105 (56.2%) |
| s1–s3 | s5 | 103/120 (85.8%) | 60/105 (57.1%) |
| s1–s4 | s5 | 118/120 (98.3%) | 56/105 (53.3%) |

Each row has zero accepted wrong sentence labels and zero accepted words from 15 rest clips. Adding same-day s4 training substantially improves the top-label accuracy on s5, while the confidence gate remains conservative. Top-label accuracy includes rest; the output column counts all 105 sentence attempts, including rejections in its denominator.

These are additional analyses of already published, previously inspected development recordings. They are not newly collected untouched final tests. Zero observed false words in a small rest sample cannot establish safe continuous operation. The results support a reproducible fixed-phrase signal for this author; they do not establish recognition on another person, similar short words, normal movement, or unrestricted silent dictation.

## Original upstream commands

The original scripts remain unchanged. These commands reproduce their scoring directly without writing tracked result files:

```sh
node --import tsx scripts/eval-dtw.ts data/raw/ss-dataset-*.json --exclude data/raw/exclude.json --protocol loso --no-write
node --import tsx scripts/five-session-analysis.ts data/raw/ss-dataset-*.json data/raw/day2/ss-dataset-*.json --exclude data/raw/exclude.json
```

To rerun the full nested hyperparameter selection rather than replay saved winners, use the upstream command below. It is substantially more expensive; `--work-dir` allows resumption. Output and progress paths stay outside the checkout:

```sh
node --import tsx scripts/eval-dtw.ts data/raw/ss-dataset-*.json --exclude data/raw/exclude.json --nested --jobs 2 --work-dir ../nested-public-progress --json ../nested-public.json
```

The new runner's saved-winner replay checks scoring of the published selections. It does not independently validate the original selection search.
