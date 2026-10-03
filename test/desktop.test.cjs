'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const childProcess = require('node:child_process');
const realExecFile = childProcess.execFile;
const { EventEmitter } = require('node:events');
const desktop = require('../src/desktop.cjs');

const PROXY = 'http://127.0.0.1:48123';
function shellMock(t, { running = false, managed = { desktop: [], code: [] }, packages = [] } = {}) {
  t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    const script = args[args.length - 1];
    if (script.includes('Get-Process')) return callback(null, running ? '1' : '0');
    if (script.includes('Get-AppxPackage')) return callback(null, JSON.stringify(packages));
    if (script.includes('Policies')) return callback(null, JSON.stringify(managed));
    callback(new Error('Unexpected process command'));
  });
}
async function fixture(t, mock = {}) {
  const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'desktop-guard-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  shellMock(t, mock);
  const home = path.join(base, 'home'), local = path.join(base, 'local');
  const library = path.join(local, 'Claude-3p', 'configLibrary'), settings = path.join(home, '.claude', 'settings.json');
  const options = { platform: 'win32', home, env: { LOCALAPPDATA: local, ProgramFiles: path.join(base, 'program-files') }, journalDir: path.join(base, 'private-journal'), proxyUrl: PROXY };
  await fs.mkdir(home, { recursive: true });
  return { base, home, library, settings, options };
}
async function jsonWrite(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`); }
async function jsonRead(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function absent(file) { await assert.rejects(fs.stat(file), { code: 'ENOENT' }); }
async function existingProfile(f, config = {}, metaExtras = {}) {
  const configId = '27ada76f-97a3-4389-b354-c6fdca77aa21';
  const configPath = path.join(f.library, `${configId}.json`), metaPath = path.join(f.library, '_meta.json');
  await jsonWrite(configPath, config);
  await jsonWrite(metaPath, { appliedId: configId, entries: [{ id: configId, name: 'Mine' }], ...metaExtras });
  return { configId, configPath, metaPath };
}

test('new profile restores existing metadata entries and deletes only owned files', async t => {
  const f = await fixture(t), metaPath = path.join(f.library, '_meta.json');
  const original = { entries: [{ id: 'other-profile', name: 'Other' }], theme: 'dark' };
  await jsonWrite(metaPath, original);
  const bytes = await fs.readFile(metaPath);
  assert.equal((await desktop.installDesktopProxy(f.options)).installed, true);
  const meta = await jsonRead(metaPath);
  assert.equal(meta.entries.length, 2);
  const configPath = path.join(f.library, `${meta.appliedId}.json`);
  assert.deepEqual(await jsonRead(configPath), { egressProxyUrl: PROXY });
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(f.options.journalDir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
  }
  assert.equal((await desktop.restoreDesktopProxy(f.options.journalDir)).restored, true);
  assert.deepEqual(await fs.readFile(metaPath), bytes);
  await absent(configPath); await absent(f.settings);
  assert.equal((await desktop.restoreDesktopProxy(f.options.journalDir)).restored, true);
});

test('existing profile and credentials restore exact original bytes', async t => {
  const f = await fixture(t);
  const profile = await existingProfile(f, { egressProxyUrl: 'http://original.example:8080', inferenceCredential: 'secret', unknown: { keep: true } });
  await jsonWrite(f.settings, { model: 'opus', env: { HTTPS_PROXY: 'http://name:private@old:9000', NO_PROXY: 'corp.example', TOKEN: 'private' } });
  const beforeConfig = await fs.readFile(profile.configPath), beforeSettings = await fs.readFile(f.settings), beforeMeta = await fs.readFile(profile.metaPath);
  await desktop.installDesktopProxy(f.options);
  assert.equal((await jsonRead(profile.configPath)).inferenceCredential, 'secret');
  assert.equal((await jsonRead(f.settings)).env.TOKEN, 'private');
  assert.deepEqual(await fs.readFile(profile.metaPath), beforeMeta);
  assert.equal((await desktop.restoreDesktopProxy(f.options.journalDir)).restored, true);
  assert.deepEqual(await fs.readFile(profile.configPath), beforeConfig);
  assert.deepEqual(await fs.readFile(f.settings), beforeSettings);
});

test('restore preserves independent unrelated edits', async t => {
  const f = await fixture(t), profile = await existingProfile(f, { model: 'old' });
  await desktop.installDesktopProxy(f.options);
  const config = await jsonRead(profile.configPath); config.model = 'new'; await jsonWrite(profile.configPath, config);
  const settings = await jsonRead(f.settings); settings.permissions = { allow: ['Read'] }; settings.env.OTHER = 'keep'; await jsonWrite(f.settings, settings);
  const restored = await desktop.restoreDesktopProxy(f.options.journalDir);
  assert.equal(restored.restored, true);
  assert.deepEqual(await jsonRead(profile.configPath), { model: 'new' });
  assert.deepEqual(await jsonRead(f.settings), { env: { OTHER: 'keep' }, permissions: { allow: ['Read'] } });
});

test('restore refuses changed touched proxy keys and applied configuration', async t => {
  const f = await fixture(t), profile = await existingProfile(f, {});
  await desktop.installDesktopProxy(f.options);
  await jsonWrite(profile.configPath, { egressProxyUrl: 'http://someone-else:8000' });
  const settings = await jsonRead(f.settings); settings.env.HTTPS_PROXY = 'http://manual:8000'; await jsonWrite(f.settings, settings);
  const result = await desktop.restoreDesktopProxy(f.options.journalDir);
  assert.equal(result.restored, false);
  assert.ok(result.conflicts.some(item => item.code === 'PROXY_CHANGED'));
  assert.ok(result.conflicts.some(item => item.code === 'USER_HTTPS_PROXY_CHANGED'));
  assert.equal((await jsonRead(profile.configPath)).egressProxyUrl, 'http://someone-else:8000');
  assert.equal((await jsonRead(f.settings)).env.HTTPS_PROXY, 'http://manual:8000');
  const meta = await jsonRead(profile.metaPath); meta.appliedId = 'other'; await jsonWrite(profile.metaPath, meta);
  assert.ok((await desktop.restoreDesktopProxy(f.options.journalDir)).conflicts.some(item => item.code === 'APPLIED_CONFIG_CHANGED'));
});

test('edited owned profile is preserved completely', async t => {
  const f = await fixture(t); await desktop.installDesktopProxy(f.options);
  const meta = await jsonRead(path.join(f.library, '_meta.json')), configPath = path.join(f.library, `${meta.appliedId}.json`);
  await jsonWrite(configPath, { egressProxyUrl: PROXY, userSetting: 'keep' });
  const result = await desktop.restoreDesktopProxy(f.options.journalDir);
  assert.equal(result.restored, false);
  assert.ok(result.conflicts.some(item => item.code === 'CREATED_CONFIG_CHANGED'));
  assert.deepEqual(await jsonRead(configPath), { egressProxyUrl: PROXY, userSetting: 'keep' });
  assert.equal((await jsonRead(path.join(f.library, '_meta.json'))).appliedId, meta.appliedId);
});

test('edited owned metadata entry prevents deletion of its configuration', async t => {
  const f = await fixture(t); await desktop.installDesktopProxy(f.options);
  const metaPath = path.join(f.library, '_meta.json'), meta = await jsonRead(metaPath);
  meta.entries[0].name = 'Renamed by user'; await jsonWrite(metaPath, meta);
  const result = await desktop.restoreDesktopProxy(f.options.journalDir);
  assert.equal(result.restored, false);
  assert.ok(result.conflicts.some(item => item.code === 'META_ENTRY_CHANGED'));
  assert.ok((await fs.stat(path.join(f.library, `${meta.appliedId}.json`))).isFile());
  assert.equal((await jsonRead(metaPath)).entries[0].name, 'Renamed by user');
});

test('planned journal restores interrupted installation without touching unchanged originals', async t => {
  const f = await fixture(t), profile = await existingProfile(f, { keep: 1 });
  await jsonWrite(f.settings, { env: { HTTPS_PROXY: 'http://original:80' }, model: 'old' });
  await desktop.installDesktopProxy(f.options);
  const file = path.join(f.options.journalDir, 'desktop-transaction.json'), journal = await jsonRead(file);
  journal.phase = 'planned'; await jsonWrite(file, journal);
  await fs.writeFile(f.settings, Buffer.from(journal.settings.original, 'base64'));
  assert.equal((await desktop.restoreDesktopProxy(f.options.journalDir)).restored, true);
  assert.deepEqual(await jsonRead(profile.configPath), { keep: 1 });
  assert.equal((await jsonRead(f.settings)).env.HTTPS_PROXY, 'http://original:80');
});

test('installer rejects malformed metadata, traversal, hybrid configuration and PAC', async t => {
  const f = await fixture(t), metaPath = path.join(f.library, '_meta.json');
  for (const meta of [{ appliedId: '../outside', entries: [] }, { appliedId: 'x', entries: 'bad' }, { hybridPointer: null }, { appliedId: 42 }, { entries: [{ id: 'x' }, { id: 'x' }] }]) {
    await jsonWrite(metaPath, meta);
    await assert.rejects(desktop.installDesktopProxy(f.options), error => ['MALFORMED_META', 'HYBRID_CONFIG'].includes(error.code));
    await absent(f.options.journalDir);
  }
  await existingProfile(f, { egressProxyPacUrl: 'https://corp/pac' });
  await assert.rejects(desktop.installDesktopProxy(f.options), { code: 'PAC_CONFLICT' });
  await absent(f.options.journalDir);
});

test('installer rejects symlink files and parent directories', async t => {
  const f = await fixture(t), target = path.join(f.base, 'target.json');
  await jsonWrite(target, {}); await fs.mkdir(f.library, { recursive: true });
  await fs.symlink(target, path.join(f.library, '_meta.json'));
  await assert.rejects(desktop.installDesktopProxy(f.options), { code: 'UNSAFE_PATH' });
  await fs.unlink(path.join(f.library, '_meta.json')); await fs.rm(f.library, { recursive: true });
  await fs.symlink(path.dirname(target), f.library);
  await assert.rejects(desktop.installDesktopProxy(f.options), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await jsonRead(target), {});
});

test('managed Desktop or Code proxy policy prevents all configuration writes', async t => {
  for (const managed of [
    { desktop: [{ source: 'HKLM', values: { disableAutoUpdates: 1 } }], code: [] },
    { desktop: [{ source: 'HKCU', values: { egressProxyPacUrl: 'https://secret/pac' } }], code: [] },
    { desktop: [], code: [{ source: 'HKLM', values: { Settings: JSON.stringify({ env: { HTTPS_PROXY: 'http://private:80' } }) } }] }
  ]) {
    const f = await fixture(t, { managed });
    await assert.rejects(desktop.installDesktopProxy(f.options), error => error.code.startsWith('MANAGED_'));
    await absent(f.options.journalDir); await absent(f.library); await absent(f.settings);
  }
});

test('running Desktop refuses installation before any mutation', async t => {
  const f = await fixture(t, { running: true });
  await assert.rejects(desktop.installDesktopProxy(f.options), { code: 'DESKTOP_RUNNING' });
  await absent(f.options.journalDir); await absent(f.library); await absent(f.settings);
});

test('audit never emits credentials or env values', async t => {
  const f = await fixture(t), secret = 'DO_NOT_EMIT_PROXY_CREDENTIALS';
  await jsonWrite(f.settings, { env: { HTTPS_PROXY: `http://user:${secret}@proxy:8080`, NO_PROXY: secret } });
  const result = await desktop.readDesktopAudit({ ...f.options, env: { ...f.options.env, HTTPS_PROXY: secret } });
  assert.ok(result.some(item => item.code === 'USER_PROXY_SETTINGS'));
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('launch arguments and env are isolated, validated and shell-free', () => {
  const descriptor = { path: '/Applications/Claude.app/Contents/MacOS/Claude', version: '2.19675.0', platform: 'darwin' };
  const launch = desktop.buildLaunch({ desktop: descriptor, proxyUrl: PROXY, timezone: 'Europe/London', language: 'en-GB', env: { NO_PROXY: '*', HTTPS_PROXY: 'http://secret:80', Keep: 'yes' } });
  assert.equal(launch.executable, descriptor.path);
  assert.ok(launch.args.includes('--proxy-server=' + PROXY));
  assert.ok(launch.args.includes('--proxy-bypass-list=<-loopback>'));
  assert.equal(launch.env.HTTPS_PROXY, PROXY); assert.equal(launch.env.NO_PROXY, 'localhost,127.0.0.1,::1'); assert.equal(launch.env.Keep, 'yes');
  assert.equal(launch.env.TZ, 'Europe/London');
  const strict = desktop.buildLaunch({ desktop: descriptor, proxyUrl: PROXY, strictMac: true, env: {} });
  assert.equal(strict.executable, '/usr/bin/sandbox-exec');
  assert.ok(strict.args[1].includes('(deny network-outbound)'));
  assert.ok(strict.args[1].includes('localhost:48123'));
  for (const proxyUrl of ['http://127.0.0.1:80;evil', 'http://name:pass@127.0.0.1:80', 'socks5://127.0.0.1:80', 'http://localhost:80', 'https://127.0.0.1:80', 'http://127.0.0.1:80/path']) {
    assert.throws(() => desktop.buildLaunch({ desktop: descriptor, proxyUrl }), { code: 'INVALID_PROXY' });
  }
  assert.throws(() => desktop.buildLaunch({ desktop: descriptor, proxyUrl: PROXY, language: 'en;evil' }), { code: 'INVALID_LANGUAGE' });
  assert.throws(() => desktop.buildLaunch({ desktop: { ...descriptor, version: '1.44121.0' }, proxyUrl: PROXY }), { code: 'DESKTOP_VERSION' });
});

test('Windows app package executable must remain inside package root', async t => {
  const f = await fixture(t);
  const root = path.join(f.base, 'package'), executable = path.join(root, 'app', 'Claude.exe');
  await fs.mkdir(path.dirname(executable), { recursive: true }); await fs.writeFile(executable, 'fixture');
  shellMock(t, { packages: [{ root, executable: '../Claude.exe', version: '9.0.0' }, { root, executable: 'app/Claude.exe', version: '2.19675.0' }] });
  assert.deepEqual(await desktop.discoverDesktop(f.options), { path: executable, platform: 'win32', version: '2.19675.0' });
});

test('launcher refuses an already running Desktop, then spawns direct executable without shell', async t => {
  const f = await fixture(t, { running: true }), executable = path.join(f.base, 'Claude.exe');
  await fs.writeFile(executable, 'fixture');
  const descriptor = { path: executable, platform: 'win32', version: '2.19675.0' };
  const child = new EventEmitter(); child.pid = 1234; child.kill = () => {};
  let calls = 0;
  t.mock.method(childProcess, 'spawn', (file, args, options) => { calls++; assert.equal(file, executable); assert.equal(options.shell, false); assert.equal(options.env.HTTPS_PROXY, PROXY); queueMicrotask(() => child.emit('spawn')); return child; });
  await assert.rejects(desktop.launchDesktop({ ...f.options, desktop: descriptor }), { code: 'DESKTOP_RUNNING' });
  assert.equal(calls, 0);
  shellMock(t, { running: false });
  assert.equal(await desktop.launchDesktop({ ...f.options, desktop: descriptor }), child);
  assert.equal(calls, 1);
  assert.doesNotThrow(() => child.emit('error', new Error('late process error')));
});

test('launcher rejects failed spawn and early nonzero sandbox exit', async t => {
  const f = await fixture(t), executable = path.join(f.base, 'Claude.exe');
  await fs.writeFile(executable, 'fixture');
  const descriptor = { path: executable, platform: 'win32', version: '2.19675.0' };
  let kind = 'error';
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter(); child.kill = () => {};
    queueMicrotask(() => {
      if (kind === 'error') child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      else { child.emit('spawn'); child.emit('exit', 1, null); }
    });
    return child;
  });
  await assert.rejects(desktop.launchDesktop({ ...f.options, desktop: descriptor }), { code: 'DESKTOP_LAUNCH_FAILED' });
  kind = 'invalidSeatbelt';
  await assert.rejects(desktop.launchDesktop({ ...f.options, desktop: descriptor }), { code: 'DESKTOP_EXITED_EARLY' });
});

test('macOS strict sandbox profile parses without launching Claude', { skip: process.platform !== 'darwin' }, async () => {
  const strict = desktop.buildLaunch({ desktop: { path: '/usr/bin/true', version: '2.19675.0', platform: 'darwin' }, proxyUrl: PROXY, strictMac: true, env: process.env });
  await new Promise((resolve, reject) => realExecFile('/usr/bin/sandbox-exec', ['-p', strict.args[1], '/usr/bin/true'], { timeout: 5000 }, error => error ? reject(error) : resolve()));
});

test('macOS strict sandbox permits gate TCP and denies another loopback port', { skip: process.platform !== 'darwin' }, async t => {
  async function listen() {
    const server = net.createServer(socket => socket.destroy());
    t.after(() => new Promise(resolve => server.close(resolve)));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return server.address().port;
  }
  const gatePort = await listen(), otherPort = await listen();
  const strict = desktop.buildLaunch({ desktop: { path: process.execPath, version: '2.19675.0', platform: 'darwin' }, proxyUrl: `http://127.0.0.1:${gatePort}`, strictMac: true, env: process.env });
  const probe = `
    const net = require('node:net');
    function connect(port) {
      return new Promise(resolve => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        function finish(result) { socket.destroy(); resolve(result); }
        socket.setTimeout(1500, () => finish({ ok: false, code: 'TIMEOUT' }));
        socket.once('connect', () => finish({ ok: true }));
        socket.once('error', error => finish({ ok: false, code: error.code }));
      });
    }
    (async () => {
      const allowed = await connect(${gatePort});
      const denied = await connect(${otherPort});
      console.log(JSON.stringify({ allowed, denied }));
    })();
  `;
  const output = await new Promise((resolve, reject) => realExecFile('/usr/bin/sandbox-exec', ['-p', strict.args[1], process.execPath, '-e', probe], { timeout: 5000, env: process.env }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const result = JSON.parse(output);
  assert.equal(result.allowed.ok, true);
  assert.equal(result.denied.ok, false);
  assert.ok(['EPERM', 'EACCES'].includes(result.denied.code), `Expected sandbox denial, received ${result.denied.code}`);
});
