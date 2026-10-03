'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { validateProfile, validateClientMask, routingIdentity, writePrivateJson, readProfile } = require('../src/profile.cjs');
const { verifyBinding } = require('../src/mihomo.cjs');

test('profile requires an explicit proxy, pin and complete optional Mihomo binding', () => {
  assert.throws(() => validateProfile({}));
  assert.throws(() => validateProfile({ proxyUrl:'http://127.0.0.1:7890' }, { requirePin:true }));
  assert.throws(() => validateProfile({ proxyUrl:'http://127.0.0.1:7890',mihomo:{ selector:'group' } }));
  const value = validateProfile({ proxyUrl:'http://127.0.0.1:7890',expectedIp:'8.8.8.8',expectedCountry:'de',controllerSecret:'private' }, { requirePin:true });
  assert.equal(value.expectedCountry,'DE'); assert.equal('controllerSecret' in value,false);
  assert.equal(value.mode, 'proxy');
});
test('Amnezia requires exact interface identity, IPv4 and no Mihomo binding', () => {
  const base = { mode: 'amnezia', vpnInterface: { name: 'utun4', index: 22, address: '10.8.0.2' } };
  for (const value of [{ mode: 'other' }, { mode: 'amnezia' }, { ...base, vpnInterface: { ...base.vpnInterface, index: '22' } },
    { ...base, vpnInterface: { ...base.vpnInterface, address: '::1' } }, { ...base, mihomo: { selector: 'group' } },
    { ...base, expectedIp: '2001:4860:4860::8888' }]) assert.throws(() => validateProfile(value));
  const value = validateProfile({ ...base, proxyUrl: 'http://127.0.0.1:temporary', unrelated: true });
  assert.deepEqual(value.vpnInterface, base.vpnInterface);
  assert.equal('proxyUrl' in value, false);
  assert.equal('unrelated' in value, false);
});
test('saved pins bind to mode, proxy, interface source and Mihomo selection', () => {
  const proxy = validateProfile({ proxyUrl: 'http://localhost:7890', expectedIp: '8.8.8.8', expectedCountry: 'US', mihomo: { controllerUrl: 'http://localhost:9090', selector: 'group', expectedLeaf: 'chosen' } });
  proxy.pinIdentity = routingIdentity(proxy);
  assert.doesNotThrow(() => validateProfile(proxy, { requirePin: true }));
  assert.throws(() => validateProfile({ ...proxy, proxyUrl: 'http://127.0.0.1:7891' }, { requirePin: true }));
  assert.throws(() => validateProfile({ ...proxy, mihomo: { ...proxy.mihomo, expectedLeaf: 'other' } }, { requirePin: true }));
  const vpn = validateProfile({ mode: 'amnezia', vpnInterface: { name: 'utun4', index: 22, address: '10.8.0.2' }, expectedIp: '8.8.8.8', expectedCountry: 'US' });
  assert.throws(() => validateProfile(vpn, { requirePin: true }));
  vpn.pinIdentity = routingIdentity(vpn);
  assert.doesNotThrow(() => validateProfile(vpn, { requirePin: true }));
  for (const change of [{ name: 'utun5' }, { index: 23 }, { address: '10.8.0.3' }]) {
    assert.throws(() => validateProfile({ ...vpn, vpnInterface: { ...vpn.vpnInterface, ...change } }, { requirePin: true }));
  }
  assert.notEqual(routingIdentity(vpn), routingIdentity(proxy));
});
test('client parameters default off and normalize explicit safe values', () => {
  assert.deepEqual(validateClientMask(), { enabled: false, timezone: '', language: '', region: '' });
  assert.deepEqual(validateClientMask({ enabled: true, timezone: 'Europe/Helsinki', language: 'EN-us', region: 'fi' }),
    { enabled: true, timezone: 'Europe/Helsinki', language: 'en-US', region: 'FI' });
  assert.equal(validateClientMask({ enabled: true, timezone: 'Europe/Helsinki', language: 'zh-Hant-TW', region: 'FI' }).language, 'zh-Hant-TW');
  assert.equal(validateClientMask({ enabled: false, timezone: 'UTC', language: 'fr-FR', region: 'CA' }).timezone, 'UTC');
});
test('enabled client parameters require every explicit field and reject wrong types', () => {
  const valid = { enabled: true, timezone: 'Europe/Helsinki', language: 'en-GB', region: 'FI' };
  for (const field of ['timezone', 'language', 'region']) {
    const missing = { ...valid }; delete missing[field]; assert.throws(() => validateClientMask(missing));
    assert.throws(() => validateClientMask({ ...valid, [field]: '  ' }));
    for (const wrong of [null, 42, true, [], {}]) assert.throws(() => validateClientMask({ ...valid, [field]: wrong }));
  }
  for (const value of [null, false, 'true', 1, [], { enabled: 'true' }, { enabled: 1 }]) assert.throws(() => validateClientMask(value));
});
test('client parameters reject invalid zones, locales and command/header injection', () => {
  const valid = { enabled: true, timezone: 'Europe/Helsinki', language: 'en-GB', region: 'FI' };
  const attempts = {
    timezone: ['Invalid/Zone', 'UTC;touch /tmp/x', '$(echo UTC)', 'UTC\nLANG=ru', 'GMT+03:00'],
    language: ['en--US', 'en-US;rm', 'en_US', 'en-US\r\nAuthorization: secret', '--proxy-server=direct'],
    region: ['FIN', 'F1', '--FI', 'FI;rm', 'FI\nX'],
  };
  for (const [field, values] of Object.entries(attempts)) for (const value of values) assert.throws(() => validateClientMask({ ...valid, [field]: value }));
});
test('enabled region must match pinned exit; language stays explicit and route identity stays unchanged', () => {
  const proxy = { proxyUrl: 'http://127.0.0.1:7890', expectedIp: '8.8.8.8', expectedCountry: 'FI' };
  const mask = { enabled: true, timezone: 'Europe/Helsinki', language: 'en-GB', region: 'FI' };
  const value = validateProfile({ ...proxy, clientMask: mask }, { requirePin: true });
  assert.equal(value.clientMask.language, 'en-GB');
  assert.equal(routingIdentity(value), routingIdentity(validateProfile(proxy)));
  assert.throws(() => validateProfile({ ...proxy, clientMask: { ...mask, region: 'DE' } }, { requirePin: true }), /совпадать/);
  assert.doesNotThrow(() => validateProfile({ ...proxy, clientMask: { ...mask, enabled: false, region: 'DE' } }, { requirePin: true }));
});
test('private profile preserves client parameters across reload', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdg-mask-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'profile.json');
  const profile = validateProfile({ proxyUrl: 'http://127.0.0.1:7890', clientMask: { enabled: true, timezone: 'Europe/Helsinki', language: 'en-GB', region: 'FI' } });
  await writePrivateJson(file, profile);
  assert.deepEqual((await readProfile(file)).clientMask, profile.clientMask);
});
test('private profile round trip excludes undeclared fields and rejects symlink writes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'cdg-profile-')); t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'profile.json');
  await writePrivateJson(file,validateProfile({proxyUrl:'http://127.0.0.1:7890',controllerSecret:'private'}));
  assert.equal((await readProfile(file)).proxyUrl,'http://127.0.0.1:7890');
  assert.equal((await fs.readFile(file,'utf8')).includes('private'),false);
  if(process.platform !== 'win32') {
    assert.equal((await fs.stat(file)).mode & 0o777,0o600);
    const link=path.join(dir,'linked');await fs.symlink(file,link);await assert.rejects(writePrivateJson(link,{}));
  }
});
test('Mihomo follows nested groups and rejects changed, direct, random or cyclic nodes', async () => {
  const binding={controllerUrl:'http://127.0.0.1:9090',selector:'group',expectedLeaf:'chosen'};
  const good={group:{type:'Selector',all:['nested'],now:'nested'},nested:{type:'Fallback',all:['chosen'],now:'chosen'},chosen:{type:'Shadowsocks'}};
  assert.equal((await verifyBinding(binding,'',async(_u,_s,name)=>good[name])).leaf,'chosen');
  await assert.rejects(verifyBinding(binding,'',async()=>({type:'Direct'})));
  await assert.rejects(verifyBinding(binding,'',async()=>({type:'LoadBalance',all:['chosen'],now:'chosen'})));
  await assert.rejects(verifyBinding(binding,'',async()=>({type:'Selector',all:['group'],now:'group'})));
  await assert.rejects(verifyBinding(binding,'',async()=>({type:'Shadowsocks'})));
  await assert.rejects(verifyBinding(binding,'',async()=>({type:'Selector',all:['chosen'],now:'other'})));
});
