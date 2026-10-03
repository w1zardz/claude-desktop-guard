'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const MIN_VERSION = '1.44121.1';
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const BYPASS_KEYS = ['NO_PROXY', 'no_proxy'];
const LOOPBACK_BYPASS = 'localhost,127.0.0.1,::1';
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }

function context({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (!['darwin', 'win32'].includes(platform)) fail('UNSUPPORTED_PLATFORM', 'Claude Desktop integration requires macOS or Windows.');
  if (!path.isAbsolute(home)) fail('UNSAFE_PATH', 'Home must be an absolute path.');
  const local = platform === 'win32' ? env.LOCALAPPDATA : path.join(home, 'Library', 'Application Support');
  if (!local || !path.isAbsolute(local)) fail('UNSAFE_PATH', 'A valid LOCALAPPDATA directory is required.');
  return { platform, home, env, library: path.join(local, 'Claude-3p', 'configLibrary'), settings: path.join(home, '.claude', 'settings.json') };
}

function command(file, args, env) {
  return new Promise((resolve, reject) => childProcess.execFile(file, args,
    { env, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
    (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
}
function powershell(script, env) {
  return command('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], env);
}
async function statOrNull(file) { try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function assertSafePath(file) {
  if (!path.isAbsolute(file)) fail('UNSAFE_PATH', 'Only absolute paths are accepted.');
  const resolved = path.resolve(file);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await statOrNull(current);
    if (!stat) continue;
    if (stat.isSymbolicLink()) fail('UNSAFE_PATH', 'Symbolic links are not accepted in configuration or journal paths.');
    if (current !== resolved && !stat.isDirectory()) fail('UNSAFE_PATH', 'A parent path is not a directory.');
  }
  return resolved;
}
async function readBytes(file, maxBytes = 4 * 1024 * 1024) {
  await assertSafePath(file);
  const stat = await statOrNull(file);
  if (!stat) return null;
  if (!stat.isFile() || stat.size > maxBytes) fail('UNSAFE_FILE', 'Configuration must be a regular file within the supported size limit.');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try { return await handle.readFile(); } finally { await handle.close(); }
}
function parseObject(bytes, label) {
  let result;
  try { result = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { fail('MALFORMED_CONFIG', `${label} is not valid JSON.`); }
  if (!object(result)) fail('MALFORMED_CONFIG', `${label} must contain a JSON object.`);
  return result;
}
async function readObject(file, label, maxBytes) { const bytes = await readBytes(file, maxBytes); return { bytes, value: bytes === null ? {} : parseObject(bytes, label) }; }
async function syncDirectory(dir) {
  if (process.platform === 'win32') return;
  const handle = await fs.open(dir, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function atomicWrite(file, bytes) {
  await assertSafePath(file);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await assertSafePath(file);
  const temp = path.join(path.dirname(file), `.guard-${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await assertSafePath(file); await fs.rename(temp, file); await syncDirectory(path.dirname(file));
  }
  finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function writeIfUnchanged(file, before, after) {
  const now = await readBytes(file);
  if ((before === null) !== (now === null) || (before !== null && !before.equals(now))) fail('CONFIG_CONCURRENT_CHANGE', 'Configuration changed during the operation; restore the pending transaction and retry.');
  await atomicWrite(file, after);
}
function versionSupported(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) return false;
  const actual = version.split('.').map(Number), minimum = MIN_VERSION.split('.').map(Number);
  for (let index = 0; index < Math.max(actual.length, minimum.length); index++) {
    const difference = (actual[index] || 0) - (minimum[index] || 0);
    if (difference) return difference > 0;
  }
  return true;
}
function validId(id) { return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id); }
function validateMeta(meta) {
  if (own(meta, 'hybridPointer')) fail('HYBRID_CONFIG', 'Bootstrap/hybrid configuration owns this profile; local proxy installation is refused.');
  if (own(meta, 'appliedId') && meta.appliedId !== null && meta.appliedId !== '' && !validId(meta.appliedId)) fail('MALFORMED_META', 'The active configuration identifier is unsafe.');
  if (own(meta, 'entries') && (!Array.isArray(meta.entries) || meta.entries.some(entry => !object(entry) || !validId(entry.id)))) fail('MALFORMED_META', 'Configuration entries are malformed.');
  const ids = (meta.entries || []).map(entry => entry.id);
  if (new Set(ids).size !== ids.length) fail('MALFORMED_META', 'Configuration identifiers must be unique.');
}
function hasPac(config) {
  for (const key of ['egressProxyUrl', 'egressProxyPacUrl']) if (own(config, key) && config[key] !== null && typeof config[key] !== 'string') fail('MALFORMED_CONFIG', 'Desktop proxy settings must be strings.');
  return typeof config.egressProxyPacUrl === 'string' && config.egressProxyPacUrl.length > 0;
}
function validateProxy(proxyUrl) {
  let url;
  try { url = new URL(proxyUrl); } catch { fail('INVALID_PROXY', 'Proxy must be an HTTP URL on literal loopback.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('INVALID_PROXY', 'Proxy must be http://127.0.0.1:<port> without credentials or extra URL parts.');
  return `http://127.0.0.1:${url.port}`;
}

async function discoverDesktop(options = {}) {
  const ctx = context(options);
  if (ctx.platform === 'darwin') {
    for (const app of [path.join(ctx.home, 'Applications', 'Claude.app'), '/Applications/Claude.app']) {
      const executable = path.join(app, 'Contents', 'MacOS', 'Claude');
      if (!(await statOrNull(executable))?.isFile()) continue;
      const version = await command('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')], ctx.env);
      return { path: executable, version, platform: ctx.platform };
    }
    return null;
  }
  // Values emitted by PowerShell are data only. No user text is interpolated into this script.
  const script = `$ErrorActionPreference='Stop'; $items=@(); Get-AppxPackage -Name 'Claude' | ForEach-Object { $p=$_; $m=Get-AppxPackageManifest -Package $p; foreach($a in $m.Package.Applications.Application){ if($a.Executable -match '(^|[\\/])Claude\\.exe$'){ $items += @{root=$p.InstallLocation; executable=[string]$a.Executable; version=[string]$p.Version} } } }; ConvertTo-Json -InputObject @($items) -Compress`;
  const packages = JSON.parse(await powershell(script, ctx.env) || '[]');
  if (!Array.isArray(packages)) fail('DISCOVERY_FAILED', 'Desktop package metadata is malformed.');
  for (const candidate of packages) {
    if (!object(candidate) || typeof candidate.root !== 'string' || !path.isAbsolute(candidate.root) || typeof candidate.executable !== 'string' || path.isAbsolute(candidate.executable)) continue;
    const executable = path.resolve(candidate.root, candidate.executable.replace(/[\\/]/g, path.sep));
    const relative = path.relative(candidate.root, executable);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || !/Claude\.exe$/i.test(executable)) continue;
    if ((await statOrNull(executable))?.isFile()) return { path: executable, version: String(candidate.version), platform: ctx.platform };
  }
  const root = path.join(ctx.env.LOCALAPPDATA, 'AnthropicClaude');
  const roots = [root, path.join(ctx.env.LOCALAPPDATA, 'Claude')];
  for (const appRoot of roots) {
    const stat = await statOrNull(appRoot);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
    const children = (await fs.readdir(appRoot)).filter(name => /^app-\d+(?:\.\d+)+$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const dir of ['', ...children]) {
      const executable = path.join(appRoot, dir, 'Claude.exe');
      if (!(await statOrNull(executable))?.isFile()) continue;
      const version = await powershell(`$ErrorActionPreference='Stop'; (Get-Item -LiteralPath $env:GUARD_DISCOVER_PATH).VersionInfo.ProductVersion`, { ...ctx.env, GUARD_DISCOVER_PATH: executable });
      return { path: executable, version, platform: ctx.platform };
    }
  }
  return null;
}
async function isDesktopRunning(options = {}) {
  const ctx = context(options);
  if (ctx.platform === 'win32') return (await powershell(`$ErrorActionPreference='Stop'; @(Get-Process -Name Claude -ErrorAction SilentlyContinue).Count`, ctx.env)) !== '0';
  try { await command('/usr/bin/pgrep', ['-x', 'Claude'], ctx.env); return true; }
  catch (error) { if (error.code === 1) return false; fail('PROCESS_CHECK_FAILED', 'Cannot determine whether Claude Desktop is running.'); }
}

async function managedState(ctx) {
  const desktop = [], code = [];
  if (ctx.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'; $result=@{desktop=@();code=@()}; foreach($h in @('HKLM','HKCU')){ foreach($name in @('Claude','ClaudeCode')){ $p=$h+':\\SOFTWARE\\Policies\\'+$name; if(Test-Path -LiteralPath $p){ $k=Get-Item -LiteralPath $p; $values=@{}; foreach($n in $k.GetValueNames()){ $kind=$k.GetValueKind($n).ToString(); if($kind -in @('String','ExpandString','DWord')){ $values[$n]=$k.GetValue($n,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } }; if($name -eq 'Claude'){ $result.desktop += @{source=$h;values=$values} }else{ $result.code += @{source=$h;values=$values} } } } }; ConvertTo-Json -InputObject $result -Depth 30 -Compress`;
    const result = JSON.parse(await powershell(script, ctx.env));
    if (!object(result) || !Array.isArray(result.desktop) || !Array.isArray(result.code)) fail('MANAGED_CHECK_FAILED', 'Policy inspection returned malformed data.');
    const machine = result.desktop.find(item => item.source === 'HKLM' && object(item.values) && Object.keys(item.values).length);
    const active = machine ? [machine] : result.desktop.filter(item => item.source === 'HKCU');
    desktop.push(...active.filter(item => object(item.values) && Object.keys(item.values).length));
    for (const item of result.code) {
      if (object(item.values) && own(item.values, 'Settings')) code.push(parseObject(Buffer.from(String(item.values.Settings)), 'Claude Code registry policy'));
    }
  } else {
    const username = path.basename(ctx.home);
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) fail('UNSAFE_PATH', 'Cannot inspect per-user managed preferences safely.');
    for (const domain of ['com.anthropic.claudefordesktop', 'com.anthropic.claudecode']) {
      for (const root of ['/Library/Managed Preferences', path.join('/Library/Managed Preferences', username)]) {
        const file = path.join(root, `${domain}.plist`);
        if (!(await statOrNull(file))) continue;
        await assertSafePath(file);
        const value = parseObject(Buffer.from(await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], ctx.env)), 'Managed preferences');
        if (Object.keys(value).length) (domain.endsWith('claudecode') ? code : desktop).push(value);
      }
    }
  }
  const codeRoot = ctx.platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : path.join(ctx.env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode');
  const files = [path.join(codeRoot, 'managed-settings.json')];
  const dropIns = path.join(codeRoot, 'managed-settings.d');
  const dropStat = await statOrNull(dropIns);
  if (dropStat) {
    await assertSafePath(dropIns);
    if (!dropStat.isDirectory()) fail('MANAGED_CHECK_FAILED', 'Managed settings drop-in path is not a directory.');
    files.push(...(await fs.readdir(dropIns)).filter(name => !name.startsWith('.') && name.endsWith('.json')).sort().map(name => path.join(dropIns, name)));
  }
  for (const file of files) {
    if (!(await statOrNull(file))) continue;
    code.push((await readObject(file, 'Claude Code managed settings')).value);
  }
  return { desktop, code };
}
function proxyEnvKeys(value) {
  if (!own(value, 'env')) return [];
  if (!object(value.env)) fail('MALFORMED_CONFIG', 'The settings env block must be an object.');
  return [...PROXY_KEYS, ...BYPASS_KEYS].filter(key => own(value.env, key));
}
function managedConflicts(state) {
  const conflicts = [];
  if (state.desktop.length) conflicts.push({ code: 'MANAGED_DESKTOP', severity: 'error', message: 'Organization-managed Desktop settings can override the local proxy. Ask the administrator to configure routing.' });
  if (state.code.some(value => proxyEnvKeys(value).length || own(value, 'policyHelper'))) conflicts.push({ code: 'MANAGED_CODE_PROXY', severity: 'error', message: 'Claude Code policy can override the agent proxy or compute settings dynamically.' });
  return conflicts;
}
async function readDesktopAudit(options = {}) {
  const ctx = context(options), findings = [];
  try {
    const desktop = await discoverDesktop(options);
    if (!desktop) findings.push({ code: 'DESKTOP_MISSING', severity: 'error', message: 'Claude Desktop was not found.' });
    else if (!versionSupported(desktop.version)) findings.push({ code: 'DESKTOP_VERSION', severity: 'error', message: `Proxy pinning requires Desktop ${MIN_VERSION} or later; detected version is unsupported or unreadable.` });
    else findings.push({ code: 'DESKTOP_SUPPORTED', severity: 'info', message: `Desktop ${desktop.version} supports proxy pinning.` });
  } catch { findings.push({ code: 'DISCOVERY_FAILED', severity: 'error', message: 'Claude Desktop version could not be verified.' }); }
  try { findings.push(...managedConflicts(await managedState(ctx))); }
  catch { findings.push({ code: 'MANAGED_CHECK_FAILED', severity: 'error', message: 'Managed policy inspection failed; routing cannot be verified.' }); }
  try {
    const meta = await readObject(path.join(ctx.library, '_meta.json'), 'Configuration index');
    validateMeta(meta.value);
    if (meta.value.appliedId) {
      const active = await readObject(path.join(ctx.library, `${meta.value.appliedId}.json`), 'Active Desktop configuration');
      if (!active.bytes) fail('MALFORMED_META', 'The active configuration file is missing.');
      if (hasPac(active.value)) findings.push({ code: 'PAC_CONFLICT', severity: 'error', message: 'The active Desktop profile uses PAC, which takes priority over a fixed proxy.' });
      if (own(active.value, 'egressProxyUrl')) findings.push({ code: 'EXISTING_DESKTOP_PROXY', severity: 'info', message: 'An existing Desktop proxy will be saved privately and restored after use.' });
    }
  } catch (error) { findings.push({ code: error.code || 'CONFIG_READ_FAILED', severity: 'error', message: 'Desktop configuration is unsafe, malformed, or bootstrap-managed.' }); }
  try {
    const settings = await readObject(ctx.settings, 'Claude Code user settings');
    const keys = proxyEnvKeys(settings.value);
    if (keys.length) findings.push({ code: 'USER_PROXY_SETTINGS', severity: 'warning', message: `User settings contain proxy variables: ${keys.join(', ')}. Values are not displayed.` });
  } catch { findings.push({ code: 'USER_SETTINGS_INVALID', severity: 'error', message: 'Claude Code user settings cannot be safely read.' }); }
  const inheritedKeys = [...PROXY_KEYS, ...BYPASS_KEYS].filter(key => own(ctx.env, key));
  if (inheritedKeys.length) findings.push({ code: 'INHERITED_PROXY_ENV', severity: 'info', message: `Launcher will replace inherited variables: ${inheritedKeys.join(', ')}.` });
  findings.push({ code: 'ROUTING_BOUNDARY', severity: 'warning', message: 'Updates, external browser sign-in, remote SSH sessions, and programs ignoring proxy variables need OS-level routing controls.' });
  return findings;
}

function snapshot(value, key) { return { exists: own(value, key), ...(own(value, key) ? { value: value[key] } : {}) }; }
function matches(value, key, saved) { return own(value, key) === saved.exists && (!saved.exists || isDeepStrictEqual(value[key], saved.value)); }
function putSnapshot(value, key, saved) { if (saved.exists) value[key] = saved.value; else delete value[key]; }
async function acquireJournal(journalDir) {
  await assertSafePath(journalDir);
  await fs.mkdir(journalDir, { recursive: true, mode: 0o700 });
  await fs.chmod(journalDir, 0o700);
  const lock = path.join(journalDir, '.lock');
  await assertSafePath(lock);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(lock, 'wx', 0o600);
      await handle.writeFile(String(process.pid)); await handle.sync(); await handle.close();
      return async () => { await fs.unlink(lock).catch(error => { if (error.code !== 'ENOENT') throw error; }); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number((await readBytes(lock)).toString('utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) fail('JOURNAL_BUSY', 'Journal lock is invalid; inspect it before continuing.');
      try { process.kill(pid, 0); fail('JOURNAL_BUSY', 'Another guard operation owns the journal.'); }
      catch (processError) { if (processError.code !== 'ESRCH') throw processError; }
      await fs.unlink(lock);
    }
  }
  fail('JOURNAL_BUSY', 'Could not acquire the journal.');
}
async function installDesktopProxy({ proxyUrl, journalDir, ...options } = {}) {
  const ctx = context(options), proxy = validateProxy(proxyUrl);
  if (typeof journalDir !== 'string' || !path.isAbsolute(journalDir)) fail('UNSAFE_PATH', 'A private absolute journal directory is required.');
  if (await isDesktopRunning(options)) fail('DESKTOP_RUNNING', 'Quit Claude Desktop completely before configuring its proxy.');
  const managed = managedConflicts(await managedState(ctx));
  if (managed.length) fail(managed[0].code, managed[0].message);
  const metaPath = path.join(ctx.library, '_meta.json');
  const meta = await readObject(metaPath, 'Configuration index'); validateMeta(meta.value);
  const createdConfig = !meta.value.appliedId, configId = meta.value.appliedId || crypto.randomUUID();
  const configPath = path.join(ctx.library, `${configId}.json`);
  const config = await readObject(configPath, 'Active Desktop configuration');
  if (!createdConfig && !config.bytes) fail('MALFORMED_META', 'The active configuration file is missing.');
  if (createdConfig && config.bytes) fail('CONFIG_COLLISION', 'The generated profile identifier already exists.');
  if (hasPac(config.value)) fail('PAC_CONFLICT', 'An existing PAC proxy takes priority; installation is refused.');
  const settings = await readObject(ctx.settings, 'Claude Code user settings'); proxyEnvKeys(settings.value);
  const configAfter = { ...config.value, egressProxyUrl: proxy };
  const metaAfter = structuredClone(meta.value);
  const entry = { id: configId, name: 'Desktop Guard' };
  if (createdConfig) { metaAfter.appliedId = configId; metaAfter.entries = [...(metaAfter.entries || []), entry]; }
  const settingsAfter = structuredClone(settings.value); settingsAfter.env = { ...(settingsAfter.env || {}) };
  for (const key of PROXY_KEYS) settingsAfter.env[key] = proxy;
  for (const key of BYPASS_KEYS) settingsAfter.env[key] = LOOPBACK_BYPASS;
  const journal = {
    schema: 1, phase: 'planned', platform: ctx.platform, home: ctx.home, library: ctx.library,
    settingsPath: ctx.settings, configId, configPath, metaPath, createdConfig,
    config: { before: snapshot(config.value, 'egressProxyUrl'), installed: proxy, original: config.bytes?.toString('base64') ?? null, after: encode(configAfter).toString('base64') },
    meta: { beforeApplied: snapshot(meta.value, 'appliedId'), beforeEntries: snapshot(meta.value, 'entries'), addedEntry: createdConfig ? entry : null, original: meta.bytes?.toString('base64') ?? null, after: encode(metaAfter).toString('base64') },
    settings: { envBefore: { exists: own(settings.value, 'env') }, keys: Object.fromEntries([...PROXY_KEYS, ...BYPASS_KEYS].map(key => [key, { before: snapshot(settings.value.env || {}, key), installed: settingsAfter.env[key] }])), original: settings.bytes?.toString('base64') ?? null, after: encode(settingsAfter).toString('base64') }
  };
  const release = await acquireJournal(journalDir);
  try {
    const journalFile = path.join(journalDir, 'desktop-transaction.json');
    const old = await readObject(journalFile, 'Transaction journal', 32 * 1024 * 1024);
    if (old.bytes && old.value.phase !== 'restored') fail('RESTORE_REQUIRED', 'Restore the previous Desktop transaction before installing again.');
    // Durable complete plan, including original bytes, exists before the first configuration write.
    await atomicWrite(journalFile, encode(journal));
    await writeIfUnchanged(configPath, config.bytes, encode(configAfter));
    if (createdConfig) await writeIfUnchanged(metaPath, meta.bytes, encode(metaAfter));
    await writeIfUnchanged(ctx.settings, settings.bytes, encode(settingsAfter));
    journal.phase = 'installed'; await atomicWrite(journalFile, encode(journal));
    return { installed: true, restored: false, conflicts: [], journalDir };
  } finally { await release(); }
}

function validateJournal(journal) {
  if (journal.schema !== 1 || !['planned', 'installed', 'restored'].includes(journal.phase) || !['darwin', 'win32'].includes(journal.platform) || !validId(journal.configId) || !object(journal.config) || !object(journal.meta) || !object(journal.settings)) fail('MALFORMED_JOURNAL', 'The restore journal is malformed.');
  for (const field of ['home', 'library', 'settingsPath', 'configPath', 'metaPath']) if (typeof journal[field] !== 'string' || !path.isAbsolute(journal[field])) fail('MALFORMED_JOURNAL', 'Journal paths are malformed.');
  if (journal.settingsPath !== path.join(journal.home, '.claude', 'settings.json') || path.basename(journal.library) !== 'configLibrary' || path.basename(path.dirname(journal.library)) !== 'Claude-3p' || journal.configPath !== path.join(journal.library, `${journal.configId}.json`) || journal.metaPath !== path.join(journal.library, '_meta.json')) fail('MALFORMED_JOURNAL', 'Journal paths do not match the transaction.');
  if (journal.platform === 'darwin' && journal.library !== path.join(journal.home, 'Library', 'Application Support', 'Claude-3p', 'configLibrary')) fail('MALFORMED_JOURNAL', 'Journal library is outside the expected user configuration.');
  validateProxy(journal.config.installed);
  if (!object(journal.config.before) || !object(journal.meta.beforeApplied) || !object(journal.settings.keys)) fail('MALFORMED_JOURNAL', 'Journal snapshots are malformed.');
  for (const key of [...PROXY_KEYS, ...BYPASS_KEYS]) if (!object(journal.settings.keys[key]) || !object(journal.settings.keys[key].before)) fail('MALFORMED_JOURNAL', 'Journal proxy snapshots are malformed.');
  if (Object.keys(journal.settings.keys).some(key => ![...PROXY_KEYS, ...BYPASS_KEYS].includes(key))) fail('MALFORMED_JOURNAL', 'Journal contains unowned settings keys.');
}
async function restoreDesktopProxy(journalDir) {
  if (typeof journalDir !== 'string' || !path.isAbsolute(journalDir)) fail('UNSAFE_PATH', 'A private absolute journal directory is required.');
  const journalFile = path.join(journalDir, 'desktop-transaction.json');
  if (!(await readBytes(journalFile, 32 * 1024 * 1024))) return { installed: false, restored: true, conflicts: [] };
  const release = await acquireJournal(journalDir);
  try {
    const journal = (await readObject(journalFile, 'Transaction journal', 32 * 1024 * 1024)).value; validateJournal(journal);
    if (journal.phase === 'restored') return { installed: false, restored: true, conflicts: [] };
    const conflicts = [], conflict = code => conflicts.push({ code, message: 'Configuration changed since installation; the independent change was preserved.' });
    const meta = await readObject(journal.metaPath, 'Configuration index');
    let metaSafe = true;
    if (own(meta.value, 'hybridPointer')) { conflict('META_CHANGED'); metaSafe = false; }
    const metaAlreadyOriginal = matches(meta.value, 'appliedId', journal.meta.beforeApplied);
    if (!metaAlreadyOriginal && meta.value.appliedId !== journal.configId) { conflict('APPLIED_CONFIG_CHANGED'); metaSafe = false; }
    const config = await readObject(journal.configPath, 'Desktop configuration');
    if (journal.createdConfig) {
      if (config.bytes && !config.bytes.equals(Buffer.from(journal.config.after, 'base64'))) { conflict('CREATED_CONFIG_CHANGED'); metaSafe = false; }
      const currentEntry = Array.isArray(meta.value.entries) ? meta.value.entries.find(entry => entry?.id === journal.configId) : null;
      if (own(meta.value, 'entries') && !Array.isArray(meta.value.entries)) { conflict('META_ENTRIES_CHANGED'); metaSafe = false; }
      if (currentEntry && !isDeepStrictEqual(currentEntry, journal.meta.addedEntry)) { conflict('META_ENTRY_CHANGED'); metaSafe = false; }
      if (metaSafe) {
        if (!metaAlreadyOriginal || currentEntry) {
          putSnapshot(meta.value, 'appliedId', journal.meta.beforeApplied);
          if (Array.isArray(meta.value.entries)) meta.value.entries = meta.value.entries.filter(entry => entry?.id !== journal.configId);
          if (!journal.meta.beforeEntries.exists && Array.isArray(meta.value.entries) && !meta.value.entries.length) delete meta.value.entries;
          const original = journal.meta.original === null ? null : Buffer.from(journal.meta.original, 'base64');
          if (original !== null && isDeepStrictEqual(meta.value, parseObject(original, 'Original configuration index'))) await writeIfUnchanged(journal.metaPath, meta.bytes, original);
          else if (original === null && !Object.keys(meta.value).length) { await fs.unlink(journal.metaPath); await syncDirectory(path.dirname(journal.metaPath)); }
          else await writeIfUnchanged(journal.metaPath, meta.bytes, encode(meta.value));
        }
        if (config.bytes) { await fs.unlink(journal.configPath); await syncDirectory(path.dirname(journal.configPath)); }
      }
    } else if (metaSafe) {
      if (!config.bytes) conflict('CONFIG_MISSING');
      else if (matches(config.value, 'egressProxyUrl', journal.config.before)) { /* interrupted before write, or already restored */ }
      else if (config.value.egressProxyUrl !== journal.config.installed) conflict('PROXY_CHANGED');
      else {
        putSnapshot(config.value, 'egressProxyUrl', journal.config.before);
        const original = Buffer.from(journal.config.original, 'base64');
        await writeIfUnchanged(journal.configPath, config.bytes, isDeepStrictEqual(config.value, parseObject(original, 'Original Desktop configuration')) ? original : encode(config.value));
      }
    }
    const settings = await readObject(journal.settingsPath, 'Claude Code user settings');
    if (settings.bytes && own(settings.value, 'env') && !object(settings.value.env)) conflict('USER_ENV_CHANGED');
    else {
      let changed = false;
      const env = settings.value.env || {};
      for (const [key, saved] of Object.entries(journal.settings.keys)) {
        if (matches(env, key, saved.before)) continue;
        if (!own(env, key) || !isDeepStrictEqual(env[key], saved.installed)) { conflict(`USER_${key}_CHANGED`); continue; }
        putSnapshot(env, key, saved.before); changed = true;
      }
      if (changed) {
        if (Object.keys(env).length || journal.settings.envBefore.exists) settings.value.env = env; else delete settings.value.env;
        const original = journal.settings.original === null ? null : Buffer.from(journal.settings.original, 'base64');
        if (original !== null && isDeepStrictEqual(settings.value, parseObject(original, 'Original user settings'))) await writeIfUnchanged(journal.settingsPath, settings.bytes, original);
        else if (original === null && !Object.keys(settings.value).length) { await fs.unlink(journal.settingsPath); await syncDirectory(path.dirname(journal.settingsPath)); }
        else await writeIfUnchanged(journal.settingsPath, settings.bytes, encode(settings.value));
      }
    }
    if (!conflicts.length) { journal.phase = 'restored'; await atomicWrite(journalFile, encode(journal)); }
    return { installed: conflicts.length > 0, restored: conflicts.length === 0, conflicts };
  } finally { await release(); }
}

function buildLaunch({ desktop, proxyUrl, timezone, language, strictMac = false, env = process.env } = {}) {
  if (!object(desktop) || !['darwin', 'win32'].includes(desktop.platform) || typeof desktop.path !== 'string' || !path.isAbsolute(desktop.path)) fail('INVALID_DESKTOP', 'A verified Desktop executable is required.');
  if (!versionSupported(desktop.version)) fail('DESKTOP_VERSION', `Proxy pinning requires Desktop ${MIN_VERSION} or later.`);
  const proxy = validateProxy(proxyUrl);
  const launchEnv = { ...env };
  for (const key of Object.keys(launchEnv)) if (/^(http_proxy|https_proxy|all_proxy|no_proxy)$/i.test(key)) delete launchEnv[key];
  for (const key of PROXY_KEYS) launchEnv[key] = proxy;
  for (const key of BYPASS_KEYS) launchEnv[key] = LOOPBACK_BYPASS;
  if (timezone) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); } catch { fail('INVALID_TIMEZONE', 'Choose a valid IANA time zone.'); }
    launchEnv.TZ = timezone;
  }
  const args = [`--proxy-server=${proxy}`, '--proxy-bypass-list=<-loopback>', '--disable-quic'];
  if (language) {
    if (typeof language !== 'string' || !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(language)) fail('INVALID_LANGUAGE', 'Choose a valid language tag.');
    args.push(`--lang=${language}`); launchEnv.LANG = `${language.replace(/-/g, '_')}.UTF-8`;
  }
  if (strictMac) {
    if (desktop.platform !== 'darwin') fail('UNSUPPORTED_STRICT_MODE', 'Process sandbox launch is available only on macOS.');
    const port = Number(new URL(proxy).port);
    // Only a validated integer reaches the profile. No hostnames, executable paths, or user strings are embedded.
    const profile = `(version 1)\n(allow default)\n(deny network-outbound)\n(allow network-outbound (remote ip "localhost:${port}"))`;
    return { executable: '/usr/bin/sandbox-exec', args: ['-p', profile, desktop.path, ...args], env: launchEnv };
  }
  return { executable: desktop.path, args, env: launchEnv };
}
async function launchDesktop(options = {}) {
  const launch = buildLaunch(options);
  if (await isDesktopRunning({ platform: options.desktop.platform, home: options.home || os.homedir(), env: options.env || process.env })) fail('DESKTOP_RUNNING', 'Quit Claude Desktop completely before launching through the guard.');
  const stat = await statOrNull(options.desktop.path);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail('INVALID_DESKTOP', 'Desktop executable must be a regular file.');
  return new Promise((resolve, reject) => {
    let child;
    try { child = childProcess.spawn(launch.executable, launch.args, { env: launch.env, shell: false, windowsHide: true, stdio: 'ignore', detached: false }); }
    catch { const error = new Error('Claude Desktop could not be started.'); error.code = 'DESKTOP_LAUNCH_FAILED'; reject(error); return; }
    let settled = false, readyTimer;
    const spawnTimer = setTimeout(() => {
      const error = new Error('Claude Desktop did not report a successful process start.'); error.code = 'DESKTOP_LAUNCH_TIMEOUT';
      settle(error); child.kill();
    }, 10000);
    function settle(error) {
      if (settled) return;
      settled = true; clearTimeout(spawnTimer); clearTimeout(readyTimer);
      child.removeListener('spawn', onSpawn); child.removeListener('exit', onEarlyExit);
      if (error) reject(error); else resolve(child);
    }
    function onSpawn() {
      clearTimeout(spawnTimer);
      // A parsed sandbox profile and successful spawn do not prove the app stayed alive.
      // Immediate startup errors (including Seatbelt failures) must reach orchestration.
      readyTimer = setTimeout(() => settle(), 750);
    }
    function onEarlyExit(code, signal) {
      const error = new Error(`Claude Desktop exited before startup completed${signal ? ` (${signal})` : ` (exit ${code})`}.`);
      error.code = 'DESKTOP_EXITED_EARLY'; settle(error);
    }
    // Retain this listener after readiness. Later process errors must not crash Guard;
    // orchestration may additionally subscribe to this same event for status updates.
    child.on('error', () => {
      const error = new Error('Claude Desktop process launch failed.'); error.code = 'DESKTOP_LAUNCH_FAILED'; settle(error);
    });
    child.once('spawn', onSpawn); child.once('exit', onEarlyExit);
  });
}

module.exports = { discoverDesktop, isDesktopRunning, readDesktopAudit, installDesktopProxy, restoreDesktopProxy, launchDesktop, MIN_VERSION, versionSupported, buildLaunch };
