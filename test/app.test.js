// -----------------------------------------------------------------------------
// The app end to end: fake Gladys (SDK), fake Telldus on a real local HTTP
// server, virtual clock, /data in memory.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { TIMINGS } from '../src/constants.js';
import { encode } from '../src/api.js';
import { memoryStore } from '../src/store.js';
import { reply } from './helpers/fakeTelldus.js';
import {
  D,
  KEYS,
  S,
  answer,
  command,
  flush,
  setup,
  createdDevices,
  status,
  statesOf,
  until,
} from './helpers/app.js';

test('Live: reads devices and sensors with signed requests; Discovery; status; assumed states', async (t) => {
  const ctx = await setup(t);
  const { srv, gladys } = ctx;
  assert.equal(srv.count('devices/list'), 1);
  assert.equal(srv.count('sensors/list'), 1);
  const req = srv.of('devices/list')[0];
  assert.equal(req.query.supportedMethods, '19');
  assert.match(req.headers.authorization, /^OAuth /);
  assert.match(req.headers.authorization, /oauth_consumer_key="PUBKEY-live-0001"/);
  assert.equal(req.headers.accept, 'application/json');
  // The signature checks with the private key and the token secret.
  const params = Object.fromEntries(
    [...req.headers.authorization.slice(6).matchAll(/(\w+)="([^"]*)"/g)].map((m) => [
      m[1],
      decodeURIComponent(m[2]),
    ]),
  );
  const pairs = [
    ...Object.entries(req.query),
    ...Object.entries(params).filter(([k]) => k !== 'oauth_signature'),
  ]
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const base = ['GET', encode(`${srv.liveUrl}devices/list`), encode(pairs)].join('&');
  const expected = createHmac('sha1', `${KEYS.private_key}&${KEYS.token_secret}`)
    .update(base)
    .digest('base64');
  assert.equal(params.oauth_signature, expected);

  const found = gladys.fake.discoveredDevices;
  assert.equal(found.length, 4);
  const byId = Object.fromEntries(found.map((d) => [d.external_id, d]));
  assert.deepEqual(
    byId[D('live', 101)].features.map((f) => [f.category, f.type, f.read_only]),
    [['switch', 'binary', false]],
  );
  assert.deepEqual(
    byId[D('live', 102)].features.map((f) => [f.category, f.type, f.read_only]),
    [
      ['light', 'binary', false],
      ['light', 'brightness', false],
    ],
  );
  // Not declared safe: read only, never a switch.
  assert.deepEqual(
    byId[D('live', 103)].features.map((f) => [f.category, f.type, f.read_only]),
    [['unknown', 'binary', true]],
  );
  assert.match(status(gladys), /Connected to Telldus Live: 3 devices, 1 sensors/);
  await flush(ctx);
  assert.deepEqual(statesOf(gladys, D('live', 101, 'state')), [0]);
  assert.deepEqual(statesOf(gladys, D('live', 102, 'brightness')), [50]);
  assert.deepEqual(statesOf(gladys, D('live', 102, 'state')), [1]);
  assert.deepEqual(statesOf(gladys, S('live', 201, 'temperature')), [12.5]);
  assert.deepEqual(statesOf(gladys, S('live', 201, 'humidity')), [80]);
  // No created_at: a fresh value, never a late one that fires a scene.
  assert.ok(gladys.fake.states.every((s) => s.created_at === undefined));
});

test('reads every interval, never sooner; a scan, the test button and a reconnection read nothing more', async (t) => {
  const ctx = await setup(t);
  const { srv, clock, app, gladys } = ctx;
  await clock.advance(TIMINGS.pollDefault - 50);
  assert.equal(srv.count('devices/list'), 1);
  await gladys.fake.scanRequest();
  const text = await answer(ctx, app.testConnection());
  assert.match(text.en, /Read less than a minute ago/);
  await until(clock, () => srv.count('devices/list') === 2, 'second read', { step: 10, max: 200 });
  await gladys.disconnect();
  await gladys.connect();
  await clock.advance(1_000);
  assert.equal(srv.count('devices/list'), 2);
  await until(clock, () => srv.count('devices/list') === 3, 'third read', {
    step: 50,
    max: TIMINGS.pollDefault + 500,
  });
});

test('a restart never reads sooner than the interval after the last attempt kept in /data; a future date is invalid', async (t) => {
  const first = await setup(t);
  await first.app.stop();
  const kept = first.store.data;
  assert.ok(kept.lastAttempt > 0);
  const again = await setup(t, {
    data: kept,
    clock: first.clock,
    srv: first.srv,
    firstRead: false,
  });
  await again.clock.advance(TIMINGS.pollDefault - 1_000);
  assert.equal(first.srv.count('devices/list'), 1);
  await until(again.clock, () => first.srv.count('devices/list') === 2, 'read after the interval', {
    step: 50,
    max: 2_000,
  });
  const future = await setup(t, {
    data: { ...kept, lastAttempt: first.clock.now() + 3_600_000 },
    firstRead: false,
  });
  await until(future.clock, () => future.srv.count('devices/list') === 1, 'read at once', {
    max: 500,
  });
});

test('turning on a device declared safe: sent, state assumed; not declared safe: refused, nothing sent', async (t) => {
  const ctx = await setup(t);
  const { srv, gladys } = ctx;
  assert.match(await answer(ctx, command(ctx, D('live', 101, 'state'), 1)), /^sent/);
  assert.deepEqual(
    srv.of('device/turnOn').map((r) => r.query.id),
    ['101'],
  );
  assert.match(await answer(ctx, command(ctx, D('live', 102, 'brightness'), 40)), /^sent/);
  assert.deepEqual(
    srv.of('device/dim').map((r) => [r.query.id, r.query.level]),
    [['102', '102']],
  );
  await assert.rejects(answer(ctx, command(ctx, D('live', 103, 'state'), 1)), /not declared safe/);
  assert.equal(srv.of('device/turnOn').length, 1);
  // Turning off a device not declared safe still leaves.
  assert.match(await answer(ctx, command(ctx, D('live', 103, 'state'), 0)), /^sent/);
  assert.deepEqual(
    srv.of('device/turnOff').map((r) => r.query.id),
    ['103'],
  );
  await flush(ctx);
  assert.equal(gladys.fake.lastState(D('live', 101, 'state')), 1);
  assert.equal(gladys.fake.lastState(D('live', 102, 'brightness')), 40);
  // Invalid values: refused, nothing sent.
  for (const value of [2, -1, 0.5, '1.0', '', null, 'on', Number.NaN]) {
    await assert.rejects(
      answer(ctx, command(ctx, D('live', 101, 'state'), value)),
      /invalid value/,
    );
  }
  await assert.rejects(
    answer(ctx, command(ctx, D('live', 102, 'brightness'), 101)),
    /invalid value/,
  );
  await assert.rejects(
    answer(ctx, command(ctx, `ext:${'other'}:device:live-101:state`, 1)),
    /invalid value/,
  );
  await assert.rejects(
    answer(ctx, command(ctx, D('local', 101, 'state'), 1)),
    /other connection mode/,
  );
  assert.equal(srv.of('device/turnOn').length, 1);
});

test('the safe list is checked again just before the send; an unknown device or method is refused', async (t) => {
  const ctx = await setup(t);
  const { srv, gladys } = ctx;
  await gladys.fake.configUpdated({ ...ctx.config, safe_devices: '102' });
  await assert.rejects(answer(ctx, command(ctx, D('live', 101, 'state'), 1)), /not declared safe/);
  // The feature stays (never a lost feature), offered read only.
  const lamp = gladys.fake.discoveredDevices.find((d) => d.external_id === D('live', 101));
  assert.deepEqual(
    lamp.features.map((f) => [f.external_id, f.read_only]),
    [[D('live', 101, 'state'), true]],
  );
  await gladys.fake.configUpdated({ ...ctx.config, safe_devices: '101 102 999' });
  await assert.rejects(
    answer(ctx, command(ctx, D('live', 999, 'state'), 1)),
    /not in the last list/,
  );
  // The on/off receiver takes no dim.
  await assert.rejects(
    answer(ctx, command(ctx, D('live', 101, 'brightness'), 30)),
    /does not take/,
  );
  assert.equal(srv.of('device/turnOn').length + srv.of('device/dim').length, 0);
});

test('turning off: sent again after 3 s and 10 s, then nothing; a newer turn on that left cancels the resends', async (t) => {
  const ctx = await setup(t);
  const { srv, clock } = ctx;
  assert.match(await answer(ctx, command(ctx, D('live', 101, 'state'), 0)), /^sent/);
  await clock.advance(2_900);
  assert.equal(srv.count('device/turnOff'), 1);
  await until(clock, () => srv.count('device/turnOff') === 2, 'resend at 3 s', {
    step: 20,
    max: 300,
  });
  await clock.advance(6_800);
  assert.equal(srv.count('device/turnOff'), 2);
  await until(clock, () => srv.count('device/turnOff') === 3, 'resend at 10 s', {
    step: 20,
    max: 400,
  });
  await clock.advance(60_000);
  assert.equal(srv.count('device/turnOff'), 3);
  assert.equal(ctx.app.stops.size, 0);

  assert.match(await answer(ctx, command(ctx, D('live', 102, 'state'), 0)), /^sent/);
  assert.match(await answer(ctx, command(ctx, D('live', 102, 'state'), 1)), /^sent/);
  await clock.advance(20_000);
  assert.equal(srv.of('device/turnOff').filter((r) => r.query.id === '102').length, 1);
});

test('a turn on refused by Telldus does not cancel the resends of a stop', async (t) => {
  const ctx = await setup(t);
  const { srv, clock } = ctx;
  srv.routes['GET device/turnOn'] = () => ({ error: 'Device not found' });
  assert.match(await answer(ctx, command(ctx, D('live', 101, 'state'), 0)), /^sent/);
  await assert.rejects(answer(ctx, command(ctx, D('live', 101, 'state'), 1)), /not done/);
  await until(clock, () => srv.count('device/turnOff') === 3, 'both resends', {
    step: 50,
    max: 12_000,
  });
});

test('a turn on queued before a stop never leaves after it', async (t) => {
  const ctx = await setup(t);
  const { srv, clock } = ctx;
  srv.routes['GET device/dim'] = () => 'hang';
  const dim = command(ctx, D('live', 102, 'brightness'), 30);
  dim.catch(() => {});
  await until(clock, () => srv.count('device/dim') === 1, 'dim in flight', { max: 200 });
  const on = command(ctx, D('live', 102, 'state'), 1);
  on.catch(() => {});
  await clock.advance(100);
  const off = command(ctx, D('live', 102, 'state'), 0);
  await until(clock, () => srv.count('device/turnOff') >= 1, 'off sent', { max: 500 });
  srv.release();
  await assert.rejects(answer(ctx, on), /turn off came after it/);
  await off;
  assert.equal(srv.count('device/turnOn'), 0);
});

test('a stop leaves whatever holds the rest: pause 429, a stuck read, /data unreadable, an unknown device', async (t) => {
  const ctx = await setup(t);
  const { srv, clock, app, gladys } = ctx;
  // A pause after a 429 on the read.
  srv.routes['GET devices/list'] = () =>
    reply(429, { error: 'slow down' }, { 'Retry-After': '120' });
  await clock.advance(TIMINGS.pollDefault + 100);
  await until(clock, () => app.paused(), '429 pause');
  assert.match(status(gladys), /paused/);
  await assert.rejects(answer(ctx, command(ctx, D('live', 101, 'state'), 1)), /slow down/);
  assert.match(await answer(ctx, command(ctx, D('live', 101, 'state'), 0)), /^sent/);
  assert.equal(srv.count('device/turnOn'), 0);
  // The pause holds the reads (Retry-After 120 s) and is in /data.
  const reads = srv.count('devices/list');
  await clock.advance(110_000);
  assert.equal(srv.count('devices/list'), reads);
  assert.ok(ctx.store.data.pause.until > clock.now());
  assert.equal(ctx.store.data.pause.failures, 1);
  delete srv.routes['GET devices/list'];
  await until(clock, () => srv.count('devices/list') === reads + 1, 'read after the pause', {
    step: 100,
    max: 15_000,
  });
  assert.equal(ctx.store.data.pause.failures, 0);

  // A stuck read: the stop cuts it and leaves at once.
  srv.routes['GET devices/list'] = () => 'hang';
  await until(clock, () => srv.hanging === 1, 'stuck read', {
    step: 200,
    max: TIMINGS.pollDefault + 1_000,
  });
  assert.match(await answer(ctx, command(ctx, D('live', 103, 'state'), 0)), /^sent/);
  assert.equal(srv.hanging, 0);
  assert.notEqual(app.lastResult?.kind, 'aborted');

  // An unknown device: the stop still leaves.
  assert.match(await answer(ctx, command(ctx, D('live', 555, 'state'), 0)), /^sent/);
  assert.ok(srv.of('device/turnOff').some((r) => r.query.id === '555'));
});

test('a stop with /data unreadable and the configuration not read yet leaves once the configuration comes', async (t) => {
  const store = memoryStore();
  store.unreadable = true;
  const ctx = await setup(t, { store, connect: false });
  const { srv, clock, gladys, app } = ctx;
  // The first call is the SDK's own (connect); the app's next 1 fail.
  let calls = 0;
  const getConfig = gladys.getConfig.bind(gladys);
  gladys.getConfig = async () => {
    calls += 1;
    if (calls > 1 && calls <= 1 + 1) throw new Error('host API down');
    return getConfig();
  };
  await gladys.connect();
  assert.equal(app.memoryState, 'unreadable');
  const off = command(ctx, D('live', 101, 'state'), 0);
  assert.match(await answer(ctx, off), /configuration is not read/);
  await until(clock, () => srv.count('device/turnOff') === 1, 'off after the config', {
    step: 50,
    max: 10_000,
  });
  // No read while /data is unreadable; reads come when it is.
  assert.equal(srv.count('devices/list'), 0);
  await assert.rejects(answer(ctx, command(ctx, D('live', 101, 'state'), 1)), /\/data not read/);
  store.unreadable = false;
  await until(clock, () => srv.count('devices/list') === 1, 'read once /data is', {
    step: 100,
    max: 12_000,
  });
  // The stop clicked meanwhile is kept, never overwritten by the file.
  assert.ok(store.saves > 0);
});

test('getConfig failing in connected: retried with spacing, exact status, then the reads start', async (t) => {
  const ctx = await setup(t, { connect: false });
  const { srv, clock, gladys } = ctx;
  // The first call is the SDK's own (connect); the app's next 2 fail.
  let calls = 0;
  const getConfig = gladys.getConfig.bind(gladys);
  gladys.getConfig = async () => {
    calls += 1;
    if (calls > 1 && calls <= 1 + 2) throw new Error('host API down');
    return getConfig();
  };
  await gladys.connect();
  assert.match(status(gladys), /could not be read from Gladys; next try in 5 s/);
  await clock.advance(5_100);
  assert.match(status(gladys), /next try in 15 s/);
  assert.equal(srv.count('devices/list'), 0);
  await until(clock, () => srv.count('devices/list') === 1, 'read after the config', {
    step: 100,
    max: 16_000,
  });
  assert.match(status(gladys), /Connected/);
});

test('turning off that cannot be sent: tried again, then reported; never past its budget', async (t) => {
  const ctx = await setup(t);
  const { srv, clock, gladys } = ctx;
  srv.routes['GET device/turnOff'] = () => reply(500, { error: 'oops' });
  assert.match(await answer(ctx, command(ctx, D('live', 101, 'state'), 0)), /without confirmation/);
  await clock.advance(TIMINGS.stopMaxAge + 30_000);
  assert.equal(srv.count('device/turnOff'), TIMINGS.stopAttempts);
  assert.match(status(gladys), /Turning off could not be sent: Lamp/);
  // A 5xx of a command never pauses the reads.
  assert.equal(ctx.app.paused(), false);
});

test('a stop kept in /data goes on after a restart; one older than 2 minutes is dropped', async (t) => {
  const first = await setup(t);
  assert.match(await answer(first, command(first, D('live', 101, 'state'), 0)), /^sent/);
  await first.app.stop();
  assert.equal(first.store.data.stops.length, 1);
  const again = await setup(t, {
    data: first.store.data,
    clock: first.clock,
    srv: first.srv,
    firstRead: false,
  });
  await until(again.clock, () => first.srv.count('device/turnOff') >= 2, 'resend after restart', {
    step: 50,
    max: 5_000,
  });
  const old = await setup(t, {
    data: {
      ...first.store.data,
      stops: [{ mode: 'live', id: '101', at: first.clock.now() - 200_000, sent: 1, attempts: 1 }],
    },
  });
  await old.clock.advance(20_000);
  assert.equal(old.srv.count('device/turnOff'), 0);
});

test('a read showing the device on after our stop: the resends stop (the Telldus app or a remote turned it on)', async (t) => {
  const ctx = await setup(t, { config: { poll_seconds: 60 } });
  const { srv, clock, app } = ctx;
  await clock.advance(TIMINGS.pollDefault - 9_000);
  assert.match(await answer(ctx, command(ctx, D('live', 101, 'state'), 0)), /^sent/);
  await until(clock, () => srv.count('device/turnOff') === 2, 'resend at 3 s', {
    step: 20,
    max: 4_000,
  });
  // Turned on by someone else after the resend: the next read (6 s later) shows it.
  srv.routes['GET devices/list'] = () => ({
    device: srv.data.devices.map((d) => (d.id === '101' ? { ...d, state: 1 } : d)),
  });
  await until(clock, () => srv.count('devices/list') === 2, 'next read', { step: 20, max: 7_000 });
  await until(clock, () => app.stops.size === 0, 'resends cancelled', { step: 20, max: 500 });
  await clock.advance(15_000);
  assert.equal(srv.count('device/turnOff'), 2);
});

test('401 on the device list: refused, kept in /data, no try on its own; new keys read again', async (t) => {
  const ctx = await setup(t);
  const { srv, clock, gladys, app } = ctx;
  srv.routes['GET devices/list'] = () => reply(401, { error: 'OAuth Verification Failed' });
  await clock.advance(TIMINGS.pollDefault + 100);
  await until(clock, () => app.refused(), 'refusal');
  assert.match(status(gladys), /refused the keys/);
  assert.equal(ctx.store.data.auth.refused, true);
  assert.equal(typeof ctx.store.data.auth.mark, 'number');
  const reads = srv.count('devices/list');
  await clock.advance(10 * TIMINGS.pollDefault);
  assert.equal(srv.count('devices/list'), reads);
  // A stop is not sent with refused keys.
  assert.match(
    await answer(ctx, command(ctx, D('live', 101, 'state'), 0)),
    /refused these credentials/,
  );
  // A restart keeps the refusal.
  await app.stop();
  const again = await setup(t, { data: ctx.store.data, srv, clock, firstRead: false });
  await clock.advance(2 * TIMINGS.pollDefault);
  assert.equal(srv.count('devices/list'), reads);
  // New keys: read at once.
  delete srv.routes['GET devices/list'];
  await again.gladys.fake.configUpdated({ ...again.config, token: 'TOKEN-live-NEW' });
  await until(clock, () => srv.count('devices/list') === reads + 1, 'read with new keys', {
    max: 500,
  });
  assert.match(status(again.gladys), /Connected/);
});

test('the test button lifts a refusal only on success', async (t) => {
  const ctx = await setup(t);
  const { srv, clock, app } = ctx;
  srv.routes['GET devices/list'] = () => reply(401, {});
  await clock.advance(TIMINGS.pollDefault + 100);
  await until(clock, () => app.refused(), 'refusal');
  await clock.advance(TIMINGS.testSpacing);
  assert.match((await answer(ctx, app.testConnection())).en, /refused the keys/);
  assert.equal(app.refused(), true);
  delete srv.routes['GET devices/list'];
  await clock.advance(TIMINGS.testSpacing);
  assert.match(
    (await answer(ctx, app.testConnection())).en,
    /Connection works: 3 devices, 1 sensors\. Telldus ids: 101 Lamp \(on\/off, safe\)/,
  );
  assert.equal(app.refused(), false);
  assert.equal(ctx.store.data.auth.refused, false);
});

test('401 on the sensors only: never a refusal; devices still read, sensors spaced out', async (t) => {
  const ctx = await setup(t, { firstRead: false });
  const { srv, clock, gladys, app } = ctx;
  srv.routes['GET sensors/list'] = () => reply(403, { error: 'forbidden' });
  await until(clock, () => app.lastResult, 'first read');
  assert.equal(app.refused(), false);
  assert.match(status(gladys), /Connected.*sensors not read/);
  await clock.advance(TIMINGS.pollDefault + 100);
  await until(clock, () => srv.count('devices/list') === 2, 'second read');
  assert.equal(srv.count('sensors/list'), 1); // spaced: 2 intervals after one refusal
  assert.match(await answer(ctx, command(ctx, D('live', 101, 'state'), 1)), /^sent/);
});

test('401 on a command: not a refusal of the keys, reads go on', async (t) => {
  const ctx = await setup(t);
  const { srv, clock, app } = ctx;
  srv.routes['GET device/turnOn'] = () => reply(401, {});
  await assert.rejects(answer(ctx, command(ctx, D('live', 101, 'state'), 1)), /HTTP 401/);
  assert.equal(app.refused(), false);
  await clock.advance(TIMINGS.pollDefault + 100);
  await until(clock, () => srv.count('devices/list') === 2, 'read goes on');
});

test('a command 5xx on one device: the others still go', async (t) => {
  const ctx = await setup(t);
  const { srv } = ctx;
  srv.routes['GET device/turnOn'] = (r) =>
    r.query.id === '101' ? reply(503, {}) : { status: 'success' };
  await assert.rejects(answer(ctx, command(ctx, D('live', 101, 'state'), 1)), /HTTP 503/);
  assert.match(await answer(ctx, command(ctx, D('live', 102, 'state'), 1)), /^sent/);
});

test('a scene on 5 slow targets sets them all', async (t) => {
  const ctx = await setup(t, { config: { safe_devices: '101 102 103 104 105' } });
  const { srv } = ctx;
  srv.data.devices.push(
    { id: '104', name: 'Four', methods: 3, state: 2, type: 'device' },
    { id: '105', name: 'Five', methods: 3, state: 2, type: 'device' },
  );
  await ctx.clock.advance(TIMINGS.pollDefault + 100);
  await until(ctx.clock, () => ctx.app.devices.size === 5, 'five devices');
  srv.latencyMs = 700;
  const ids = ['101', '102', '103', '104', '105'];
  const ons = await Promise.all(ids.map((id) => command(ctx, D('live', id, 'state'), 1)));
  assert.ok(
    ons.every((o) => /^sent/.test(o)),
    ons.join(' | '),
  );
  const offs = await Promise.all(ids.map((id) => command(ctx, D('live', id, 'state'), 0)));
  assert.ok(
    offs.every((o) => /^sent/.test(o)),
    offs.join(' | '),
  );
});

test('sensor values: older than 2 h, without a date, in the future or text are never published; never twice after a restart', async (t) => {
  const extra = ['202', '203', '204'].map((id) => ({
    name: id,
    external_id: S('live', id),
    features: [
      {
        external_id: S('live', id, 'temperature'),
        category: 'temperature-sensor',
        type: 'decimal',
      },
    ],
  }));
  // The sensors exist in Gladys from the start (values are sent for created features only).
  const first = await setup(t, { firstRead: false, devices: [...createdDevices(), ...extra] });
  const { srv, clock, gladys } = first;
  const s = () => Math.floor(clock.now() / 1000);
  srv.data.sensors = [
    {
      id: '201',
      name: 'Outdoor',
      lastUpdated: s() - 60,
      data: [
        { name: 'temp', value: '12.5', scale: '0' },
        { name: 'humidity', value: '', scale: '0' },
      ],
    },
    {
      id: '202',
      name: 'Old',
      lastUpdated: s() - 3 * 3600,
      data: [{ name: 'temp', value: '9', scale: '0' }],
    },
    {
      id: '203',
      name: 'Future',
      lastUpdated: s() + 3600,
      data: [{ name: 'temp', value: '9', scale: '0' }],
    },
    { id: '204', name: 'No date', data: [{ name: 'temp', value: '9', scale: '0' }] },
  ];
  await until(clock, () => first.app.lastResult, 'read');
  await flush(first);
  assert.deepEqual(statesOf(gladys, S('live', 201, 'temperature')), [12.5]);
  assert.deepEqual(statesOf(gladys, S('live', 201, 'humidity')), []);
  for (const id of ['202', '203', '204'])
    assert.deepEqual(statesOf(gladys, S('live', id, 'temperature')), []);
  // Same source date after a restart: not published again.
  await first.app.stop();
  const again = await setup(t, { data: first.store.data, srv, clock, firstRead: false });
  await clock.advance(TIMINGS.pollDefault + 2_000);
  assert.equal(srv.count('devices/list'), 2);
  await flush(again);
  assert.deepEqual(statesOf(again.gladys, S('live', 201, 'temperature')), []);
});

test('an answer too large is cut and refused, never parsed', async (t) => {
  const ctx = await setup(t, { firstRead: false });
  const { srv, clock, app, gladys } = ctx;
  srv.routes['GET devices/list'] = () => ({ device: [], pad: 'x'.repeat(600 * 1024) });
  await until(clock, () => app.lastResult, 'read');
  assert.equal(app.lastResult.kind, 'bad');
  assert.match(status(gladys), /unreadable/);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
});

test('a reconnection republishes status and Discovery, never an old state as new', async (t) => {
  const ctx = await setup(t);
  const { gladys, clock } = ctx;
  await flush(ctx);
  const states = gladys.fake.states.length;
  const discoveries = gladys.fake.requests.filter((r) => r.path === '/discovered_device').length;
  await gladys.disconnect();
  await gladys.connect();
  await clock.advance(5_000);
  assert.equal(gladys.fake.states.length, states);
  assert.equal(
    gladys.fake.requests.filter((r) => r.path === '/discovered_device').length,
    discoveries + 1,
  );
  assert.match(status(gladys), /Connected/);
  await gladys.fake.deviceCreated(gladys.fake.devices[0]);
  await clock.advance(5_000);
  assert.equal(gladys.fake.states.length, states);
});

test('no key or token ever in the logs, the status, the actions or /data', async (t) => {
  const ctx = await setup(t);
  const { srv, clock, gladys, app, logger } = ctx;
  srv.routes['GET devices/list'] = () =>
    reply(200, { error: `bad token ${KEYS.token} ${KEYS.private_key}` });
  await clock.advance(TIMINGS.pollDefault + 100);
  await until(clock, () => app.lastResult?.ok === false, 'refused answer');
  srv.routes['GET device/turnOn'] = () => ({ error: `nope ${KEYS.token_secret}` });
  await assert.rejects(answer(ctx, command(ctx, D('live', 101, 'state'), 1)));
  const texts = [
    JSON.stringify(ctx.store.data),
    JSON.stringify(gladys.fake.connectionStatuses),
    logger.lines.join('\n'),
    JSON.stringify(await answer(ctx, app.testConnection())),
  ].join('\n');
  for (const secret of Object.values(KEYS)) assert.ok(!texts.includes(secret), secret);
});

test('a read that left before a command never publishes its older state over the command', async (t) => {
  const ctx = await setup(t);
  const { srv, clock, gladys } = ctx;
  await flush(ctx);
  let send;
  srv.routes['GET devices/list'] = () => {
    const snapshot = structuredClone(srv.data.devices);
    return new Promise((resolve) => (send = () => resolve({ device: snapshot })));
  };
  await clock.advance(TIMINGS.pollDefault + 100);
  await until(clock, () => send, 'read in flight');
  assert.match(await answer(ctx, command(ctx, D('live', 101, 'state'), 1)), /^sent/);
  send();
  await until(clock, () => ctx.app.lastResult?.ok && srv.count('sensors/list') === 2, 'read done');
  await flush(ctx);
  assert.deepEqual(statesOf(gladys, D('live', 101, 'state')), [0, 1]);
});

test('the device list older than 15 minutes: turning on refused, turning off still sent', async (t) => {
  const ctx = await setup(t);
  const { srv, clock } = ctx;
  srv.routes['GET devices/list'] = () => 'drop';
  await clock.advance(TIMINGS.listMaxAge + 1_000);
  await assert.rejects(answer(ctx, command(ctx, D('live', 101, 'state'), 1)), /too old/);
  assert.match(await answer(ctx, command(ctx, D('live', 101, 'state'), 0)), /^sent/);
});

test('the time of a read attempt is in /data before the read, even when the read fails', async (t) => {
  const ctx = await setup(t, { firstRead: false });
  const { srv, clock, store } = ctx;
  srv.routes['GET devices/list'] = () => 'drop';
  await until(clock, () => ctx.app.lastResult, 'failed read');
  assert.equal(ctx.app.lastResult.ok, false);
  assert.ok(store.data.lastAttempt > 0);
});

test('a stop waiting more than 2 minutes for the configuration is dropped, never sent late', async (t) => {
  const ctx = await setup(t, { connect: false });
  const { srv, clock, gladys, app } = ctx;
  let calls = 0;
  const getConfig = gladys.getConfig.bind(gladys);
  gladys.getConfig = async () => {
    calls += 1;
    if (calls > 1 && calls <= 5) throw new Error('host API down');
    return getConfig();
  };
  await gladys.connect();
  assert.match(
    await answer(ctx, command(ctx, D('live', 101, 'state'), 0)),
    /configuration is not read/,
  );
  await until(clock, () => app.config, 'configuration', { step: 1_000, max: 500_000 });
  await clock.advance(5_000);
  assert.equal(srv.count('device/turnOff'), 0);
  assert.equal(app.stops.size, 0);
});

test('the safe list is read again just before the send, after a wait in the lane of the device', async (t) => {
  const ctx = await setup(t);
  const { srv, clock, gladys } = ctx;
  srv.routes['GET device/dim'] = () => 'hang';
  const dim = command(ctx, D('live', 102, 'brightness'), 30);
  dim.catch(() => {});
  await until(clock, () => srv.count('device/dim') === 1, 'dim in flight', { max: 200 });
  const on = command(ctx, D('live', 102, 'state'), 1);
  on.catch(() => {});
  await clock.advance(50);
  await gladys.fake.configUpdated({ ...ctx.config, safe_devices: '101' });
  srv.release();
  await assert.rejects(answer(ctx, on), /not declared safe/);
  assert.equal(srv.count('device/turnOn'), 0);
});

test('a command stuck on one device never holds a command of another', async (t) => {
  const ctx = await setup(t);
  const { srv, clock } = ctx;
  srv.routes['GET device/turnOn'] = (r) => (r.query.id === '101' ? 'hang' : { status: 'success' });
  const stuck = command(ctx, D('live', 101, 'state'), 1);
  stuck.catch(() => {});
  await until(clock, () => srv.count('device/turnOn') === 1, 'first on in flight', { max: 200 });
  assert.match(await answer(ctx, command(ctx, D('live', 102, 'state'), 1)), /^sent/);
  srv.release();
});
