import { expect, test, type Page } from '@playwright/test';
import { calibrationReadyFixture } from './phrase-study-fixture';

/** Only in this disposable test browser. Production has no fake/replay source or alternate endpoint. */
async function testMotion(page: Page) {
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.addInitScript(() => {
    const state = { on: true, simulated: false, loc: 'left', outbound: 0 };
    Object.assign(window, { testMotion: state });
    class TestSocket {
      static OPEN = 1;
      readyState = 1;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(url: string) {
        if (url !== 'ws://127.0.0.1:8766') throw new Error('Unexpected endpoint');
        let seq = 0;
        const emit = (value: unknown) => this.onmessage?.({ data: JSON.stringify(value) });
        const status = () => emit({ type: 'status', headphones: state.on ? 'connected' : 'disconnected', auth: 'authorized',
          loc: state.loc, hz: 50, gapPct: 0, clients: 1, armed: false, simulated: state.simulated });
        setTimeout(() => { emit({ type: 'hello', v: 1, app: 'PhraseMotionBridge', version: 'test', actions: [], armed: false }); status(); }, 10);
        setInterval(status, 250);
        setInterval(() => {
          if (!state.on) return;
          const t = 1000 + performance.now() / 1000;
          emit({ type: 'motion', seq: seq++, t, q: [1, 0, 0, 0], rr: [0.001 * Math.sin(t * 3.7), 0.001 * Math.cos(t * 4.1), 0], ua: [0, 0, 0], g: [0, 0, -1] });
        }, 20);
      }
      send() { state.outbound++; throw new Error('The study must never send actions or recordings'); }
      close() { this.readyState = 3; this.onclose?.(); }
    }
    Object.defineProperty(window, 'WebSocket', { value: TestSocket });
  });
}

test('opens an empty motion-only study with no public model, replay or audio', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./study.html');
  await expect(page.locator('#cue')).toHaveText('Training is ready');
  await expect(page.locator('#start')).toBeDisabled();
  await expect(page.locator('#step-training')).toHaveText('Training · 0/64');
  await expect(page.locator('#step-calibration')).toHaveText('Calibration · 0/16');
  await expect(page.locator('#step-test')).toHaveText('Final test · 0/24');
  await expect(page.locator('audio, video')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('records timed windows, saves before advancing, pauses and restores without actions', async ({ page }) => {
  await testMotion(page); await page.goto('./study.html');
  await expect(page.locator('#cue')).toHaveText('Training is ready');
  await page.clock.runFor(300);
  await expect(page.locator('#start')).toBeEnabled(); await page.locator('#start').click();
  await expect(page.locator('#cue')).toHaveText('Relax and stay still');
  await page.clock.runFor(2600);
  await expect(page.locator('#capture-phase')).toHaveText(/SILENTLY MOUTH ONCE|MOVEMENT \/ REST CONTROL/);
  await page.clock.runFor(4300);
  await expect(page.locator('#step-training')).toHaveText('Training · 1/64');
  await page.locator('#pause').click();
  await page.reload(); await page.clock.runFor(300);
  await expect(page.locator('#step-training')).toHaveText('Training · 1/64');
  await expect(page.locator('#same-fit')).toBeVisible();
  await expect(page.locator('#start')).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { testMotion: { outbound: number } }).testMotion.outbound)).toBe(0);
});

test('a stalled or simulated stream cannot produce a saved training take', async ({ page }) => {
  await testMotion(page); await page.goto('./study.html'); await expect(page.locator('#cue')).toHaveText('Training is ready');
  await page.clock.runFor(300); await page.locator('#start').click(); await page.clock.runFor(2800);
  await page.evaluate(() => { (window as unknown as { testMotion: { on: boolean } }).testMotion.on = false; });
  await page.clock.runFor(1000);
  await expect(page.locator('#step-training')).toHaveText('Training · 0/64');
  await expect(page.locator('#notice')).toContainText(/not saved|stopped/);
  await page.evaluate(() => { const s = (window as unknown as { testMotion: { on: boolean; simulated: boolean } }).testMotion; s.on = true; s.simulated = true; });
  await page.clock.runFor(500);
  await expect(page.locator('#start')).toBeDisabled();
});

test('failed storage keeps the captured take available and does not advance the prompt', async ({ page }) => {
  await testMotion(page);
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      const row = value as { data?: { clips?: unknown[] } };
      if (row.data?.clips?.length) throw new DOMException('Synthetic test quota failure', 'QuotaExceededError');
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
  });
  await page.goto('./study.html'); await expect(page.locator('#cue')).toHaveText('Training is ready');
  await page.clock.runFor(300); await page.locator('#start').click(); await page.clock.runFor(7000);
  await expect(page.locator('#step-training')).toHaveText('Training · 0/64');
  await expect(page.locator('#notice')).toContainText('Not saved');
  await expect(page.locator('#export-pending')).toBeVisible();
  await expect(page.locator('#start')).toBeDisabled();
});

test('freezes calibration before a separate final test and preserves the matcher after capture', async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = calibrationReadyFixture();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await testMotion(page);
  await page.goto('./study.html');
  await expect(page.locator('#cue')).toHaveText('Training is ready');
  await page.evaluate(async data => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('airpods-phrase-study-v1', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['studies', 'meta'], 'readwrite');
      tx.objectStore('studies').put({ id: data.id, revision: 1, data });
      tx.objectStore('meta').put(data.id, 'active');
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, fixture);
  await page.reload(); await page.clock.runFor(300);
  await expect(page.locator('#cue')).toHaveText('Calibration is complete');
  await expect(page.locator('#step-training')).toHaveText('Training · 64/64');
  await expect(page.locator('#step-calibration')).toHaveText('Calibration · 16/16');
  await expect(page.locator('#step-test')).toHaveText('Final test · 0/24');
  await expect(page.locator('#freeze')).toBeVisible();
  await page.locator('#freeze').click();
  await expect(page.locator('#cue')).toHaveText('Final test is ready');
  await page.clock.runFor(300);
  await expect(page.locator('#freeze')).toBeHidden();
  await expect(page.locator('#same-fit')).toBeVisible();
  await page.locator('#same-fit').click();
  await expect(page.locator('#start')).toBeEnabled();

  const readPersisted = () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('airpods-phrase-study-v1', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const saved = await new Promise<{ id: string; revision: number; data: { frozen: unknown; clips: { phase: string; frozenId?: string; prediction?: unknown }[] } }>((resolve, reject) => {
      const tx = db.transaction(['studies', 'meta'], 'readonly');
      const active = tx.objectStore('meta').get('active');
      active.onsuccess = () => {
        const row = tx.objectStore('studies').get(active.result);
        row.onsuccess = () => resolve(row.result); row.onerror = () => reject(row.error);
      };
      active.onerror = () => reject(active.error);
    });
    db.close(); return saved;
  });
  const frozen = await readPersisted();
  expect(frozen.data.clips).toHaveLength(80);
  expect(frozen.data.frozen).toBeTruthy();
  const frozenBytes = JSON.stringify(frozen.data.frozen);

  await page.locator('#start').click(); await page.clock.runFor(6900);
  await expect(page.locator('#step-test')).toHaveText('Final test · 1/24');
  await page.locator('#pause').click();
  const tested = await readPersisted();
  expect(tested.revision).toBe(frozen.revision + 1);
  expect(tested.data.clips.filter(c => c.phase === 'training')).toHaveLength(64);
  expect(tested.data.clips.filter(c => c.phase === 'calibration')).toHaveLength(16);
  expect(tested.data.clips.filter(c => c.phase === 'test')).toHaveLength(1);
  expect(tested.data.clips.at(-1)?.prediction).toBeTruthy();
  expect(tested.data.clips.at(-1)?.frozenId).toBe((tested.data.frozen as { id: string }).id);
  expect(JSON.stringify(tested.data.frozen)).toBe(frozenBytes);
  await expect(page.locator('#results-kind')).toHaveText('FINAL TEST · FROZEN MATCHER');
  expect(await page.evaluate(() => (window as unknown as { testMotion: { outbound: number } }).testMotion.outbound)).toBe(0);
  expect(errors).toEqual([]);
});
