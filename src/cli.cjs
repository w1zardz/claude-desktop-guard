'use strict';

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { GuardGate, probeExit, validateProxyUrl } = require('./network.cjs');
const { readProfile, validateProfile, routingIdentity } = require('./profile.cjs');
const { verifyBinding } = require('./mihomo.cjs');

const FAILURE_CODE = 78;
const FAILURE_MARKER = '[Claude Desktop Guard]';

function parseCliArgs(argv) {
  const index = argv.indexOf('--guard-cli');
  if (index < 0 || argv[index + 1] !== '--claude-executable' || argv[index + 3] !== '--') {
    throw new Error('Запуск: --guard-cli --claude-executable <абсолютный путь> -- <аргументы Claude>.');
  }
  const executable = argv[index + 2];
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || executable.includes('\0')) {
    throw new Error('Укажите абсолютный путь к исполняемому файлу Claude CLI.');
  }
  const args = argv.slice(index + 4);
  if (args.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('Некорректные аргументы Claude CLI.');
  if (args.some(value => /^--(?:settings|setting-sources)(?:=|$)/.test(value))) throw new Error('Guard владеет --settings и --setting-sources. Уберите переопределение маршрута из аргументов.');
  return { executable, args };
}

async function verifyExecutable(executable, platform) {
  const info = await fs.stat(executable);
  if (!info.isFile()) throw new Error('Claude CLI должен быть исполняемым файлом.');
  await fs.access(executable, platform === 'win32' ? constants.F_OK : constants.X_OK);
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) throw new Error('Для запуска без оболочки выберите нативный claude.exe.');
}

function buildCliLaunch({ executable, args, proxyUrl, profile, env = process.env, platform = process.platform }) {
  const proxy = validateProxyUrl(proxyUrl);
  const checked = validateProfile(profile, { requirePin: true });
  if (!checked.clientMask.enabled) throw new Error('Включите и сохраните часовой пояс, язык и страну в Guard.');
  if (Object.entries(env).some(([key, value]) => /^(node_options|electron_run_as_node)$/i.test(key) && value)) throw new Error('Уберите NODE_OPTIONS и ELECTRON_RUN_AS_NODE: внедрение кода в CLI несовместимо с проверенным запуском.');
  if (Object.entries(env).some(([key, value]) => /^node_tls_reject_unauthorized$/i.test(key) && value !== undefined && value !== '1')) throw new Error('Проверка TLS должна оставаться включённой. Уберите NODE_TLS_REJECT_UNAUTHORIZED.');
  const launchEnv = { ...env };
  for (const key of Object.keys(launchEnv)) if (/^(http_proxy|https_proxy|all_proxy|no_proxy|tz|lang|lc_all|disable_error_reporting|claude_code_proxy_resolves_hosts)$/i.test(key)) delete launchEnv[key];
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) launchEnv[key] = proxy;
  for (const key of ['NO_PROXY', 'no_proxy']) launchEnv[key] = 'localhost,127.0.0.1,::1';
  launchEnv.TZ = checked.clientMask.timezone;
  launchEnv.LANG = `${checked.clientMask.language.replace(/-/g, '_')}.UTF-8`;
  launchEnv.LC_ALL = launchEnv.LANG;
  launchEnv.DISABLE_ERROR_REPORTING = '1';
  launchEnv.NODE_TLS_REJECT_UNAUTHORIZED = '1';
  launchEnv.NODE_OPTIONS = '';
  launchEnv.ELECTRON_RUN_AS_NODE = '';
  launchEnv.CLAUDE_CODE_PROXY_RESOLVES_HOSTS = '1';
  // Inline settings outrank user/project settings.env. Managed policy is
  // checked separately and cannot be bypassed by this launch argument.
  const ownedKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy', 'TZ', 'LANG', 'LC_ALL', 'DISABLE_ERROR_REPORTING', 'CLAUDE_CODE_PROXY_RESOLVES_HOSTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'];
  const ownedSettings = JSON.stringify({ env: Object.fromEntries(ownedKeys.map(key => [key, launchEnv[key]])) });
  const cliArgs = ['--settings', ownedSettings, ...args];
  if (checked.strictMac) {
    if (platform !== 'darwin') throw new Error('Строгий сетевой режим доступен только на macOS.');
    const port = Number(new URL(proxy).port);
    if (new URL(proxy).hostname !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Строгий режим требует локальный барьер Guard.');
    const sandbox = `(version 1)\n(allow default)\n(deny network-outbound)\n(allow network-outbound (remote ip "localhost:${port}"))`;
    return { executable: '/usr/bin/sandbox-exec', args: ['-p', sandbox, executable, ...cliArgs], env: launchEnv };
  }
  return { executable, args: cliArgs, env: launchEnv };
}

function signalCode(signal) { return 128 + (os.constants.signals[signal] || 1); }

function createCliStdin({ platform = process.platform, inherited = process.stdin,
  createReadStream = require('node:fs').createReadStream } = {}) {
  // Electron replaces process.stdin with an EOF-only Readable on Windows.
  // Read the inherited descriptor directly; keep it paused until verified spawn.
  if (platform !== 'win32') return inherited;
  return createReadStream(null, { fd: 0, autoClose: false });
}

async function signalOwnedChild(child, signal, { platform = process.platform, killProcess = process.kill, spawnCommand = spawn } = {}) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) return child.kill(signal);
  if (platform !== 'win32') {
    try { killProcess(-child.pid, signal); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  }
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error('Не найден системный каталог Windows для завершения дочерних процессов.');
  const executable = path.win32.join(systemRoot, 'System32', 'taskkill.exe');
  // Console processes require /F. /T includes their currently owned descendants;
  // no command shell or broad image-name matching is involved.
  return new Promise((resolve, reject) => {
    const command = spawnCommand(executable, ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => { command.kill(); finish(new Error('Завершение дерева CLI в Windows не подтверждено.')); }, 1000);
    command.on('error', error => finish(error));
    command.once('close', code => finish(code === 0 ? null : new Error('Windows не подтвердила завершение дерева CLI.'), code === 0));
  });
}

async function inspectMacGroup(pid) {
  return new Promise((resolve, reject) => execFile('/bin/ps', ['-g', String(pid), '-o', 'pid=,pgid=,stat='],
    { timeout: 500, maxBuffer: 65536, encoding: 'utf8' }, (error, stdout) => {
      if (error && !(error.code === 1 && !stdout.trim())) return reject(error);
      try {
        const states = stdout.trim().split('\n').filter(Boolean).map(line => {
          const values = line.trim().split(/\s+/);
          if (values.length !== 3 || !/^\d+$/.test(values[0]) || Number(values[1]) !== pid || !/^[A-Za-z+<>]+$/.test(values[2])) throw new Error('Не удалось подтвердить состояние группы CLI.');
          return values[2];
        });
        resolve(states);
      } catch (error) { reject(error); }
    }));
}

async function ownedGroupAlive(child, childDone, platform, { killProcess = process.kill, inspectGroup = inspectMacGroup } = {}) {
  if (platform === 'win32' || !Number.isSafeInteger(child.pid) || child.pid < 1) return !childDone;
  try { killProcess(-child.pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    // Older libuv/macOS can report EPERM while an orphan group is being reaped.
    // A bounded native snapshot distinguishes terminal zombies/empty groups
    // from a denied live process. Live/unknown groups remain cleanup failures.
    if (platform === 'darwin' && childDone && error.code === 'EPERM') {
      const states = await inspectGroup(child.pid);
      if (!states.some(state => !/^[ZX]/.test(state))) return false;
    }
    throw error;
  }
}

async function runGuardedCli({ argv, dataDir, env = process.env, platform = process.platform,
  stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, signals = process,
  loadProfile = readProfile, validateExecutable = verifyExecutable, spawnChild = spawn,
  Gate = GuardGate, probe = probeExit, binding = verifyBinding, amnezia, auditPolicy,
  killDelayMs = 1500, signalTree = signalOwnedChild } = {}) {
  const api = amnezia || require('./amnezia.cjs');
  const policy = auditPolicy || (context => require('./desktop.cjs').auditCliPolicy(context));
  const controller = new AbortController();
  let cancelled;
  let code = FAILURE_CODE;
  let helper, gate, child, childDone, armed = false, finishing = false;
  let helperClosed = false, stoppingTree;
  let notifyChild, notifyExit;
  const childClosed = new Promise(resolve => { notifyChild = resolve; });
  const childExited = new Promise(resolve => { notifyExit = resolve; });
  const stopTree = signal => {
    const operation = Promise.resolve().then(() => signalTree(child, signal, { platform })).catch(error => {
      cancelled ||= new Error(`Завершение дочерних процессов CLI не подтверждено: ${error.message}`);
      code = FAILURE_CODE;
      // Keep the local gate closed even if the platform tree operation fails.
      if (!childDone) { try { child.kill(signal); } catch {} }
    });
    return operation;
  };
  const assertActive = () => {
    if (cancelled || controller.signal.aborted) throw cancelled || new Error('Запуск CLI отменён.');
    if (helper && (helperClosed || helper.alive === false)) throw new Error('Amnezia-помощник остановлен. Прямой маршрут запрещён.');
  };
  const cancel = (error, exitCode = FAILURE_CODE) => {
    if (finishing || cancelled) return;
    cancelled = error;
    code = exitCode;
    controller.abort();
    gate?.lock(error.message);
    if (child) stoppingTree = stopTree('SIGTERM');
  };
  const onSigint = () => cancel(new Error('Запуск CLI остановлен сигналом SIGINT.'), signalCode('SIGINT'));
  const onSigterm = () => cancel(new Error('Запуск CLI остановлен сигналом SIGTERM.'), signalCode('SIGTERM'));
  const ioError = error => cancel(new Error(`Поток CLI закрыт: ${error.code || error.message}`));
  const inputError = error => {
    // Auth/update commands may deliberately close stdin before exiting. Their
    // status still belongs to the child; parent read/output errors stay fatal.
    if (['EPIPE', 'ECONNRESET'].includes(error.code)) { stdin.unpipe(child?.stdin); child?.stdin.destroy(); return; }
    if (!childDone) ioError(error);
  };
  const ioStreams = [stdin, stdout, stderr];
  ioStreams.forEach(stream => stream.on('error', ioError));
  signals.on('SIGINT', onSigint); signals.on('SIGTERM', onSigterm);

  try {
    const input = parseCliArgs(argv);
    await validateExecutable(input.executable, platform);
    assertActive();
    const profile = validateProfile(await loadProfile(path.join(dataDir, 'profile.json')), { requirePin: true });
    if (profile.pinIdentity !== routingIdentity(profile)) throw new Error('Сначала проверьте и явно закрепите выбранный маршрут в Guard.');
    if (!profile.clientMask.enabled) throw new Error('Включите и сохраните часовой пояс, язык и страну в Guard.');
    // Validate dangerous runtime inputs before any helper/network activity.
    buildCliLaunch({ ...input, proxyUrl: 'http://127.0.0.1:1', profile, env, platform });
    const findings = await policy({ platform, env });
    if (!Array.isArray(findings) || findings.length) throw new Error('Управляемая политика Claude CLI может переопределить маршрут, часовой пояс или язык. Обратитесь к администратору.');
    assertActive();
    let proxyUrl = profile.proxyUrl;
    if (profile.mode === 'amnezia') {
      const interfaces = await api.listInterfaces({ signal: controller.signal });
      assertActive();
      const selected = profile.vpnInterface;
      if (!interfaces.some(item => item.name === selected.name && item.index === selected.index && item.address === selected.address)) {
        throw new Error('Выбранный VPN-интерфейс исчез или изменился. Выберите и закрепите его заново в Guard.');
      }
      helper = await api.openAmnezia(selected, { signal: controller.signal });
      const died = () => cancel(new Error('Amnezia-помощник остановлен. Прямой маршрут запрещён.'));
      helper.on('exit', died); helper.on('error', died);
      assertActive();
      proxyUrl = helper.proxyUrl;
    }
    const check = async (_url, options = {}) => {
      assertActive();
      const currentPolicy = await policy({ platform, env });
      assertActive();
      if (!Array.isArray(currentPolicy) || currentPolicy.length) throw new Error('Управляемая политика CLI изменилась. Проверенный запуск остановлен.');
      if (profile.mode === 'proxy') await binding(profile.mihomo, '');
      assertActive();
      const result = await probe(proxyUrl, options);
      assertActive();
      if (profile.mode === 'amnezia' && net.isIP(result.ip) !== 4) throw new Error('Режим Amnezia требует проверенный IPv4-выход.');
      let zone;
      try { zone = result.timezone && new Intl.DateTimeFormat('en', { timeZone: result.timezone }).resolvedOptions().timeZone; } catch {}
      if (!zone || zone !== profile.clientMask.timezone) throw new Error('Часовой пояс профиля не совпадает с проверенным выходом. Выберите пояс выхода в Guard.');
      return result;
    };
    gate = new Gate({ proxyUrl, expectedIp: profile.expectedIp, expectedCountry: profile.expectedCountry, probe: check });
    gate.on('locked', () => { if (armed) cancel(new Error(`Барьер CLI заблокирован: ${gate.status().reason}`)); });
    const localProxy = await gate.start();
    armed = true;
    assertActive();
    if (!gate.status().healthy || gate.status().locked) throw new Error('Выход перестал проходить проверку до запуска CLI.');
    const launch = buildCliLaunch({ ...input, proxyUrl: localProxy, profile, env, platform });
    assertActive();
    child = spawnChild(launch.executable, launch.args, { env: launch.env, shell: false, windowsHide: true,
      detached: platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('error', error => {
      cancel(new Error(`Claude CLI не запущен: ${error.message}`));
      childDone = true; notifyChild(); notifyExit();
    });
    child.once('exit', (exitCode, signal) => {
      childDone = true;
      if (!cancelled) code = Number.isInteger(exitCode) ? exitCode : signalCode(signal);
      notifyExit();
    });
    child.once('close', () => { childDone = true; notifyChild(); });
    child.stdin.on('error', inputError);
    [child.stdout, child.stderr].forEach(stream => stream.on('error', ioError));
    // A helper or gate may lock synchronously inside an injected/native spawn.
    assertActive();
    if (!gate.status().healthy || gate.status().locked) throw new Error('Выход перестал проходить проверку при запуске CLI.');
    child.stdout.pipe(stdout, { end: false });
    child.stderr.pipe(stderr, { end: false });
    stdin.pipe(child.stdin);
    await Promise.race([childExited, childClosed, new Promise(resolve => {
      if (controller.signal.aborted) return resolve();
      controller.signal.addEventListener('abort', resolve, { once: true });
    })]);
    // Allow ordinary output to drain, but do not wait forever for inherited
    // pipe handles retained by a descendant after the owned child exits.
    if (childDone && !cancelled) {
      let timer;
      await Promise.race([childClosed, new Promise(resolve => { timer = setTimeout(resolve, 500); })]);
      clearTimeout(timer);
    }
  } catch (error) {
    cancel(error);
  } finally {
    finishing = true;
    armed = false;
    controller.abort();
    stdin.unpipe(child?.stdin);
    // Close the route while terminating the CLI group; helper cleanup and the
    // child grace period run concurrently instead of extending cancellation.
    const routeCleanup = Promise.allSettled([gate?.stop(), helper?.close().finally(() => { helperClosed = true; })]);
    if (child) {
      if (stoppingTree) await stoppingTree;
      else if (platform !== 'win32' || !childDone) await stopTree('SIGTERM');
      const deadline = Date.now() + killDelayMs;
      try {
        while (await ownedGroupAlive(child, childDone, platform) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(25, killDelayMs)));
        if (await ownedGroupAlive(child, childDone, platform)) {
          await stopTree('SIGKILL');
          let timer;
          await Promise.race([childClosed, new Promise(resolve => { timer = setTimeout(resolve, 500); })]);
          clearTimeout(timer);
        }
      } catch (error) { cancelled ||= error; code = FAILURE_CODE; }
    }
    child?.stdin.destroy();
    child?.stdout.unpipe(stdout); child?.stderr.unpipe(stderr);
    child?.stdout.destroy(); child?.stderr.destroy();
    await routeCleanup;
    if (cancelled && !stderr.destroyed && !stderr.writableEnded) {
      await new Promise(resolve => {
        let timer;
        try {
          timer = setTimeout(resolve, 500);
          stderr.write(`\n${FAILURE_MARKER} ${cancelled.message}\n`, () => { clearTimeout(timer); resolve(); });
        } catch { clearTimeout(timer); resolve(); }
      });
    }
    // Flush queued stream error events before removing their owning listeners.
    await new Promise(resolve => setImmediate(resolve));
    ioStreams.forEach(stream => stream.removeListener('error', ioError));
    signals.removeListener('SIGINT', onSigint); signals.removeListener('SIGTERM', onSigterm);
  }
  return code;
}

function writeHandshake(stdout, version) {
  return new Promise(resolve => {
    const failed = () => resolve(FAILURE_CODE);
    stdout.on('error', failed);
    try {
      stdout.write(`${JSON.stringify({ version, headlessCli: true })}\n`, error => {
        setImmediate(() => { stdout.removeListener('error', failed); resolve(error ? FAILURE_CODE : 0); });
      });
    } catch { stdout.removeListener('error', failed); resolve(FAILURE_CODE); }
  });
}

module.exports = { parseCliArgs, buildCliLaunch, runGuardedCli, writeHandshake, signalOwnedChild, createCliStdin, ownedGroupAlive, FAILURE_CODE, FAILURE_MARKER };
