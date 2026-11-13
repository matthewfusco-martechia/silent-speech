// Read-only reproduction using the author's published recordings and the unchanged upstream model.
// node --import tsx scripts/reproduce-public.ts --out ../public-reproduction.json
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clip, Dataset, DtwKnnOptions } from '../web/src/core/contracts';
import { DEFAULT_CHANNELS, NONE } from '../web/src/core/contracts';
import { validateDataset } from '../web/src/core/validate';
import { applyExclude, mergeDatasets, parseExclude } from '../web/src/ml/data';
import { crossValidate, holdOut, type FoldResult } from '../web/src/ml/eval';
import { resolveOpts } from '../web/src/ml/preprocess';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UPSTREAM_REFERENCE = '5c0c84955565e77516ba61d032ce630d6da3ea7d';
const HELP = `Reproduce public AirPods fixed-phrase results; no sensor capture or Mac actions.

Usage: node --import tsx scripts/reproduce-public.ts --out PATH

--out PATH  Required JSON report outside this checkout. Its parent must exist.
            Creates a new owner-only file; refuses to overwrite any existing path.
--help      Show this help without reading recordings.

Uses only bundled data/raw recordings. Does not read personal Subvox data.
Replays saved nested-winning configurations; does NOT rerun their grid search.
See docs/public-reproduction.md for interpretation and original commands.`;

interface SavedPick {
  chans: string;
  L: number;
  band: number;
  norm: 'global' | 'clip';
  k: number;
  budNorm: 'mirror' | 'none';
}
interface SavedNested {
  folds: { test: string; picked: SavedPick[]; accuracy: number }[];
  pooled: { accuracy: number };
}

function outputPath(args: string[]): string | null {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return null;
  if (args.length !== 2 || args[0] !== '--out' || !args[1] || args[1].startsWith('--')) {
    throw new Error('Supply exactly --out PATH, or --help.');
  }
  const out = resolve(args[1]);
  const rel = relative(ROOT, out);
  if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../')) {
    throw new Error('--out must be outside this checkout; repository files are never report targets.');
  }
  if (existsSync(out)) throw new Error(`Refusing to overwrite ${out}`);
  return out;
}

function summarize(rows: FoldResult[]) {
  const sentences = rows.filter((x) => x.label !== NONE);
  const rest = rows.filter((x) => x.label === NONE);
  const correct = rows.filter((x) => x.label === x.predicted).length;
  return {
    count: rows.length, correct, accuracy: rows.length ? correct / rows.length : null,
    thresholds: [0.70, 0.85].map((threshold) => ({
      threshold, sentenceAttempts: sentences.length, restAttempts: rest.length,
      acceptedCorrect: sentences.filter((x) => x.predicted !== NONE && x.confidence >= threshold && x.predicted === x.label).length,
      acceptedWrong: sentences.filter((x) => x.predicted !== NONE && x.confidence >= threshold && x.predicted !== x.label).length,
      restFalseWords: rest.filter((x) => x.predicted !== NONE && x.confidence >= threshold).length,
    })),
  };
}

function main() {
  const out = outputPath(process.argv.slice(2));
  if (out === null) { console.log(HELP); return; }
  const hashes: Record<string, string> = {};
  function load(path: string): unknown {
    const bytes = readFileSync(resolve(ROOT, path));
    hashes[path] = createHash('sha256').update(bytes).digest('hex');
    return JSON.parse(bytes.toString('utf8')) as unknown;
  }
  const files = ['data/raw', 'data/raw/day2'].flatMap((dir) => readdirSync(resolve(ROOT, dir))
    .filter((f) => /^ss-dataset-.*\.json$/.test(f)).sort().map((f) => `${dir}/${f}`));
  const datasets = files.map((path) => {
    const data = load(path);
    const errors = validateDataset(data);
    if (errors.length) throw new Error(`${path}: ${errors.slice(0, 3).join('; ')}`);
    const d = data as Dataset;
    if (d.source !== 'airpods') throw new Error(`${path}: expected public AirPods recordings, not synthetic data`);
    return d;
  });
  const merged = mergeDatasets(datasets);
  if (merged.duplicates) throw new Error('Duplicate public clip IDs; refusing to silently drop recordings.');
  const excluded = applyExclude(merged.clips, parseExclude(load('data/raw/exclude.json')));
  if (excluded.missing.length) throw new Error('The public exclusion list contains IDs absent from the loaded recordings.');
  const clips = excluded.clips;
  const sessions = [...new Set(clips.map((c) => c.session))].sort();
  if (sessions.join(',') !== 's1,s2,s3,s4,s5') throw new Error('This reproduction expects exactly the published s1–s5 sessions.');
  const first = clips.filter((c) => ['s1', 's2', 's3'].includes(c.session!));
  const leftSessions = sessions.filter((s) => clips.filter((c) => c.session === s).every((c) => c.loc === 'left'));
  const left = clips.filter((c) => leftSessions.includes(c.session));

  const defaultThree = summarize(crossValidate(first, {}, 'loso'));
  console.log(`Original three-session default LOSO: ${(100 * defaultThree.accuracy!).toFixed(1)}%`);
  const leftRows = leftSessions.flatMap((s) => holdOut(left.filter((c) => c.session !== s), left.filter((c) => c.session === s), {}));
  const leftOnly = summarize(leftRows);
  console.log(`Left-ear-only five-session LOSO: ${(100 * leftOnly.accuracy!).toFixed(1)}%`);

  const channelSets: Record<string, DtwKnnOptions['channels']> = {
    all: [...DEFAULT_CHANNELS], rr: ['rr.x', 'rr.y', 'rr.z'],
    'rr.yz+ua.yz': ['rr.y', 'rr.z', 'ua.y', 'ua.z'],
  };
  const reference = load('ml/results/dtw-knn/sweep/nested-real.json') as SavedNested;
  if (reference.folds.map((f) => f.test).sort().join(',') !== 's1,s2,s3') throw new Error('Unexpected saved nested folds.');
  const nestedFolds = reference.folds.map((fold) => {
    if (!fold.picked.length) throw new Error(`No saved picks for ${fold.test}`);
    const training = first.filter((c) => c.session !== fold.test);
    const test = first.filter((c) => c.session === fold.test);
    const picks = fold.picked.map(({ chans, ...options }) => {
      const channels = channelSets[chans];
      if (!channels) throw new Error(`Unsupported saved channel set: ${chans}`);
      const opts = resolveOpts({ ...options, channels });
      return { opts, ...summarize(holdOut(training, test, opts)) };
    });
    const correct = picks.reduce((a, p) => a + p.correct, 0) / picks.length;
    return { testSession: fold.test, trainingSessions: [...new Set(training.map((c) => c.session))],
      count: test.length, correct, accuracy: correct / test.length, publishedAccuracy: fold.accuracy, picks };
  });
  const nestedCount = nestedFolds.reduce((a, f) => a + f.count, 0);
  const nestedCorrect = nestedFolds.reduce((a, f) => a + f.correct, 0);
  const savedNested = {
    interpretation: 'Replay of saved per-fold winning configurations only. The 768-config selection search is NOT rerun. Tied configurations are averaged, allowing fractional correct counts.',
    count: nestedCount, correct: nestedCorrect, accuracy: nestedCorrect / nestedCount,
    publishedAccuracy: reference.pooled.accuracy, folds: nestedFolds,
  };
  console.log(`Saved nested-winner replay: ${(100 * savedNested.accuracy).toFixed(1)}% (search not rerun)`);

  function forward(name: string, training: Clip[], test: Clip[]) {
    const row = { name, trainingCount: training.length,
      trainingSessions: [...new Set(training.map((c) => c.session))], testSessions: [...new Set(test.map((c) => c.session))],
      ...summarize(holdOut(training, test, {})) };
    console.log(`${name}: ${(100 * row.accuracy!).toFixed(1)}% (${row.correct}/${row.count})`);
    return row;
  }
  const chronological = ['s4', 's5'].flatMap((s) => {
    const test = clips.filter((c) => c.session === s);
    return [forward(`s1–s3 → ${s}`, first, test),
      forward(`left-only s2+s3 → ${s}`, first.filter((c) => c.loc === 'left'), test)];
  });
  chronological.push(forward('s1–s4 → s5', clips.filter((c) => c.session !== 's5'), clips.filter((c) => c.session === 's5')));

  // Hash the model source actually used, alongside the raw datasets and saved selection table.
  for (const path of ['web/src/ml/index.ts', 'web/src/ml/knn.ts', 'web/src/ml/dtw.ts', 'web/src/ml/preprocess.ts',
    'web/src/ml/eval.ts', 'web/src/ml/data.ts', 'web/src/core/contracts.ts', 'scripts/reproduce-public.ts']) {
    hashes[path] = createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex');
  }
  const report = {
    format: 'silent-speech-public-reproduction', version: 1, generatedAt: new Date().toISOString(),
    source: { repository: 'Spiro-12/silent-speech', upstreamReference: UPSTREAM_REFERENCE,
      checkoutHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), hashes },
    data: { description: 'Only the author’s published recordings; no current-user data or live capture.',
      recorded: merged.clips.length, excluded: excluded.excluded, retained: clips.length, sessions },
    options: resolveOpts({}), defaultThreeSessionLoso: defaultThree, leftEarOnlyLoso: leftOnly,
    savedNestedWinnerReplay: savedNested, chronological,
    limitations: [
      'One person, seven distinct complete sentences plus rest, controlled posture, Spacebar segmentation, five sessions across two days.',
      'Default options were tuned on s1–s3. The 0.70 threshold was selected after inspecting all five sessions; it is descriptive, not independent calibration.',
      'Chronological analysis reuses already published and inspected development data, not newly collected untouched final tests.',
      'Zero false words in a small number of rest clips does not establish a low continuous-use false-activation rate.',
    ],
  };
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Created report: ${out}`);
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
