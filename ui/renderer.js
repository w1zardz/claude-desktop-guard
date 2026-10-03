'use strict';
const $ = id => document.getElementById(id);
let state; let pending = false; let hydratedVpn = '';
const fields = ['route-mode','vpn-interface','proxy-url','controller-url','controller-secret','selector','expected-leaf','strict-mac','client-mask-enabled','mask-timezone','mask-language','mask-region'];
function canonicalUrl(value) {
  const url = new URL(value);
  if (url.hostname.toLowerCase() === 'localhost') url.hostname = '127.0.0.1';
  return url.origin;
}
function identity(profile) {
  try {
    const mode = profile.mode || 'proxy';
    const route = mode === 'amnezia' ? [profile.vpnInterface.name, profile.vpnInterface.index, profile.vpnInterface.address] : canonicalUrl(profile.proxyUrl);
    const mihomo = profile.mihomo || {};
    return JSON.stringify([mode, route, [mihomo.controllerUrl ? canonicalUrl(mihomo.controllerUrl) : '', mihomo.selector || '', mihomo.expectedLeaf || '']]);
  } catch { return null; }
}
function input() {
  const mode = $('route-mode').value;
  let vpnInterface;
  try { vpnInterface = JSON.parse($('vpn-interface').value); } catch { vpnInterface = null; }
  const chosen = { mode, ...(mode === 'amnezia' ? { vpnInterface } : { proxyUrl: $('proxy-url').value.trim() }), strictMac: $('strict-mac').checked,
    mihomo: mode === 'amnezia' ? {} : { controllerUrl: $('controller-url').value.trim(), selector: $('selector').value.trim(), expectedLeaf: $('expected-leaf').value.trim() },
    clientMask: $('client-mask-enabled').checked ? { enabled: true, timezone: $('mask-timezone').value.trim(), language: $('mask-language').value.trim(), region: $('mask-region').value.trim().toUpperCase() } : { enabled: false } };
  const same = state?.profile && identity(chosen) && identity(chosen) === (state.profile.pinIdentity || identity(state.profile));
  return { profile: { ...chosen, expectedIp: same ? state.profile.expectedIp : '', expectedCountry: same ? state.profile.expectedCountry : '',
    pinIdentity: same ? state.profile.pinIdentity : undefined },
    controllerSecret: mode === 'amnezia' ? '' : $('controller-secret').value };
}
function hydrated(profile) {
  if (!profile) return;
  $('route-mode').value = profile.mode || 'proxy';
  $('proxy-url').value = profile.proxyUrl || '';
  hydratedVpn = profile.vpnInterface ? JSON.stringify(profile.vpnInterface) : '';
  $('controller-url').value = profile.mihomo?.controllerUrl || '';
  $('selector').value = profile.mihomo?.selector || '';
  $('expected-leaf').value = profile.mihomo?.expectedLeaf || '';
  $('strict-mac').checked = profile.strictMac;
  $('client-mask-enabled').checked = profile.clientMask?.enabled === true;
  $('mask-timezone').value = profile.clientMask?.timezone || '';
  $('mask-language').value = profile.clientMask?.language || '';
  $('mask-region').value = profile.clientMask?.region || '';
  $('mihomo-options').open = Boolean(profile.mihomo?.controllerUrl);
}
function checkedExit() {
  if (state?.gate?.healthy) return state.gate;
  const probe = state?.probe, observed = new Date(probe?.observedAt).getTime();
  if (probe?.routingIdentity === identity(input().profile) && Number.isFinite(observed) && observed <= Date.now() && Date.now() - observed <= 120000) return probe;
  return null;
}
function maskValid() {
  const enabled = $('client-mask-enabled').checked;
  const timezone = $('mask-timezone').value.trim(), language = $('mask-language').value.trim(), region = $('mask-region').value.trim().toUpperCase();
  let timeValid = !enabled, languageValid = !enabled, regionValid = !enabled;
  if (enabled) {
    try { timeValid = /^[A-Za-z0-9_+./-]{1,100}$/.test(timezone) && Boolean(new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone); } catch { timeValid = false; }
    try { languageValid = language.length <= 100 && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language) && Boolean(Intl.getCanonicalLocales(language)[0]); } catch { languageValid = false; }
    regionValid = /^[A-Z]{2}$/.test(region);
  }
  $('mask-timezone').setAttribute('aria-invalid', String(!timeValid));
  $('mask-language').setAttribute('aria-invalid', String(!languageValid));
  $('mask-region').setAttribute('aria-invalid', String(!regionValid));
  const valid = timeValid && languageValid && regionValid;
  $('mask-error').hidden = valid;
  $('mask-error').textContent = valid ? '' : 'Укажите действительный IANA-часовой пояс, BCP47-язык и двухбуквенную страну Claude.';
  return valid;
}
function maskStatus() {
  const applied = state.clientMask;
  const requested = applied?.requested || input().profile.clientMask;
  const enabled = applied?.status === 'disabled' ? false : applied?.requested ? applied.requested.enabled !== false : requested.enabled === true;
  $('requested-timezone').textContent = enabled ? requested.timezone || 'Не задан' : 'Выключено';
  $('requested-language').textContent = enabled ? requested.language || 'Не задан' : 'Выключено';
  $('requested-region').textContent = enabled ? requested.region || 'Не задана' : 'Выключено';
  if (applied?.measured) {
    const measured = applied.measured;
    $('client-mask-status').textContent = `Измерено внутри приложения: часовой пояс ${measured.timezone || '—'}, язык ${measured.language || '—'}, страна ${measured.region || '—'}.`;
  } else if (applied?.status === 'applied') $('client-mask-status').textContent = applied.nativeLocaleApplied === false
    ? 'TZ и язык Chromium переданы. Запасные языки и регион ОС Windows сохранены. Автоматическая проверка значений внутри Claude не выполняется.'
    : 'Параметры переданы; значения внутри Claude автоматически не измеряются.';
  else $('client-mask-status').textContent = enabled ? 'Ожидает запуска; значения внутри приложения не измерены.' : 'Выключено';
}
function interfaceOptions(items) {
  const select = $('vpn-interface');
  const selected = hydratedVpn || select.value; hydratedVpn = '';
  select.replaceChildren();
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Выберите интерфейс явно'; select.append(placeholder);
  for (const item of items) {
    const option = document.createElement('option'); option.value = JSON.stringify(item);
    option.textContent = `${item.name} · индекс ${item.index} · ${item.address}`; select.append(option);
  }
  if (selected && ![...select.options].some(option => option.value === selected)) {
    const missing = document.createElement('option'); missing.value = selected; missing.disabled = true;
    missing.textContent = 'Сохранённый интерфейс недоступен — выберите заново'; select.append(missing);
  }
  select.value = selected;
}
function render(next) {
  state = next;
  const active = Boolean(state.gate), busy = pending || state.busy;
  interfaceOptions(state.vpnInterfaces || []);
  const amnezia = $('route-mode').value === 'amnezia';
  const profile = input().profile, currentIdentity = identity(profile);
  const selectedAvailable = !amnezia || (state.vpnInterfaces || []).some(item => JSON.stringify(item) === $('vpn-interface').value);
  const pinnedMatches = Boolean(state.profile?.expectedIp && currentIdentity && currentIdentity === (state.profile.pinIdentity || identity(state.profile)));
  const labels = { idle:'Не запущен', checking:'Проверяем выход', starting:'Запускаем', active:'Выход проверен', locked:'Туннели закрыты' };
  $('status').className = `status ${state.phase}`;
  $('status').querySelector('span').textContent = labels[state.phase] || state.phase;
  $('desktop-info').textContent = state.desktop ? `Claude Desktop ${state.desktop.version || ''}` : 'Claude Desktop не найден';
  $('error').hidden = !state.reason; $('error').textContent = state.reason || '';
  $('proxy-options').hidden = amnezia; $('amnezia-options').hidden = !amnezia; $('mihomo-options').hidden = amnezia;
  $('exit-title').textContent = amnezia ? 'Amnezia VPN' : 'Ваш прокси';
  $('interfaces-error').hidden = !state.interfacesError; $('interfaces-error').textContent = state.interfacesError || '';
  $('route-changed').hidden = !state.profile?.expectedIp || pinnedMatches;
  $('pinned-ip').textContent = state.profile?.expectedIp || 'Не выбран';
  $('pinned-country').textContent = state.profile?.expectedCountry || 'Не выбрана';
  $('health-label').textContent = state.phase === 'locked' ? 'Заблокирован' : state.gate?.healthy ? 'Выход совпадает' : pinnedMatches ? 'Нужен запуск' : 'Ожидает выбора';
  $('local-address').textContent = state.gate?.localProxyUrl || 'Ожидает запуска';
  $('exit-summary').textContent = amnezia && profile.vpnInterface ? `${profile.vpnInterface.name} / ${profile.vpnInterface.address}` : state.profile?.expectedIp || 'Выход ещё не выбран';
  $('system-timezone').textContent = state.environment.timezone;
  $('exit-timezone').textContent = state.gate?.timezone || state.probe?.timezone || '—';
  const checked = state.gate?.verifiedAt || state.probe?.observedAt;
  $('checked-at').textContent = checked ? new Date(checked).toLocaleTimeString() : '—';
  $('sandbox-option').hidden = state.environment.platform !== 'darwin';
  const showProbe = state.probe && currentIdentity && state.probe.routingIdentity === currentIdentity;
  $('probe-result').hidden = !showProbe;
  if (showProbe) {
    $('probe-ip').textContent = state.probe.ip;
    $('probe-country').textContent = `Страна ${state.probe.country}${state.probe.binding?.leaf ? ` / ${state.probe.binding.leaf}` : ''}`;
  }
  fields.forEach(id => $(id).disabled = busy || active);
  const enabledMask = $('client-mask-enabled').checked, validMask = maskValid();
  $('client-mask-options').hidden = !enabledMask;
  for (const id of ['mask-timezone','mask-language','mask-region']) $(id).disabled = busy || active || !enabledMask;
  const measuredExit = checkedExit();
  $('mask-copy-button').disabled = busy || active || !enabledMask || !measuredExit?.timezone || !measuredExit?.country;
  maskStatus();
  $('interfaces-button').disabled = busy || active;
  $('probe-button').disabled = busy || active || !currentIdentity || !selectedAvailable;
  $('pin-button').disabled = busy || active || !showProbe || !selectedAvailable || !validMask || (enabledMask && profile.clientMask.region !== state.probe?.country);
  $('start-button').hidden = active;
  $('start-button').disabled = busy || !state.desktop || state.transaction || !pinnedMatches || !selectedAvailable || !validMask || (enabledMask && profile.clientMask.region !== state.profile?.expectedCountry);
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
for (const command of ['probe','pin','start','stop','restore','interfaces']) $(command + '-button').addEventListener('click', () => perform(command));
$('mask-copy-button').addEventListener('click', () => {
  const exit = checkedExit();
  if (!exit?.timezone || !exit?.country || !$('client-mask-enabled').checked || pending || state.busy || state.gate) return;
  $('mask-timezone').value = exit.timezone; $('mask-region').value = exit.country;
  render(state);
});
fields.forEach(id => $(id).addEventListener('input', () => render(state)));
window.guard.onState(render);
window.guard.snapshot().then(initial => { hydrated(initial.profile); render(initial); });
