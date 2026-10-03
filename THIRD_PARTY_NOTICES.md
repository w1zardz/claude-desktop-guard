# Third-party notices

This project independently implements a desktop proxy gate and configuration transaction. It does not copy or bundle implementation code from the repositories below.

- [deafenken/notme](https://github.com/deafenken/notme), MIT, copyright 2026 GeoMirror contributors: inspiration for auditing location/timezone consistency. Its browser extension is not injected into Claude Desktop. No claim of full browser fingerprint masking is made.
- [xnydl/claude-code-guard](https://github.com/xnydl/claude-code-guard): inspiration for explicit route selection and checking the final Mihomo node. No license was found when reviewed on 2026-10-03; its implementation is not copied or redistributed.
- [cso1z/claude-ip-guard](https://github.com/cso1z/claude-ip-guard), MIT: inspiration for checking the exit before use. This project fails closed when its checks fail.
- [AschoofAlpha/claude-sonar](https://github.com/AschoofAlpha/claude-sonar): inspiration for distinguishing observations from suspension predictions.
- [kobie3717/claude-oauth-proxy](https://github.com/kobie3717/claude-oauth-proxy): reviewed and deliberately not reused. No fabricated tool history, prompt rewriting, credential extraction, or subscription-to-API conversion is performed here.

Electron is provided under its own license and Chromium/Node.js notices, included by the application packager. Build dependency licenses remain available in their published packages and lockfile. Product names identify compatibility and do not imply affiliation or endorsement.

Local TLS private keys in network tests are disposable public fixtures for an ephemeral test server, not operational credentials.
