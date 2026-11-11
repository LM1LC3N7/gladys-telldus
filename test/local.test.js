// -----------------------------------------------------------------------------
// The local API of a TellStick ZNet / Net v2: the token granted in the
// browser, its renewal, the Bearer reads, a refused token.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMINGS } from '../src/constants.js';
import { mark } from '../src/store.js';
import { reply } from './helpers/fakeTelldus.js';
import {
  D,
  LOCAL_TOKEN,
  answer,
  command,
  memoryLogger,
  setup,
  status,
  until,
} from './helpers/app.js';

test('local: reads with the Bearer token on /api/, commands too', async (t) => {
  const ctx = await setup(t, { mode: 'local' });
  const { srv, gladys } = ctx;
  const req = srv.of('devices/list')[0];
  assert.equal(req.headers.authorization, `Bearer ${LOCAL_TOKEN}`);
  assert.match(status(gladys), /Connected to the TellStick: 3 devices/);
  assert.match(await answer(ctx, command(ctx, D('local', 101, 'state'), 1)), /^sent/);
  assert.equal(srv.of('device/turnOn')[0].headers.authorization, `Bearer ${LOCAL_TOKEN}`);
  await assert.rejects(
    answer(ctx, command(ctx, D('live', 101, 'state'), 1)),
    /other connection mode/,
  );
  assert.match(
    await answer(ctx, command(ctx, D('live', 101, 'state'), 0)),
    /other connection mode/,
  );
  assert.equal(srv.count('device/turnOff'), 0);
});

test('local access: request, accept in the browser, finish; the token goes to the configuration, never to /data', async (t) => {
  const logger = memoryLogger();
  const ctx = await setup(t, {
    mode: 'local',
    config: { local_token: '' },
    firstRead: false,
    logger,
  });
  const { srv, clock, gladys, app } = ctx;
  await clock.advance(1_000);
  assert.equal(srv.count('devices/list'), 0);
  assert.match(status(gladys), /No local token yet/);
  let accepted = false;
  const s = () => Math.floor(clock.now() / 1000);
  srv.routes['PUT token'] = () => ({
    authUrl: `http://${srv.host}/api/authorize?token=REQ-0001`,
    token: 'REQ-0001',
  });
  srv.routes['GET token'] = (r) =>
    accepted && r.query.token === 'REQ-0001'
      ? { token: 'GRANTED-local-0001', expires: s() + 30 * 86400, allowRenew: true }
      : { error: 'Request token not authorized' };
  assert.match((await answer(ctx, app.finishLocalAccess())).en, /Request local access" first/);
  const asked = await answer(ctx, app.requestLocalAccess());
  assert.match(asked.en, /authorize\?token=REQ-0001/);
  const put = srv.of('token')[0];
  assert.equal(put.method, 'PUT');
  assert.equal(put.body, 'app=Gladys+Assistant');
  assert.equal(put.headers.authorization, undefined);
  assert.match((await answer(ctx, app.finishLocalAccess())).en, /Not accepted yet/);
  accepted = true;
  assert.match(
    (await answer(ctx, app.finishLocalAccess())).en,
    /Local access granted and saved in Gladys/,
  );
  assert.equal(gladys.fake.config.local_token, 'GRANTED-local-0001');
  await until(clock, () => srv.count('devices/list') === 1, 'read with the new token');
  assert.equal(srv.of('devices/list')[0].headers.authorization, 'Bearer GRANTED-local-0001');
  const kept = JSON.stringify(ctx.store.data);
  for (const secret of ['GRANTED-local-0001', 'REQ-0001']) {
    assert.ok(!kept.includes(secret));
    assert.ok(!logger.lines.join('\n').includes(secret));
    assert.ok(!JSON.stringify(gladys.fake.connectionStatuses).includes(secret));
  }
  assert.equal(ctx.store.data.token.renew, true);
});

test('local token renewed a week before it expires, saved in Gladys; not when Gladys cannot save it, kept in memory', async (t) => {
  const clockStart = Date.UTC(2026, 10, 11, 10);
  const salt = 'ab'.repeat(16);
  const data = {
    salt,
    token: { mark: mark(salt, LOCAL_TOKEN), expires: clockStart + 3 * 86_400_000, renew: true },
  };
  const ctx = await setup(t, { mode: 'local', data, firstRead: false });
  const { srv, clock, gladys, app } = ctx;
  let fail = true;
  const setConfig = gladys.setConfig.bind(gladys);
  gladys.setConfig = async (c) => {
    if (fail) throw new Error('host API down');
    return setConfig(c);
  };
  srv.routes['GET refreshToken'] = (r) =>
    r.headers.authorization === `Bearer ${LOCAL_TOKEN}` ||
    r.headers.authorization === 'Bearer RENEWED-0001'
      ? { token: 'RENEWED-0001', expires: Math.floor(clock.now() / 1000) + 365 * 86400 }
      : reply(401, {});
  await until(clock, () => app.lastResult, 'first read');
  assert.equal(srv.count('refreshToken'), 1);
  assert.equal(srv.of('devices/list')[0].headers.authorization, 'Bearer RENEWED-0001');
  assert.match(status(gladys), /renewed but Gladys did not save it/);
  fail = false;
  await app.saveToken();
  assert.equal(gladys.fake.config.local_token, 'RENEWED-0001');
  // Not renewed again: it expires in a year now.
  await clock.advance(TIMINGS.pollDefault + 500);
  await until(clock, () => srv.count('devices/list') === 2, 'second read');
  assert.equal(srv.count('refreshToken'), 1);
  assert.ok(!JSON.stringify(ctx.store.data).includes('RENEWED-0001'));
});

test('local: 401 on the device list is a refused token; requesting a new access lifts it', async (t) => {
  const ctx = await setup(t, { mode: 'local', firstRead: false });
  const { srv, clock, gladys, app } = ctx;
  srv.routes['GET devices/list'] = () => reply(401, { error: 'expired' });
  await until(clock, () => app.refused(), 'refusal');
  assert.match(status(gladys), /refused the local token/);
  delete srv.routes['GET devices/list'];
  srv.routes['PUT token'] = () => ({
    authUrl: `http://${srv.host}/api/authorize?token=R2`,
    token: 'R2-xx',
  });
  srv.routes['GET token'] = () => ({ token: 'FRESH-local-0002', expires: 0 });
  await answer(ctx, app.requestLocalAccess());
  await answer(ctx, app.finishLocalAccess());
  await until(clock, () => app.lastResult?.ok, 'read with the fresh token');
  assert.equal(app.refused(), false);
});

test('local: the address is checked (no broadcast, multicast, 0.0.0.0, loopback, path)', async (t) => {
  for (const host of [
    '0.0.0.0',
    '192.168.1.255',
    '224.0.0.1',
    '127.0.0.1',
    'localhost',
    '10.0.0.1/api',
    'a b',
  ]) {
    const ctx = await setup(t, { mode: 'local', config: { host }, firstRead: false });
    await ctx.clock.advance(1_000);
    assert.match(status(ctx.gladys), /address of the TellStick/, host);
    assert.equal(ctx.srv.requests.length, 0);
  }
});

test('local: a token not the one whose expiry is known is never renewed', async (t) => {
  const salt = 'ab'.repeat(16);
  const data = {
    salt,
    token: { mark: (mark(salt, LOCAL_TOKEN) + 1) % 64, expires: 1, renew: true },
  };
  const ctx = await setup(t, { mode: 'local', data });
  assert.equal(ctx.srv.count('refreshToken'), 0);
  assert.equal(ctx.app.lastResult.ok, true);
});

test('local: a renewal not saved yet is saved again at the next read; a token typed meanwhile wins', async (t) => {
  const clockStart = Date.UTC(2026, 10, 11, 10);
  const salt = 'ab'.repeat(16);
  const data = {
    salt,
    token: { mark: mark(salt, LOCAL_TOKEN), expires: clockStart + 86_400_000, renew: true },
  };
  const ctx = await setup(t, { mode: 'local', data, firstRead: false });
  const { srv, clock, gladys, app } = ctx;
  let fail = true;
  const setConfig = gladys.setConfig.bind(gladys);
  gladys.setConfig = async (c) => {
    if (fail) throw new Error('host API down');
    return setConfig(c);
  };
  srv.routes['GET refreshToken'] = () => ({ token: 'RENEWED-0002', expires: 0 });
  await until(clock, () => app.lastResult, 'first read');
  // Another field saved with the old token: the renewed one stays in use.
  await gladys.fake.configUpdated({ ...ctx.config, safe_devices: '101' });
  assert.equal(app.config.local.token, 'RENEWED-0002');
  fail = false;
  await clock.advance(TIMINGS.pollDefault + 500);
  await until(clock, () => srv.count('devices/list') === 2, 'second read');
  assert.equal(gladys.fake.config.local_token, 'RENEWED-0002');
  // A token typed by the user wins.
  await gladys.fake.configUpdated({ ...ctx.config, local_token: 'TYPED-0003' });
  assert.equal(app.config.local.token, 'TYPED-0003');
});
