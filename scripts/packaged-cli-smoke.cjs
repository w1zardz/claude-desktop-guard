'use strict';

// Offline packaged executable test. Refuse existing profiles; never use a real
// Claude executable, API key, account, authentication flow, or external socket.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { validateProfile, routingIdentity } = require('../src/profile.cjs');
const packageInfo = require('../package.json');

const root = path.resolve(__dirname, '..');
const fixtureRoot = path.join(root, 'test', 'fixtures');
const SYNTHETIC_IP = '8.8.8.8'; // A public-shaped response value only; never dialed.
const connections = new Set();
let temporary, profileFile, ownedProfile, profileDirCreated = false;
const servers = [];

async function existing(file) {
  try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function defaultDataDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', packageInfo.name);
  if (process.platform === 'win32' && path.isAbsolute(process.env.APPDATA || '')) return path.join(process.env.APPDATA, packageInfo.name);
  throw new Error('Packaged CLI smoke supports macOS/Windows with a valid default userData path.');
}

async function packagedExecutable() {
  if (process.env.CDG_PACKAGED_EXECUTABLE) {
    if (!path.isAbsolute(process.env.CDG_PACKAGED_EXECUTABLE)) throw new Error('CDG_PACKAGED_EXECUTABLE must be absolute.');
    return process.env.CDG_PACKAGED_EXECUTABLE;
  }
  const arch = process.env.CDG_PACKAGED_ARCH || process.arch;
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Unsupported packaged smoke architecture.');
  const folder = process.platform === 'darwin' ? (arch === 'arm64' ? 'mac-arm64' : 'mac') : (arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked');
  const file = process.platform === 'darwin'
    ? path.join(root, 'dist', folder, `${packageInfo.build.productName}.app`, 'Contents', 'MacOS', packageInfo.build.productName)
    : path.join(root, 'dist', folder, `${packageInfo.build.productName}.exe`);
  if (!(await existing(file))?.isFile()) throw new Error(`Packaged executable missing: ${file}`);
  return file;
}

function execute(file, args, { env = process.env, input = '', timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', diagnostics = '', bytes = 0, settled = false, timeout;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      if (error) reject(error); else resolve(result);
    };
    timeout = setTimeout(() => {
      child.kill('SIGTERM');
      timeout = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Packaged CLI smoke timed out.')); }, 5000);
    }, timeoutMs);
    const read = kind => chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { child.kill('SIGTERM'); finish(new Error('Packaged fixture output exceeds limit.')); return; }
      if (kind === 'stdout') output += chunk.toString('utf8'); else diagnostics += chunk.toString('utf8');
    };
    child.stdout.on('data', read('stdout')); child.stderr.on('data', read('stderr'));
    child.stdin.on('error', error => { if (!['EPIPE', 'ECONNRESET'].includes(error.code)) finish(error); });
    child.stdout.on('error', error => finish(error)); child.stderr.on('error', error => finish(error));
    child.once('error', error => finish(error));
    child.once('close', (code, signal) => finish(null, { code, signal, output, diagnostics }));
    child.stdin.end(input);
  });
}

async function listen(server) {
  servers.push(server);
  server.on('connection', socket => {
    connections.add(socket); socket.on('error', () => socket.destroy()); socket.once('close', () => connections.delete(socket));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}

async function replaceOwnedProfile(value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (ownedProfile) {
    const stat = await fs.lstat(profileFile);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Smoke profile ownership changed.');
    assert.ok((await fs.readFile(profileFile)).equals(ownedProfile), 'Smoke refuses replacing another writer profile.');
    await fs.writeFile(profileFile, bytes, { mode: 0o600 });
  } else await fs.writeFile(profileFile, bytes, { flag: 'wx', mode: 0o600 });
  ownedProfile = bytes;
}

async function main() {
  const dataDir = defaultDataDir();
  profileFile = path.join(dataDir, 'profile.json');
  if (await existing(profileFile)) throw new Error('Refusing packaged smoke: an existing default Guard profile must never be overwritten.');
  const dirInfo = await existing(dataDir);
  if (dirInfo && (!dirInfo.isDirectory() || dirInfo.isSymbolicLink())) throw new Error('Refusing unsafe default Guard data directory.');
  const executable = await packagedExecutable();
  const version = await execute(executable, ['--guard-cli-version'], { timeoutMs: 15000 });
  assert.equal(version.code, 0, version.diagnostics);
  assert.deepEqual(JSON.parse(version.output), { version: packageInfo.version, headlessCli: true });

  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cdg-packaged-cli-'));
  const childFixture = path.join(temporary, `inert-child${process.platform === 'win32' ? '.exe' : ''}`);
  const compiled = await execute('go', ['build', '-o', childFixture, path.join(fixtureRoot, 'headless-child.go')], { timeoutMs: 120000 });
  assert.equal(compiled.code, 0, compiled.diagnostics);
  const key = await fs.readFile(path.join(fixtureRoot, 'packaged-tls', 'public-test-key.pem'));
  const cert = await fs.readFile(path.join(fixtureRoot, 'packaged-tls', 'public-test-cert.pem'));
  let geographyRequests = 0;
  const secure = https.createServer({ key, cert }, (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.headers.host === 'api.ipify.org' && request.url === '/?format=json') return response.end(JSON.stringify({ ip: SYNTHETIC_IP }));
    if (request.headers.host === 'ipinfo.io' && request.url === '/json') {
      geographyRequests++;
      return response.end(JSON.stringify({ ip: SYNTHETIC_IP, country: 'FI', timezone: 'Europe/Helsinki' }));
    }
    response.writeHead(403); response.end('{}');
  });
  const securePort = await listen(secure);
  const unexpectedTargets = [];
  const proxy = http.createServer((_request, response) => { response.writeHead(405); response.end(); });
  proxy.on('clientError', (_error, socket) => socket.destroy());
  proxy.on('connect', (request, client, head) => {
    if (!['api.ipify.org:443', 'ipinfo.io:443'].includes(request.url)) {
      unexpectedTargets.push(request.url); client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    const upstream = net.connect(securePort, '127.0.0.1');
    connections.add(upstream);
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    upstream.once('close', () => { connections.delete(upstream); client.destroy(); }); client.once('close', () => upstream.destroy());
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
  });
  const proxyPort = await listen(proxy);
  const profile = validateProfile({ mode: 'proxy', proxyUrl: `http://127.0.0.1:${proxyPort}`, expectedIp: SYNTHETIC_IP, expectedCountry: 'FI',
    clientMask: { enabled: true, timezone: 'Europe/Helsinki', language: 'en-US', region: 'FI' } });
  profile.pinIdentity = routingIdentity(profile);
  if (await existing(profileFile)) throw new Error('Refusing packaged smoke: a Guard profile appeared concurrently.');
  profileDirCreated = !dirInfo;
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await replaceOwnedProfile(profile);

  const startedFile = path.join(temporary, 'child-started');
  const childEnv = { ...process.env, CDG_SMOKE_STARTED_FILE: startedFile,
    NODE_EXTRA_CA_CERTS: path.join(fixtureRoot, 'packaged-tls', 'public-test-cert.pem'), NODE_TLS_REJECT_UNAUTHORIZED: '1' };
  delete childEnv.NODE_OPTIONS; delete childEnv.ELECTRON_RUN_AS_NODE;
  const originalArgs = ['-p', 'inert fixture; no model request $()'];
  const originalInput = 'exact stdin\nЮникод\n';
  const invoke = () => execute(executable, ['--guard-cli', '--claude-executable', childFixture, '--', ...originalArgs], { env: childEnv, input: originalInput });
  const result = await invoke();
  assert.equal(result.code, 7, result.diagnostics);
  assert.equal(await fs.readFile(startedFile, 'utf8'), 'fixture started\n', 'Successful wrapper never started the inert child.');
  assert.ok(!result.diagnostics.includes('[Claude Desktop Guard]'), result.diagnostics);
  assert.ok(result.diagnostics.includes('fixture stderr without final newline'), result.diagnostics);
  // Electron writes one native startup newline on Windows before JavaScript.
  // Account for only this exact prefix; retain every byte of the child payload.
  const startupPrefix = process.platform === 'win32' ? '\r\n' : '';
  assert.equal(result.output.slice(0, startupPrefix.length), startupPrefix);
  const childOutput = result.output.slice(startupPrefix.length);
  assert.ok(childOutput.startsWith('{'), 'Unexpected stdout bytes before child JSON.');
  const decoded = JSON.parse(childOutput);
  assert.equal(decoded.input, originalInput); assert.deepEqual(decoded.args, originalArgs);
  assert.equal(decoded.env.TZ, 'Europe/Helsinki'); assert.equal(decoded.env.LANG, 'en_US.UTF-8'); assert.equal(decoded.env.LC_ALL, 'en_US.UTF-8');
  assert.equal(decoded.env.DISABLE_ERROR_REPORTING, '1'); assert.equal(decoded.env.CLAUDE_CODE_PROXY_RESOLVES_HOSTS, '1');
  assert.match(decoded.env.HTTPS_PROXY, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
  assert.notEqual(decoded.env.HTTPS_PROXY, profile.proxyUrl);
  assert.equal(decoded.env.NO_PROXY, 'localhost,127.0.0.1,::1');
  for (const [name, value] of Object.entries(decoded.env)) assert.equal(decoded.settingsEnv[name], value);
  assert.ok(geographyRequests > 0, 'Packaged CLI did not verify the offline TLS exit.');

  await replaceOwnedProfile({ ...profile, expectedIp: '1.1.1.1' });
  await fs.unlink(startedFile);
  const refusal = await invoke();
  assert.equal(refusal.code, 78, refusal.diagnostics); assert.equal(refusal.output, startupPrefix);
  assert.equal(await existing(startedFile), null, 'Pinned-exit refusal started the inert child.');
  assert.match(refusal.diagnostics, /^\[Claude Desktop Guard\]/m);
  assert.deepEqual(unexpectedTargets, []);
  console.log(`Packaged ${process.platform}/${process.arch} CLI verified: version, trusted offline TLS gate, exact stdin/stdout/args/env, child exit7, pinned-exit refusal78.`);
}

async function cleanup() {
  for (const socket of connections) socket.destroy();
  await Promise.allSettled(servers.map(server => new Promise(resolve => server.close(resolve))));
  if (ownedProfile) {
    const stat = await existing(profileFile);
    if (!stat?.isFile() || stat.isSymbolicLink() || !(await fs.readFile(profileFile)).equals(ownedProfile)) throw new Error('Smoke profile changed concurrently; refusing to remove it.');
    await fs.unlink(profileFile);
    if (profileDirCreated) await fs.rmdir(path.dirname(profileFile)).catch(error => { if (error.code !== 'ENOTEMPTY') throw error; });
  }
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => cleanup().catch(error => { console.error(error.message); process.exitCode = 1; }));
