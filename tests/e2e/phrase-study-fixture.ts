import type { MotionSample } from '../../web/src/core/contracts';
import { mulberry32 } from '../../web/src/core/rng';
import { createStudy, nextPrompt, phaseOf, recordTrial, type Capture, type Phase, type Study } from '../../web/src/study/engine';

/** Invented recordings for the disposable Playwright profile only. Never imported by production. */
function capture(study: Study, n: number): Capture {
  const prompt = nextPrompt(study)!;
  const phase = phaseOf(study) as Phase;
  const start = 100 + n * 10;
  const actionStart = start + 1, recoveryStart = start + 5, end = start + 5.3;
  const samples = Array.from({ length: 265 }, (_, i): MotionSample => {
    const t = start + i / 50;
    const active = t >= actionStart && t < recoveryStart;
    const p = prompt.kind === 'phrase' ? Number(prompt.id.slice(1)) : 0;
    const freq = prompt.kind === 'headTurn' ? 0.3 : prompt.kind === 'nod' ? 0.65 : 1.5 + p * 0.8;
    const gain = !active ? 0.0005 : prompt.kind === 'rest' ? 0.0006 : prompt.kind === 'phrase' ? 0.025 : 0.4;
    const x = gain * Math.sin((t - actionStart) * Math.PI * 2 * freq + n * 0.0007);
    const y = gain * Math.cos((t - actionStart) * Math.PI * (freq + 0.3) + n * 0.0009);
    return { seq: n * 1000 + i, t, q: [1, 0, 0, 0], rr: [x, y, x / 2], ua: [x / 10, y / 12, y / 20], g: [0, 0, -1] };
  });
  return { id: `browser-fixture-${n}`, phase, promptId: prompt.id, createdAt: new Date(1_800_000_000_000 + n * 10000).toISOString(),
    locStart: 'left', locEnd: 'left', connectionStart: 1, connectionEnd: 1, liveReal: true,
    baseline: samples.filter(s => s.t < actionStart), action: samples.filter(s => s.t >= actionStart && s.t < recoveryStart),
    recovery: samples.filter(s => s.t >= recoveryStart && s.t < end), baselineStart: start, actionStart, recoveryStart, end };
}

export function calibrationReadyFixture(): Study {
  let study = createStudy('Disposable browser fixture', mulberry32(123));
  while (nextPrompt(study)) study = recordTrial(study, capture(study, study.clips.length));
  if (study.clips.length !== 80 || phaseOf(study) !== 'calibration' || study.frozen) throw new Error('Fixture must stop before freezing');
  return study;
}
