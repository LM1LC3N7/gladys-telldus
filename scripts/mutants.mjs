// -----------------------------------------------------------------------------
// The mutants the tests must kill: each one breaks a guard of the code; the
// suite (`node --test test/*.test.js`) must then fail. The unmodified suite
// runs first ("baseline FAILED" and exit 1 when it is red). One mutant at a
// time, in a copy of the repository made in a fresh temporary directory
// (`.git` left out, `node_modules` copied, never linked; removed after), the
// repository itself never touched; each run bounded in time (its whole
// process group killed past the deadline).
//
// Usage: node scripts/mutants.mjs [name filter]   (wrap it in memcap on a dev VM)
// -----------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const DEADLINE = 300_000;

const A = 'src/app.js';

export const MUTANTS = [
  // Commands that start something.
  ['safe list', A, 'if (!this.isSafe(id)) return T.notSafe;', ''],
  [
    'stop after the click wins',
    A,
    '// Just before the send: everything checked again, and no stop came since the click.\n      if ((this.stopGen.get(deviceKey) ?? 0) !== gen) return { refused: T.supersededByStop };',
    '',
  ],
  [
    'checked again before the send',
    A,
    'const again = this.startProblem(mode, id, cmd);\n      if (again) return { refused: again };',
    '',
  ],
  [
    'device takes the command',
    A,
    'if ((device.methods & cmd.need) === 0) return T.notSupported;',
    '',
  ],
  [
    'device list fresh',
    A,
    'this.listAt === undefined || this.monotonic() - this.listAt > TIMINGS.listMaxAge',
    'this.listAt === undefined',
  ],
  ['lane per device', A, 'this.inCommandLane(deviceKey, async', "this.inCommandLane('all', async"],
  [
    '5xx of one device never pauses',
    A,
    "pause. A 5xx of one device never pauses the others.\n    if (err.kind === 'rate') this.pause(err);",
    "pause. A 5xx of one device never pauses the others.\n    if (err.kind === 'rate' || err.kind === 'server') this.pause(err);",
  ],
  // Stops.
  [
    'stop cuts a stuck read',
    A,
    'this.readAbort?.abort();\n    stop.attempts += 1;',
    'stop.attempts += 1;',
  ],
  [
    'stop ignores a pause',
    A,
    'if (this.refused()) return T.stopRefusedAuth;\n    return true;',
    'if (this.refused() || this.paused()) return T.stopRefusedAuth;\n    return true;',
  ],
  [
    'stop not sent with refused keys',
    A,
    'if (this.refused()) return T.stopRefusedAuth;\n    return true;',
    'return true;',
  ],
  ['two resends', 'src/constants.js', 'stopResends: [3_000, 10_000]', 'stopResends: [3_000]'],
  ['bounded tries', A, 'if (stop.attempts >= TIMINGS.stopAttempts || age', 'if (age'],
  [
    'newer turn on cancels the resends',
    A,
    'if (this.stops.get(deviceKey) === held && held) this.endStop(deviceKey);',
    '',
  ],
  [
    'turned on elsewhere cancels the resends',
    A,
    'says nothing).\n        this.endStop(key);',
    'says nothing).',
  ],
  [
    'stops kept in /data',
    A,
    'this.memory.stops = [...this.stops.values()]',
    'this.memory.stops = [].concat([])\n    void [...this.stops.values()]',
  ],
  [
    'stop never replayed late',
    A,
    'if (this.stopAge(stop) > TIMINGS.stopMaxAge) {\n        // Never',
    'if (false) {\n        // Never',
  ],
  [
    'old stops dropped from /data',
    'src/store.js',
    'if (now - at > TIMINGS.stopMaxAge || keys.has',
    'if (keys.has',
  ],
  // Reads.
  [
    'older read never over a command',
    A,
    'if ((this.commandAt.get(key) ?? -Infinity) >= started) continue;',
    '',
  ],
  [
    'refusal kept',
    A,
    "this.memory.auth = { refused: true, mark: this.credentialsMark() };\n      this.lastResult = { ok: false, kind: 'auth' };",
    "this.lastResult = { ok: false, kind: 'auth' };",
  ],
  [
    'secondary never a refusal',
    A,
    "if (err.kind === 'auth') {\n        // A secondary",
    "if (err.kind === 'auth') {\n        this.memory.auth = { refused: true, mark: this.credentialsMark() };\n        // A secondary",
  ],
  [
    'pause on 429/5xx',
    A,
    "if (err.kind === 'rate' || err.kind === 'server') {\n      this.pause(err);\n      this.lastResult",
    "if (err.kind === 'rate' || err.kind === 'server') {\n      this.lastResult",
  ],
  ['Retry-After honored', A, 'Math.max(doubled, err.retryAfter ?? 0)', 'doubled'],
  [
    'first read after the interval',
    A,
    'return elapsed >= 0 ? Math.max(0, this.config.pollMs - elapsed) : 0;',
    'return 0;',
  ],
  [
    'future /data date invalid',
    'src/store.js',
    'value > 0 && value <= now ? value',
    'value > 0 ? value',
  ],
  [
    'attempt in /data before the read',
    A,
    'await this.save();\n    if (gen !== this.generation) return this.lastResult;\n    if (this.config.mode',
    'if (gen !== this.generation) return this.lastResult;\n    if (this.config.mode',
  ],
  ['test button spacing', A, 'if (since < min) {', 'if (false) {'],
  ['value age', A, '|| now - at > TIMINGS.valueMaxAge) continue;', ') continue;'],
  ['value never twice', A, 'if ((this.memory.seen.get(featureId) ?? 0) >= at) continue;', ''],
  ['answer bounded', 'src/http.js', 'if (size > maxBytes) {', 'if (false) {'],
  ['secrets masked', A, "for (const s of secrets) out = out.split(s).join('***');", ''],
  // Local token.
  [
    'renew only near expiry',
    A,
    'if (token.expires - this.now() > TIMINGS.tokenRenewBefore) return;',
    '',
  ],
  [
    'renew only the known token',
    A,
    'if (token.mark !== mark(this.memory.salt, current)) return;',
    '',
  ],
  // Model and configuration.
  [
    'not safe is read only',
    'src/model.js',
    "return [['state', safe ? binary(C.SWITCH, false) : binary(C.UNKNOWN, true)]];",
    "return [['state', binary(C.SWITCH, false)]];",
  ],
  ['no multicast host', 'src/config.js', 'bytes[0] >= 224', 'bytes[0] >= 240'],
  [
    'unknown is never 0',
    'src/model.js',
    "if (typeof value === 'string' && /^-?\\d{1,4}(?:\\.\\d{1,3})?$/.test(value)) return Number(value);",
    "if (typeof value === 'string') return Number(value);",
  ],
  // Review r1.
  [
    'I1 stop age monotonic',
    A,
    'return this.monotonic() - stop.atMono;',
    'return this.now() - stop.at;',
  ],
  [
    'I2 one timer per stop',
    A,
    'if (stop.timer) this.timers.clearTimeout(stop.timer);\n    stop.timer = this.timers.setTimeout(async',
    'stop.timer = this.timers.setTimeout(async',
  ],
  [
    'I2 planStop after stop()',
    A,
    'if (this.stopped || this.stops.get(key) !== stop) return;\n    const resends',
    'if (this.stops.get(key) !== stop) return;\n    const resends',
  ],
  [
    'I2 stop() cancels the stop timers',
    A,
    'if (stop.timer) this.timers.clearTimeout(stop.timer);\n      stop.timer = undefined;\n    }\n    for (const [handle',
    'stop.timer = undefined;\n    }\n    for (const [handle',
  ],
  [
    'I3 new keys lift the refusal',
    A,
    'if (credentialsChanged && before && this.memory.auth.refused) {',
    'if (false) {',
  ],
  ['I4 resend waits for a newer turn on', A, 'if (held) held.holdWait = wait;', ''],
  [
    'I4 one send of a stop at a time',
    A,
    'if (this.stopped || this.stops.get(key) !== stop || stop.inflight) {',
    'if (this.stopped || this.stops.get(key) !== stop) {',
  ],
  [
    'I4 sensors 429/5xx pause',
    A,
    "if (err.kind === 'rate' || err.kind === 'server') {\n        this.pause(err);\n        return;",
    "if (err.kind === 'rate' || err.kind === 'server') {\n        return;",
  ],
  [
    'I4 command 429 pauses',
    A,
    "pause. A 5xx of one device never pauses the others.\n    if (err.kind === 'rate') this.pause(err);",
    'pause. A 5xx of one device never pauses the others.',
  ],
  ['I4 read 3 s after the send', A, 'started - stop.lastSendAt >= TIMINGS.stopReadAfter', 'true'],
  [
    'I4 retry within 250 ms',
    A,
    'if (!this.stopped && this.stops.get(key) === stop && !stop.inflight)\n        outcome = await this.sendStop(stop, deadline);',
    '',
  ],
  [
    'I4 generation in connected',
    A,
    'if (this.loading) await this.loading;\n    if (gen !== this.generation) return;',
    'if (this.loading) await this.loading;',
  ],
  [
    'M2 refused by Telldus said',
    A,
    "            return 'refused';",
    "            return 'failed-sent';",
  ],
  [
    'M4 no ON over a newer stop',
    A,
    'if ((this.stopGen.get(deviceKey) ?? 0) !== gen) return { ok: true };',
    '',
  ],
];

async function run(dir) {
  // `node --test test/*.test.js`, the glob expanded here.
  const files = (await readdir(join(dir, 'test'))).filter((f) => f.endsWith('.test.js')).sort();
  return new Promise((resolve) => {
    const args = ['--test', '--test-timeout=60000', ...files.map((f) => `test/${f}`)];
    const child = spawn(process.execPath, args, {
      cwd: dir,
      stdio: 'ignore',
      detached: true,
      shell: false,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
      resolve('timeout');
    }, DEADLINE);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? 'survived' : 'killed');
    });
  });
}

/** A copy of the repository (no `.git`; `node_modules` copied, never linked). */
async function copy(dir) {
  await cp(REPO, dir, {
    recursive: true,
    filter: (src) => !/[/\\]\.git$/.test(src),
  });
}

async function main() {
  const filter = process.argv[2];
  const survivors = [];
  // The unmodified suite first: a red baseline would make every mutant look killed.
  const base = await mkdtemp(join(tmpdir(), 'telldus-baseline-'));
  try {
    await copy(base);
    const outcome = await run(base);
    if (outcome !== 'survived') {
      console.log(`baseline FAILED (${outcome})`);
      process.exitCode = 1;
      return;
    }
    console.log('baseline ok');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
  for (const [name, file, from, to] of MUTANTS) {
    if (filter && !name.includes(filter)) continue;
    const dir = await mkdtemp(join(tmpdir(), 'telldus-mutant-'));
    try {
      await copy(dir);
      const path = join(dir, file);
      const text = await readFile(path, 'utf8');
      const count = text.split(from).length - 1;
      if (count !== 1) {
        console.log(`STALE   ${name}: found ${count} times in ${file}`);
        survivors.push(name);
        continue;
      }
      await writeFile(path, text.replace(from, to));
      const outcome = await run(dir);
      console.log(`${outcome.toUpperCase().padEnd(8)}${name}`);
      if (outcome !== 'killed') survivors.push(name);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  console.log(survivors.length ? `Not killed: ${survivors.join(', ')}` : 'Every mutant killed');
  process.exitCode = survivors.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
