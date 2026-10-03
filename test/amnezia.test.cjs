'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { _createAdapter } = require('../src/amnezia.cjs');

const SELECTED = { name: 'utun4', index: 26, address: '10.8.1.2' };
const READY = { proxyUrl: 'http://127.0.0.1:32123', interface: SELECTED };

function fakeChild(run, { closeOnEof = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.done = false;
  child.finish = (code = 0, signal = null) => {
    if (child.done) return;
    child.done = true;
    child.emit('exit', code, signal);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code, signal);
  };
  child.kill = signal => {
    child.kills.push(signal || 'SIGTERM');
    setImmediate(() => child.finish(null, signal || 'SIGTERM'));
    return true;
  };
  if (closeOnEof) child.stdin.once('finish', () => setImmediate(() => child.finish()));
  setImmediate(() => run(child));
  return child;
}

function adapter(t, run, options = {}) {
  const children = [];
  const calls = [];
  const instance = _createAdapter({ platform: 'darwin', readinessMs: 50, shutdownMs: 5, ...options, spawnHelper: (args, platform) => {
    calls.push({ args, platform });
    const child = fakeChild(run, options);
    children.push(child);
    return child;
  } });
  t.after(() => children.forEach(child => child.finish()));
  return { ...instance, children, calls };
}

test('Amnezia lists validated exact tuples and returns no hidden choice', async t => {
  const api = adapter(t, child => { child.stdout.write(`${JSON.stringify([SELECTED])}\n`); child.finish(); });
  assert.deepEqual(await api.listInterfaces(), [SELECTED]);
  assert.deepEqual(api.calls, [{ args: ['--list'], platform: 'darwin' }]);
  const empty = adapter(t, child => { child.stdout.write('[]\n'); child.finish(); });
  assert.deepEqual(await empty.listInterfaces(), []);
});

test('Amnezia rejects invalid interface tuples before spawning helper', async t => {
  const api = adapter(t, () => {});
  for (const value of [undefined, {}, { ...SELECTED, name: 'en0' }, { ...SELECTED, name: 'utun4\n' }, { ...SELECTED, index: 0 }, { ...SELECTED, index: 0x1000000 }, { ...SELECTED, address: '127.0.0.1' }, { ...SELECTED, address: '169.254.1.1' }, { ...SELECTED, address: '224.0.0.1' }, { ...SELECTED, address: '::1' }, { ...SELECTED, address: '010.8.1.2' }]) {
    await assert.rejects(api.openAmnezia(value));
  }
  assert.equal(api.calls.length, 0);
});

test('Amnezia ready output must match selected tuple and loopback ephemeral proxy', async t => {
  for (const message of [{ ...READY, interface: { ...SELECTED, index: 27 } }, { ...READY, interface: { ...SELECTED, address: '10.8.1.3' } }, { ...READY, proxyUrl: 'http://8.8.8.8:32123' }, { ...READY, proxyUrl: 'http://127.0.0.1:0' }, { ...READY, proxyUrl: 'http://127.0.0.1:32123/path' }, { ...READY, proxyUrl: 'https://127.0.0.1:32123' }, { ...READY, proxyUrl: 'http://[::1]:32123' }]) {
    const api = adapter(t, child => child.stdout.write(`${JSON.stringify(message)}\n`));
    await assert.rejects(api.openAmnezia(SELECTED));
    assert.equal(api.children[0].done, true, 'invalid readiness left orphan helper');
  }
});

test('Amnezia session close owns stdin and has idempotent bounded cleanup', async t => {
  const api = adapter(t, child => child.stdout.write(`${JSON.stringify(READY)}\n`), { closeOnEof: true });
  const session = await api.openAmnezia(SELECTED);
  assert.equal(session.proxyUrl, READY.proxyUrl);
  assert.equal(session.alive, true);
  assert.deepEqual(api.calls[0].args, ['--interface', 'utun4', '--index', '26', '--address', '10.8.1.2']);
  const closing = session.close();
  assert.equal(session.alive, false);
  assert.equal(session.close(), closing);
  await closing;
  assert.equal(api.children[0].stdin.writableEnded, true);
  assert.deepEqual(api.children[0].kills, []);
});

test('Amnezia unexpected exit flips alive before notifying listeners', async t => {
  const api = adapter(t, child => child.stdout.write(`${JSON.stringify(READY)}\n`));
  const session = await api.openAmnezia(SELECTED);
  const exited = once(session, 'exit');
  session.once('exit', () => assert.equal(session.alive, false));
  api.children[0].finish(1);
  assert.deepEqual(await exited, [1, null]);
  await session.close();
});

test('Amnezia immediate exit after readiness is observable without race', async t => {
  const api = adapter(t, child => { child.stdout.write(`${JSON.stringify(READY)}\n`); child.finish(1); });
  const session = await api.openAmnezia(SELECTED);
  assert.equal(session.alive, false);
  await session.close();
});

test('Amnezia readiness timeout and process errors clean up child', async t => {
  const hanging = adapter(t, () => {}, { readinessMs: 10 });
  await assert.rejects(hanging.openAmnezia(SELECTED), /timed out/);
  assert.equal(hanging.children[0].done, true);
  assert.equal(hanging.children[0].kills.length, 1);
  const failed = adapter(t, child => child.emit('error', new Error('fixture spawn failure')));
  await assert.rejects(failed.openAmnezia(SELECTED), /fixture spawn failure/);
  assert.equal(failed.children[0].done, true);
});

test('Amnezia discovery rejects duplicates, malformed JSON, huge output and nonzero exit', async t => {
  for (const output of ['not JSON', '{}', JSON.stringify([SELECTED, SELECTED]), JSON.stringify([{ ...SELECTED, name: 'en0' }]), 'x'.repeat(65537)]) {
    const api = adapter(t, child => { child.stdout.write(output); child.finish(); });
    await assert.rejects(api.listInterfaces());
  }
  const failed = adapter(t, child => child.finish(1));
  await assert.rejects(failed.listInterfaces(), /enumerate/);
  const timed = adapter(t, () => {}, { readinessMs: 10 });
  await assert.rejects(timed.listInterfaces(), /timed out/);
});

test('Amnezia Windows adapter accepts only Amnezia-named IPv4 interfaces', async t => {
  const windows = { name: 'AmneziaVPN', index: 7, address: '10.8.1.2' };
  const api = adapter(t, child => { child.stdout.write(JSON.stringify([windows])); child.finish(); }, { platform: 'win32' });
  assert.deepEqual(await api.listInterfaces(), [windows]);
  await assert.rejects(api.openAmnezia({ ...windows, name: 'Ethernet' }));
});

test('Amnezia unsupported platforms never start any helper', async t => {
  const api = adapter(t, () => {}, { platform: 'linux' });
  await assert.rejects(api.listInterfaces(), /macOS and Windows/);
  await assert.rejects(api.openAmnezia(SELECTED), /macOS and Windows/);
  assert.equal(api.calls.length, 0);
});

test('Amnezia rejects extra readiness lines and oversized/error output', async t => {
  const duplicate = adapter(t, child => child.stdout.write(`${JSON.stringify(READY)}\nextra\n`));
  await assert.rejects(duplicate.openAmnezia(SELECTED), /Unexpected/);
  const huge = adapter(t, child => child.stdout.write('x'.repeat(16385)));
  await assert.rejects(huge.openAmnezia(SELECTED), /exceeds limit/);
  const errorOutput = adapter(t, child => child.stderr.write('x'.repeat(65537)));
  await assert.rejects(errorOutput.openAmnezia(SELECTED), /exceeds limit/);
});
