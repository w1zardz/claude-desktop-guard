'use strict';
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { buildLaunch } = require('../src/desktop.cjs');

(async () => {
  const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let headers;
  // A local HTTP proxy fixture captures only this test page's language header.
  // The .invalid name is never resolved and no external service is contacted.
  const server = http.createServer((request, response) => {
    headers = { language: request.headers['accept-language'] };
    response.end('<title>Client environment fixture</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let app;
  try {
    const clientMask = { enabled: true, timezone: 'Europe/Helsinki', language: 'en-GB', region: 'FI' };
    const launch = buildLaunch({ desktop: { platform: process.platform === 'darwin' ? 'darwin' : 'win32',
      path: require('electron'), version: '2.19675.0' },
      proxyUrl: `http://127.0.0.1:${server.address().port}`, clientMask });
    delete launch.env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: launch.executable,
      args: [path.resolve(__dirname, '../test/fixtures/client-window.cjs'), ...launch.args], env: launch.env, timeout: 60000 });
    const page = await app.firstWindow();
    await page.waitForLoadState();
    const main = await app.evaluate(({ app }) => ({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: app.getLocale(), preferredLanguages: app.getPreferredSystemLanguages(), systemLocale: app.getSystemLocale() }));
    const renderer = await page.evaluate(async () => {
      const worker = await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(new Blob(['postMessage(Intl.DateTimeFormat().resolvedOptions().timeZone)'], { type: 'text/javascript' }));
        const child = new Worker(url);
        child.onmessage = event => { resolve(event.data); child.terminate(); URL.revokeObjectURL(url); };
        child.onerror = reject;
      });
      return { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: Intl.DateTimeFormat().resolvedOptions().locale,
        language: navigator.language, languages: navigator.languages, workerTimezone: worker,
        winterOffset: new Date('2026-01-15T12:00:00Z').getTimezoneOffset(),
        summerOffset: new Date('2026-07-15T12:00:00Z').getTimezoneOffset() };
    });
    console.log(JSON.stringify({ platform: process.platform, main, renderer, headers }));
    assert.equal(main.timezone, clientMask.timezone);
    assert.equal(renderer.timezone, clientMask.timezone);
    assert.equal(renderer.workerTimezone, clientMask.timezone);
    assert.equal(renderer.language, clientMask.language);
    assert.equal(renderer.languages[0], clientMask.language);
    assert.equal(renderer.winterOffset, -120); assert.equal(renderer.summerOffset, -180);
    assert.match(headers.language, /^en-GB(?:,|$)/);
    if (process.platform === 'darwin') {
      assert.deepEqual(renderer.languages, [clientMask.language]);
      assert.deepEqual(main.preferredLanguages, [clientMask.language]); assert.equal(main.systemLocale, 'en-FI');
    }
    if (process.platform === 'win32') {
      // Electron appends native OS languages to navigator.languages on Windows.
      // Assert this remaining signal rather than claiming it was removed.
      for (const language of main.preferredLanguages) assert.ok(renderer.languages.includes(language));
    }
    const child = JSON.parse(execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,language:process.env.LANG}))'], { env: launch.env, encoding: 'utf8' }));
    assert.equal(child.timezone, clientMask.timezone); assert.equal(child.language, 'en_GB.UTF-8');
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, hostTimezone);
  } finally {
    await app?.close(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
