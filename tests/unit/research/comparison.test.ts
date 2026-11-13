import { describe, expect, it } from 'vitest';
import { requireCoverage, summarize } from '../../../scripts/compare-subvox';
import type { SubvoxClip } from '../../../scripts/lib/subvox';
import type { FoldResult } from '../../../web/src/ml/eval';

const clip = (id: string, label: string, kind: SubvoxClip['kind'] = 'word'): SubvoxClip => ({
  id, label, kind, samples: [], hasSession: true, context: 'one-fit', fingerprint: id,
});
const prediction = (c: SubvoxClip, predicted: string, accepted: boolean): FoldResult => ({
  id: c.id, label: c.label, predicted, accepted, confidence: accepted ? 0.95 : 0.1, ms: 0,
});

describe('offline comparison reporting', () => {
  it('requires actual training coverage even for labels inherited by ordinary objects', () => {
    const train = [clip('1', 'yes'), clip('2', 'yes'), clip('3', 'no'), clip('4', 'no')];
    for (const label of ['constructor', 'toString', '__proto__']) {
      expect(() => requireCoverage(train, [clip('test', label)])).toThrow(/two independent training examples/);
    }
  });

  it('counts vocabulary strings as labels without modifying object prototypes', () => {
    const clips = ['constructor', 'toString', '__proto__'].map((label, i) => clip(String(i), label));
    const metrics = summarize(clips, clips.map(c => prediction(c, c.label, true)));
    expect(metrics.labelCounts).toEqual({ constructor: 1, toString: 1, ['__proto__']: 1 });
    expect(metrics.top1Correct).toBe(3);
    for (const c of clips) {
      expect(metrics.top1Confusion[c.label][c.label]).toBe(1);
      expect(metrics.emittedConfusion[c.label][c.label]).toBe(1);
    }
    expect(Object.getPrototypeOf(metrics.labelCounts)).toBe(null);
    expect(Object.getPrototypeOf(metrics.top1Confusion)).toBe(null);
    expect(Object.getPrototypeOf(metrics.top1Confusion.__proto__)).toBe(null);
  });

  it('includes rejections in word failures and control emissions in precision', () => {
    const clips = [clip('1', 'yes'), clip('2', 'yes'), clip('3', 'no'), clip('4', 'none', 'rest')];
    const rows = [prediction(clips[0], 'yes', true), prediction(clips[1], 'yes', false),
      prediction(clips[2], 'yes', true), prediction(clips[3], 'yes', true)];
    const metrics = summarize(clips, rows);
    expect(metrics.words).toMatchObject({ attempts: 3, top1Correct: 2, acceptedCorrect: 1,
      correctPerAttempt: 1 / 3, wrongAccepted: 1, rejected: 1 });
    expect(metrics.acceptedPrecisionIncludingControls).toBe(1 / 3);
    expect(metrics.controls.rest).toEqual({ attempts: 1, falseWords: 1 });
    expect(metrics.emittedConfusion.yes.rejected).toBe(1);
  });

  it('does not report perfect precision when every attempt is rejected', () => {
    const c = clip('1', 'yes');
    const metrics = summarize([c], [prediction(c, 'yes', false)]);
    expect(metrics.acceptedPrecisionIncludingControls).toBeNull();
    expect(metrics.words.correctPerAttempt).toBe(0);
    expect(() => summarize([c], [])).toThrow(/Incomplete/);
  });
});
