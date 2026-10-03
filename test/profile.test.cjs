'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { validateProfile, writePrivateJson, readProfile } = require('../src/profile.cjs');
const { verifyBinding } = require('../src/mihomo.cjs');

test('profile requires an explicit proxy, pin and complete optional Mihomo binding', () => {
  assert.throws(() => validateProfile({}));
  assert.throws(() => validateProfile({ proxyUrl:'http://127.0.0.1:7890' }, { requirePin:true }));
  assert.throws(() => validateProfile({ proxyUrl:'http://127.0.0.1:7890',mihomo:{ selector:'group' } }));
  const value = validateProfile({ proxyUrl:'http://127.0.0.1:7890',expectedIp:'8.8.8.8',expectedCountry:'de',controllerSecret:'private' }, { requirePin:true });
  assert.equal(value.expectedCountry,'DE'); assert.equal('controllerSecret' in value,false);
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
