'use strict';
const $ = (id) => document.getElementById(id),
  key = location.hash.slice(1),
  selection = new Set();
let hardStopping = false;
let state = null,
  step = 'launch',
  busy = false,
  timer = null,
  notificationKey = '',
  dismissed = '',
  packageStamp = '',
  requestId = null,
  finishedAttempt = '',
  setupStamp = '',
  resultStamp = '',
  pendingSetup = null,
  logFollow = true,
  logWriting = false,
  backendNotice = '';
const startupSelection = new Set();
let startupStamp = '';
try {
  for (const id of JSON.parse(
    (localStorage.getItem('iz2s.startupModules') ?? localStorage.getItem('iz15.startupModules')) || '[]',
  ))
    startupSelection.add(id);
} catch {}
function saveStartup() {
  localStorage.setItem(
    'iz2s.startupModules',
    JSON.stringify([...startupSelection]),
  );
  localStorage.setItem(
    'iz2s.startupEnabled',
    $('preload-enabled').checked ? '1' : '0',
  );
}
try {
  $('preload-enabled').checked =
    (localStorage.getItem('iz2s.startupEnabled') ?? localStorage.getItem('iz15.startupEnabled')) === '1';
} catch {}
const words = {
  server: ['Server', 'i-server'],
  arm: ['ARM PC', 'i-arm'],
  usb: ['ARM Type C - Switch', 'i-usb'],
  lan: ['Console', 'i-lan'],
};
const element = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};
function folderButton(kind, id, text = 'Open folder') {
  const button = element('button', 'quiet folder-button');
  button.type = 'button';
  button.innerHTML = '<svg aria-hidden="true"><use href="#i-folder"/></svg>';
  button.append(element('span', '', text));
  button.setAttribute('aria-label', text);
  button.title = text;
  button.disabled = !!state?.preview;
  button.onclick = async event => {
    event.preventDefault();
    event.stopPropagation();
    button.disabled = true;
    try { await api('/api/folder/open', { kind, ...(id ? { id } : {}) }); }
    catch (error) { notice(error.message); }
    finally { button.disabled = !!state?.preview; }
  };
  return button;
}
const date = (value) =>
  value ? new Date(value).toLocaleString('en-GB', { hour12: false }) : '';
async function api(route, data) {
  const res = await fetch(route, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      'x-iz-key': key,
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await res.json();
  if (!res.ok) throw Error(result.error || 'The server did not respond');
  return result;
}
function notice(message, type = 'error', identity = message) {
  if (identity === dismissed) return;
  notificationKey = identity;
  $('toast').hidden = false;
  $('toast').classList.toggle('success', type === 'success');
  $('toast-title').textContent =
    type === 'success' ? 'All set.' : 'Something needs attention.';
  $('toast-text').textContent = message;
  $('toast').querySelector('.toast-symbol').textContent =
    type === 'success' ? '✓' : '!';
}
async function act(route, data = {}) {
  if (busy) return;
  busy = true;
  renderControls();
  try {
    const result = await api(route, data);
    await poll();
    return result;
  } catch (e) {
    notice(e.message);
  } finally {
    busy = false;
    renderControls();
  }
}
function switchView(id) {
  document.querySelectorAll('.view').forEach((e) => (e.hidden = e.id !== id));
  document
    .querySelectorAll('[data-view]')
    .forEach((e) => e.classList.toggle('active', e.dataset.view === id));
}
function chooseStep(value) {
  step = value;
  requestId = null;
  $('screen-ready').checked = false;
  document
    .querySelectorAll('[data-step]')
    .forEach((e) => e.classList.toggle('selected', e.dataset.step === step));
  renderControls();
  if (state) renderWizard();
}
function fieldsDirty(container, values) {
  return Object.entries(fieldValues(container)).some(
    ([name, value]) => String(value) !== String(values?.[name] ?? ''),
  );
}
function deliveryDirty() {
  return (
    !!state?.platform?.izModules &&
    fieldsDirty($('delivery-fields'), state.platform.loaderSettings)
  );
}
function renderControls() {
  if(state?.platform)renderArmSetup(state.platform);
  renderPlatformControls();
  const setup = state?.active?.kind === 'bootstrap' ? state.active.setup : null,
    reboot = setup?.stage === 'reboot',
    active = !!state?.active,
    ready = !!state?.checks.ready,
    ack = $('screen-ready').checked,
    initial = !active || reboot;
  $('recovery-option').hidden =
    step !== 'bootstrap' || !initial || !state?.recoverySetupAvailable;
  $('recovery-enabled').disabled =
    busy || !initial || !state?.recoverySetupAvailable;
  if (state && !state.recoverySetupAvailable)
    $('recovery-enabled').checked = false;
  $('launch-modules').hidden = step !== 'launch' && !reboot;
  $('preload-options').hidden = !$('preload-enabled').checked;
  $('preload-enabled').disabled = busy || !initial;
  $('preload-clear').disabled = busy || !initial;
  document
    .querySelectorAll('#preload-list input')
    .forEach((e) => (e.disabled = busy || !initial || e.dataset.unavailable === 'true'));
  $('preload-count').textContent = startupSelection.size + ' selected';
  $('start').disabled =
    busy ||
    !!state?.emergencyInputPending ||
    !initial ||
    !ready ||
    !ack ||
    !!state?.preview ||
    !state?.setupWizard ||
    deliveryDirty();
  $('start-label').textContent =
    reboot || step === 'launch'
      ? 'Load IZlauncher'
      : 'Install ' +
        ($('recovery-enabled').checked && state?.recoverySetupAvailable
          ? state?.platform?.delivery?.recoveryBootstrapName || 'NS2R'
          : state?.platform?.delivery?.baseBootstrapName || 'NS2');
  $('start').hidden = !initial;
  $('gate-message').textContent = deliveryDirty()
    ? 'Save the loading settings before launch.'
    : state?.emergencyInputPending
      ? 'Check the ARM PC connection. Press red STOP to retry input cancellation.'
      : !state?.setupWizard
        ? 'Restart Platform to activate the updated setup flow'
        : active && !reboot
          ? 'Leave the console on the indicated screen.'
          : state?.preview
            ? 'Preview · device commands disabled'
            : !ready
              ? 'Waiting for '+(state?.checks?.items?.length || 0)+' device checks'
              : !ack
                ? 'Confirm the console screen to continue'
                : 'All checks passed · ready to start';
  $('hard-stop').hidden = !active && !busy && !state?.emergencyInputPending;
  $('hard-stop').disabled = hardStopping || !state?.hardStopAvailable;
  $('stop').hidden = !active;
  $('stop').disabled = busy || state?.active?.status === 'stopping';
  $('stop').textContent =
    state?.active?.status === 'stopping'
      ? 'Disconnecting…'
      : state?.active?.kind === 'bootstrap'
        ? 'Cancel setup'
        : 'Disconnect safely';
  $('screen-ready').disabled = !initial || busy;
  $('screen-ready').parentElement.hidden = !initial;
  document
    .querySelectorAll('[data-step]')
    .forEach((e) => (e.disabled = active || busy));
  $('recheck').disabled = !!state?.active?.inputActive || busy;
  $('load').disabled =
    busy || !state?.connected || !selection.size || !!state?.preview;
  document.querySelectorAll('.module-host-actions button').forEach(button => {
    const source = button.closest('.local-module')?.querySelector('.local-source');
    button.disabled = busy || !!state?.preview || button.dataset.unavailable === 'true' || (!!source && !source.value.trim());
  });
  document
    .querySelectorAll(
      '.transport-choice button,.transport-choice input,.address-form input,.address-form select,.address-form button,.detected-peer',
    )
    .forEach(
      (e) =>
        (e.disabled =
          busy ||
          !state?.connections ||
          !!state?.connections?.locked ||
          !!state?.preview ||
          e.dataset.unavailable === 'true'),
    );
  const hidDisabled = busy || !ready || !!state?.preview || !state?.setupWizard;
  $('verify-source').disabled = hidDisabled || !$('review-ready').checked;
  $('skip-source').disabled =
    busy || !$('review-ready').checked || !state?.setupWizard;
  $('save-source').disabled = hidDisabled;
  $('compare-source').disabled =
    busy ||
    !$('check-lines').checked ||
    !Array.from({ length: 6 }, (_, i) => $('metric-' + i).value).every((s) =>
      /^[0-9]{1,8}$/.test(s),
    );
  $('reverify-source').disabled = hidDisabled;
  $('confirm-saved').disabled = busy || !$('saved-ready').checked;
  $('retry').disabled = busy;
  $('restart-setup').disabled = busy;
  $('edit-readings').disabled = busy;
}
function renderWizard() {
  if (state?.platform && !state.platform.izModules) {
    renderPlatformControls();
    renderEngineInstall();
    return;
  }
  const row = state.active;
  if (row?.kind === 'launch') {
    step = 'launch';
    document
      .querySelectorAll('[data-step]')
      .forEach((e) =>
        e.classList.toggle('selected', e.dataset.step === 'launch'),
      );
  }
  const setup = row?.kind === 'bootstrap' ? row.setup : null,
    stage = setup?.stage || 'prepare',
    show = step === 'bootstrap' || !!setup;
  for (const id of [
    'wizard-review',
    'wizard-values',
    'wizard-results',
    'wizard-save',
    'wizard-saved',
  ])
    $(id).hidden = true;
  $('wizard-steps').hidden = !show;
  renderInstallationSlot();
  const failed =
    !row && ['failed', 'cancelled'].includes(state.lastAttempt?.status);
  $('retry').hidden = !failed;
  const source =
      setup ||
      ($('recovery-enabled').checked && state.recoverySetupAvailable
        ? state.recoverySource
        : state.platform?.baseSource),
    lines = source?.lines || 229,
    sourceSlot = source?.sourceSlot ?? 0,
    name =
      setup?.name ||
      ($('recovery-enabled').checked && state.recoverySetupAvailable
        ? state.platform?.delivery?.recoveryBootstrapName || 'NS2R'
        : state.platform?.delivery?.baseBootstrapName || 'NS2');
  document.querySelector('[data-phase=typing]').textContent = lines + ' lines';
  document.querySelector('[data-phase=save]').textContent = 'Save ' + name;
  for (let i = 0; i < 3; i++) {
    const part = source?.parts?.[i];
    if (part)
      document.querySelector('label[for=metric-' + i * 2 + ']').textContent =
        i + 1 + ' · lines ' + part.first + '–' + part.last;
  }
  $('check-lines').nextElementSibling.textContent =
    'The check finished without errors. SOURCE LINES shows ' +
    lines +
    ', or ' +
    (lines + 1) +
    ' with only one empty final line.';
  $('save-source').firstChild.textContent = 'Save as ' + name + ' ';
  $('saved-ready').nextElementSibling.textContent =
    name + ' was saved successfully on the console.';
  $('recovery-status').hidden = !state.recoverySetupAvailable;
  $('recovery-status').textContent =
    state.link?.state === 'waiting-for-dock'
      ? 'Connection interrupted · waiting for the console to reconnect.'
      : state.link?.protocol === 2
        ? 'Automatic connection recovery is active.'
        : state.active?.kind === 'launch'
          ? 'This session uses the original NS2. Install NS2R to enable recovery.'
          : state.bootstrapProfile?.recovery
            ? (state.platform?.delivery?.bootstrapName || 'NS2R') +
              ' is selected for the next launch.'
            : 'Connection recovery needs a one-time NS2R installation.';
  const descriptions = {
    prepare:
      'In SmileBASIC, choose Make a Program and open Direct mode (the black console screen). Slot 0 must be empty. I will enter LIST 0:1 first, then the original 229 lines.',
    typing:
      'Entering the original source into EDIT0. Keep SmileBASIC open and do not switch screens.',
    review:
      'Are all 229 source lines present, with END on the last source line? An empty line 230 after the final Enter is normal. The three-part source check is optional.',
    checking:
      'Switching to Direct automatically when needed, then entering ordinary read-only source checks. The bootstrap is not executed.',
    values:
      'Read the six numbers from the Switch. The PC cannot read or validate the console output automatically.',
    mismatch:
      'Some source readings differ. Review the marked part and line range. Download a diagnostic for analysis, correct the readings if mistyped, or start again.',
    save: 'Ready to save the source as NS2. Saving is a separate action and never starts the bootstrap.',
    saving:
      'Sending the save command in Direct mode. Confirm any on-console Save / Overwrite dialog.',
    save_confirmation:
      'Has SmileBASIC saved NS2 successfully? Confirm the result on the Switch before continuing.',
    reboot:
      'Fully restart the Switch. Then open SmileBASIC → Make a Program → Direct (the black screen). Only confirm the checkbox below after this is done.',
  };
  if (show) {
    $('step-description').textContent = (
      descriptions[stage] || descriptions.prepare
    )
      .replaceAll('229', String(lines))
      .replaceAll('230', String(lines + 1))
      .replaceAll('original ', name === 'NS2R' ? 'recovery ' : 'original ')
      .replaceAll('as NS2.', 'as ' + name + '.')
      .replaceAll('saved NS2 successfully', 'saved ' + name + ' successfully')
      .replaceAll('Slot 0', 'Slot ' + sourceSlot)
      .replaceAll('LIST 0:1', 'LIST ' + sourceSlot + ':1')
      .replaceAll('EDIT0', 'EDIT' + sourceSlot);
    $('screen-label').textContent =
      stage === 'reboot'
        ? 'I fully restarted the Switch and opened fresh SmileBASIC Direct.'
        : 'I opened fresh SmileBASIC → Make a Program → Direct, slot ' +
          sourceSlot +
          ' is empty, keyboard is English (US), Caps Lock is off.';
  } else {
    $('step-description').textContent =
      row?.kind === 'launch'
          ? 'Keep SmileBASIC open. The original launch sequence is running; no memory preparation is repeated automatically.'
          : 'Use the program already saved on your console. Fully restart the Switch and open fresh SmileBASIC Direct before launching.';
    $('screen-label').textContent = state.platform?.delivery?.preloaded
      ? 'After a full restart, the bootstrap is loaded in slot 0 and Direct is open; RUN and REMOVE have not been executed.'
      : 'I fully restarted the Switch and opened fresh SmileBASIC Direct.';
  }
  const stamp = (row?.id || 'none') + ':' + stage;
  if (stamp !== setupStamp) {
    const previous = setupStamp.split(':').at(-1);
    setupStamp = stamp;
    if (stage === 'review') $('review-ready').checked = false;
    if (stage === 'values') {
      $('check-lines').checked = false;
      if (previous === 'checking')
        for (let i = 0; i < 6; i++) $('metric-' + i).value = '';
    }
    if (stage === 'save_confirmation') $('saved-ready').checked = false;
    if (stage === 'reboot') {
      requestId = null;
      $('screen-ready').checked = false;
    }
  }
  $('wizard-review').hidden = !setup || stage !== 'review';
  $('wizard-values').hidden = !setup || stage !== 'values';
  $('wizard-save').hidden = !setup || stage !== 'save';
  $('wizard-saved').hidden = !setup || stage !== 'save_confirmation';
  if (setup) {
    $('review-label').textContent =
      'All ' +
      lines +
      ' source lines are present, the last source line is END, and I left the console in ' +
      (setup.screen === 'editor' ? 'the editor.' : 'Direct mode.');
    $('save-note').textContent =
      setup.verification === 'passed'
        ? 'All three parts match the entered readings. The next button enters SAVE “TXT:NS2” in Direct.'
        : 'You skipped the optional check. The received source remains unverified. The next button enters SAVE “TXT:NS2” in Direct.';
    $('save-note').textContent =
      $('save-note').textContent.replaceAll('TXT:NS2', 'TXT:' + name) +
      ' · SAVE "TXT:' +
      name +
      '",' +
      sourceSlot;
    const comparison = setup.comparison;
    if (comparison && ['mismatch', 'save'].includes(stage)) {
      $('wizard-results').hidden = false;
      const fingerprint = JSON.stringify(comparison);
      if (fingerprint !== resultStamp) {
        resultStamp = fingerprint;
        $('part-results').replaceChildren();
        for (const part of comparison.parts) {
          const box = element(
            'div',
            'part-result' + (part.matches ? '' : ' mismatch'),
          );
          box.append(
            element(
              'strong',
              '',
              `Part ${part.index} · lines ${part.first}–${part.last} · ${part.matches ? 'Matches' : 'Mismatch'}`,
            ),
            element(
              'span',
              '',
              `Characters: ${part.actual.characters} / expected ${part.characters}`,
            ),
            element(
              'span',
              '',
              `Checksum: ${part.actual.checksum} / expected ${part.checksum}`,
            ),
            element(
              'span',
              '',
              `Text storage: ${part.actual.characters * 2} / expected ${part.utf16Bytes} bytes (UTF-16, derived)`,
            ),
          );
          $('part-results').append(box);
        }
      }
      $('edit-readings').hidden = stage !== 'mismatch';
      $('restart-setup').hidden = stage !== 'mismatch';
    }
  }
  const phases = ['prepare', 'typing', 'review', 'save', 'reboot', 'launch'],
    phase = ['checking', 'values', 'mismatch'].includes(stage)
      ? 'review'
      : ['saving', 'save_confirmation'].includes(stage)
        ? 'save'
        : stage;
  document.querySelectorAll('[data-phase]').forEach((e) => {
    e.classList.toggle('current', e.dataset.phase === phase);
    e.classList.toggle(
      'done',
      phases.indexOf(e.dataset.phase) < phases.indexOf(phase),
    );
  });
  renderControls();
  renderEngineInstall();
}

const networkName = (mode) => (mode === 'wifi' ? 'Wi-Fi' : 'LAN');
async function changeConnection(id, mode, ip, modes) {
  const result = await act('/api/connection', {
    id,
    ...(mode === undefined ? {} : { mode }),
    ...(ip === undefined ? {} : { ip }),
    ...(modes === undefined ? {} : { modes }),
  });
  if (result?.ok) {
    $('screen-ready').checked = false;
    requestId = null;
    renderControls();
  }
}
function renderConsoleConnections(card, preference, locked, supported) {
  const modes = preference.modes || [preference.mode];
  card.querySelectorAll('[data-transport]').forEach((label) => {
    const selected = modes.includes(label.dataset.transport),
      input = label.querySelector('input');
    label.classList.toggle('selected', selected);
    input.checked = selected;
    input.dataset.unavailable = String(
      !supported || (selected && modes.length === 1),
    );
    input.disabled = locked || input.dataset.unavailable === 'true';
  });
  const editor = card.querySelector('.address-editor');
  if (!editor.dataset.dual) {
    editor.dataset.dual = 'true';
    const summary = element('summary');
    editor.replaceChildren(summary);
    for (const mode of ['lan', 'wifi']) {
      const form = element('form', 'address-form console-address');
      form.dataset.mode = mode;
      const label = element('label', '', networkName(mode) + ' IP'),
        input = element('input'),
        apply = element('button', '', 'Apply'),
        status = element('p', 'console-path');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.autocomplete = 'off';
      input.placeholder = 'Automatic · optional address';
      input.id = 'console-address-' + mode;
      input.setAttribute(
        'aria-label',
        'Console ' + networkName(mode) + ' IP address',
      );
      label.htmlFor = input.id;
      apply.type = 'submit';
      const auto = element('button', 'quiet', 'Auto');
      auto.type = 'button';
      auto.onclick = () =>
        changeConnection('lan', mode, '', state.connections.devices.lan.modes);
      form.append(label, input, apply, auto, status);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pref = state.connections.devices.lan;
        await changeConnection(
          'lan',
          mode,
          input.value.trim(),
          pref.modes || [pref.mode],
        );
      });
      editor.append(form);
    }
  }
  const active = preference.paths?.find(
    (p) => p.ready && p.mode === preference.activeMode,
  );
  editor.querySelector('summary').textContent = active
    ? networkName(active.mode) + ' · ' + active.address + ' · Edit'
    : modes.map(networkName).join(' + ') + ' · Auto / manual';
  for (const form of editor.querySelectorAll('form')) {
    const mode = form.dataset.mode,
      input = form.querySelector('input'),
      path = preference.paths?.find((p) => p.mode === mode),
      enabled = modes.includes(mode),
      status = form.querySelector('.console-path'),
      value =
        preference.addresses[mode] ||
        preference.candidates?.find((p) => p.mode === mode)?.address ||
        '';
    if (document.activeElement !== input) input.value = value;
    const lastKnown=preference.lastKnownAddresses?.[mode];input.placeholder=lastKnown?'Auto · last known '+lastKnown.address:'Automatic · optional address';
    form.querySelectorAll('input,button').forEach((e) => {
      e.dataset.unavailable = String(!supported);
      e.disabled = locked || !supported;
    });
    status.textContent = !supported
      ? 'Restart Platform to enable both connections'
      : !enabled
        ? 'Not selected'
        : !path
          ? (lastKnown?'Last known · '+lastKnown.address+' · not checked':'Not checked')
          : path.pending
            ? 'Automatic · waiting for Switch'+(lastKnown?' · last known '+lastKnown.address:'')
            : path.ready
              ? (mode === preference.activeMode ? 'In use' : 'Available') +
                (Number.isFinite(path.latencyMs)
                  ? ' · ' + path.latencyMs.toFixed(2) + ' ms'
                  : '')
              : 'Unavailable';
    status.title = path?.error || (lastKnown?'Verified '+lastKnown.verifiedAt+'; current connection not confirmed':'');
    status.classList.toggle('available', !!path?.ready && enabled);
    status.classList.toggle(
      'active',
      mode === preference.activeMode && !!path?.ready,
    );
  }
  card.querySelector('.console-paths')?.remove();
}
function renderArmSetup(meta) {
  const serial = meta.configuration.inputAdapter === 'esp32s3-serial';
  $('esp32-setup').hidden = !serial;
  $('esp32-setup').querySelectorAll('button').forEach(button => button.disabled = busy || !!meta.locked || !!state.preview);
  const panel = $('arm-setup');
  panel.hidden = meta.configuration.inputAdapter !== 'ssh-gadget';
  if (panel.hidden) return;
  const source = meta.profiles?.[meta.configurationId] || {};
  const fields = { 'arm-setup-address': source.armAddress || meta.configuration.settings?.armAddress || '', 'arm-setup-user': source.armUser || 'root', 'arm-setup-key': source.sshIdentity || '' };
  if(panel.dataset.configuration!==meta.configurationId){panel.dataset.configuration=meta.configurationId;panel.open=!state.checks.items.find(x=>x.id==='arm')?.ready;}
  for(const [id,value] of Object.entries(fields)) if(document.activeElement!==$(id) && !$(id).dataset.edited) $(id).value=value;
  const ready=state.checks.items.find(x=>x.id==='arm')?.ready;
  $('arm-setup-status').textContent=ready?'Input device ready · setup guide remains available':'Install the input package before the first connection';
  const locked=busy||!!meta.locked||!!state.preview;
  panel.querySelectorAll('input,button').forEach(e=>{if(!['arm-method-ssh','arm-method-manual','arm-package-download'].includes(e.id))e.disabled=locked;});
  $('arm-install-target').textContent='Target folder: '+(meta.configuration.inputDirectory||'/opt/iz2s/arm-input')+' · service: iz2s-discovery.service';
  $('arm-install').disabled ||= !$('arm-install-confirm').checked;
}
function renderDeviceDetail(container, row) {
  const detail = String(row.detail || 'Not checked');
  if (!container.querySelector('.detail-text')) {
    const text = element('span', 'detail-text');
    const help = element('button', 'detail-help', '?');
    help.type = 'button';
    const tooltip = element('span', 'detail-tooltip');
    tooltip.id = 'device-help-' + row.id;
    tooltip.setAttribute('role', 'tooltip');
    help.setAttribute('aria-describedby', tooltip.id);
    help.setAttribute('aria-label', 'Connection details');
    help.setAttribute('aria-expanded', 'false');
    help.append(tooltip);
    help.onclick = (event) => {
      event.stopPropagation();
      const open = help.getAttribute('aria-expanded') !== 'true';
      document.querySelectorAll('.detail-help[aria-expanded="true"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
      help.setAttribute('aria-expanded', String(open));
    };
    help.onkeydown = (event) => {
      if (event.key === 'Escape') { help.setAttribute('aria-expanded', 'false'); help.blur(); }
    };
    container.replaceChildren(text, help);
  }
  const extended = detail.length > 70 || detail.includes('\n');
  const first = detail.split(/\.(?:\s|$)|\n/)[0];
  container.querySelector('.detail-text').textContent = extended
    ? (first.length <= 55 ? first.replace(/[.;]$/, '') + '.' : row.pending ? 'Waiting for connection.' : row.ready ? 'Ready.' : 'Setup required.')
    : detail;
  container.querySelector('.detail-help').hidden = !extended;
  container.querySelector('.detail-tooltip').textContent = detail;
}
document.addEventListener('click', (event) => {
  if (!event.target.closest('.detail-help')) document.querySelectorAll('.detail-help[aria-expanded="true"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
});
function renderDevices() {
  const config = state.connections;
  for(const card of [...$('devices').children])if(!state.checks.items.some(row=>card.id==='device-'+row.id))card.remove();
  $('devices').style.setProperty('--device-count',state.checks.items.length);
  for (const row of state.checks.items) {
    const serialInput = row.id === 'arm' && state.platform?.configuration.inputAdapter === 'esp32s3-serial';
    let card = $('device-' + row.id);
    if (card && card.dataset.serial !== String(serialInput)) { card.remove(); card = null; }
    const preference = serialInput ? null : config?.devices[row.id];
    if (!card) {
      card = element('article', 'device');
      card.id = 'device-' + row.id;
      card.dataset.serial = String(serialInput);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
        use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#' + words[row.id][1]);
      svg.setAttribute('aria-hidden', 'true');
      svg.append(use);
      const heading = element('div', 'device-heading');
      heading.append(
        svg,
        element('span', 'state'),
        element('h3', '', words[row.id][0]),
        element('p', 'device-detail'),
        element('p', 'device-ping'),
      );
      card.append(heading);
      if (row.id !== 'usb' && !serialInput) {
        const group = element('div', 'transport-choice');
        group.setAttribute('role', 'group');
        group.setAttribute(
          'aria-label',
          words[row.id][0] + ' network connection',
        );
        for (const mode of ['lan', 'wifi']) {
          const button = element(
            row.id === 'lan' ? 'label' : 'button',
            'transport-option',
          );
          button.dataset.transport = mode;
          button.title = networkName(mode);
          if (row.id === 'lan') {
            const input = element('input');
            input.type = 'checkbox';
            input.setAttribute(
              'aria-label',
              'Enable console ' + networkName(mode),
            );
            input.addEventListener('change', () => {
              const current = state.connections.devices.lan.modes || [
                  state.connections.devices.lan.mode,
                ],
                modes = input.checked
                  ? [...new Set([...current, mode])]
                  : current.filter((m) => m !== mode);
              if (!modes.length) {
                input.checked = true;
                return;
              }
              changeConnection(row.id, undefined, undefined, modes);
            });
            button.append(input, element('span', 'transport-tick', '✓'));
          } else {
            button.type = 'button';
            button.setAttribute('aria-label', networkName(mode));
            button.addEventListener('click', () =>
              changeConnection(row.id, mode),
            );
          }
          const icon = document.createElementNS(
              'http://www.w3.org/2000/svg',
              'svg',
            ),
            symbol = document.createElementNS(
              'http://www.w3.org/2000/svg',
              'use',
            );
          symbol.setAttribute('href', mode === 'wifi' ? '#i-wifi' : '#i-lan');
          icon.setAttribute('aria-hidden', 'true');
          icon.append(symbol);
          button.append(icon);
          group.append(button);
        }
        const editor = element('details', 'address-editor'),
          summary = element('summary'),
          form = element('form', 'address-form'),
          label = element(
            'label',
            '',
            row.id === 'server' ? 'Listen on this PC' : 'Device IP address',
          );
        const input = element(row.id === 'server' ? 'select' : 'input');
        input.id = 'address-' + row.id;
        input.setAttribute('aria-label', words[row.id][0] + ' IP address');
        if (row.id !== 'server') {
          input.type = 'text';
          input.inputMode = 'decimal';
          input.autocomplete = 'off';
          input.placeholder = 'Automatic · or enter IP';
          const list = element('datalist');
          list.id = 'addresses-' + row.id;
          input.setAttribute('list', list.id);
          form.append(list);
        }
        const apply = element('button', '', 'Apply');
        apply.type = 'submit';
        label.htmlFor = input.id;
        const automatic = element('button', 'quiet', 'Auto');
        automatic.type = 'button';
        automatic.onclick = () =>
          act('/api/connection', {
            id: row.id,
            mode: state.connections.devices[row.id].mode,
            automatic: true,
          });
        form.append(label, input, apply, automatic);
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const pref = state.connections?.devices[row.id];
          if (!pref) return;
          await changeConnection(row.id, pref.mode, input.value.trim());
        });
        const suggestions = element('div', 'detected-peers');
        editor.append(summary, suggestions, form);
        card.append(group, editor);
      } else {
        const fixed = element('div', 'fixed-transport');
        fixed.title = serialInput ? 'Serial · COM port' : 'USB · direct cable';
        fixed.setAttribute('aria-label', fixed.title);
        const usb = svg.cloneNode(true);
        fixed.append(usb);
        card.append(fixed);
      }
    }
    $('devices').append(card);
    card.querySelector('h3').textContent=row.label||words[row.id][0];
    card.classList.toggle('ready', row.ready);
    card.querySelector('.state').textContent = row.ready
      ? row.pending
        ? 'AUTO'
        : row.confirmed ? '✓ CONFIRMED' : '✓ READY'
      : state.preview
        ? 'PREVIEW'
        : '○ WAITING';
    renderDeviceDetail(card.querySelector('.device-detail'), row);
    const ping = card.querySelector('.device-ping');
    ping.hidden = !Number.isFinite(row.latencyMs);
    ping.textContent = Number.isFinite(row.latencyMs)
      ? 'Last ping · ' + row.latencyMs.toFixed(2) + ' ms'
      : '';
    if (preference) {
      const locked = busy || !!config.locked || !!state.preview;
      if (row.id === 'lan') {
        renderConsoleConnections(
          card,
          preference,
          locked,
          config.dualConsoleSupported,
        );
        card
          .querySelector('.device-heading use')
          .setAttribute(
            'href',
            '#' +
              (preference.activeMode === 'wifi' ||
              (preference.modes?.length !== 2 && preference.mode === 'wifi')
                ? 'i-wifi'
                : 'i-lan'),
          );
        continue;
      }
      card.querySelectorAll('[data-transport]').forEach((button) => {
        const selected = button.dataset.transport === preference.mode;
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-pressed', String(selected));
        button.disabled = locked;
      });
      const icon =
        row.id === 'lan'
          ? preference.mode === 'wifi'
            ? 'i-wifi'
            : 'i-lan'
          : words[row.id][1];
      card.querySelector('use').setAttribute('href', '#' + icon);
      const editor = card.querySelector('.address-editor'),
        input = $('address-' + row.id);
      editor.querySelector('summary').textContent = preference.address
        ? (preference.automatic ? 'Auto · ' : '') +
          preference.address +
          ' · Edit'
        : 'Auto / manual · ' + networkName(preference.mode);
      if (document.activeElement !== input) {
        if (row.id === 'server') {
          const options = preference.options.filter(
              (o) => o.mode === preference.mode,
            ),
            stamp = JSON.stringify([
              options,
              preference.address,
              preference.automatic,
            ]);
          if (input.dataset.stamp !== stamp) {
            input.dataset.stamp = stamp;
            input.replaceChildren();
            const automatic = element('option', '', 'Automatic');
            automatic.value = '';
            input.append(automatic);
            if (
              preference.address &&
              !options.some((o) => o.address === preference.address)
            ) {
              const option = element(
                'option',
                '',
                preference.address ||
                  'No active ' + networkName(preference.mode) + ' adapter',
              );
              option.value = preference.address;
              input.append(option);
            }
            for (const item of options) {
              const option = element(
                'option',
                '',
                item.address + ' · ' + item.name,
              );
              option.value = item.address;
              input.append(option);
            }
            input.value = preference.automatic ? '' : preference.address;
          }
        } else if (input.dataset.mode !== preference.mode || !editor.open)
          input.value = preference.address;
        input.dataset.mode = preference.mode;
      }
      if (row.id !== 'server') {
        const list = $('addresses-' + row.id),
          stamp = JSON.stringify(preference.options);
        if (list.dataset.stamp !== stamp) {
          list.dataset.stamp = stamp;
          list.replaceChildren();
          for (const item of preference.options) {
            const option = element('option');
            option.value = item.address;
            option.label = item.name || item.address;
            list.append(option);
          }
        }
      }
      const suggestions = editor.querySelector('.detected-peers'),
        choices =
          row.id === 'server'
            ? []
            : preference.options.filter(
                (p) => p.address !== state.connections.devices.server.address,
              ),
        choiceStamp = JSON.stringify([preference.mode, choices]);
      if (suggestions.dataset.stamp !== choiceStamp) {
        suggestions.dataset.stamp = choiceStamp;
        suggestions.replaceChildren();
        if (choices.length) {
          suggestions.append(
            element('span', '', 'Detected on ' + networkName(preference.mode)),
          );
          for (const item of choices.slice(0, 5)) {
            const choose = element(
              'button',
              'detected-peer',
              item.name ? item.name + ' · ' + item.address : item.address,
            );
            choose.type = 'button';
            choose.addEventListener('click', () =>
              changeConnection(
                row.id,
                state.connections.devices[row.id].mode,
                item.address,
              ),
            );
            suggestions.append(choose);
          }
        }
      }
      input.disabled = locked;
      editor
        .querySelectorAll('button')
        .forEach((button) => (button.disabled = locked));
    } else if (row.id !== 'usb') {
      card
        .querySelectorAll('button,input,select')
        .forEach((e) => (e.disabled = true));
    }
  }
  const consoleState = state.consoleState,
    known = state.connected && consoleState && !consoleState.stale;
  const modeLine = $('console-mode-state');
  modeLine.hidden = !known;
  if (known) {
    const mode =
        consoleState.mode === 'docked'
          ? 'TV mode'
          : consoleState.mode === 'handheld'
            ? 'Portable mode'
            : 'Output mode unknown',
      network =
        consoleState.network.type === 'ethernet'
          ? 'Ethernet'
          : consoleState.network.type === 'wifi'
            ? 'Wi-Fi'
            : 'network unknown',
      display = consoleState.display;
    modeLine.textContent =
      mode +
      ' · ' +
      display.width +
      ' × ' +
      display.height +
      ' · ' +
      network +
      (consoleState.network.connected ? '' : ' (disconnected)') +
      (consoleState.warning ? ' · Ethernet is not connected.' : '');
    modeLine.classList.toggle('warning', !!consoleState.warning);
  }
  const modes = config?.devices;
  $('network-summary').textContent = modes
    ? ['server', 'arm', 'lan'].filter(id=>state.checks.items.some(row=>row.id===id))
        .map(
          (id) =>
            (state.checks.items.find(row=>row.id===id)?.label||words[id][0]) +
            ' ' +
            (id === 'arm' && state.platform?.configuration.inputAdapter === 'esp32s3-serial' ? 'Serial' : (modes[id].modes || [modes[id].mode]).map(networkName).join(' + ')),
        )
        .join('  ·  ')
    : 'Restart Platform to enable connection choices.';
  $('network-help').textContent = config?.locked
    ? 'Connections are locked for this session. Stop it before changing networks.'
    : config?.discovery?.ambiguous
      ? 'Several ARM services found. Choose the required device, or enter its IP.'
      : 'Automatic discovery uses your local network. Manual addresses take priority.';
}

function renderStartupModules() {
  const stamp = JSON.stringify(
    state.library.map((p) => [p.id, p.name, p.version, p.icon, p.supported]),
  );
  if (stamp === startupStamp) return;
  startupStamp = stamp;
  const valid = new Set(state.library.filter(p => p.supported !== false).map(p => p.id));
  for (const id of startupSelection)
    if (!valid.has(id)) startupSelection.delete(id);
  $('preload-list').replaceChildren();
  for (const pkg of state.library) {
    const label = element('label', 'preload-item'),
      input = element('input'),
      image = element('img'),
      text = element('span');
    input.type = 'checkbox';
    input.checked = startupSelection.has(pkg.id);
    input.dataset.unavailable = String(pkg.supported === false);
    input.disabled = pkg.supported === false;
    input.setAttribute('aria-label', 'Load ' + pkg.name + ' at startup');
    input.addEventListener('change', () => {
      input.checked
        ? startupSelection.add(pkg.id)
        : startupSelection.delete(pkg.id);
      saveStartup();
      renderControls();
    });
    image.src = pkg.icon;
    image.alt = '';
    text.append(
      element('strong', '', pkg.name),
      element('small', '', pkg.version),
    );
    label.append(input, image, text);
    $('preload-list').append(label);
  }
}
$('preload-enabled').addEventListener('change', () => {
  saveStartup();
  renderControls();
});
$('preload-clear').addEventListener('click', () => {
  startupSelection.clear();
  document
    .querySelectorAll('#preload-list input')
    .forEach((e) => (e.checked = false));
  saveStartup();
  renderControls();
});
function renderLibrary() {
  const errors = $('module-errors');
  if (errors) {
    errors.hidden = !state.moduleErrors?.length;
    errors.textContent = (state.moduleErrors || []).map(row => (row.id || row.path || 'Module') + ': ' + row.error).join(' · ');
  }
  const available = new Set(state.library.filter(pkg => pkg.supported !== false).map(pkg => pkg.id));
  for (const id of selection) if (!available.has(id)) selection.delete(id);
  const stamp = JSON.stringify(
    state.library.map((p) => [p.id, p.version, p.bytes, p.name, p.icon, p.description, p.supported, p.contents]),
  );
  if (stamp !== packageStamp) {
    packageStamp = stamp;
    $('library').replaceChildren();
    $('module-host-actions').dataset.stamp = '';
    for (const pkg of state.library) {
      const card = element('article', 'app-card'),
        label = element('label', 'app-select'),
        input = element('input'),
        img = element('img');
      card.dataset.appId = pkg.id;
      input.type = 'checkbox';
      input.disabled = pkg.supported === false;
      if (input.disabled) selection.delete(pkg.id);
      input.checked = selection.has(pkg.id);
      input.setAttribute('aria-label', 'Select ' + pkg.name);
      input.addEventListener('change', () => {
        if (input.checked) selection.add(pkg.id);
        else selection.delete(pkg.id);
        renderControls();
      });
      img.src = pkg.icon;
      img.alt = '';
      label.append(
        input,
        img,
        element('strong', '', pkg.name),
        element(
          'small',
          '',
          pkg.version + ' / IZM ' + (pkg.bytes / 1024).toFixed(1) + ' KiB',
        ),
        element('p', '', pkg.description),
      );
      card.append(label, element('div', 'module-host-actions'));
      if (pkg.contents) {
        const details = element('details', 'module-contents');
        details.append(
          element('summary', '', 'Package contents'),
          element(
            'p',
            '',
            'Switch sources: ' +
              (pkg.contents.switchSourceBytes / 1024).toFixed(1) +
              ' KiB · Server sources: ' +
              (pkg.contents.serverSourceBytes / 1024).toFixed(1) +
              ' KiB. Server code stays on this PC.' +
              (pkg.contents.upstreamSourceBytes
                ? ' Upstream sources: ' +
                  (pkg.contents.upstreamSourceBytes / 1048576).toFixed(1) +
                  ' MiB.'
                : '') +
              (pkg.contents.moduleDependencies?.length
                ? ' Required modules: ' +
                  pkg.contents.moduleDependencies.join(', ') +
                  '.'
                : '') +
              (pkg.contents.externalDependencies.length
                ? ' Downloaded separately: ' +
                  pkg.contents.externalDependencies.join(', ') +
                  '.'
                : ''),
          ),
        );
        details.onclick = (e) => e.stopPropagation();
        card.append(details);
      }
      card.append(folderButton('module', pkg.module?.id || pkg.id, 'Open module folder'));
      const unload=element('button','secondary module-unload','Remove from console');
      unload.type='button';unload.title='Unload this module from the console menu. The PC package remains available.';
      unload.onclick=async()=>{if(!window.confirm(window.IZ2SI18n.translate('Remove '+pkg.name+' from the console menu? You can load it again from this PC.')))return;selection.delete(pkg.id);await act('/api/unload',{ids:[pkg.id]});};
      card.append(unload);
      $('library').append(card);
    }
  }
  const installed = new Set((state.installed || []).map(app => typeof app === 'string' ? app : app.id));
  for (const card of $('library').children) {
    const loaded = installed.has(card.dataset.appId);
    card.classList.toggle('installed', loaded);
    card.dataset.installed = String(loaded);
    card.querySelector('img').title = loaded ? 'Loaded on console' : 'Not loaded on console';
    const unload=card.querySelector('.module-unload'),pending=state.jobs.some(job=>job.packageId===card.dataset.appId&&['queued','loading','publishing'].includes(job.status));
    unload.hidden=!loaded;unload.disabled=busy||state.preview||!state.connected||pending;
    unload.textContent=pending?'Operation queued…':'Remove from console';
  }
  const hostList = $('module-host-actions'),
    hostStamp = JSON.stringify([packageStamp, state.moduleCatalog, state.hostModules, state.moduleStates]);
  if (hostList.dataset.stamp !== hostStamp) {
    const drafts = new Map([...document.querySelectorAll('.module-host-actions .local-source')].map(input => [input.dataset.runtime, input.value]));
    hostList.dataset.stamp = hostStamp;
    for (const target of document.querySelectorAll('.module-host-actions')) target.replaceChildren();
    for (const module of state.moduleCatalog || []) {
      const card = [...$('library').children].find(item => item.dataset.appId === module.id),
        target = card?.querySelector('.module-host-actions') || hostList;
      for (const pkg of module.server?.localPackages || []) {
        const record = state.hostModules?.[pkg.id];
        if (record?.installed) continue;
        const box = element('details', 'local-module module-setup'),
          summary = element('summary', '', 'PC setup'),
          text = element('div'),
          button = element('button', 'secondary', pkg.importSource ? 'Import local runtime' : 'Install on this PC');
        text.append(element('p', 'hint', pkg.importSource
          ? 'Choose the local game folder. Saved games stay in the original installation.'
          : record?.missingFiles?.length ? 'Local runtime files are missing. Reinstall this component.'
          : 'External component is downloaded separately from the IZM package.'));
        button.dataset.unavailable = String(record?.supported === false);
        button.disabled = busy || state.preview || record?.supported === false;
        button.onclick = () => act('/api/install-host', { id: pkg.id });
        if (pkg.importSource) {
          const input = element('input', 'local-source');
          input.type = 'text';
          input.dataset.runtime = pkg.id;
          input.value = drafts.get(pkg.id) || '';
          input.placeholder = 'Absolute runtime folder';
          input.setAttribute('aria-label', module.name + ' runtime folder');
          text.append(input);
          button.disabled ||= !input.value.trim();
          input.oninput = () => { button.disabled = busy || state.preview || record?.supported === false || !input.value.trim(); };
          button.onclick = () => act('/api/install-host', { id: pkg.id, source: input.value.trim() });
        }
        box.append(summary, text, button);
        target.append(box);
      }
      if (module.server && !module.switch) {
        const box = element('div', 'local-module'),
          running = state.moduleStates?.some(item => item.id === module.id),
          button = element('button', 'secondary', running ? 'Stop' : 'Start');
        box.append(element('strong', '', module.name), button);
        button.disabled = busy || state.preview;
        button.onclick = () => act(running ? '/api/module/stop' : '/api/module/start', { id: module.id });
        target.append(box);
      }
    }
  }
  for (const target of document.querySelectorAll('.module-host-actions')) target.hidden = !target.childElementCount;
  $('app-count').textContent = state.library.length;
  const libraryConnection = $('library-connection');
  libraryConnection.classList.toggle('online', !!state.connected);
  const connectionLabel = state.connected ? 'Switch 2 connected' : 'Switch 2 not connected';
  if (libraryConnection.querySelector('span').textContent !== connectionLabel)
    libraryConnection.querySelector('span').textContent = connectionLabel;
  $('library-note').textContent = state.connected
    ? 'Switch 2 connected · ' + selection.size + ' selected'
    : 'Connect Switch 2 and start IZlauncher to load apps.';
  $('jobs').replaceChildren();
  for (const job of state.jobs.slice(-6).reverse()) {
    const row = element('div', 'job ' + job.status);
    row.append(
      element('strong', '', job.name),
      element('span', '', ['complete','ready'].includes(job.status) ? (job.operation==='remove'?'Removed from console':'Loaded') : job.status),
    );
    if (job.error) row.title = job.error;
    $('jobs').append(row);
  }
  const url = state.streamUrl;
  try {
    const u = new URL(url);
    if (u.hostname !== '127.0.0.1' || u.protocol !== 'http:') throw Error();
    $('stream-link').href = url;
    $('stream-link').hidden = !state.connected;
  } catch {
    $('stream-link').hidden = true;
  }
}
let historyStamp = '';
function renderHistory() {
  const stamp = JSON.stringify(state.history);
  $('fail-count').textContent = state.history.length;
  if (stamp === historyStamp) return;
  historyStamp = stamp;
  $('attempts').replaceChildren();
  if (!state.history.length) {
    const box = element('div', 'empty');
    box.append(
      element('h2', '', 'No failed attempts'),
      element('p', '', 'Session diagnostics appear here after a failed or cancelled attempt.'),
    );
    $('attempts').append(box);
  }
  for (const attempt of state.history) {
    const row = element('article', 'attempt'),
      body = element('div', 'body');
    body.append(
      element(
        'h3',
        '',
        attempt.kind === 'bootstrap'
          ? 'Bootstrap installation'
          : 'Launcher session',
      ),
      element('time', '', date(attempt.created)),
      element(
        'p',
        '',
        attempt.error ||
          'Input cancelled. Restart the console before trying again.',
      ),
    );
    const view = element('button', '', 'View log'),
      remove = element('button', 'delete', 'Delete log');
    view.addEventListener('click', async () => {
      try {
        const value = await api(
          '/api/log?id=' + encodeURIComponent(attempt.id),
        );
        $('saved-log').textContent =
          value.events.map((e) => date(e.at) + '  ' + e.message).join('\n') ||
          'No further details were recorded.';
        $('log-dialog').showModal();
      } catch (e) {
        notice(e.message);
      }
    });
    remove.addEventListener('click', () =>
      act('/api/delete', { id: attempt.id }),
    );
    row.append(body, view, folderButton('session', attempt.id, 'Open log folder'), remove);
    $('attempts').append(row);
  }
}
function renderActivity() {
  const list = state.log.filter((e) => e.type !== 'detail').slice(-60),
    stamp = JSON.stringify(list),
    log = $('log');
  if (log.dataset.stamp === stamp) return;
  const previous = log.scrollTop;
  logWriting = true;
  log.dataset.stamp = stamp;
  $('log-count').textContent = list.length + ' events';
  log.replaceChildren();
  for (const item of list) {
    const row = element('div', 'log-row ' + item.type);
    row.append(
      element('time', '', new Date(item.at).toLocaleTimeString('en-GB')),
      element('span', '', item.message),
    );
    log.append(row);
  }
  if (!list.length)
    log.append(
      element(
        'p',
        'hint',
        'No active attempt. Device checks do not send console commands.',
      ),
    );
  log.scrollTop = logFollow ? log.scrollHeight : previous;
  requestAnimationFrame(() => {
    log.scrollTop = logFollow ? log.scrollHeight : previous;
    logWriting = false;
  });
}

function render() {
  renderPlatform();
  const ended = state.lastAttempt;
  if (ended && ended.id !== finishedAttempt) {
    finishedAttempt = ended.id;
    requestId = null;
    $('screen-ready').checked = false;
  }
  renderDevices();
  renderStartupModules();
  renderLibrary();
  renderHistory();
  renderActivity();
  renderWizard();
  $('mode').textContent = state.simulated
    ? 'SIMULATED DEVICES'
    : state.preview
      ? 'DESIGN PREVIEW'
      : state.connected
        ? 'CONSOLE CONNECTED'
        : 'LOCAL CONTROL';
  $('mode').classList.toggle('preview', state.preview);
  $('connection').classList.toggle('online', state.connected);
  $('connection').lastChild.textContent =
    state.link?.state === 'waiting-for-dock'
      ? 'Reconnecting…'
      : state.connected
        ? 'Console connected'
        : state.active?.kind === 'bootstrap'
          ? 'Setup in progress'
          : state.active
            ? 'Connecting…'
            : 'Not connected';
  const attempt = state.active || state.lastAttempt;
  $('progress-box').hidden = !attempt;
  $('progress-title').textContent = attempt
    ? {
        starting: 'Preparing launcher',
        typing: 'Entering bootstrap.bas',
        running: 'Launcher is running',
        stopping: 'Stopping safely…',
        complete: 'Setup complete',
        review: 'Source entered · awaiting your review',
        checking: 'Reading the source check',
        saving: 'Sending the save command',
        awaiting_restart: 'Waiting for a full console restart',
        failed: 'Attempt failed',
        cancelled: 'Input cancelled',
        stopped: 'Session stopped',
      }[attempt.status] || attempt.status
    : '';
  if (attempt?.progress) {
    $('progress').value = attempt.progress.line;
    $('progress').max = attempt.progress.total;
    $('progress-value').textContent =
      attempt.progress.line + ' / ' + attempt.progress.total + ' lines';
  } else {
    if (['complete', 'running'].includes(attempt?.status))
      $('progress').value = 229;
    else $('progress').removeAttribute('value');
    $('progress-value').textContent = '';
  }
  $('progress-note').textContent =
    attempt?.kind === 'bootstrap'
      ? 'Source entry uses the original HID timings. Console execution and save results require your confirmation.'
      : state.connected
        ? 'You can close this window. Your console session will keep running.'
        : attempt?.status === 'failed'
          ? 'Restart the console before your next attempt.'
          : state.platform?.delivery?.preloaded
            ? 'RUN → prepare memory once → connect'
            : 'LOAD “TXT:' +
              (state.platform?.delivery?.bootstrapName ||
                (state.bootstrapProfile?.recovery ? 'NS2R' : 'NS2')) +
              '” → RUN → prepare memory once → connect';
  if (state.notification) {
    backendNotice = state.notification.at || state.notification.message;
    notice(state.notification.message, state.notification.type, backendNotice);
  } else if (backendNotice) {
    if (notificationKey === backendNotice) $('toast').hidden = true;
    backendNotice = '';
  }
}
let platformMenuStamp = '',
  configurationStamp = '',
  loaderFieldsStamp = '';
const upstreamSteps = { izmysh: 'launch' };
function fieldsFor(schema) {
  if (Array.isArray(schema)) return schema;
  if (schema?.fields) return schema.fields;
  return Object.entries(schema?.properties || schema || {}).map(([id, v]) => ({
    id,
    ...v,
  }));
}
function buildFields(container, schema, values) {
  container.replaceChildren();
  for (const field of fieldsFor(schema)) {
    const id = field.id || field.key || field.name;
    if (!id) continue;
    const label = element('label', 'configuration-field'),
      input = field.options ? element('select') : element('input');
    input.name = id;
    input.dataset.kind = field.type || 'string';
    if (field.options)
      for (const value of field.options) {
        const o = element(
          'option',
          '',
          typeof value === 'object' ? value.label : value,
        );
        o.value = typeof value === 'object' ? value.value : value;
        input.append(o);
      }
    else
      input.type = ['boolean', 'checkbox'].includes(field.type)
        ? 'checkbox'
        : field.type === 'number'
          ? 'number'
          : 'text';
    input.autocomplete = 'off';
    const value = values?.[id] ?? field.default ?? '';
    if (input.type === 'checkbox') input.checked = !!value;
    else input.value = value;
    label.append(element('span', '', field.label || field.title || id), input);
    if (field.description || field.help)
      label.append(element('small', 'hint', field.description || field.help));
    container.append(label);
  }
}
function fieldValues(container) {
  const value = {};
  for (const input of container.querySelectorAll('input,select'))
    value[input.name] =
      input.type === 'checkbox'
        ? input.checked
        : input.dataset.kind === 'number'
          ? Number(input.value)
          : input.value.trim();
  return value;
}
function upstreamPanel(id) {
  return document.querySelector('[data-upstream-panel="' + id + '"]');
}
function renderPlatform() {
  const meta = state?.platform;
  if (!meta) return;
  const locked = busy || meta.locked,
    selected = meta.loaderId;
  const inventoryStamp = JSON.stringify(
    meta.loaders.map((l) => [l.id, l.name]),
  );
  const tabs = document.querySelector('.loader-tabs');
  tabs.hidden = meta.loaders.length < 2;
  tabs.style.setProperty('--engine-count', meta.loaders.length);
  if (tabs.dataset.inventory !== inventoryStamp) {
    tabs.dataset.inventory = inventoryStamp;
    tabs.replaceChildren();
    meta.loaders.forEach((loader, i) => {
      const b = element('button');
      b.type = 'button';
      b.dataset.loader = loader.id;
      b.setAttribute('role', 'tab');
      b.append(
        element('span', '', String(i + 1).padStart(2, '0')),
        element('strong', '', loader.name),
      );
      b.onclick = () => act('/api/launch-settings', { loaderId: loader.id });
      tabs.append(b);
    });
  }
  let hardwareSearch=$('hardware-search');if(!hardwareSearch){hardwareSearch=element('input');hardwareSearch.id='hardware-search';hardwareSearch.type='search';hardwareSearch.placeholder='Find a configuration…';hardwareSearch.setAttribute('aria-label','Search hardware configurations');$('launch-configuration').before(hardwareSearch);hardwareSearch.oninput=()=>{for(const option of $('launch-configuration').options)option.hidden=!option.textContent.toLowerCase().includes(hardwareSearch.value.toLowerCase());};}
  hardwareSearch.hidden = meta.configurations.length < 7;
  hardwareSearch.disabled = locked;
  const profileSelect = $('launch-configuration'),
    profileStamp = JSON.stringify(
      meta.configurations.map((p) => [p.id, p.name, p.selectable, p.unavailableReason]),
    );
  if (profileSelect.dataset.inventory !== profileStamp) {
    profileSelect.dataset.inventory = profileStamp;
    profileSelect.replaceChildren();
    for (const p of meta.configurations) {
      const o = element('option', '', p.name);
      o.value = p.id;
      o.disabled = p.selectable === false;
      o.title = p.unavailableReason || '';
      profileSelect.append(o);
    }
  }
  const shellSelect = $('launch-runtime'),
    shellStamp = JSON.stringify((meta.shells || []).map((p) => [p.id, p.name]));
  if (shellSelect.dataset.inventory !== shellStamp) {
    shellSelect.dataset.inventory = shellStamp;
    shellSelect.replaceChildren();
    for (const v of [
      ...(meta.shells || []),
      { id: 'original', name: 'Original' },
    ]) {
      const b = element('button', '', v.name);
      b.type = 'button';
      b.dataset.variant = v.id;
      b.onclick = () => act('/api/launch-settings', { variant: v.id });
      shellSelect.append(b);
    }
  }
  document.querySelector('[data-step=bootstrap]').hidden =
    meta.loaders.find((l) => l.id === selected)?.menu?.sourceSetup === false;
  document.querySelector('[data-view=apps]').disabled = !meta.izModules;
  document.querySelector('[data-view=apps]').title = meta.izModules
    ? ''
    : 'IZM modules are available in IZlauncher mode';
  if (!meta.izModules && !$('apps').hidden) switchView('setup');
  $('iz-flow').hidden = !meta.izModules;
  const label = meta.loaders.find((l) => l.id === selected)?.name || selected;
  const errors = $('extension-errors');
  if (errors) {
    errors.hidden = !meta.extensionErrors?.length;
    errors.textContent = (meta.extensionErrors || [])
      .map((e) => e.id + ': ' + e.error)
      .join(' · ');
  }
  $('delivery-summary').textContent = label;
  document.querySelector('[data-variant=original]').textContent = 'Original';
  const deliverySchema = (
    meta.loaders.find((l) => l.id === selected)?.settingsSchema || []
  ).filter(
    (f) =>
      (!f.runtimes || f.runtimes.includes('izlauncher')) &&
      f.key !== 'holdRpc' &&
      f.key !== 'mode' &&
      f.key !== 'basicArity',
  );
  const deliveryStamp = JSON.stringify([
    selected,
    deliverySchema,
    meta.loaderSettings,
  ]);
  if (
    $('delivery-options').dataset.stamp !== deliveryStamp &&
    !$('delivery-options').contains(document.activeElement)
  ) {
    buildFields($('delivery-fields'), deliverySchema, meta.loaderSettings);
    $('delivery-options').dataset.stamp = deliveryStamp;
  }
  $('delivery-options').hidden = !meta.izModules || !deliverySchema.length;
  $('delivery-options')
    .querySelectorAll('input,select,button')
    .forEach((e) => (e.disabled = locked));
  $('launch-runtime').hidden = false;
  document.querySelectorAll('[data-loader]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.loader === selected);
    button.setAttribute(
      'aria-selected',
      String(button.dataset.loader === selected),
    );
    const available =
      meta.loaders.find((l) => l.id === button.dataset.loader)?.supported !==
        false &&
      (
        meta.loaders.find((l) => l.id === button.dataset.loader)
          ?.availableIn || ['izlauncher', 'original']
      ).includes(meta.variant);
    button.disabled = locked || !available;
    button.classList.toggle('unavailable', !available);
    button.setAttribute('aria-disabled', String(locked || !available));
    button.title = available ? '' : 'Available in Original mode';
  });
  document.querySelectorAll('[data-variant]').forEach((button) => {
    button.classList.toggle(
      'selected',
      button.dataset.variant === meta.variant,
    );
    button.disabled = locked;
  });
  $('launch-configuration').value = meta.configurationId;
  $('launch-configuration').disabled = locked;
  const configuration = meta.configurations.find(
      (c) => c.id === meta.configurationId,
    ),
    stamp = JSON.stringify([
      meta.configurationId,
      configuration?.settingsSchema,
      configuration?.fields,
      meta.profiles?.[meta.configurationId],
    ]);
  if (
    stamp !== configurationStamp &&
    !$('hardware-form').contains(document.activeElement)
  ) {
    configurationStamp = stamp;
    buildFields(
      $('hardware-fields'),
      configuration?.settingsSchema || configuration?.fields || [],
      meta.profiles?.[meta.configurationId] || {},
    );
  }
  $('hardware-form')
    .querySelectorAll('input,select,button')
    .forEach((e) => (e.disabled = locked));
  const hw=meta.configuration.hardware;
  if(hw){let summary=$('hardware-topology');if(!summary){summary=element('p','hint');summary.id='hardware-topology';$('configuration-note').after(summary);}summary.textContent=hw.deviceCount+' devices · '+(hw.combined?'Server + input: '+hw.server.name:'Server: '+hw.server.name+' → Input: '+hw.input.name)+' → Console: '+hw.console.name;}
  renderArmSetup(meta);
  const needs = meta.configuration.setupRequired;
  $('configuration-note').textContent =
    (needs ? 'Setup required. ' : '') +
    (Array.isArray(meta.configuration.requirements)
      ? meta.configuration.requirements
          .map((x) => (typeof x === 'string' ? x : x.message || x.label || ''))
          .filter(Boolean)
          .join(' · ')
      : meta.configuration.requirements || '');
  const menuStamp = JSON.stringify(
    meta.loaders.map((l) => [l.id, l.menu, l.settingsSchema]),
  );
  if (menuStamp !== platformMenuStamp) {
    platformMenuStamp = menuStamp;
    $('upstream-menus').replaceChildren();
    for (const loader of meta.loaders) {
      const id = loader.id;
      upstreamSteps[id] ??= 'launch';
      const panel = element('section', 'installation upstream-menu');
      panel.dataset.upstreamPanel = id;
      const heading = element('div', 'section-heading'),
        title = element('div'),
        tabs = element('div', 'segmented');
      title.append(
        element('span', 'eyebrow', 'LOADER / ' + id.toUpperCase()),
        element('h2', '', loader.menu?.title || loader.name || id),
      );
      for (const value of loader.menu?.sourceSetup === false
        ? ['launch']
        : ['bootstrap', 'launch']) {
        const button = element(
          'button',
          '',
          value === 'launch' ? 'Launch' : 'First setup',
        );
        button.type = 'button';
        button.dataset.upstreamStep = value;
        button.onclick = () => {
          upstreamSteps[id] = value;
          panel.querySelector('.up-ready').checked = false;
          renderPlatformControls();
        };
        tabs.append(button);
      }
      heading.append(title, tabs);
      panel.append(
        heading,
        element(
          'p',
          'subtitle',
          loader.menu?.description ||
            loader.menu?.subtitle ||
            loader.description ||
            '',
        ),
      );
      const fields = element('form', 'configuration-form loader-settings'),
        fieldBox = element('div'),
        save = element('button', 'secondary', 'Save loader settings');
      fieldBox.className = 'loader-fields';
      save.type = 'submit';
      fields.append(fieldBox, save);
      fields.oninput = () => {
        panel.querySelector('.up-ready').checked = false;
        renderPlatformControls();
      };
      fields.onsubmit = (e) => {
        e.preventDefault();
        act('/api/launch-settings', { loaderSettings: fieldValues(fieldBox) });
      };
      panel.append(fields);
      const note = element('p', 'subtitle up-description'),
        source = element('button', 'quiet up-source', 'Download source .bas');
      source.type = 'button';
      source.onclick = async () => {
        try {
          const response = await fetch(
            '/api/loader-source?id=' + encodeURIComponent(id),
            {
              headers: { 'x-iz-key': key },
            },
          );
          if (!response.ok) throw Error((await response.json()).error);
          const url = URL.createObjectURL(await response.blob()),
            link = element('a');
          link.href = url;
          link.download = id + '-bootstrap.bas';
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (e) {
          notice(e.message);
        }
      };
      const ack = element('label', 'ack'),
        ready = element('input'),
        readyText = element(
          'span',
          '',
          'Switch is fully restarted and SmileBASIC Direct is open.',
        );
      ready.type = 'checkbox';
      ready.className = 'up-ready';
      readyText.className = 'up-ready-label';
      ready.onchange = renderPlatformControls;
      ack.append(ready, readyText);
      const actions = element('div', 'launch-row'),
        start = element('button', 'primary up-start', 'Launch'),
        saveSource = element('button', 'secondary up-save', 'Save source'),
        confirm = element(
          'button',
          'secondary up-confirm',
          'Source saved · continue',
        ),
        stop = element('button', 'soft-stop up-stop', 'Disconnect safely'),
        hard = element('button', 'hard-stop up-hard', '! STOP'),
        status = element('span', 'hint up-status');
      start.onclick = () =>
        act('/api/start', {
          kind: upstreamSteps[id] || 'launch',
          requestId: crypto.randomUUID(),
          screenReady: ready.checked,
          sourceReady: panel.querySelector('.up-source-ready').checked,
          moduleIds: [],
        });
      saveSource.onclick = () =>
        act('/api/setup', { action: 'save', requestId: crypto.randomUUID() });
      confirm.onclick = () =>
        act('/api/setup', {
          action: 'saved',
          requestId: crypto.randomUUID(),
          savedConfirmed: true,
        });
      stop.onclick = () => act('/api/stop', {});
      hard.onclick = async () => {
        if (hardStopping) return;
        hardStopping = true;
        try {
          await api('/api/hard-stop', {});
          await poll();
        } catch (e) {
          notice(e.message);
        } finally {
          hardStopping = false;
          renderPlatformControls();
        }
      };
      actions.append(start, saveSource, confirm, stop, hard, status);
      const sourceAck = element('label', 'ack source-preparation'),
        sourceReady = element('input'),
        sourceText = element('span');
      sourceReady.type = 'checkbox';
      sourceReady.className = 'up-source-ready';
      sourceReady.onchange = renderPlatformControls;
      sourceText.className = 'up-source-label';
      sourceAck.append(sourceReady, sourceText);
      panel.append(note, source, sourceAck, ack, actions);
      $('upstream-menus').append(panel);
    }
  }
  for (const loader of meta.loaders) {
    const panel = upstreamPanel(loader.id);
    if (!panel) continue;
    panel.hidden = meta.izModules || loader.id !== selected;
    const fieldBox = panel.querySelector('.loader-fields'),
      fieldsStamp = JSON.stringify([
        loader.id,
        loader.settingsSchema,
        selected === loader.id ? meta.loaderSettings : {},
      ]);
    if (
      panel.dataset.fieldsStamp !== fieldsStamp &&
      !panel.querySelector('.loader-settings').contains(document.activeElement)
    ) {
      panel.dataset.fieldsStamp = fieldsStamp;
      buildFields(
        fieldBox,
        (loader.settingsSchema || []).filter(f => !f.runtimes || f.runtimes.includes('original')),
        selected === loader.id ? meta.loaderSettings : {},
      );
    }
    panel.querySelector('.loader-settings').hidden = !fieldBox.children.length;
  }
  const inputName =
    meta.configurationId === 'arm-only'
      ? 'ARM PC · local input'
      : meta.configurationId === 'pc-cardputer-adv'
        ? 'Cardputer ADV'
        : 'ARM PC';
  words.arm[0] = inputName;
  words.usb[0] = inputName === 'ARM PC' ? 'ARM Type C - Switch' : 'USB · ' + inputName + ' → Switch';
  for (const row of state.checks.items) {
    const card = $('device-' + row.id);
    if (card && words[row.id])
      card.querySelector('h3').textContent = row.label || words[row.id][0];
  }
  renderPlatformControls();
  renderEngineInstall();
}
function renderInstallationSlot() {
  if(state?.platform?.configuration?.externalWorkflow){$('installation-options').hidden=true;return;}
  const meta = state?.platform,
    installation = meta?.installation;
  const firstSetup = meta?.izModules
    ? step === 'bootstrap'
    : upstreamSteps[meta?.loaderId] === 'bootstrap';
  $('installation-options').hidden = !installation || !firstSetup;
  if (!installation) return;
  $('install-slot').value = String(installation.slot);
  $('install-slot').disabled = busy || !!meta.locked;
  $('install-slot-commands').textContent =
    installation.list + ' → source entry → ' + installation.save;
  $('install-slot-warning').querySelector('span').textContent = 'Installation can overwrite code in slot ' + installation.slot + ' and the saved file TXT:' + installation.name + '. Back up anything you need first.';
}
function renderEngineInstall() {
  const meta = state?.platform;
  if (!meta) return;
  if(meta.configuration.externalWorkflow){$('engine-install').hidden=true;return;}
  const missing = meta.engineInstalled === false;
  $('engine-install').hidden = !missing;
  const selectedEngine = meta.loaders.find((e) => e.id === meta.loaderId);
  $('engine-source').href = selectedEngine?.upstream?.repository || '#';
  $('engine-install-note').textContent =
    'Download the engine source from its published repository, or add it manually. The engine runs only when you launch a session.';
  $('engine-install-folder').textContent =
    'Manual installation: copy the complete repository into engines/' +
    meta.loaderId + '/upstream/, then choose Check manual folder.';
  $('engine-install-folder').title = meta.engineInstallation?.folder || '';
  $('engine-download').disabled = busy || meta.locked || state.preview;
  $('engine-rescan').disabled = busy || meta.locked;
  if (missing) {
    $('iz-flow').hidden = true;
    $('installation-options').hidden = true;
    for (const p of document.querySelectorAll('[data-upstream-panel]'))
      p.hidden = true;
  }
}
function renderPlatformControls() {
  renderInstallationSlot();
  const meta = state?.platform;
  if (!meta) return;
  for (const panel of document.querySelectorAll('[data-upstream-panel]')) {
    const id = panel.dataset.upstreamPanel,
      phase = upstreamSteps[id] || 'launch',
      preparation = state.sourcePreparation,
      active = state.active,
      locked = busy || meta.locked,
      stage = active?.setup?.stage;
    const fields = panel.querySelector('.loader-fields'),
      draft = fieldValues(fields),
      dirty = id === meta.loaderId && fieldsDirty(fields, meta.loaderSettings),
      preloaded = draft.bootstrapMode === 'loaded';
    const sourceRequired =
      phase === 'launch' && !preloaded && !preparation?.ready;
    panel.querySelectorAll('[data-upstream-step]').forEach((button) => {
      button.classList.toggle(
        'selected',
        button.dataset.upstreamStep === phase,
      );
      button.disabled = locked;
    });
    panel
      .querySelectorAll(
        '.loader-settings input,.loader-settings select,.loader-settings button',
      )
      .forEach((e) => (e.disabled = locked));
    panel.querySelector('.source-preparation').hidden = !sourceRequired;
    panel.querySelector('.up-source-label').textContent =
      'I confirm: the selected bootstrap has been saved as ' +
      (draft.bootstrapName || preparation?.name || 'NS2') +
      '.';
    panel.querySelector('.up-source-ready').disabled = locked;
    panel.querySelector('.up-source').hidden = !preparation?.name;
    panel.querySelector('.up-ready-label').textContent =
      phase === 'bootstrap'
        ? 'Fresh SmileBASIC Direct is open; slot ' +
          (preparation?.sourceSlot ?? 0) +
          ' is empty; English (US) keyboard, Caps Lock off.'
        : preloaded
          ? 'After a full restart, the bootstrap is loaded in slot 0 and Direct is open; RUN and REMOVE have not been executed.'
          : 'After a full restart, SmileBASIC Direct is open; RUN and REMOVE have not been executed.';
    panel.querySelector('.up-description').textContent =
      phase === 'launch'
        ? preloaded
          ? 'Source is already in slot 0. The engine will provide the connection commands.'
          : 'The panel will load the saved file ' +
            (draft.bootstrapName || preparation?.name || 'bootstrap') +
            ' with LOAD confirmation, then enter RUN → REMOVE → START.'
        : 'Source will be entered into empty slot ' +
          (preparation?.sourceSlot ?? 0) +
          '. Save it separately as ' +
          (preparation?.name || 'NS2') +
          ', then restart Switch. Other slots remain unchanged.';
    const start = panel.querySelector('.up-start');
    start.textContent =
      phase === 'launch' ? 'Launch' : 'Enter source';
    start.hidden = !!active;
    start.disabled =
      busy ||
      dirty ||
      !!state.preview ||
      !state.checks.ready ||
      !panel.querySelector('.up-ready').checked ||
      (sourceRequired && !panel.querySelector('.up-source-ready').checked) ||
      !!state.emergencyInputPending;
    panel.querySelector('.up-ready').disabled = locked;
    panel.querySelector('.up-save').hidden = stage !== 'review';
    panel.querySelector('.up-save').disabled = busy;
    panel.querySelector('.up-confirm').hidden = stage !== 'save_confirmation';
    panel.querySelector('.up-confirm').disabled = busy;
    panel.querySelector('.up-stop').hidden = !active;
    panel.querySelector('.up-stop').disabled =
      busy || active?.status === 'stopping';
    panel.querySelector('.up-hard').hidden =
      !active && !state.emergencyInputPending;
    panel.querySelector('.up-hard').disabled = hardStopping;
    panel.querySelector('.up-status').textContent = active
      ? active.inputActive
        ? 'Entering commands…'
        : stage === 'review'
          ? 'Review the source on Switch, then save.'
          : stage === 'save_confirmation'
            ? 'Confirm saving on Switch before continuing.'
            : active.status
      : state.emergencyInputPending
        ? 'Input cancellation needs confirmation.'
        : dirty
          ? 'Save the loader settings before connecting.'
          : state.checks.ready
            ? 'Ready to launch.'
            : 'Configure the connections to continue.';
  }
}
document
  .querySelectorAll('[data-loader]')
  .forEach(
    (button) =>
      (button.onclick = () =>
        act('/api/launch-settings', { loaderId: button.dataset.loader })),
  );
document
  .querySelectorAll('[data-variant]')
  .forEach(
    (button) =>
      (button.onclick = () =>
        act('/api/launch-settings', { variant: button.dataset.variant })),
  );
$('launch-configuration').onchange = (e) =>
  act('/api/launch-settings', { configurationId: e.target.value });
$('hardware-form').onsubmit = (e) => {
  e.preventDefault();
  act('/api/launch-settings', {
    configurationId: state.platform.configurationId,
    profile: fieldValues($('hardware-fields')),
  });
};

async function poll() {
  try {
    state = await api('/api/state');
    render();
  } catch (e) {
    $('connection').lastChild.textContent = 'Server unavailable';
    $('connection').classList.remove('online');
    $('start').disabled = true;
    $('load').disabled = true;
    notice(
      'The local server is unavailable. Reopen Platform to reconnect this window.',
    );
  }
}
document
  .querySelectorAll('[data-view]')
  .forEach((e) =>
    e.addEventListener('click', () => switchView(e.dataset.view)),
  );
document
  .querySelectorAll('[data-step]')
  .forEach((e) =>
    e.addEventListener('click', () => chooseStep(e.dataset.step)),
  );
$('recovery-enabled').addEventListener('change', () => {
  requestId = null;
  renderWizard();
});
$('screen-ready').addEventListener('change', renderControls);
$('recheck').addEventListener('click', () => act('/api/check', {}));
$('start').addEventListener('click', () => {
  requestId ||= crypto.randomUUID();
  act('/api/start', {
    kind: state?.active?.setup?.stage === 'reboot' ? 'launch' : step,
    screenReady: $('screen-ready').checked,
    requestId,
    recovery: $('recovery-enabled').checked,
    moduleIds: $('preload-enabled').checked ? [...startupSelection] : [],
  });
});
$('stop').addEventListener('click', () => act('/api/stop', {}));
$('load').addEventListener('click', () =>
  act('/api/load', { ids: [...selection] }),
);
$('about').addEventListener('click', () => $('about-dialog').showModal());
document
  .querySelectorAll('[data-close]')
  .forEach((e) =>
    e.addEventListener('click', () => $(e.dataset.close).close()),
  );
document.querySelectorAll('dialog').forEach((e) =>
  e.addEventListener('click', (event) => {
    if (event.target === e) {
      const r = e.getBoundingClientRect();
      if (
        event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom
      )
        e.close();
    }
  }),
);
$('dismiss').addEventListener('click', () => {
  dismissed = notificationKey;
  $('toast').hidden = true;
  api('/api/dismiss', {}).catch(() => {});
});
document.querySelector('.brand').addEventListener('click', (e) => {
  e.preventDefault();
  switchView('setup');
});
chooseStep('launch');
poll().finally(() => (timer = setInterval(poll, 2000)));
// No unload/visibility handler: closing or hiding Chrome never ends the session.

async function setupAction(action, extra = {}) {
  if (!pendingSetup || pendingSetup.action !== action)
    pendingSetup = { action, requestId: crypto.randomUUID() };
  const result = await act('/api/setup', { ...pendingSetup, ...extra });
  if (result) pendingSetup = null;
  return result;
}
async function retrySetup() {
  const result = await act('/api/retry', {});
  if (result?.ok) {
    requestId = null;
    pendingSetup = null;
    setupStamp = '';
    resultStamp = '';
    $('toast').hidden = true;
    dismissed = notificationKey;
    backendNotice = '';
    $('screen-ready').checked = false;
    $('review-ready').checked = false;
    $('check-lines').checked = false;
    $('saved-ready').checked = false;
    for (let i = 0; i < 6; i++) $('metric-' + i).value = '';
    chooseStep('bootstrap');
  }
}
$('verify-source').addEventListener('click', () =>
  setupAction('verify', { reviewed: $('review-ready').checked }),
);
$('skip-source').addEventListener('click', () =>
  setupAction('skip', { reviewed: $('review-ready').checked }),
);
$('reverify-source').addEventListener('click', () =>
  setupAction('verify', { reviewed: true }),
);
$('compare-source').addEventListener('click', () =>
  setupAction('compare', {
    values: Array.from({ length: 6 }, (_, i) => $('metric-' + i).value),
    linesConfirmed: $('check-lines').checked,
  }),
);
$('edit-readings').addEventListener('click', () => setupAction('edit-values'));
$('save-source').addEventListener('click', () => setupAction('save'));
$('confirm-saved').addEventListener('click', () =>
  setupAction('saved', { savedConfirmed: $('saved-ready').checked }),
);
$('retry').addEventListener('click', retrySetup);
$('restart-setup').addEventListener('click', retrySetup);
for (const id of [
  'review-ready',
  'check-lines',
  'saved-ready',
  ...Array.from({ length: 6 }, (_, i) => 'metric-' + i),
])
  $(id).addEventListener('input', renderControls);
$('export-source').addEventListener('click', async () => {
  try {
    const row = state.active || state.lastAttempt,
      data = await api('/api/setup-report?id=' + encodeURIComponent(row.id)),
      url = URL.createObjectURL(
        new Blob([data.text], { type: 'text/plain;charset=utf-8' }),
      ),
      a = element('a');
    a.href = url;
    a.download = 'IZlauncher-source-check-' + row.id + '.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    notice(e.message);
  }
});
$('log').addEventListener('scroll', () => {
  if (!logWriting && $('log').clientHeight)
    logFollow =
      $('log').scrollHeight - $('log').scrollTop - $('log').clientHeight < 40;
});
document.querySelector('.activity').addEventListener('toggle', (event) => {
  if (event.target.open && logFollow)
    $('log').scrollTop = $('log').scrollHeight;
});

$('hard-stop').addEventListener('click', async () => {
  if (hardStopping) return;
  hardStopping = true;
  renderControls();
  try {
    await api('/api/hard-stop', {});
    await poll();
  } catch (e) {
    notice(e.message, 'error');
  } finally {
    hardStopping = false;
    renderControls();
  }
});


$('delivery-options').oninput = () => {
  $('screen-ready').checked = false;
  renderControls();
};
$('delivery-options').onsubmit = (e) => {
  e.preventDefault();
  act('/api/launch-settings', {
    loaderSettings: {
      ...state.platform.loaderSettings,
      ...fieldValues($('delivery-fields')),
    },
  });
};

$('install-slot').onchange = () => {
  $('screen-ready').checked = false;
  document.querySelectorAll('.up-ready').forEach((e) => (e.checked = false));
  act('/api/launch-settings', { installSlot: Number($('install-slot').value) });
};

$('engine-download').onclick = () =>
  act('/api/engine/install', { id: state.platform.loaderId });
$('engine-rescan').onclick = () => act('/api/engine/rescan', {});

for(const id of ['arm-setup-address','arm-setup-user','arm-setup-key']) $(id).oninput=()=>{$(id).dataset.edited='true';};
$('arm-install-confirm').onchange=()=>{if(state?.platform)renderArmSetup(state.platform);};
for(const mode of ['ssh','manual']) $('arm-method-'+mode).onclick=()=>{for(const item of ['ssh','manual']){$('arm-method-'+item).classList.toggle('selected',mode===item);$('arm-'+item+'-pane').hidden=mode!==item;}};
$('arm-install-form').onsubmit=async(event)=>{
  event.preventDefault();
  $('arm-install-result').textContent='Installing the verified package over SSH…';
  const result=await act('/api/input/install',{address:$('arm-setup-address').value.trim(),user:$('arm-setup-user').value.trim(),identity:$('arm-setup-key').value.trim(),confirm:$('arm-install-confirm').checked});
  if(result?.ok){$('arm-install-result').textContent=result.keyboard?'Installed. Check the console USB connection before launch.':'Installed. Connect/configure the board’s USB keyboard gadget, then check again.';for(const id of ['arm-setup-address','arm-setup-user','arm-setup-key'])delete $(id).dataset.edited;}else $('arm-install-result').textContent='Installation was not confirmed. Check the error above, or use the manual package.';
};
$('arm-check').onclick=()=>act('/api/check');
$('esp32-check').onclick=()=>act('/api/check');
$('esp32-configure').onclick=()=>{
  $('hardware-options').open=true;
  $('hardware-fields').querySelector('[name="esp32Port"]')?.focus();
  $('hardware-options').scrollIntoView({block:'center',behavior:'smooth'});
};
$('esp32-list-ports').onclick=async()=>{
  try {
    const response=await fetch('/api/input/ports',{headers:{'x-iz-key':key}});
    const result=await response.json();if(!response.ok)throw Error(result.error);
    $('esp32-ports').textContent=result.ports.length
      ? result.ports.map(port=>port.port+' · '+port.description).join(' | ')
      : 'No COM ports found. Connect the serial/UART cable to this PC.';
  } catch(error){$('esp32-ports').textContent=error.message;}
};
$('arm-package-download').onclick=async()=>{try{const response=await fetch('/api/input-package',{headers:{'x-iz-key':key}});if(!response.ok)throw Error((await response.json()).error);const url=URL.createObjectURL(await response.blob()),link=element('a');link.href=url;link.download='iz2s-arm-input.tar.gz';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){notice(error.message);}};


for (const placeholder of document.querySelectorAll('[data-folder]')) {
  const button = folderButton(placeholder.dataset.folder, null, placeholder.textContent.trim());
  button.id = placeholder.id;
  button.className += ' ' + placeholder.className;
  button.onclick = async event => {
    event.preventDefault();
    event.stopPropagation();
    const kind = placeholder.dataset.folder;
    const id = kind === 'configuration' ? state?.platform?.configurationId
      : ['engine', 'engine-source'].includes(kind) ? state?.platform?.loaderId : undefined;
    button.disabled = true;
    try { await api('/api/folder/open', { kind, ...(id ? { id } : {}) }); }
    catch (error) { notice(error.message); }
    finally { button.disabled = !!state?.preview; }
  };
  placeholder.replaceWith(button);
}

/* Panel language support stays in the existing asset so an active host needs no restart. */
(() => {
  const catalog = {
  "IZ2S Platform": "IZ2S Platform",
  "Cowboy mouse": "牛仔鼠标志",
  "IZ2S": "IZ2S",
  "Platform": "Platform",
  "0.16.0-rc.5": "0.16.0-rc.5",
  "Main navigation": "主导航",
  "Connection": "连接",
  "App library": "应用库",
  "Failed attempts": "失败记录",
  "Not connected": "未连接",
  "About IZ2S": "关于 IZ2S",
  "Created by IZMYSH": "作者：IZMYSH",
  "CONNECTION": "连接",
  "↻ Check again": "↻ 重新检查",
  "LOCAL CONTROL": "本地控制",
  "Launch configuration": "启动配置",
  "LAUNCH MODE": "启动模式",
  "Console connection": "主机连接",
  "Application": "应用",
  "IZlauncher": "IZlauncher",
  "Original": "原版",
  "ENGINE": "引擎",
  "ns2jb by IZMYSH": "ns2jb（IZMYSH）",
  "Engine folder": "引擎文件夹",
  "Engine": "引擎",
  "Save loading settings": "保存加载设置",
  "Hardware configuration": "硬件配置",
  "PC + ARM PC": "电脑 + ARM PC",
  "ARM PC Only": "仅 ARM PC",
  "PC + Cardputer ADV": "电脑 + Cardputer ADV",
  "Configure": "配置",
  "Save configuration": "保存配置",
  "Configuration folder": "配置文件夹",
  "Install original engine": "安装原版引擎",
  "Download original engine": "下载原版引擎",
  "Check manual folder": "检查手动安装文件夹",
  "Open install folder": "打开安装文件夹",
  "Open original repository ↗": "打开原版代码仓库 ↗",
  "First-time setup": "首次设置",
  "Prepare your ARM input device": "准备 ARM 输入设备",
  "ARM INPUT": "ARM 输入",
  "1 · Prepare": "1 · 准备",
  "Linux, Python 3, systemd and SSH. Use the board’s USB data/OTG port. The OS must expose a keyboard gadget, usually": "需要 Linux、Python 3、systemd 和 SSH。请使用开发板的 USB 数据/OTG 接口。系统必须提供 USB 键盘设备接口，通常为",
  "2 · Install": "2 · 安装",
  "Use trusted SSH keys, or download the complete package for manual/password-only installation. No PC server or Node.js is needed on ARM.": "使用受信任的 SSH 密钥，或下载完整安装包，通过手动操作或密码验证安装。ARM 设备无需运行电脑端服务或 Node.js。",
  "3 · Connect": "3 · 连接",
  "Connect the board to Switch, then check the connection. Installing the agent does not configure board firmware or type anything on the console.": "将开发板连接至 Switch，然后检查连接。安装输入代理不会配置开发板固件，也不会在主机上输入任何内容。",
  "ARM installation method": "ARM 安装方式",
  "Over SSH": "通过 SSH",
  "Manual / password": "手动安装 / 密码验证",
  "ARM IPv4 address": "ARM 设备 IPv4 地址",
  "SSH user": "SSH 用户名",
  "Private key path on this PC · optional": "本机私钥路径 · 可选",
  "Use SSH agent or default key": "使用 SSH 代理或默认密钥",
  "First connect from a terminal and verify the board’s host fingerprint. Use": "请先在终端连接开发板并核对主机指纹。使用",
  "to authorize an existing key. Passwords stay in your terminal; private keys stay on this PC.": "授权现有密钥。密码仅在终端输入，私钥保留在本机。",
  "Install the input agent and enable its discovery service on the selected ARM device.": "在所选 ARM 设备上安装输入代理，并启用其发现服务。",
  "Install over SSH": "通过 SSH 安装",
  "Download the complete ARM package below, or copy": "下载下方的完整 ARM 安装包，或从平台文件夹复制",
  "from the platform folder. Enter SSH passwords in your terminal.": "。请在终端输入 SSH 密码。",
  "On ARM:": "在 ARM 设备上执行：",
  "Use your actual SSH account. Non-root accounts need sudo for manual installation. The bundled README includes prerequisites, troubleshooting, offline copying and removal.": "请使用实际的 SSH 账户。非 root 账户手动安装时需要 sudo 权限。随附的 README 包含环境要求、故障排查、离线复制和卸载说明。",
  "Download ARM package": "下载 ARM 安装包",
  "ARM package folder": "ARM 安装包文件夹",
  "Check connection": "检查连接",
  "ESP32-S3 TextKeyboard": "ESP32-S3 TextKeyboard",
  "Use your existing TextKeyboard firmware": "使用现有的 TextKeyboard 固件",
  "SERIAL INPUT": "串口输入",
  "1 · Connect both links": "1 · 连接两条线路",
  "Connect the board's serial/UART link to this PC and its USB/OTG keyboard port to Switch. Close TextSender while IZ2S uses the COM port.": "将开发板的串口/UART 接口连接至本机，USB/OTG 键盘接口连接至 Switch。IZ2S 使用 COM 端口时，请关闭 TextSender。",
  "2 · Configure": "2 · 配置",
  "In Configure above, enter the COM port, use 115200 baud and confirm the keyboard USB cable is connected to Switch. The input protocol is ESP32S3-TEXTKEY/1 with TYPE2.": "在上方“配置”中填写 COM 端口，波特率设为 115200，并确认键盘 USB 线已连接至 Switch。输入协议为 ESP32S3-TEXTKEY/1，使用 TYPE2。",
  "3 · Check and start": "3 · 检查并启动",
  "Check connection reads the firmware identity. Use First setup below to enter and save NS2I, then fully restart Switch before Launch. Each launch uses a fresh command.": "“检查连接”会读取固件标识。使用下方“首次设置”输入并保存 NS2I，然后完整重启 Switch，再点击“启动”。每次启动都会使用新命令。",
  "List COM ports": "列出 COM 端口",
  "Configure serial input": "配置串口输入",
  "USB cable readiness is your confirmation. A successful PING or DONE response does not verify text on the Switch screen.": "USB 线是否连接就绪需要您自行确认。收到 PING 或 DONE 成功响应，并不代表 Switch 屏幕上的文本已验证正确。",
  "Choose LAN or Wi-Fi for each network device.": "为每台网络设备选择有线网络或 Wi-Fi。",
  "Connect devices to the same local network. USB input uses its own cable.": "请将设备连接到同一局域网。USB 输入使用独立的数据线。",
  "Program slot": "程序槽位",
  "Installation program slot": "安装使用的程序槽位",
  "Slot 0": "槽位 0",
  "Slot 1": "槽位 1",
  "Slot 2": "槽位 2",
  "Slot 3": "槽位 3",
  "Warning:": "警告：",
  "Existing code in slot 0 may be overwritten. Back up anything you need first.": "槽位 0 中的现有代码可能被覆盖。请先备份需要保留的内容。",
  "Choose an empty slot. Its contents will be edited; saved files change only after Save. After restart, Launch loads the saved file into slot 0.": "请选择空槽位。该槽位内容将被编辑；只有执行“保存”后才会修改已保存的文件。重启后，“启动”会将已保存的文件加载至槽位 0。",
  "CONSOLE SESSION": "主机会话",
  "Start a session.": "启动会话。",
  "Installation step": "安装步骤",
  "First setup": "首次设置",
  "Launch": "启动",
  "First setup progress": "首次设置进度",
  "Direct": "Direct",
  "229 lines": "229 行",
  "Check": "校验",
  "optional": "可选",
  "Save NS2": "保存 NS2",
  "Restart": "重启",
  "Recover connection automatically": "自动恢复连接",
  "Install NS2R to resume after a brief Wi-Fi or dock interruption. Keeps your original NS2.": "安装 NS2R，可在 Wi-Fi 或底座连接短暂中断后恢复连接。原有 NS2 将保留。",
  "All 229 source lines are present, the last source line is END, and I left the console in the editor.": "229 行源码已全部输入，最后一行为 END，主机仍停留在编辑器中。",
  "Check three parts": "分三段校验",
  "Skip optional check": "跳过可选校验",
  "Copy the six values printed under PART 1–3 on the Switch. Line endings are excluded from character counts; the checksum also checks character order.": "填写 Switch 上 PART 1–3 下显示的六个数值。字符数不含换行符；校验和还会检查字符顺序。",
  "Source part": "源码分段",
  "Characters": "字符数",
  "Checksum": "校验和",
  "1 · lines 1–77": "第 1 段 · 第 1–77 行",
  "Part 1 characters": "第 1 段字符数",
  "Part 1 checksum": "第 1 段校验和",
  "2 · lines 78–153": "第 2 段 · 第 78–153 行",
  "Part 2 characters": "第 2 段字符数",
  "Part 2 checksum": "第 2 段校验和",
  "3 · lines 154–229": "第 3 段 · 第 154–229 行",
  "Part 3 characters": "第 3 段字符数",
  "Part 3 checksum": "第 3 段校验和",
  "The check finished without errors. SOURCE LINES shows 229, or 230 with only one empty final line.": "校验已完成且没有报错。SOURCE LINES 显示 229，或显示 230 且仅末尾多一行空行。",
  "Confirm readings": "确认数值",
  "Run check again": "重新校验",
  "Download diagnostic for LLM ↗": "下载供 AI 分析的诊断信息 ↗",
  "Edit readings": "修改数值",
  "Again · from the beginning": "从头重试",
  "Save as NS2": "另存为 NS2",
  "Confirm any Save / Overwrite dialog on the console. Wait for saving to finish; the PC cannot see this result.": "请在主机上确认“保存/覆盖”对话框，并等待保存完成；电脑无法读取此结果。",
  "NS2 was saved successfully on the console.": "NS2 已在主机上成功保存。",
  "Continue to restart": "继续重启步骤",
  "Modules at startup": "启动时加载的模块",
  "Load modules at startup": "启动时加载模块",
  "Choose what appears in your console menu.": "选择要在主机菜单中显示的模块。",
  "0 selected": "已选 0 项",
  "AVAILABLE MODULES": "可用模块",
  "Clear selection": "清空选择",
  "Modules load with IZlauncher.": "模块将随 IZlauncher 一起加载。",
  "Start launcher": "启动 IZlauncher",
  "Checking devices…": "正在检查设备…",
  "Disconnect safely": "安全断开连接",
  "Force-stop this host session. Restart the Switch manually afterwards.": "强制停止本次电脑端会话。之后需要手动重启 Switch。",
  "STOP": "停止",
  "Preparing…": "正在准备…",
  "Session activity": "会话日志",
  "0 events": "0 条记录",
  "Select modules to load on your console.": "选择要加载到主机上的模块。",
  "Switch 2 not connected": "Switch 2 未连接",
  "Modules folder": "模块文件夹",
  "Open BlitBun ↗": "打开 BlitBun ↗",
  "Connect your console to load apps.": "连接主机后即可加载应用。",
  "Load selected": "加载所选项",
  "Modules:": "模块：",
  "· IZM packages": "· IZM 安装包",
  "Review diagnostics or remove saved logs.": "查看诊断信息或移除已保存的日志。",
  "Log folder": "日志文件夹",
  "Platform folder": "平台文件夹",
  "IZlauncher folder": "IZlauncher 文件夹",
  "Created by IZMYSH (@byizmysh)": "作者：IZMYSH (@byizmysh)",
  "Dismiss notification": "关闭通知",
  "Close about": "关闭关于窗口",
  "IZ2S PLATFORM": "IZ2S PLATFORM",
  "About IZ2S Platform": "关于 IZ2S Platform",
  "Created by": "作者：",
  "IZMYSH (@byizmysh) ↗": "IZMYSH (@byizmysh) ↗",
  "BUILT ON THE WORK OF": "基于以下作者的成果",
  "@pepsipu": "@pepsipu",
  "ns2jb ↗": "ns2jb ↗",
  "@kurumuz": "@kurumuz",
  "Thank you for the foundation that makes this possible.": "感谢你们提供的基础，让这个项目得以实现。",
  "Close log": "关闭日志",
  "SAVED ATTEMPT": "已保存的尝试记录",
  "Session log": "会话日志",
  "Open folder": "打开文件夹",
  "The server did not respond": "服务器未响应",
  "All set.": "已完成。",
  "Something needs attention.": "有事项需要处理。",
  "Load IZlauncher": "加载 IZlauncher",
  "Save the loading settings before launch.": "请先保存加载设置，再启动。",
  "Check the ARM PC connection. Press red STOP to retry input cancellation.": "请检查 ARM PC 连接。点击红色“停止”按钮，再次尝试取消输入。",
  "Restart Platform to activate the updated setup flow": "请重启 Platform，以启用更新后的设置流程",
  "Leave the console on the indicated screen.": "请让主机停留在指定画面。",
  "Preview · device commands disabled": "预览模式 · 设备命令已禁用",
  "Confirm the console screen to continue": "请确认主机画面后继续",
  "All checks passed · ready to start": "所有检查均已通过 · 可以启动",
  "Disconnecting…": "正在断开连接…",
  "Cancel setup": "取消设置",
  "Connection interrupted · waiting for the console to reconnect.": "连接已中断 · 等待主机重新连接。",
  "Automatic connection recovery is active.": "自动恢复连接已启用。",
  "This session uses the original NS2. Install NS2R to enable recovery.": "当前会话使用原版 NS2。安装 NS2R 后可启用连接恢复。",
  "Connection recovery needs a one-time NS2R installation.": "需先安装一次 NS2R，才能使用连接恢复。",
  "Switching to Direct automatically when needed, then entering ordinary read-only source checks. The bootstrap is not executed.": "需要时会自动切换到 Direct，再输入只读的源码检查命令。此步骤不会运行引导程序。",
  "Read the six numbers from the Switch. The PC cannot read or validate the console output automatically.": "请读取 Switch 上显示的六个数字。电脑无法自动读取或验证主机输出。",
  "Some source readings differ. Review the marked part and line range. Download a diagnostic for analysis, correct the readings if mistyped, or start again.": "部分源码读数不一致。请检查标记的部分和行号范围。可以下载诊断报告分析、纠正输错的读数，或重新输入源码。",
  "Sending the save command in Direct mode. Confirm any on-console Save / Overwrite dialog.": "正在 Direct 模式中发送保存命令。若主机弹出保存或覆盖确认，请在主机上确认。",
  "Fully restart the Switch. Then open SmileBASIC → Make a Program → Direct (the black screen). Only confirm the checkbox below after this is done.": "请完整重启 Switch，然后打开 SmileBASIC → Make a Program → Direct（黑色命令画面）。完成后再勾选下方确认框。",
  "I fully restarted the Switch and opened fresh SmileBASIC Direct.": "我已完整重启 Switch，并重新进入 SmileBASIC Direct。",
  "Keep SmileBASIC open. The original launch sequence is running; no memory preparation is repeated automatically.": "请保持 SmileBASIC 打开。原版启动流程正在执行，内存准备不会自动重复。",
  "Use the program already saved on your console. Fully restart the Switch and open fresh SmileBASIC Direct before launching.": "使用主机上已保存的程序。启动前请完整重启 Switch，并重新进入 SmileBASIC Direct。",
  "After a full restart, the bootstrap is loaded in slot 0 and Direct is open; RUN and REMOVE have not been executed.": "我已完整重启，将引导程序加载到槽位 0，并打开 Direct；尚未执行 RUN 和 REMOVE。",
  "Apply": "应用",
  "Auto": "自动",
  "Automatic": "自动",
  "Automatic · optional address": "自动 · 可选填地址",
  "Automatic · or enter IP": "自动 · 或输入 IP",
  "Restart Platform to enable both connections": "请重启 Platform，以启用两种连接",
  "Not selected": "未选择",
  "Not checked": "尚未检查",
  "In use": "使用中",
  "Available": "可用",
  "Unavailable": "不可用",
  "Input device ready · setup guide remains available": "输入设备已就绪 · 仍可查看设置指南",
  "Install the input package before the first connection": "首次连接前请安装输入程序包",
  "Connection details": "连接详情",
  "Waiting for connection.": "等待连接。",
  "Ready.": "已就绪。",
  "Setup required.": "需要设置。",
  "Server": "服务器",
  "ARM PC": "ARM PC",
  "Console": "主机",
  "Listen on this PC": "本机监听地址",
  "Device IP address": "设备 IP 地址",
  "Serial · COM port": "串口 · COM 端口",
  "USB · direct cable": "USB · 直连线缆",
  "AUTO": "自动",
  "✓ CONFIRMED": "✓ 已确认",
  "✓ READY": "✓ 已就绪",
  "PREVIEW": "预览",
  "○ WAITING": "○ 等待中",
  "Restart Platform to enable connection choices.": "请重启 Platform，以启用连接选项。",
  "Connections are locked for this session. Stop it before changing networks.": "当前会话的连接设置已锁定。请先停止会话，再更换网络。",
  "Several ARM services found. Choose the required device, or enter its IP.": "发现多个 ARM 服务。请选择所需设备，或输入其 IP 地址。",
  "Automatic discovery uses your local network. Manual addresses take priority.": "自动发现使用本地网络。手动填写的地址优先。",
  "Package contents": "程序包内容",
  "Open module folder": "打开模块文件夹",
  "Remove from console": "从主机移除",
  "Unload this module from the console menu. The PC package remains available.": "从主机菜单中卸载此模块。电脑上的程序包仍会保留。",
  "Loaded on console": "已加载到主机",
  "Not loaded on console": "尚未加载到主机",
  "Operation queued…": "操作已排队…",
  "PC setup": "电脑端设置",
  "Import local runtime": "导入本地运行环境",
  "Install on this PC": "安装到此电脑",
  "Choose the local game folder. Saved games stay in the original installation.": "请选择本地游戏文件夹。游戏存档保留在原安装目录。",
  "Local runtime files are missing. Reinstall this component.": "缺少本地运行环境文件。请重新安装此组件。",
  "External component is downloaded separately from the IZM package.": "外部组件需单独下载，不包含在 IZM 程序包中。",
  "Absolute runtime folder": "运行环境文件夹的绝对路径",
  "Stop": "停止",
  "Start": "启动",
  "Switch 2 connected": "Switch 2 已连接",
  "Connect Switch 2 and start IZlauncher to load apps.": "请连接 Switch 2 并启动 IZlauncher，再加载应用。",
  "Removed from console": "已从主机移除",
  "Loaded": "已加载",
  "queued": "排队中",
  "loading": "加载中",
  "publishing": "发布中",
  "starting": "启动中",
  "typing": "输入中",
  "running": "运行中",
  "stopping": "停止中",
  "complete": "已完成",
  "ready": "已就绪",
  "review": "等待检查",
  "checking": "检查中",
  "saving": "保存中",
  "awaiting_restart": "等待重启",
  "failed": "失败",
  "cancelled": "已取消",
  "stopped": "已停止",
  "No failed attempts": "暂无失败记录",
  "Session diagnostics appear here after a failed or cancelled attempt.": "尝试失败或取消后，会话诊断记录会显示在这里。",
  "Bootstrap installation": "引导程序安装",
  "Launcher session": "启动器会话",
  "Input cancelled. Restart the console before trying again.": "输入已取消。请重启主机后再试。",
  "View log": "查看日志",
  "Delete log": "删除日志",
  "Open log folder": "打开日志文件夹",
  "No further details were recorded.": "没有记录更多详情。",
  "No active attempt. Device checks do not send console commands.": "当前没有正在执行的任务。设备检查不会向主机发送命令。",
  "SIMULATED DEVICES": "模拟设备",
  "DESIGN PREVIEW": "界面预览",
  "CONSOLE CONNECTED": "主机已连接",
  "Reconnecting…": "正在重新连接…",
  "Console connected": "主机已连接",
  "Setup in progress": "正在设置",
  "Connecting…": "正在连接…",
  "Preparing launcher": "正在准备启动器",
  "Entering bootstrap.bas": "正在输入 bootstrap.bas",
  "Launcher is running": "启动器运行中",
  "Stopping safely…": "正在安全停止…",
  "Setup complete": "设置完成",
  "Source entered · awaiting your review": "源码已输入 · 等待检查",
  "Reading the source check": "正在读取源码检查结果",
  "Sending the save command": "正在发送保存命令",
  "Waiting for a full console restart": "等待完整重启主机",
  "Attempt failed": "本次尝试失败",
  "Input cancelled": "输入已取消",
  "Session stopped": "会话已停止",
  "Source entry uses the original HID timings. Console execution and save results require your confirmation.": "源码输入使用原版 HID 时序。主机执行情况和保存结果需要由你确认。",
  "You can close this window. Your console session will keep running.": "可以关闭此窗口，主机会话仍会继续运行。",
  "Restart the console before your next attempt.": "下次尝试前请重启主机。",
  "RUN → prepare memory once → connect": "RUN → 准备一次内存 → 连接",
  "Find a configuration…": "查找配置…",
  "Search hardware configurations": "搜索硬件配置",
  "IZM modules are available in IZlauncher mode": "IZM 模块可在 IZlauncher 模式下使用",
  "Available in Original mode": "可在原版模式下使用",
  "Save loader settings": "保存加载器设置",
  "Download source .bas": "下载源码 .bas",
  "Switch is fully restarted and SmileBASIC Direct is open.": "Switch 已完整重启，并已打开 SmileBASIC Direct。",
  "Save source": "保存源码",
  "Source saved · continue": "源码已保存 · 继续",
  "! STOP": "! 停止",
  "Enter source": "输入源码",
  "ARM PC · local input": "ARM PC · 本地输入",
  "Download the engine source from its published repository, or add it manually. The engine runs only when you launch a session.": "从引擎的公开仓库下载源码，或手动添加。引擎仅在启动会话时运行。",
  "After a full restart, SmileBASIC Direct is open; RUN and REMOVE have not been executed.": "我已完整重启，并打开 SmileBASIC Direct；尚未执行 RUN 和 REMOVE。",
  "Source is already in slot 0. The engine will provide the connection commands.": "源码已位于槽位 0。引擎将提供连接命令。",
  "Entering commands…": "正在输入命令…",
  "Review the source on Switch, then save.": "请在 Switch 上检查源码，然后保存。",
  "Confirm saving on Switch before continuing.": "请在 Switch 上确认保存后再继续。",
  "Input cancellation needs confirmation.": "需要确认输入已取消。",
  "Save the loader settings before connecting.": "请先保存加载器设置，再连接。",
  "Ready to launch.": "可以启动。",
  "Configure the connections to continue.": "请先配置连接后再继续。",
  "Server unavailable": "服务器不可用",
  "The local server is unavailable. Reopen Platform to reconnect this window.": "本地服务器不可用。请重新打开 Platform，以重新连接此窗口。",
  "Installing the verified package over SSH…": "正在通过 SSH 安装已校验的程序包…",
  "Installed. Check the console USB connection before launch.": "安装完成。启动前请检查主机的 USB 连接。",
  "Installed. Connect/configure the board’s USB keyboard gadget, then check again.": "安装完成。请连接或配置开发板的 USB 键盘设备，然后重新检查。",
  "Installation was not confirmed. Check the error above, or use the manual package.": "未能确认安装成功。请查看上方错误，或使用手动安装包。",
  "No COM ports found. Connect the serial/UART cable to this PC.": "未找到 COM 端口。请将串口 / UART 线连接到此电脑。",
  "Switch LAN IPv4 address (optional)": "Switch 有线网络 IPv4 地址（可选）",
  "Switch Wi-Fi IPv4 address (optional)": "Switch Wi-Fi IPv4 地址（可选）",
  "Server IPv4 address (empty = automatic)": "服务器 IPv4 地址（留空则自动选择）",
  "ARM PC IPv4 address (optional)": "ARM PC IPv4 地址（可选）",
  "ARM input module directory": "ARM 输入模块目录",
  "ARM SSH user (root required for input)": "ARM SSH 用户（输入功能需要 root）",
  "SSH private key path (optional; stays on this PC)": "SSH 私钥路径（可选；保留在此电脑上）",
  "SSH known-hosts file (optional)": "SSH 已知主机文件（可选）",
  "SSH host-key alias (optional)": "SSH 主机密钥别名（可选）",
  "mac2jb application bundle": "mac2jb 应用程序包",
  "Cardputer KProx HTTP address": "Cardputer KProx HTTP 地址",
  "Environment variable containing the KProx API key": "存储 KProx API 密钥的环境变量",
  "Installed firmware": "已安装的固件",
  "Not configured": "尚未配置",
  "KProx (USB keyboard mode)": "KProx（USB 键盘模式）",
  "Switch keyboard Caps Lock state": "Switch 键盘大写锁定状态",
  "Not confirmed": "尚未确认",
  "Off": "关闭",
  "On": "开启",
  "USB HID gadget device": "USB HID 设备",
  "ESP32-S3 UART serial port (for example COM15)": "ESP32-S3 UART 串口（例如 COM15）",
  "Serial speed": "串口速率",
  "115200 baud / 8N1": "115200 波特率 / 8N1",
  "Delay after each key (1-1000 ms)": "每次按键后的延迟（1–1000 毫秒）",
  "Letter case correction / 大小写反转补偿": "大小写反转补偿",
  "Enable only if every letter appears with reversed case on the Switch screen. Check a short sample before entering source. 仅当屏幕上的字母大小写全部颠倒时启用，并先核对短文本。": "仅当 Switch 屏幕上的字母大小写全部颠倒时启用。输入源码前请先核对短文本。",
  "Off / 关闭（默认）": "关闭（默认）",
  "Swap letter case / 反转字母大小写": "反转字母大小写",
  "USB/OTG data port connected to Switch": "USB/OTG 数据接口已连接 Switch",
  "I have connected USB/OTG to Switch": "我已将 USB/OTG 连接到 Switch",
  "Run this server on the ARM PC; its local USB gadget connects directly to Switch.": "在 ARM PC 上运行服务器，通过其本地 USB 设备直接连接 Switch。",
  "Server and applications on this Windows or Linux PC; USB keyboard on the Linux ARM PC.": "服务器和应用运行在此 Windows 或 Linux 电脑上；USB 键盘功能运行在 Linux ARM PC 上。",
  "Server on this PC; Cardputer ADV runs KProx and sends USB keyboard input.": "服务器运行在此电脑上；Cardputer ADV 运行 KProx 并发送 USB 键盘输入。",
  "Server on this PC; existing ESP32-S3 TextKeyboard receives text over UART and sends USB keyboard input to Switch.": "服务器运行在此电脑上；现有 ESP32-S3 TextKeyboard 通过 UART 接收文本，再向 Switch 发送 USB 键盘输入。",
  "ARM PC · server + input": "ARM PC · 服务器 + 输入",
  "ARM PC · input": "ARM PC · 输入",
  "Cardputer ADV · input": "Cardputer ADV · 输入",
  "ESP32-S3 serial input": "ESP32-S3 串口输入",
  "USB/OTG connection confirmation": "USB/OTG 连接确认",
  "Coming soon": "即将支持",
  "ARM PC: server + USB input": "ARM PC：服务器 + USB 输入",
  "ARM PC USB gadget": "ARM PC USB 设备",
  "Live console folders and FTP file transfers": "实时浏览主机文件夹并通过 FTP 传输文件",
  "PC + ESP32-S3": "电脑 + ESP32-S3",
  "PC (Windows / Linux)": "电脑（Windows / Linux）",
  "ns2jb by pepsipu": "ns2jb（pepsipu）",
  "ns2jb by kurumuz": "ns2jb（kurumuz）",
  "ESP32-S3 input job is running": "ESP32-S3 输入任务正在运行",
  "Serial connection is unavailable; close other senders using this port": "串口连接不可用；请关闭占用此端口的其他发送程序",
  "USB/OTG connection confirmed by you; firmware does not report live HID readiness": "你已确认 USB/OTG 连接；固件不提供 HID 实时就绪状态",
  "Confirm the ESP32-S3 USB/OTG data port is connected to Switch": "请确认 ESP32-S3 的 USB/OTG 数据接口已连接到 Switch",
  "Choose a COM port or a local /dev serial device": "请选择 COM 端口或本地 /dev 串口设备",
  "Select the ESP32-S3 UART serial port.": "请选择 ESP32-S3 UART 串口。",
  "Select the ESP32-S3 UART serial port": "请选择 ESP32-S3 UART 串口",
  "TextKeyboard requires 115200 baud": "TextKeyboard 需要使用 115200 波特率",
  "Key delay must be 1-1000 ms": "按键延迟必须为 1–1000 毫秒",
  "Choose whether to swap letter case": "请选择是否反转字母大小写",
  "Confirm the USB/OTG connection setting": "请确认 USB/OTG 连接设置",
  "Confirm the USB/OTG data cable is connected to Switch before typing": "开始输入前，请确认 USB/OTG 数据线已连接 Switch",
  "Serial device is not ESP32-S3 TextKeyboard": "串口设备不是 ESP32-S3 TextKeyboard",
  "Firmware is missing MAX/KEY_HOLD capabilities": "固件缺少 MAX/KEY_HOLD 功能信息",
  "Expected TextKeyboard TYPE2=1, CAPS_FIX=1 and KEY_HOLD>=20": "需要 TextKeyboard 支持 TYPE2=1、CAPS_FIX=1 及 KEY_HOLD>=20",
  "Incomplete serial write; text was not resent": "串口写入不完整；未重新发送文本",
  "Serial response is too long": "串口响应过长",
  "Serial response timed out; no text was retried": "串口响应超时；未重新发送文本",
  "Input job cancelled": "输入任务已取消",
  "Checking host": "正在检查电脑端",
  "Checking input service": "正在检查输入服务",
  "Waiting for USB status": "正在等待 USB 状态",
  "Checking console network": "正在检查主机网络",
  "No local server adapter for automatic console connection": "没有可用于自动连接主机的本机网卡",
  "No route to the console": "没有可通往主机的网络路由",
  "Server and console are on different networks": "服务器与主机不在同一网络",
  "Awaiting the next console connection": "等待主机再次连接",
  "Console port is already in use": "主机连接端口已被占用",
  "Multiple ARM input services found · choose the required address": "发现多个 ARM 输入服务 · 请选择所需地址",
  "Install or update the ARM input package": "请安装或更新 ARM 输入程序包",
  "USB state unavailable until ARM reconnects": "ARM 重新连接后才能获取 USB 状态",
  "Input device is busy": "输入设备正忙",
  "USB host configured": "USB 主机已配置",
  "Connect the USB data cable": "请连接 USB 数据线",
  "Waiting for the ARM PC": "正在等待 ARM PC",
  "Finish hardware configuration to continue.": "请完成硬件配置后继续。",
  "Preview · no device commands": "预览 · 不发送设备命令",
  "Checking…": "正在检查…",
  "Checking selected connection…": "正在检查所选连接…",
  "ARM PC · input service": "ARM PC · 输入服务",
  "ARM PC · local input service": "ARM PC · 本地输入服务",
  "Cardputer ADV · KProx input": "Cardputer ADV · KProx 输入",
  "LAN · console": "LAN · 主机",
  "USB keyboard is not ready": "USB 键盘尚未就绪",
  "Cardputer ADV · KProx USB keyboard": "Cardputer ADV · KProx USB 键盘",
  "Enable KProx USB keyboard and connect its data cable to Switch": "请启用 KProx USB 键盘，并将数据线连接到 Switch",
  "ARM connection failed: SSH did not respond": "ARM 连接失败：SSH 未响应",
  "Server IP address": "服务器 IP 地址",
  "Server network connection": "服务器 网络连接",
  "ARM PC IP address": "ARM PC IP 地址",
  "ARM PC network connection": "ARM PC 网络连接",
  "Console IP address": "主机 IP 地址",
  "Console network connection": "主机 网络连接",
  "Server LAN  ·  ARM PC · input LAN  ·  Console LAN": "服务器 LAN  ·  ARM PC · 输入 LAN  ·  主机 LAN",
  "Server LAN  ·  ARM PC · input LAN  ·  Console Wi-Fi": "服务器 LAN  ·  ARM PC · 输入 LAN  ·  主机 Wi-Fi",
  "Server LAN  ·  ARM PC · input LAN  ·  Console LAN + Wi-Fi": "服务器 LAN  ·  ARM PC · 输入 LAN  ·  主机 LAN + Wi-Fi",
  "Server LAN  ·  ARM PC · input LAN  ·  Console Wi-Fi + LAN": "服务器 LAN  ·  ARM PC · 输入 LAN  ·  主机 Wi-Fi + LAN",
  "Server LAN  ·  ARM PC · input Wi-Fi  ·  Console LAN": "服务器 LAN  ·  ARM PC · 输入 Wi-Fi  ·  主机 LAN",
  "Server LAN  ·  ARM PC · input Wi-Fi  ·  Console Wi-Fi": "服务器 LAN  ·  ARM PC · 输入 Wi-Fi  ·  主机 Wi-Fi",
  "Server LAN  ·  ARM PC · input Wi-Fi  ·  Console LAN + Wi-Fi": "服务器 LAN  ·  ARM PC · 输入 Wi-Fi  ·  主机 LAN + Wi-Fi",
  "Server LAN  ·  ARM PC · input Wi-Fi  ·  Console Wi-Fi + LAN": "服务器 LAN  ·  ARM PC · 输入 Wi-Fi  ·  主机 Wi-Fi + LAN",
  "Server Wi-Fi  ·  ARM PC · input LAN  ·  Console LAN": "服务器 Wi-Fi  ·  ARM PC · 输入 LAN  ·  主机 LAN",
  "Server Wi-Fi  ·  ARM PC · input LAN  ·  Console Wi-Fi": "服务器 Wi-Fi  ·  ARM PC · 输入 LAN  ·  主机 Wi-Fi",
  "Server Wi-Fi  ·  ARM PC · input LAN  ·  Console LAN + Wi-Fi": "服务器 Wi-Fi  ·  ARM PC · 输入 LAN  ·  主机 LAN + Wi-Fi",
  "Server Wi-Fi  ·  ARM PC · input LAN  ·  Console Wi-Fi + LAN": "服务器 Wi-Fi  ·  ARM PC · 输入 LAN  ·  主机 Wi-Fi + LAN",
  "Server Wi-Fi  ·  ARM PC · input Wi-Fi  ·  Console LAN": "服务器 Wi-Fi  ·  ARM PC · 输入 Wi-Fi  ·  主机 LAN",
  "Server Wi-Fi  ·  ARM PC · input Wi-Fi  ·  Console Wi-Fi": "服务器 Wi-Fi  ·  ARM PC · 输入 Wi-Fi  ·  主机 Wi-Fi",
  "Server Wi-Fi  ·  ARM PC · input Wi-Fi  ·  Console LAN + Wi-Fi": "服务器 Wi-Fi  ·  ARM PC · 输入 Wi-Fi  ·  主机 LAN + Wi-Fi",
  "Server Wi-Fi  ·  ARM PC · input Wi-Fi  ·  Console Wi-Fi + LAN": "服务器 Wi-Fi  ·  ARM PC · 输入 Wi-Fi  ·  主机 Wi-Fi + LAN",
  "Server LAN  ·  ESP32-S3 serial input Serial  ·  Console LAN": "服务器 LAN  ·  ESP32-S3 串口输入 串口  ·  主机 LAN",
  "Server LAN  ·  ESP32-S3 serial input Serial  ·  Console Wi-Fi": "服务器 LAN  ·  ESP32-S3 串口输入 串口  ·  主机 Wi-Fi",
  "Server LAN  ·  ESP32-S3 serial input Serial  ·  Console LAN + Wi-Fi": "服务器 LAN  ·  ESP32-S3 串口输入 串口  ·  主机 LAN + Wi-Fi",
  "Server LAN  ·  ESP32-S3 serial input Serial  ·  Console Wi-Fi + LAN": "服务器 LAN  ·  ESP32-S3 串口输入 串口  ·  主机 Wi-Fi + LAN",
  "Server Wi-Fi  ·  ESP32-S3 serial input Serial  ·  Console LAN": "服务器 Wi-Fi  ·  ESP32-S3 串口输入 串口  ·  主机 LAN",
  "Server Wi-Fi  ·  ESP32-S3 serial input Serial  ·  Console Wi-Fi": "服务器 Wi-Fi  ·  ESP32-S3 串口输入 串口  ·  主机 Wi-Fi",
  "Server Wi-Fi  ·  ESP32-S3 serial input Serial  ·  Console LAN + Wi-Fi": "服务器 Wi-Fi  ·  ESP32-S3 串口输入 串口  ·  主机 LAN + Wi-Fi",
  "Server Wi-Fi  ·  ESP32-S3 serial input Serial  ·  Console Wi-Fi + LAN": "服务器 Wi-Fi  ·  ESP32-S3 串口输入 串口  ·  主机 Wi-Fi + LAN",
  "Server LAN  ·  Cardputer ADV · input LAN  ·  Console LAN": "服务器 LAN  ·  Cardputer ADV · 输入 LAN  ·  主机 LAN",
  "Server LAN  ·  Cardputer ADV · input LAN  ·  Console Wi-Fi": "服务器 LAN  ·  Cardputer ADV · 输入 LAN  ·  主机 Wi-Fi",
  "Server LAN  ·  Cardputer ADV · input LAN  ·  Console LAN + Wi-Fi": "服务器 LAN  ·  Cardputer ADV · 输入 LAN  ·  主机 LAN + Wi-Fi",
  "Server LAN  ·  Cardputer ADV · input LAN  ·  Console Wi-Fi + LAN": "服务器 LAN  ·  Cardputer ADV · 输入 LAN  ·  主机 Wi-Fi + LAN",
  "Server LAN  ·  Cardputer ADV · input Wi-Fi  ·  Console LAN": "服务器 LAN  ·  Cardputer ADV · 输入 Wi-Fi  ·  主机 LAN",
  "Server LAN  ·  Cardputer ADV · input Wi-Fi  ·  Console Wi-Fi": "服务器 LAN  ·  Cardputer ADV · 输入 Wi-Fi  ·  主机 Wi-Fi",
  "Server LAN  ·  Cardputer ADV · input Wi-Fi  ·  Console LAN + Wi-Fi": "服务器 LAN  ·  Cardputer ADV · 输入 Wi-Fi  ·  主机 LAN + Wi-Fi",
  "Server LAN  ·  Cardputer ADV · input Wi-Fi  ·  Console Wi-Fi + LAN": "服务器 LAN  ·  Cardputer ADV · 输入 Wi-Fi  ·  主机 Wi-Fi + LAN",
  "Server Wi-Fi  ·  Cardputer ADV · input LAN  ·  Console LAN": "服务器 Wi-Fi  ·  Cardputer ADV · 输入 LAN  ·  主机 LAN",
  "Server Wi-Fi  ·  Cardputer ADV · input LAN  ·  Console Wi-Fi": "服务器 Wi-Fi  ·  Cardputer ADV · 输入 LAN  ·  主机 Wi-Fi",
  "Server Wi-Fi  ·  Cardputer ADV · input LAN  ·  Console LAN + Wi-Fi": "服务器 Wi-Fi  ·  Cardputer ADV · 输入 LAN  ·  主机 LAN + Wi-Fi",
  "Server Wi-Fi  ·  Cardputer ADV · input LAN  ·  Console Wi-Fi + LAN": "服务器 Wi-Fi  ·  Cardputer ADV · 输入 LAN  ·  主机 Wi-Fi + LAN",
  "Server Wi-Fi  ·  Cardputer ADV · input Wi-Fi  ·  Console LAN": "服务器 Wi-Fi  ·  Cardputer ADV · 输入 Wi-Fi  ·  主机 LAN",
  "Server Wi-Fi  ·  Cardputer ADV · input Wi-Fi  ·  Console Wi-Fi": "服务器 Wi-Fi  ·  Cardputer ADV · 输入 Wi-Fi  ·  主机 Wi-Fi",
  "Server Wi-Fi  ·  Cardputer ADV · input Wi-Fi  ·  Console LAN + Wi-Fi": "服务器 Wi-Fi  ·  Cardputer ADV · 输入 Wi-Fi  ·  主机 LAN + Wi-Fi",
  "Server Wi-Fi  ·  Cardputer ADV · input Wi-Fi  ·  Console Wi-Fi + LAN": "服务器 Wi-Fi  ·  Cardputer ADV · 输入 Wi-Fi  ·  主机 Wi-Fi + LAN",
  "ARM PC · server + input LAN  ·  Console LAN": "ARM PC · 服务器 + 输入 LAN  ·  主机 LAN",
  "ARM PC · server + input LAN  ·  Console Wi-Fi": "ARM PC · 服务器 + 输入 LAN  ·  主机 Wi-Fi",
  "ARM PC · server + input LAN  ·  Console LAN + Wi-Fi": "ARM PC · 服务器 + 输入 LAN  ·  主机 LAN + Wi-Fi",
  "ARM PC · server + input LAN  ·  Console Wi-Fi + LAN": "ARM PC · 服务器 + 输入 LAN  ·  主机 Wi-Fi + LAN",
  "ARM PC · server + input Wi-Fi  ·  Console LAN": "ARM PC · 服务器 + 输入 Wi-Fi  ·  主机 LAN",
  "ARM PC · server + input Wi-Fi  ·  Console Wi-Fi": "ARM PC · 服务器 + 输入 Wi-Fi  ·  主机 Wi-Fi",
  "ARM PC · server + input Wi-Fi  ·  Console LAN + Wi-Fi": "ARM PC · 服务器 + 输入 Wi-Fi  ·  主机 LAN + Wi-Fi",
  "ARM PC · server + input Wi-Fi  ·  Console Wi-Fi + LAN": "ARM PC · 服务器 + 输入 Wi-Fi  ·  主机 Wi-Fi + LAN",
  "Language": "语言",
  "Console connection ended": "主机连接已断开",
  "Console response timed out; restart the application": "主机响应超时，请重启应用程序"
};
  const english = {
    'Letter case correction / 大小写反转补偿': 'Letter case correction',
    'Off / 关闭（默认）': 'Off (default)',
    'Swap letter case / 反转字母大小写': 'Swap letter case',
    'Enable only if every letter appears with reversed case on the Switch screen. Check a short sample before entering source. 仅当屏幕上的字母大小写全部颠倒时启用，并先核对短文本。': 'Enable only if every letter appears with reversed case on the Switch screen. Check a short sample before entering source.',
  };
  const patterns = [
  {
    "source": "^TextKeyboard protocol verified on (COM[1-9][0-9]{0,3}|/dev/[A-Za-z0-9_./-]+)$",
    "flags": "",
    "replacement": "已在 $1 验证 TextKeyboard 协议"
  },
  {
    "source": "^LAN \\+ Wi-Fi · using (LAN|Wi-Fi) selected · ([0-9a-fA-F:.]+)$",
    "flags": "",
    "replacement": "LAN + Wi-Fi · 正在使用 $1（已选择） · $2"
  },
  {
    "source": "^LAN \\+ Wi-Fi · using (LAN|Wi-Fi) verified · ([0-9a-fA-F:.]+)$",
    "flags": "",
    "replacement": "LAN + Wi-Fi · 正在使用 $1（已验证） · $2"
  },
  {
    "source": "^Reachable · (LAN|Wi-Fi) selected · ([0-9a-fA-F:.]+)$",
    "flags": "",
    "replacement": "可连接 · $1（已选择） · $2"
  },
  {
    "source": "^Reachable · (LAN|Wi-Fi) verified · ([0-9a-fA-F:.]+)$",
    "flags": "",
    "replacement": "可连接 · $1（已验证） · $2"
  },
  {
    "source": "^Load ([^\\r\\n]+) at startup$",
    "flags": "",
    "replacement": "启动时加载 $1"
  },
  {
    "source": "^Automatic · waiting for Switch to connect to ([0-9a-fA-F:.]+)$",
    "flags": "",
    "replacement": "自动 · 等待 Switch 连接到 $1"
  },
  {
    "source": "^Set the console (LAN|Wi-Fi) address$",
    "flags": "",
    "replacement": "请设置主机的 $1 地址"
  },
  {
    "source": "^Console is on (LAN|Wi-Fi) · switch the connection or connect via (LAN|Wi-Fi)$",
    "flags": "",
    "replacement": "主机当前使用 $1 · 请切换连接，或通过 $2 连接"
  },
  {
    "source": "^Console is not reachable via (LAN|Wi-Fi) · ([0-9a-fA-F:.]+)$",
    "flags": "",
    "replacement": "无法通过 $1 连接主机 · $2"
  },
  {
    "source": "^No active (LAN|Wi-Fi) address on this PC$",
    "flags": "",
    "replacement": "此电脑上没有可用的 $1 地址"
  },
  {
    "source": "^This PC address uses (LAN|Wi-Fi)$",
    "flags": "",
    "replacement": "此电脑地址使用 $1"
  },
  {
    "source": "^Set the ARM PC (LAN|Wi-Fi) address, or install its IZ2S discovery service$",
    "flags": "",
    "replacement": "请设置 ARM PC 的 $1 地址，或安装 IZ2S 发现服务"
  },
  {
    "source": "^ARM PC is on (LAN|Wi-Fi) · select that connection$",
    "flags": "",
    "replacement": "ARM PC 当前使用 $1 · 请选择该连接"
  },
  {
    "source": "^Input module installed · (LAN|Wi-Fi) · ([0-9a-fA-F:.]+)$",
    "flags": "",
    "replacement": "输入模块已安装 · $1 · $2"
  },
  {
    "source": "^Input module installed · (LAN|Wi-Fi) · local input$",
    "flags": "",
    "replacement": "输入模块已安装 · $1 · 本地输入"
  },
  {
    "source": "^Input module ready · (LAN|Wi-Fi) · ([0-9a-fA-F:.]+)$",
    "flags": "",
    "replacement": "输入模块已就绪 · $1 · $2"
  },
  {
    "source": "^Input module ready · (LAN|Wi-Fi) · local input$",
    "flags": "",
    "replacement": "输入模块已就绪 · $1 · 本地输入"
  },
  {
    "source": "^ARM PC is not reachable · ([0-9a-fA-F:.]+)$",
    "flags": "",
    "replacement": "无法连接 ARM PC · $1"
  },
  {
    "source": "^ARM PC is not reachable · (LAN|Wi-Fi) address needed$",
    "flags": "",
    "replacement": "无法连接 ARM PC · 需要 $1 地址"
  },
  {
    "source": "^Timed out waiting for (READY|QUEUED|DONE|identity); no text was retried$",
    "flags": "",
    "replacement": "等待 $1 超时；未重新发送文本"
  },
  {
    "source": "^(\\d+) selected$",
    "flags": "",
    "replacement": "已选择 $1 项"
  },
  {
    "source": "^Install ([^\\r\\n]+)$",
    "flags": "",
    "replacement": "安装 $1"
  },
  {
    "source": "^Waiting for (\\d+) device checks$",
    "flags": "",
    "replacement": "等待 $1 项设备检查"
  },
  {
    "source": "^(\\d+) lines$",
    "flags": "",
    "replacement": "$1 行"
  },
  {
    "source": "^Save ((?!as )[^\\r\\n]+)$",
    "flags": "",
    "replacement": "保存 $1"
  },
  {
    "source": "^(\\d+) · lines (\\d+)–(\\d+)$",
    "flags": "",
    "replacement": "$1 · 第 $2–$3 行"
  },
  {
    "source": "^The check finished without errors\\. SOURCE LINES shows (\\d+), or (\\d+) with only one empty final line\\.$",
    "flags": "",
    "replacement": "检查已完成且无错误。SOURCE LINES 应显示 $1；若末尾仅多出一个空行，也可以是 $2。"
  },
  {
    "source": "^Save as ([^\\r\\n]+)$",
    "flags": "",
    "replacement": "另存为 $1"
  },
  {
    "source": "^([^\\r\\n]+) was saved successfully on the console\\.$",
    "flags": "",
    "replacement": "$1 已成功保存到主机。"
  },
  {
    "source": "^([^\\r\\n]+) is selected for the next launch\\.$",
    "flags": "",
    "replacement": "下次启动将使用 $1。"
  },
  {
    "source": "^In SmileBASIC, choose Make a Program and open Direct mode \\(the black console screen\\)\\. Slot (\\d+) must be empty\\. I will enter LIST (\\d+):1 first, then the original (\\d+) lines\\.$",
    "flags": "",
    "replacement": "在 SmileBASIC 中选择 Make a Program，再打开 Direct 模式（黑色命令画面）。槽位 $1 必须为空。系统会先输入 LIST $2:1，再输入原版的 $3 行源码。"
  },
  {
    "source": "^Entering the original source into EDIT(\\d+)\\. Keep SmileBASIC open and do not switch screens\\.$",
    "flags": "",
    "replacement": "正在向 EDIT$1 输入原版源码。请保持 SmileBASIC 打开，不要切换画面。"
  },
  {
    "source": "^In SmileBASIC, choose Make a Program and open Direct mode \\(the black console screen\\)\\. Slot (\\d+) must be empty\\. I will enter LIST (\\d+):1 first, then the recovery (\\d+) lines\\.$",
    "flags": "",
    "replacement": "在 SmileBASIC 中选择 Make a Program，再打开 Direct 模式（黑色命令画面）。槽位 $1 必须为空。系统会先输入 LIST $2:1，再输入恢复版的 $3 行源码。"
  },
  {
    "source": "^Entering the recovery source into EDIT(\\d+)\\. Keep SmileBASIC open and do not switch screens\\.$",
    "flags": "",
    "replacement": "正在向 EDIT$1 输入恢复版源码。请保持 SmileBASIC 打开，不要切换画面。"
  },
  {
    "source": "^Are all (\\d+) source lines present, with END on the last source line\\? An empty line (\\d+) after the final Enter is normal\\. The three-part source check is optional\\.$",
    "flags": "",
    "replacement": "是否已输入全部 $1 行源码，且最后一行是 END？最后一次回车后出现空白的第 $2 行属于正常情况。可选择进行三段式源码检查。"
  },
  {
    "source": "^Ready to save the source as ([^\\r\\n]+)\\. Saving is a separate action and never starts the bootstrap\\.$",
    "flags": "",
    "replacement": "准备将源码保存为 $1。保存是独立操作，不会启动引导程序。"
  },
  {
    "source": "^Has SmileBASIC saved ([^\\r\\n]+) successfully\\? Confirm the result on the Switch before continuing\\.$",
    "flags": "",
    "replacement": "SmileBASIC 是否已成功保存 $1？请先在 Switch 上确认结果，再继续。"
  },
  {
    "source": "^I opened fresh SmileBASIC → Make a Program → Direct, slot (\\d+) is empty, keyboard is English \\(US\\), Caps Lock is off\\.$",
    "flags": "",
    "replacement": "我已重新打开 SmileBASIC → Make a Program → Direct，槽位 $1 为空，键盘为 English (US)，大写锁定已关闭。"
  },
  {
    "source": "^All (\\d+) source lines are present, the last source line is END, and I left the console in the editor\\.$",
    "flags": "",
    "replacement": "全部 $1 行源码已输入，最后一行是 END，主机已停留在编辑器。"
  },
  {
    "source": "^All (\\d+) source lines are present, the last source line is END, and I left the console in Direct mode\\.$",
    "flags": "",
    "replacement": "全部 $1 行源码已输入，最后一行是 END，主机已停留在Direct 模式。"
  },
  {
    "source": "^All three parts match the entered readings\\. The next button enters SAVE “TXT:([^”\\r\\n]+)” in Direct\\. · (SAVE \"TXT:[^\\r\\n]+)$",
    "flags": "",
    "replacement": "三个部分均与输入的读数一致。下一按钮将在 Direct 中输入 SAVE “TXT:$1”。 · $2"
  },
  {
    "source": "^You skipped the optional check\\. The received source remains unverified\\. The next button enters SAVE “TXT:([^”\\r\\n]+)” in Direct\\. · (SAVE \"TXT:[^\\r\\n]+)$",
    "flags": "",
    "replacement": "已跳过可选检查，接收的源码尚未校验。下一按钮将在 Direct 中输入 SAVE “TXT:$1”。 · $2"
  },
  {
    "source": "^Part (\\d+) · lines (\\d+)–(\\d+) · Matches$",
    "flags": "",
    "replacement": "第 $1 部分 · 第 $2–$3 行 · 一致"
  },
  {
    "source": "^Part (\\d+) · lines (\\d+)–(\\d+) · Mismatch$",
    "flags": "",
    "replacement": "第 $1 部分 · 第 $2–$3 行 · 不一致"
  },
  {
    "source": "^Characters: (\\d+) / expected (\\d+)$",
    "flags": "",
    "replacement": "字符数：$1 / 预期 $2"
  },
  {
    "source": "^Checksum: (\\d+) / expected (\\d+)$",
    "flags": "",
    "replacement": "校验和：$1 / 预期 $2"
  },
  {
    "source": "^Text storage: (\\d+) / expected (\\d+) bytes \\(UTF-16, derived\\)$",
    "flags": "",
    "replacement": "文本存储：$1 / 预期 $2 字节（按 UTF-16 计算）"
  },
  {
    "source": "^Console (LAN|Wi-Fi) IP address$",
    "flags": "",
    "replacement": "主机 $1 IP 地址"
  },
  {
    "source": "^Enable console (LAN|Wi-Fi)$",
    "flags": "",
    "replacement": "启用主机 $1"
  },
  {
    "source": "^(LAN|Wi-Fi) · ([^\\r\\n]+) · Edit$",
    "flags": "",
    "replacement": "$1 · $2 · 编辑"
  },
  {
    "source": "^(LAN|Wi-Fi|LAN \\+ Wi-Fi|Wi-Fi \\+ LAN) · Auto / manual$",
    "flags": "",
    "replacement": "$1 · 自动 / 手动"
  },
  {
    "source": "^Auto · last known ([^\\r\\n]+)$",
    "flags": "",
    "replacement": "自动 · 上次地址 $1"
  },
  {
    "source": "^Last known · ([^\\r\\n]+) · not checked$",
    "flags": "",
    "replacement": "上次地址 · $1 · 尚未检查"
  },
  {
    "source": "^Automatic · waiting for Switch$",
    "flags": "",
    "replacement": "自动 · 等待 Switch"
  },
  {
    "source": "^Automatic · waiting for Switch · last known ([^\\r\\n]+)$",
    "flags": "",
    "replacement": "自动 · 等待 Switch · 上次地址 $1"
  },
  {
    "source": "^In use · ([0-9.]+) ms$",
    "flags": "",
    "replacement": "使用中 · $1 毫秒"
  },
  {
    "source": "^Available · ([0-9.]+) ms$",
    "flags": "",
    "replacement": "可用 · $1 毫秒"
  },
  {
    "source": "^Verified ([^\\r\\n]+); current connection not confirmed$",
    "flags": "",
    "replacement": "验证时间 $1；当前连接尚未确认"
  },
  {
    "source": "^Target folder: ([^\\r\\n]+) · service: iz2s-discovery\\.service$",
    "flags": "",
    "replacement": "目标文件夹：$1 · 服务：iz2s-discovery.service"
  },
  {
    "source": "^Last ping · ([0-9.]+) ms$",
    "flags": "",
    "replacement": "上次延迟 · $1 毫秒"
  },
  {
    "source": "^Auto · ([0-9a-fA-F:.]+) · Edit$",
    "flags": "",
    "replacement": "自动 · $1 · 编辑"
  },
  {
    "source": "^([0-9a-fA-F:.]+) · Edit$",
    "flags": "",
    "replacement": "$1 · 编辑"
  },
  {
    "source": "^Auto / manual · (LAN|Wi-Fi)$",
    "flags": "",
    "replacement": "自动 / 手动 · $1"
  },
  {
    "source": "^No active (LAN|Wi-Fi) adapter$",
    "flags": "",
    "replacement": "没有可用的 $1 网卡"
  },
  {
    "source": "^Detected on (LAN|Wi-Fi)$",
    "flags": "",
    "replacement": "在 $1 上发现"
  },
  {
    "source": "^TV mode · (\\d+) × (\\d+) · Ethernet$",
    "flags": "",
    "replacement": "电视模式 · $1 × $2 · 以太网"
  },
  {
    "source": "^TV mode · (\\d+) × (\\d+) · Ethernet · Ethernet is not connected\\.$",
    "flags": "",
    "replacement": "电视模式 · $1 × $2 · 以太网 · 以太网未连接。"
  },
  {
    "source": "^TV mode · (\\d+) × (\\d+) · Ethernet \\(disconnected\\)$",
    "flags": "",
    "replacement": "电视模式 · $1 × $2 · 以太网（已断开）"
  },
  {
    "source": "^TV mode · (\\d+) × (\\d+) · Ethernet \\(disconnected\\) · Ethernet is not connected\\.$",
    "flags": "",
    "replacement": "电视模式 · $1 × $2 · 以太网（已断开） · 以太网未连接。"
  },
  {
    "source": "^TV mode · (\\d+) × (\\d+) · Wi-Fi$",
    "flags": "",
    "replacement": "电视模式 · $1 × $2 · Wi-Fi"
  },
  {
    "source": "^TV mode · (\\d+) × (\\d+) · Wi-Fi · Ethernet is not connected\\.$",
    "flags": "",
    "replacement": "电视模式 · $1 × $2 · Wi-Fi · 以太网未连接。"
  },
  {
    "source": "^TV mode · (\\d+) × (\\d+) · Wi-Fi \\(disconnected\\)$",
    "flags": "",
    "replacement": "电视模式 · $1 × $2 · Wi-Fi（已断开）"
  },
  {
    "source": "^TV mode · (\\d+) × (\\d+) · Wi-Fi \\(disconnected\\) · Ethernet is not connected\\.$",
    "flags": "",
    "replacement": "电视模式 · $1 × $2 · Wi-Fi（已断开） · 以太网未连接。"
  },
  {
    "source": "^TV mode · (\\d+) × (\\d+) · network unknown$",
    "flags": "",
    "replacement": "电视模式 · $1 × $2 · 网络未知"
  },
  {
    "source": "^TV mode · (\\d+) × (\\d+) · network unknown · Ethernet is not connected\\.$",
    "flags": "",
    "replacement": "电视模式 · $1 × $2 · 网络未知 · 以太网未连接。"
  },
  {
    "source": "^TV mode · (\\d+) × (\\d+) · network unknown \\(disconnected\\)$",
    "flags": "",
    "replacement": "电视模式 · $1 × $2 · 网络未知（已断开）"
  },
  {
    "source": "^TV mode · (\\d+) × (\\d+) · network unknown \\(disconnected\\) · Ethernet is not connected\\.$",
    "flags": "",
    "replacement": "电视模式 · $1 × $2 · 网络未知（已断开） · 以太网未连接。"
  },
  {
    "source": "^Portable mode · (\\d+) × (\\d+) · Ethernet$",
    "flags": "",
    "replacement": "便携模式 · $1 × $2 · 以太网"
  },
  {
    "source": "^Portable mode · (\\d+) × (\\d+) · Ethernet · Ethernet is not connected\\.$",
    "flags": "",
    "replacement": "便携模式 · $1 × $2 · 以太网 · 以太网未连接。"
  },
  {
    "source": "^Portable mode · (\\d+) × (\\d+) · Ethernet \\(disconnected\\)$",
    "flags": "",
    "replacement": "便携模式 · $1 × $2 · 以太网（已断开）"
  },
  {
    "source": "^Portable mode · (\\d+) × (\\d+) · Ethernet \\(disconnected\\) · Ethernet is not connected\\.$",
    "flags": "",
    "replacement": "便携模式 · $1 × $2 · 以太网（已断开） · 以太网未连接。"
  },
  {
    "source": "^Portable mode · (\\d+) × (\\d+) · Wi-Fi$",
    "flags": "",
    "replacement": "便携模式 · $1 × $2 · Wi-Fi"
  },
  {
    "source": "^Portable mode · (\\d+) × (\\d+) · Wi-Fi · Ethernet is not connected\\.$",
    "flags": "",
    "replacement": "便携模式 · $1 × $2 · Wi-Fi · 以太网未连接。"
  },
  {
    "source": "^Portable mode · (\\d+) × (\\d+) · Wi-Fi \\(disconnected\\)$",
    "flags": "",
    "replacement": "便携模式 · $1 × $2 · Wi-Fi（已断开）"
  },
  {
    "source": "^Portable mode · (\\d+) × (\\d+) · Wi-Fi \\(disconnected\\) · Ethernet is not connected\\.$",
    "flags": "",
    "replacement": "便携模式 · $1 × $2 · Wi-Fi（已断开） · 以太网未连接。"
  },
  {
    "source": "^Portable mode · (\\d+) × (\\d+) · network unknown$",
    "flags": "",
    "replacement": "便携模式 · $1 × $2 · 网络未知"
  },
  {
    "source": "^Portable mode · (\\d+) × (\\d+) · network unknown · Ethernet is not connected\\.$",
    "flags": "",
    "replacement": "便携模式 · $1 × $2 · 网络未知 · 以太网未连接。"
  },
  {
    "source": "^Portable mode · (\\d+) × (\\d+) · network unknown \\(disconnected\\)$",
    "flags": "",
    "replacement": "便携模式 · $1 × $2 · 网络未知（已断开）"
  },
  {
    "source": "^Portable mode · (\\d+) × (\\d+) · network unknown \\(disconnected\\) · Ethernet is not connected\\.$",
    "flags": "",
    "replacement": "便携模式 · $1 × $2 · 网络未知（已断开） · 以太网未连接。"
  },
  {
    "source": "^Output mode unknown · (\\d+) × (\\d+) · Ethernet$",
    "flags": "",
    "replacement": "输出模式未知 · $1 × $2 · 以太网"
  },
  {
    "source": "^Output mode unknown · (\\d+) × (\\d+) · Ethernet · Ethernet is not connected\\.$",
    "flags": "",
    "replacement": "输出模式未知 · $1 × $2 · 以太网 · 以太网未连接。"
  },
  {
    "source": "^Output mode unknown · (\\d+) × (\\d+) · Ethernet \\(disconnected\\)$",
    "flags": "",
    "replacement": "输出模式未知 · $1 × $2 · 以太网（已断开）"
  },
  {
    "source": "^Output mode unknown · (\\d+) × (\\d+) · Ethernet \\(disconnected\\) · Ethernet is not connected\\.$",
    "flags": "",
    "replacement": "输出模式未知 · $1 × $2 · 以太网（已断开） · 以太网未连接。"
  },
  {
    "source": "^Output mode unknown · (\\d+) × (\\d+) · Wi-Fi$",
    "flags": "",
    "replacement": "输出模式未知 · $1 × $2 · Wi-Fi"
  },
  {
    "source": "^Output mode unknown · (\\d+) × (\\d+) · Wi-Fi · Ethernet is not connected\\.$",
    "flags": "",
    "replacement": "输出模式未知 · $1 × $2 · Wi-Fi · 以太网未连接。"
  },
  {
    "source": "^Output mode unknown · (\\d+) × (\\d+) · Wi-Fi \\(disconnected\\)$",
    "flags": "",
    "replacement": "输出模式未知 · $1 × $2 · Wi-Fi（已断开）"
  },
  {
    "source": "^Output mode unknown · (\\d+) × (\\d+) · Wi-Fi \\(disconnected\\) · Ethernet is not connected\\.$",
    "flags": "",
    "replacement": "输出模式未知 · $1 × $2 · Wi-Fi（已断开） · 以太网未连接。"
  },
  {
    "source": "^Output mode unknown · (\\d+) × (\\d+) · network unknown$",
    "flags": "",
    "replacement": "输出模式未知 · $1 × $2 · 网络未知"
  },
  {
    "source": "^Output mode unknown · (\\d+) × (\\d+) · network unknown · Ethernet is not connected\\.$",
    "flags": "",
    "replacement": "输出模式未知 · $1 × $2 · 网络未知 · 以太网未连接。"
  },
  {
    "source": "^Output mode unknown · (\\d+) × (\\d+) · network unknown \\(disconnected\\)$",
    "flags": "",
    "replacement": "输出模式未知 · $1 × $2 · 网络未知（已断开）"
  },
  {
    "source": "^Output mode unknown · (\\d+) × (\\d+) · network unknown \\(disconnected\\) · Ethernet is not connected\\.$",
    "flags": "",
    "replacement": "输出模式未知 · $1 × $2 · 网络未知（已断开） · 以太网未连接。"
  },
  {
    "source": "^Select ([^\\r\\n]+)$",
    "flags": "",
    "replacement": "选择 $1"
  },
  {
    "source": "^Remove ([^\\r\\n]+) from the console menu\\? You can load it again from this PC\\.$",
    "flags": "",
    "replacement": "要从主机菜单移除 $1 吗？之后可以从此电脑重新加载。"
  },
  {
    "source": "^([^\\r\\n]+) runtime folder$",
    "flags": "",
    "replacement": "$1 运行环境文件夹"
  },
  {
    "source": "^Switch 2 connected · (\\d+) selected$",
    "flags": "",
    "replacement": "Switch 2 已连接 · 已选择 $1 项"
  },
  {
    "source": "^(\\d+) events$",
    "flags": "",
    "replacement": "$1 条事件"
  },
  {
    "source": "^(\\d+) / (\\d+) lines$",
    "flags": "",
    "replacement": "$1 / $2 行"
  },
  {
    "source": "^LOAD “TXT:([^”\\r\\n]+)” → RUN → prepare memory once → connect$",
    "flags": "",
    "replacement": "LOAD “TXT:$1” → RUN → 准备一次内存 → 连接"
  },
  {
    "source": "^LOADER / ([A-Z0-9_-]+)$",
    "flags": "",
    "replacement": "加载器 / $1"
  },
  {
    "source": "^(\\d+) devices · Server \\+ input: ([^\\r\\n]+) → Console: ([^\\r\\n]+)$",
    "flags": "",
    "replacement": "$1 台设备 · 服务器 + 输入：$2 → 主机：$3"
  },
  {
    "source": "^(\\d+) devices · Server: ([^\\r\\n]+) → Input: ([^\\r\\n]+) → Console: ([^\\r\\n]+)$",
    "flags": "",
    "replacement": "$1 台设备 · 服务器：$2 → 输入：$3 → 主机：$4"
  },
  {
    "source": "^(LIST \\d+:1) → source entry → (SAVE [^\\r\\n]+)$",
    "flags": "",
    "replacement": "$1 → 输入源码 → $2"
  },
  {
    "source": "^Installation can overwrite code in slot (\\d+) and the saved file TXT:([^\\r\\n]+)\\. Back up anything you need first\\.$",
    "flags": "",
    "replacement": "安装可能覆盖槽位 $1 中的代码及已保存的 TXT:$2 文件。请先备份需要保留的内容。"
  },
  {
    "source": "^Manual installation: copy the complete repository into (engines/[^\\r\\n]+/upstream/), then choose Check manual folder\\.$",
    "flags": "",
    "replacement": "手动安装：将完整仓库复制到 $1，然后选择“检查手动安装文件夹”。"
  },
  {
    "source": "^I confirm: the selected bootstrap has been saved as ([^\\r\\n]+)\\.$",
    "flags": "",
    "replacement": "我确认：所选引导程序已保存为 $1。"
  },
  {
    "source": "^Fresh SmileBASIC Direct is open; slot (\\d+) is empty; English \\(US\\) keyboard, Caps Lock off\\.$",
    "flags": "",
    "replacement": "已重新打开 SmileBASIC Direct；槽位 $1 为空；键盘为 English (US)，大写锁定已关闭。"
  },
  {
    "source": "^The panel will load the saved file ([^\\r\\n]+) with LOAD confirmation, then enter RUN → REMOVE → START\\.$",
    "flags": "",
    "replacement": "面板将加载已保存的文件 $1，确认 LOAD 后依次输入 RUN → REMOVE → START。"
  },
  {
    "source": "^Source will be entered into empty slot (\\d+)\\. Save it separately as ([^\\r\\n]+), then restart Switch\\. Other slots remain unchanged\\.$",
    "flags": "",
    "replacement": "源码将输入到空槽位 $1。请单独保存为 $2，然后重启 Switch。其他槽位保持不变。"
  },
  {
    "source": "^Switch sources: ([0-9.]+) KiB · Server sources: ([0-9.]+) KiB\\. Server code stays on this PC\\. Upstream sources: ([0-9.]+) MiB\\. Required modules: ([^\\r\\n]+)\\. Downloaded separately: ([^\\r\\n]+)\\.$",
    "flags": "",
    "replacement": "Switch 源码：$1 KiB · 服务器源码：$2 KiB。服务器代码保留在此电脑上。 上游源码：$3 MiB。 所需模块：$4。 单独下载：$5。"
  },
  {
    "source": "^Switch sources: ([0-9.]+) KiB · Server sources: ([0-9.]+) KiB\\. Server code stays on this PC\\. Upstream sources: ([0-9.]+) MiB\\. Required modules: ([^\\r\\n]+)\\.$",
    "flags": "",
    "replacement": "Switch 源码：$1 KiB · 服务器源码：$2 KiB。服务器代码保留在此电脑上。 上游源码：$3 MiB。 所需模块：$4。"
  },
  {
    "source": "^Switch sources: ([0-9.]+) KiB · Server sources: ([0-9.]+) KiB\\. Server code stays on this PC\\. Upstream sources: ([0-9.]+) MiB\\. Downloaded separately: ([^\\r\\n]+)\\.$",
    "flags": "",
    "replacement": "Switch 源码：$1 KiB · 服务器源码：$2 KiB。服务器代码保留在此电脑上。 上游源码：$3 MiB。 单独下载：$4。"
  },
  {
    "source": "^Switch sources: ([0-9.]+) KiB · Server sources: ([0-9.]+) KiB\\. Server code stays on this PC\\. Upstream sources: ([0-9.]+) MiB\\.$",
    "flags": "",
    "replacement": "Switch 源码：$1 KiB · 服务器源码：$2 KiB。服务器代码保留在此电脑上。 上游源码：$3 MiB。"
  },
  {
    "source": "^Switch sources: ([0-9.]+) KiB · Server sources: ([0-9.]+) KiB\\. Server code stays on this PC\\. Required modules: ([^\\r\\n]+)\\. Downloaded separately: ([^\\r\\n]+)\\.$",
    "flags": "",
    "replacement": "Switch 源码：$1 KiB · 服务器源码：$2 KiB。服务器代码保留在此电脑上。 所需模块：$3。 单独下载：$4。"
  },
  {
    "source": "^Switch sources: ([0-9.]+) KiB · Server sources: ([0-9.]+) KiB\\. Server code stays on this PC\\. Required modules: ([^\\r\\n]+)\\.$",
    "flags": "",
    "replacement": "Switch 源码：$1 KiB · 服务器源码：$2 KiB。服务器代码保留在此电脑上。 所需模块：$3。"
  },
  {
    "source": "^Switch sources: ([0-9.]+) KiB · Server sources: ([0-9.]+) KiB\\. Server code stays on this PC\\. Downloaded separately: ([^\\r\\n]+)\\.$",
    "flags": "",
    "replacement": "Switch 源码：$1 KiB · 服务器源码：$2 KiB。服务器代码保留在此电脑上。 单独下载：$3。"
  },
  {
    "source": "^Switch sources: ([0-9.]+) KiB · Server sources: ([0-9.]+) KiB\\. Server code stays on this PC\\.$",
    "flags": "",
    "replacement": "Switch 源码：$1 KiB · 服务器源码：$2 KiB。服务器代码保留在此电脑上。"
  }
].map(({ source, flags, replacement }) => ({
    expression: new RegExp(source, flags), replacement,
  }));
  const storageKey = 'iz2s.language';
  const selector = document.getElementById('ui-language');
  const sources = new WeakMap();
  const attributes = ['aria-label', 'title', 'placeholder', 'alt'];
  // Keep commands, raw diagnostics and user-editable text in their original form.
  const excluded = 'script,style,code,pre,textarea,[contenteditable]:not([contenteditable="false"]),[data-i18n-ignore],#log .log-row';
  let language = /^zh\b/i.test(navigator.language || '') ? 'zh-CN' : 'en';
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'zh-CN' || saved === 'en') language = saved;
  } catch {}

  function translate(value) {
    if (typeof value !== 'string') return value;
    const text = value.trim();
    if (!text) return value;
    const dictionary = language === 'zh-CN' ? catalog : english;
    let translated = Object.hasOwn(dictionary, text) ? dictionary[text] : undefined;
    if (translated === undefined && language === 'zh-CN') {
      for (const { expression, replacement } of patterns) {
        if (expression.test(text)) {
          translated = text.replace(expression, replacement);
          break;
        }
      }
    }
    return translated === undefined ? value : value.slice(0, value.indexOf(text)) + translated + value.slice(value.indexOf(text) + text.length);
  }
  function update(node, field, read, write) {
    const current = read();
    if (current === null || current === '') return;
    let record = sources.get(node);
    if (!record) sources.set(node, record = new Map());
    const old = record.get(field);
    const source = old && current === old.rendered ? old.source : current;
    const rendered = translate(source);
    record.set(field, { source, rendered });
    if (rendered !== current) write(rendered);
  }
  function localize(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.parentElement?.closest(excluded))
        update(node, 'text', () => node.nodeValue, value => { node.nodeValue = value; });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || node.closest(excluded)) return;
    for (const name of attributes)
      update(node, name, () => node.getAttribute(name), value => node.setAttribute(name, value));
    for (const child of node.childNodes) localize(child);
  }
  const observation = { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attributes };
  const observer = new MutationObserver(records => {
    observer.disconnect();
    try {
      const roots = new Set();
      for (const record of records) {
        if (record.type === 'childList') for (const node of record.addedNodes) roots.add(node);
        else roots.add(record.target);
      }
      for (const root of roots) if (root.isConnected) localize(root);
    } finally { observer.observe(document.body, observation); }
  });
  function setLanguage(value) {
    if (value !== 'zh-CN' && value !== 'en') return;
    language = value;
    try { localStorage.setItem(storageKey, language); } catch {}
    observer.disconnect();
    document.documentElement.lang = language;
    if (selector) selector.value = language;
    try { localize(document.body); }
    finally { observer.observe(document.body, observation); }
  }
  window.IZ2SI18n = { translate, get language() { return language; } };
  selector?.addEventListener('change', () => setLanguage(selector.value));
  setLanguage(language);
})();
