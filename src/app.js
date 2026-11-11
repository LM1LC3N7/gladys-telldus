// -----------------------------------------------------------------------------
// TelldusApp: configuration, reads of Telldus (Live or local API), states,
// Discovery, commands, the stops (turn off) and the buttons.
//
// Clocks: `monotonic` for every decision (intervals, pauses, deadlines),
// `now` (wall) only for /data, the OAuth timestamp and the age of a sensor
// value against the Date of the answer. Timers come from `timers` (tests
// drive a virtual clock).
//
// Lanes: the reads (devices then sensors), one at a time; the commands that
// start something, one at a time per device (never across devices). Stops never wait in a lane: they leave
// at once, abort a read in flight (which then counts as nothing), and are
// independent of the safe list, a pause, the device list and /data.
// -----------------------------------------------------------------------------

import { ApiError, TelldusApi } from './api.js';
import { credentialsText, normalizeConfig, readable } from './config.js';
import { APP_NAME, LIMITS, MODES, STATE, SUPPORTED_METHODS, TIMINGS } from './constants.js';
import { T, join } from './i18n.js';
import {
  buildDevice,
  buildSensor,
  commandOf,
  deviceIds,
  parseDevices,
  parseExternalId,
  parseSensors,
  sensorIds,
} from './model.js';
import { StatePublisher } from './publisher.js';
import { emptyMemory, fileStore, mark, normalizeMemory, serializeMemory } from './store.js';

const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
];

/** The features of the created device that the new build lacks, kept as they are (never a lost feature). */
export function keepCreatedFeatures(built, created) {
  if (!created) return built;
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => typeof f?.external_id === 'string' && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  return { ...built, features: [...built.features, ...kept] };
}

/** A promise bounded in time: resolves `fallback` (or rejects) past `ms`. */
function bounded(promise, ms, timers, onTimeout) {
  let timer;
  return Promise.race([
    promise.finally(() => timers.clearTimeout(timer)),
    new Promise((resolve, reject) => {
      timer = timers.setTimeout(() => {
        try {
          resolve(onTimeout());
        } catch (err) {
          reject(err);
        }
      }, ms);
    }),
  ]);
}

const refusal = (text) => Object.assign(new Error(text.en), { text });

export class TelldusApp {
  constructor({
    gladys,
    logger,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
    request,
    baseUrl,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.request = request;
    this.baseUrl = baseUrl;
    this.generation = 0;
    this.stopped = false;
    /** Normalized configuration, undefined until read. */
    this.config = undefined;
    this.api = undefined;
    /** /data: 'none' | 'loading' | 'ok' | 'unreadable'. */
    this.memoryState = 'none';
    this.memory = emptyMemory();
    this.pauseUntil = 0; // monotonic
    /** Last lists read: id -> device / sensor; `listAt` monotonic. */
    this.devices = new Map();
    this.sensors = new Map();
    this.listAt = undefined;
    this.lastRead = undefined; // monotonic time of the last read attempt
    this.lastResult = undefined;
    /** key `${mode}-${id}` -> monotonic time of the last command sent. */
    this.commandAt = new Map();
    /** key -> counter bumped at each stop (a command queued before never leaves after it). */
    this.stopGen = new Map();
    /** key -> stop { mode, id, at (wall, for /data), atMono, sent, attempts, timer, inflight, holdWait }. */
    this.stops = new Map();
    this.lostStops = [];
    this.readLane = Promise.resolve();
    this.commandLanes = new Map();
    this.readAbort = undefined;
    /** Short waits of the stops (timer -> resolve), cut by stop(). */
    this.sleeps = new Map();
    this.pollTimer = undefined;
    this.configTimer = undefined;
    this.storeTimer = undefined;
    this.configTries = 0;
    this.secondary = { failures: 0, until: 0 };
    this.requestToken = undefined;
    this.pendingToken = undefined;
    this.statusKey = undefined;
    this.discoveryKey = undefined;
    this.saving = undefined;
    this.saveAgain = false;
    this.publisher = new StatePublisher({ gladys, logger, monotonic, timers });
  }

  get language() {
    return 'en';
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Every connection to Gladys: /data, the configuration, then status, Discovery and the reads. */
  async connected() {
    this.stopped = false;
    const gen = ++this.generation;
    this.publisher.clear();
    this.publisher.start();
    this.statusKey = undefined;
    this.discoveryKey = undefined;
    if (!this.loading && (this.memoryState === 'none' || this.memoryState === 'unreadable')) {
      this.loading = this.loadMemory().finally(() => {
        this.loading = undefined;
      });
    }
    // A second connection during a slow /data waits for the same load, then goes on alone.
    if (this.loading) await this.loading;
    if (gen !== this.generation) return;
    await this.readConfig(gen);
  }

  async stop() {
    this.stopped = true;
    this.generation += 1;
    this.publisher.stop();
    for (const name of ['pollTimer', 'configTimer', 'storeTimer']) {
      if (this[name]) this.timers.clearTimeout(this[name]);
      this[name] = undefined;
    }
    this.readAbort?.abort();
    for (const stop of this.stops.values()) {
      if (stop.timer) this.timers.clearTimeout(stop.timer);
      stop.timer = undefined;
    }
    for (const [handle, resolve] of this.sleeps) {
      this.timers.clearTimeout(handle);
      resolve();
    }
    this.sleeps.clear();
    await this.save();
  }

  async loadMemory() {
    this.memoryState = 'loading';
    let raw;
    try {
      raw = await bounded(this.store.load(), TIMINGS.storeTimeout, this.timers, () => {
        throw new Error('timeout');
      });
    } catch (err) {
      this.memoryState = 'unreadable';
      this.logger?.warn(`/data unreadable (${err.code ?? err.message}); read again in 10 s`);
      if (this.storeTimer) this.timers.clearTimeout(this.storeTimer);
      this.storeTimer = this.timers.setTimeout(() => {
        this.storeTimer = undefined;
        if (this.stopped) return;
        this.loadMemory().then(() => this.memoryState === 'ok' && this.afterLoad());
      }, TIMINGS.storeRetry);
      this.publishStatus();
      return;
    }
    const now = this.now();
    const memory = raw === null ? emptyMemory() : normalizeMemory(raw, now);
    // Stops clicked meanwhile (/data was unreadable) win over the file.
    for (const stop of memory.stops) {
      const key = `${stop.mode}-${stop.id}`;
      if (!this.stops.has(key)) {
        // Its age goes on on the monotonic clock (the wall date of /data is bounded on load).
        const atMono = this.monotonic() - Math.min(Math.max(0, now - stop.at), TIMINGS.stopMaxAge);
        this.stops.set(key, { ...stop, atMono, timer: undefined, inflight: undefined });
      }
    }
    this.memory = memory;
    this.pauseUntil = memory.pause.until > now ? this.monotonic() + (memory.pause.until - now) : 0;
    this.memoryState = 'ok';
  }

  /** /data readable at last (it was not at the connection): resume. */
  afterLoad() {
    if (this.config) {
      this.resumeStops();
      this.schedulePoll(this.firstDelay());
    }
    this.publishStatus();
  }

  async readConfig(gen) {
    let raw;
    try {
      raw = await this.gladys.getConfig();
    } catch (err) {
      if (gen !== this.generation) return;
      const wait = TIMINGS.configRetry[Math.min(this.configTries, TIMINGS.configRetry.length - 1)];
      this.configTries += 1;
      this.logger?.warn(`Configuration not read (${err.message}); next try in ${wait} ms`);
      this.setStatus(false, T.configNotRead(wait), 'config');
      if (this.configTimer) this.timers.clearTimeout(this.configTimer);
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        if (gen === this.generation) this.readConfig(gen);
      }, wait);
      return;
    }
    if (gen !== this.generation) return;
    this.configTries = 0;
    this.applyConfig(raw, { first: true });
  }

  /** Configuration saved by the user (or by the token renewal). */
  async configUpdated(raw) {
    if (this.stopped) return;
    this.applyConfig(raw, { first: false });
  }

  applyConfig(raw, { first }) {
    const config = normalizeConfig(raw);
    const before = this.config;
    if (this.pendingToken) {
      const typed = config.local?.token;
      if (config.mode === MODES.LOCAL && (!typed || typed === this.replacedToken)) {
        // A renewal Gladys has not saved yet: still the token in use.
        config.local.token = this.pendingToken;
      } else {
        // Saved (Gladys sends it back), another mode, or a token typed by the user: it wins.
        this.pendingToken = undefined;
      }
    }
    const credentialsChanged = !before || credentialsText(before) !== credentialsText(config);
    const ownRenewal =
      before?.mode === MODES.LOCAL &&
      config.mode === MODES.LOCAL &&
      before.local.host === config.local.host &&
      config.local.token === this.renewedToken;
    this.config = config;
    if (credentialsChanged && before && this.memory.auth.refused) {
      // New credentials are always tried: the mark only serves after a restart.
      this.memory.auth = { refused: false };
      this.save();
    }
    if (credentialsChanged) {
      this.api = readable(config)
        ? new TelldusApi(config, {
            baseUrl: this.baseUrl,
            now: this.now,
            request: this.request,
            timers: this.timers,
          })
        : undefined;
      if (before && before.mode !== config.mode) {
        this.devices.clear();
        this.sensors.clear();
        this.listAt = undefined;
      }
      this.secondary = { failures: 0, until: 0 };
    }
    this.publishDiscovery();
    this.publishStatus();
    this.resumeStops();
    if (first) {
      this.schedulePoll(this.firstDelay());
    } else if (credentialsChanged && !ownRenewal) {
      // New credentials: read now (a pause still holds).
      this.schedulePoll(0);
    }
  }

  /** The first read after a (re)connection or a restart: never sooner than the interval after the last attempt. */
  firstDelay() {
    if (this.lastRead !== undefined) {
      return Math.max(0, this.lastRead + this.config.pollMs - this.monotonic());
    }
    const last = this.memory.lastAttempt;
    if (last === undefined) return 0;
    const elapsed = this.now() - last;
    return elapsed >= 0 ? Math.max(0, this.config.pollMs - elapsed) : 0;
  }

  // --- /data -------------------------------------------------------------------

  /** Saves /data (coalesced, bounded); never when it was not read (never overwritten blind). */
  save() {
    if (this.memoryState !== 'ok') return Promise.resolve(false);
    if (this.saving) {
      this.saveAgain = true;
      return this.saving;
    }
    this.memory.stops = [...this.stops.values()].map(({ mode, id, at, sent, attempts }) => ({
      mode,
      id,
      at,
      sent,
      attempts,
    }));
    const data = serializeMemory(this.memory);
    this.saving = bounded(
      this.store.save(data).then(() => true),
      TIMINGS.storeTimeout,
      this.timers,
      () => false,
    )
      .catch((err) => {
        this.logger?.warn(`/data not written (${err.code ?? err.message})`);
        return false;
      })
      .finally(() => {
        this.saving = undefined;
        if (this.saveAgain && !this.stopped) {
          this.saveAgain = false;
          this.save();
        }
      });
    return this.saving;
  }

  // --- Guards ----------------------------------------------------------------

  credentialsMark() {
    return mark(this.memory.salt, credentialsText(this.config));
  }

  /** Telldus refused these very credentials (kept in /data). */
  /** Telldus refused these very credentials while the module runs (in memory only: proof, not a mark). */
  refusedProven() {
    return Boolean(this.config && this.refusedText === credentialsText(this.config));
  }

  refused() {
    return Boolean(
      this.config && this.memory.auth.refused && this.memory.auth.mark === this.credentialsMark(),
    );
  }

  paused() {
    return this.pauseUntil > this.monotonic();
  }

  /** Any configured key or token, masked in a text that leaves the module. */
  redact(text) {
    let out = String(text);
    const secrets = [
      ...Object.values(this.config?.live ?? {}),
      this.config?.local?.token,
      this.pendingToken,
      this.replacedToken,
      this.requestToken?.token,
    ].filter((s) => typeof s === 'string' && s.length >= 4);
    for (const s of secrets) out = out.split(s).join('***');
    return out.slice(0, LIMITS.message);
  }

  // --- Status and Discovery ----------------------------------------------------

  setStatus(connected, message, key = message.en) {
    const text = { en: this.redact(message.en), fr: this.redact(message.fr) };
    const id = `${connected}|${text.en}|${key}`;
    if (id === this.statusKey) return;
    this.statusKey = id;
    this.gladys
      .setConnectionStatus(connected, text)
      .catch((err) => this.logger?.warn(`Status not sent: ${err.message}`));
  }

  publishStatus() {
    if (this.memoryState === 'unreadable') {
      this.setStatus(false, T.storeUnreadable);
      return;
    }
    const config = this.config;
    if (!config) return;
    const extra = [];
    if (config.safeInvalid) extra.push(T.safeInvalid(config.safeInvalid));
    if (this.lostStops.length) extra.push(T.stopLost(this.lostStops.slice(0, 10)));
    if (this.pendingToken) extra.push(T.renewNotSaved);
    if (config.errors.length) {
      this.setStatus(false, join(T.configMissing(config.errors), ...extra));
      return;
    }
    if (config.mode === MODES.LOCAL && !config.local.token) {
      this.setStatus(false, join(T.waitingToken, ...extra));
      return;
    }
    if (this.refused()) {
      this.setStatus(false, join(T.refused(config.mode), ...extra));
      return;
    }
    if (this.paused()) {
      this.setStatus(false, join(T.paused(this.pauseUntil - this.monotonic()), ...extra), 'paused');
      return;
    }
    const r = this.lastResult;
    if (!r) return;
    if (r.ok) {
      if (this.secondary.failures) {
        extra.unshift(T.sensorsNotRead(Math.max(0, this.secondary.until - this.monotonic())));
      }
      this.setStatus(
        true,
        join(T.connected(this.devices.size, this.sensors.size, config.mode), ...extra),
        'ok',
      );
    } else {
      this.setStatus(false, join(r.kind === 'bad' ? T.badAnswer : T.unreachable(r.kind), ...extra));
    }
  }

  isSafe(id) {
    return Boolean(this.config?.safe.has(id));
  }

  /** The devices and sensors of the last lists (no read: never faster than the interval). */
  discovered() {
    if (!this.config) return [];
    const mode = this.config.mode;
    const created = new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
    const list = [];
    for (const device of this.devices.values()) {
      const built = buildDevice(this.gladys, mode, device, {
        safe: this.isSafe(device.id),
        language: this.language,
      });
      list.push(keepCreatedFeatures(built, created.get(built.external_id)));
    }
    for (const sensor of this.sensors.values()) {
      const built = buildSensor(this.gladys, mode, sensor, { language: this.language });
      list.push(keepCreatedFeatures(built, created.get(built.external_id)));
    }
    return list;
  }

  publishDiscovery(force = false) {
    const list = this.discovered();
    const key = JSON.stringify(list);
    if (!force && key === this.discoveryKey) return Promise.resolve();
    this.discoveryKey = key;
    return this.gladys
      .publishDiscoveredDevices(list)
      .catch((err) => this.logger?.warn(`Discovery not sent: ${err.message}`));
  }

  async scan() {
    await this.publishDiscovery(true);
  }

  async deviceCreated() {
    // Nothing republished: a value already sent is never sent again as new.
  }

  async deviceDeleted(device) {
    if (device?.external_id) this.publisher.forget(device.external_id);
  }

  /** True when this feature exists in Gladys (states are sent for created features only). */
  created(featureId) {
    return (this.gladys.devices ?? []).some((d) =>
      (d.features ?? []).some((f) => f.external_id === featureId),
    );
  }

  push(featureId, state, options) {
    if (this.created(featureId)) this.publisher.push(featureId, state, options);
  }

  // --- Reads -------------------------------------------------------------------

  schedulePoll(delay) {
    if (this.stopped) return;
    if (this.pollTimer) this.timers.clearTimeout(this.pollTimer);
    this.pollTimer = this.timers.setTimeout(
      () => {
        this.pollTimer = undefined;
        this.poll().catch((err) => this.logger?.error(`Read failed: ${err.message}`));
      },
      Math.max(0, delay),
    );
  }

  /** One read, then the next one planned (one timer). */
  async poll() {
    const gen = this.generation;
    if (this.stopped || !this.config) return;
    if (this.memoryState !== 'ok') return; // read again once /data is (afterLoad)
    if (!this.api || this.refused()) {
      this.publishStatus();
      return;
    }
    if (this.paused()) {
      this.publishStatus();
      this.schedulePoll(this.pauseUntil - this.monotonic() + 1);
      return;
    }
    await this.read(gen);
    if (gen !== this.generation || this.stopped) return;
    const next = this.paused() ? this.pauseUntil - this.monotonic() + 1 : this.config.pollMs;
    if (!this.refused()) this.schedulePoll(next);
  }

  /** Runs `fn` in the read lane (one read at a time). */
  inReadLane(fn) {
    const run = this.readLane.then(fn, fn);
    this.readLane = run.catch(() => {});
    return run;
  }

  read(gen) {
    return this.inReadLane(() => this.doRead(gen));
  }

  async doRead(gen) {
    if (gen !== this.generation || !this.api || this.refused() || this.paused())
      return this.lastResult;
    const started = this.monotonic();
    this.lastRead = started;
    this.memory.lastAttempt = this.now();
    // The time of the attempt is in /data before the read (a restart never reads sooner).
    await this.save();
    if (gen !== this.generation) return this.lastResult;
    if (this.config.mode === MODES.LOCAL) {
      // A renewed token Gladys could not save yet: saved again now.
      if (this.pendingToken) await this.saveToken();
      await this.renewToken(gen);
    }
    if (gen !== this.generation || !this.api) return this.lastResult;
    const api = this.api;
    const abort = new AbortController();
    this.readAbort = abort;
    let devices;
    let date;
    try {
      const res = await api.call(
        'devices/list',
        { supportedMethods: SUPPORTED_METHODS, includeIgnored: 0 },
        { timeoutMs: TIMINGS.readTimeout, signal: abort.signal },
      );
      devices = parseDevices(res.json);
      date = res.date;
      if (!devices) throw new ApiError('bad', { detail: 'no device list' });
    } catch (err) {
      if (this.readAbort === abort) this.readAbort = undefined;
      if (gen !== this.generation || api !== this.api) return this.lastResult;
      if (err.kind === 'aborted') {
        // Cut by a stop: counts as nothing (read again at the next interval).
        this.lastRead = undefined;
        return this.lastResult;
      }
      this.readFailed(err, { main: true });
      return this.lastResult;
    }
    if (this.readAbort === abort) this.readAbort = undefined;
    if (gen !== this.generation || api !== this.api) return this.lastResult;
    this.pauseOk();
    this.applyDevices(devices, started);
    await this.readSensors(gen, api, started, date);
    if (gen !== this.generation || api !== this.api) return this.lastResult;
    this.lastResult = { ok: true };
    this.publishDiscovery();
    this.publishStatus();
    this.save();
    return this.lastResult;
  }

  async readSensors(gen, api, started, listDate) {
    if (this.secondary.until > this.monotonic()) return;
    const abort = new AbortController();
    this.readAbort = abort;
    try {
      const res = await api.call(
        'sensors/list',
        { includeValues: 1, includeScale: 1, includeIgnored: 0 },
        { timeoutMs: TIMINGS.readTimeout, signal: abort.signal },
      );
      const sensors = parseSensors(res.json);
      if (!sensors) throw new ApiError('bad', { detail: 'no sensor list' });
      if (gen !== this.generation || api !== this.api) return;
      this.secondary = { failures: 0, until: 0 };
      this.applySensors(sensors, res.date ?? listDate);
    } catch (err) {
      if (gen !== this.generation || api !== this.api || err.kind === 'aborted') return;
      if (err.kind === 'rate' || err.kind === 'server') {
        this.pause(err);
        return;
      }
      if (err.kind === 'auth') {
        // A secondary route refused: never a refusal of the credentials (the device list was read).
        this.secondary.failures += 1;
        const wait = Math.min(
          this.config.pollMs * 2 ** this.secondary.failures,
          TIMINGS.secondaryMax,
        );
        this.secondary.until = this.monotonic() + wait;
      }
      this.logger?.warn(`Sensors not read (${this.redact(err.message)})`);
    } finally {
      if (this.readAbort === abort) this.readAbort = undefined;
    }
  }

  readFailed(err, { main }) {
    this.logger?.warn(`Telldus read failed (${this.redact(err.message)})`);
    if (err.kind === 'auth' && main) {
      this.memory.auth = { refused: true, mark: this.credentialsMark() };
      this.refusedText = credentialsText(this.config);
      this.lastResult = { ok: false, kind: 'auth' };
      this.save();
      this.publishStatus();
      return;
    }
    if (err.kind === 'rate' || err.kind === 'server') {
      this.pause(err);
      this.lastResult = { ok: false, kind: err.kind };
      return;
    }
    this.lastResult = {
      ok: false,
      kind: err.kind === 'bad' || err.kind === 'too-large' ? 'bad' : err.kind,
    };
    this.publishStatus();
  }

  /** 429 / 5xx: a pause, doubled at each one in a row (Retry-After when longer), bounded, in /data. */
  pause(err) {
    const failures = Math.min(this.memory.pause.failures + 1, 20);
    const doubled = Math.min(TIMINGS.pauseMin * 2 ** (failures - 1), TIMINGS.pauseMax);
    const wait = Math.min(Math.max(doubled, err.retryAfter ?? 0), TIMINGS.pauseMax);
    this.pauseUntil = this.monotonic() + wait;
    this.memory.pause = { until: this.now() + wait, failures };
    this.save();
    this.publishStatus();
  }

  pauseOk() {
    if (this.memory.pause.failures || this.memory.pause.until) {
      this.memory.pause = { until: 0, failures: 0 };
      this.pauseUntil = 0;
    }
  }

  applyDevices(devices, started) {
    const mode = this.config.mode;
    this.devices = new Map(devices.map((d) => [d.id, d]));
    this.listAt = started;
    for (const device of devices) {
      const key = `${mode}-${device.id}`;
      // A read that left before the last command of this device says nothing of it.
      if ((this.commandAt.get(key) ?? -Infinity) >= started) continue;
      const stop = this.stops.get(key);
      if (
        stop &&
        device.state?.on === STATE.ON &&
        stop.sent > 0 &&
        started - stop.lastSendAt >= TIMINGS.stopReadAfter
      ) {
        // Turned on after our stop, by the Telldus app, a schedule or a remote: no resend over it
        // (a read that left soon after a send may still show the old state: it says nothing).
        this.endStop(key);
      }
      if (!device.state) continue;
      const ids = deviceIds(this.gladys, mode, device.id);
      this.push(ids.feature('state'), device.state.on);
      if (device.state.level !== undefined && device.kind === 'dimmer') {
        this.push(ids.feature('brightness'), device.state.level);
      }
    }
  }

  applySensors(sensors, serverDate) {
    const mode = this.config.mode;
    const now = serverDate ?? this.now();
    this.sensors = new Map(sensors.map((s) => [s.id, s]));
    let changed = false;
    for (const sensor of sensors) {
      const ids = sensorIds(this.gladys, mode, sensor.id);
      for (const { key, value, at } of sensor.values) {
        const featureId = ids.feature(key);
        if (at === undefined || at > now + 300_000 || now - at > TIMINGS.valueMaxAge) continue;
        if ((this.memory.seen.get(featureId) ?? 0) >= at) continue;
        if (!this.created(featureId)) continue;
        this.memory.seen.delete(featureId);
        this.memory.seen.set(featureId, at);
        changed = true;
        this.publisher.push(featureId, value, { spaced: true });
      }
    }
    while (this.memory.seen.size > LIMITS.seen)
      this.memory.seen.delete(this.memory.seen.keys().next().value);
    if (changed) this.save();
  }

  // --- Local token -------------------------------------------------------------

  /** Renews the local token when it expires within a week (when the TellStick allows it). */
  async renewToken(gen) {
    const token = this.memory.token;
    const current = this.config.local?.token;
    if (!token || !current || !token.renew) return;
    if (token.mark !== mark(this.memory.salt, current)) return;
    if (token.expires - this.now() > TIMINGS.tokenRenewBefore) return;
    try {
      const res = await this.api.call('refreshToken', {}, { timeoutMs: TIMINGS.readTimeout });
      if (gen !== this.generation) return;
      const fresh = res.json.token;
      const expires = Number(res.json.expires);
      if (typeof fresh !== 'string' || !/^[\x21-\x7e]{8,2048}$/.test(fresh)) return;
      await this.useToken(
        fresh,
        Number.isFinite(expires) ? expires * 1000 : undefined,
        token.renew,
      );
    } catch (err) {
      this.logger?.warn(`Local token not renewed (${this.redact(err.message)})`);
    }
  }

  /** A new local token: used at once, saved in the configuration of Gladys (never in /data). */
  async useToken(fresh, expires, renew) {
    this.replacedToken = this.config.local.token;
    // A new token is always tried.
    this.memory.auth = { refused: false };
    this.renewedToken = fresh;
    this.pendingToken = fresh;
    this.config.local.token = fresh;
    this.api = new TelldusApi(this.config, {
      baseUrl: this.baseUrl,
      now: this.now,
      request: this.request,
      timers: this.timers,
    });
    this.memory.token = expires
      ? { mark: mark(this.memory.salt, fresh), expires, renew: Boolean(renew) }
      : undefined;
    this.save();
    return this.saveToken();
  }

  async saveToken() {
    if (!this.pendingToken) return true;
    try {
      await this.gladys.setConfig({ local_token: this.pendingToken });
      this.pendingToken = undefined;
      this.publishStatus();
      return true;
    } catch (err) {
      this.logger?.warn(`Local token not saved in Gladys (${err.message})`);
      this.publishStatus();
      return false;
    }
  }

  // --- Commands ----------------------------------------------------------------

  /** A command from Gladys. Turning off is never held; anything else is checked first. */
  async setValue(device, feature, value) {
    const target = parseExternalId(feature?.external_id, `ext:${this.gladys.selector}:`);
    if (!target || target.family !== 'device' || !target.key) throw refusal(T.invalidValue);
    const cmd = commandOf(target.key, value);
    if (!cmd) throw refusal(T.invalidValue);
    if (cmd.off) return this.turnOff(target.mode, target.id);
    return this.start(target.mode, target.id, target.key, cmd);
  }

  // --- Stops -------------------------------------------------------------------

  /**
   * Turn off: sent at once (a read in flight is cut), whatever the safe list,
   * a pause, the device list or /data; sent again after 3 s and 10 s (433 MHz
   * has no feedback); a send that fails is tried again (6 tries, 2 minutes).
   */
  async turnOff(mode, id) {
    const key = `${mode}-${id}`;
    this.stopGen.set(key, (this.stopGen.get(key) ?? 0) + 1);
    this.commandAt.set(key, this.monotonic());
    const old = this.stops.get(key);
    if (old?.timer) this.timers.clearTimeout(old.timer);
    const stop = {
      mode,
      id,
      at: this.now(),
      atMono: this.monotonic(),
      sent: 0,
      attempts: 0,
      timer: undefined,
      inflight: undefined,
    };
    this.stops.set(key, stop);
    this.lostStops = this.lostStops.filter((n) => n !== this.stopName(stop));
    this.save();
    const ready = this.stopReady(stop);
    if (ready !== true) {
      if (ready === T.otherMode || ready === T.stopRefusedAuth) this.endStop(key);
      return ready.en;
    }
    // The first send, retried within its budget when nothing left.
    const deadline = this.monotonic() + TIMINGS.commandAck;
    let outcome = await this.sendStop(stop, deadline);
    if (
      outcome === 'not-sent' &&
      this.monotonic() + TIMINGS.stopRetry < deadline &&
      this.stops.get(key) === stop
    ) {
      await this.sleep(TIMINGS.stopRetry);
      if (!this.stopped && this.stops.get(key) === stop && !stop.inflight)
        outcome = await this.sendStop(stop, deadline);
    }
    if (outcome === 'sent') return T.sent.en;
    if (outcome === 'no-answer') return T.sentNoAnswer.en;
    if (outcome === 'refused') return T.stopRefusedByTelldus(stop.lastError ?? 'error').en;
    return T.stopNotSent.en;
  }

  /** A short wait (cut and resolved by stop()). */
  sleep(ms) {
    return new Promise((resolve) => {
      const handle = this.timers.setTimeout(() => {
        this.sleeps.delete(handle);
        resolve();
      }, ms);
      this.sleeps.set(handle, resolve);
    });
  }

  /** Age of a stop on the monotonic clock. */
  stopAge(stop) {
    return this.monotonic() - stop.atMono;
  }

  stopName(stop) {
    return this.devices.get(stop.id)?.name ?? `Telldus ${stop.id}`;
  }

  /** true, or the text of why a stop cannot leave now. */
  stopReady(stop) {
    if (!this.config || !this.api) return T.stopNoConfig;
    if (stop.mode !== this.config.mode) return T.otherMode;
    // A mark kept in /data is a hint only (64 values): a stop is held only by a refusal seen now.
    if (this.refusedProven()) return T.stopRefusedAuth;
    return true;
  }

  /** Stops kept (in /data, or clicked before the configuration was read): sent now. */
  resumeStops() {
    for (const [key, stop] of this.stops) {
      if (stop.timer) continue;
      if (this.stopAge(stop) > TIMINGS.stopMaxAge) {
        // Never replayed late: it could turn off what was turned on since.
        this.endStop(key);
        continue;
      }
      const ready = this.stopReady(stop);
      if (ready === true) this.sendStop(stop);
      else if (ready !== T.stopNoConfig) this.endStop(key);
    }
  }

  endStop(key) {
    const stop = this.stops.get(key);
    if (!stop) return;
    if (stop.timer) this.timers.clearTimeout(stop.timer);
    stop.timer = undefined;
    stop.ended = true;
    this.stops.delete(key);
    this.save();
  }

  /**
   * One send of a stop. Resolves 'sent' (Telldus accepted it), 'no-answer'
   * (it left, no answer by `deadline`), 'not-sent'. The request goes on after
   * the deadline; its answer counts.
   */
  sendStop(stop, deadline) {
    const key = `${stop.mode}-${stop.id}`;
    if (this.stopped || this.stops.get(key) !== stop || stop.inflight) {
      return Promise.resolve('not-sent');
    }
    const ready = this.stopReady(stop);
    if (ready !== true) return Promise.resolve('not-sent');
    // A read in flight never delays a stop: cut it (it counts as nothing).
    this.readAbort?.abort();
    stop.attempts += 1;
    stop.lastSendAt = this.monotonic();
    let left = false;
    const request = this.api
      .call(
        'device/turnOff',
        { id: stop.id },
        { timeoutMs: TIMINGS.commandTimeout, onSent: () => (left = true) },
      )
      .then(
        () => 'sent',
        (err) => {
          this.logger?.warn(`Turning off ${stop.id}: ${this.redact(err.message)}`);
          if (err.kind === 'rate') this.pause(err);
          if (['auth', 'refused', 'bad', 'rate'].includes(err.kind)) {
            // Telldus answered no: not "without confirmation".
            stop.lastError = err.status ? `HTTP ${err.status}` : this.redact(err.message);
            return 'refused';
          }
          return err.sent || left ? 'failed-sent' : 'not-sent';
        },
      );
    stop.inflight = request;
    request.then((result) => {
      stop.inflight = undefined;
      if (stop.ended || this.stops.get(key) !== stop) return;
      if (result === 'sent') {
        stop.sent += 1;
        this.commandAt.set(key, this.monotonic());
        const ids = deviceIds(this.gladys, stop.mode, stop.id);
        this.push(ids.feature('state'), STATE.OFF);
        if (this.devices.get(stop.id)?.kind === 'dimmer') this.push(ids.feature('brightness'), 0);
      }
      this.planStop(stop);
    });
    if (deadline === undefined) return request;
    return bounded(request, Math.max(0, deadline - this.monotonic()), this.timers, () =>
      left ? 'no-answer' : 'not-sent',
    ).then((r) => (r === 'failed-sent' ? 'no-answer' : r));
  }

  /** The next send of a stop: a resend after a send, a retry after a failure, or the end. */
  planStop(stop) {
    const key = `${stop.mode}-${stop.id}`;
    if (this.stopped || this.stops.get(key) !== stop) return;
    const resends = TIMINGS.stopResends;
    if (stop.sent > resends.length) {
      this.endStop(key);
      return;
    }
    const age = this.stopAge(stop);
    if (stop.attempts >= TIMINGS.stopAttempts || age > TIMINGS.stopMaxAge) {
      if (stop.sent === 0) {
        this.lostStops = [
          ...this.lostStops.filter((n) => n !== this.stopName(stop)),
          this.stopName(stop),
        ].slice(-10);
        this.publishStatus();
      }
      this.endStop(key);
      return;
    }
    const delay =
      stop.sent > 0 && stop.sent === stop.attempts
        ? Math.max(0, resends[stop.sent - 1] - age)
        : TIMINGS.stopRetrySpacing;
    this.save();
    // One timer per stop: a new plan replaces the one in place.
    if (stop.timer) this.timers.clearTimeout(stop.timer);
    stop.timer = this.timers.setTimeout(async () => {
      stop.timer = undefined;
      if (stop.holdWait) {
        // A newer command of this device has left: its answer decides (2xx ends this stop,
        // anything else and the stop leaves), bounded by the command timeout.
        await bounded(stop.holdWait, TIMINGS.commandTimeout, this.timers, () => undefined);
        if (this.stopped || this.stops.get(key) !== stop) return;
      }
      this.sendStop(stop);
    }, delay);
  }

  // --- Commands that start something -------------------------------------------

  /** Why a command that starts something cannot leave, else undefined (checked again just before the send). */
  startProblem(mode, id, cmd) {
    if (this.memoryState !== 'ok') return T.storeCommand;
    if (!this.config || !this.api) return T.notConfigured;
    if (mode !== this.config.mode) return T.otherMode;
    if (!this.isSafe(id)) return T.notSafe;
    if (this.refused()) return T.refusedCommand;
    if (this.paused()) return T.pausedCommand;
    const device = this.devices.get(id);
    if (!device) return T.notKnown;
    if (this.listAt === undefined || this.monotonic() - this.listAt > TIMINGS.listMaxAge)
      return T.listOld;
    if ((device.methods & cmd.need) === 0) return T.notSupported;
    return undefined;
  }

  /** Runs `fn` in the lane of one device: serialized per target, never across devices. */
  inCommandLane(key, fn) {
    const before = this.commandLanes.get(key) ?? Promise.resolve();
    const run = before.then(fn, fn);
    const tail = run.catch(() => {});
    this.commandLanes.set(key, tail);
    tail.then(() => {
      if (this.commandLanes.get(key) === tail) this.commandLanes.delete(key);
    });
    return run;
  }

  async start(mode, id, key, cmd) {
    const problem = this.startProblem(mode, id, cmd);
    if (problem) throw refusal(problem);
    const deviceKey = `${mode}-${id}`;
    const gen = this.stopGen.get(deviceKey) ?? 0;
    const deadline = this.monotonic() + TIMINGS.commandAck;
    let left = false;
    let settled = false;
    const work = this.inCommandLane(deviceKey, async () => {
      // Just before the send: everything checked again, and no stop came since the click.
      if ((this.stopGen.get(deviceKey) ?? 0) !== gen) return { refused: T.supersededByStop };
      if (this.monotonic() >= deadline || settled) return { refused: T.notSentCommand('timeout') };
      const again = this.startProblem(mode, id, cmd);
      if (again) return { refused: again };
      const stop = this.stops.get(deviceKey);
      if (stop?.inflight) {
        // Never two orders of one device on the air together: the stop send first.
        await stop.inflight;
        if ((this.stopGen.get(deviceKey) ?? 0) !== gen) return { refused: T.supersededByStop };
        if (this.monotonic() >= deadline || settled)
          return { refused: T.notSentCommand('timeout') };
      }
      const held = this.stops.get(deviceKey);
      const query = cmd.level === undefined ? { id } : { id, level: cmd.level };
      const call = this.api.call(cmd.call, query, {
        timeoutMs: TIMINGS.commandTimeout,
        onSent: () => (left = true),
      });
      const wait = call.then(
        () => undefined,
        () => undefined,
      );
      if (held) held.holdWait = wait;
      try {
        await call;
      } catch (err) {
        return { error: err };
      } finally {
        if (held && held.holdWait === wait) held.holdWait = undefined;
      }
      // It left and Telldus accepted it: newer than any stop of this device.
      this.commandAt.set(deviceKey, this.monotonic());
      if (this.stops.get(deviceKey) === held && held) this.endStop(deviceKey);
      // A stop clicked while it was on its way wins: no ON shown over it.
      if ((this.stopGen.get(deviceKey) ?? 0) !== gen) return { ok: true };
      const ids = deviceIds(this.gladys, mode, id);
      if (key === 'brightness') {
        this.push(ids.feature('state'), STATE.ON);
        this.push(ids.feature('brightness'), cmd.percent);
      } else {
        this.push(ids.feature('state'), STATE.ON);
      }
      return { ok: true };
    });
    const result = await bounded(
      work,
      Math.max(0, deadline - this.monotonic()),
      this.timers,
      () => ({
        late: true,
      }),
    );
    settled = true;
    if (result.late) {
      if (left) return T.sentNoAnswer.en;
      throw refusal(T.notSentCommand('timeout'));
    }
    if (result.ok) return T.sent.en;
    if (result.refused) throw refusal(result.refused);
    const err = result.error;
    // A 429 is about the account: pause. A 5xx of one device never pauses the others.
    if (err.kind === 'rate') this.pause(err);
    if (!err.sent && !left) throw refusal(T.notSentCommand(err.kind));
    if (err.kind === 'timeout') return T.sentNoAnswer.en;
    throw refusal(T.failedCommand(err.status ? `HTTP ${err.status}` : this.redact(err.message)));
  }

  // --- Buttons -------------------------------------------------------------------

  async testConnection() {
    if (this.memoryState !== 'ok') return T.storeUnreadable;
    if (!this.config) return T.notConfigured;
    if (this.config.errors.length) return T.configMissing(this.config.errors);
    if (this.config.mode === MODES.LOCAL && !this.config.local.token) return T.waitingToken;
    if (this.paused()) return T.paused(this.pauseUntil - this.monotonic());
    const min = this.config.mode === MODES.LIVE ? TIMINGS.pollMinLive : TIMINGS.pollMinLocal;
    const since = this.lastRead === undefined ? Infinity : this.monotonic() - this.lastRead;
    if (since < min) {
      return join(this.resultText(), T.testTooSoon(min - since));
    }
    const gen = this.generation;
    const wasRefused = this.refused();
    const proven = this.refusedText;
    if (wasRefused) {
      // The button always tries: a mark may be a collision after a restart.
      this.memory.auth = { refused: false };
      this.refusedText = undefined;
    }
    const result = await this.read(gen);
    if (gen === this.generation && !this.refused() && this.lastResult?.ok) {
      this.schedulePoll(this.config.pollMs);
    } else if (wasRefused && !this.refused() && !this.lastResult?.ok) {
      // Nothing proved the keys good: still refused.
      this.memory.auth = { refused: true, mark: this.credentialsMark() };
      this.refusedText = proven;
      this.save();
    }
    void result;
    return this.resultText();
  }

  resultText() {
    if (this.refused()) return T.refused(this.config.mode);
    if (this.paused()) return T.paused(this.pauseUntil - this.monotonic());
    const r = this.lastResult;
    if (!r) return T.reading;
    if (!r.ok) return r.kind === 'bad' ? T.badAnswer : T.unreachable(r.kind);
    const devices = [...this.devices.values()].map((d) => ({ ...d, safe: this.isSafe(d.id) }));
    const text = T.testOk(devices, this.sensors.size);
    return { en: this.redact(text.en), fr: this.redact(text.fr) };
  }

  localApi() {
    if (!this.config || this.config.mode !== MODES.LOCAL) return undefined;
    if (!this.config.local.host) return undefined;
    return (
      this.api ??
      new TelldusApi(this.config, {
        baseUrl: this.baseUrl,
        now: this.now,
        request: this.request,
        timers: this.timers,
      })
    );
  }

  /** Local access, step 1: a request token; the user accepts it in the browser. */
  async requestLocalAccess() {
    const api = this.localApi();
    if (!api) return this.config?.mode === MODES.LOCAL ? T.configMissing(['host']) : T.localOnly;
    try {
      const res = await api.call(
        'token',
        {},
        { method: 'PUT', form: { app: APP_NAME }, token: null, timeoutMs: TIMINGS.readTimeout },
      );
      const { authUrl, token } = res.json;
      if (typeof token !== 'string' || !/^[\x21-\x7e]{4,512}$/.test(token))
        return T.actionFailed('no token');
      if (
        typeof authUrl !== 'string' ||
        authUrl.length > 300 ||
        !/^https?:\/\/[\x21-\x7e]+$/.test(authUrl)
      ) {
        return T.actionFailed('no address');
      }
      this.requestToken = { token, at: this.monotonic() };
      return T.openThis(authUrl);
    } catch (err) {
      return T.actionFailed(err.status ? `HTTP ${err.status}` : err.kind);
    }
  }

  /** Local access, step 2: the token granted, saved in the configuration of Gladys. */
  async finishLocalAccess() {
    const api = this.localApi();
    if (!api) return this.config?.mode === MODES.LOCAL ? T.configMissing(['host']) : T.localOnly;
    if (!this.requestToken || this.monotonic() - this.requestToken.at > 3_600_000)
      return T.noRequest;
    let res;
    try {
      res = await api.call(
        'token',
        { token: this.requestToken.token },
        { token: null, timeoutMs: TIMINGS.readTimeout },
      );
    } catch (err) {
      if (err.kind === 'refused' || err.kind === 'auth') return T.notAccepted;
      return T.actionFailed(err.status ? `HTTP ${err.status}` : err.kind);
    }
    const fresh = res.json.token;
    if (typeof fresh !== 'string' || !/^[\x21-\x7e]{8,2048}$/.test(fresh)) return T.notAccepted;
    const expiresS = Number(res.json.expires);
    const expires = Number.isFinite(expiresS) && expiresS > 0 ? expiresS * 1000 : undefined;
    this.requestToken = undefined;
    // A new token: whatever was refused before is not this one.
    const saved = await this.useToken(fresh, expires, res.json.allowRenew === true);
    this.schedulePoll(0);
    if (!saved) return T.tokenNotSaved;
    return T.tokenSaved(expires ? new Date(expires).toISOString().slice(0, 10) : undefined);
  }
}
