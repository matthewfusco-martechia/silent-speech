/** Offline comparison against the unchanged upstream matcher. Never opens a sensor or runs an action. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DtwKnnOptions } from '../web/src/core/contracts';
import { crossValidate, holdOut, type FoldResult } from '../web/src/ml/eval';
import { resolveOpts } from '../web/src/ml/preprocess';
import { adaptSubvox, assertIndependent, balancedTimedRounds, type SubvoxClip } from './lib/subvox';

type Counts = Record<string, number>;
const root = fileURLToPath(new URL('..', import.meta.url));
const count = (values: string[]): Counts => values.reduce<Counts>((out, key) => {
  out[key] = (out[key] ?? 0) + 1;
  return out;
}, Object.create(null) as Counts);
const ratio = (n: number, d: number): number | null => d ? n / d : null;

export function summarize(clips: SubvoxClip[], predictions: FoldResult[]) {
  if (clips.length !== predictions.length) throw new Error('Incomplete prediction set');
  let correct = 0, wordN = 0, wordTop1 = 0, accepted = 0, wordAcceptedCorrect = 0;
  let wordWrongAccepted = 0, wordRejected = 0;
  const controls: Record<string, { attempts: number; falseWords: number }> = {};
  const top1Confusion: Record<string, Counts> = Object.create(null), emittedConfusion: Record<string, Counts> = Object.create(null);
  clips.forEach((clip, i) => {
    const p = predictions[i];
    if (clip.id !== p.id || clip.label !== p.label) throw new Error('Prediction alignment mismatch');
    const truth = clip.kind === 'word' ? clip.label : `control:${clip.kind}`;
    for (const [table, predicted] of [[top1Confusion, p.predicted], [emittedConfusion, p.accepted ? p.predicted : 'rejected']] as const) {
      table[truth] ??= Object.create(null) as Counts;
      table[truth][predicted] = (table[truth][predicted] ?? 0) + 1;
    }
    if (p.predicted === clip.label) correct++;
    if (p.accepted) accepted++;
    if (clip.kind === 'word') {
      wordN++;
      if (p.predicted === clip.label) wordTop1++;
      if (!p.accepted) wordRejected++;
      else if (p.predicted === clip.label) wordAcceptedCorrect++;
      else wordWrongAccepted++;
    } else {
      controls[clip.kind] ??= { attempts: 0, falseWords: 0 };
      controls[clip.kind].attempts++;
      if (p.accepted) controls[clip.kind].falseWords++;
    }
  });
  return {
    attempts: clips.length, labelCounts: count(clips.map(c => c.label)),
    top1Correct: correct, top1Accuracy: ratio(correct, clips.length),
    words: { attempts: wordN, top1Correct: wordTop1, top1Accuracy: ratio(wordTop1, wordN),
      acceptedCorrect: wordAcceptedCorrect, correctPerAttempt: ratio(wordAcceptedCorrect, wordN),
      wrongAccepted: wordWrongAccepted, rejected: wordRejected },
    controls, acceptedOutputs: accepted,
    acceptedPrecisionIncludingControls: ratio(wordAcceptedCorrect, accepted),
    outputCoverage: ratio(accepted, clips.length), top1Confusion, emittedConfusion,
  };
}

export function requireCoverage(train: SubvoxClip[], test: SubvoxClip[]): void {
  const counts = count(train.map(c => c.label));
  if (Object.keys(counts).length < 2) throw new Error('Training needs at least two labels');
  if (test.some(c => (counts[c.label] ?? 0) < 2)) {
    throw new Error('Every tested label needs at least two independent training examples');
  }
}

function fixedSplit(name: string, training: SubvoxClip[], test: SubvoxClip[], opts: DtwKnnOptions) {
  assertIndependent(training, test);
  requireCoverage(training, test);
  return {
    name, protocol: 'fixed batch holdout', trainingCount: training.length,
    trainingLabelCounts: count(training.map(c => c.label)),
    caveat: 'Reused development recordings. Batch boundaries do not establish a different day, ear, or AirPods fit.',
    ...summarize(test, holdOut(training, test, opts)),
  };
}

function exactLoo(name: string, clips: SubvoxClip[], opts: DtwKnnOptions) {
  // Preflight every fold before upstream preprocessing, which otherwise deduplicates timestamps and IDs.
  clips.forEach((clip, i) => {
    const training = clips.filter((_, j) => i !== j);
    assertIndependent(training, [clip]);
    requireCoverage(training, [clip]);
  });
  return {
    name, protocol: 'exact leave one training take out', trainingCountPerFold: clips.length - 1,
    caveat: 'Training diagnostic only; captures from the same round and fit. All controls share the none label.',
    ...summarize(clips, crossValidate(clips, opts, 'loo', true)),
  };
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node --import tsx scripts/compare-subvox.ts --dataset /path/profile.json --out /private/new-report.json');
    return;
  }
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--dataset', '--out'].includes(key) || !value || value.startsWith('--') || values[key]) {
      throw new Error('Use --dataset PATH and --out PATH once each');
    }
    values[key] = value;
  }
  if (!values['--dataset'] || !values['--out']) throw new Error('Both --dataset and --out are required; use --help');
  const inputPath = resolve(values['--dataset']), outputPath = resolve(values['--out']);
  if (inputPath === outputPath) throw new Error('Output cannot replace the input dataset');
  const bytes = readFileSync(inputPath);
  const data = adaptSubvox(JSON.parse(bytes.toString('utf8')));
  // Options are declared before seeing these results; no search or threshold fitting on the personal recordings.
  const variants = [
    { name: 'upstream-default', options: resolveOpts() },
    { name: 'rotation-only-ablation', options: resolveOpts({ channels: ['rr.x', 'rr.y', 'rr.z'] }) },
  ];
  const earlier = data.legacy.filter(c => !c.hasSession), guided = data.legacy.filter(c => c.hasSession);
  const completeRounds = balancedTimedRounds(data.timedTraining, data.vocabulary);
  const results: unknown[] = [], unavailable: string[] = [];
  for (const variant of variants) {
    const runs: unknown[] = [];
    if (earlier.length && guided.length) {
      runs.push(fixedSplit('earlier-to-guided', earlier, guided, variant.options));
      runs.push(fixedSplit('guided-to-earlier', guided, earlier, variant.options));
    } else unavailable.push(`${variant.name}: no earlier/guided batch split available`);
    for (let i = 0; i < completeRounds.length; i++) {
      runs.push(exactLoo(`complete-timed-training-round-${i + 1}`, completeRounds[i], variant.options));
    }
    if (!completeRounds.length) unavailable.push(`${variant.name}: no complete balanced timed training round`);
    results.push({ variant: variant.name, options: variant.options, runs });
  }
  const report = {
    format: 'subvox-upstream-comparison', version: 1, generatedAt: new Date().toISOString(),
    source: {
      upstreamRepository: 'Spiro-12/silent-speech', upstreamReference: '5c0c84955565e77516ba61d032ce630d6da3ea7d',
      checkoutHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      hashes: Object.fromEntries(['web/src/ml/index.ts', 'web/src/ml/knn.ts', 'web/src/ml/dtw.ts',
        'web/src/ml/preprocess.ts', 'web/src/ml/eval.ts', 'web/src/core/contracts.ts',
        'scripts/compare-subvox.ts', 'scripts/lib/subvox.ts'].map(path =>
        [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')])),
    },
    sourceDatasetSHA256: createHash('sha256').update(bytes).digest('hex'),
    interpretation: 'Exploratory development comparison, not an independent final test. No model selection, threshold calibration, or app change.',
    input: { legacyTakes: data.legacy.length, timedTrainingTrials: data.timedTraining.length,
      timedRoleCounts: data.roleCounts, completeTimedTrainingRounds: completeRounds.length },
    warnings: [
      'Ear location was not stored by Subvox. Every clip uses unknown; no axis mirroring is inferred.',
      'Upstream confidence threshold 0.85 was learned on another person and is not calibrated to these recordings.',
      'Timed rest, head-turn, and nod controls become none; subtype false words are reported separately.',
      'Raw action windows are passed unchanged. No Subvox trimming, baseline subtraction, or recovery samples are added.',
      'Top-1 includes rejected guesses. Correct words per attempt includes rejection failures.',
      ...data.warnings,
    ],
    unavailable, results,
  };
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  // Exclusive creation prevents accidentally replacing any existing recording or report.
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output: outputPath, input: report.input, results }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(`Comparison failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
