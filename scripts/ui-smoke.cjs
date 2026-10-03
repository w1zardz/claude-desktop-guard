'use strict';
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');

(async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.CDG_PACKAGED_EXECUTABLE;
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}),
    args: executablePath ? ['--smoke-test'] : [path.resolve(__dirname, '..'), '--smoke-test'], env, timeout: 60000 });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.getElementById('system-timezone').textContent !== '—');
    assert.equal(await page.title(), 'Claude Desktop Guard');
    assert.equal(await page.locator('#proxy-url').inputValue(), '');
    assert.equal(await page.locator('#start-button').isDisabled(), true);
    assert.equal(await page.locator('#probe-button').isDisabled(), true);
    await page.locator('#proxy-url').fill('http://127.0.0.1:1');
    assert.equal(await page.locator('#probe-button').isEnabled(), true);
    assert.equal(await page.locator('#start-button').isDisabled(), true);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
    await page.locator('#proxy-url').fill('');
    const screenshot = process.env.CDG_SCREENSHOT || path.join(os.tmpdir(), 'claude-desktop-guard.png');
    await fs.mkdir(path.dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, 'UI must fit window width');
    console.log('Electron UI smoke passed: empty defaults, explicit pin, renderer isolation, layout.');
  } finally { await app.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
