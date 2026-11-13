import { describe, expect, it } from 'vitest';
import { loadModel } from '../../../web/src/ml/index';
import { mulberry32 } from '../../../web/src/core/rng';
import type { MotionSample } from '../../../web/src/core/contracts';
import { CONTROLS, DEFAULT_PHRASES, REPETITIONS, createStudy, freezeCalibration, nextPrompt, parseStudy, phaseOf,
  phaseProgress, recordTrial, report, validateCapture, type Capture, type Phase, type Study } from '../../../web/src/study/engine';

// Artificial fixtures exercise protocol integrity. They are not AirPods-recognition evidence.
function capture(study: Study, n: number, hz = 50): Capture {
  const prompt = nextPrompt(study)!;
  const phase = phaseOf(study) as Phase;
  const start = 100 + n * 10;
  const actionStart = start + 1, recoveryStart = start + 5, end = start + 5.3;
  const samples = Array.from({ length: Math.ceil(5.3 * hz) }, (_, i): MotionSample => {
    const t = start + i / hz;
    const active = t >= actionStart && t < recoveryStart;
    const p = prompt.kind === 'phrase' ? Number(prompt.id.slice(1)) : 0;
    const freq = prompt.kind === 'headTurn' ? 0.3 : prompt.kind === 'nod' ? 0.65 : 1.5 + p * 0.8;
    const gain = !active ? 0.0005 : prompt.kind === 'rest' ? 0.0006 : prompt.kind === 'phrase' ? 0.025 : 0.4;
    const x = gain * Math.sin((t - actionStart) * Math.PI * 2 * freq + n * 0.0007);
    const y = gain * Math.cos((t - actionStart) * Math.PI * (freq + 0.3) + n * 0.0009);
    return { seq: n * 1000 + i, t, q: [1, 0, 0, 0], rr: [x, y, x / 2], ua: [x / 10, y / 12, y / 20], g: [0, 0, -1] };
  });
  return { id: `take-${n}`, phase, promptId: prompt.id, createdAt: new Date(1_800_000_000_000 + n * 10000).toISOString(),
    locStart: 'left', locEnd: 'left', connectionStart: 1, connectionEnd: 1, liveReal: true,
    baseline: samples.filter(s => s.t < actionStart), action: samples.filter(s => s.t >= actionStart && s.t < recoveryStart),
    recovery: samples.filter(s => s.t >= recoveryStart && s.t < end), baselineStart: start, actionStart, recoveryStart, end };
}

function finish(study: Study, phase: Phase): Study {
  let s = study;
  while (phaseOf(s) === phase && nextPrompt(s)) s = recordTrial(s, capture(s, s.clips.length));
  return s;
}

const fresh = () => createStudy('Test fixture', mulberry32(123));
let calibrationFixture: Study | undefined;
const calibrated = () => calibrationFixture ??= freezeCalibration(finish(finish(fresh(), 'training'), 'calibration'));

describe('phrase prompt and recording protocol', () => {
  it('makes randomized balanced blocks with explicit separate recording roles', () => {
    const s = fresh();
    const ids = [...DEFAULT_PHRASES, ...CONTROLS].map(p => p.id).sort();
    expect(s.clips).toEqual([]);
    expect(s.frozen).toBeUndefined();
    for (const phase of ['training', 'calibration', 'test'] as const) {
      expect(s.plans[phase]).toHaveLength(8 * REPETITIONS[phase]);
      for (let i = 0; i < s.plans[phase].length; i += 8) {
        expect(s.plans[phase].slice(i, i + 8).sort()).toEqual(ids);
        if (i) expect(s.plans[phase][i]).not.toBe(s.plans[phase][i - 1]);
      }
    }
    expect(fresh().plans).toEqual(s.plans);
    expect(createStudy('Other', mulberry32(456)).plans.training).not.toEqual(s.plans.training);
  });

  it('accepts complete real 25 Hz and 50 Hz windows, including resting actions', () => {
    expect(validateCapture(capture(fresh(), 0, 25))).toBeNull();
    expect(validateCapture(capture(fresh(), 0, 50))).toBeNull();
  });

  it('rejects replay, disconnect, ear change, missing data, nonfinite values and clock errors', () => {
    const c = capture(fresh(), 0);
    expect(validateCapture({ ...c, liveReal: false })).toMatch(/live AirPods/);
    expect(validateCapture({ ...c, connectionEnd: 2 })).toMatch(/connection changed/);
    expect(validateCapture({ ...c, locEnd: 'right' })).toMatch(/AirPod changed/);
    expect(validateCapture({ ...c, action: c.action.slice(20) })).toMatch(/window is missing/);
    const nonfinite = structuredClone(c); nonfinite.action[3].rr[1] = NaN;
    expect(validateCapture(nonfinite)).toMatch(/invalid/);
    const seq = structuredClone(c); seq.action[3].seq = seq.action[2].seq;
    expect(validateCapture(seq)).toMatch(/skipped or repeated/);
    const reverse = structuredClone(c); reverse.action.reverse();
    expect(validateCapture(reverse)).toBeTruthy();
    const gap = structuredClone(c); gap.action.splice(30, 12);
    expect(validateCapture(gap)).toMatch(/skipped or repeated/);
    expect(validateCapture({ ...c, recoveryStart: c.actionStart + 3 })).toMatch(/interrupted/);
  });

  it('rejects moving pre-cue baselines without rejecting quiet actions for weak signal', () => {
    const c = capture(fresh(), 0);
    c.baseline.forEach(s => { s.rr = [0.2, 0, 0]; });
    expect(validateCapture(c)).toMatch(/baseline was moving/);
    const quiet = capture(fresh(), 0);
    quiet.action.forEach(s => { s.rr = [0, 0, 0]; s.ua = [0, 0, 0]; });
    expect(validateCapture(quiet)).toBeNull();
  });

  it('returns immutable candidates and does not advance the original study', () => {
    const s = fresh(), c = capture(s, 0), before = JSON.stringify(s);
    const candidate = recordTrial(s, c);
    expect(JSON.stringify(s)).toBe(before);
    expect(candidate.clips).toHaveLength(1);
    expect(candidate.loc).toBe('left');
    expect(candidate.clips[0].prediction).toBeUndefined();
    const savedValue = candidate.clips[0].capture.action[0].rr[0];
    c.action[0].rr[0] = 99;
    expect(candidate.clips[0].capture.action[0].rr[0]).toBe(savedValue);
    expect(() => recordTrial(candidate, { ...capture(candidate, 1), phase: 'test' })).toThrow(/current study phase/);
  });

  it('locks the reporting ear and rejects repeated IDs, content and overlap', () => {
    const a = recordTrial(fresh(), capture(fresh(), 0));
    const b = capture(a, 1);
    expect(() => recordTrial(a, { ...b, locStart: 'right', locEnd: 'right' })).toThrow(/reporting AirPod/);
    expect(() => recordTrial(a, { ...b, id: 'take-0' })).toThrow(/ID was reused/);
    const duplicate = structuredClone(a.clips[0].capture);
    duplicate.id = b.id; duplicate.promptId = b.promptId;
    duplicate.baselineStart += 10; duplicate.actionStart += 10; duplicate.recoveryStart += 10; duplicate.end += 10;
    [duplicate.baseline, duplicate.action, duplicate.recovery].flat().forEach(s => { s.t += 10; s.seq += 1000; });
    expect(() => recordTrial(a, duplicate)).toThrow(/already recorded/);
    const overlap = capture(a, 0.2);
    expect(() => recordTrial(a, overlap)).toThrow(/overlap/);
  });
});

describe('calibration and frozen final testing', () => {
  it('requires complete distinct calibration before freezing; test prompts cannot be added early', () => {
    const trained = finish(fresh(), 'training');
    expect(phaseProgress(trained, 'training').done).toBe(64);
    expect(phaseOf(trained)).toBe('calibration');
    expect(() => freezeCalibration(trained)).toThrow(/Complete a separate calibration/);
    expect(() => recordTrial(trained, { ...capture(trained, 64), phase: 'test' })).toThrow(/current study phase/);
    const ready = finish(trained, 'calibration');
    expect(phaseProgress(ready, 'calibration').done).toBe(16);
    expect(nextPrompt(ready)).toBeNull();
    expect(phaseOf(ready)).toBe('calibration');
  }, 30_000);

  it('freezes a training-only model before test and keeps test clips out of templates', () => {
    const s = calibrated();
    expect(phaseOf(s)).toBe('test');
    expect(s.frozen?.trainingIds).toHaveLength(64);
    expect(s.frozen?.calibrationIds).toHaveLength(16);
    expect(s.frozen?.model.templates).toHaveLength(64);
    const frozenBytes = JSON.stringify(s.frozen);
    const tested = recordTrial(s, capture(s, 80));
    expect(JSON.stringify(tested.frozen)).toBe(frozenBytes);
    expect(tested.clips.at(-1)?.frozenId).toBe(s.frozen?.id);
    expect(tested.clips.at(-1)?.prediction).toBeDefined();
    expect(report(tested)?.attempts).toBe(1);
    expect(report(s)?.attempts).toBe(0);
    expect(() => freezeCalibration(tested)).toThrow(/Complete a separate calibration/);
  }, 30_000);

  it('predicts without a prompted label and keeps calibration/test metrics distinct', () => {
    const s = calibrated();
    const c = capture(s, 80);
    const expected = loadModel(s.frozen!.model).predict(c.action, { loc: c.locStart });
    const tested = recordTrial(s, c);
    expect(tested.clips.at(-1)!.prediction!.label).toBe(expected.label);
    expect(tested.clips.at(-1)!.prediction!.confidence).toBe(expected.confidence);
    expect(s.frozen!.calibration.attempts).toBe(16);
    expect(s.frozen!.calibration.interpretation).toMatch(/not final-test/);
    expect(report(tested)?.interpretation).toMatch(/Fresh test takes only/);
  }, 30_000);

  it('finishes exactly 24 independent test takes without changing the frozen model', () => {
    const s = calibrated();
    const tested = finish(s, 'test');
    expect(phaseOf(tested)).toBe('complete');
    expect(nextPrompt(tested)).toBeNull();
    expect(tested.frozen).toEqual(s.frozen);
    const result = report(tested)!;
    expect(result).toMatchObject({ phase: 'test', attempts: 24, phraseAttempts: 15, controlAttempts: 9 });
    expect(result.phraseCorrect + result.phraseWrongAccepted + result.phraseRejected).toBe(15);
    expect(result.phraseAccuracy).toBe(result.phraseCorrect / 15);
    expect(Object.values(result.byControl).map(v => v.attempts)).toEqual([3, 3, 3]);
    expect(() => recordTrial(tested, capture(s, 200))).toThrow(/current study phase/);
  }, 30_000);

  it('explicitly chooses reject-all when calibration cannot recognize the phrases', () => {
    let s = finish(fresh(), 'training');
    while (nextPrompt(s)) {
      const c = capture(s, s.clips.length);
      c.action.forEach((v, i) => {
        const tiny = (s.clips.length + 1) * 1e-10 * Math.sin(i / 4);
        v.rr = [tiny, tiny / 2, tiny / 3]; v.ua = [tiny / 4, tiny / 5, tiny / 6];
      });
      s = recordTrial(s, c);
    }
    const frozen = freezeCalibration(s);
    expect(frozen.frozen?.threshold).toBe(1.01);
    expect(frozen.frozen?.calibration.phraseCorrect).toBe(0);
    expect(frozen.frozen?.calibration.acceptedPrecision).toBeNull();
  }, 20_000);

  it('fails closed if persisted raw data, predictions, plans or frozen settings change', () => {
    const good = recordTrial(calibrated(), capture(calibrated(), 80));
    expect(parseStudy(JSON.parse(JSON.stringify(good))).clips).toHaveLength(81);
    const raw = structuredClone(good); raw.clips[0].capture.action[0].rr[0] += 0.001;
    expect(() => parseStudy(raw)).toThrow(/Frozen model/);
    const predicted = structuredClone(good); predicted.clips.at(-1)!.prediction!.label = 'p999';
    expect(() => parseStudy(predicted)).toThrow(/final-test result/);
    const model = structuredClone(good); model.frozen!.model.templates[0].x[0][0] += 1;
    expect(() => parseStudy(model)).toThrow(/frozen model differs/);
    const plans = structuredClone(good); plans.plans.test[0] = plans.plans.test[1];
    expect(() => parseStudy(plans)).toThrow(/unbalanced/);
    expect(() => parseStudy(null)).toThrow(/invalid/);
    const metrics = structuredClone(good); metrics.frozen!.calibration.phraseCorrect++;
    expect(() => parseStudy(metrics)).toThrow(/calibration result/);
  }, 20_000);
});
