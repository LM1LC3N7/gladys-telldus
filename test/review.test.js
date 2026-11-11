// -----------------------------------------------------------------------------
// The points of review r1: monotonic stop ages (I1), one timer per stop and
// nothing after stop() (I2), refusal lifted by new credentials (I3), and one
// test per guard the reviewer's mutants broke (I4), with the minor points.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMINGS } from '../src/constants.js';
import { HttpError } from '../src/http.js';
import { memoryStore } from '../src/store.js';
import { reply } from './helpers/fakeTelldus.js';
import { D, answer, command, flush, setup, statesOf, until } from './helpers/app.js';

for (const jump of [-60_000, 3_600_000]) {
  test(`I1: a wall clock jump of ${jump / 1000} s during an outage never drops a stop`, async (t) => {
    const wallOffset = { ms: 0 };
    const ctx = await setup(t, { wallOffset });
    const { srv, clock } = ctx;
    srv.routes['GET device/turnOff'] = () => reply(503, {});
    await answer(ctx, command(ctx, D('live', 101, 'state'), 0));
    await clock.advance(500);
    wallOffset.ms = jump;
    await clock.advance(TIMINGS.stopMaxAge + 10_000);
    assert.equal(srv.count('device/turnOff'), TIMINGS.stopAttempts);
  });
}

test('I1: a stop kept in /data is placed by its wall date, bounded; its age then goes on monotonic', async (t) => {
  const first = await setup(t);
  first.srv.routes['GET device/turnOff'] = () => reply(503, {});
  await answer(first, command(first, D('live', 101, 'state'), 0));
  await first.app.stop();
  const wallOffset = { ms: 0 };
  const again = await setup(t, {
    data: first.store.data,
    clock: first.clock,
    srv: first.srv,
    firstRead: false,
    wallOffset,
  });
  await again.clock.advance(1_000);
  wallOffset.ms = -3_600_000;
  await again.clock.advance(30_000);
  // Still tried after the jump (sent 1 before the restart, then every 10 s).
  assert.ok(first.srv.count('device/turnOff') >= 4);
});

test('I2: a failed first send planned twice keeps one timer; nothing leaves after stop()', async (t) => {
  let fail = 2;
  const ctx = await setup(t, {
    inject: (url) =>
      url.includes('turnOff') && fail-- > 0
        ? new HttpError('network', false, 'ECONNREFUSED')
        : undefined,
  });
  const { srv, clock, app } = ctx;
  const off = command(ctx, D('live', 101, 'state'), 0);
  await clock.advance(300);
  await app.stop();
  assert.match(await off, /nothing sent yet/);
  await clock.advance(60_000);
  assert.equal(srv.count('device/turnOff'), 0);
  assert.equal(clock.pending, 0, 'no timer left');
});

test('I2: stop() cancels the resend timers', async (t) => {
  const ctx = await setup(t);
  const { srv, clock, app } = ctx;
  assert.match(await answer(ctx, command(ctx, D('live', 101, 'state'), 0)), /^sent/);
  await app.stop();
  assert.equal(clock.pending, 0, 'no timer left');
  await clock.advance(20_000);
  assert.equal(srv.count('device/turnOff'), 1);
});

test('I2: an answer that comes after stop() plans nothing', async (t) => {
  const ctx = await setup(t);
  const { srv, clock, app } = ctx;
  srv.routes['GET device/turnOff'] = () => 'hang';
  const off = command(ctx, D('live', 101, 'state'), 0);
  off.catch(() => {});
  await until(clock, () => srv.count('device/turnOff') === 1, 'off in flight', { max: 200 });
  await app.stop();
  srv.release();
  await until(clock, () => clock.pending === 0, 'no timer left', { max: 2_000 });
  await clock.advance(20_000);
  assert.equal(srv.count('device/turnOff'), 1);
});

test('I3: new credentials are always tried, whatever the mark of the refused ones', async (t) => {
  const ctx = await setup(t);
  const { srv, clock, gladys, app } = ctx;
  srv.routes['GET devices/list'] = () => reply(401, {});
  await clock.advance(TIMINGS.pollDefault + 100);
  await until(clock, () => app.refused(), 'refusal');
  delete srv.routes['GET devices/list'];
  const reads = srv.count('devices/list');
  const next = { ...ctx.config, token: 'TOKEN-live-OTHER' };
  // Forced collision: the kept mark is the one of the new keys.
  const { credentialsText, normalizeConfig } = await import('../src/config.js');
  const { mark } = await import('../src/store.js');
  app.memory.auth.mark = mark(app.memory.salt, credentialsText(normalizeConfig(next)));
  await gladys.fake.configUpdated(next);
  await until(clock, () => srv.count('devices/list') === reads + 1, 'read with the new keys', {
    max: 500,
  });
  assert.equal(app.refused(), false);
  assert.equal(ctx.store.data.auth.refused, false);
});

test('I4: a resend due while a newer turn on is on its way waits for its answer (2xx: no resend)', async (t) => {
  const ctx = await setup(t);
  const { srv, clock } = ctx;
  assert.match(await answer(ctx, command(ctx, D('live', 101, 'state'), 0)), /^sent/);
  let send;
  srv.routes['GET device/turnOn'] = () =>
    new Promise((resolve) => (send = () => resolve({ status: 'success' })));
  const on = command(ctx, D('live', 101, 'state'), 1);
  on.catch(() => {});
  await until(clock, () => send, 'on in flight', { max: 2_000 });
  await clock.advance(4_000); // the 3 s resend is due meanwhile
  assert.equal(srv.count('device/turnOff'), 1);
  send();
  await clock.advance(20_000);
  assert.equal(srv.count('device/turnOff'), 1);
  assert.deepEqual(
    srv.requests.filter((r) => r.path.startsWith('device/')).map((r) => r.path),
    ['device/turnOff', 'device/turnOn'],
  );
});

test('I4: a resend waiting for a turn on that Telldus refuses still leaves', async (t) => {
  const ctx = await setup(t);
  const { srv, clock } = ctx;
  assert.match(await answer(ctx, command(ctx, D('live', 101, 'state'), 0)), /^sent/);
  let send;
  srv.routes['GET device/turnOn'] = () =>
    new Promise((resolve) => (send = () => resolve(reply(429, {}))));
  const on = command(ctx, D('live', 101, 'state'), 1);
  on.catch(() => {});
  await until(clock, () => send, 'on in flight', { max: 2_000 });
  await clock.advance(4_000);
  send();
  await until(clock, () => srv.count('device/turnOff') === 2, 'resend after the refused on', {
    max: 2_000,
  });
});

test('I4: one send of a stop at a time (a configuration saved during a send sends nothing more)', async (t) => {
  const ctx = await setup(t);
  const { srv, clock, gladys } = ctx;
  srv.routes['GET device/turnOff'] = () => 'hang';
  const off = command(ctx, D('live', 101, 'state'), 0);
  off.catch(() => {});
  await until(clock, () => srv.count('device/turnOff') === 1, 'off in flight', { max: 200 });
  await gladys.fake.configUpdated({ ...ctx.config, safe_devices: '102' });
  await clock.advance(100);
  assert.equal(srv.count('device/turnOff'), 1);
  srv.release();
});

test('I4: 429 or 5xx on the sensors pauses the reads', async (t) => {
  for (const status of [429, 503]) {
    const ctx = await setup(t, { firstRead: false });
    ctx.srv.routes['GET sensors/list'] = () => reply(status, {});
    await until(ctx.clock, () => ctx.app.lastResult, 'read');
    assert.equal(ctx.app.paused(), true, String(status));
  }
});

test('I4: a 429 on a command pauses the account (a stop still leaves)', async (t) => {
  const ctx = await setup(t);
  const { srv, app } = ctx;
  srv.routes['GET device/turnOn'] = () => reply(429, {}, { 'Retry-After': '30' });
  await assert.rejects(answer(ctx, command(ctx, D('live', 101, 'state'), 1)), /HTTP 429/);
  assert.equal(app.paused(), true);
  assert.match(await answer(ctx, command(ctx, D('live', 101, 'state'), 0)), /^sent/);
});

test('I4 and M5: a read that left less than 3 s after a send never cancels the resends', async (t) => {
  const ctx = await setup(t);
  const { srv, clock, app } = ctx;
  await clock.advance(TIMINGS.pollDefault - 1_000);
  assert.match(await answer(ctx, command(ctx, D('live', 101, 'state'), 0)), /^sent/);
  // Telldus Live still shows the old state just after the stop.
  srv.routes['GET devices/list'] = () => ({
    device: srv.data.devices.map((d) => (d.id === '101' ? { ...d, state: 1 } : d)),
  });
  await until(clock, () => srv.count('devices/list') === 2, 'read 1 s after the send', {
    max: 2_000,
  });
  await until(clock, () => srv.count('device/turnOff') === 3, 'both resends', {
    step: 50,
    max: 12_000,
  });
  assert.equal(app.stops.size, 0);
});

test('I4: a first send that cannot leave is tried again within 250 ms, in the ack budget', async (t) => {
  let fail = 1;
  const ctx = await setup(t, {
    inject: (url) =>
      url.includes('turnOff') && fail-- > 0
        ? new HttpError('network', false, 'ECONNRESET')
        : undefined,
  });
  assert.match(await answer(ctx, command(ctx, D('live', 101, 'state'), 0)), /^sent/);
  assert.equal(ctx.srv.count('device/turnOff'), 1);
});

test('I4 and M3: two connections during a slow /data: one load, one configuration read, the reads start', async (t) => {
  let release;
  const inner = memoryStore();
  const store = {
    ...inner,
    load: () => new Promise((resolve) => (release = () => resolve(null))),
    save: (d) => inner.save(d),
  };
  const ctx = await setup(t, { store, connect: false });
  const { srv, clock, gladys, app } = ctx;
  let calls = 0;
  const getConfig = gladys.getConfig.bind(gladys);
  gladys.getConfig = async () => {
    calls += 1;
    return getConfig();
  };
  const first = app.connected();
  await clock.advance(100);
  const second = app.connected();
  await clock.advance(100);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  await until(clock, () => srv.count('devices/list') === 1, 'first read', { max: 1_000 });
});

test('M2: a stop refused by Telldus says so, and is tried again', async (t) => {
  const ctx = await setup(t);
  const { srv, clock } = ctx;
  srv.routes['GET device/turnOff'] = () => reply(403, {});
  assert.match(
    await answer(ctx, command(ctx, D('live', 101, 'state'), 0)),
    /refused by Telldus \(HTTP 403\)/,
  );
  await until(clock, () => srv.count('device/turnOff') === 2, 'tried again', {
    step: 100,
    max: 11_000,
  });
});

test('M4: a turn on answered after a newer stop never shows ON', async (t) => {
  const ctx = await setup(t);
  const { srv, clock, gladys } = ctx;
  await flush(ctx);
  let send;
  srv.routes['GET device/turnOn'] = () =>
    new Promise((resolve) => (send = () => resolve({ status: 'success' })));
  const on = command(ctx, D('live', 101, 'state'), 1);
  on.catch(() => {});
  await until(clock, () => send, 'on in flight', { max: 2_000 });
  assert.match(await answer(ctx, command(ctx, D('live', 101, 'state'), 0)), /^sent/);
  send();
  await answer(ctx, on);
  await flush(ctx);
  assert.equal(statesOf(gladys, D('live', 101, 'state')).at(-1), 0);
});

test('I2: two plans of one stop leave one timer: one try 10 s later, not two', async (t) => {
  let fail = 2;
  const ctx = await setup(t, {
    inject: (url) =>
      url.includes('turnOff') && fail-- > 0
        ? new HttpError('network', false, 'ECONNREFUSED')
        : undefined,
  });
  const { srv, clock } = ctx;
  srv.routes['GET device/turnOff'] = () => reply(503, {});
  assert.match(await answer(ctx, command(ctx, D('live', 101, 'state'), 0)), /nothing sent yet/);
  await clock.advance(10_600);
  assert.equal(srv.count('device/turnOff'), 1);
});

test('I5: after a restart, a mark is a hint only: a stop is sent; the test button tries and its success clears the mark', async (t) => {
  const first = await setup(t);
  first.srv.routes['GET devices/list'] = () => reply(401, {});
  await first.clock.advance(TIMINGS.pollDefault + 100);
  await until(first.clock, () => first.app.refused(), 'refusal');
  // In session, the refusal is proven: the stop is not sent with these keys.
  assert.match(
    await answer(first, command(first, D('live', 101, 'state'), 0)),
    /refused these credentials/,
  );
  await first.app.stop();
  delete first.srv.routes['GET devices/list'];
  // Restart: same mark (a collision, or the same keys), no proof in memory.
  const again = await setup(t, {
    data: first.store.data,
    srv: first.srv,
    clock: first.clock,
    firstRead: false,
  });
  assert.equal(again.app.refused(), true);
  assert.match(await answer(again, command(again, D('live', 101, 'state'), 0)), /^sent/);
  assert.equal(first.srv.count('device/turnOff'), 1);
  const text = await answer(again, again.app.testConnection());
  assert.match(text.en, /Connection works/);
  assert.equal(again.app.refused(), false);
  assert.equal(again.store.data.auth.refused, false);
});
