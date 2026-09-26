// Pure logic for Extension Sets: no DOM, no SillyTavern imports, so it can be
// tested in Node. Extension names are SillyTavern's internal names
// (e.g. "third-party/SillyTavern-Timelines" or built-ins like "vectors").

/** Snapshot the current on/off state of every installed extension. */
export function snapshot({ installed, disabled, exclude = [] }) {
    const skip = new Set(exclude);
    const off = new Set(disabled);
    const names = installed.filter((n) => !skip.has(n));
    return {
        enabled: names.filter((n) => !off.has(n)),
        disabled: names.filter((n) => off.has(n)),
    };
}

/**
 * Work out what applying a set would change on this machine.
 * Extensions the set doesn't know about (installed after it was saved) are left alone,
 * and names in the set that aren't installed here are reported, not errors.
 *
 * @param {object} args
 * @param {{enabled: string[], disabled: string[]}} args.set
 * @param {string[]} args.installed
 * @param {string[]} args.disabled     currently disabled names
 * @param {string[]} [args.exclude]    never touched (this extension itself)
 * @param {(name: string) => string[]} [args.getDependencies]  manifest `dependencies` of an extension
 */
export function planApply({ set, installed, disabled, exclude = [], getDependencies = () => [] }) {
    const have = new Set(installed);
    const skip = new Set(exclude);
    const off = new Set(disabled);
    const touchable = (n) => have.has(n) && !skip.has(n);

    const toEnable = set.enabled.filter((n) => touchable(n) && off.has(n));
    const toDisable = set.disabled.filter((n) => touchable(n) && !off.has(n));
    const missing = [...set.enabled, ...set.disabled].filter((n) => !have.has(n));

    // What the world looks like after applying, to catch broken dependencies.
    const finalOff = new Set(off);
    toEnable.forEach((n) => finalOff.delete(n));
    toDisable.forEach((n) => finalOff.add(n));
    const warnings = [];
    for (const name of installed) {
        if (skip.has(name) || finalOff.has(name)) continue;
        for (const dep of getDependencies(name) || []) {
            if (!have.has(dep)) warnings.push({ name, dependency: dep, problem: 'not installed' });
            else if (finalOff.has(dep)) warnings.push({ name, dependency: dep, problem: 'turned off' });
        }
    }

    return { toEnable, toDisable, missing, warnings, isNoop: !toEnable.length && !toDisable.length };
}

/**
 * The shared on/off list lives on the server, so every device sees the same one.
 * Rule: the last device to apply a set owns it. A device re-applies its own set when
 * it finds the state was last applied by a different device (or under a different
 * assignment), and never on top of its own apply, so manual toggles survive reloads.
 *
 * @returns {{apply: boolean, reason: string}}
 */
export function shouldAutoApply({ lastApplied, deviceId, assignedSet, sets }) {
    if (!assignedSet) return { apply: false, reason: 'no set assigned to this device' };
    if (!sets || !sets[assignedSet]) return { apply: false, reason: 'assigned set no longer exists' };
    if (lastApplied && lastApplied.deviceId === deviceId && lastApplied.set === assignedSet) {
        return { apply: false, reason: 'this device applied it last' };
    }
    return { apply: true, reason: lastApplied && lastApplied.deviceId !== deviceId ? 'another device applied last' : 'assignment changed' };
}

/**
 * Loop guard for auto-apply: at most `max` attempts per `windowMs`, so a failed save
 * can never cause endless reloads. `history` is a list of timestamps kept in sessionStorage.
 */
export function guardAutoApply(history, now, { max = 2, windowMs = 120000 } = {}) {
    const recent = (history || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return { allowed: false, history: recent };
    return { allowed: true, history: [...recent, now] };
}

/** Short guess at a device label from the user agent, used only as a first suggestion. */
export function guessDeviceLabel(userAgent = '') {
    if (/android|iphone|ipad|mobile/i.test(userAgent)) return 'Phone';
    return 'PC';
}
