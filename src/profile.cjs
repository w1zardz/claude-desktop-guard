'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { validateProxyUrl } = require('./network.cjs');

function validateClientMask(value) {
  if (value === undefined) return { enabled: false, timezone: '', language: '', region: '' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректные параметры часового пояса и языка Claude.');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('Включение параметров Claude должно быть явным boolean.');
  const enabled = value.enabled === true;
  const fields = {};
  for (const name of ['timezone', 'language', 'region']) {
    if (value[name] !== undefined && typeof value[name] !== 'string') throw new Error(`Параметр ${name} должен быть строкой.`);
    fields[name] = (value[name] || '').trim();
  }
  if (enabled && Object.values(fields).some(field => !field)) throw new Error('Укажите часовой пояс, язык и страну Claude явно.');
  if (fields.timezone) {
    if (!/^[A-Za-z0-9_+./-]{1,100}$/.test(fields.timezone)) throw new Error('Укажите корректный IANA-часовой пояс Claude.');
    try { fields.timezone = new Intl.DateTimeFormat('en', { timeZone: fields.timezone }).resolvedOptions().timeZone; }
    catch { throw new Error('Укажите корректный IANA-часовой пояс Claude.'); }
  }
  if (fields.language) {
    if (fields.language.length > 100 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(fields.language)) throw new Error('Укажите корректный BCP47-код языка Claude.');
    try { fields.language = Intl.getCanonicalLocales(fields.language)[0]; }
    catch { throw new Error('Укажите корректный BCP47-код языка Claude.'); }
  }
  if (fields.region) {
    fields.region = fields.region.toUpperCase();
    if (!/^[A-Z]{2}$/.test(fields.region)) throw new Error('Страна Claude должна иметь явный двухбуквенный код ISO.');
  }
  return { enabled, ...fields };
}

function validateVpnInterface(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.name !== 'string' ||
      !value.name.trim() || value.name.length > 256 || /[\u0000-\u001f\u007f]/.test(value.name) ||
      !Number.isInteger(value.index) || value.index < 1 || value.index > 0xffffffff || net.isIP(value.address) !== 4 ||
      value.address === '0.0.0.0' || value.address.startsWith('127.')) {
    throw new Error('Явно выберите доступный VPN-интерфейс с именем, индексом и IPv4-адресом.');
  }
  return { name: value.name, index: value.index, address: value.address };
}

function routingIdentity(profile) {
  const mode = profile.mode || 'proxy';
  const route = mode === 'amnezia' ? [profile.vpnInterface.name, profile.vpnInterface.index, profile.vpnInterface.address] : profile.proxyUrl;
  const mihomo = profile.mihomo || {};
  return JSON.stringify([mode, route, [mihomo.controllerUrl || '', mihomo.selector || '', mihomo.expectedLeaf || '']]);
}

function validateProfile(value, { requirePin = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Укажите настройки выхода.');
  const mode = value.mode === undefined ? 'proxy' : value.mode;
  if (!['proxy', 'amnezia'].includes(mode)) throw new Error('Явно выберите режим: локальный прокси или Amnezia VPN.');
  const proxyUrl = mode === 'proxy' ? validateProxyUrl(value.proxyUrl) : undefined;
  const vpnInterface = mode === 'amnezia' ? validateVpnInterface(value.vpnInterface) : undefined;
  const expectedIp = String(value.expectedIp || '').trim();
  const expectedCountry = String(value.expectedCountry || '').trim().toUpperCase();
  if (expectedIp && !net.isIP(expectedIp)) throw new Error('Некорректный закреплённый IP.');
  if (mode === 'amnezia' && expectedIp && net.isIP(expectedIp) !== 4) throw new Error('Режим Amnezia поддерживает только IPv4. IPv6-маршрут запрещён.');
  if (expectedCountry && !/^[A-Z]{2}$/.test(expectedCountry)) throw new Error('Страна должна иметь двухбуквенный код.');
  if (requirePin && (!expectedIp || !expectedCountry)) throw new Error('Сначала проверьте выход и явно закрепите IP и страну.');
  const clientMask = validateClientMask(value.clientMask);
  if (requirePin && clientMask.enabled && clientMask.region !== expectedCountry) throw new Error('Страна параметров Claude должна совпадать со страной закреплённого выхода.');
  const mihomo = value.mihomo || {};
  const controllerUrl = String(mihomo.controllerUrl || '').trim();
  const selector = String(mihomo.selector || '').trim();
  const expectedLeaf = String(mihomo.expectedLeaf || '').trim();
  if (mode === 'amnezia' && [controllerUrl, selector, expectedLeaf].some(Boolean)) throw new Error('Привязка Mihomo не применяется в режиме Amnezia VPN.');
  if ([controllerUrl, selector, expectedLeaf].some(Boolean) && ![controllerUrl, selector, expectedLeaf].every(Boolean)) {
    throw new Error('Для привязки Mihomo нужны адрес контроллера, группа и выбранный узел.');
  }
  if (selector.length > 256 || expectedLeaf.length > 256) throw new Error('Имя узла слишком длинное.');
  const profile = { mode, ...(mode === 'proxy' ? { proxyUrl } : { vpnInterface }), expectedIp, expectedCountry, strictMac: value.strictMac === true, clientMask,
    mihomo: { controllerUrl: controllerUrl ? validateProxyUrl(controllerUrl) : '', selector, expectedLeaf } };
  if (value.pinIdentity !== undefined) {
    if (typeof value.pinIdentity !== 'string' || value.pinIdentity.length > 2048) throw new Error('Некорректная привязка проверенного маршрута.');
    profile.pinIdentity = value.pinIdentity;
  }
  if (requirePin && ((profile.pinIdentity && profile.pinIdentity !== routingIdentity(profile)) || (mode === 'amnezia' && !profile.pinIdentity))) {
    throw new Error('Маршрут изменился. Проверьте выход и заново закрепите IP для выбранного интерфейса или узла.');
  }
  return profile;
}

async function writePrivateJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const info = await fs.lstat(file).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
  if (info?.isSymbolicLink()) throw new Error('Файл настроек не может быть символической ссылкой.');
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

async function readProfile(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Некорректный файл профиля.');
    return validateProfile(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
module.exports = { validateProfile, validateClientMask, validateVpnInterface, routingIdentity, readProfile, writePrivateJson };
