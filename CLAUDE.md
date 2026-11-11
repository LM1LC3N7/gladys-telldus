# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.16). It
reads and drives the 433 MHz devices and sensors of a TellStick through
Telldus Live (OAuth 1, the user's keys) or the local API of a TellStick ZNet /
Net v2 (Bearer token). Not affiliated with Telldus.

## Commands

```bash
npm install
npm test                 # node --test --test-timeout=60000
npm run lint
npm run format:check
npm run audit
npm run mutants          # under memcap on a dev VM
```

## Architecture

```
index.js           SDK bootstrap only
src/handlers.js    every SDK handler -> the app (shared with the tests)
src/app.js         TelldusApp: config, reads, Discovery, commands, stops, buttons
src/api.js         the Telldus calls, OAuth 1 signature, answer classification
src/http.js        the only network access: one bounded, abortable request
src/model.js       lists -> devices, values, commands (pure)
src/store.js       /data (no secret)
src/publisher.js   states within the Gladys rate limit
src/config.js      config_schema normalized
src/i18n.js        runtime texts (en/fr)
test/helpers/      fake Telldus HTTP server, virtual and real clocks
scripts/           cover.png, mutants
```

## Rules

- External ids are forever (`ext:<selector>:device:<mode>-<id>`, feature keys
  `state`, `brightness`, `temperature`, `humidity`). Manifest keys are frozen.
- A device is a switch or a light only when declared safe. Turning off is
  never held by an option, a pause, the device list or `/data`.
- No key or token in logs, status, errors or `/data`; the forbidden words of test/encoding.test.js stay out of every text.
- `monotonic` for every decision, `now` only for `/data`, OAuth and source dates.
- A guard whose mutant survives gets a test, never removed.
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` in sync.
