# gladys-telldus

External integration for [Gladys Assistant](https://gladysassistant.com): the
433 MHz plugs, lights and sensors of a **TellStick**, through **Telldus Live**
(cloud, your own API keys) or the **local API** of a TellStick ZNet / Net v2.
Unofficial, not affiliated with Telldus. Never tested with a real device.

- On/off receivers and dimmers: switch or light **once declared safe**, read
  only otherwise; the state is **assumed** (433 MHz gives no feedback).
- Temperature and humidity sensors.
- Turning off is not held by the safe list, a pause or a read in progress,
  and is sent again after 3 s and 10 s.

User documentation: [English](docs/en.md), [Français](docs/fr.md).

## Development

```bash
npm install
npm test                 # node --test
npm run lint
npm run format:check
npm run mutants          # the guards the tests must defend (slow)
```

See [CLAUDE.md](CLAUDE.md) for the rules of the project and
[TODO.md](TODO.md) for its state. Apache-2.0, see [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
