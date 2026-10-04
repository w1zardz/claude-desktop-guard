'use strict';
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const net = require('node:net');
const { GuardGate, probeExit } = require('./network.cjs');
const desktopApi = require('./desktop.cjs');
const { validateProfile, validateVpnInterface, routingIdentity, writePrivateJson, readProfile } = require('./profile.cjs');
const { verifyBinding } = require('./mihomo.cjs');

class GuardSession extends EventEmitter {
  constructor({ dataDir, desktop = desktopApi, Gate = GuardGate, probe = probeExit, binding = verifyBinding, amnezia } = {}) {
    super();
    this.dataDir = dataDir; this.desktopApi = desktop; this.Gate = Gate;
    this.probeExit = probe; this.binding = binding;
    this.amnezia = amnezia || { listInterfaces: () => require('./amnezia.cjs').listInterfaces(), openAmnezia: selected => require('./amnezia.cjs').openAmnezia(selected) };
    this.profileFile = path.join(dataDir, 'profile.json');
    this.journalDir = path.join(dataDir, 'desktop-transaction');
    this.profile = null; this.desktop = null; this.gate = null;
    this.busy = false; this.phase = 'idle'; this.reason = ''; this.history = [];
    this.pendingProbe = null; this.findings = []; this.transaction = false; this.clientMask = null;
    this.vpnInterfaces = []; this.interfacesError = ''; this.routing = null; this.routes = new Set(); this.openings = new Set(); this.shuttingDown = false;
  }
  log(message) {
    this.history.unshift({ time: new Date().toISOString(), message });
    this.history = this.history.slice(0, 60); this.emit('change', this.snapshot());
  }
  snapshot() {
    return { profile: this.profile, desktop: this.desktop, phase: this.phase,
      reason: this.reason, busy: this.busy, probe: this.pendingProbe,
      gate: this.gate?.status() || null, transaction: this.transaction,
      findings: this.findings, history: this.history, clientMask: this.clientMask,
      vpnInterfaces: this.vpnInterfaces, interfacesError: this.interfacesError,
      environment: { platform: process.platform, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: Intl.DateTimeFormat().resolvedOptions().locale },
    };
  }
  async init() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    this.dataDir = await fs.realpath(this.dataDir);
    this.profileFile = path.join(this.dataDir, 'profile.json');
    this.journalDir = path.join(this.dataDir, 'desktop-transaction');
    this.profile = await readProfile(this.profileFile);
    this.desktop = await this.desktopApi.discoverDesktop();
    this.findings = await this.desktopApi.readDesktopAudit();
    try { await this.refreshInterfaces(); }
    catch {
      this.interfacesError = 'VPN-интерфейсы недоступны. Запустите Amnezia и обновите список.';
      this.findings.push({ code: 'AMNEZIA_INTERFACES', severity: 'warning', message: this.interfacesError });
    }
    this.transaction = await this.transactionPending();
    if (this.transaction) this.log('Сохранена транзакция настроек. Восстановите её перед следующим запуском.');
    return this.snapshot();
  }
  async transactionPending() {
    try {
      const file = path.join(this.journalDir, 'desktop-transaction.json');
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new Error('Некорректный журнал восстановления.');
      const journal = JSON.parse(await fs.readFile(file, 'utf8'));
      return journal.phase !== 'restored';
    } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  }
  async exclusive(operation) {
    if (this.shuttingDown) throw new Error('Guard завершает работу.');
    if (this.busy) throw new Error('Дождитесь завершения текущего действия.');
    this.busy = true; this.emit('change', this.snapshot());
    try { return await operation(); }
    catch (e) { this.reason = e.message; this.log(e.message); throw e; }
    finally { this.busy = false; this.emit('change', this.snapshot()); }
  }
  async refreshInterfaces() {
    const items = await this.amnezia.listInterfaces();
    if (!Array.isArray(items)) throw new Error('Не удалось получить список VPN-интерфейсов.');
    const interfaces = items.map(validateVpnInterface);
    if (new Set(interfaces.map(item => JSON.stringify(item))).size !== interfaces.length) throw new Error('Список VPN-интерфейсов содержит дубли.');
    this.vpnInterfaces = interfaces; this.interfacesError = '';
    return interfaces;
  }
  async interfaces() {
    return this.exclusive(async () => {
      try { await this.refreshInterfaces(); }
      catch (error) { this.vpnInterfaces = []; this.interfacesError = 'VPN-интерфейсы недоступны. Запустите Amnezia и обновите список.'; throw error; }
      this.emit('change', this.snapshot()); return this.snapshot();
    });
  }
  async openRouting(profile, persistent = false) {
    if (profile.mode !== 'amnezia') {
      const route = { proxyUrl: profile.proxyUrl, assertAlive: () => { if (this.shuttingDown) throw new Error('Guard завершает работу.'); },
        close: async () => { if (this.routing === route) this.routing = null; } };
      if (persistent) this.routing = route;
      return route;
    }
    const opening = this.openNativeRouting(profile, persistent);
    this.openings.add(opening);
    try { return await opening; } finally { this.openings.delete(opening); }
  }
  async openNativeRouting(profile, persistent) {
    const available = await this.refreshInterfaces();
    const selected = profile.vpnInterface;
    if (!available.some(item => item.name === selected.name && item.index === selected.index && item.address === selected.address)) {
      throw new Error('Выбранный VPN-интерфейс исчез или изменился. Обновите список и явно выберите его заново.');
    }
    if (this.shuttingDown) throw new Error('Guard завершает работу.');
    const helper = await this.amnezia.openAmnezia(selected);
    let closed = false, dead = false;
    const route = {
      proxyUrl: helper.proxyUrl,
      assertAlive: () => { if (closed || dead || helper.alive === false || this.shuttingDown) throw new Error('Amnezia-помощник остановлен. Прямой маршрут запрещён.'); },
      close: async () => { if (closed) return; closed = true; try { await helper.close(); } finally { this.routes.delete(route); if (this.routing === route) this.routing = null; } },
    };
    const died = () => {
      if (closed) return;
      dead = true;
      if (persistent && this.gate) this.gate.lock('Amnezia-помощник остановлен. Прямой маршрут запрещён.');
    };
    // Subscribe immediately after ready and inspect the provider's durable alive flag.
    // A helper that died before these listeners were installed must never unlock the gate.
    helper.on('exit', died); helper.on('error', died);
    this.routes.add(route);
    if (persistent) this.routing = route;
    try { route.assertAlive(); return route; } catch (error) { await route.close(); throw error; }
  }
  async checkRouting(profile, route, secret) {
    route.assertAlive();
    const bound = profile.mode === 'proxy' ? await this.binding(profile.mihomo, secret) : { enabled: false };
    route.assertAlive();
    const exit = await this.probeExit(route.proxyUrl);
    route.assertAlive();
    if (profile.mode === 'amnezia' && net.isIP(exit.ip) !== 4) throw new Error('Режим Amnezia поддерживает только IPv4. Проверка IPv6 отклонена.');
    return { ...exit, binding: bound };
  }
  async probe(input) {
    return this.exclusive(async () => {
      if (this.gate) throw new Error('Сначала остановите текущий барьер.');
      // Exit probing needs only routing fields; an unfinished client profile
      // must not prevent the check that supplies its timezone and region.
      const profile = validateProfile({ ...input?.profile, clientMask: undefined });
      const secret = this.secret(input?.controllerSecret);
      this.phase = 'checking'; this.reason = ''; this.pendingProbe = null;
      let route;
      try {
        route = await this.openRouting(profile);
        const exit = await this.checkRouting(profile, route, secret);
        this.pendingProbe = { ...exit, routingIdentity: routingIdentity(profile), ...(profile.mode === 'proxy' ? { proxyUrl: profile.proxyUrl } : {}) };
        this.phase = 'idle'; this.log('Выход проверен через выбранный маршрут. IP ещё не закреплён.');
        return this.snapshot();
      } catch (e) { this.phase = 'idle'; throw e; }
      finally { await route?.close(); }
    });
  }
  secret(value) {
    if (value === undefined) return '';
    if (typeof value !== 'string' || value.length > 1024 || /[\r\n]/.test(value)) throw new Error('Некорректный ключ контроллера.');
    return value;
  }
  async pin(input) {
    return this.exclusive(async () => {
      if (this.gate) throw new Error('Нельзя менять закреплённый выход при работающем барьере.');
      const profile = validateProfile(input?.profile);
      const sample = this.pendingProbe;
      const observedAt = new Date(sample?.observedAt).getTime();
      const identity = routingIdentity(profile);
      if (!sample || sample.routingIdentity !== identity || !Number.isFinite(observedAt) || observedAt > Date.now() || Date.now() - observedAt > 120000) throw new Error('Сначала снова проверьте этот маршрут, интерфейс и выбранный узел.');
      profile.expectedIp = sample.ip; profile.expectedCountry = sample.country;
      profile.pinIdentity = identity;
      this.profile = validateProfile(profile, { requirePin: true });
      await writePrivateJson(this.profileFile, this.profile);
      this.log('IP и страна закреплены вашим выбором. Секрет контроллера не сохраняется.');
      return this.snapshot();
    });
  }
  async start(input) {
    return this.exclusive(async () => {
      if (this.gate || this.transaction) throw new Error('Остановите барьер и восстановите прежнюю транзакцию настроек.');
      const profile = validateProfile(input?.profile, { requirePin: true });
      const secret = this.secret(input?.controllerSecret);
      if (await this.desktopApi.isDesktopRunning()) throw new Error('Завершите Claude Desktop через меню приложения и повторите запуск.');
      this.desktop = await this.desktopApi.discoverDesktop();
      if (!this.desktop) throw new Error('Claude Desktop не найден. Установите официальное приложение.');
      if (!desktopApi.versionSupported(this.desktop.version)) throw new Error(`Обновите Claude Desktop до ${desktopApi.MIN_VERSION} или новее.`);
      this.phase = 'starting'; this.reason = '';
      this.clientMask = null;
      let route, gate;
      try {
        route = await this.openRouting(profile, true);
        const check = async () => {
          const exit = await this.checkRouting(profile, route, secret);
          if (profile.clientMask.enabled) {
            let zone;
            try { zone = new Intl.DateTimeFormat('en', { timeZone: exit.timezone }).resolvedOptions().timeZone; } catch {}
            if (!exit.timezone || zone !== profile.clientMask.timezone) throw new Error('Часовой пояс профиля не совпадает с проверенным выходом. Выберите пояс выхода явно.');
          }
          return exit;
        };
        gate = new this.Gate({ proxyUrl: route.proxyUrl, expectedIp: profile.expectedIp,
          expectedCountry: profile.expectedCountry, probe: check });
        this.gate = gate;
        gate.on('status', () => this.emit('change', this.snapshot()));
        gate.on('locked', () => { this.phase = 'locked'; this.reason = gate.status().reason; this.log(`Барьер заблокирован: ${this.reason}. Действующие и новые туннели закрыты.`); });
        route.assertAlive();
        const proxyUrl = await gate.start();
        route.assertAlive();
        await this.desktopApi.installDesktopProxy({ proxyUrl, journalDir: this.journalDir });
        this.transaction = true;
        route.assertAlive();
        if (!gate.status().healthy) throw new Error('Выход перестал проходить проверку до запуска Claude.');
        await this.desktopApi.launchDesktop({ desktop: this.desktop, proxyUrl, clientMask: profile.clientMask, strictMac: profile.strictMac });
        if (profile.clientMask.enabled) {
          const { timezone, language, region } = profile.clientMask;
          this.clientMask = { requested: { timezone, language, region }, status: 'applied', measured: null,
            nativeLocaleApplied: this.desktop.platform === 'darwin' };
          this.log('Параметры часового пояса и языка переданы Claude при запуске. Это не измерение значений внутри Claude.');
        }
        this.profile = profile; await writePrivateJson(this.profileFile, profile);
        route.assertAlive();
        if (!gate.status().healthy) throw new Error('Выход перестал проходить проверку при запуске Claude.');
        this.phase = 'active'; this.reason = ''; this.log('Claude запущен через локальный барьер. Проверка выхода повторяется каждые 10 секунд.');
        return this.snapshot();
      } catch (e) {
        gate?.lock('Запуск остановлен.');
        await Promise.allSettled([gate?.stop(), route?.close()]);
        this.gate = null; this.phase = 'idle'; this.clientMask = null;
        // An interrupted install may have written only part of its durable journal.
        this.transaction = await this.transactionPending();
        throw e;
      }
    });
  }
  async recheck() {
    return this.exclusive(async () => {
      if (!this.gate || !this.routing) throw new Error('Сначала запустите барьер.');
      this.phase = 'checking'; this.reason = '';
      try {
        this.routing.assertAlive();
        await this.gate.recheck();
        this.routing.assertAlive();
        if (!this.gate.status().healthy) throw new Error('Выход не прошёл повторную проверку.');
        this.phase = 'active'; this.reason = '';
        this.log('Выбранный маршрут повторно проверен. Барьер открыт на прежнем порту; перезапуск Claude не требуется.');
        return this.snapshot();
      } catch (error) {
        this.gate.lock(error.message);
        throw error;
      }
    });
  }
  async stop() {
    return this.exclusive(async () => {
      this.gate?.lock('Барьер остановлен.');
      const cleanup = await Promise.allSettled([this.gate?.stop(), this.routing?.close()]);
      this.gate = null; this.phase = 'idle'; this.clientMask = null;
      if (cleanup.some(result => result.status === 'rejected')) throw new Error('Ошибка остановки. Барьер заблокирован; прежние настройки сохранены в журнале.');
      this.log('Барьер остановлен. Настройки Claude остаются закреплены на закрытом прокси до явного восстановления.');
      return this.snapshot();
    });
  }
  async shutdown() {
    this.shuttingDown = true;
    this.gate?.lock('Приложение Guard закрывается.');
    // A pending ready handshake may create a helper after quit was requested.
    // Let its route observe shuttingDown and close before Electron exits.
    await Promise.allSettled([...this.openings]);
    await Promise.allSettled([this.gate?.stop(), ...[...this.routes].map(route => route.close())]);
    this.gate = null; this.routing = null;
  }
  async restore() {
    return this.exclusive(async () => {
      if (this.gate) throw new Error('Сначала остановите барьер.');
      if (await this.desktopApi.isDesktopRunning()) throw new Error('Перед восстановлением завершите Claude Desktop.');
      const result = await this.desktopApi.restoreDesktopProxy(this.journalDir);
      if (result.conflicts?.length) throw new Error('Настройки изменены другим приложением. Автоматическое восстановление остановлено; резервная копия сохранена.');
      this.transaction = false; this.reason = ''; this.log('Прежние настройки восстановлены. Следующий запуск Claude использует прежний маршрут.');
      return this.snapshot();
    });
  }
}
module.exports = { GuardSession };
