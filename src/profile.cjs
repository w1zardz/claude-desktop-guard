'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { validateProxyUrl } = require('./network.cjs');

function validateProfile(value, { requirePin = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Укажите настройки выхода.');
  const proxyUrl = validateProxyUrl(value.proxyUrl);
  const expectedIp = String(value.expectedIp || '').trim();
  const expectedCountry = String(value.expectedCountry || '').trim().toUpperCase();
  if (expectedIp && !net.isIP(expectedIp)) throw new Error('Некорректный закреплённый IP.');
  if (expectedCountry && !/^[A-Z]{2}$/.test(expectedCountry)) throw new Error('Страна должна иметь двухбуквенный код.');
  if (requirePin && (!expectedIp || !expectedCountry)) throw new Error('Сначала проверьте выход и явно закрепите IP и страну.');
  const mihomo = value.mihomo || {};
  const controllerUrl = String(mihomo.controllerUrl || '').trim();
  const selector = String(mihomo.selector || '').trim();
  const expectedLeaf = String(mihomo.expectedLeaf || '').trim();
  if ([controllerUrl, selector, expectedLeaf].some(Boolean) && ![controllerUrl, selector, expectedLeaf].every(Boolean)) {
    throw new Error('Для привязки Mihomo нужны адрес контроллера, группа и выбранный узел.');
  }
  if (selector.length > 256 || expectedLeaf.length > 256) throw new Error('Имя узла слишком длинное.');
  return { proxyUrl, expectedIp, expectedCountry, strictMac: value.strictMac === true,
    mihomo: { controllerUrl: controllerUrl ? validateProxyUrl(controllerUrl) : '', selector, expectedLeaf } };
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
module.exports = { validateProfile, readProfile, writePrivateJson };
