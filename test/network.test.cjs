'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { validateProxyUrl, connectTunnel, requestJsonViaProxy, probeExit, GuardGate } = require('../src/network.cjs');

// Public, self-signed localhost fixture. This key has no production use.
const FIXTURE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDgqVmsd8Qns4Fo
VPVKtN+EjLVLFGkW5ujhlE1ba+H9g2+Tzidolso62d4IGbTM6eC+RTOUTPe61qG7
pfkasHVjD4xztd9uF0eO6Noqz3BZFXGwv73ths2yoVw7AmLeDYsP+SSt03CB3kW7
jIcLaDc8h2sWCBJ2IY4orjGLLQBzvys8uqhvx/6F8W3y8hmvPIaQPF/HEbXtcXtg
/UsvStUjqpWtWO3aT+zbap6BtzJnc9qMZpVfAkx+4vb0FaRtOw/gFMy81tX2rzYM
QTAaV5/bcGLlmWxZRblPuvgh7Xls+vhVgSBUz5e9VuWF4OW+y6M4qN2IRE2awxiE
YKnbD5/tAgMBAAECggEAHZkXcto+h1p7XehKKWL7Svu8th0ExrB6QEnpB8vb9KnY
d9kXpmGuAqM0a3hzh5xNGymDz5x09h0T0WSJlTi9O7qkhD69pm6TuLdjEskh4eKq
MqE4SlmnB6CBmwFH+ZLq3hpdTjdb4bLhGKySwsUioytWHODIXzQxhe4udx8L1F5n
yujPRLqfiu6T7ZfqXmNyh11+2pO8gq4SPePISTdUlbpwpjxUxtKG13m2t2kVuj5Y
H3W7PRtLP7nP0rJ4OANlNmHOtEKhPQdRHP8Kcm4qZAgcR4eiw9Qyl416ir1WJ4Yj
kZA6RBRrz9gH8kWPzt3JxR6ZRu/Wx0r3UjB0wc87QwKBgQD7zh9/9fxS4ucMnlAF
mwyWQKZbrHrLuc4wLf5K12lyOwgqGcTfSE3E+hY5+90jpu2631npdMr0ViOjWB1b
s7zjA5BTYvfDLsYUgZCKTzA8rCrtG0rhTNpFPY7P2UUruZ72BDcXUx7OSRRUeRoM
R2P6T7krgBT59OSe6n2QWKgxCwKBgQDkZ3elusQgXu/J4o+MbDZvN4jTSJfcbU8X
UD/shcUJjYZ5X4iuU/ZlE7ZwOI0ZDjGpKYmxeqD3NEjC2r6LO/Pv2+EhrhOMX9V1
j0BiyAH1xsu6rVOoq2g+Y0gtrG/iJU3fkSznjsDLx1pWRnwPkbxjtx5w8KeI7Ke/
jgsyi6t95wKBgQDrEZDshzooMrTZXc18fjNw7Sege1MjbvDin30+ZvyEbEGB9A6L
F1eqpIEtXkgiaUqTYsDwJVz2XpfkfHTjz9Zs4z3P6ps7tiWqrQ2/YI+6hEuKkCkG
TRWTABWbScy+NgoExwibGLiwgR6egXNktRzLZ7OIvYhXlFv9UxEnOOzC4wKBgGV5
5rmWEd8D7us2ImrUBRdCiCK+5OGFGxeTiuMNx63n1/AC1toE6bqcmHihV2bjXIL4
tnlIr01FSHJx9ygrGcTeXta03XCHf3H8lDGPBPfqO8eTjFCq3uSg/Yd1TjweMMv8
VwQF83hV+LfOFv5f1GBFElxBP13hLuI3PJhXX3jPAoGAQm0llkA9nFJtuQDrU8nO
Efxcpcixh+H1ouOmHA0TJE963EVRme6Mcn6MJlhVu3NKRCxTAafub/Klfd44jBL4
g+csiiGfMBGoP1/wsqqSgDjh7ltHPpUNl+OQwNQ1XS5mDLHCIGDXmOUg2Rrx+hO1
nGRQ3Ef4cQ1m7Fuv8KWsmoo=
-----END PRIVATE KEY-----
`;
const FIXTURE_CERT = `-----BEGIN CERTIFICATE-----
MIIDKzCCAhOgAwIBAgIUUzkl3FYeiPgtmg3Hvw5ZLnqZ7ngwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNYXBpLmlwaWZ5Lm9yZzAeFw0yNjEwMDMwNzIzNThaFw0z
NjA5MzAwNzIzNThaMBgxFjAUBgNVBAMMDWFwaS5pcGlmeS5vcmcwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQDgqVmsd8Qns4FoVPVKtN+EjLVLFGkW5ujh
lE1ba+H9g2+Tzidolso62d4IGbTM6eC+RTOUTPe61qG7pfkasHVjD4xztd9uF0eO
6Noqz3BZFXGwv73ths2yoVw7AmLeDYsP+SSt03CB3kW7jIcLaDc8h2sWCBJ2IY4o
rjGLLQBzvys8uqhvx/6F8W3y8hmvPIaQPF/HEbXtcXtg/UsvStUjqpWtWO3aT+zb
ap6BtzJnc9qMZpVfAkx+4vb0FaRtOw/gFMy81tX2rzYMQTAaV5/bcGLlmWxZRblP
uvgh7Xls+vhVgSBUz5e9VuWF4OW+y6M4qN2IRE2awxiEYKnbD5/tAgMBAAGjbTBr
MB0GA1UdDgQWBBQ3qgX5SK8iSeDZT4I2XzxncaEqnjAfBgNVHSMEGDAWgBQ3qgX5
SK8iSeDZT4I2XzxncaEqnjAPBgNVHRMBAf8EBTADAQH/MBgGA1UdEQQRMA+CDWFw
aS5pcGlmeS5vcmcwDQYJKoZIhvcNAQELBQADggEBAE/YWF9kKhKyA+gNypAf0q8k
o6T/eErkaCrY9WlVoLAqwZRWYqPKlTbSAkw1slKU8L7kk8qeiwrkF/xDVvllh+XR
lFCq5PDqDZa+3ayWISWDVJ3/hVxLT4IqtxNufQx20m1gv6NZvKdcnPJ0SR0FOyjD
U+hxIIs0ckAzxqsrTkpNvXOPylJj10vjjjZrvCo1skfT0CUgOV964BZ+CAcXfkm+
OmtNOOQeaWyuaNspanRbzqY9UyYtURlkBIVnrWMi0xgW7izF4F9/6eXgE6mF0nr3
zUTb9Ni2xO1pwprv1TysN/Pbor7eP/4Di6wWAm4gN9P9zK1cuEahKfBRPFO0z2k=
-----END CERTIFICATE-----
`;
const EXIT = { ip: '1.1.1.1', country: 'US', timezone: 'America/New_York', observedAt: new Date().toISOString() };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function client(t, proxyUrl, request) {
  const socket = net.connect(Number(new URL(proxyUrl).port), '127.0.0.1');
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  if (request) socket.once('connect', () => socket.write(request));
  return socket;
}

async function collectHeader(socket, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    let result = '';
    const timer = setTimeout(() => finish(new Error('Fixture response timed out')), timeoutMs);
    const data = chunk => {
      result += chunk.toString('latin1');
      if (result.includes('\r\n\r\n')) finish(null, result);
    };
    const closed = () => finish(null, result);
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.removeListener('data', data);
      socket.removeListener('close', closed);
      if (error) reject(error); else resolve(value);
    };
    socket.on('data', data);
    socket.once('close', closed);
  });
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Fixture condition timed out');
    await sleep(5);
  }
}

function makeGate(t, settings = {}) {
  const gate = new GuardGate({ proxyUrl: 'http://127.0.0.1:9', expectedIp: EXIT.ip, expectedCountry: EXIT.country, probe: async () => EXIT, ...settings });
  t.after(() => gate.stop());
  return gate;
}

test('proxy config accepts only canonical loopback HTTP(S) origins', () => {
  assert.equal(validateProxyUrl('http://localhost:7890/'), 'http://127.0.0.1:7890');
  assert.equal(validateProxyUrl('https://[::1]:8080'), 'https://[::1]:8080');
  for (const value of [undefined, '', 'socks5://127.0.0.1:7890', 'http://8.8.8.8:80', 'http://127.1:80', 'http://0x7f000001:80', 'http://127.0.0.2:80', 'http://user:pass@127.0.0.1:80', 'http://127.0.0.1/a', 'http://127.0.0.1/?x=1', 'http://127.0.0.1/#x', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://localhost:80\r\n']) {
    assert.throws(() => validateProxyUrl(value), undefined, String(value));
  }
});

test('gate config rejects private/reserved IPs and unknown countries', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.1.1', '172.16.0.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '203.0.113.1', '224.1.1.1', '::1', 'fc00::1', 'fe80::1', '2001:db8::1', '2001::1', '2002:a00:1::1', '3fff::1', '::ffff:1.1.1.1', 'not-an-ip']) {
    assert.throws(() => new GuardGate({ proxyUrl: 'http://127.0.0.1:9', expectedIp: ip, expectedCountry: 'US' }), undefined, ip);
  }
  assert.throws(() => new GuardGate({ proxyUrl: 'http://127.0.0.1:9', expectedIp: EXIT.ip, expectedCountry: 'ZZ' }));
  assert.throws(() => new GuardGate({ proxyUrl: 'http://127.0.0.1:9', expectedIp: EXIT.ip, expectedCountry: 'US', maxAgeMs: 0 }));
});

test('CONNECT parses fragmented headers and preserves unread TLS bytes', async t => {
  const tlsBytes = Buffer.from([0x16, 0x03, 0x03, 0x00, 0x04, 1, 2, 3, 4]);
  let seen = '';
  const proxyUrl = await fixture(t, net.createServer(socket => {
    socket.once('data', data => {
      seen = data.toString();
      socket.write('HTTP/1.1 20');
      setTimeout(() => socket.write('0 Connection Established\r\nX-Fixture: yes\r\n'), 5);
      setTimeout(() => socket.write(Buffer.concat([Buffer.from('\r\n'), tlsBytes])), 15);
    });
  }));
  const socket = await connectTunnel(proxyUrl, 'api.anthropic.com:443', 500);
  t.after(() => socket.destroy());
  const received = once(socket, 'data');
  socket.resume();
  assert.deepEqual((await received)[0], tlsBytes);
  assert.match(seen, /^CONNECT api\.anthropic\.com:443 HTTP\/1\.1\r\nHost: api\.anthropic\.com:443\r\n\r\n$/);
});

test('CONNECT rejection, malformed response, oversized headers and timeout fail closed', async t => {
  for (const response of ['HTTP/1.1 407 Authentication Required\r\n\r\n', 'HTTP/1.1 2000 Nope\r\n\r\n', 'HTTP/1.1 200 OK\r\nfolded line\r\n\r\n', `HTTP/1.1 200 OK\r\nX: ${'x'.repeat(17000)}\r\n\r\n`]) {
    const proxyUrl = await fixture(t, net.createServer(socket => socket.once('data', () => socket.write(response))));
    await assert.rejects(connectTunnel(proxyUrl, 'api.anthropic.com:443', 250));
  }
  let closed = false;
  const hangingProxy = await fixture(t, net.createServer(socket => { socket.resume(); socket.on('close', () => { closed = true; }); }));
  await assert.rejects(connectTunnel(hangingProxy, 'api.anthropic.com:443', 35), /timed out/);
  await waitUntil(() => closed);
});

test('CONNECT cancellation closes upstream socket before it responds', async t => {
  let connected = false;
  let closed = false;
  const proxyUrl = await fixture(t, net.createServer(socket => {
    connected = true;
    socket.resume();
    socket.on('close', () => { closed = true; });
  }));
  const controller = new AbortController();
  const connecting = connectTunnel(proxyUrl, 'api.anthropic.com:443', 500, { signal: controller.signal });
  await waitUntil(() => connected);
  controller.abort();
  await assert.rejects(connecting, /aborted/);
  await waitUntil(() => closed);
});

test('HTTPS upstream proxy certificate is always verified', async t => {
  const url = await fixture(t, tls.createServer({ key: FIXTURE_KEY, cert: FIXTURE_CERT }, () => assert.fail('Untrusted TLS proxy was accepted')));
  await assert.rejects(connectTunnel(url.replace('http:', 'https:'), 'api.anthropic.com:443', 500), /certificate|self.signed/i);
});

test('probe compares independent IP responses and validates geography', async () => {
  const request = async (_proxy, url) => url.includes('ipify') ? { ip: EXIT.ip } : EXIT;
  const result = await probeExit('http://127.0.0.1:9', { request });
  assert.deepEqual({ ip: result.ip, country: result.country, timezone: result.timezone }, { ip: EXIT.ip, country: EXIT.country, timezone: EXIT.timezone });
  assert.ok(Number.isFinite(Date.parse(result.observedAt)));
  await assert.rejects(probeExit('http://127.0.0.1:9', { request: async (_proxy, url) => url.includes('ipify') ? { ip: '8.8.8.8' } : EXIT }), /disagree/);
  for (const invalid of [{ ...EXIT, ip: '10.0.0.1' }, { ...EXIT, country: 'ZZ' }, { ...EXIT, timezone: 'not/a/timezone' }]) {
    await assert.rejects(probeExit('http://127.0.0.1:9', { request: async (_proxy, url) => url.includes('ipify') ? { ip: invalid.ip } : invalid }));
  }
  const ipv6 = '2606:4700:4700::1111';
  assert.equal((await probeExit('http://127.0.0.1:9', { request: async (_proxy, url) => url.includes('ipify') ? { ip: ipv6 } : { ...EXIT, ip: '2606:4700:4700:0:0:0:0:1111' } })).ip, ipv6);
});

test('gate permits CONNECT only through explicitly selected upstream', async t => {
  const authorities = [];
  const proxyUrl = await fixture(t, net.createServer(socket => {
    socket.once('data', data => {
      authorities.push(data.toString().split('\r\n')[0]);
      socket.write('HTTP/1.1 200 OK\r\n\r\n');
      socket.on('data', body => socket.write(body));
    });
  }));
  const gate = makeGate(t, { proxyUrl });
  const local = await gate.start();
  const socket = client(t, local, 'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n');
  assert.match(await collectHeader(socket), /^HTTP\/1\.1 200/);
  const echoed = once(socket, 'data');
  socket.write('opaque payload');
  assert.equal((await echoed)[0].toString(), 'opaque payload');
  assert.deepEqual(authorities, ['CONNECT api.anthropic.com:443 HTTP/1.1']);
  assert.equal(gate.status().healthy, true);
});

test('gate rejects plaintext HTTP without opening any upstream tunnel', async t => {
  let calls = 0;
  const gate = makeGate(t, { connect: async () => { calls++; throw new Error('Should not connect'); } });
  const local = await gate.start();
  const socket = client(t, local, 'GET http://api.anthropic.com/ HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n');
  assert.match(await collectHeader(socket), /^HTTP\/1\.1 405/);
  assert.equal(calls, 0);
  assert.equal(gate.status().healthy, true);
});

test('malformed and private CONNECT targets never reach upstream', async t => {
  for (const authority of ['api.anthropic.com:80', '127.0.0.1:443', '[::1]:443', '192.168.1.1:443', 'localhost:443', 'router.local:443', 'user@api.anthropic.com:443', 'api.anthropic.com:443/path', '2130706433:443', '0x7f000001:443', 'api.anthropic.com:443\r\nInjected: yes']) {
    let calls = 0;
    await assert.rejects(async () => connectTunnel('http://127.0.0.1:9', authority), undefined, authority);
    const gate = makeGate(t, { connect: async () => { calls++; throw new Error('Should not connect'); } });
    const local = await gate.start();
    const socket = client(t, local, `CONNECT ${authority} HTTP/1.1\r\nHost: ignored\r\n\r\n`);
    await collectHeader(socket);
    assert.equal(calls, 0, authority);
    assert.equal(gate.status().locked, true, authority);
    await gate.stop();
  }
});

test('upstream failure locks gate and never falls back to direct transport', async t => {
  let calls = 0;
  const gate = makeGate(t, { connect: async (proxy, authority) => {
    calls++;
    assert.equal(proxy, 'http://127.0.0.1:9');
    assert.equal(authority, 'api.anthropic.com:443');
    throw new Error('Selected upstream unavailable');
  } });
  const local = await gate.start();
  await collectHeader(client(t, local, 'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: ignored\r\n\r\n'));
  assert.equal(gate.status().locked, true);
  await collectHeader(client(t, local, 'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: ignored\r\n\r\n'));
  assert.equal(calls, 1);
  await assert.rejects(gate.verify(), /explicit start/);
});

test('locked CONNECT handles asynchronous rejection write errors without reopening', async t => {
  let calls = 0;
  const gate = makeGate(t, { connect: async () => { calls++; throw new Error('Should not connect'); } });
  const local = await gate.start();
  gate.lock('Changed exit');
  for (const code of ['EPIPE', 'ECONNRESET']) {
    let closed = false;
    // Use a real accepted socket, but make the write fail deterministically:
    // peer-reset timing differs between macOS, Windows and Linux.
    gate._server.prependOnceListener('connect', (_request, socket) => {
      socket._write = (_chunk, _encoding, callback) => {
        process.nextTick(() => callback(Object.assign(new Error(`write ${code}`), { code })));
      };
      socket.once('close', () => { closed = true; });
    });
    await collectHeader(client(t, local, 'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: ignored\r\n\r\n'));
    await waitUntil(() => closed);
    assert.equal(gate.status().locked, true);
    assert.equal(gate.status().reason, 'Changed exit');
    assert.equal(calls, 0);
  }
  assert.match(await collectHeader(client(t, local, 'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: ignored\r\n\r\n')), /^HTTP\/1\.1 503/);
  assert.equal(calls, 0);
});

test('local CONNECT write failure closes only its tunnel and leaves verified gate usable', async t => {
  const upstreams = [];
  const gate = makeGate(t, { connect: async () => {
    const upstream = new PassThrough();
    upstreams.push(upstream);
    return upstream;
  } });
  const local = await gate.start();
  gate._server.prependOnceListener('connect', (_request, socket) => {
    socket._write = (_chunk, _encoding, callback) => {
      process.nextTick(() => callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
    };
  });
  await collectHeader(client(t, local, 'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: ignored\r\n\r\n'));
  await waitUntil(() => upstreams.length === 1 && upstreams[0].destroyed);
  assert.equal(gate.status().healthy, true);
  assert.equal(gate.status().locked, false);
  assert.match(await collectHeader(client(t, local, 'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: ignored\r\n\r\n')), /^HTTP\/1\.1 200/);
  assert.equal(upstreams.length, 2);
});

test('local reset during CONNECT cancels pending transport and destroys late upstream', async t => {
  let accepted;
  let release;
  let signal;
  const late = new PassThrough();
  const gate = makeGate(t, { connect: (_proxy, _authority, _timeout, options) => {
    signal = options.signal;
    return new Promise(resolve => { release = resolve; });
  } });
  const local = await gate.start();
  gate._server.prependOnceListener('connect', (_request, socket) => { accepted = socket; });
  const socket = client(t, local, 'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: ignored\r\n\r\n');
  const response = collectHeader(socket);
  await waitUntil(() => release);
  accepted.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
  await response;
  await waitUntil(() => signal.aborted);
  release(late);
  await waitUntil(() => late.destroyed);
  assert.equal(gate.status().healthy, true);
  assert.equal(gate._pending.size, 0);
});

test('upstream socket errors still lock verified gate and close local tunnels', async t => {
  const upstream = new PassThrough();
  const gate = makeGate(t, { connect: async () => upstream });
  const local = await gate.start();
  const socket = client(t, local, 'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: ignored\r\n\r\n');
  assert.match(await collectHeader(socket), /^HTTP\/1\.1 200/);
  upstream.destroy(Object.assign(new Error('upstream reset'), { code: 'ECONNRESET' }));
  await waitUntil(() => socket.destroyed);
  assert.equal(gate.status().locked, true);
  assert.match(gate.status().reason, /Upstream tunnel error/);
});

test('lock destroys active and pending native socket tunnels', async t => {
  let upstreamCount = 0;
  let closedCount = 0;
  const proxyUrl = await fixture(t, net.createServer(socket => {
    const number = ++upstreamCount;
    socket.once('close', () => { closedCount++; });
    socket.once('data', () => { if (number === 1) socket.write('HTTP/1.1 200 OK\r\n\r\n'); });
  }));
  const gate = makeGate(t, { proxyUrl });
  const local = await gate.start();
  const active = client(t, local, 'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: ignored\r\n\r\n');
  assert.match(await collectHeader(active), /^HTTP\/1\.1 200/);
  const pending = client(t, local, 'CONNECT ipinfo.io:443 HTTP/1.1\r\nHost: ignored\r\n\r\n');
  let pendingBytes = '';
  pending.on('data', chunk => { pendingBytes += chunk.toString(); });
  await waitUntil(() => upstreamCount === 2);
  gate.lock('User kill switch');
  await waitUntil(() => active.destroyed && pending.destroyed && closedCount === 2);
  assert.equal(pendingBytes.includes('200'), false);
  assert.equal(gate.status().locked, true);
});

test('late async CONNECT cannot return 200 after lock or leave orphan socket', async t => {
  let release;
  let invoked = false;
  const late = new PassThrough();
  const gate = makeGate(t, { connect: () => {
    invoked = true;
    return new Promise(resolve => { release = resolve; });
  } });
  const local = await gate.start();
  const socket = client(t, local, 'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: ignored\r\n\r\n');
  let response = '';
  socket.on('data', chunk => { response += chunk; });
  await waitUntil(() => invoked);
  gate.lock('Changed exit');
  release(late);
  await waitUntil(() => late.destroyed && socket.destroyed);
  assert.equal(response.includes('200'), false);
  assert.equal(gate.status().locked, true);
});

test('probe IP/country mismatch locks and successful verify cannot reopen', async t => {
  let observation = EXIT;
  const gate = makeGate(t, { probe: async () => observation });
  await gate.start();
  observation = { ...EXIT, ip: '8.8.8.8' };
  await assert.rejects(gate.verify(), /IP changed/);
  observation = EXIT;
  await assert.rejects(gate.verify(), /explicit start/);
  assert.equal(gate.status().locked, true);
  await gate.start();
  assert.equal(gate.status().healthy, true);
  observation = { ...EXIT, country: 'CA' };
  await assert.rejects(gate.verify(), /country changed/);
  assert.equal(gate.status().locked, true);
});

test('stale health closes existing tunnels and blocks new CONNECT', async t => {
  let calls = 0;
  const echo = await fixture(t, net.createServer(socket => socket.pipe(socket)));
  const gate = makeGate(t, { maxAgeMs: 70, checkIntervalMs: 10000, connect: async () => { calls++; return net.connect(Number(new URL(echo).port), '127.0.0.1'); } });
  const local = await gate.start();
  const active = client(t, local, 'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: ignored\r\n\r\n');
  assert.match(await collectHeader(active), /^HTTP\/1\.1 200/);
  await waitUntil(() => gate.status().locked && active.destroyed);
  assert.match(gate.status().reason, /stale/);
  await collectHeader(client(t, local, 'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: ignored\r\n\r\n'));
  assert.equal(calls, 1);
});

test('hanging probe is bounded and cannot reopen after late completion', async t => {
  let release;
  const gate = makeGate(t, { maxAgeMs: 30, probe: () => new Promise(resolve => { release = resolve; }) });
  const startedAt = Date.now();
  await assert.rejects(gate.start(), /timed out/);
  assert.ok(Date.now() - startedAt < 500);
  release(EXIT);
  await sleep(5);
  assert.equal(gate.status().locked, true);
  assert.equal(gate.status().healthy, false);
  assert.equal(gate.status().localProxyUrl, null);
});

test('stop during verification cancels start without creating a proxy', async t => {
  let invoked = false;
  let release;
  const gate = makeGate(t, { probe: () => { invoked = true; return new Promise(resolve => { release = resolve; }); } });
  const starting = gate.start();
  // Attach rejection handler immediately: stop intentionally aborts verification.
  const rejected = assert.rejects(starting, /aborted|cancelled/);
  await waitUntil(() => invoked);
  await gate.stop();
  release(EXIT);
  await rejected;
  assert.equal(gate.status().localProxyUrl, null);
  assert.equal(gate.status().locked, true);
});

async function jsonFixture(t, handler) {
  const secure = https.createServer({ key: FIXTURE_KEY, cert: FIXTURE_CERT }, handler);
  await fixture(t, secure);
  const proxy = http.createServer();
  proxy.on('connect', (req, clientSocket, head) => {
    assert.match(req.url, /^(api\.ipify\.org|ipinfo\.io):443$/);
    const upstream = net.connect(secure.address().port, '127.0.0.1');
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
    clientSocket.on('close', () => upstream.destroy());
    upstream.once('connect', () => {
      clientSocket.write('HTTP/1.1 200 OK\r\n\r\n');
      if (head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
  });
  return fixture(t, proxy);
}

async function trustedProbeChild(t, proxyUrl, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'claude-guard-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const certificatePath = path.join(dir, 'public-fixture-ca.pem');
  await writeFile(certificatePath, FIXTURE_CERT);
  const script = `require(process.argv[1]).requestJsonViaProxy(process.argv[2], process.argv[3], JSON.parse(process.argv[4])).then(value => process.stdout.write(JSON.stringify(value))).catch(error => { process.stderr.write(error.message); process.exitCode = 1; });`;
  const child = spawn(process.execPath, ['-e', script, require.resolve('../src/network.cjs'), proxyUrl, options.url || 'https://api.ipify.org/?format=json', JSON.stringify({ timeoutMs: 1000, maxBytes: options.maxBytes || 256 })], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: certificatePath, NODE_TLS_REJECT_UNAUTHORIZED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  const [code] = await once(child, 'close');
  return { code, output, error };
}

test('HTTPS target certificate is verified even behind selected proxy', async t => {
  let reached = false;
  const proxyUrl = await jsonFixture(t, (_req, res) => { reached = true; res.end('{}'); });
  await assert.rejects(requestJsonViaProxy(proxyUrl, 'https://api.ipify.org/?format=json', { timeoutMs: 500 }), /certificate|self.signed/i);
  assert.equal(reached, false);
  const wrongHost = await trustedProbeChild(t, proxyUrl, { url: 'https://ipinfo.io/json' });
  assert.equal(wrongHost.code, 1);
  assert.match(wrongHost.error, /certificate|altname|hostname/i);
  assert.equal(reached, false);
});

test('HTTPS JSON probe uses tunnel, enforces limits, and never follows redirect', async t => {
  let mode = 'valid';
  let requests = 0;
  const proxyUrl = await jsonFixture(t, (_req, response) => {
    requests++;
    response.setHeader('Content-Type', 'application/json');
    if (mode === 'redirect') { response.writeHead(302, { Location: 'https://api.ipify.org/elsewhere' }); response.end(); }
    else if (mode === 'malformed') response.end('{invalid');
    else if (mode === 'large') response.end(JSON.stringify({ ip: 'x'.repeat(1000) }));
    else if (mode === 'encoding') { response.setHeader('Content-Encoding', 'gzip'); response.end('{}'); }
    else if (mode === 'array') response.end('[]');
    else response.end(JSON.stringify({ ip: EXIT.ip }));
  });
  const good = await trustedProbeChild(t, proxyUrl);
  assert.equal(good.code, 0, good.error);
  assert.deepEqual(JSON.parse(good.output), { ip: EXIT.ip });
  for (const invalid of ['redirect', 'malformed', 'large', 'encoding', 'array']) {
    mode = invalid;
    const before = requests;
    const result = await trustedProbeChild(t, proxyUrl);
    assert.equal(result.code, 1, invalid);
    assert.equal(requests - before, 1, invalid);
    assert.match(result.error, /status 302|Invalid HTTPS|exceeds limit|uncompressed JSON/, invalid);
  }
});

test('HTTPS probe rejects plaintext URL, credentials and private destinations before I/O', () => {
  for (const target of ['http://api.ipify.org/', 'https://user:pass@api.ipify.org/', 'https://127.0.0.1/', 'https://api.ipify.org:8443/', 'https://api.ipify.org/#fragment']) {
    assert.throws(() => requestJsonViaProxy('http://127.0.0.1:9', target), undefined, target);
  }
});
