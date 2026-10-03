'use strict';
const $ = id => document.getElementById(id);
let state; let pending = false;
const fields = ['proxy-url','controller-url','controller-secret','selector','expected-leaf','strict-mac'];
function input() {
  return { profile: { proxyUrl: $('proxy-url').value.trim(), expectedIp: state?.profile?.expectedIp || '',
    expectedCountry: state?.profile?.expectedCountry || '', strictMac: $('strict-mac').checked,
    mihomo: { controllerUrl: $('controller-url').value.trim(), selector: $('selector').value.trim(), expectedLeaf: $('expected-leaf').value.trim() } },
    controllerSecret: $('controller-secret').value };
}
function hydrated(profile) {
  if (!profile) return;
  $('proxy-url').value = profile.proxyUrl;
  $('controller-url').value = profile.mihomo?.controllerUrl || '';
  $('selector').value = profile.mihomo?.selector || '';
  $('expected-leaf').value = profile.mihomo?.expectedLeaf || '';
  $('strict-mac').checked = profile.strictMac;
  $('mihomo-options').open = Boolean(profile.mihomo?.controllerUrl);
}
function sameProxy(a,b) { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } }
function render(next) {
  state = next;
  const active = Boolean(state.gate);
  const busy = pending || state.busy;
  const labels = { idle:'Не запущен', checking:'Проверяем выход', starting:'Запускаем', active:'Прокси проверен', locked:'Туннели закрыты' };
  $('status').className = `status ${state.phase}`;
  $('status').querySelector('span').textContent = labels[state.phase] || state.phase;
  $('desktop-info').textContent = state.desktop ? `Claude Desktop ${state.desktop.version || ''}` : 'Claude Desktop не найден';
  $('error').hidden = !state.reason; $('error').textContent = state.reason || '';
  $('pinned-ip').textContent = state.profile?.expectedIp || 'Не выбран';
  $('pinned-country').textContent = state.profile?.expectedCountry || 'Не выбрана';
  $('health-label').textContent = state.phase === 'locked' ? 'Заблокирован' : state.gate?.healthy ? 'Выход совпадает' : state.profile?.expectedIp ? 'Нужен запуск' : 'Ожидает выбора';
  $('local-address').textContent = state.gate?.localProxyUrl || 'Ожидает запуска';
  $('exit-summary').textContent = state.profile?.expectedIp || 'Выход ещё не выбран';
  $('system-timezone').textContent = state.environment.timezone;
  $('exit-timezone').textContent = state.probe?.timezone || '—';
  const checked = state.gate?.verifiedAt || state.probe?.observedAt;
  $('checked-at').textContent = checked ? new Date(checked).toLocaleTimeString() : '—';
  $('sandbox-option').hidden = state.environment.platform !== 'darwin';
  const showProbe = state.probe && sameProxy(state.probe.proxyUrl, $('proxy-url').value);
  $('probe-result').hidden = !showProbe;
  if (showProbe) {
    $('probe-ip').textContent = state.probe.ip;
    $('probe-country').textContent = `Страна ${state.probe.country}${state.probe.binding?.leaf ? ` / ${state.probe.binding.leaf}` : ''}`;
  }
  fields.forEach(id => $(id).disabled = busy || active);
  $('probe-button').disabled = busy || active || !$('proxy-url').value.trim();
  $('pin-button').disabled = busy || active;
  $('start-button').hidden = active;
  $('start-button').disabled = busy || !state.desktop || state.transaction || !state.profile?.expectedIp || !sameProxy(state.profile.proxyUrl, $('proxy-url').value);
  $('stop-button').hidden = !active; $('stop-button').disabled = busy;
  $('restore-button').hidden = !state.transaction; $('restore-button').disabled = busy || active;
  $('transaction-note').hidden = !state.transaction;
  const findings = $('findings'); findings.replaceChildren();
  for (const item of state.findings) { const li = document.createElement('li'); li.dataset.severity = item.severity; li.textContent = item.message; findings.append(li); }
  const history = $('history'); history.replaceChildren();
  for (const item of state.history) { const li = document.createElement('li'); const time = document.createElement('time'); time.textContent = new Date(item.time).toLocaleTimeString(); li.append(time, document.createTextNode(item.message)); history.append(li); }
}
async function perform(command) {
  pending = true; render(state);
  let failure = '';
  try { await window.guard[command](input()); }
  catch(e) { failure = e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
  finally {
    pending = false;
    const latest = await window.guard.snapshot();
    if (failure) latest.reason = failure;
    render(latest);
  }
}
for (const command of ['probe','pin','start','stop','restore']) $(command + '-button').addEventListener('click', () => perform(command));
fields.forEach(id => $(id).addEventListener('input', () => render(state)));
window.guard.onState(render);
window.guard.snapshot().then(initial => { hydrated(initial.profile); render(initial); });
