// Run after opening PhraseMotionBridge.app. Reads status only; never records a labeled take.
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const url = 'ws://127.0.0.1:8766';
async function blocked(origin) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error('Origin rejection timed out')); }, 3000);
    ws.on('open', () => { clearTimeout(timeout); ws.close(); reject(new Error('Untrusted Origin was accepted')); });
    ws.on('error', () => { clearTimeout(timeout); resolve(); });
  });
}

await blocked();
await blocked('https://example.com');
const status = await new Promise((resolve, reject) => {
  const ws = new WebSocket(url, { origin: 'http://127.0.0.1:5173' });
  let hello, status;
  const timeout = setTimeout(() => { ws.terminate(); reject(new Error('Bridge status timed out')); }, 4000);
  ws.on('message', raw => {
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'hello') {
        hello = frame;
        assert.equal(frame.app, 'PhraseMotionBridge');
        assert.deepEqual(frame.actions, []);
        assert.equal(frame.armed, false);
        ws.send(JSON.stringify({ type: 'action', id: 'read-only-check', action: 'unavailable' }));
      }
      if (frame.type === 'status') {
        status = frame;
        assert.equal(frame.simulated, false);
        assert.equal(frame.armed, false);
      }
      if (frame.type === 'error') {
        assert.ok(hello && status);
        assert.equal(frame.code, 'unknown_action');
        clearTimeout(timeout);
        ws.close();
        resolve(status);
      }
    } catch (error) { clearTimeout(timeout); ws.terminate(); reject(error); }
  });
  ws.on('error', error => { clearTimeout(timeout); reject(error); });
});
console.log(JSON.stringify({ originChecks: 'passed', actions: 'unavailable', simulated: false,
  headphones: status.headphones, permission: status.auth, sensorEar: status.loc, rate: status.hz }, null, 2));
