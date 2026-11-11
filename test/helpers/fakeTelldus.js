// -----------------------------------------------------------------------------
// A fake Telldus API on a real local HTTP server (127.0.0.1, free port): the
// Live paths under /json/ and the local ones under /api/, the same answers.
// Routes are `'GET devices/list'` -> a function `(req, srv) => answer`, an
// answer being an object (JSON 200), `reply(status, body, headers)`, 'hang'
// (never answers until `release()`), or 'drop' (closes the socket).
// Every request is recorded (`requests`, `count(path)`); the Date header is
// the one of the injected clock.
// -----------------------------------------------------------------------------

import http from 'node:http';

export const reply = (status, body, headers = {}) => ({ __reply: true, status, body, headers });

export function defaultData(now) {
  const s = Math.floor(now() / 1000);
  return {
    devices: [
      { id: '101', name: 'Lamp', methods: 3, state: 2, statevalue: '', type: 'device' },
      { id: '102', name: 'Dimmer', methods: 19, state: 16, statevalue: '128', type: 'device' },
      { id: '103', name: 'Heater plug', methods: 3, state: 1, statevalue: '', type: 'device' },
    ],
    sensors: [
      {
        id: '201',
        name: 'Outdoor',
        lastUpdated: s - 60,
        data: [
          { name: 'temp', value: '12.5', scale: '0' },
          { name: 'humidity', value: '80', scale: '0' },
        ],
      },
    ],
  };
}

export async function fakeTelldus({ now = Date.now, latencyMs = 0 } = {}) {
  const data = defaultData(now);
  const requests = [];
  const held = new Set();
  let waiting = 0;
  const srv = {
    data,
    requests,
    latencyMs,
    /** Requests waiting on a 'hang' route (the virtual clock may move meanwhile). */
    get hanging() {
      return held.size + waiting;
    },
    routes: {},
    count: (path) => requests.filter((r) => r.path === path).length,
    of: (path) => requests.filter((r) => r.path === path),
    release() {
      for (const h of held) h();
      held.clear();
    },
  };
  const success = () => ({ status: 'success' });
  const defaults = {
    'GET devices/list': () => ({ device: data.devices }),
    'GET sensors/list': () => ({ sensor: data.sensors }),
    'GET device/turnOn': (r) => {
      const d = data.devices.find((x) => x.id === r.query.id);
      if (d) d.state = 1;
      return success();
    },
    'GET device/turnOff': (r) => {
      const d = data.devices.find((x) => x.id === r.query.id);
      if (d) d.state = 2;
      return success();
    },
    'GET device/dim': (r) => {
      const d = data.devices.find((x) => x.id === r.query.id);
      if (d) {
        d.state = 16;
        d.statevalue = r.query.level;
      }
      return success();
    },
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname.replace(/^\/(json|api)\//, '');
      const record = {
        method: req.method,
        path,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(record);
      const route = srv.routes[`${req.method} ${path}`] ?? defaults[`${req.method} ${path}`];
      let answer = route ? route(record, srv) : reply(404, { error: 'not found' });
      if (answer === 'hang') {
        let release;
        const wait = new Promise((resolve) => (release = resolve));
        held.add(release);
        res.on('close', () => {
          held.delete(release);
          release();
        });
        await wait;
        held.delete(release);
        if (!res.writable || res.destroyed) return;
        const key = `${req.method} ${path}`;
        answer = defaults[key] ? defaults[key](record, srv) : reply(500, {});
      }
      if (answer && typeof answer.then === 'function') {
        // An answer given later by the test (a snapshot taken now, sent then).
        waiting += 1;
        try {
          answer = await answer;
        } finally {
          waiting -= 1;
        }
      }
      if (answer === 'drop') {
        req.socket.destroy();
        return;
      }
      if (srv.latencyMs) await new Promise((resolve) => setTimeout(resolve, srv.latencyMs));
      const { status, body, headers } = answer?.__reply
        ? answer
        : { status: 200, body: answer, headers: {} };
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      if (!res.writable) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        Date: new Date(now()).toUTCString(),
        ...headers,
      });
      res.end(text);
    });
  });
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  srv.port = port;
  srv.host = `127.0.0.1:${port}`;
  srv.liveUrl = `http://127.0.0.1:${port}/json/`;
  srv.close = async () => {
    srv.release();
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
  return srv;
}
