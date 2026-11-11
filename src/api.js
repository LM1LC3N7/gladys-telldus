// -----------------------------------------------------------------------------
// The Telldus APIs, the same JSON calls on two transports:
//   - Telldus Live (`https://api.telldus.com/json/<call>`), every request
//     signed with OAuth 1 (HMAC-SHA1) from the four keys the user created on
//     api.telldus.com/keys;
//   - the local API of a TellStick ZNet / Net v2 (`http://<host>/api/<call>`)
//     with the token the user granted in the browser (Bearer).
// Every answer is classified (ApiError.kind): 'auth' (401/403), 'rate' (429),
// 'server' (5xx), 'refused' (a 2xx JSON `{ error }`), 'bad' (not the JSON of
// the API, cut, a redirect), or the network kinds of src/http.js. The keys
// and tokens never appear in an error, a log or a status.
// -----------------------------------------------------------------------------

import { createHmac, randomBytes } from 'node:crypto';
import { request } from './http.js';
import { LIVE_API, MODES } from './constants.js';

export class ApiError extends Error {
  constructor(kind, { sent = true, status, retryAfter, detail } = {}) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.kind = kind;
    this.sent = sent;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** RFC 3986 encoding (OAuth 1). */
export const encode = (value) =>
  encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** The OAuth 1 Authorization header of a request (RFC 5849, HMAC-SHA1). */
export function oauthHeader(method, url, query, keys, { nonce, timestamp }) {
  const oauth = {
    oauth_consumer_key: keys.publicKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp),
    oauth_token: keys.token,
    oauth_version: '1.0',
  };
  const pairs = [...Object.entries(query), ...Object.entries(oauth)]
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : 1) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const base = [method.toUpperCase(), encode(url), encode(pairs)].join('&');
  const signature = createHmac('sha1', `${encode(keys.privateKey)}&${encode(keys.tokenSecret)}`)
    .update(base)
    .digest('base64');
  const header = Object.entries({ ...oauth, oauth_signature: signature })
    .map(([k, v]) => `${encode(k)}="${encode(v)}"`)
    .join(', ');
  return `OAuth ${header}`;
}

/** Seconds of a Retry-After header (a number or an HTTP date against the Date header). */
export function retryAfterMs(headers) {
  const value = headers?.['retry-after'];
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (/^\d{1,7}$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  const now = Date.parse(headers.date ?? '');
  return Number.isFinite(at) && Number.isFinite(now) ? Math.max(0, at - now) : undefined;
}

/**
 * One API client for one configuration. `call(path, query, options)` resolves
 * the JSON object of the answer and the server date (`{ json, date }`, date in
 * ms or undefined).
 */
export class TelldusApi {
  constructor(
    config,
    { baseUrl, now = Date.now, request: send = request, timers = globalThis } = {},
  ) {
    this.mode = config.mode;
    this.keys = config.live;
    this.local = config.local;
    this.base =
      baseUrl ?? (this.mode === MODES.LIVE ? LIVE_API : `http://${config.local.host}/api/`);
    this.now = now;
    this.send = send;
    this.timers = timers;
  }

  url(path) {
    return new URL(path, this.base).toString();
  }

  headers(method, url, query, token) {
    const headers = { Accept: 'application/json', 'User-Agent': 'gladys-telldus' };
    if (this.mode === MODES.LIVE) {
      headers.Authorization = oauthHeader(method, url, query, this.keys, {
        nonce: randomBytes(16).toString('hex'),
        timestamp: Math.floor(this.now() / 1000),
      });
    } else if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  /**
   * `options`: `timeoutMs`, `signal`, `method` ('GET' or 'PUT' with a form
   * body), `token` (local: another token than the configured one, or null for
   * none), `onSent` (called once the request left).
   */
  async call(path, query = {}, { timeoutMs, signal, method = 'GET', form, token, onSent } = {}) {
    const url = this.url(path);
    const search = new URLSearchParams(query).toString();
    const full = search ? `${url}?${search}` : url;
    const bearer = token === undefined ? this.local?.token : token;
    const body = form ? new URLSearchParams(form).toString() : undefined;
    const headers = this.headers(method, url, form ? { ...query, ...form } : query, bearer);
    if (body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    let res;
    try {
      res = await this.send(full, {
        method,
        headers,
        body,
        timeoutMs,
        signal,
        onSent,
        timers: this.timers,
      });
    } catch (err) {
      throw new ApiError(err.kind ?? 'network', { sent: err.sent === true, detail: err.message });
    }
    const date = Date.parse(res.headers?.date ?? '');
    const status = res.status;
    if (status === 401 || status === 403) throw new ApiError('auth', { status });
    if (status === 429)
      throw new ApiError('rate', { status, retryAfter: retryAfterMs(res.headers) });
    if (status >= 500)
      throw new ApiError('server', { status, retryAfter: retryAfterMs(res.headers) });
    if (status < 200 || status > 299)
      throw new ApiError('bad', { status, detail: `HTTP ${status}` });
    let json;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new ApiError('bad', { status, detail: 'not JSON' });
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new ApiError('bad', { status, detail: 'not an object' });
    }
    if (Object.hasOwn(json, 'error')) {
      throw new ApiError('refused', { status, detail: cleanError(json.error) });
    }
    return { json, date: Number.isFinite(date) ? date : undefined };
  }
}

/** The error text of the API, printable and short (it never carries our keys). */
export function cleanError(value) {
  if (typeof value !== 'string') return 'error';
  return value.replace(/[^\x20-\x7e]/g, '').slice(0, 120) || 'error';
}
