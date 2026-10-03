'use strict';
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { GuardGate, probeExit } = require('./network.cjs');
const desktopApi = require('./desktop.cjs');
const { validateProfile, writePrivateJson, readProfile } = require('./profile.cjs');
const { verifyBinding } = require('./mihomo.cjs');

class GuardSession extends EventEmitter {
  constructor({ dataDir, desktop = desktopApi, Gate = GuardGate, probe = probeExit, binding = verifyBinding } = {}) {
    super();
    this.dataDir = dataDir; this.desktopApi = desktop; this.Gate = Gate;
    this.probeExit = probe; this.binding = binding;
    this.profileFile = path.join(dataDir, 'profile.json');
    this.journalDir = path.join(dataDir, 'desktop-transaction');
    this.profile = null; this.desktop = null; this.gate = null;
    this.busy = false; this.phase = 'idle'; this.reason = ''; this.history = [];
    this.pendingProbe = null; this.findings = []; this.transaction = false;
  }
  log(message) {
    this.history.unshift({ time: new Date().toISOString(), message });
    this.history = this.history.slice(0, 60); this.emit('change', this.snapshot());
  }
  snapshot() {
    return { profile: this.profile, desktop: this.desktop, phase: this.phase,
      reason: this.reason, busy: this.busy, probe: this.pendingProbe,
      gate: this.gate?.status() || null, transaction: this.transaction,
      findings: this.findings, history: this.history,
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
    if (this.busy) throw new Error('Дождитесь завершения текущего действия.');
    this.busy = true; this.emit('change', this.snapshot());
    try { return await operation(); }
    catch (e) { this.reason = e.message; this.log(e.message); throw e; }
    finally { this.busy = false; this.emit('change', this.snapshot()); }
  }
  async probe(input) {
    return this.exclusive(async () => {
      if (this.gate) throw new Error('Сначала остановите текущий барьер.');
      const profile = validateProfile(input?.profile);
      const secret = this.secret(input?.controllerSecret);
      this.phase = 'checking'; this.reason = ''; this.pendingProbe = null;
      try {
        const bound = await this.binding(profile.mihomo, secret);
        const exit = await this.probeExit(profile.proxyUrl);
        this.pendingProbe = { ...exit, proxyUrl: profile.proxyUrl, binding: bound };
        this.phase = 'idle'; this.log('Выход проверен через выбранный прокси. IP ещё не закреплён.');
        return this.snapshot();
      } catch (e) { this.phase = 'idle'; throw e; }
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
      if (!sample || sample.proxyUrl !== profile.proxyUrl || !Number.isFinite(observedAt) || observedAt > Date.now() || Date.now() - observedAt > 120000) throw new Error('Сначала снова проверьте этот выход.');
      profile.expectedIp = sample.ip; profile.expectedCountry = sample.country;
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
      const check = async () => {
        await this.binding(profile.mihomo, secret);
        return this.probeExit(profile.proxyUrl);
      };
      const gate = new this.Gate({ proxyUrl: profile.proxyUrl, expectedIp: profile.expectedIp,
        expectedCountry: profile.expectedCountry, probe: check });
      this.gate = gate;
      gate.on('status', () => this.emit('change', this.snapshot()));
      gate.on('locked', () => { this.phase = 'locked'; this.reason = gate.status().reason; this.log('Барьер заблокирован. Действующие и новые туннели закрыты.'); });
      try {
        const proxyUrl = await gate.start();
        await this.desktopApi.installDesktopProxy({ proxyUrl, journalDir: this.journalDir });
        this.transaction = true;
        if (!gate.status().healthy) throw new Error('Выход перестал проходить проверку до запуска Claude.');
        await this.desktopApi.launchDesktop({ desktop: this.desktop, proxyUrl, strictMac: profile.strictMac });
        this.profile = profile; await writePrivateJson(this.profileFile, profile);
        if (!gate.status().healthy) throw new Error('Выход перестал проходить проверку при запуске Claude.');
        this.phase = 'active'; this.log('Claude запущен через локальный барьер. Проверка выхода повторяется каждые 10 секунд.');
        return this.snapshot();
      } catch (e) {
        await gate.stop(); this.gate = null; this.phase = 'idle';
        // An interrupted install may have written only part of its durable journal.
        this.transaction = await this.transactionPending();
        throw e;
      }
    });
  }
  async stop() {
    return this.exclusive(async () => {
      if (this.gate) await this.gate.stop();
      this.gate = null; this.phase = 'idle';
      this.log('Барьер остановлен. Настройки Claude остаются закреплены на закрытом прокси до явного восстановления.');
      return this.snapshot();
    });
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
