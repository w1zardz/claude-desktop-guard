'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GuardSession } = require('../src/session.cjs');

const profile = { proxyUrl:'http://127.0.0.1:7890',expectedIp:'8.8.8.8',expectedCountry:'US' };
const sample = () => ({ ip:'8.8.8.8',country:'US',timezone:'Etc/UTC',observedAt:new Date().toISOString() });
class FakeGate extends EventEmitter {
  constructor() { super(); this.healthy=false; }
  async start() { this.healthy=true;return 'http://127.0.0.1:45678'; }
  status() { return { healthy:this.healthy,locked:!this.healthy,reason:this.healthy?'':'fixture failure' }; }
  lock() { this.healthy=false;this.emit('locked'); }
  async stop() { this.healthy=false; }
}
async function setup(t, overrides={}) {
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
  const session=new GuardSession({dataDir:dir,desktop,Gate:FakeGate,probe:async()=>sample(),binding:async()=>({enabled:false})});
  await session.init(); return {session,calls,dir,desktop};
}
test('pin rejects stale ISO dates, future dates and invalid timestamps', async t=>{
  const {session}=await setup(t);
  for(const observedAt of ['2000-01-01T00:00:00.000Z',new Date(Date.now()+60000).toISOString(),'invalid']) {
    session.pendingProbe={...sample(),proxyUrl:profile.proxyUrl,observedAt};
    await assert.rejects(session.pin({profile}));
  }
  session.pendingProbe={...sample(),proxyUrl:profile.proxyUrl};
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
