// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a fake Telldus API on a real local
// HTTP server, a virtual clock and a /data in memory. Every wait is bounded:
// a test fails, never hangs, even under a mutant.
//
// The virtual clock never moves while a request of the app is on its way
// (`clock.idle`), except a request the fake holds on purpose ('hang'): a
// timeout of the app never races the real network.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { TelldusApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { buildDevice, buildSensor } from '../../src/model.js';
import { memoryStore } from '../../src/store.js';
import { request as httpRequest } from '../../src/http.js';
import { fakeTelldus } from './fakeTelldus.js';
import { settle, testClock, waitFor } from './clock.js';

export const SELECTOR = 'telldus';
export const KEYS = {
  public_key: 'PUBKEY-live-0001',
  private_key: 'PRIVKEY-live-0002',
  token: 'TOKEN-live-0003',
  token_secret: 'TOKSECRET-live-0004',
};
export const LOCAL_TOKEN = 'LOCALTOKEN-abcdef-0005';

/** A memory logger (every line kept). */
export function memoryLogger() {
  const lines = [];
  const log =
    (level) =>
    (...args) =>
      lines.push(`${level} ${args.map(String).join(' ')}`);
  return { lines, info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') };
}

/** `D('live', 101, 'state')` -> the external id of a feature. */
export const D = (mode, id, key) => `ext:${SELECTOR}:device:${mode}-${id}${key ? `:${key}` : ''}`;
export const S = (mode, id, key) => `ext:${SELECTOR}:sensor:${mode}-${id}${key ? `:${key}` : ''}`;

/** The devices created in Gladys by default: the three devices (101, 102 safe) and the sensor. */
export function createdDevices(mode = 'live', safe = ['101', '102']) {
  const g = createFakeGladys({ selector: SELECTOR });
  return [
    buildDevice(
      g,
      mode,
      { id: '101', name: 'Lamp', kind: 'onoff' },
      { safe: safe.includes('101') },
    ),
    buildDevice(
      g,
      mode,
      { id: '102', name: 'Dimmer', kind: 'dimmer' },
      { safe: safe.includes('102') },
    ),
    buildDevice(
      g,
      mode,
      { id: '103', name: 'Heater plug', kind: 'onoff' },
      { safe: safe.includes('103') },
    ),
    buildSensor(
      g,
      mode,
      { id: '201', name: 'Outdoor', values: [{ key: 'temperature' }, { key: 'humidity' }] },
      {},
    ),
  ];
}

export async function setup(t, options = {}) {
  const clock = options.clock ?? testClock({ start: Date.UTC(2026, 10, 11, 10) });
  const srv = options.srv ?? (await fakeTelldus({ now: clock.now }));
  let pending = 0;
  const request = (url, opts) => {
    pending += 1;
    return httpRequest(url, opts).finally(() => {
      pending -= 1;
    });
  };
  // Several apps may share one clock (a restart): time waits for the requests of all of them.
  clock.busy ??= [];
  clock.busy.push(() => pending - srv.hanging > 0);
  clock.idle ??= () => !clock.busy.some((busy) => busy());
  const store = options.store ?? memoryStore(options.data ?? null);
  const mode = options.mode ?? 'live';
  const config =
    mode === 'live'
      ? { mode, ...KEYS, safe_devices: '101, 102', ...options.config }
      : {
          mode,
          host: '192.168.1.40',
          local_token: LOCAL_TOKEN,
          safe_devices: '101, 102',
          ...options.config,
        };
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config,
    devices: options.devices ?? createdDevices(mode),
  });
  const logger = options.logger ?? memoryLogger();
  const app = new TelldusApp({
    gladys,
    logger,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    request,
    // The configured address is a LAN one; the requests go to the fake.
    baseUrl: mode === 'live' ? srv.liveUrl : `http://${srv.host}/api/`,
    ...options.app,
  });
  registerHandlers(gladys, app, logger);
  t.after(async () => {
    await Promise.race([app.stop(), new Promise((resolve) => setTimeout(resolve, 300))]);
    await srv.close();
  });
  const ctx = { app, gladys, srv, clock, store, config, logger, pending: () => pending };
  if (options.connect !== false) {
    await gladys.connect();
    if (options.firstRead !== false)
      await until(
        clock,
        () => app.lastResult !== undefined || app.memoryState !== 'ok',
        'first read',
      );
  }
  return ctx;
}

/** Advances the virtual clock until `condition()` (real I/O runs in between), bounded. */
export async function until(clock, condition, what, { step = 10, max = 30_000 } = {}) {
  for (let spent = 0; spent <= max; spent += step) {
    await settle(3);
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
    await clock.advance(step);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The answer of a call, the virtual clock run until it comes (bounded). */
export async function answer(ctx, promise, { step = 5, max = 30_000 } = {}) {
  const box = { done: false };
  const settled = promise.then(
    (value) => {
      box.done = true;
      return value;
    },
    (err) => {
      box.done = true;
      throw err;
    },
  );
  settled.catch(() => {});
  await until(ctx.clock, () => box.done, 'answer', { step, max });
  return settled;
}

/** A command through the SDK wiring (as Gladys sends it), its outcome text or its refusal. */
export function command(ctx, featureId, value) {
  return ctx.app.setValue({}, { external_id: featureId }, value);
}

/** The states published to Gladys for one feature (values in order). */
export const statesOf = (gladys, featureId) =>
  gladys.fake.states.filter((s) => s.device_feature_external_id === featureId).map((s) => s.state);

/** The last status of the integration, in English. */
export const status = (gladys) => gladys.fake.connectionStatus?.message?.en ?? '';

/** Lets the publisher flush (1 s of virtual time). */
export const flush = (ctx) => ctx.clock.advance(1_100);

export { settle, waitFor };
