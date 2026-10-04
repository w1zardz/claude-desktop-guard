'use strict';

const { EventEmitter } = require('node:events');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

const HEADER_LIMIT = 16 * 1024;
const DEFAULT_TIMEOUT = 8000;
const DEFAULT_JSON_LIMIT = 64 * 1024;
const COUNTRY_CODES = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));

function boundedPositive(value, name, maximum = 0x7fffffff) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function validateProxyUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?\/?$/i.test(value)) {
    throw new Error('Proxy must be an HTTP(S) origin on 127.0.0.1 or [::1], without credentials, path, query or fragment');
  }
  const parsed = new URL(value);
  if (parsed.port === '0') throw new Error('Proxy port must be between 1 and 65535');
  if (parsed.hostname.toLowerCase() === 'localhost') parsed.hostname = '127.0.0.1';
  return parsed.origin;
}

function ipv6Number(ip) {
  let value = ip.toLowerCase();
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const octets = value.slice(lastColon + 1).split('.').map(Number);
    value = `${value.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = value.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.reduce((total, group) => (total << 16n) | BigInt(`0x${group}`), 0n);
}

function normalizePublicIp(value) {
  if (typeof value !== 'string' || value.length > 45 || value.trim() !== value) throw new Error('Invalid public IP');
  const family = net.isIP(value);
  if (family === 4) {
    const [a, b, c, d] = value.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 192 && b === 0 && (c === 0 || c === 2)) ||
        (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) ||
        (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) {
      throw new Error('IP must be globally routable');
    }
    return `${a}.${b}.${c}.${d}`;
  }
  if (family === 6) {
    const number = ipv6Number(value);
    // Accept global unicast only; reject transition and special-purpose ranges.
    if ((number >> 125n) !== 1n || (number >> 96n) === 0x20010db8n ||
        (number >> 105n) === (0x20010000000000000000000000000000n >> 105n) ||
        (number >> 112n) === 0x2002n || (number >> 108n) === 0x3fff0n) {
      throw new Error('IP must be globally routable');
    }
    return new URL(`http://[${value}]`).hostname.slice(1, -1);
  }
  throw new Error('Invalid public IP');
}

function normalizeCountry(value) {
  if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value) || !COUNTRY_CODES.has(value.toUpperCase())) {
    throw new Error('Country must be an ISO 3166-1 alpha-2 code');
  }
  return value.toUpperCase();
}

function normalizeTimezone(value) {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z0-9_+./-]+$/.test(value)) throw new Error('Invalid time zone');
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; }
  catch { throw new Error('Invalid time zone'); }
}

function validateAuthority(authority) {
  if (typeof authority !== 'string' || authority.length > 260 || /[\s\\/@?#]/.test(authority)) throw new Error('Invalid CONNECT authority');
  const match = authority.match(/^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):443$/);
  if (!match) throw new Error('CONNECT must target an explicit public host on port 443');
  let hostname = match[1].toLowerCase();
  if (hostname.startsWith('[')) {
    const ip = hostname.slice(1, -1);
    if (net.isIP(ip) !== 6) throw new Error('Invalid IPv6 target');
    hostname = normalizePublicIp(ip);
    return { hostname, port: 443, authority: `[${hostname}]:443` };
  }
  if (net.isIP(hostname)) {
    hostname = normalizePublicIp(hostname);
  } else {
    // Numeric pseudo-IP spellings must never become hostnames.
    if (/^[0-9.]+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) throw new Error('Invalid IP target');
    if (hostname.length > 253 || !hostname.includes('.') || hostname.endsWith('.') ||
        hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
        /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|example)$/.test(hostname)) {
      throw new Error('Target must be a public DNS hostname');
    }
  }
  return { hostname, port: 443, authority: `${hostname}:443` };
}

function abortError() { return new Error('Operation aborted'); }

function connectTunnel(proxyUrl, authority, timeoutMs = DEFAULT_TIMEOUT, { signal } = {}) {
  const proxy = new URL(validateProxyUrl(proxyUrl));
  const target = validateAuthority(authority);
  boundedPositive(timeoutMs, 'timeoutMs');
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const host = proxy.hostname.replace(/^\[|\]$/g, '');
    const options = { host, port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)) };
    const socket = proxy.protocol === 'https:'
      ? tls.connect({ ...options, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] })
      : net.connect(options);
    let settled = false;
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error('Upstream CONNECT timed out')), timeoutMs);
    const onAbort = () => fail(abortError());
    const onError = error => fail(error);
    const onClose = () => fail(new Error('Upstream closed before CONNECT completed'));
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      socket.removeListener('connect', sendConnect);
      socket.removeListener('secureConnect', sendConnect);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const sendConnect = () => {
      socket.write(`CONNECT ${target.authority} HTTP/1.1\r\nHost: ${target.authority}\r\n\r\n`);
    };
    const onData = chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buffered.length > HEADER_LIMIT) fail(new Error('Upstream CONNECT headers exceed limit'));
        return;
      }
      if (end + 4 > HEADER_LIMIT) return fail(new Error('Upstream CONNECT headers exceed limit'));
      const header = buffered.subarray(0, end).toString('latin1');
      if (!/^HTTP\/1\.[01] 200(?:[ \t][^\r\n]*)?\r\n/.test(`${header}\r\n`)) {
        return fail(new Error('Upstream proxy rejected CONNECT'));
      }
      const headerLines = header.split('\r\n').slice(1);
      if (headerLines.some(line => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[\t\x20-\x7e\x80-\xff]*$/.test(line))) {
        return fail(new Error('Malformed upstream CONNECT response'));
      }
      settled = true;
      socket.pause();
      cleanup();
      const unread = buffered.subarray(end + 4);
      if (unread.length) socket.unshift(unread);
      resolve(socket);
    };
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.on('data', onData);
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once(proxy.protocol === 'https:' ? 'secureConnect' : 'connect', sendConnect);
    // Cover an abort arriving during synchronous socket creation.
    if (signal?.aborted) onAbort();
  });
}

function requestJsonViaProxy(proxyUrl, httpsUrl, { timeoutMs = DEFAULT_TIMEOUT, maxBytes = DEFAULT_JSON_LIMIT, signal } = {}) {
  const canonicalProxy = validateProxyUrl(proxyUrl);
  boundedPositive(timeoutMs, 'timeoutMs');
  boundedPositive(maxBytes, 'maxBytes', 4 * 1024 * 1024);
  const target = new URL(httpsUrl);
  if (target.protocol !== 'https:' || target.username || target.password || target.hash || (target.port && target.port !== '443')) {
    throw new Error('Probe URL must be HTTPS on port 443 without credentials or fragment');
  }
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const { authority } = validateAuthority(`${net.isIP(host) === 6 ? `[${host}]` : host}:443`);
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let secureSocket;
    const controller = new AbortController();
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
    const timer = setTimeout(() => finish(new Error('HTTPS probe timed out')), timeoutMs);
    const onAbort = () => finish(abortError());
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      controller.abort();
      if (error) req?.destroy();
      secureSocket?.destroy();
      agent.destroy();
      if (error) reject(error); else resolve(result);
    };
    // Agent has exactly one transport: a verified TLS socket over selected CONNECT.
    agent.createConnection = (_options, callback) => {
      connectTunnel(canonicalProxy, authority, timeoutMs, { signal: controller.signal }).then(tunnel => {
        if (settled) { tunnel.destroy(); return; }
        secureSocket = tls.connect({
          socket: tunnel,
          host,
          ...(net.isIP(host) ? {} : { servername: host }),
          rejectUnauthorized: true,
          ALPNProtocols: ['http/1.1'],
        });
        secureSocket.once('error', callback);
        secureSocket.once('secureConnect', () => {
          secureSocket.removeListener('error', callback);
          if (settled) { secureSocket.destroy(); return; }
          callback(null, secureSocket);
        });
      }, callback);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      req = https.request(target, {
        method: 'GET', agent, maxHeaderSize: HEADER_LIMIT,
        headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'Claude-Desktop-Guard/0.1' },
      }, response => {
        if (response.statusCode !== 200) {
          response.destroy();
          return finish(new Error(`HTTPS probe returned status ${response.statusCode}; redirects are not followed`));
        }
        const contentType = String(response.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        if (!/^application\/(?:json|[a-z0-9.+-]+\+json)$/.test(contentType) ||
            (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
          response.destroy();
          return finish(new Error('HTTPS probe must return uncompressed JSON'));
        }
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(new Error('HTTPS probe response exceeds limit'));
            response.destroy();
          } else chunks.push(chunk);
        });
        response.on('aborted', () => finish(new Error('HTTPS probe response was truncated')));
        response.on('error', error => finish(error));
        response.on('end', () => {
          if (settled) return;
          try {
            const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
            const result = JSON.parse(decoded);
            if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('HTTPS probe JSON must be an object');
            finish(null, result);
          } catch (error) { finish(new Error(`Invalid HTTPS probe JSON: ${error.message}`)); }
        });
      });
      req.once('error', error => finish(error));
      req.end();
      if (signal?.aborted) onAbort();
    } catch (error) { finish(error); }
  });
}

async function probeExit(proxyUrl, { request = requestJsonViaProxy, timeoutMs = DEFAULT_TIMEOUT, signal } = {}) {
  const canonicalProxy = validateProxyUrl(proxyUrl);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const [identity, geography] = await Promise.all([
      request(canonicalProxy, 'https://api.ipify.org/?format=json', { timeoutMs, signal: controller.signal }),
      request(canonicalProxy, 'https://ipinfo.io/json', { timeoutMs, signal: controller.signal }),
    ]);
    const ip = normalizePublicIp(identity?.ip);
    if (ip !== normalizePublicIp(geography?.ip)) throw new Error('Independent exit probes disagree on public IP');
    return {
      ip, country: normalizeCountry(geography?.country), timezone: normalizeTimezone(geography?.timezone),
      observedAt: new Date().toISOString(),
    };
  } finally {
    controller.abort();
    signal?.removeEventListener('abort', onAbort);
  }
}

class GuardGate extends EventEmitter {
  constructor({ proxyUrl, expectedIp, expectedCountry, probe = probeExit, checkIntervalMs = 10000, maxAgeMs = 20000, connect = connectTunnel }) {
    super();
    this.proxyUrl = validateProxyUrl(proxyUrl);
    this.expectedIp = normalizePublicIp(expectedIp);
    this.expectedCountry = normalizeCountry(expectedCountry);
    boundedPositive(checkIntervalMs, 'checkIntervalMs');
    boundedPositive(maxAgeMs, 'maxAgeMs');
    if (typeof probe !== 'function' || typeof connect !== 'function') throw new Error('probe and connect must be functions');
    this._probe = probe;
    this._connect = connect;
    this.checkIntervalMs = checkIntervalMs;
    this.maxAgeMs = maxAgeMs;
    this._generation = 0;
    this._server = null;
    this._localProxyUrl = null;
    this._locked = true;
    this._healthy = false;
    this._reason = 'Not started';
    this._verifiedAt = null;
    this._observation = null;
    this._connections = new Set();
    this._pending = new Set();
    this._verification = null;
    this._interval = null;
    this._expiryTimer = null;
  }

  status() {
    return {
      running: Boolean(this._server?.listening), localProxyUrl: this._localProxyUrl,
      locked: this._locked, healthy: this._isFresh(), reason: this._reason,
      ip: this._observation?.ip || null, country: this._observation?.country || null,
      timezone: this._observation?.timezone || null, observedAt: this._observation?.observedAt || null,
      verifiedAt: this._verifiedAt,
    };
  }

  _emitStatus() { this.emit('status', this.status()); }
  _isFresh() { return !this._locked && this._healthy && this._verifiedAt !== null && Date.now() - this._verifiedAt < this.maxAgeMs; }

  async verify() {
    if (this._locked) throw new Error('Guard is locked; explicit start is required');
    if (this._verification) return this._verification.promise;
    const generation = this._generation;
    const controller = new AbortController();
    const timeoutMs = Math.min(DEFAULT_TIMEOUT, this.maxAgeMs);
    const record = { controller, promise: null };
    record.promise = (async () => {
      let timer;
      let onAbort;
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => this._probe(this.proxyUrl, { timeoutMs, signal: controller.signal })),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Exit verification timed out')), timeoutMs);
            onAbort = () => reject(abortError());
            controller.signal.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
        if (generation !== this._generation || this._locked) throw abortError();
        const ip = normalizePublicIp(result?.ip);
        const country = normalizeCountry(result?.country);
        const timezone = normalizeTimezone(result?.timezone);
        if (ip !== this.expectedIp) throw new Error('Exit IP changed or does not match pinned IP');
        if (country !== this.expectedCountry) throw new Error('Exit country changed or does not match pinned country');
        this._verifiedAt = Date.now();
        this._observation = { ip, country, timezone, observedAt: new Date(this._verifiedAt).toISOString() };
        this._healthy = true;
        this._reason = 'Verified';
        clearTimeout(this._expiryTimer);
        this._expiryTimer = setTimeout(() => {
          if (generation === this._generation) this.lock('Exit verification became stale');
        }, this.maxAgeMs);
        this._expiryTimer.unref();
        this._emitStatus();
        return this.status();
      } catch (error) {
        if (generation === this._generation && !this._locked) this.lock(`Exit verification failed: ${error.message}`);
        throw error;
      } finally {
        clearTimeout(timer);
        if (onAbort) controller.signal.removeEventListener('abort', onAbort);
        controller.abort();
        if (this._verification === record) this._verification = null;
      }
    })();
    this._verification = record;
    return record.promise;
  }

  async start() {
    await this.stop();
    const generation = ++this._generation;
    this._locked = false;
    this._healthy = false;
    this._reason = 'Verifying';
    this._emitStatus();
    await this.verify();
    if (generation !== this._generation || !this._isFresh()) throw new Error('Guard start cancelled');
    const server = http.createServer({ maxHeaderSize: HEADER_LIMIT, headersTimeout: DEFAULT_TIMEOUT, requestTimeout: DEFAULT_TIMEOUT, connectionsCheckingInterval: 1000 }, (_req, response) => {
      response.writeHead(405, { Connection: 'close', 'Content-Type': 'text/plain' });
      response.end('Only HTTPS CONNECT is supported\n');
    });
    this._server = server;
    server.on('connection', socket => {
      this._connections.add(socket);
      // CONNECT detaches the HTTP parser's socket error handler. Keep our own
      // for rejection replies and pending tunnels, including async EPIPE/reset.
      // A local client disappearing closes its tunnel, not the verified route.
      socket.on('error', () => socket.destroy());
      socket.once('close', () => this._connections.delete(socket));
    });
    server.on('connect', (request, client, head) => { this._handleConnect(request, client, head).catch(error => this.lock(`Tunnel failed: ${error.message}`)); });
    server.on('clientError', (_error, socket) => {
      socket.destroy();
      this.lock('Malformed local proxy request');
    });
    server.on('error', error => {
      if (generation === this._generation) this.lock(`Local proxy failed: ${error.message}`);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    if (generation !== this._generation || !this._isFresh()) {
      server.close();
      throw new Error('Guard start cancelled');
    }
    this._localProxyUrl = `http://127.0.0.1:${server.address().port}`;
    this._interval = setInterval(() => { this.verify().catch(() => {}); }, this.checkIntervalMs);
    this._interval.unref();
    this._emitStatus();
    return this._localProxyUrl;
  }

  async _handleConnect(request, client, head) {
    if (!this._isFresh()) {
      if (!this._locked) this.lock('Exit verification became stale');
      if (!client.destroyed) client.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    let target;
    try {
      if (request.httpVersion !== '1.1' && request.httpVersion !== '1.0') throw new Error('CONNECT requires HTTP/1.0 or HTTP/1.1');
      target = validateAuthority(request.url);
    }
    catch (error) {
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      this.lock(`Invalid CONNECT target: ${error.message}`);
      return;
    }
    const generation = this._generation;
    const pending = new AbortController();
    this._pending.add(pending);
    const clientClosed = () => pending.abort();
    client.once('close', clientClosed);
    let upstream;
    let timer;
    let onAbort;
    try {
      const connecting = Promise.resolve().then(() => this._connect(this.proxyUrl, target.authority, DEFAULT_TIMEOUT, { signal: pending.signal }));
      // Injected transports may ignore cancellation. Destroy any socket that arrives late.
      connecting.then(socket => {
        if ((pending.signal.aborted || generation !== this._generation) && typeof socket?.destroy === 'function') socket.destroy();
      }, () => {});
      upstream = await Promise.race([
        connecting,
        new Promise((_, reject) => {
          timer = setTimeout(() => { pending.abort(); reject(new Error('Upstream CONNECT timed out')); }, DEFAULT_TIMEOUT);
          onAbort = () => reject(abortError());
          pending.signal.addEventListener('abort', onAbort, { once: true });
          if (pending.signal.aborted) onAbort();
        }),
      ]);
      if (!upstream || typeof upstream.pipe !== 'function' || typeof upstream.destroy !== 'function') throw new Error('Invalid upstream tunnel socket');
      // Lock or stop can happen while CONNECT is in flight. Never send 200 after it.
      if (generation !== this._generation || !this._isFresh() || client.destroyed || pending.signal.aborted) {
        upstream.destroy();
        if (generation === this._generation && !this._locked && !client.destroyed) this.lock('Exit verification became stale');
        client.destroy();
        return;
      }
      this._connections.add(upstream);
      upstream.once('close', () => { this._connections.delete(upstream); client.destroy(); });
      client.once('close', () => upstream.destroy());
      upstream.on('error', error => this.lock(`Upstream tunnel error: ${error.message}`));
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
      upstream.resume();
    } catch (error) {
      upstream?.destroy();
      if (generation === this._generation && !this._locked && !client.destroyed) this.lock(`Upstream CONNECT failed: ${error.message}`);
      client.destroy();
    } finally {
      clearTimeout(timer);
      if (onAbort) pending.signal.removeEventListener('abort', onAbort);
      client.removeListener('close', clientClosed);
      this._pending.delete(pending);
    }
  }

  lock(reason = 'Locked') {
    this._locked = true;
    this._healthy = false;
    this._reason = String(reason);
    ++this._generation;
    clearInterval(this._interval);
    clearTimeout(this._expiryTimer);
    this._interval = null;
    this._expiryTimer = null;
    this._verification?.controller.abort();
    for (const pending of this._pending) pending.abort();
    this._pending.clear();
    for (const socket of this._connections) socket.destroy();
    this._connections.clear();
    this._emitStatus();
    this.emit('locked', this.status());
  }

  async stop() {
    this.lock('Stopped');
    const server = this._server;
    this._server = null;
    this._localProxyUrl = null;
    this._verifiedAt = null;
    this._observation = null;
    this._emitStatus();
    if (server) await new Promise((resolve, reject) => server.close(error => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve();
    }));
  }
}

module.exports = { validateProxyUrl, connectTunnel, requestJsonViaProxy, probeExit, GuardGate };
