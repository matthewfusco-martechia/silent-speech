import { describe, expect, it } from 'vitest';
import { adaptSubvox, assertIndependent, balancedTimedRounds } from '../../../scripts/lib/subvox';

// All fixtures are invented. No participant recordings belong in these tests.
const samples = (start = 100, gain = 1) => Array.from({ length: 31 }, (_, i) => ({
  t: start + i / 50,
  rx: gain * Math.sin(i / 4), ry: gain * Math.cos(i / 3), rz: gain * i / 100,
  ax: gain * Math.cos(i / 5), ay: gain * Math.sin(i / 6), az: gain * i / 200,
  qw: 1, qx: 0, qy: 0, qz: 0, gx: 0, gy: 0, gz: -1,
}));
const template = (id = 'old', start = 100, gain = 1) => ({ id, label: 'yes', samples: samples(start, gain) });
const trial = (id = 'timed', start = 200, gain = 2, kind = 'word', label = 'yes') => ({
  id, roundID: 'round-1', purpose: 'Training', protocolVersion: 1,
  prompt: kind === 'word' ? { word: { _0: label } } : { [kind]: {} },
  capture: { action: samples(start, gain), actionStart: start, recoveryStart: start + 0.62 },
});
const dataset = () => ({ vocabulary: ['yes', 'no'], templates: [template()], timedTrials: [trial()] });

describe('Subvox offline adapter', () => {
  it('preserves raw motion units, timeline and unknown ear; does not use posture as a feature', () => {
    const source = dataset();
    const before = JSON.stringify(source);
    const { legacy, timedTraining } = adaptSubvox(source);
    expect(legacy[0].samples[3]).toEqual({
      seq: 3, t: source.templates[0].samples[3].t,
      rr: [source.templates[0].samples[3].rx, source.templates[0].samples[3].ry, source.templates[0].samples[3].rz],
      ua: [source.templates[0].samples[3].ax, source.templates[0].samples[3].ay, source.templates[0].samples[3].az],
      q: [1, 0, 0, 0], g: [0, 0, -1],
    });
    expect(legacy[0]).toMatchObject({ loc: 'unknown', hasSession: false, session: 'legacy:unassigned', kind: 'word' });
    expect(timedTraining[0].samples).toHaveLength(source.timedTrials[0].capture.action.length);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('retains recording batches and profile/fit identities', () => {
    const source = dataset();
    const old = { ...template(), sessionID: 'guided', profileID: 'person-a', fitSessionID: 'fit-a' };
    const adapted = adaptSubvox({ ...source, templates: [old] });
    expect(adapted.legacy[0]).toMatchObject({ session: 'legacy:guided', hasSession: true });
    expect(adapted.legacy[0].context).not.toEqual(adapted.timedTraining[0].context);
  });

  it('collapses all control kinds into none while preserving their subtypes', () => {
    const timedTrials = ['rest', 'headTurn', 'nod'].map((kind, i) => trial(kind, 200 + i, 2 + i, kind));
    const result = adaptSubvox({ ...dataset(), timedTrials });
    expect(result.timedTraining.map((c) => c.label)).toEqual(['none', 'none', 'none']);
    expect(result.timedTraining.map((c) => c.kind)).toEqual(['rest', 'headTurn', 'nod']);
  });

  it('counts calibration/final test roles without importing their samples', () => {
    const timedTrials = [trial(), { ...trial('calibration'), purpose: 'Calibration', capture: null },
      { ...trial('test'), purpose: 'Final test', capture: null }];
    const result = adaptSubvox({ ...dataset(), timedTrials });
    expect(result.timedTraining).toHaveLength(1);
    expect(result.roleCounts).toEqual({ Training: 1, Calibration: 1, 'Final test': 1 });
  });

  it('rejects unknown roles, future protocols, ambiguous prompts and none word collisions', () => {
    for (const purpose of ['train', 'toString']) {
      expect(() => adaptSubvox({ ...dataset(), timedTrials: [{ ...trial(), purpose }] })).toThrow(/purpose/);
    }
    expect(() => adaptSubvox({ ...dataset(), timedTrials: [{ ...trial(), protocolVersion: 2 }] })).toThrow(/protocol/);
    expect(() => adaptSubvox({ ...dataset(), timedTrials: [{ ...trial(), prompt: { rest: {}, nod: {} } }] })).toThrow(/one case/);
    expect(() => adaptSubvox({ ...dataset(), vocabulary: ['none'] })).toThrow(/negative class/);
    expect(() => adaptSubvox({ ...dataset(), templates: [{ ...template(), label: 'maybe' }] })).toThrow(/vocabulary/);
  });

  it('rejects missing/malformed roots and arrays instead of silently using empty data', () => {
    expect(() => adaptSubvox(null)).toThrow();
    expect(() => adaptSubvox({ vocabulary: [] })).toThrow(/Not a Subvox/);
    expect(() => adaptSubvox({ ...dataset(), templates: null })).toThrow(/array/);
    expect(() => adaptSubvox({ ...dataset(), vocabulary: ['yes', 'yes'] })).toThrow(/Duplicate vocabulary/);
  });

  it('does not let sorting, timestamp deduplication or interpolation repair corrupt captures', () => {
    const run = (s: ReturnType<typeof samples>) => adaptSubvox({ ...dataset(), templates: [{ ...template(), samples: s }] });
    const reversed = samples().reverse();
    expect(() => run(reversed)).toThrow(/duration|increasing/);
    const duplicate = samples(); duplicate[4].t = duplicate[3].t;
    expect(() => run(duplicate)).toThrow(/increasing/);
    const gap = samples(); gap.forEach((s, i) => { if (i > 10) s.t += 0.3; });
    expect(() => run(gap)).toThrow(/gap/);
    const nonfinite = samples(); nonfinite[5].rx = NaN;
    expect(() => run(nonfinite)).toThrow(/finite/);
    expect(() => run(samples().slice(0, 9))).toThrow(/10 samples/);
    const slow = samples(); slow.forEach((s, i) => { s.t = 100 + i / 10; });
    expect(() => run(slow)).toThrow(/15 Hz/);
  });

  it('enforces timed action boundaries and coverage', () => {
    const t = trial();
    expect(() => adaptSubvox({ ...dataset(), timedTrials: [{ ...t, capture: { ...t.capture, recoveryStart: 200.6 } }] })).toThrow(/exclusive/);
    expect(() => adaptSubvox({ ...dataset(), timedTrials: [{ ...t, capture: { ...t.capture, actionStart: 199.8 } }] })).toThrow(/exclusive/);
  });

  it('allows fully absent unused historic fields but rejects partially missing vectors', () => {
    const s = samples().map(({ qw: _w, qx: _x, qy: _y, qz: _z, gx: _gx, gy: _gy, gz: _gz, ...rest }) => rest);
    const result = adaptSubvox({ ...dataset(), templates: [{ ...template(), samples: s }] });
    expect(result.legacy[0].samples[0].q).toEqual([1, 0, 0, 0]);
    expect(result.warnings.some((w) => w.includes('placeholders'))).toBe(true);
    expect(() => adaptSubvox({ ...dataset(), templates: [{ ...template(), samples: s.map((r) => ({ ...r, qw: 1 })) }] })).toThrow(/finite/);
  });
});

describe('recording independence', () => {
  it('rejects duplicated IDs and same motion shifted in time or relabeled', () => {
    const [a] = adaptSubvox(dataset()).legacy;
    expect(() => assertIndependent([a], [{ ...a, fingerprint: 'different' }])).toThrow(/IDs/);
    const [shifted] = adaptSubvox({ ...dataset(), templates: [template('different', 300)] }).legacy;
    expect(() => assertIndependent([a], [{ ...shifted, label: 'no' }])).toThrow(/content/);
  });

  it('rejects overlapping clips even with different IDs and different motion', () => {
    const [a] = adaptSubvox(dataset()).legacy;
    const [b] = adaptSubvox({ ...dataset(), templates: [template('different', 100.4, 3)] }).legacy;
    expect(() => assertIndependent([a], [b])).toThrow(/Overlapping/);
    expect(() => assertIndependent([a], [{ ...b, context: 'different-person' }])).toThrow(/profiles or fits/);
  });

  it('retains same-fold pre-roll overlaps unchanged and surfaces a warning', () => {
    const templates = [template(), template('adjacent', 100.58, 2)];
    const result = adaptSubvox({ ...dataset(), templates });
    expect(result.legacy).toHaveLength(2);
    expect(result.legacy[0].samples).toHaveLength(31);
    expect(result.warnings.some((w) => w.includes('1 overlapping'))).toBe(true);
    expect(() => assertIndependent(result.legacy, [])).not.toThrow();
    expect(() => assertIndependent([result.legacy[0]], [result.legacy[1]])).toThrow(/Overlapping/);
  });
});

describe('complete timed rounds', () => {
  const complete = () => {
    const kinds = [['word', 'yes'], ['word', 'no'], ['rest', ''], ['headTurn', ''], ['nod', '']];
    let n = 0;
    return kinds.flatMap(([kind, label]) => Array.from({ length: 3 }, () => {
      n++;
      return trial(`trial-${n}`, 200 + n, n, kind, label);
    }));
  };

  it('returns complete rounds without promoting incomplete ones into test sessions', () => {
    const timedTrials = [...complete(), { ...trial('partial', 400, 30), roundID: 'incomplete' }];
    const result = adaptSubvox({ ...dataset(), timedTrials });
    const rounds = balancedTimedRounds(result.timedTraining, result.vocabulary);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toHaveLength(15);
    expect(balancedTimedRounds(result.timedTraining.slice(0, 5), result.vocabulary)).toEqual([]);
  });

  it('rejects a round mixing profiles/fits and refuses legacy clips', () => {
    const timedTrials = complete().map((t, i) => ({ ...t, profileID: 'a', fitSessionID: i === 1 ? 'fit-b' : 'fit-a' }));
    expect(() => adaptSubvox({ ...dataset(), timedTrials })).toThrow(/profiles or fits/);
    const result = adaptSubvox({ ...dataset(), timedTrials: complete() });
    result.timedTraining[1].context = 'another-fit';
    expect(() => balancedTimedRounds(result.timedTraining, result.vocabulary)).toThrow(/profiles or fits/);
    expect(() => balancedTimedRounds(result.legacy, result.vocabulary)).toThrow(/timed/);
  });
});
