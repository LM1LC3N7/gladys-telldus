// -----------------------------------------------------------------------------
// Telldus lists -> Gladys devices and values (pure).
//
// Identifier rule (frozen, it fixes the external ids):
//   `ext:<selector>:device:<mode>-<id>`   a Telldus device (433 MHz receiver),
//   `ext:<selector>:sensor:<mode>-<id>`   a Telldus sensor,
// `<mode>` `live` or `local` (Telldus Live and the local API number the same
// device differently), `<id>` the decimal id of the API. Feature keys:
// `state`, `brightness` (devices), `temperature`, `humidity` (sensors).
//
// 433 MHz receivers send nothing back: the state Telldus gives is the last
// command it sent (from Gladys, its app, a schedule or a remote it heard),
// an ASSUMED state. A device becomes a switch or a light ONLY when the user
// declared its id safe; otherwise it is shown read only (`unknown`), never a
// `switch` (a "turn everything off/on" reaches every switch and light, and a
// plug may feed a heater or a pump).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { KIND, LIMITS, METHOD, SCALE, SENSOR, STATE } from './constants.js';
import { kindLabel, sensorLabel } from './i18n.js';

const own = (object, key) =>
  object !== null && typeof object === 'object' && Object.hasOwn(object, key)
    ? object[key]
    : undefined;

/** A Telldus id: a decimal integer (number or text) 1..2^31-1, as text; else undefined. */
export function idOf(value) {
  const textValue = typeof value === 'number' ? String(value) : value;
  if (typeof textValue !== 'string' || !/^[1-9]\d{0,9}$/.test(textValue)) return undefined;
  return Number(textValue) <= 2 ** 31 - 1 ? textValue : undefined;
}

/** A strict integer of a JSON value (number or decimal text), else undefined. */
export function intOf(value, min, max) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^-?\d{1,10}$/.test(value)) n = Number(value);
  else return undefined;
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/** A strict decimal of a JSON value, else undefined (`''`, null, `'unde'` are unknown, never 0). */
export function decimalOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^-?\d{1,4}(?:\.\d{1,3})?$/.test(value)) return Number(value);
  return undefined;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** A name from the API: printable, trimmed, bounded. */
export function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL, '').trim().slice(0, LIMITS.name);
}

/** The kind of a device from its methods, else undefined (bell, group, scene…: not handled). */
export function kindOf(methods) {
  if ((methods & METHOD.TURNOFF) === 0) return undefined;
  if (methods & METHOD.DIM) return KIND.DIMMER;
  if (methods & METHOD.TURNON) return KIND.ONOFF;
  return undefined;
}

/**
 * The assumed state of a device from `state` / `statevalue`:
 * `{ on: 0|1, level?: 0-100 }`, else undefined (unknown).
 */
export function stateOf(state, statevalue) {
  const s = intOf(state, 0, 0xffff);
  if (s === METHOD.TURNON) return { on: STATE.ON };
  if (s === METHOD.TURNOFF) return { on: STATE.OFF, level: 0 };
  if (s === METHOD.DIM) {
    const raw = intOf(statevalue, 0, 255);
    if (raw === undefined) return undefined;
    const level = Math.round((raw * 100) / 255);
    return { on: raw > 0 ? STATE.ON : STATE.OFF, level };
  }
  return undefined;
}

/** The devices of a `devices/list` answer: `[{ id, name, kind, methods, state }]` (bounded). */
export function parseDevices(json) {
  const list = own(json, 'device');
  if (!Array.isArray(list)) return undefined;
  const devices = [];
  const seen = new Set();
  for (const raw of list) {
    if (devices.length >= LIMITS.devices) break;
    const id = idOf(own(raw, 'id'));
    const type = own(raw, 'type');
    if (!id || seen.has(id) || (type !== undefined && type !== 'device')) continue;
    if (own(raw, 'ignored') === 1 || own(raw, 'ignored') === '1') continue;
    const methods = intOf(own(raw, 'methods'), 0, 0xffff);
    const kind = methods === undefined ? undefined : kindOf(methods);
    if (!kind) continue;
    seen.add(id);
    devices.push({
      id,
      name: cleanName(own(raw, 'name')) || `Telldus ${id}`,
      kind,
      methods,
      state: stateOf(own(raw, 'state'), own(raw, 'statevalue')),
    });
  }
  return devices;
}

/** The value of a sensor reading in Gladys units, else undefined. */
export function sensorValue(name, scale, value) {
  const n = decimalOf(value);
  if (n === undefined) return undefined;
  if (name === SENSOR.TEMPERATURE) {
    let c;
    if (scale === SCALE.CELSIUS) c = n;
    else if (scale === SCALE.FAHRENHEIT) c = Math.round(((n - 32) * 50) / 9) / 10;
    else return undefined;
    return c >= -60 && c <= 85 ? c : undefined;
  }
  if (name === SENSOR.HUMIDITY) {
    return scale === SCALE.PERCENT && n >= 0 && n <= 100 ? n : undefined;
  }
  return undefined;
}

const SENSOR_KEY = { [SENSOR.TEMPERATURE]: 'temperature', [SENSOR.HUMIDITY]: 'humidity' };

/** A source date (seconds since 1970) in ms, else undefined. */
const dateOf = (value) => {
  const s = intOf(value, 1, 4_102_444_800);
  return s === undefined ? undefined : s * 1000;
};

/**
 * The sensors of a `sensors/list` answer (includeValues, includeScale):
 * `[{ id, name, values: [{ key, value, at }] }]`; a value without a
 * readable date or value is left out (unknown, never 0).
 */
export function parseSensors(json) {
  const list = own(json, 'sensor');
  if (!Array.isArray(list)) return undefined;
  const sensors = [];
  const seen = new Set();
  for (const raw of list) {
    if (sensors.length >= LIMITS.sensors) break;
    const id = idOf(own(raw, 'id'));
    if (!id || seen.has(id)) continue;
    if (own(raw, 'ignored') === 1 || own(raw, 'ignored') === '1') continue;
    const data = own(raw, 'data');
    if (!Array.isArray(data)) continue;
    const sensorAt = dateOf(own(raw, 'lastUpdated'));
    const values = [];
    for (const item of data.slice(0, 16)) {
      const name = own(item, 'name');
      if (!Object.hasOwn(SENSOR_KEY, name) || values.some((v) => v.key === SENSOR_KEY[name])) {
        continue;
      }
      const scale = intOf(own(item, 'scale'), 0, 9);
      const value = sensorValue(name, scale, own(item, 'value'));
      const at = dateOf(own(item, 'lastUpdated')) ?? sensorAt;
      if (value === undefined) continue;
      values.push({ key: SENSOR_KEY[name], value, at });
    }
    if (values.length === 0) continue;
    seen.add(id);
    sensors.push({ id, name: cleanName(own(raw, 'name')) || `Telldus ${id}`, values });
  }
  return sensors;
}

// --- Gladys devices ----------------------------------------------------------

export const deviceIds = (gladys, mode, id) => gladys.externalIds('device', `${mode}-${id}`);
export const sensorIds = (gladys, mode, id) => gladys.externalIds('sensor', `${mode}-${id}`);

const ID_RE =
  /^:(device|sensor):(live|local)-([1-9]\d{0,9})(?::(state|brightness|temperature|humidity))?$/;

/** `{ family, mode, id, key? }` of one of our external ids, else undefined. */
export function parseExternalId(externalId, prefix) {
  if (typeof externalId !== 'string' || externalId.length > 200) return undefined;
  if (!externalId.startsWith(prefix)) return undefined;
  const match = ID_RE.exec(externalId.slice(prefix.length - 1));
  if (!match || idOf(match[3]) === undefined) return undefined;
  return { family: match[1], mode: match[2], id: match[3], key: match[4] };
}

const binary = (category, readOnly) => ({
  category,
  type:
    category === C.SWITCH
      ? T.SWITCH.BINARY
      : category === C.LIGHT
        ? T.LIGHT.BINARY
        : T.SENSOR.BINARY,
  min: 0,
  max: 1,
  read_only: readOnly,
  has_feedback: false,
  keep_history: true,
});

/** The features of a device: declared safe -> switch or light; else read only. */
export function deviceFeatures(kind, safe) {
  if (kind === KIND.DIMMER) {
    return safe
      ? [
          ['state', binary(C.LIGHT, false)],
          [
            'brightness',
            {
              category: C.LIGHT,
              type: T.LIGHT.BRIGHTNESS,
              min: 0,
              max: 100,
              unit: U.PERCENT,
              read_only: false,
              has_feedback: false,
              keep_history: true,
            },
          ],
        ]
      : [
          ['state', binary(C.UNKNOWN, true)],
          [
            'brightness',
            {
              category: C.UNKNOWN,
              type: T.SENSOR.INTEGER,
              min: 0,
              max: 100,
              unit: U.PERCENT,
              read_only: true,
              has_feedback: false,
              keep_history: true,
            },
          ],
        ];
  }
  return [['state', safe ? binary(C.SWITCH, false) : binary(C.UNKNOWN, true)]];
}

export function buildDevice(gladys, mode, device, { safe, language }) {
  const ids = deviceIds(gladys, mode, device.id);
  return {
    name: device.name,
    external_id: ids.device,
    model: kindLabel(device.kind, safe, language),
    should_poll: false,
    features: deviceFeatures(device.kind, safe).map(([key, feature]) => ({
      name: `${device.name} - ${kindLabel(device.kind, safe, language, key)}`.slice(0, 100),
      external_id: ids.feature(key),
      ...feature,
    })),
    params: [
      { name: 'telldus_id', value: device.id },
      { name: 'telldus_mode', value: mode },
    ],
  };
}

export function buildSensor(gladys, mode, sensor, { language }) {
  const ids = sensorIds(gladys, mode, sensor.id);
  return {
    name: sensor.name,
    external_id: ids.device,
    model: sensorLabel(undefined, language),
    should_poll: false,
    features: sensor.values.map(({ key }) => ({
      name: `${sensor.name} - ${sensorLabel(key, language)}`.slice(0, 100),
      external_id: ids.feature(key),
      category: key === 'temperature' ? C.TEMPERATURE_SENSOR : C.HUMIDITY_SENSOR,
      type: T.SENSOR.DECIMAL,
      unit: key === 'temperature' ? U.CELSIUS : U.PERCENT,
      min: key === 'temperature' ? -60 : 0,
      max: key === 'temperature' ? 85 : 100,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    })),
    params: [
      { name: 'telldus_id', value: sensor.id },
      { name: 'telldus_mode', value: mode },
    ],
  };
}

/** A command value, strictly: a finite number, or a text that is exactly one. */
export function strictNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^-?\d{1,3}$/.test(value)) return Number(value);
  return undefined;
}

/**
 * What a command asks, on its own: `{ off: true }` (state 0, brightness 0:
 * the protective way, never held) or `{ off: false, call, query, level? }`.
 * Undefined: not a value of this feature.
 */
export function commandOf(key, value) {
  const n = strictNumber(value);
  if (n === undefined || !Number.isInteger(n)) return undefined;
  if (key === 'state') {
    if (n === 0) return { off: true };
    if (n === 1) return { off: false, call: 'device/turnOn', need: METHOD.TURNON };
    return undefined;
  }
  if (key === 'brightness') {
    if (n < 0 || n > 100) return undefined;
    if (n === 0) return { off: true };
    const level = Math.round((n * 255) / 100);
    return { off: false, call: 'device/dim', need: METHOD.DIM, level, percent: n };
  }
  return undefined;
}
