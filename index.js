// Extension Sets — save named sets of enabled/disabled extensions and switch
// between them, with an optional per-device set that applies itself on load.
// Client-side only. The decision logic lives in sets.js (tested in Node).

import { extensionNames, extensionTypes, extension_settings, enableExtension, disableExtension, getExtensionManifest } from '../../../extensions.js';
import { saveSettings, saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';
import { snapshot, planApply, shouldAutoApply, guardAutoApply, guessDeviceLabel } from './sets.js';

const DEVICE_KEY = 'extension_sets_device'; // per browser: id, label, assigned set
const GUARD_KEY = 'extension_sets_autoapply_history'; // per tab: loop guard

let pendingApply = null; // set name currently shown in the preview

// ─────────────────────────── storage ───────────────────────────

/** Sets and "who applied last" live in ST's settings, so every device sees them. */
function store() {
    const s = (extension_settings.extension_sets ??= {});
    s.sets ??= {};
    s.lastApplied ??= null;
    return s;
}

function newId() {
    // crypto.randomUUID only exists on HTTPS/localhost; phones on plain http need the fallback.
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'dev-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function getDevice() {
    try {
        const saved = JSON.parse(localStorage.getItem(DEVICE_KEY));
        if (saved && saved.id) return saved;
    } catch { /* fall through and create one */ }
    const device = { id: newId(), label: guessDeviceLabel(navigator.userAgent), assigned: null };
    saveDevice(device);
    return device;
}

function saveDevice(device) {
    try {
        localStorage.setItem(DEVICE_KEY, JSON.stringify(device));
    } catch { /* storage unavailable: the device just won't remember its set */ }
}

// ─────────────────────────── extensions ───────────────────────────

/** This extension's own internal name, so it can never switch itself off. */
function selfName() {
    const folder = new URL(import.meta.url).pathname.split('/').slice(-2, -1)[0];
    return extensionNames.find((n) => n === `third-party/${folder}` || n.endsWith(`/${folder}`)) || null;
}

const displayName = (name) => (getExtensionManifest(name) || {}).display_name || name.replace(/^third-party\//, '');

function dependenciesOf(name) {
    const deps = (getExtensionManifest(name) || {}).dependencies;
    return Array.isArray(deps) ? deps : [];
}

function planFor(set) {
    const self = selfName();
    return planApply({
        set,
        installed: extensionNames,
        disabled: extension_settings.disabledExtensions,
        exclude: self ? [self] : [],
        getDependencies: dependenciesOf,
    });
}

function currentSnapshot() {
    const self = selfName();
    return snapshot({ installed: extensionNames, disabled: extension_settings.disabledExtensions, exclude: self ? [self] : [] });
}

/**
 * Apply a set: record this device as the last to apply, toggle what differs, save, reload.
 * The ownership record is written first so the saves triggered by each toggle include it.
 */
async function applySet(name) {
    const st = store();
    const set = st.sets[name];
    if (!set) throw new Error(`No set called “${name}”.`);
    const device = getDevice();
    const plan = planFor(set);

    st.lastApplied = { deviceId: device.id, deviceLabel: device.label, set: name, at: Date.now() };
    if (plan.isNoop) {
        await saveSettings();
        return false;
    }
    for (const n of plan.toEnable) await enableExtension(n, false);
    for (const n of plan.toDisable) await disableExtension(n, false);
    await saveSettings();
    location.reload();
    return true;
}

// ─────────────────────────── helpers ───────────────────────────

const $ = (id) => document.getElementById(id);

function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function notify(kind, message) {
    if (typeof toastr !== 'undefined') toastr[kind](message, 'Extension Sets');
    else console.log('[Extension Sets]', message);
}

const TYPE_LABELS = { system: 'built-in', global: 'global', local: 'user' };
const typeTag = (name) => (extensionTypes && TYPE_LABELS[extensionTypes[name]]) || '';

const nameList = (names) => `<ul class="es-names">${names.map((n) => `<li>${esc(displayName(n))}</li>`).join('')}</ul>`;

// ─────────────────────────── dialog ───────────────────────────

function dialogTemplate() {
    return `
    <div class="es-dialog" role="dialog" aria-modal="true" aria-labelledby="es-heading">
        <h3 id="es-heading">Extension Sets</h3>
        <p class="es-sub" id="es-summary"></p>

        <h4>This device</h4>
        <div class="es-row">
            <div class="es-field">
                <label for="es-device-label">Device name</label>
                <input type="text" class="text_pole" id="es-device-label" maxlength="30" />
            </div>
            <div class="es-field">
                <label for="es-assigned">Uses this set</label>
                <select class="text_pole" id="es-assigned"></select>
            </div>
        </div>
        <p class="es-hint">Devices share one on/off list, so a device with a set assigned switches to it when it finds another device changed things.
            It never overrides its own manual toggles.</p>

        <h4>Saved sets</h4>
        <div id="es-list"></div>

        <h4>Save the current setup as a new set</h4>
        <div class="es-row">
            <input type="text" class="text_pole" id="es-new-name" placeholder="e.g. Phone (lightweight)" maxlength="40" />
            <button type="button" class="menu_button" id="es-save-new">Save current</button>
        </div>

        <div id="es-preview"></div>

        <div class="es-actions">
            <button type="button" class="menu_button" id="es-close">Close</button>
        </div>
    </div>`;
}

function renderSummary() {
    const snap = currentSnapshot();
    $('es-summary').textContent = `Right now on this server: ${snap.enabled.length} extensions on, ${snap.disabled.length} off (built-in ones included).`;
}

function renderDevice() {
    const device = getDevice();
    const sets = Object.keys(store().sets).sort((a, b) => a.localeCompare(b));
    $('es-device-label').value = device.label;
    const select = $('es-assigned');
    select.innerHTML = `<option value="">(none — don't switch automatically)</option>` +
        sets.map((n) => `<option value="${esc(n)}"${device.assigned === n ? ' selected' : ''}>${esc(n)}</option>`).join('');
    if (device.assigned && !sets.includes(device.assigned)) select.value = '';
}

function renderList() {
    const st = store();
    const device = getDevice();
    const names = Object.keys(st.sets).sort((a, b) => a.localeCompare(b));
    const list = $('es-list');
    if (!names.length) {
        list.innerHTML = '<div class="es-empty">No sets yet. Get your extensions the way you want them on this device, then save the current setup below.</div>';
        return;
    }
    list.innerHTML = names.map((name) => {
        const set = st.sets[name];
        const badge = device.assigned === name ? '<span class="es-badge">this device</span>' : '';
        const last = st.lastApplied && st.lastApplied.set === name ? `<span class="es-badge">applied last${st.lastApplied.deviceLabel ? ' by ' + esc(st.lastApplied.deviceLabel) : ''}</span>` : '';
        return `
        <div class="es-set" data-set="${esc(name)}">
            <div class="es-set-info">
                <div class="es-set-name">${esc(name)}${badge}${last}</div>
                <div class="es-set-meta">${set.enabled.length} on · ${set.disabled.length} off${set.savedOn ? ' · saved on ' + esc(set.savedOn) : ''}</div>
            </div>
            <div class="es-set-buttons">
                <button type="button" class="menu_button" data-act="contents" title="See every extension in this set and whether it is on or off">Contents</button>
                <button type="button" class="menu_button" data-act="apply">Apply…</button>
                <button type="button" class="menu_button" data-act="update" title="Overwrite this set with the current on/off state">Update</button>
                <button type="button" class="menu_button" data-act="rename">Rename</button>
                <button type="button" class="menu_button" data-act="delete">Delete</button>
            </div>
        </div>`;
    }).join('');
}

function renderAll() {
    renderSummary();
    renderDevice();
    renderList();
}

function showPreview(name) {
    const set = store().sets[name];
    if (!set) return;
    const plan = planFor(set);
    pendingApply = name;

    let html = `<h4>Apply “${esc(name)}”?</h4>`;
    if (plan.isNoop) {
        html += '<p class="es-hint">Nothing would change: this is already how your extensions are set up.</p>';
    } else {
        if (plan.toEnable.length) html += `<div class="es-list-title">Turn on (${plan.toEnable.length})</div>${nameList(plan.toEnable)}`;
        if (plan.toDisable.length) html += `<div class="es-list-title">Turn off (${plan.toDisable.length})</div>${nameList(plan.toDisable)}`;
    }
    if (plan.warnings.length) {
        html += `<div class="es-list-title es-warn">Heads up</div><ul class="es-names es-warn">${plan.warnings
            .map((w) => `<li>${esc(displayName(w.name))} needs ${esc(displayName(w.dependency))}, which is ${w.problem}.</li>`).join('')}</ul>`;
    }
    if (plan.missing.length) {
        html += `<div class="es-list-title">Not installed on this server (ignored: ${plan.missing.length})</div>${nameList(plan.missing)}`;
    }
    html += plan.isNoop
        ? '<div class="es-actions"><button type="button" class="menu_button" id="es-preview-cancel">OK</button></div>'
        : `<p class="es-hint">SillyTavern will reload the page to apply this.</p>
           <div class="es-actions"><button type="button" class="menu_button" id="es-preview-cancel">Cancel</button>
           <button type="button" class="menu_button" id="es-preview-apply">Apply and reload</button></div>`;

    const box = $('es-preview');
    box.innerHTML = html;
    box.classList.add('es-open');
    $('es-preview-cancel').addEventListener('click', hidePreview);
    const go = $('es-preview-apply');
    if (go) go.addEventListener('click', () => confirmApply(go));
    box.scrollIntoView({ block: 'nearest' });
}

/** Every extension, not just the changes: what the set turns on, off, and what it doesn't know about. */
function showContents(name) {
    const set = store().sets[name];
    if (!set) return;
    pendingApply = null;
    const self = selfName();
    const installed = new Set(extensionNames);
    const inSet = new Set([...set.enabled, ...set.disabled]);
    const tagged = (names) => `<ul class="es-names">${names.map((n) => {
        const tag = typeTag(n);
        return `<li>${esc(displayName(n))}${tag ? ` <span class="es-badge">${tag}</span>` : ''}</li>`;
    }).join('')}</ul>`;
    const byName = (a, b) => displayName(a).localeCompare(displayName(b));

    const on = set.enabled.filter((n) => installed.has(n)).sort(byName);
    const off = set.disabled.filter((n) => installed.has(n)).sort(byName);
    const missing = [...set.enabled, ...set.disabled].filter((n) => !installed.has(n));
    const unknown = extensionNames.filter((n) => n !== self && !inSet.has(n)).sort(byName);

    let html = `<h4>“${esc(name)}” — everything in it</h4>
        <div class="es-list-title">On (${on.length})</div>${on.length ? tagged(on) : '<p class="es-hint">None.</p>'}
        <div class="es-list-title">Off (${off.length})</div>${off.length ? tagged(off) : '<p class="es-hint">None.</p>'}`;
    if (unknown.length) {
        html += `<div class="es-list-title">Not in this set (${unknown.length}) — left exactly as they are when you apply it</div>${tagged(unknown)}`;
    }
    if (missing.length) {
        html += `<div class="es-list-title">In the set but not installed here (${missing.length})</div>${nameList(missing)}`;
    }
    html += '<div class="es-actions"><button type="button" class="menu_button" id="es-preview-cancel">Close</button></div>';

    const box = $('es-preview');
    box.innerHTML = html;
    box.classList.add('es-open');
    $('es-preview-cancel').addEventListener('click', hidePreview);
    box.scrollIntoView({ block: 'nearest' });
}

function hidePreview() {
    pendingApply = null;
    $('es-preview').classList.remove('es-open');
}

async function confirmApply(button) {
    if (!pendingApply) return;
    button.disabled = true;
    button.textContent = 'Applying…';
    try {
        await applySet(pendingApply);
    } catch (e) {
        console.error('[Extension Sets] Apply failed:', e);
        notify('error', `Could not apply the set: ${e.message}`);
        button.disabled = false;
        button.textContent = 'Apply and reload';
    }
}

function onListClick(e) {
    const button = e.target.closest('button[data-act]');
    if (!button) return;
    const name = button.closest('.es-set').dataset.set;
    const st = store();
    switch (button.dataset.act) {
        case 'apply':
            showPreview(name);
            break;
        case 'contents':
            showContents(name);
            break;
        case 'update': {
            if (!confirm(`Overwrite “${name}” with the extensions' current on/off state?`)) return;
            const snap = currentSnapshot();
            st.sets[name] = { ...st.sets[name], ...snap, savedOn: getDevice().label, savedAt: Date.now() };
            saveSettingsDebounced();
            renderAll();
            notify('success', `Updated “${name}”.`);
            break;
        }
        case 'rename': {
            const next = (prompt('New name for this set:', name) || '').trim();
            if (!next || next === name) return;
            if (st.sets[next]) return notify('error', `There's already a set called “${next}”.`);
            st.sets[next] = st.sets[name];
            delete st.sets[name];
            if (st.lastApplied && st.lastApplied.set === name) st.lastApplied.set = next;
            const device = getDevice();
            if (device.assigned === name) saveDevice({ ...device, assigned: next });
            saveSettingsDebounced();
            renderAll();
            break;
        }
        case 'delete':
            if (!confirm(`Delete the set “${name}”? Your extensions themselves are not affected.`)) return;
            delete st.sets[name];
            saveSettingsDebounced();
            renderAll();
            break;
    }
}

function onSaveNew() {
    const input = $('es-new-name');
    const name = input.value.trim();
    const st = store();
    if (!name) return notify('warning', 'Give the set a name first.');
    if (st.sets[name] && !confirm(`A set called “${name}” already exists. Overwrite it?`)) return;
    st.sets[name] = { ...currentSnapshot(), savedOn: getDevice().label, savedAt: Date.now() };
    saveSettingsDebounced();
    input.value = '';
    renderAll();
    notify('success', `Saved “${name}”.`);
}

function onAssignedChange() {
    const device = getDevice();
    const value = $('es-assigned').value || null;
    saveDevice({ ...device, assigned: value });
    renderList();
    if (value) showPreview(value); // offer to switch right away
    else hidePreview();
}

function onLabelChange() {
    const label = $('es-device-label').value.trim() || guessDeviceLabel(navigator.userAgent);
    saveDevice({ ...getDevice(), label });
}

function openDialog() {
    renderAll();
    hidePreview();
    $('es-overlay').classList.add('es-open');
}

function closeDialog() {
    $('es-overlay').classList.remove('es-open');
    hidePreview();
}

function injectDialog() {
    if ($('es-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'es-overlay';
    overlay.innerHTML = dialogTemplate();
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeDialog(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('es-open')) closeDialog(); });
    $('es-close').addEventListener('click', closeDialog);
    $('es-list').addEventListener('click', onListClick);
    $('es-save-new').addEventListener('click', onSaveNew);
    $('es-new-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') onSaveNew(); });
    $('es-assigned').addEventListener('change', onAssignedChange);
    $('es-device-label').addEventListener('change', onLabelChange);
}

function injectMenuButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('es-menu-button')) return;
    const item = document.createElement('div');
    item.id = 'es-menu-button';
    item.className = 'list-group-item flex-container flexGap5';
    item.innerHTML = '<div class="fa-solid fa-layer-group extensionsMenuExtensionButton"></div> Extension Sets';
    item.addEventListener('click', openDialog);
    menu.appendChild(item);
}

// ─────────────────────────── auto-apply on load ───────────────────────────

async function autoApplyOnLoad() {
    const device = getDevice();
    const st = store();
    const decision = shouldAutoApply({ lastApplied: st.lastApplied, deviceId: device.id, assignedSet: device.assigned, sets: st.sets });
    if (!decision.apply) return;

    // Loop guard: if a save ever silently fails, never reload more than twice in two minutes.
    let history = [];
    try { history = JSON.parse(sessionStorage.getItem(GUARD_KEY)) || []; } catch { /* start fresh */ }
    const guard = guardAutoApply(history, Date.now());
    try { sessionStorage.setItem(GUARD_KEY, JSON.stringify(guard.history)); } catch { /* fine */ }
    if (!guard.allowed) {
        notify('warning', 'Skipped switching to this device’s set: it already tried twice in the last two minutes.');
        return;
    }

    const set = st.sets[device.assigned];
    if (!planFor(set).isNoop) notify('info', `Switching to “${device.assigned}” for this device…`);
    try {
        await applySet(device.assigned);
    } catch (e) {
        console.error('[Extension Sets] Auto-apply failed:', e);
        notify('error', `Could not switch to “${device.assigned}”: ${e.message}`);
    }
}

/**
 * This extension has loading_order: 1, so its own script runs very early in SillyTavern's
 * boot sequence — specifically before ST calls getSettings(), which is what marks its settings
 * system "ready" and only then fires APP_READY. Calling saveSettings() before that point doesn't
 * error: ST's own saveSettings() silently schedules a later save and returns as if it succeeded.
 * Auto-apply then reloads the page right after that fake success, before the real save has
 * landed — so the next boot sees the same stale "who applied last" data and retries, tripping
 * the loop guard. Waiting for APP_READY (fired once, at the very end of ST's startup) avoids the
 * race entirely, rather than guessing at a delay.
 */
function scheduleAutoApply(bus, types) {
    if (bus && types && types.APP_READY) {
        bus.on(types.APP_READY, autoApplyOnLoad);
        return;
    }
    return autoApplyOnLoad(); // no lifecycle event to wait on: fall back to running immediately
}

jQuery(() => {
    injectDialog();
    injectMenuButton();
    scheduleAutoApply(eventSource, event_types);
});

// Exposed for the Node glue tests (test/glue-test.mjs); ST ignores extra exports.
export { applySet, autoApplyOnLoad, scheduleAutoApply, selfName, showContents };
