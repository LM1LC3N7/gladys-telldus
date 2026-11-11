// -----------------------------------------------------------------------------
// The only network access: one HTTP(S) request, bounded in time and size,
// abortable, telling whether the request LEFT (written on an open connection,
// TLS verified for HTTPS) when it fails. No redirect followed, no retry here,
// no keep-alive (each request on its own connection: a stuck one never
// delays another).
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import { LIMITS } from './constants.js';

export class HttpError extends Error {
  /** `kind`: 'network' | 'timeout' | 'aborted' | 'too-large'; `sent`: the request left. */
  constructor(kind, sent, message) {
    super(message ?? kind);
    this.kind = kind;
    this.sent = sent;
  }
}

const agents = {
  'http:': new http.Agent({ keepAlive: false, maxSockets: 4 }),
  'https:': new https.Agent({ keepAlive: false, maxSockets: 4 }),
};

/**
 * `{ status, headers, body }`; throws an HttpError. `timeoutMs` bounds the
 * whole exchange; `maxBytes` the body (cut as soon as it is passed, a
 * Content-Length above it refused before reading).
 */
export function request(
  url,
  {
    method = 'GET',
    headers = {},
    body,
    timeoutMs,
    maxBytes = LIMITS.answerBytes,
    signal,
    onSent,
    timers = globalThis,
  },
) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    let connected = false;
    let finished = false;
    let done = false;
    const sent = () => connected && finished;
    let told = false;
    const check = () => {
      if (!told && !done && sent()) {
        told = true;
        onSent?.();
      }
    };
    let req;
    const fail = (kind, message) => {
      if (done) return;
      done = true;
      timers.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const err = new HttpError(kind, sent(), message);
      req?.destroy();
      reject(err);
    };
    const timer = timers.setTimeout(() => fail('timeout'), timeoutMs);
    const onAbort = () => fail('aborted');
    if (signal?.aborted) {
      fail('aborted');
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      req = lib.request(target, {
        method,
        headers:
          body === undefined ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) },
        agent: agents[target.protocol],
      });
    } catch (err) {
      fail('network', err.code ?? 'invalid request');
      return;
    }
    req.on('socket', (socket) => {
      const event = target.protocol === 'https:' ? 'secureConnect' : 'connect';
      if (!socket.connecting && (event === 'connect' || socket.authorized)) connected = true;
      else
        socket.once(event, () => {
          connected = true;
          check();
        });
    });
    req.on('finish', () => {
      finished = true;
      check();
    });
    req.on('error', (err) => fail('network', err.code ?? 'network error'));
    req.on('response', (res) => {
      connected = true;
      finished = true;
      check();
      const length = Number(res.headers['content-length']);
      if (Number.isFinite(length) && length > maxBytes) {
        fail('too-large');
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          fail('too-large');
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', (err) => fail('network', err.code ?? 'network error'));
      res.on('end', () => {
        if (done) return;
        done = true;
        timers.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.end(body);
  });
}
