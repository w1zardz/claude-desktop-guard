'use strict';
const http = require('node:http');
const https = require('node:https');
const { validateProxyUrl } = require('./network.cjs');

function controllerJson(controllerUrl, secret, name, timeout = 5000) {
  const base = new URL(validateProxyUrl(controllerUrl));
  if (typeof secret !== 'string' || secret.length > 1024 || /[\r\n]/.test(secret)) throw new Error('Некорректный ключ контроллера.');
  const target = new URL(`/proxies/${encodeURIComponent(name)}`, base);
  return new Promise((resolve, reject) => {
    const req = (base.protocol === 'https:' ? https : http).get(target, {
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      agent: false,
    }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('Контроллер Mihomo не подтвердил узел.')); return; }
      let body = ''; let size = 0;
      res.on('data', data => { size += data.length; if (size > 65536) { req.destroy(new Error('Ответ контроллера слишком большой.')); return; } body += data; });
      res.on('error', reject);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Контроллер вернул некорректный JSON.')); } });
    });
    const timer = setTimeout(() => req.destroy(new Error('Контроллер Mihomo не отвечает.')), timeout);
    req.on('error', reject); req.on('close', () => clearTimeout(timer));
  });
}

async function verifyBinding(binding, secret = '', fetch = controllerJson) {
  if (!binding?.controllerUrl) return { enabled: false };
  const visited = new Set(); let name = binding.selector;
  for (let depth = 0; depth < 16; depth++) {
    if (!name || visited.has(name)) throw new Error('Цикл или пустой узел в группе Mihomo.');
    visited.add(name);
    const item = await fetch(binding.controllerUrl, secret, name);
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Некорректная структура узла Mihomo.');
    if (/^(direct|reject|rejectdrop|loadbalance)$/i.test(String(item.type || ''))) throw new Error('Выбрана прямая, блокирующая или балансирующая группа Mihomo.');
    if (Array.isArray(item.all)) {
      if (typeof item.now !== 'string' || !item.all.includes(item.now)) throw new Error('Группа Mihomo не указывает единственный активный узел.');
      name = item.now; continue;
    }
    if (!item.type || name !== binding.expectedLeaf) throw new Error('Mihomo переключил выбранный узел. Соединения заблокированы.');
    return { enabled: true, leaf: name, chain: [...visited] };
  }
  throw new Error('Слишком глубокая цепочка Mihomo.');
}
module.exports = { controllerJson, verifyBinding };
