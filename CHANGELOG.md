# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: the 433 MHz devices and sensors of a TellStick through
  Telldus Live (OAuth 1 with the user's own keys) or the local API of a
  TellStick ZNet / Net v2 (token granted in the browser, renewed before it
  expires): on/off receivers and dimmers (assumed state), temperature and
  humidity sensors.
- A device is a switch or a light only once its Telldus id is declared safe;
  otherwise read only. Turning off is never held, sent again after 3 s and
  10 s, kept in `/data` across a restart.
- Stops aged on the monotonic clock, one timer per stop, nothing after
  shutdown; a resend waits for a newer turn on on its way (review r1).
- A 401/403 on a stop after a restart confirms a kept refusal (one try per
  click); shutdown finishes the last `/data` write.
- Refused credentials kept in `/data` (salted 6-bit mark), pauses after a
  429 / 5xx, bounded answers, the "Test the connection", "Request local
  access" and "Finish local access" buttons.
