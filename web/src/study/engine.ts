import type { BudLocation, Clip, DtwKnnModelJSON, MotionSample, Prediction } from '../core/contracts';
import { NONE } from '../core/contracts';
import { shuffle } from '../core/rng';
import { loadModel, train } from '../ml/index';
import { DEFAULT_OPTS } from '../ml/preprocess';

export type Phase = 'training' | 'calibration' | 'test';
export type PromptKind = 'phrase' | 'rest' | 'headTurn' | 'nod';
export interface Prompt { id: string; kind: PromptKind; text: string; label: string }
export interface Capture {
  id: string; phase: Phase; promptId: string; createdAt?: string;
  locStart: BudLocation; locEnd: BudLocation;
  connectionStart: number; connectionEnd: number; liveReal: boolean;
  baseline: MotionSample[]; action: MotionSample[]; recovery: MotionSample[];
  baselineStart: number; actionStart: number; recoveryStart: number; end: number;
}
export interface StudyTrial {
  id: string; phase: Phase; promptId: string; label: string; kind: PromptKind;
  loc: BudLocation; createdAt: string; capture: Capture;
  prediction?: Prediction; frozenId?: string;
}
export interface FrozenStudy {
  id: string; createdAt: string; studyId: string; loc: BudLocation;
  trainingIds: string[]; calibrationIds: string[];
  /** Exact canonical action-input manifest, not a security hash or a fitted test statistic. */
  sourceSignature: string;
  model: DtwKnnModelJSON; threshold: number;
  calibration: StudyReport;
}
export interface Study {
  version: 1; id: string; name: string; createdAt: string; phrases: Prompt[];
  plans: Record<Phase, string[]>; clips: StudyTrial[]; loc?: BudLocation; frozen?: FrozenStudy;
}
export interface StudyReport {
  phase: Phase; attempts: number; phraseAttempts: number; phraseTop1Correct: number;
  phraseCorrect: number; phraseWrongAccepted: number; phraseRejected: number;
  phraseAccuracy: number | null; phraseTop1Accuracy: number | null;
  controlAttempts: number; controlFalseWords: number; controlSpecificity: number | null;
  byControl: Record<string, { attempts: number; falseWords: number }>;
  acceptedPrecision: number | null; top1Correct: number; top1Accuracy: number | null;
  confusion: Record<string, Record<string, number>>;
  threshold: number; interpretation: string;
}
export const REPETITIONS: Record<Phase, number> = { training: 8, calibration: 2, test: 3 };
export const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.01] as const;
export const DEFAULT_PHRASES: readonly Prompt[] = [
  { id: 'p1', kind: 'phrase', text: 'Make a note for later', label: 'p1' },
  { id: 'p2', kind: 'phrase', text: 'I need a moment to think', label: 'p2' },
  { id: 'p3', kind: 'phrase', text: 'That sounds good to me', label: 'p3' },
  { id: 'p4', kind: 'phrase', text: 'Please go to the next item', label: 'p4' },
  { id: 'p5', kind: 'phrase', text: 'Let us come back to this tomorrow', label: 'p5' },
];
export const CONTROLS: readonly Prompt[] = [
  { id: 'rest', kind: 'rest', text: 'Rest. Keep your mouth closed and stay still.', label: NONE },
  { id: 'headTurn', kind: 'headTurn', text: 'Gently turn your head left and back. Do not mouth a phrase.', label: NONE },
  { id: 'nod', kind: 'nod', text: 'Nod once and return to center. Do not mouth a phrase.', label: NONE },
];

const PHASES: Phase[] = ['training', 'calibration', 'test'];
const LOCATIONS: BudLocation[] = ['left', 'right', 'default', 'unknown'];
const copy = <T>(v: T): T => structuredClone(v);
const ratio = (n: number, d: number): number | null => d ? n / d : null;
const prompts = (s: Study): Prompt[] => [...s.phrases, ...CONTROLS];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function createStudy(name = 'My phrase study', rng: () => number = Math.random): Study {
  const ids = [...DEFAULT_PHRASES, ...CONTROLS].map(p => p.id);
  const plans = {} as Record<Phase, string[]>;
  for (const phase of PHASES) {
    plans[phase] = [];
    for (let i = 0; i < REPETITIONS[phase]; i++) {
      const block = shuffle(ids, rng);
      if (block[0] === plans[phase].at(-1)) [block[0], block[1]] = [block[1], block[0]];
      plans[phase].push(...block);
    }
  }
  return { version: 1, id: crypto.randomUUID(), name: name.trim() || 'My phrase study',
    createdAt: new Date().toISOString(), phrases: copy([...DEFAULT_PHRASES]), plans, clips: [] };
}

export function promptById(study: Study, id: string): Prompt {
  const p = prompts(study).find(p => p.id === id);
  if (!p) throw new Error('Unknown study prompt');
  return p;
}

export function phaseProgress(study: Study, phase: Phase) {
  const byPrompt = Object.fromEntries(prompts(study).map(p => [p.id, 0]));
  const clips = study.clips.filter(c => c.phase === phase);
  for (const c of clips) byPrompt[c.promptId]++;
  return { done: clips.length, total: study.plans[phase].length, byPrompt };
}

export const counts = (study: Study, phase: Phase) => phaseProgress(study, phase).byPrompt;

export function phaseOf(study: Study): Phase | 'complete' {
  if (phaseProgress(study, 'training').done < study.plans.training.length) return 'training';
  if (!study.frozen) return 'calibration';
  return phaseProgress(study, 'test').done < study.plans.test.length ? 'test' : 'complete';
}

export function nextPrompt(study: Study): Prompt | null {
  const phase = phaseOf(study);
  if (phase === 'complete') return null;
  const id = study.plans[phase][phaseProgress(study, phase).done];
  return id ? promptById(study, id) : null;
}

function validSample(s: MotionSample): boolean {
  return !!s && Number.isInteger(s.seq) && s.seq >= 0 && Number.isFinite(s.t) &&
    [s.rr, s.ua].every(v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) &&
    Array.isArray(s.q) && s.q.length === 4 && s.q.every(Number.isFinite) &&
    (s.g === undefined || (Array.isArray(s.g) && s.g.length === 3 && s.g.every(Number.isFinite)));
}

/** Integrity and pre-cue quietness only. No attempt is excluded for a weak action signal. */
export function validateCapture(c: Capture): string | null {
  if (!c || !c.liveReal) return 'A live AirPods motion stream is required. Simulated or replay data cannot be recorded.';
  if (!LOCATIONS.includes(c.locStart) || c.locStart !== c.locEnd) return 'The reporting AirPod changed. Retry after checking the fit.';
  if (!Number.isInteger(c.connectionStart) || c.connectionStart !== c.connectionEnd) return 'The AirPods connection changed during the take. Retry this cue.';
  const bounds = [c.baselineStart, c.actionStart, c.recoveryStart, c.end];
  if (!bounds.every(Number.isFinite) || bounds.some((v, i) => i > 0 && v <= bounds[i - 1])) return 'Invalid capture timing. Retry this cue.';
  const durations = [c.actionStart - c.baselineStart, c.recoveryStart - c.actionStart, c.end - c.recoveryStart];
  if (durations[0] < 0.8 || durations[0] > 1.3 || durations[1] < 3.8 || durations[1] > 4.3 || durations[2] < 0.2 || durations[2] > 0.6) {
    return 'The timed windows were interrupted. Retry this cue.';
  }
  const windows = [c.baseline, c.action, c.recovery];
  for (let w = 0; w < windows.length; w++) {
    const samples = windows[w];
    if (!Array.isArray(samples) || samples.length < 3 || !samples.every(validSample)) return 'Missing or invalid AirPods readings. Retry this cue.';
    const first = samples[0], last = samples.at(-1)!;
    if (first.t < bounds[w] || last.t >= bounds[w + 1] || first.t - bounds[w] > 0.15 || bounds[w + 1] - last.t > 0.15) {
      return 'Part of the timed motion window is missing. Retry this cue.';
    }
    if ((samples.length - 1) / (last.t - first.t) < 15) return 'The motion sample rate is too low. Reconnect the AirPods and retry.';
  }
  const samples = windows.flat();
  for (let i = 1; i < samples.length; i++) {
    const gap = samples[i].t - samples[i - 1].t;
    if (!(gap > 0 && gap <= 0.2) || samples[i].seq <= samples[i - 1].seq) return 'The motion stream skipped or repeated readings. Retry this cue.';
  }
  const rms = (key: 'rr' | 'ua') => Math.sqrt(c.baseline.reduce((sum, s) => sum + s[key].reduce((a, x) => a + x * x, 0), 0) / c.baseline.length);
  if (rms('rr') > 0.12 || rms('ua') > 0.04) return 'The resting baseline was moving. Relax your jaw and hold your head still before the next cue.';
  return null;
}

function actionIdentity(c: Capture): string {
  const t0 = c.action[0].t;
  return JSON.stringify(c.action.map(s => [Math.round((s.t - t0) * 1e6) / 1e6, ...s.rr, ...s.ua]));
}

function independent(clips: StudyTrial[]): void {
  const ids = new Set<string>(), content = new Set<string>();
  for (const c of clips) {
    if (ids.has(c.id)) throw new Error('A take ID was reused. Nothing was saved.');
    const identity = actionIdentity(c.capture);
    if (content.has(identity)) throw new Error('This motion take was already recorded. Nothing was saved.');
    ids.add(c.id); content.add(identity);
  }
  const sorted = clips.slice().sort((a, b) => a.capture.action[0].t - b.capture.action[0].t);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].capture.action[0].t <= sorted[i - 1].capture.action.at(-1)!.t) throw new Error('Recorded motion windows overlap. Start a new study after a clock restart.');
  }
}

const modelClips = (s: Study, phase: Phase): Clip[] => s.clips.filter(c => c.phase === phase)
  .map(c => ({ id: c.id, label: c.label, samples: c.capture.action, session: `${s.id}:${phase}`, loc: c.loc }));

function sourceSignature(s: Study): string {
  return JSON.stringify({ id: s.id, phrases: s.phrases, loc: s.loc,
    clips: s.clips.filter(c => c.phase !== 'test').map(c => ({ id: c.id, phase: c.phase, promptId: c.promptId, capture: c.capture })) });
}

function scoreTrials(trials: StudyTrial[], threshold: number, phase: Phase): StudyReport {
  let phraseAttempts = 0, phraseTop1Correct = 0, phraseCorrect = 0, phraseWrongAccepted = 0, phraseRejected = 0;
  let controlAttempts = 0, controlFalseWords = 0, top1Correct = 0;
  const byControl: StudyReport['byControl'] = Object.create(null);
  const confusion: StudyReport['confusion'] = Object.create(null);
  for (const trial of trials) {
    const p = trial.prediction;
    if (!p) throw new Error('A scored take has no frozen prediction');
    const accepted = p.label !== NONE && p.confidence >= threshold;
    const truth = trial.kind === 'phrase' ? trial.label : `control:${trial.kind}`;
    const output = accepted ? p.label : 'rejected';
    confusion[truth] ??= Object.create(null);
    confusion[truth][output] = (confusion[truth][output] ?? 0) + 1;
    if (p.label === trial.label) top1Correct++;
    if (trial.kind === 'phrase') {
      phraseAttempts++;
      if (p.label === trial.label) phraseTop1Correct++;
      if (!accepted) phraseRejected++;
      else if (p.label === trial.label) phraseCorrect++;
      else phraseWrongAccepted++;
    } else {
      controlAttempts++;
      byControl[trial.kind] ??= { attempts: 0, falseWords: 0 };
      byControl[trial.kind].attempts++;
      if (accepted) { controlFalseWords++; byControl[trial.kind].falseWords++; }
    }
  }
  return { phase, attempts: trials.length, phraseAttempts, phraseTop1Correct, phraseCorrect, phraseWrongAccepted, phraseRejected,
    phraseAccuracy: ratio(phraseCorrect, phraseAttempts), phraseTop1Accuracy: ratio(phraseTop1Correct, phraseAttempts),
    controlAttempts, controlFalseWords, controlSpecificity: ratio(controlAttempts - controlFalseWords, controlAttempts), byControl,
    acceptedPrecision: ratio(phraseCorrect, phraseCorrect + phraseWrongAccepted + controlFalseWords), top1Correct,
    top1Accuracy: ratio(top1Correct, trials.length), confusion, threshold,
    interpretation: phase === 'calibration' ? 'Calibration data selected this threshold; these are not final-test results.' :
      'Fresh test takes only. Correct phrase rate includes rejections; small control samples do not establish an idle false-activation rate.' };
}

function selectThreshold(calibration: StudyTrial[]): StudyReport {
  let best: StudyReport | null = null;
  for (const threshold of THRESHOLDS) {
    const candidate = scoreTrials(calibration, threshold, 'calibration');
    const balanced = ((candidate.phraseAccuracy ?? 0) + (candidate.controlSpecificity ?? 0)) / 2;
    const current = best ? ((best.phraseAccuracy ?? 0) + (best.controlSpecificity ?? 0)) / 2 : -1;
    if (!best || balanced > current + 1e-12 || (Math.abs(balanced - current) <= 1e-12 &&
      (candidate.controlFalseWords < best.controlFalseWords || (candidate.controlFalseWords === best.controlFalseWords && candidate.phraseWrongAccepted < best.phraseWrongAccepted)))) best = candidate;
  }
  // If nothing beats reject-all's balanced score, choose reject-all explicitly.
  if (!best || ((best.phraseAccuracy ?? 0) + (best.controlSpecificity ?? 0)) / 2 <= 0.5 + 1e-12) return scoreTrials(calibration, 1.01, 'calibration');
  return best;
}

function validateStudy(s: Study, checkFrozen = true): void {
  if (!s || s.version !== 1 || typeof s.id !== 'string' || !s.id || typeof s.name !== 'string' || !s.name.trim() ||
    !Number.isFinite(Date.parse(s.createdAt)) || !same(s.phrases, DEFAULT_PHRASES) || !Array.isArray(s.clips) || !s.plans) {
    throw new Error('Saved phrase study is invalid. Export it before starting a new study; it has not been replaced.');
  }
  const expectedIds = prompts(s).map(p => p.id).sort();
  for (const phase of PHASES) {
    const plan = s.plans[phase];
    if (!Array.isArray(plan) || plan.length !== expectedIds.length * REPETITIONS[phase]) throw new Error('Saved study prompt plan is invalid');
    for (let i = 0; i < plan.length; i += expectedIds.length) {
      if (!same(plan.slice(i, i + expectedIds.length).sort(), expectedIds)) throw new Error('Saved study prompt blocks are unbalanced');
    }
  }
  const seen = { training: 0, calibration: 0, test: 0 };
  let lastPhaseIndex = 0;
  for (const c of s.clips) {
    if (!c || !PHASES.includes(c.phase) || typeof c.id !== 'string' || !c.id || !Number.isFinite(Date.parse(c.createdAt))) throw new Error('Invalid saved take');
    const phaseIndex = PHASES.indexOf(c.phase);
    if (phaseIndex < lastPhaseIndex || PHASES.slice(0, phaseIndex).some(p => seen[p] !== s.plans[p].length)) throw new Error('Saved recording phases are out of order');
    lastPhaseIndex = phaseIndex;
    if (s.plans[c.phase][seen[c.phase]++] !== c.promptId) throw new Error('Saved take does not match its planned cue');
    const p = promptById(s, c.promptId);
    if (c.label !== p.label || c.kind !== p.kind || !c.capture || c.capture.id !== c.id || c.capture.phase !== c.phase || c.capture.promptId !== c.promptId) throw new Error('Saved take provenance is invalid');
    if (validateCapture(c.capture)) throw new Error('A saved motion take is invalid');
    if (c.loc !== c.capture.locStart || c.loc !== s.loc) throw new Error('Saved takes mix reporting AirPods. Start a separate study for another fit.');
    if (c.phase !== 'test' && (c.prediction !== undefined || c.frozenId !== undefined)) throw new Error('Training/calibration takes contain unexpected test results');
  }
  if (s.loc !== undefined && !LOCATIONS.includes(s.loc)) throw new Error('Invalid saved sensor location');
  if (s.clips.length && !s.loc) throw new Error('Saved study has no reporting AirPod');
  independent(s.clips);
  if (s.frozen) {
    const f = s.frozen;
    if (seen.training !== s.plans.training.length || seen.calibration !== s.plans.calibration.length ||
      typeof f.id !== 'string' || !f.id || f.studyId !== s.id || f.loc !== s.loc || !Number.isFinite(Date.parse(f.createdAt)) ||
      !THRESHOLDS.includes(f.threshold as typeof THRESHOLDS[number]) ||
      !same(f.trainingIds, s.clips.filter(c => c.phase === 'training').map(c => c.id)) ||
      !same(f.calibrationIds, s.clips.filter(c => c.phase === 'calibration').map(c => c.id)) ||
      f.sourceSignature !== sourceSignature(s) || f.model?.opts?.threshold !== f.threshold) throw new Error('Frozen model no longer matches its source recordings');
    if (checkFrozen) {
      // Reconstruct from training inputs alone. A modified cache cannot silently change the frozen model.
      const rebuilt = train(modelClips(s, 'training'), { threshold: f.threshold });
      if (!same(rebuilt.toJSON(), f.model)) throw new Error('Saved frozen model differs from its training recordings');
      const model = loadModel(f.model);
      // The upstream unsafe-model fallback caps confidence at threshold/2. Replay
      // calibration with the same original default gate used during selection;
      // a selected reject-all gate must not alter the scores used to select it.
      const calibrationModel = loadModel({ ...f.model, opts: { ...f.model.opts, threshold: DEFAULT_OPTS.threshold } });
      const calibration = s.clips.filter(c => c.phase === 'calibration').map(c => ({ ...c,
        prediction: calibrationModel.predict(c.capture.action, { loc: c.loc }) }));
      if (!same(selectThreshold(calibration), f.calibration) || f.calibration.threshold !== f.threshold) throw new Error('Saved calibration result differs from its frozen source recordings');
      for (const c of s.clips.filter(c => c.phase === 'test')) {
        const p = model.predict(c.capture.action, { loc: c.loc });
        if (c.frozenId !== f.id || !c.prediction || p.label !== c.prediction.label || p.confidence !== c.prediction.confidence || p.accepted !== c.prediction.accepted || !same(p.top, c.prediction.top)) {
          throw new Error('Saved final-test result does not match the frozen model');
        }
      }
    }
  } else if (seen.test) throw new Error('Final-test takes exist without a frozen model');
}

/** Validate before using persisted data. Invalid data is never replaced by an empty study. */
export function parseStudy(value: unknown): Study {
  const s = copy(value) as Study;
  validateStudy(s);
  return s;
}

/** Returns a candidate snapshot. The UI must persist it successfully before adopting it. */
export function recordTrial(study: Study, capture: Capture): Study {
  validateStudy(study);
  const reason = validateCapture(capture);
  if (reason) throw new Error(reason);
  const phase = phaseOf(study), prompt = nextPrompt(study);
  if (phase === 'complete' || !prompt || capture.phase !== phase || capture.promptId !== prompt.id) throw new Error('This take does not match the current study phase and cue');
  if (study.loc !== undefined && study.loc !== capture.locStart) throw new Error('The reporting AirPod changed. Start a new study or restore the original fit.');
  const s = copy(study);
  s.loc ??= capture.locStart;
  const c: StudyTrial = { id: capture.id, phase: capture.phase, promptId: prompt.id, label: prompt.label, kind: prompt.kind,
    loc: capture.locStart, createdAt: capture.createdAt ?? new Date().toISOString(), capture: copy(capture) };
  if (phase === 'test') {
    if (!s.frozen) throw new Error('Freeze calibration before testing');
    c.frozenId = s.frozen.id;
    c.prediction = loadModel(s.frozen.model).predict(c.capture.action, { loc: c.loc });
  }
  s.clips.push(c);
  validateStudy(s, false);
  return s;
}

/** Fits training only, selects one threshold on calibration only, then seals both before the first test. */
export function freezeCalibration(study: Study): Study {
  validateStudy(study);
  if (study.frozen || phaseOf(study) !== 'calibration' || nextPrompt(study) !== null || !study.loc) throw new Error('Complete a separate calibration round before freezing the model');
  const training = modelClips(study, 'training');
  const model = train(training);
  const calibration = study.clips.filter(c => c.phase === 'calibration').map(c => ({ ...c,
    prediction: model.predict(c.capture.action, { loc: c.loc }) }));
  const best = selectThreshold(calibration);
  const s = copy(study);
  model.threshold = best.threshold;
  const savedModel = model.toJSON();
  // toJSON records opts as well as the live threshold; freeze both consistently.
  savedModel.opts.threshold = best.threshold;
  s.frozen = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), studyId: s.id, loc: s.loc!,
    trainingIds: training.map(c => c.id), calibrationIds: calibration.map(c => c.id), sourceSignature: sourceSignature(s),
    model: savedModel, threshold: best.threshold, calibration: best };
  validateStudy(s);
  return s;
}

/** Final-test results only; calibration results remain explicitly separate in frozen.calibration. */
export function report(study: Study): StudyReport | null {
  validateStudy(study);
  if (!study.frozen) return null;
  return scoreTrials(study.clips.filter(c => c.phase === 'test'), study.frozen.threshold, 'test');
}
