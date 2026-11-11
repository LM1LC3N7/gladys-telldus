// -----------------------------------------------------------------------------
// The configuration of the Configuration screen, normalized. Never throws:
// an invalid value is reported (`errors`, never the value itself) and the
// configuration is then not usable for reads nor for commands that start
// something. Secrets are kept as given, never logged, never in an error.
// -----------------------------------------------------------------------------

import { LIMITS, MODES, TIMINGS } from './constants.js';

/** The defaults the manifest declares too (tied by test/manifest.test.js). */
export const DEFAULT_CONFIG = { mode: MODES.LIVE, poll_seconds: 60 };

// Printable ASCII, no space, no control byte (CR/LF never reach a header).
const TOKEN_RE = /^[\x21-\x7e]{1,2048}$/;
const HOST_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** An IPv4 address that is a single LAN host: never 0.0.0.0, broadcast, multicast, loopback. */
function ipv4Problem(host) {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^(?:0|[1-9]\d{0,2})$/.test(p))) return undefined;
  const bytes = parts.map(Number);
  if (bytes.some((b) => b > 255)) return 'invalid';
  if (bytes[0] === 0 || bytes[0] === 127 || bytes[0] >= 224) return 'not a host';
  if (bytes.every((b) => b === 255) || bytes[3] === 255 || bytes[3] === 0) return 'not a host';
  return '';
}

/** `{ host }` (with an optional `:port`) or `{ error }`. */
export function parseHost(value) {
  const raw = text(value);
  if (!raw) return { error: 'missing' };
  if (raw.length > 255) return { error: 'invalid' };
  const match = /^([^:/?#\s]+)(?::(\d{1,5}))?$/.exec(raw);
  if (!match) return { error: 'invalid' };
  const [, name, portText] = match;
  if (portText !== undefined) {
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== portText) {
      return { error: 'invalid' };
    }
  }
  const ip = ipv4Problem(name);
  if (ip === undefined) {
    if (/^\d+(?:\.\d+)*$/.test(name) || !HOST_RE.test(name)) return { error: 'invalid' };
    if (/^(?:localhost|.*\.localhost)$/i.test(name)) return { error: 'not a host' };
  } else if (ip) {
    return { error: ip };
  }
  return { host: portText === undefined ? name : `${name}:${portText}` };
}

/** The ids declared safe: `{ ids: Set<string>, invalid: number }`. */
export function parseSafe(value) {
  const ids = new Set();
  let invalid = 0;
  for (const entry of text(value).split(/[\s,;]+/)) {
    if (!entry) continue;
    if (/^[1-9]\d{0,9}$/.test(entry) && Number(entry) <= 2 ** 31 - 1 && ids.size < LIMITS.safe) {
      ids.add(entry);
    } else {
      invalid += 1;
    }
  }
  return { ids, invalid };
}

const secret = (value) => {
  const raw = text(value);
  if (!raw) return { missing: true };
  return TOKEN_RE.test(raw) ? { value: raw } : { invalid: true };
};

/**
 * `{ mode, live?, local?, safe, safeInvalid, pollMs, errors: string[] }`;
 * `errors` holds config keys only (never a value).
 */
export function normalizeConfig(raw = {}) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const mode = Object.values(MODES).includes(config.mode) ? config.mode : DEFAULT_CONFIG.mode;
  let live;
  let local;
  if (mode === MODES.LIVE) {
    live = {};
    for (const [key, name] of [
      ['public_key', 'publicKey'],
      ['private_key', 'privateKey'],
      ['token', 'token'],
      ['token_secret', 'tokenSecret'],
    ]) {
      const s = secret(config[key]);
      if (s.value) live[name] = s.value;
      else errors.push(key);
    }
  } else {
    const host = parseHost(config.host);
    const token = secret(config.local_token);
    local = { host: host.host, token: token.value };
    if (host.error) errors.push('host');
    if (token.invalid) errors.push('local_token');
  }
  const safe = parseSafe(config.safe_devices);
  const seconds = Number(config.poll_seconds);
  const min = mode === MODES.LIVE ? TIMINGS.pollMinLive : TIMINGS.pollMinLocal;
  const pollMs =
    Number.isInteger(seconds) && seconds > 0
      ? Math.min(Math.max(seconds * 1000, min), TIMINGS.pollMax)
      : Math.max(DEFAULT_CONFIG.poll_seconds * 1000, min);
  return { mode, live, local, safe: safe.ids, safeInvalid: safe.invalid, pollMs, errors };
}

/** True when reads can start (a local configuration without a token waits for one). */
export const readable = (config) =>
  config.errors.length === 0 && (config.mode === MODES.LIVE || Boolean(config.local?.token));

/** The identity of the credentials (what a refusal is about), never stored as such. */
export const credentialsText = (config) =>
  config.mode === MODES.LIVE
    ? [
        'live',
        config.live?.publicKey,
        config.live?.privateKey,
        config.live?.token,
        config.live?.tokenSecret,
      ].join('\0')
    : ['local', config.local?.host, config.local?.token].join('\0');
