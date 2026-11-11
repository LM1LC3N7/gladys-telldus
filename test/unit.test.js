// -----------------------------------------------------------------------------
// Pure parts: OAuth 1 signature, configuration, model, /data, HTTP bounds.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { oauthHeader, retryAfterMs } from '../src/api.js';
import { normalizeConfig, parseHost, parseSafe } from '../src/config.js';
import { TIMINGS } from '../src/constants.js';
import { request } from '../src/http.js';
import {
  buildDevice,
  buildSensor,
  commandOf,
  parseDevices,
  parseExternalId,
  parseSensors,
  sensorValue,
  stateOf,
} from '../src/model.js';
import { emptyMemory, mark, normalizeMemory, serializeMemory } from '../src/store.js';

test('OAuth 1 HMAC-SHA1: the RFC example signature', () => {
  // The worked example of the Twitter documentation (RFC 5849 signing).
  const header = oauthHeader(
    'POST',
    'https://api.twitter.com/1.1/statuses/update.json',
    { include_entities: 'true', status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
    {
      publicKey: 'xvz1evFS4wEEPTGEFPHBog',
      privateKey: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
      token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
      tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    },
    { nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', timestamp: 1318622958 },
  );
  assert.match(header, /oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"/);
});

test('Retry-After: seconds or a date against the Date header', () => {
  assert.equal(retryAfterMs({ 'retry-after': '120' }), 120_000);
  assert.equal(
    retryAfterMs({
      'retry-after': 'Wed, 11 Nov 2026 10:02:00 GMT',
      date: 'Wed, 11 Nov 2026 10:00:00 GMT',
    }),
    120_000,
  );
  assert.equal(retryAfterMs({ 'retry-after': 'Wed, 11 Nov 2026 10:02:00 GMT' }), undefined);
  assert.equal(retryAfterMs({}), undefined);
});

test('configuration: the missing keys are named, never their values; the interval is bounded per mode', () => {
  const live = normalizeConfig({
    mode: 'live',
    public_key: 'abc',
    private_key: 'bad key with spaces',
  });
  assert.deepEqual(live.errors, ['private_key', 'token', 'token_secret']);
  assert.ok(!JSON.stringify(live.errors).includes('abc'));
  assert.equal(live.pollMs, 60_000);
  assert.equal(normalizeConfig({ mode: 'live', poll_seconds: 10 }).pollMs, TIMINGS.pollMinLive);
  assert.equal(
    normalizeConfig({ mode: 'local', host: '192.168.1.4', poll_seconds: 10 }).pollMs,
    10_000,
  );
  assert.equal(
    normalizeConfig({ mode: 'local', host: '192.168.1.4', poll_seconds: 99999 }).pollMs,
    TIMINGS.pollMax,
  );
  assert.equal(
    normalizeConfig({ mode: 'local', host: '192.168.1.4', poll_seconds: 1.5 }).pollMs,
    60_000,
  );
  assert.equal(normalizeConfig({ mode: 'other' }).mode, 'live');
  const local = normalizeConfig({ mode: 'local', host: 'tellstick.lan', local_token: 'a\r\nb' });
  assert.deepEqual(local.errors, ['local_token']);
  assert.deepEqual(normalizeConfig({ mode: 'local', host: 'tellstick.lan' }).errors, []);
});

test('the TellStick address: one LAN host, never broadcast, multicast, 0.0.0.0, loopback, a path or a port out of range', () => {
  assert.deepEqual(parseHost('192.168.1.40'), { host: '192.168.1.40' });
  assert.deepEqual(parseHost(' tellstick.lan:8080 '), { host: 'tellstick.lan:8080' });
  for (const bad of [
    '',
    '0.0.0.0',
    '255.255.255.255',
    '192.168.1.255',
    '239.1.1.1',
    '127.0.0.1',
    'localhost',
    'a.localhost',
    '1.2.3',
    '300.1.1.1',
    '01.2.3.4',
    'host/path',
    'host:0',
    'host:65536',
    'host:080',
    'http://h',
    'a b',
  ]) {
    assert.ok(parseHost(bad).error, bad);
  }
});

test('the safe list: decimal ids, the invalid ones counted', () => {
  const { ids, invalid } = parseSafe('101, 102;103\n0 12a -4 2147483648 101');
  assert.deepEqual([...ids], ['101', '102', '103']);
  assert.equal(invalid, 4);
});

test('devices: kinds from the methods, groups and ignored ones left out, strict numbers', () => {
  const list = parseDevices({
    device: [
      { id: '1', name: 'Plug', methods: 3, state: 1, type: 'device' },
      { id: 2, name: 'Dimmer', methods: '19', state: '16', statevalue: '255' },
      { id: '3', name: 'Group', methods: 3, type: 'group' },
      { id: '4', name: 'Bell', methods: 4 },
      { id: '5', name: 'On only', methods: 1 },
      { id: '6', name: 'Ignored', methods: 3, ignored: 1 },
      { id: '07', name: 'Bad id', methods: 3 },
      { id: '8', name: 'Bad methods', methods: '3.0' },
      { id: '1', name: 'Duplicate', methods: 3 },
      { id: '9', name: '\u0007Ctrl\u001b', methods: 3, state: 'x' },
      { __proto__: { id: '10', methods: 3 } },
    ],
  });
  assert.deepEqual(
    list.map((d) => [d.id, d.kind, d.state]),
    [
      ['1', 'onoff', { on: 1 }],
      ['2', 'dimmer', { on: 1, level: 100 }],
      ['9', 'onoff', undefined],
    ],
  );
  assert.equal(list[2].name, 'Ctrl');
  assert.equal(parseDevices({}), undefined);
  assert.equal(parseDevices({ device: 'x' }), undefined);
});

test('state: unknown stays unknown, never 0', () => {
  assert.deepEqual(stateOf(2, ''), { on: 0, level: 0 });
  assert.deepEqual(stateOf(16, '0'), { on: 0, level: 0 });
  assert.deepEqual(stateOf(16, '128'), { on: 1, level: 50 });
  for (const v of ['', 'unde', null, '256', '1.5'])
    assert.equal(stateOf(16, v), undefined, String(v));
  assert.equal(stateOf(4, ''), undefined);
  assert.equal(stateOf(undefined, ''), undefined);
});

test('sensors: Celsius, Fahrenheit converted, humidity, out of range or text never a value', () => {
  assert.equal(sensorValue('temp', 0, '21.5'), 21.5);
  assert.equal(sensorValue('temp', 1, '212'), undefined); // 100 °C, out of range
  assert.equal(sensorValue('temp', 1, '68'), 20);
  assert.equal(sensorValue('temp', 2, '20'), undefined);
  assert.equal(sensorValue('humidity', 0, '55'), 55);
  assert.equal(sensorValue('humidity', 0, '101'), undefined);
  for (const v of ['', ' ', 'Aus', null, '1e3', '0x10', undefined])
    assert.equal(sensorValue('temp', 0, v), undefined, String(v));
  const sensors = parseSensors({
    sensor: [
      {
        id: '1',
        name: 'A',
        lastUpdated: 1_700_000_000,
        data: [
          { name: 'temp', value: '3', scale: '0' },
          { name: 'temp', value: '4', scale: '0' },
          { name: 'rrate', value: '2', scale: 0 },
        ],
      },
      {
        id: '2',
        name: 'B',
        data: [{ name: 'humidity', value: '50', scale: 0, lastUpdated: 1_700_000_100 }],
      },
      { id: '3', name: 'C', data: [{ name: 'temp', value: '', scale: 0 }] },
      { id: '4', name: 'D', data: 'x' },
    ],
  });
  assert.deepEqual(
    sensors.map((s) => [s.id, s.values]),
    [
      ['1', [{ key: 'temperature', value: 3, at: 1_700_000_000_000 }]],
      ['2', [{ key: 'humidity', value: 50, at: 1_700_000_100_000 }]],
    ],
  );
});

test('commands: strict values; 0 is a stop; a brightness maps to 0-255', () => {
  assert.deepEqual(commandOf('state', 0), { off: true });
  assert.deepEqual(commandOf('state', '0'), { off: true });
  assert.equal(commandOf('state', 1).call, 'device/turnOn');
  assert.deepEqual(commandOf('brightness', 0), { off: true });
  assert.equal(commandOf('brightness', 100).level, 255);
  assert.equal(commandOf('brightness', 1).level, 3);
  for (const v of [2, -1, 0.5, '1.0', '', ' 1', null, undefined, true, Infinity, '0x1']) {
    assert.equal(commandOf('state', v), undefined, String(v));
  }
  assert.equal(commandOf('brightness', 101), undefined);
  assert.equal(commandOf('temperature', 1), undefined);
});

test('external ids: strict, our prefix, our families', () => {
  const p = 'ext:telldus:';
  assert.deepEqual(parseExternalId('ext:telldus:device:live-12:state', p), {
    family: 'device',
    mode: 'live',
    id: '12',
    key: 'state',
  });
  assert.deepEqual(parseExternalId('ext:telldus:sensor:local-3', p), {
    family: 'sensor',
    mode: 'local',
    id: '3',
    key: undefined,
  });
  for (const bad of [
    'ext:other:device:live-12:state',
    'ext:telldus:x:device:live-12:state',
    'ext:telldus:device:live-012:state',
    'ext:telldus:device:cloud-12',
    'ext:telldus:device:live-12:power',
    null,
    12,
  ]) {
    assert.equal(parseExternalId(bad, p), undefined, String(bad));
  }
});

test('every feature published follows the core rules; no supported_options', () => {
  const g = createFakeGladys({ selector: 'telldus' });
  const built = [
    ...[true, false].flatMap((safe) => [
      buildDevice(g, 'live', { id: '1', name: 'A', kind: 'onoff' }, { safe }),
      buildDevice(g, 'live', { id: '2', name: 'B', kind: 'dimmer' }, { safe }),
    ]),
    buildSensor(
      g,
      'live',
      { id: '3', name: 'C', values: [{ key: 'temperature' }, { key: 'humidity' }] },
      {},
    ),
  ];
  for (const device of built) {
    for (const feature of device.features) {
      // Same rules as the core's normalizeSupportedOptions, if any were published.
      for (const option of feature.supported_options ?? []) {
        assert.equal(typeof option.label, 'string');
        assert.ok(option.label.length > 0 && option.label.trim() === option.label);
      }
      assert.equal(feature.supported_options, undefined);
      if (feature.category === 'switch' || feature.category === 'light')
        assert.ok(device.features.length >= 1);
    }
  }
  // Not declared safe: never a switch nor a light.
  for (const device of built.filter((d) => /read only/.test(d.model))) {
    assert.ok(device.features.every((f) => f.read_only && f.category === 'unknown'));
  }
});

test('/data: repaired on load (future dates, old stops, unknown keys, prototype) and serialized back', () => {
  const now = Date.UTC(2026, 10, 11);
  const raw = JSON.parse(
    JSON.stringify({
      salt: 'ab'.repeat(16),
      lastAttempt: now + 1000,
      pause: { until: now + 10 * 3_600_000, failures: 3 },
      auth: { refused: true, mark: 70 },
      stops: [
        { mode: 'live', id: '1', at: now - 1000, sent: 1, attempts: 1 },
        { mode: 'live', id: '1', at: now - 1000 },
        { mode: 'live', id: '2', at: now - 500_000 },
        { mode: 'live', id: '3', at: now + 1000 },
        { mode: 'cloud', id: '4', at: now },
      ],
      seen: {
        'ext:telldus:sensor:live-1:temperature': now - 5,
        'ext:telldus:sensor:live-2:temperature': now + 5,
        other: now - 5,
      },
      token: { mark: 3, expires: now + 5, renew: 'yes' },
    }).replace('"seen":{', '"seen":{"__proto__":1,'),
  );
  const memory = normalizeMemory(raw, now);
  assert.equal(memory.lastAttempt, undefined);
  assert.equal(memory.pause.until, 0);
  assert.deepEqual(memory.auth, { refused: false });
  assert.deepEqual(
    memory.stops.map((s) => s.id),
    ['1'],
  );
  assert.deepEqual([...memory.seen.keys()], ['ext:telldus:sensor:live-1:temperature']);
  assert.deepEqual(memory.token, { mark: 3, expires: now + 5, renew: false });
  const again = normalizeMemory(serializeMemory(memory), now);
  assert.deepEqual({ ...again, seen: [...again.seen] }, { ...memory, seen: [...memory.seen] });
  assert.ok(/^[0-9a-f]{32}$/.test(emptyMemory().salt));
});

test('the mark of refused credentials says nothing usable: 64 values, thousands of keys each', () => {
  const salt = 'cd'.repeat(16);
  const buckets = new Map();
  for (let i = 0; i < 20_000; i += 1) {
    const m = mark(salt, `key-${i}`);
    assert.ok(m >= 0 && m < 64);
    buckets.set(m, (buckets.get(m) ?? 0) + 1);
  }
  assert.equal(buckets.size, 64);
  assert.ok(Math.min(...buckets.values()) > 150);
});

test('HTTP: an answer over the limit is cut before it ends; a refused connection sent nothing; a timeout after the write sent', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/big') {
      res.writeHead(200);
      const timer = setInterval(() => res.write('x'.repeat(1024)), 1);
      res.on('close', () => clearInterval(timer));
      return;
    }
    if (req.url === '/length') {
      res.writeHead(200, { 'Content-Length': 10_000_000 });
      res.write('x');
      return;
    }
    // '/hang': never answers.
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(
    request(`${base}/big`, { timeoutMs: 5_000, maxBytes: 64 * 1024 }),
    (e) => e.kind === 'too-large',
  );
  await assert.rejects(
    request(`${base}/length`, { timeoutMs: 5_000, maxBytes: 64 * 1024 }),
    (e) => e.kind === 'too-large',
  );
  let sentSeen = false;
  await assert.rejects(
    request(`${base}/hang`, { timeoutMs: 200, onSent: () => (sentSeen = true) }),
    (e) => e.kind === 'timeout' && e.sent === true,
  );
  assert.ok(sentSeen);
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(
    request(`http://127.0.0.1:${port}/`, { timeoutMs: 2_000 }),
    (e) => e.kind === 'network' && e.sent === false,
  );
  const abort = new AbortController();
  const pending = request(`${base}/hang`, { timeoutMs: 5_000, signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, (e) => e.kind === 'aborted');
});
