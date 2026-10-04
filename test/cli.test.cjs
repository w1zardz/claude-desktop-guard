'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { validateProfile, routingIdentity } = require('../src/profile.cjs');
const { _createAdapter } = require('../src/amnezia.cjs');
const { parseCliArgs, buildCliLaunch, runGuardedCli, writeHandshake, createCliStdin, ownedGroupAlive, FAILURE_CODE, FAILURE_MARKER } = require('../src/cli.cjs');

const SELECTED = { name: 'utun4', index: 26, address: '10.8.1.2' };
function profile(overrides = {}) {
  const value = validateProfile({ mode: 'proxy', proxyUrl: 'http://127.0.0.1:7890', expectedIp: '8.8.8.8', expectedCountry: 'FI',
    clientMask: { enabled: true, timezone: 'Europe/Helsinki', language: 'en-US', region: 'FI' }, ...overrides });
  value.pinIdentity = routingIdentity(value);
  return value;
}
const sample = overrides => ({ ip: '8.8.8.8', country: 'FI', timezone: 'Europe/Helsinki', ...overrides });
const args = extra => ['--guard-cli', '--claude-executable', process.execPath, '--', ...(extra || ['-p', 'fixture only'])];
function setup(options = {}) {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(), signals = new EventEmitter();
  let output = '', diagnostics = '';
  stdout.on('data', chunk => { output += chunk; }); stderr.on('data', chunk => { diagnostics += chunk; });
  const children = [];
  const dependencies = { argv: args(), dataDir: process.cwd(), stdin, stdout, stderr, signals, env: {},
    loadProfile: async () => profile(), auditPolicy: async () => [], binding: async () => ({ enabled: false }), probe: async () => sample(), killDelayMs: 10,
    spawnChild: (...input) => { const child = fakeChild(); children.push({ child, input }); return child; }, ...options };
  return { stdin, stdout, stderr, signals, children, dependencies, output: () => output, diagnostics: () => diagnostics, run: () => runGuardedCli(dependencies) };
}
function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = []; child.done = false;
  child.finish = (code = 0, signal = null) => {
    if (child.done) return;
    child.done = true; child.emit('exit', code, signal);
    child.stdout.end(); child.stderr.end(); child.emit('close', code, signal);
  };
  child.kill = (signal = 'SIGTERM') => { child.kills.push(signal); setImmediate(() => child.finish(null, signal)); return true; };
  return child;
}
async function started(fixture) {
  for (let tries = 0; tries < 100 && !fixture.children.length; tries++) await nextTurn();
  assert.equal(fixture.children.length, 1, fixture.diagnostics());
  return fixture.children[0].child;
}
function helperFixture() {
  const helper = new EventEmitter(); helper.alive = true; helper.proxyUrl = 'http://127.0.0.1:7890'; helper.closes = 0;
  helper.close = async () => { helper.closes++; helper.alive = false; };
  return helper;
}

test('CLI requires explicit absolute executable and rejects competing settings flags', () => {
  assert.deepEqual(parseCliArgs(args(['-p', 'quoted $() ` ; prompt'])), { executable: process.execPath, args: ['-p', 'quoted $() ` ; prompt'] });
  for (const argv of [[], ['--guard-cli'], ['--guard-cli', '--claude-executable', 'claude', '--'], args(['--settings', '{}']), args(['--settings={"env":{}}']), args(['--setting-sources', 'user'])]) assert.throws(() => parseCliArgs(argv));
});

test('owned inline settings and environment replace stale proxies without global locale changes', () => {
  const launch = buildCliLaunch({ executable: process.execPath, args: ['-p', 'fixture'], proxyUrl: 'http://127.0.0.1:54321', profile: profile(),
    env: { TZ: 'Europe/Moscow', LANG: 'ru_RU.UTF-8', LC_ALL: 'ru_RU.UTF-8', HtTp_PrOxY: 'http://invalid:1', no_proxy: '*', KEEP: 'yes' } });
  assert.equal(launch.env.TZ, 'Europe/Helsinki'); assert.equal(launch.env.LANG, 'en_US.UTF-8'); assert.equal(launch.env.LC_ALL, 'en_US.UTF-8');
  assert.equal(launch.env.HTTP_PROXY, 'http://127.0.0.1:54321'); assert.equal(launch.env.NO_PROXY, 'localhost,127.0.0.1,::1');
  assert.equal(launch.env.HtTp_PrOxY, undefined); assert.equal(launch.env.KEEP, 'yes');
  assert.deepEqual(launch.args.slice(2), ['-p', 'fixture']);
  assert.equal(launch.args[0], '--settings'); assert.equal(JSON.parse(launch.args[1]).env.TZ, launch.env.TZ);
  assert.equal(JSON.parse(launch.args[1]).env.HTTPS_PROXY, launch.env.HTTPS_PROXY);
  assert.equal(launch.env.DISABLE_ERROR_REPORTING, '1'); assert.equal(JSON.parse(launch.args[1]).env.DISABLE_ERROR_REPORTING, '1');
  assert.equal(launch.env.CLAUDE_CODE_PROXY_RESOLVES_HOSTS, '1'); assert.equal(JSON.parse(launch.args[1]).env.CLAUDE_CODE_PROXY_RESOLVES_HOSTS, '1');
  for (const [key, value] of Object.entries({ NODE_TLS_REJECT_UNAUTHORIZED: '1', NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '' })) {
    assert.equal(launch.env[key], value); assert.equal(JSON.parse(launch.args[1]).env[key], value);
  }
  const other = buildCliLaunch({ executable: process.execPath, args: [], proxyUrl: 'http://127.0.0.1:54321', profile: profile({ expectedCountry: 'JP', clientMask: { enabled: true, timezone: 'Asia/Tokyo', language: 'ja-JP', region: 'JP' } }) });
  assert.equal(other.env.TZ, 'Asia/Tokyo'); assert.equal(other.env.LANG, 'ja_JP.UTF-8');
});

test('strict Mac profile confines CLI executable to numeric local gate; unsupported platform rejects', () => {
  const launch = buildCliLaunch({ executable: process.execPath, args: ['-p', 'literal'], proxyUrl: 'http://127.0.0.1:54321', profile: profile({ strictMac: true }), platform: 'darwin', env: {} });
  assert.equal(launch.executable, '/usr/bin/sandbox-exec'); assert.match(launch.args[1], /localhost:54321/);
  assert.equal(launch.args[2], process.execPath); assert.equal(launch.args[3], '--settings');
  assert.throws(() => buildCliLaunch({ executable: process.execPath, args: [], proxyUrl: 'http://127.0.0.1:1', profile: profile({ strictMac: true }), platform: 'win32' }));
});

test('missing/unpinned profile, disabled mask and managed/runtime overrides never spawn child', async () => {
  for (const options of [
    { loadProfile: async () => null },
    { loadProfile: async () => ({ ...profile(), pinIdentity: undefined }) },
    { loadProfile: async () => profile({ clientMask: { enabled: false } }) },
    { auditPolicy: async () => [{ code: 'MANAGED_PROXY' }] },
    { env: { NODE_OPTIONS: '--require /tmp/inject.js' } },
    { env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } },
    { env: { ELECTRON_RUN_AS_NODE: '1' } },
  ]) {
    let probes = 0;
    const fixture = setup({ probe: async () => { probes++; return sample(); }, ...options });
    assert.equal(await fixture.run(), FAILURE_CODE); assert.equal(probes, 0); assert.equal(fixture.children.length, 0);
    assert.match(fixture.diagnostics(), /^\[Claude Desktop Guard\]/m);
  }
});

test('real GuardGate rejects changed IP/country/timezone or missing timezone before child start', async () => {
  for (const changed of [{ ip: '1.1.1.1' }, { country: 'RU' }, { timezone: 'Europe/Moscow' }, { timezone: null }]) {
    const fixture = setup({ probe: async () => sample(changed) });
    assert.equal(await fixture.run(), FAILURE_CODE); assert.equal(fixture.children.length, 0);
    assert.match(fixture.diagnostics(), /^\[Claude Desktop Guard\]/m);
  }
});

test('missing selected interface and helper already dead at readiness fail closed', async () => {
  let opened = 0;
  const gone = setup({ loadProfile: async () => profile({ mode: 'amnezia', vpnInterface: SELECTED }), amnezia: {
    listInterfaces: async () => [{ ...SELECTED, index: SELECTED.index + 1 }], openAmnezia: async () => { opened++; },
  } });
  assert.equal(await gone.run(), FAILURE_CODE); assert.equal(opened, 0); assert.equal(gone.children.length, 0);
  const helper = helperFixture(); helper.alive = false;
  const dead = setup({ loadProfile: async () => profile({ mode: 'amnezia', vpnInterface: SELECTED }), amnezia: {
    listInterfaces: async () => [SELECTED], openAmnezia: async () => helper,
  } });
  assert.equal(await dead.run(), FAILURE_CODE); assert.equal(dead.children.length, 0); assert.equal(helper.closes, 1);
});

test('signal aborts pending exit verification and cannot produce a late child launch', async () => {
  let release, checking;
  const entered = new Promise(resolve => { checking = resolve; });
  const fixture = setup({ probe: async () => { checking(); return new Promise(resolve => { release = resolve; }); } });
  const result = fixture.run(); await entered;
  fixture.signals.emit('SIGTERM'); assert.equal(await result, 143); assert.equal(fixture.children.length, 0);
  release(sample()); await nextTurn(); assert.equal(fixture.children.length, 0);
});

test('running gate lock kills owned CLI and restores no Desktop settings', async () => {
  let gate;
  const { GuardGate } = require('../src/network.cjs');
  class CaptureGate extends GuardGate { constructor(options) { super(options); gate = this; } }
  const fixture = setup({ Gate: CaptureGate }); const result = fixture.run(); const child = await started(fixture);
  gate.lock('fixture lost route');
  assert.equal(await result, FAILURE_CODE); assert.ok(child.kills.includes('SIGTERM'));
  assert.equal(gate.status().running, false); assert.equal(fixture.output(), ''); assert.match(fixture.diagnostics(), /fixture lost route/);
});

test('Guard failure marker starts its own line after child stderr without final newline', async () => {
  let gate;
  const { GuardGate } = require('../src/network.cjs');
  class CaptureGate extends GuardGate { constructor(options) { super(options); gate = this; } }
  const fixture = setup({ Gate: CaptureGate }); const result = fixture.run(); const child = await started(fixture);
  child.stderr.write('native diagnostic without newline'); gate.lock('fixture refusal');
  assert.equal(await result, FAILURE_CODE);
  assert.match(fixture.diagnostics(), /^native diagnostic without newline\n\[Claude Desktop Guard\] /);
});

test('real owned CLI tree includes grandchild; gate lock terminates both', async t => {
  let gate, realChild, grandchild;
  const { GuardGate } = require('../src/network.cjs');
  class CaptureGate extends GuardGate { constructor(options) { super(options); gate = this; } }
  const code = `const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore'});process.stdout.write(String(c.pid));setInterval(()=>{},10000);`;
  const fixture = setup({ Gate: CaptureGate, killDelayMs: 100, spawnChild: (_executable, childArgs, options) => {
    assert.equal(options.detached, process.platform !== 'win32'); realChild = spawn(process.execPath, ['-e', code, '--', ...childArgs], options); return realChild;
  } });
  t.after(() => {
    if (realChild?.pid) { try { process.kill(process.platform === 'win32' ? realChild.pid : -realChild.pid, 'SIGKILL'); } catch {} }
    if (grandchild) { try { process.kill(grandchild, 'SIGKILL'); } catch {} }
  });
  const result = fixture.run();
  const deadline = Date.now() + 3000;
  while (!fixture.output() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  grandchild = Number(fixture.output()); assert.ok(Number.isSafeInteger(grandchild) && grandchild > 1);
  process.kill(grandchild, 0); gate.lock('descendant fixture refusal');
  assert.equal(await result, FAILURE_CODE);
  let gone = false;
  for (let attempt = 0; attempt < 100 && !gone; attempt++) {
    try { process.kill(grandchild, 0); } catch (error) { if (error.code === 'ESRCH') gone = true; else throw error; }
    if (!gone) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(gone, true, 'owned grandchild survived group cleanup');
  assert.equal(gate.status().running, false);
});

test('normal POSIX CLI leader exit still terminates surviving owned grandchild', { skip: process.platform === 'win32' }, async t => {
  let realChild, grandchild;
  const code = `const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore'});process.stdout.write(String(c.pid));process.exit(7);`;
  const fixture = setup({ killDelayMs: 100, spawnChild: (_executable, childArgs, options) => {
    realChild = spawn(process.execPath, ['-e', code, '--', ...childArgs], options); return realChild;
  } });
  t.after(() => { if (realChild?.pid) { try { process.kill(-realChild.pid, 'SIGKILL'); } catch {} } });
  assert.equal(await fixture.run(), 7, fixture.diagnostics());
  grandchild = Number(fixture.output()); assert.ok(Number.isSafeInteger(grandchild) && grandchild > 1);
  let gone = false;
  for (let attempt = 0; attempt < 100 && !gone; attempt++) {
    try { process.kill(grandchild, 0); } catch (error) { if (error.code === 'ESRCH') gone = true; else throw error; }
    if (!gone) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(gone, true, 'owned grandchild survived normal leader exit');
});

test('a lock immediately after gate start prevents child launch', async () => {
  const { GuardGate } = require('../src/network.cjs');
  class LockOnReady extends GuardGate {
    async start() { const proxy = await super.start(); this.lock('fixture readiness race'); return proxy; }
  }
  const fixture = setup({ Gate: LockOnReady });
  assert.equal(await fixture.run(), FAILURE_CODE); assert.equal(fixture.children.length, 0);
});

test('changed managed policy on repeated verification closes gate and owned child', async () => {
  let gate, policyChecks = 0;
  const { GuardGate } = require('../src/network.cjs');
  class CaptureGate extends GuardGate { constructor(options) { super(options); gate = this; } }
  const fixture = setup({ Gate: CaptureGate, auditPolicy: async () => { if (++policyChecks > 2) throw new Error('managed policy changed'); return []; } });
  const result = fixture.run(); const child = await started(fixture);
  await assert.rejects(gate.verify(), /managed policy changed/);
  assert.equal(await result, FAILURE_CODE); assert.ok(child.kills.includes('SIGTERM')); assert.equal(gate.status().running, false);
});

test('helper death while running kills owned CLI and closes helper exactly once', async () => {
  const helper = helperFixture();
  const fixture = setup({ loadProfile: async () => profile({ mode: 'amnezia', vpnInterface: SELECTED }), amnezia: {
    listInterfaces: async () => [SELECTED], openAmnezia: async () => helper,
  } });
  const result = fixture.run(); const child = await started(fixture);
  helper.alive = false; helper.emit('exit', 1);
  assert.equal(await result, FAILURE_CODE); assert.ok(child.kills.includes('SIGTERM')); assert.equal(helper.closes, 1);
});

test('synchronous helper death inside spawn never returns a surviving unguarded child', async () => {
  const helper = helperFixture(); const child = fakeChild();
  const fixture = setup({ loadProfile: async () => profile({ mode: 'amnezia', vpnInterface: SELECTED }), amnezia: {
    listInterfaces: async () => [SELECTED], openAmnezia: async () => helper,
  }, spawnChild: () => { helper.alive = false; helper.emit('exit', 1); return child; } });
  assert.equal(await fixture.run(), FAILURE_CODE); assert.ok(child.kills.includes('SIGTERM')); assert.equal(helper.closes, 1);
});

test('stdio EPIPE triggers owned child cleanup without uncaught stream errors', async () => {
  for (const select of [fixture => fixture.stdout, fixture => fixture.stdin]) {
    const fixture = setup(); const result = fixture.run(); const child = await started(fixture);
    select(fixture).emit('error', Object.assign(new Error('closed pipe'), { code: 'EPIPE' }));
    assert.equal(await result, FAILURE_CODE); assert.ok(child.kills.includes('SIGTERM')); assert.match(fixture.diagnostics(), /EPIPE/);
  }
});

test('child deliberate stdin close preserves its exit status; parent error handling stays separate', async () => {
  for (const code of ['EPIPE', 'ECONNRESET']) {
    const fixture = setup(); const result = fixture.run(); const child = await started(fixture);
    child.stdin.emit('error', Object.assign(new Error('child stopped reading'), { code }));
    child.finish(7);
    assert.equal(await result, 7); assert.equal(fixture.diagnostics(), '');
  }
});

test('macOS EPERM inspection accepts only terminal/empty owned groups, never denied live groups', async () => {
  const denied = () => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); };
  const child = { pid: 45678 };
  for (const states of [[], ['Z'], ['Zs', 'X']]) assert.equal(await ownedGroupAlive(child, true, 'darwin', { killProcess: denied, inspectGroup: async () => states }), false);
  await assert.rejects(ownedGroupAlive(child, true, 'darwin', { killProcess: denied, inspectGroup: async () => ['S'] }), /EPERM/);
  await assert.rejects(ownedGroupAlive(child, true, 'darwin', { killProcess: denied, inspectGroup: async () => { throw new Error('inspection failed'); } }), /inspection failed/);
  await assert.rejects(ownedGroupAlive(child, false, 'darwin', { killProcess: denied, inspectGroup: async () => [] }), /EPERM/);
});

test('Windows headless stdin uses inherited fd0 despite Electron EOF-only process.stdin', async () => {
  const inherited = new PassThrough(); let captured;
  const fixture = createCliStdin({ platform: 'win32', inherited, createReadStream: (file, options) => { captured = { file, options }; return new PassThrough(); } });
  assert.notEqual(fixture, inherited); assert.deepEqual(captured, { file: null, options: { fd: 0, autoClose: false } });
  assert.equal(createCliStdin({ platform: 'darwin', inherited }), inherited);
  const moduleFile = require.resolve('../src/cli.cjs');
  const code = `const {Readable}=require('node:stream');Object.defineProperty(process,'stdin',{get:()=>Readable.from([])});const input=require(process.argv[1]).createCliStdin({platform:'win32'});let data='';input.setEncoding('utf8');input.on('data',chunk=>data+=chunk);input.on('end',()=>process.stdout.write(JSON.stringify(data)));input.on('error',error=>{process.stderr.write(error.message);process.exitCode=1;});`;
  const child = spawn(process.execPath, ['-e', code, moduleFile], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', diagnostics = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { diagnostics += bytes; });
  const expected = 'Юникод\n' + 'input '.repeat(20000);
  child.stdin.end(expected);
  const exit = await new Promise(resolve => child.once('close', resolve));
  assert.equal(exit, 0, diagnostics); assert.equal(JSON.parse(output), expected);
});

test('owned child ignoring SIGTERM is killed within bounded cleanup', async () => {
  const fixture = setup(); const result = fixture.run(); const child = await started(fixture);
  child.kill = signal => { child.kills.push(signal); if (signal === 'SIGKILL') setImmediate(() => child.finish(null, signal)); return true; };
  fixture.signals.emit('SIGINT');
  assert.equal(await result, 130); assert.ok(child.kills.includes('SIGKILL')); assert.equal(child.done, true);
});

test('real inert child receives owned env/settings, original args and stdin; stdout/code unchanged', async () => {
  const code = `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>input+=v);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({input,args:process.argv.slice(1),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,env:{TZ:process.env.TZ,LANG:process.env.LANG,LC_ALL:process.env.LC_ALL,HTTPS_PROXY:process.env.HTTPS_PROXY,NO_PROXY:process.env.NO_PROXY}}));process.stderr.write('fixture stderr');process.exitCode=7;});`;
  let original;
  const fixture = setup({ argv: args(['-p', 'literal prompt $()']), spawnChild: (executable, childArgs, options) => {
    original = { executable, childArgs, options }; return spawn(process.execPath, ['-e', code, '--', ...childArgs], options);
  } });
  fixture.stdin.end('exact stdin\n');
  assert.equal(await fixture.run(), 7); assert.equal(original.executable, process.execPath); assert.equal(original.options.shell, false);
  const result = JSON.parse(fixture.output()); assert.equal(result.input, 'exact stdin\n');
  assert.equal(result.timezone, 'Europe/Helsinki'); assert.equal(result.env.TZ, 'Europe/Helsinki'); assert.equal(result.env.LANG, 'en_US.UTF-8');
  assert.match(result.env.HTTPS_PROXY, /^http:\/\/127\.0\.0\.1:[0-9]+$/); assert.equal(result.env.NO_PROXY, 'localhost,127.0.0.1,::1');
  assert.deepEqual(result.args.slice(2), ['-p', 'literal prompt $()']); assert.equal(JSON.parse(result.args[1]).env.TZ, result.env.TZ);
  assert.equal(fixture.diagnostics(), 'fixture stderr'); assert.equal(fixture.signals.listenerCount('SIGTERM'), 0);
});

test('native helper opening observes cancellation before readiness and destroys owned process', async () => {
  const child = fakeChild(); const controller = new AbortController();
  const api = _createAdapter({ platform: 'darwin', spawnHelper: async () => child, readinessMs: 1000, shutdownMs: 5 });
  const opening = api.openAmnezia(SELECTED, { signal: controller.signal });
  controller.abort();
  await assert.rejects(opening, /cancelled/); assert.ok(child.kills.includes('SIGTERM')); assert.equal(child.done, true);
});

test('native interface discovery observes cancellation and never returns a late tuple', async () => {
  const child = fakeChild(); const controller = new AbortController();
  const api = _createAdapter({ platform: 'darwin', spawnHelper: async () => child, readinessMs: 1000 });
  const listing = api.listInterfaces({ signal: controller.signal });
  controller.abort(); await assert.rejects(listing, /cancelled/);
  assert.ok(child.kills.includes('SIGTERM')); await nextTurn(); assert.equal(child.done, true);
});

test('headless version handshake is isolated JSON; closed stdout returns failure', async () => {
  const output = new PassThrough(); let text = ''; output.on('data', data => { text += data; });
  assert.equal(await writeHandshake(output, '0.4.0'), 0); assert.deepEqual(JSON.parse(text), { version: '0.4.0', headlessCli: true });
  const closed = new PassThrough(); closed.destroy(); assert.equal(await writeHandshake(closed, '0.4.0'), FAILURE_CODE);
});
