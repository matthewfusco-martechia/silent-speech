import './study.css';
import type { MotionSample, StatusMsg } from '../core/contracts';
import { parseServerMsg } from '../core/validate';
import { createStudy, phaseOf, phaseProgress, nextPrompt, promptById, recordTrial,
  freezeCalibration, report, type Capture, type Study, type Phase } from './engine';
import { StudyStorage, type SavedStudy } from './storage';

const root = document.getElementById('study-root')!;
root.innerHTML = `
  <header class="top"><div><div class="eyebrow">SILENT SPEECH</div><h1>Your phrase study</h1></div><span class="privacy">AirPods motion only · on this Mac</span></header>
  <main>
    <section class="connection card"><div><span class="signal-dot" id="signal-dot"></span><strong id="connection">Connecting to the motion bridge…</strong><p id="device-detail">Put in your AirPods and choose them as your Mac’s audio output. Allow Motion when asked.</p></div><canvas id="scope" width="480" height="72" aria-label="Live AirPods rotation signal"></canvas></section>
    <nav class="steps" aria-label="Study progress"><div id="step-training"></div><div id="step-calibration"></div><div id="step-test"></div></nav>
    <section class="card cue-card" aria-labelledby="cue"><div class="cue-top"><span id="round-label">Getting ready</span><span id="progress">0 takes</span></div>
      <div class="phase-label" id="capture-phase">READY WHEN YOU ARE</div><h2 id="cue">Loading your local study…</h2><p id="instruction">Every cue is visual. Mouth phrases without making a sound.</p>
      <div class="time-track"><div id="time-fill"></div></div><p id="countdown" aria-hidden="true">&nbsp;</p>
      <div class="buttons"><button id="start" class="primary" disabled>Start training</button><button id="pause" hidden>Pause</button><button id="freeze" class="primary" hidden>Freeze matcher & prepare final test</button><button id="same-fit" hidden>Continue with the same fit</button></div>
      <p class="notice" id="notice" role="status" aria-live="polite">Loading saved recordings…</p>
      <div class="buttons" id="save-recovery" hidden><button id="retry-save">Retry saving</button><button id="export-pending">Export unsaved study</button></div>
    </section>
    <section class="card results" id="results" hidden><div class="eyebrow" id="results-kind">FINAL TEST</div><h2 id="result-title">Your results</h2><div id="result-metrics" class="metrics"></div><p id="result-note"></p><div id="control-results"></div></section>
    <div class="lower-grid"><section class="card"><h2>Five phrases, learned from you</h2><ol id="phrases"></ol><p class="muted">Rest, a gentle head turn, and a nod are mixed into every round. They should produce no phrase.</p></section>
    <section class="card"><h2>How to take the study</h2><ol class="guide"><li>Sit comfortably with your head supported. Keep the AirPods seated the same way.</li><li>Stay still while the screen says settle and baseline. The phrase appears when capture starts.</li><li>Silently mouth it once during the four-second cue, then relax. For a control, follow its instruction.</li><li>Finish training, calibration, then the final test. You can pause between takes.</li></ol><p class="muted">About 8 minutes of training, 2 minutes of calibration, and 3 minutes of testing. If you remove or reseat the AirPods, start a new study.</p></section></div>
    <footer><div><strong id="saved-state">Local autosave</strong><p>Separate from your Subvox recordings. This screen never speaks or runs commands.</p></div><div class="buttons"><button id="export" disabled>Export study</button><button id="new-study" disabled>Start a separate study</button></div></footer>
  </main>`;

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => el<HTMLButtonElement>(id);
let storage: StudyStorage | null = null, saved: SavedStudy | null = null;
let pending: Study | null = null, saving = false, fatal = false;
let running = false, resumeFit = false;
let socket: WebSocket | null = null, trusted = false, status: StatusMsg | null = null;
let connection = 0, lastArrival = 0, lastStatus = 0, lastSample: MotionSample | null = null;
let attempt: { start: number; wallStart: number; baselineChecked: boolean; connection: number; loc: StatusMsg['loc']; samples: MotionSample[]; phase: Phase; promptId: string } | null = null;
let nextTimer: ReturnType<typeof setTimeout> | null = null;
let scopeSamples: MotionSample[] = [];
let lastPaint = 0;
let lastReportStudy: Study | null = null;

const phaseName = (phase: Phase | 'complete') => ({ training: 'Training', calibration: 'Calibration', test: 'Final test', complete: 'Study complete' })[phase];
function message(text: string, bad = false) { el('notice').textContent = text; el('notice').classList.toggle('bad', bad); }
function isLive(): boolean {
  return trusted && socket?.readyState === WebSocket.OPEN && status?.headphones === 'connected' &&
    status.auth === 'authorized' && !status.simulated && !status.armed && performance.now() - lastArrival < 300 && performance.now() - lastStatus < 2500;
}

function render(): void {
  const s = saved?.data;
  const live = isLive();
  el('signal-dot').classList.toggle('on', live);
  el('connection').textContent = live ? 'AirPods motion connected' : status?.auth === 'denied' ? 'Motion permission is needed' : 'Waiting for AirPods motion';
  el('device-detail').textContent = live ? `${status!.loc} sensor · ${status!.hz.toFixed(1)} Hz · keep the same fit through all rounds` :
    status?.auth === 'denied' ? 'Enable Phrase Motion Bridge in System Settings → Privacy & Security → Motion & Fitness.' :
      'Put in your AirPods, choose them as the Mac’s audio output, and open Phrase Motion Bridge.';
  button('export').disabled = !s || saving;
  button('new-study').disabled = !storage || running || saving || !!pending || fatal;
  el('save-recovery').hidden = !pending;
  button('retry-save').disabled = saving;
  button('pause').hidden = !running;
  button('same-fit').hidden = !resumeFit || !live || running || !!pending;
  if (!s) { button('start').disabled = true; return; }
  const phase = phaseOf(s), prompt = nextPrompt(s);
  for (const p of ['training', 'calibration', 'test'] as Phase[]) {
    const progress = phaseProgress(s, p), node = el(`step-${p}`);
    node.className = `step ${phase === p ? 'active' : ''} ${progress.done === progress.total ? 'done' : ''}`;
    node.textContent = `${phaseName(p)} · ${progress.done}/${progress.total}`;
  }
  el('round-label').textContent = phaseName(phase);
  const progress = phase === 'complete' ? null : phaseProgress(s, phase);
  el('progress').textContent = progress ? `${progress.done} of ${progress.total} saved` : `${s.clips.length} takes saved`;
  button('start').textContent = `${progress?.done ? 'Resume' : 'Start'} ${phase === 'test' ? 'final test' : phase}`;
  button('start').hidden = running || phase === 'complete' || !prompt;
  button('start').disabled = !live || resumeFit || !!pending || saving || fatal;
  button('freeze').hidden = running || phase !== 'calibration' || !!prompt || !!s.frozen;
  button('freeze').disabled = saving || !!pending || fatal;
  el('saved-state').textContent = pending ? 'Take not saved — keep this page open' : saving ? 'Saving on this Mac…' : `${s.clips.length} takes saved on this Mac`;
  if (!running && !pending) {
    el('capture-phase').textContent = phase === 'complete' ? 'ALL THREE ROUNDS FINISHED' : 'READY WHEN YOU ARE';
    el('cue').textContent = phase === 'complete' ? 'Your final test is complete' : phase === 'calibration' && !prompt ? 'Calibration is complete' : `${phaseName(phase)} is ready`;
    el('instruction').textContent = phase === 'complete' ? 'Results below include every final-test attempt and rejection.' : phase === 'calibration' && !prompt ?
      'Freeze the matcher before collecting the final test. No test recording will be used to train it.' :
      phase === 'test' ? 'These are fresh recordings. Your training and confidence threshold are now fixed.' : 'Stay still for the baseline, then follow each visual cue. No Space key is needed.';
    el('countdown').textContent = '\u00a0'; el('time-fill').style.width = '0%';
  }
  if (s.frozen && lastReportStudy !== s) { showReport(s); lastReportStudy = s; }
  el('phrases').replaceChildren(...s.phrases.map(p => { const li = document.createElement('li'); li.textContent = p.text; return li; }));
}

function showReport(s: Study): void {
  const finalCount = s.clips.filter(c => c.phase === 'test').length;
  const r = finalCount ? report(s) : s.frozen!.calibration;
  if (!r) return;
  el('results').hidden = false;
  el('results-kind').textContent = finalCount ? 'FINAL TEST · FROZEN MATCHER' : 'CALIBRATION · BEFORE FINAL TEST';
  el('result-title').textContent = finalCount ? `${r.phraseCorrect} of ${r.phraseAttempts} phrases emitted correctly` : 'Matcher frozen and ready to test';
  const metrics = [
    ['Correct per attempt', `${r.phraseCorrect}/${r.phraseAttempts}`],
    ['Wrong phrases emitted', String(r.phraseWrongAccepted)],
    ['Rejected phrases', String(r.phraseRejected)],
    ['False phrases on controls', `${r.controlFalseWords}/${r.controlAttempts}`],
  ];
  el('result-metrics').replaceChildren(...metrics.map(([label, value]) => { const div = document.createElement('div'); const strong = document.createElement('strong'); strong.textContent = value; const span = document.createElement('span'); span.textContent = label; div.append(strong, span); return div; }));
  el('result-note').textContent = r.interpretation + (s.frozen!.threshold > 1 ? ' Calibration chose to reject everything. Recognition has not been demonstrated.' : ' Rejected attempts count as failures. These results apply to this study and fit.');
  el('control-results').textContent = Object.entries(r.byControl).map(([kind, v]) => `${kind}: ${v.falseWords} false phrases in ${v.attempts} attempts`).join(' · ');
}

function stop(reason?: string, bad = false): void {
  running = false; attempt = null;
  if (nextTimer) clearTimeout(nextTimer); nextTimer = null;
  if (reason) message(reason, bad);
  render();
}

async function persist(candidate: Study): Promise<boolean> {
  pending = candidate; saving = true; render();
  try {
    if (!storage) throw new Error('Local storage is not available. Export the unsaved study before closing.');
    saved = await storage.save(candidate, saved?.id === candidate.id ? saved.revision : 0);
    pending = null; message('Saved on this Mac.');
    return true;
  } catch (e) {
    stop(); message(`Not saved. ${e instanceof Error ? e.message : String(e)}`, true); return false;
  } finally { saving = false; render(); }
}

function startAttempt(): void {
  if (!running || !saved || !lastSample || !isLive()) { stop('Waiting for a fresh AirPods signal. No take was saved.', true); return; }
  const phase = phaseOf(saved.data), prompt = nextPrompt(saved.data);
  if (phase === 'complete' || !prompt) { stop(`${phaseName(phase)} finished. You can continue below.`); return; }
  attempt = { start: lastSample.t, wallStart: performance.now(), baselineChecked: false, connection, loc: status!.loc, samples: [], phase, promptId: prompt.id };
  paintCapture(lastSample.t);
}

function paintCapture(t: number): void {
  if (!attempt || !saved) return;
  const elapsed = t - attempt.start;
  const prompt = promptById(saved.data, attempt.promptId);
  let title: string, instruction: string, stage: string, remaining: number;
  if (elapsed < 1.5) {
    stage = 'SETTLE'; title = 'Relax and stay still'; instruction = 'The next cue will appear after your resting baseline.'; remaining = 1.5 - elapsed;
  } else if (elapsed < 2.5) {
    stage = 'RESTING BASELINE'; title = 'Keep still'; instruction = 'Keep your jaw relaxed and your mouth closed.'; remaining = 2.5 - elapsed;
  } else if (elapsed < 6.5) {
    stage = prompt.kind === 'phrase' ? 'SILENTLY MOUTH ONCE' : 'MOVEMENT / REST CONTROL'; title = prompt.text;
    instruction = prompt.kind === 'phrase' ? 'Mouth this phrase once without making a sound. Then relax.' : 'Follow the cue. Do not mouth a phrase.'; remaining = 6.5 - elapsed;
  } else { stage = 'RECOVERY'; title = 'Relax'; instruction = 'Saving this take next.'; remaining = Math.max(0, 6.8 - elapsed); }
  el('capture-phase').textContent = stage; el('cue').textContent = title; el('instruction').textContent = instruction;
  el('countdown').textContent = `${Math.max(0, remaining).toFixed(1)} s`;
  el('time-fill').style.width = `${Math.min(100, elapsed / 6.8 * 100)}%`;
}

async function finishAttempt(a: NonNullable<typeof attempt>): Promise<void> {
  attempt = null;
  if (!saved || !running) return;
  if (Math.abs((performance.now() - a.wallStart) / 1000 - 6.8) > 0.35) {
    stop('The motion timing drifted from the visual cue. This take was not saved. Please retry.', true); return;
  }
  const baselineStart = a.start + 1.5, actionStart = a.start + 2.5, recoveryStart = a.start + 6.5, end = a.start + 6.8;
  const between = (start: number, stop: number) => a.samples.filter(s => s.t >= start && s.t < stop);
  const capture: Capture = {
    id: crypto.randomUUID(), phase: a.phase, promptId: a.promptId, createdAt: new Date().toISOString(),
    locStart: a.loc, locEnd: status?.loc ?? 'unknown', connectionStart: a.connection, connectionEnd: connection,
    liveReal: isLive(), baseline: between(baselineStart, actionStart), action: between(actionStart, recoveryStart),
    recovery: between(recoveryStart, end), baselineStart, actionStart, recoveryStart, end,
  };
  let candidate: Study;
  try { candidate = recordTrial(saved.data, capture); }
  catch (e) { stop(`Retry this cue. ${e instanceof Error ? e.message : String(e)}`, true); return; }
  const previousPhase = a.phase;
  if (!await persist(candidate) || !running) return;
  if (phaseOf(candidate) !== previousPhase || !nextPrompt(candidate)) {
    stop(`${phaseName(previousPhase)} finished and saved. Continue with the next step when you are ready.`); return;
  }
  nextTimer = setTimeout(startAttempt, 800);
}

function onMotion(sample: MotionSample): void {
  if (!trusted || !status || status.simulated || status.auth !== 'authorized') return;
  if (lastSample && (sample.t <= lastSample.t || sample.seq <= lastSample.seq)) {
    if (running) stop('The motion clock changed. This take was not saved. Retry after the signal settles.', true);
    scopeSamples = []; lastSample = null; resumeFit = !!saved?.data.clips.length;
  }
  lastArrival = performance.now(); lastSample = sample;
  scopeSamples.push(sample); if (scopeSamples.length > 300) scopeSamples.shift();
  if (attempt) {
    attempt.samples.push(sample);
    if (!attempt.baselineChecked && sample.t - attempt.start >= 2.5) {
      const rest = attempt.samples.filter(s => s.t >= attempt!.start + 1.5 && s.t < attempt!.start + 2.5);
      const rms = (field: 'rr' | 'ua') => Math.sqrt(rest.reduce((sum, s) => sum + s[field].reduce((n, v) => n + v * v, 0), 0) / Math.max(1, rest.length));
      if (rest.length < 15 || rms('rr') > 0.12 || rms('ua') > 0.04) {
        stop('The resting baseline was moving. Relax, then resume to retry the same hidden cue.', true); return;
      }
      attempt.baselineChecked = true;
    }
    if (sample.t - attempt.start >= 6.8) void finishAttempt(attempt);
    else if (performance.now() - lastPaint > 70) paintCapture(sample.t);
  }
  if (performance.now() - lastPaint > 70) { drawScope(); lastPaint = performance.now(); }
}

function drawScope(): void {
  const canvas = el<HTMLCanvasElement>('scope'), ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h); ctx.strokeStyle = '#334443'; ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
  const colors = ['#92d8b9', '#c4b6f2', '#e3ba79'];
  for (let axis = 0; axis < 3; axis++) {
    ctx.strokeStyle = colors[axis]; ctx.beginPath();
    scopeSamples.forEach((s, i) => { const x = i / 299 * w, y = h / 2 - Math.max(-1, Math.min(1, s.rr[axis])) * h * 0.42; if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke();
  }
}

function connect(): void {
  trusted = false; status = null; lastSample = null; lastArrival = 0; lastStatus = 0; scopeSamples = []; connection++;
  socket = new WebSocket('ws://127.0.0.1:8766');
  socket.onmessage = event => {
    const msg = parseServerMsg(event.data);
    if (!msg) { if (running) stop('The motion bridge sent an invalid reading. Retry after reconnecting.', true); return; }
    if (msg.type === 'hello') {
      trusted = msg.app === 'PhraseMotionBridge' && msg.actions.length === 0 && !msg.armed;
      if (!trusted) { stop('Open the motion-only Phrase Motion Bridge for this study.', true); socket?.close(); }
    } else if (msg.type === 'status' && trusted) {
      if (status && msg.loc !== status.loc && saved?.data.clips.length) resumeFit = true;
      if (running && (msg.loc !== status?.loc || msg.simulated || msg.headphones !== 'connected' || msg.auth !== 'authorized' || msg.armed)) {
        stop('AirPods or sensor location changed. This unfinished take was not saved.', true); resumeFit = !!saved?.data.clips.length;
      }
      status = msg; lastStatus = performance.now(); render();
    } else if (msg.type === 'motion') onMotion(msg);
  };
  socket.onclose = () => {
    trusted = false; status = null; lastSample = null; connection++;
    resumeFit = !!saved?.data.clips.length;
    if (running) stop('AirPods motion disconnected. This unfinished take was not saved.', true);
    render(); setTimeout(connect, 2000);
  };
  socket.onerror = () => { /* onclose handles retry; no alternate source or simulated data. */ };
  render();
}

function exportStudy(s: Study): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(s)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `phrase-study-${s.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
button('start').onclick = () => {
  if (!saved || !isLive() || saving || pending || resumeFit) return;
  if (saved.data.loc && status!.loc !== saved.data.loc) { message('The sensor ear changed. Start a separate study for this fit.', true); return; }
  running = true; message('Follow each cue. You can pause at any time.'); render(); startAttempt();
};
button('pause').onclick = () => stop('Paused. The unfinished take was not saved. Resume when ready.');
button('same-fit').onclick = () => { resumeFit = false; message('Continue only if the AirPods have stayed seated the same way. Otherwise start a separate study.'); render(); };
button('freeze').onclick = async () => {
  if (!saved || saving || pending) return;
  message('Choosing a confidence threshold using calibration only…');
  try { await persist(freezeCalibration(saved.data)); }
  catch (e) { message(e instanceof Error ? e.message : String(e), true); }
};
button('retry-save').onclick = async () => { if (pending && !saving) await persist(pending); };
button('export-pending').onclick = () => { if (pending) exportStudy(pending); };
button('export').onclick = () => { if (saved) exportStudy(saved.data); };
button('new-study').onclick = async () => {
  if (!storage || running || saving || pending) return;
  const candidate = createStudy();
  if (await persist(candidate)) { resumeFit = false; el('results').hidden = true; message('A separate study is ready. Earlier studies remain in local storage.'); render(); }
};
document.addEventListener('visibilitychange', () => { if (document.hidden && running) stop('Paused because the study was hidden. Keep this tab visible while recording.'); });
window.addEventListener('beforeunload', event => { if (pending || saving || running) { event.preventDefault(); event.returnValue = ''; } });
setInterval(() => {
  if (running && attempt && !isLive()) { resumeFit = !!saved?.data.clips.length; stop('The AirPods signal stopped. This take was not saved. Retry when the signal is steady.', true); }
  render();
}, 500);

async function boot() {
  try {
    storage = await StudyStorage.open(); saved = await storage.load();
    if (!saved) {
      const data = createStudy(); saved = await storage.save(data, 0);
    }
    resumeFit = saved.data.clips.length > 0;
    message(resumeFit ? 'Saved study restored. Continue with the same fit, or start a separate study if you reseated the AirPods.' : 'Ready for your first training round. Nothing is recorded until you press Start.');
  } catch (e) {
    fatal = true; message(`Local study could not be loaded. ${e instanceof Error ? e.message : String(e)} Existing recordings have been preserved.`, true);
  }
  connect(); render();
}
void boot();
