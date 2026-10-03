'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GuardSession } = require('../src/session.cjs');
const { validateProfile, routingIdentity } = require('../src/profile.cjs');

const profile = { proxyUrl:'http://127.0.0.1:7890',expectedIp:'8.8.8.8',expectedCountry:'US' };
const sample = () => ({ ip:'8.8.8.8',country:'US',timezone:'Etc/UTC',observedAt:new Date().toISOString() });
class FakeGate extends EventEmitter {
  constructor(options) { super(); this.healthy=false; this.options = options; }
  async start() { await this.options.probe(); this.healthy=true;return 'http://127.0.0.1:45678'; }
  status() { return { healthy:this.healthy,locked:!this.healthy,reason:this.healthy?'':'fixture failure' }; }
  lock() { this.healthy=false;this.emit('locked'); }
  async stop() { this.healthy=false; }
}
async function setup(t, overrides={}, dependencies={}) {
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'cdg-session-'));
  const dir=await fs.realpath(temporary); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const calls=[];
  const desktop={
    discoverDesktop:async()=>({path:'/fixture/Claude',version:'2.19675.0',platform:'darwin'}),
    readDesktopAudit:async()=>[],isDesktopRunning:async()=>false,
    installDesktopProxy:async({journalDir})=>{calls.push('install');await fs.mkdir(journalDir,{recursive:true});await fs.writeFile(path.join(journalDir,'desktop-transaction.json'),JSON.stringify({phase:'installed'}));},
    launchDesktop:async()=>{calls.push('launch');return new EventEmitter();},
    restoreDesktopProxy:async journalDir=>{calls.push('restore');await fs.writeFile(path.join(journalDir,'desktop-transaction.json'),JSON.stringify({phase:'restored'}));return {restored:true,conflicts:[]};},
    ...overrides,
  };
  const session=new GuardSession({dataDir:dir,desktop,Gate:FakeGate,probe:async()=>sample(),binding:async()=>({enabled:false}), amnezia: { listInterfaces: async () => [], openAmnezia: async () => { throw new Error('No interface selected'); } }, ...dependencies});
  await session.init(); return {session,calls,dir,desktop};
}
test('pin rejects stale ISO dates, future dates and invalid timestamps', async t=>{
  const {session}=await setup(t);
  for(const observedAt of ['2000-01-01T00:00:00.000Z',new Date(Date.now()+60000).toISOString(),'invalid']) {
    session.pendingProbe={...sample(),proxyUrl:profile.proxyUrl,routingIdentity:routingIdentity(validateProfile(profile)),observedAt};
    await assert.rejects(session.pin({profile}));
  }
  session.pendingProbe={...sample(),proxyUrl:profile.proxyUrl,routingIdentity:routingIdentity(validateProfile(profile))};
  await session.pin({profile});assert.equal(session.profile.expectedIp,'8.8.8.8');
});
test('restored journal does not block restart, planned journal does', async t=>{
  const {session}=await setup(t);
  await fs.mkdir(session.journalDir,{recursive:true});
  const file=path.join(session.journalDir,'desktop-transaction.json');
  await fs.writeFile(file,JSON.stringify({phase:'restored'}));await session.init();assert.equal(session.transaction,false);
  await fs.writeFile(file,JSON.stringify({phase:'planned'}));await session.init();assert.equal(session.transaction,true);
});
test('a lock during settings installation prevents Desktop launch and active status', async t=>{
  const {session,calls,desktop}=await setup(t);
  const install=desktop.installDesktopProxy;
  desktop.installDesktopProxy=async options=>{await install(options);session.gate.lock();};
  await assert.rejects(session.start({profile}));
  assert.deepEqual(calls,['install']);assert.notEqual(session.phase,'active');assert.equal(session.gate,null);assert.equal(session.transaction,true);
});
test('a lock during launch never returns a verified active state', async t=>{
  const {session,desktop}=await setup(t);
  desktop.launchDesktop=async()=>{session.gate.lock();};
  await assert.rejects(session.start({profile}));assert.notEqual(session.phase,'active');assert.equal(session.gate,null);
});
test('running Desktop prevents both start and restore changes', async t=>{
  const {session,calls,desktop}=await setup(t);
  desktop.isDesktopRunning=async()=>true;
  await assert.rejects(session.start({profile}));await assert.rejects(session.restore());assert.deepEqual(calls,[]);
});
test('stopping leaves explicit restore transaction, restore survives the next initialization', async t=>{
  const {session,calls}=await setup(t);
  await session.start({profile});await session.stop();assert.equal(session.transaction,true);
  await session.restore();assert.equal(session.transaction,false);
  await session.init();assert.equal(session.transaction,false);assert.deepEqual(calls,['install','launch','restore']);
});
test('launch failure closes gate and retains settings journal for recovery', async t=>{
  const {session,desktop}=await setup(t);
  desktop.launchDesktop=async()=>{throw new Error('fixture launch failed');};
  await assert.rejects(session.start({profile}),/fixture launch failed/);assert.equal(session.gate,null);assert.equal(session.transaction,true);
});
test('unsupported Desktop fails before writing any configuration', async t=>{
  const {session,calls,desktop}=await setup(t);
  desktop.discoverDesktop=async()=>({path:'/fixture/Claude',version:'1.0.0',platform:'darwin'});
  await assert.rejects(session.start({profile}),/Обновите/);assert.deepEqual(calls,[]);assert.equal(session.gate,null);
});

const selected = { name: 'utun4', index: 22, address: '10.8.0.2' };
const vpnProfile = () => ({ mode: 'amnezia', vpnInterface: { ...selected } });
function pinnedVpn() {
  const value = validateProfile({ ...vpnProfile(), expectedIp: '8.8.8.8', expectedCountry: 'US' });
  value.pinIdentity = routingIdentity(value); return value;
}
function nativeFixture() {
  const helpers = [], calls = [];
  const provider = {
    listInterfaces: async () => [{ ...selected }],
    openAmnezia: async requested => {
      assert.deepEqual(requested, selected); calls.push('open');
      const helper = new EventEmitter(); helper.alive = true; helper.proxyUrl = 'http://127.0.0.1:48765'; helper.closed = 0;
      helper.close = async () => { if (helper.closed) return; helper.closed++; helper.alive = false; calls.push('close'); helper.emit('exit', 0, null); };
      helper.die = () => { helper.alive = false; helper.emit('exit', 1, null); };
      helpers.push(helper); return helper;
    },
  };
  return { provider, helpers, calls };
}
test('Amnezia probe closes helper and pins exact interface without saving temporary proxy URL', async t => {
  const native = nativeFixture(), urls = [];
  const { session, dir } = await setup(t, {}, { amnezia: native.provider, probe: async url => { urls.push(url); return sample(); } });
  await session.probe({ profile: vpnProfile() });
  assert.deepEqual(native.calls, ['open', 'close']);
  assert.deepEqual(urls, [native.helpers[0].proxyUrl]);
  assert.equal('proxyUrl' in session.pendingProbe, false);
  await session.pin({ profile: vpnProfile() });
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'profile.json'), 'utf8'));
  assert.deepEqual(saved.vpnInterface, selected);
  assert.equal(saved.mode, 'amnezia'); assert.equal('proxyUrl' in saved, false);
  assert.equal(saved.pinIdentity, routingIdentity(saved));
});
test('Amnezia failed or IPv6 probe always closes helper', async t => {
  for (const probe of [async () => { throw new Error('probe failed'); }, async () => ({ ...sample(), ip: '2001:4860:4860::8888' })]) {
    const native = nativeFixture(), { session } = await setup(t, {}, { amnezia: native.provider, probe });
    await assert.rejects(session.probe({ profile: vpnProfile() }));
    assert.equal(native.helpers[0].closed, 1); assert.equal(session.pendingProbe, null);
  }
});
test('missing or changed interface never opens native helper or launches Desktop', async t => {
  const native = nativeFixture(), { session, calls } = await setup(t, {}, { amnezia: native.provider });
  for (const available of [[], [{ ...selected, name: 'utun5' }], [{ ...selected, index: 23 }], [{ ...selected, address: '10.8.0.3' }]]) {
    native.provider.listInterfaces = async () => available;
    await assert.rejects(session.start({ profile: pinnedVpn() }), /интерфейс/);
  }
  assert.deepEqual(native.calls, []); assert.deepEqual(calls, []); assert.equal(session.gate, null);
});
test('pin rejects changed interface, mode and Mihomo selection identities', async t => {
  const native = nativeFixture(), { session } = await setup(t, {}, { amnezia: native.provider });
  await session.probe({ profile: vpnProfile() });
  for (const change of [{ name: 'utun5' }, { index: 23 }, { address: '10.8.0.3' }]) {
    await assert.rejects(session.pin({ profile: { ...vpnProfile(), vpnInterface: { ...selected, ...change } } }));
  }
  await assert.rejects(session.pin({ profile }));
  const proxy = { ...profile, mihomo: { controllerUrl: 'http://127.0.0.1:9090', selector: 'group', expectedLeaf: 'chosen' } };
  await session.probe({ profile: proxy });
  await assert.rejects(session.pin({ profile: { ...proxy, mihomo: { ...proxy.mihomo, selector: 'other-group' } } }));
  await assert.rejects(session.pin({ profile: { ...proxy, mihomo: { ...proxy.mihomo, expectedLeaf: 'other-node' } } }));
});
test('helper death immediately locks gate; stop closes helper with no restart', async t => {
  const native = nativeFixture(), { session } = await setup(t, {}, { amnezia: native.provider });
  await session.start({ profile: pinnedVpn() });
  assert.equal(session.gate.options.proxyUrl, native.helpers[0].proxyUrl);
  native.helpers[0].die();
  assert.equal(session.gate.status().healthy, false); assert.equal(session.phase, 'locked');
  assert.equal(native.helpers.length, 1);
  await session.stop(); assert.equal(native.helpers[0].closed, 1); assert.equal(session.routing, null);
});
test('helper error locks gate and launch failure closes helper', async t => {
  const native = nativeFixture(), { session, desktop } = await setup(t, {}, { amnezia: native.provider });
  desktop.launchDesktop = async () => { throw new Error('launch failed'); };
  await assert.rejects(session.start({ profile: pinnedVpn() }), /launch failed/);
  assert.equal(native.helpers[0].closed, 1); assert.equal(session.gate, null); assert.equal(session.routing, null);
  await session.restore(); desktop.launchDesktop = async () => new EventEmitter();
  await session.start({ profile: pinnedVpn() });
  native.helpers[1].alive = false; native.helpers[1].emit('error', new Error('helper failed'));
  assert.equal(session.gate.status().healthy, false);
  await session.stop(); assert.equal(native.helpers[1].closed, 1);
});
test('helper that already died or dies during installation cannot launch Desktop', async t => {
  const native = nativeFixture(), { session, desktop, calls } = await setup(t, {}, { amnezia: native.provider });
  const open = native.provider.openAmnezia;
  native.provider.openAmnezia = async requested => { const helper = await open(requested); helper.alive = false; return helper; };
  await assert.rejects(session.start({ profile: pinnedVpn() }));
  assert.deepEqual(calls, []); assert.equal(native.helpers[0].closed, 1);
  native.provider.openAmnezia = open;
  const install = desktop.installDesktopProxy;
  desktop.installDesktopProxy = async options => { await install(options); native.helpers[1].die(); };
  await assert.rejects(session.start({ profile: pinnedVpn() }));
  assert.deepEqual(calls, ['install']); assert.equal(native.helpers[1].closed, 1); assert.equal(session.gate, null);
});
test('shutdown closes active helper and a helper still running a probe', async t => {
  const native = nativeFixture(), { session } = await setup(t, {}, { amnezia: native.provider });
  await session.start({ profile: pinnedVpn() }); await session.shutdown();
  assert.equal(native.helpers[0].closed, 1); assert.equal(session.gate, null);
  const probing = nativeFixture(); let finish;
  const { session: pending } = await setup(t, {}, { amnezia: probing.provider, probe: async () => new Promise(resolve => { finish = resolve; }) });
  const result = pending.probe({ profile: vpnProfile() });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await pending.shutdown(); assert.equal(probing.helpers[0].closed, 1);
  finish(sample()); await assert.rejects(result); assert.equal(pending.pendingProbe, null);
});
test('shutdown waits for helper readiness and closes a helper opened during quit', async t => {
  const native = nativeFixture(); let ready;
  const open = native.provider.openAmnezia;
  native.provider.openAmnezia = async requested => {
    await new Promise(resolve => { ready = resolve; });
    return open(requested);
  };
  const { session } = await setup(t, {}, { amnezia: native.provider });
  const probe = session.probe({ profile: vpnProfile() });
  const rejected = assert.rejects(probe, /остановлен/);
  while (!ready) await new Promise(resolve => setImmediate(resolve));
  let stopped = false;
  const quit = session.shutdown().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  ready(); await quit; await rejected;
  assert.equal(native.helpers[0].closed, 1); assert.equal(session.routes.size, 0);
});
test('interface discovery failure leaves proxy mode available', async t => {
  const { session } = await setup(t, {}, { amnezia: { listInterfaces: async () => { throw new Error('platform unsupported'); } } });
  assert.ok(session.interfacesError); await session.probe({ profile });
  assert.ok(session.pendingProbe); assert.equal(session.phase, 'idle');
});
test('proxy start paused before gate creation cannot continue after shutdown', async t => {
  const { session, desktop, calls } = await setup(t); let discover;
  desktop.discoverDesktop = async () => new Promise(resolve => { discover = resolve; });
  const start = session.start({ profile });
  const rejected = assert.rejects(start, /завершает работу/);
  while (!discover) await new Promise(resolve => setImmediate(resolve));
  await session.shutdown();
  discover({ path: '/fixture/Claude', version: '2.19675.0', platform: 'darwin' });
  await rejected; assert.deepEqual(calls, []); assert.equal(session.gate, null);
});
test('proxy probe paused during binding cannot open its connection after shutdown', async t => {
  let bound; let probes = 0;
  const { session } = await setup(t, {}, { binding: async () => new Promise(resolve => { bound = resolve; }), probe: async () => { probes++; return sample(); } });
  const probe = session.probe({ profile });
  const rejected = assert.rejects(probe, /завершает работу/);
  while (!bound) await new Promise(resolve => setImmediate(resolve));
  await session.shutdown(); bound({ enabled: false }); await rejected;
  assert.equal(probes, 0); assert.equal(session.pendingProbe, null);
});
