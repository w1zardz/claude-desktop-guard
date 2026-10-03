# Client environment validation

## Actual Claude Desktop on macOS

Measured on 2026-10-03 in the Code tab of the installed, unmodified Claude Desktop **2.19675.0**, using its bundled **Electron 44.4.3 / Chromium 152.0.7977.130**. Guard's launcher supplied this explicit profile before starting the application:

```json
{"enabled":true,"timezone":"Europe/Helsinki","language":"en-US","region":"FI"}
```

The selected Amnezia tunnel's exit check returned country `FI` and timezone `Europe/Helsinki`. Measurement used Claude's own local DevTools console. No model prompt was sent, TLS was not decrypted, and account tokens/cookies were not inspected.

| Signal inside the actual Claude renderer | Measured value |
| --- | --- |
| `Intl.DateTimeFormat().resolvedOptions().timeZone` | `Europe/Helsinki` |
| Default Intl locale | `en-US` |
| `navigator.language` | `en-US` |
| `navigator.languages` | `["en-US"]` |
| `window.desktopPreferredLanguages` | `["en-US"]` |
| `(await window.electronIntl.getInitialLocale()).locale` | `en-US` |
| January 15, 2026 timezone offset | `-120` minutes (UTC+2) |
| July 15, 2026 timezone offset | `-180` minutes (UTC+3) |
| User-Agent | Retains real Claude/Electron/Chromium version and macOS platform |
| Host macOS timezone after launch | `Europe/Moscow`, unchanged |

This proves these listed values for that application version and launch. It does not prove every request, local Code child, remote session, hardware fingerprint or server-side account decision. Guard's normal UI deliberately says **parameters passed**: it does not automatically open Claude's DevTools or pretend that its own Electron renderer is Claude.

Claude's supported developer preference `allowDevTools` was enabled temporarily for this measurement and its original absent state restored afterward. No remote debugging port/pipe or vendor executable patch was used. Current Claude versions reject external CDP debugging flags without vendor authorization; Guard does not bypass that check.

## Cross-platform regression test

Run `npm run test:client`. A separate sandboxed Electron fixture uses the actual `buildLaunch` function and a local HTTP proxy fixture. It verifies:

- Renderer, worker and child Node timezone are `Europe/Helsinki`.
- Winter/summer offsets follow Finland's DST rules.
- Chromium primary language and the HTTP `Accept-Language` header match explicit `en-GB`. On macOS the entire language list is `["en-GB"]`; on Windows the test also confirms that native OS languages remain in that list.
- On macOS, Cocoa preferred languages become `["en-GB"]` and native regional locale becomes `en-FI`.
- Host environment remains unchanged. The `.invalid` page name is handled by the local fixture; no external service is contacted.

The fixture runs in CI on macOS, Windows and Linux. A passing Windows fixture is evidence for the tested Electron runtime, **not** a live test of Claude Desktop on the user's Windows PC.

Windows native preferred languages and regional APIs remain those of Windows. Electron also appends these native languages to `navigator.languages`: choosing a primary language does not conceal fallback OS languages. Chromium language and Node locale environment do not replace those APIs. Changing the system timezone while Claude runs can reset Chromium's Windows timezone; relaunch Claude through Guard afterward. A previously saved Desktop UI language can also override automatic UI language selection.

## Reproduce the actual application measurement

Quit Claude completely, select and verify the VPN/proxy exit in Guard, then explicitly choose the timezone, language and region. Start Claude through Guard. If your Claude deployment permits its built-in DevTools, use `Cmd+Option+I` on macOS or `Ctrl+Alt+I` on Windows and evaluate this read-only expression in its Console:

```js
JSON.stringify({
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  locale: Intl.DateTimeFormat().resolvedOptions().locale,
  language: navigator.language,
  languages: navigator.languages,
  desktopPreferredLanguages: window.desktopPreferredLanguages,
  uiLocale: (await window.electronIntl.getInitialLocale()).locale,
  winterOffset: new Date('2026-01-15T12:00:00Z').getTimezoneOffset(),
  summerOffset: new Date('2026-07-15T12:00:00Z').getTimezoneOffset(),
  userAgent: navigator.userAgent
})
```

Native locale APIs and process-scoped Cocoa argument defaults are documented by [Electron](https://www.electronjs.org/docs/latest/api/app#getpreferredsystemlanguages) and [Apple](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/UserDefaults/AboutPreferenceDomains/AboutPreferenceDomains.html). Node's Windows initialization explicitly applies `TZ` to ICU at startup: [Node source](https://github.com/nodejs/node/blob/v24.21.0/src/node.cc#L974). Runtime tests remain necessary because Chromium's timezone monitor also reacts to OS changes.

OS/platform, User-Agent, RAM/device-class headers, GPU, fonts, Canvas/WebGL, TLS properties, account history and server-side restrictions remain outside this profile's masking scope. No ban-prevention effectiveness has been measured.
