# TODO — Telldus v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Status

- [x] **Milestone 1 — core** (2026-11-11): Telldus Live (OAuth 1 signed
      requests, the four keys of api.telldus.com/keys) and the local API of
      a TellStick ZNet / Net v2 (request token, accepted in the browser,
      saved with `setConfig`, renewed a week before expiry); devices
      (on/off, dimmer) with assumed state, declared-safe rule, stops with
      resends kept in `/data`; temperature and humidity sensors with source
      dates; refusals, pauses, bounded answers; docs en/fr; tests on a fake
      Telldus HTTP server (virtual and real clock), mutants.
- [ ] **Milestone 2 — real hardware**: a TellStick ZNet v2 and a Telldus Live
      account: check the field names and types of `devices/list` and
      `sensors/list` (strings or numbers), the `lastUpdated` of each sensor
      value, the error answers of a bad signature (401 or 200 + `error`),
      the local token flow and `refreshToken` (does it rotate the token?);
      how soon after a `device/turnOff` Telldus Live shows the new `state`
      (a read that left 3 s after a send may cancel the resends, r1 M5).
- [ ] **Milestone 3 — more devices**: groups, shutters (up/down/stop, with
      the opening option), bells, the other sensor values (rain, wind, UV,
      power), battery (253/254/255 or a percentage).
- [ ] **Milestone 4 — first release**: Docker image, store validator,
      Release workflow, topic.

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, `docker_image`).
- Manifest: categories `protocols`, `lighting`, `environment`; no
  `keywords` / `countries` (Telldus sells in SE, NO, the EU: to add with the
  store if wanted).
- Reference: tellduslive (Unlicense) read as an example; the official API
  documentation (api.telldus.com/explore) needs a login, not read.
- Live API host `api.telldus.com` (answers 401 without keys on 2026-11-11;
  `pa-api.telldus.com` of tellduslive answers the same).
- External ids `ext:telldus:device:<mode>-<id>` and `...:sensor:<mode>-<id>`,
  frozen; Live and local ids differ, so a mode change gives new devices.
- Declared-safe rule (Louis, model gladys-mysensors): a device not listed is
  `unknown` read only, never a `switch`/`light`.
- Stops: independent of the safe list, pauses, device list, `/data`; they cut
  a read in flight; sent again after 3 s and 10 s; a failed send tried again
  every 10 s, 6 tries, 2 minutes; cancelled by a newer turn on accepted by
  Telldus, or a read (started after) showing the device on.
- Commands serialized per device, never across devices; a 5xx on a command
  never pauses the others; a 429 pauses the account (all but stops).
- Credentials: never in `/data`, logs, status, errors (the API error texts
  are masked). The local token lives in the Gladys configuration only; its
  expiry and a 6-bit salted mark are in `/data`.
- Refusal mark: 6 bits salted (fiche: 4-8 bits; 32 bits tried in r1 and
  reverted in r2, a long fingerprint of a secret could help a brute force).
  Changed credentials or a new local token lift a refusal at once while the
  module runs. After a restart, other credentials share the mark of the
  refused ones once in 64: the reads then wait, but the test button always
  tries and its success clears the mark, and the stops take a mark as a hint
  only (they are held only by a refusal seen while the module runs).
- Stop ages on the monotonic clock (review r1, I1); the wall date of /data
  only places a stop kept across a restart, bounded to 2 minutes.
- The test button may lift a refusal by a success, not more often than the
  mode's minimum interval (60 s Live, 10 s local).
