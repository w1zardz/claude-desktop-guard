'use strict';

const { spawn } = require('node:child_process');
const { access, constants } = require('node:fs/promises');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const path = require('node:path');
const { validateProxyUrl } = require('./network.cjs');

const OUTPUT_LIMIT = 64 * 1024;
const READY_LIMIT = 16 * 1024;

function validateInterface(value, platform) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.name !== 'string' || value.name.length > 128 || /[\x00-\x1f\x7f]/.test(value.name) || !Number.isSafeInteger(value.index) || value.index < 1 || value.index > 0xffffff || typeof value.address !== 'string' || net.isIP(value.address) !== 4) throw new Error('Invalid VPN interface tuple');
  if ((platform === 'darwin' && !/^utun[0-9]+$/.test(value.name)) || (platform === 'win32' && !/^amnezia/i.test(value.name))) throw new Error('Selected interface is not an eligible VPN tunnel');
  const [a, b] = value.address.split('.').map(Number);
  if (a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254)) throw new Error('VPN interface requires a usable IPv4 source address');
  return { name: value.name, index: value.index, address: value.address };
}

function helperPath(platform) {
  const name = `vpn-helper${platform === 'win32' ? '.exe' : ''}`;
  if (process.resourcesPath && !process.defaultApp) return path.join(process.resourcesPath, name);
  return path.resolve(__dirname, '..', 'native', 'bin', name);
}

async function spawnNative(args, platform) {
  const binary = helperPath(platform);
  try { await access(binary, platform === 'win32' ? constants.F_OK : constants.X_OK); }
  catch { throw new Error('VPN helper is missing. Reinstall the packaged app or run npm run helper:build.'); }
  return spawn(binary, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

function createAdapter({ platform = process.platform, spawnHelper = spawnNative, readinessMs = 8000, shutdownMs = 1500 } = {}) {
  function supported() {
    if (platform !== 'darwin' && platform !== 'win32') throw new Error('Amnezia native mode supports macOS and Windows only');
  }

  async function listInterfaces() {
    supported();
    const child = await spawnHelper(['--list'], platform);
    return new Promise((resolve, reject) => {
      let done = false;
      let output = '';
      let bytes = 0;
      let stderrBytes = 0;
      const timer = setTimeout(() => finish(new Error('VPN interface discovery timed out')), readinessMs);
      const finish = (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.stdin.destroy();
        if (error) child.kill();
        if (error) reject(error); else resolve(result);
      };
      child.stdin.on('error', () => {});
      child.stdout.on('error', error => finish(error));
      child.stderr.on('error', error => finish(error));
      child.on('error', error => finish(error));
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > OUTPUT_LIMIT) return finish(new Error('VPN interface discovery output exceeds limit'));
        output += chunk.toString('utf8');
      });
      child.stderr.on('data', chunk => {
        stderrBytes += chunk.length;
        if (stderrBytes > OUTPUT_LIMIT) finish(new Error('VPN helper error output exceeds limit'));
      });
      child.once('close', code => {
        if (done) return;
        if (code !== 0) return finish(new Error('Unable to enumerate VPN interfaces'));
        try {
          const decoded = JSON.parse(output);
          if (!Array.isArray(decoded) || decoded.length > 128) throw new Error('Invalid VPN interface list');
          const values = decoded.map(item => validateInterface(item, platform));
          const keys = values.map(item => JSON.stringify(item));
          if (new Set(keys).size !== keys.length) throw new Error('Duplicate VPN interface tuple');
          finish(null, values);
        } catch (error) { finish(error); }
      });
      child.stdin.end();
    });
  }

  async function openAmnezia(value) {
    supported();
    const selected = validateInterface(value, platform);
    const child = await spawnHelper(['--interface', selected.name, '--index', String(selected.index), '--address', selected.address], platform);
    const session = new EventEmitter();
    // An exit can arrive before caller installs listeners; errors must never crash the app.
    session.on('error', () => {});
    let alive = false;
    let exited = false;
    let closed = false;
    let closing = false;
    let ready = false;
    let proxyUrl = null;
    let closePromise;
    let notifyClosed;
    const childClosed = new Promise(resolve => { notifyClosed = resolve; });
    Object.defineProperties(session, { alive: { get: () => alive }, proxyUrl: { get: () => proxyUrl } });
    session.close = () => {
      alive = false;
      closing = true;
      if (closePromise) return closePromise;
      closePromise = (async () => {
        if (closed) return;
        child.stdin.end();
        let timer;
        await Promise.race([childClosed, new Promise(resolve => { timer = setTimeout(resolve, shutdownMs); })]);
        clearTimeout(timer);
        if (!closed) {
          child.kill();
          await Promise.race([childClosed, new Promise(resolve => { timer = setTimeout(resolve, 500); })]);
          clearTimeout(timer);
        }
        if (!closed) {
          child.kill('SIGKILL');
          await Promise.race([childClosed, new Promise(resolve => { timer = setTimeout(resolve, 500); })]);
          clearTimeout(timer);
        }
      })();
      return closePromise;
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      let output = '';
      let outputBytes = 0;
      let stderrBytes = 0;
      const timer = setTimeout(() => fail(new Error('VPN helper readiness timed out')), readinessMs);
      const fail = error => {
        alive = false;
        clearTimeout(timer);
        const cleanup = session.close();
        if (!settled) { settled = true; cleanup.then(() => reject(error), () => reject(error)); }
        else session.emit('error', error);
      };
      child.stdin.on('error', () => {});
      child.stdout.on('error', fail);
      child.stderr.on('error', fail);
      child.on('error', fail);
      child.once('exit', (code, signal) => {
        exited = true;
        alive = false;
        clearTimeout(timer);
        if (!settled) { settled = true; reject(new Error('VPN helper exited before readiness')); }
        session.emit('exit', code, signal);
      });
      child.once('close', () => { closed = true; alive = false; notifyClosed(); });
      child.stderr.on('data', chunk => {
        stderrBytes += chunk.length;
        if (stderrBytes > OUTPUT_LIMIT) fail(new Error('VPN helper error output exceeds limit'));
      });
      child.stdout.on('data', chunk => {
        outputBytes += chunk.length;
        if (outputBytes > READY_LIMIT) return fail(new Error('VPN helper readiness output exceeds limit'));
        output += chunk.toString('utf8');
        const newline = output.indexOf('\n');
        if (newline < 0) return;
        if (ready) return fail(new Error('Unexpected VPN helper output after readiness'));
        try {
          const message = JSON.parse(output.slice(0, newline));
          const actual = validateInterface(message?.interface, platform);
          if (JSON.stringify(actual) !== JSON.stringify(selected)) throw new Error('VPN helper selected a different interface');
          const origin = validateProxyUrl(message?.proxyUrl);
          if (!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(origin)) throw new Error('VPN helper must listen on an ephemeral IPv4 loopback HTTP port');
          if (exited || closed || closing) throw new Error('VPN helper exited before readiness');
          if (output.slice(newline + 1).trim()) throw new Error('Unexpected VPN helper output after readiness');
          output = '';
          ready = true;
          proxyUrl = origin;
          alive = true;
          clearTimeout(timer);
          settled = true;
          resolve(session);
        } catch (error) { fail(error); }
      });
    });
  }

  return { listInterfaces, openAmnezia };
}

module.exports = { ...createAdapter(), _createAdapter: createAdapter };
