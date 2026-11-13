import { createHash } from 'node:crypto';
import type { Clip, MotionSample } from '../../web/src/core/contracts';
import { NONE } from '../../web/src/core/contracts';

/** Offline adapter only: never reads or changes the live Subvox store. */
export interface SubvoxClip extends Clip {
  kind: 'word' | 'rest' | 'headTurn' | 'nod';
  hasSession: boolean;
  context: string;
  fingerprint: string;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown, name: string): Obj => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${name}: expected an object`);
  return v as Obj;
};
const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${name}: expected a nonempty string`);
  return v;
};
const num = (v: unknown, name: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name}: expected a finite number`);
  return v;
};
const array = (v: unknown, name: string): unknown[] => {
  if (!Array.isArray(v)) throw new Error(`${name}: expected an array`);
  return v;
};
const optionalID = (v: unknown, name: string): string => v === undefined ? 'legacy' : str(v, name);
const contextOf = (v: Obj): string => JSON.stringify([
  optionalID(v.profileID, 'profileID'), optionalID(v.fitSessionID, 'fitSessionID'),
]);
const word = (v: unknown, name: string): string => {
  const w = str(v, name);
  if (w === NONE) throw new Error(`${name}: word "none" collides with the upstream negative class`);
  return w;
};

function samplesOf(v: unknown, name: string, warnings: Set<string>): MotionSample[] {
  const input = array(v, name);
  if (input.length < 10) throw new Error(`${name}: need at least 10 samples`);
  const samples = input.map((value, seq): MotionSample => {
    const s = obj(value, `${name}[${seq}]`);
    const field = (key: string) => num(s[key], `${name}[${seq}].${key}`);
    // The matcher reads only rr/ua. Earlier Subvox files can lack q/g; placeholders
    // keep the public MotionSample shape without claiming those values were measured.
    const optional = (keys: string[], fallback: number[]) => {
      if (keys.every((key) => s[key] === undefined)) {
        warnings.add('Missing historical quaternion/gravity fields use placeholders; the six-channel matcher ignores them.');
        return fallback;
      }
      return keys.map(field);
    };
    const q = optional(['qw', 'qx', 'qy', 'qz'], [1, 0, 0, 0]);
    const g = optional(['gx', 'gy', 'gz'], [0, 0, -1]);
    for (const key of ['pitch', 'roll', 'yaw']) if (s[key] !== undefined) field(key);
    return {
      seq, t: field('t'), rr: [field('rx'), field('ry'), field('rz')],
      ua: [field('ax'), field('ay'), field('az')],
      q: [q[0], q[1], q[2], q[3]], g: [g[0], g[1], g[2]],
    };
  });
  const duration = samples.at(-1)!.t - samples[0].t;
  if (duration < 0.25 || duration > 5) throw new Error(`${name}: duration must be 0.25 to 5 seconds`);
  if ((samples.length - 1) / duration < 15) throw new Error(`${name}: sample rate is below 15 Hz`);
  for (let i = 1; i < samples.length; i++) {
    const gap = samples[i].t - samples[i - 1].t;
    if (!(gap > 0)) throw new Error(`${name}: timestamps must be strictly increasing`);
    if (gap > 0.2) throw new Error(`${name}: motion gap exceeds 0.2 seconds`);
  }
  return samples;
}

/** Timestamp origin and unused channels cannot disguise replayed classifier inputs. */
function fingerprint(samples: MotionSample[]): string {
  const start = samples[0].t;
  const content = samples.map((s) => [Math.round((s.t - start) * 1e6) / 1e6, ...s.rr, ...s.ua]);
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

function clip(value: Obj, kind: SubvoxClip['kind'], label: string, raw: unknown, session: string,
  hasSession: boolean, warnings: Set<string>): SubvoxClip {
  const id = str(value.id, 'clip.id');
  const samples = samplesOf(raw, `clip ${id}.samples`, warnings);
  return { id, kind, label, samples, session, hasSession, context: contextOf(value),
    loc: 'unknown', fingerprint: fingerprint(samples) };
}

export function adaptSubvox(value: unknown): {
  legacy: SubvoxClip[]; timedTraining: SubvoxClip[]; vocabulary: string[];
  roleCounts: Record<string, number>; warnings: string[];
} {
  const d = obj(value, 'Subvox dataset');
  if (!('templates' in d) && !('timedTrials' in d)) throw new Error('Not a Subvox template/profile dataset');
  const vocabulary = array(d.vocabulary, 'vocabulary').map((v) => word(v, 'vocabulary word'));
  if (new Set(vocabulary).size !== vocabulary.length) throw new Error('Duplicate vocabulary words');
  const warnings = new Set<string>(['Subvox does not persist sensor ear location; clips use unknown with no axis mirroring.']);
  const legacy = array(d.templates === undefined ? [] : d.templates, 'templates').map((v) => {
    const t = obj(v, 'template');
    const label = word(t.label, 'template label');
    if (!vocabulary.includes(label)) throw new Error(`Template word ${label} is outside vocabulary`);
    const hasSession = t.sessionID !== undefined;
    return clip(t, 'word', label, t.samples,
      hasSession ? `legacy:${str(t.sessionID, 'sessionID')}` : 'legacy:unassigned', hasSession, warnings);
  });
  const roleCounts: Record<string, number> = { Training: 0, Calibration: 0, 'Final test': 0 };
  const timedTraining: SubvoxClip[] = [];
  const ids = new Set(legacy.map((c) => c.id));
  if (ids.size !== legacy.length) throw new Error('Duplicate clip IDs');
  for (const value of array(d.timedTrials === undefined ? [] : d.timedTrials, 'timedTrials')) {
    const t = obj(value, 'timed trial');
    const id = str(t.id, 'timed trial.id');
    if (ids.has(id)) throw new Error('Duplicate clip IDs');
    ids.add(id);
    const role = str(t.purpose, 'timed trial.purpose');
    if (!Object.hasOwn(roleCounts, role)) throw new Error(`Unknown timed trial purpose ${role}`);
    roleCounts[role]++;
    const protocol = num(t.protocolVersion, 'timed trial.protocolVersion');
    if (!Number.isInteger(protocol) || protocol < 1) throw new Error('Invalid timed protocol version');
    if (protocol !== 1) throw new Error(`Unsupported timed protocol version ${protocol}`);
    // Existing Calibration/Final test recordings retain their roles and are never
    // pulled into this exploratory comparison, even when a caller supplies them.
    if (role !== 'Training') continue;
    const prompt = obj(t.prompt, 'timed prompt');
    const keys = Object.keys(prompt);
    if (keys.length !== 1) throw new Error('Timed prompt must contain exactly one case');
    const kind = keys[0];
    if (!['word', 'rest', 'headTurn', 'nod'].includes(kind)) throw new Error(`Unknown timed prompt ${kind}`);
    const body = obj(prompt[kind], 'timed prompt body');
    const label = kind === 'word' ? word(body._0, 'timed word') : NONE;
    if (kind === 'word' && !vocabulary.includes(label)) throw new Error(`Timed word ${label} is outside vocabulary`);
    const capture = obj(t.capture, 'timed capture');
    const c = clip(t, kind as SubvoxClip['kind'], label, capture.action,
      `timed:${str(t.roundID, 'roundID')}`, true, warnings);
    const start = num(capture.actionStart, 'actionStart');
    const end = num(capture.recoveryStart, 'recoveryStart');
    if (!(start < end) || c.samples[0].t < start || c.samples.at(-1)!.t >= end ||
      c.samples[0].t - start > 0.15 || end - c.samples.at(-1)!.t > 0.15) {
      throw new Error('Timed action samples do not cover their exclusive capture window');
    }
    timedTraining.push(c);
  }
  assertIndependent(legacy, []);
  assertIndependent(timedTraining, []);
  for (const [name, recordings] of [['Legacy', legacy], ['Timed', timedTraining]] as const) {
    let overlapCount = 0;
    for (let i = 0; i < recordings.length; i++) {
      for (let j = i + 1; j < recordings.length; j++) if (overlaps(recordings[i], recordings[j])) overlapCount++;
    }
    if (overlapCount) warnings.add(`${name} recordings contain ${overlapCount} overlapping sample-clock pairs. Cross-fold overlap is rejected; same-fold recordings are retained unchanged.`);
  }
  return { legacy, timedTraining, vocabulary, roleCounts, warnings: [...warnings] };
}

function overlaps(a: SubvoxClip, b: SubvoxClip): boolean {
  return a.context === b.context && a.samples[0].t <= b.samples.at(-1)!.t && b.samples[0].t <= a.samples.at(-1)!.t;
}

/** Also checks within each side, preventing upstream's silent ID deduplication. */
export function assertIndependent(train: SubvoxClip[], test: SubvoxClip[]): void {
  const ids = new Set<string>(), hashes = new Set<string>();
  const contexts = new Set<string>();
  for (const c of [...train, ...test]) {
    if (ids.has(c.id)) throw new Error('Duplicate clip IDs across or within folds');
    if (hashes.has(c.fingerprint)) throw new Error('Duplicate motion content across or within folds');
    ids.add(c.id); hashes.add(c.fingerprint);
    contexts.add(c.context);
  }
  if (contexts.size > 1) throw new Error('Comparison mixes profiles or fits');
  // Legacy pre-roll can overlap adjacent takes within one recording batch. Keep
  // these unchanged; only a window shared by training and test leaks the query.
  for (const a of train) for (const b of test) if (overlaps(a, b)) {
    throw new Error('Overlapping sample-clock windows across training and test');
  }
}

export function balancedTimedRounds(clips: SubvoxClip[], words: string[]): SubvoxClip[][] {
  if (!words.length || new Set(words).size !== words.length || words.includes(NONE)) throw new Error('Invalid round vocabulary');
  const rounds = new Map<string, SubvoxClip[]>();
  for (const c of clips) {
    if (!c.session?.startsWith('timed:')) throw new Error('Expected timed-round clips');
    const round = rounds.get(c.session) ?? [];
    round.push(c); rounds.set(c.session, round);
  }
  const complete: SubvoxClip[][] = [];
  for (const round of rounds.values()) {
    if (new Set(round.map((c) => c.context)).size !== 1) throw new Error('Timed round mixes profiles or fits');
    assertIndependent(round, []);
    if (round.some((c) => c.kind === 'word' && !words.includes(c.label))) throw new Error('Timed round contains an unknown word');
    if (words.every((w) => round.filter((c) => c.kind === 'word' && c.label === w).length >= 3) &&
      (['rest', 'headTurn', 'nod'] as const).every((k) => round.filter((c) => c.kind === k).length >= 3)) complete.push(round);
  }
  return complete;
}
