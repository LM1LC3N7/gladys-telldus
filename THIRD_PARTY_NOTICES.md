# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). No
third-party code is copied into it. The calls of the Telldus APIs were written
after the project below, read as an example.

## tellduslive

<https://github.com/molobrakos/tellduslive> (package `tellduslive`, version
0.10.12 of 2024-08-28, read at commit c8f2861), by molobrakos and
contributors, the library of the Home Assistant `tellduslive` integration.
Released into the public domain under the Unlicense (`LICENSE` of the
repository: "This is free and unencumbered software released into the public
domain").

Read as an example, rewritten in JavaScript: the JSON calls of Telldus Live
and of the local API (`devices/list` with `supportedMethods`, `sensors/list`
with `includeValues` and `includeScale`, `device/turnOn`, `device/turnOff`,
`device/dim` with `level`), the method bits (1 on, 2 off, 16 dim), the
request-token exchange of the local API (`PUT /api/token` with `app`, then
`GET /api/token?token=...` once accepted, `GET /api/refreshToken`). Changed:
the OAuth 1 signature is written here from RFC 5849 (no library), every
answer is bounded and checked, and the local token is renewed only a week
before it expires.
