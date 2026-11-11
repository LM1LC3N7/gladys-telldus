// -----------------------------------------------------------------------------
// The app on a REAL moving clock (sped up 20 times) and the real local fake
// Telldus: Telldus read every minute (never early, a little late under load
// at most), a stop sent again after 3 s and 10 s; nothing left running after
// stop.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { TelldusApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { TIMINGS } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { fakeTelldus } from './helpers/fakeTelldus.js';
import { realClock, waitFor } from './helpers/clock.js';
import { D, KEYS, SELECTOR, createdDevices, memoryLogger } from './helpers/app.js';

const SPEED = 20;

test('real clock: read every minute; stop resends at 3 s and 10 s; nothing after stop', async (t) => {
  const clock = realClock({ speed: SPEED });
  const srv = await fakeTelldus({ now: clock.now });
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { mode: 'live', ...KEYS, safe_devices: '101' },
    devices: createdDevices(),
  });
  const app = new TelldusApp({
    gladys,
    logger: memoryLogger(),
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
    baseUrl: srv.liveUrl,
  });
  registerHandlers(gladys, app, memoryLogger());
  t.after(async () => {
    await Promise.race([app.stop(), new Promise((resolve) => setTimeout(resolve, 500))]);
    clock.close();
    await srv.close();
  });
  const reads = [];
  const offs = [];
  const original = srv.routes;
  original['GET devices/list'] = () => {
    reads.push(clock.monotonic());
    return { device: srv.data.devices };
  };
  original['GET device/turnOff'] = () => {
    offs.push(clock.monotonic());
    return { status: 'success' };
  };
  await gladys.connect();
  await waitFor(() => reads.length === 1, 'first read', 3_000);
  const click = clock.monotonic();
  await app.setValue({}, { external_id: D('live', 101, 'state') }, 0);
  const period = TIMINGS.pollDefault;
  await waitFor(() => reads.length >= 4, 'four reads', (3 * period) / SPEED + 5_000);
  const gaps = reads.slice(1).map((v, i) => v - reads[i]);
  for (const gap of gaps.slice(0, 3)) {
    assert.ok(gap >= period * 0.98 && gap <= period * 1.5, `gap ${Math.round(gap)} ms`);
  }
  assert.equal(offs.length, 3);
  const expected = [0, 3_000, 10_000];
  offs.forEach((at, i) => {
    const late = at - click - expected[i];
    assert.ok(late >= -50 && late <= 1_500, `send ${i}: ${Math.round(late)} ms late`);
  });
  await app.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const count = srv.requests.length;
  await new Promise((resolve) => setTimeout(resolve, (2 * period) / SPEED));
  assert.equal(srv.requests.length, count, 'nothing sent after stop');
  assert.equal(clock.live, 0, 'no timer left');
});
