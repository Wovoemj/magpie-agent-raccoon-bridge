import fs from 'node:fs';
import path from 'node:path';
import { Catalog, discover } from './magpie.js';

import {
  apply,
  catalogSignature,
  loginState,
  readState,
  restore,
  takenOver,
  writeState,
} from './sync.js';
import { atomicWrite, configDir, configFile, raccoonProfile, readJSON, readText, sha256 } from './util.js';
import { applyReport, checkinDue, checkinOnce, loadCheckin } from './checkin.js';

/**
 * Resolved per call, not at import: tests and the CLI point MAGPIE_RACCOON_CONFIG_DIR
 * at a sandbox, and a module-level constant would keep reading the real one.
 */
function connectionFile() {
  return path.join(configDir(), 'connection.json');
}

/**
 * What Magpie currently says about this agent.
 *
 * Magpie writes the object `connect()` returned into the agent's `config` file and
 * resets it to `{}` when the switch turns off, so `enabled !== true` means off.
 */
export function connectionState(file = connectionFile()) {
  const present = fs.existsSync(file);
  const raw = present ? readJSON(file) : null;
  if (!raw || typeof raw !== 'object') {
    return { file, present, enabled: false, model: null, gateway: null, key: null, models: 0 };
  }
  return {
    file,
    present,
    enabled: raw.enabled === true,
    model: raw.model || null,
    gateway: raw.gateway || null,
    key: raw.key || null,
    models: Array.isArray(raw.models) ? raw.models.length : 0,
  };
}

/** Cheap fingerprint so a poll only re-syncs when Magpie actually changed something. */
export function connectionStamp(file = connectionFile()) {
  return sha256(readText(file) ?? 'absent');
}

/** Last observable outcome, for `status` and for Magpie's own status line. */
export async function record(patch) {
  return writeState(patch);
}

/**
 * One reconcile pass.
 *
 * Turning the agent off must hand Raccoon its own menu back, so `restored` is a
 * first-class outcome rather than a cleanup detail. A failure to reach the
 * gateway keeps the previous presets in place: an empty menu is worse than a
 * stale one.
 */
export async function reconcile({ catalog, profile = raccoonProfile(), force = false } = {}) {
  const connection = connectionState();

  if (!connection.enabled) {
    if (!takenOver()) {
      return { action: 'idle', reason: 'magpie has not switched the bridge on', connection };
    }
    const result = await restore({ profile });
    await record({ state: 'restored', reason: result.reason || null });
    return { action: 'restored', connection, result };
  }

  if (!fs.existsSync(configFile(profile))) {
    await record({ state: 'error', reason: `Raccoon config not found: ${configFile(profile)}` });
    return { action: 'error', reason: 'raccoon config missing', connection };
  }

  const options = { gateway: connection.gateway, key: connection.key };
  const found = catalog ? await catalog.refresh(options) : await discover(options);
  if (!found.ok || !found.models.length) {
    const previous = readState();
    await record({
      state: 'error',
      reason: `Magpie gateway returned no models${found.notes?.length ? ` (${found.notes.join('; ')})` : ''}`,
    });
    return {
      action: 'error',
      reason: 'gateway unavailable',
      connection,
      keptPresets: previous.magpie || 0,
    };
  }

  const signature = catalogSignature(found.models);
  // The pick is part of what a sync produces, so it is part of the fingerprint:
  // switching models keeps the same catalog, and skipping it on the catalog alone
  // left the menu on the previous model.
  const pick = String(connection.model || '');
  const state = readState();
  const connectionSignature = sha256(JSON.stringify([connection.gateway, connection.key]));
  const profileSignature = sha256(readText(configFile(profile)));
  if (
    !force &&
    state.signature === signature &&
    String(state.pick || '') === pick &&
    state.connectionSignature === connectionSignature &&
    state.profileSignature === profileSignature &&
    state.state === 'connected' &&
    takenOver()
  ) {
    return { action: 'unchanged', connection, models: found.models.length };
  }

  const result = await apply({
    models: found.models,
    gateway: found.gateway,
    key: found.key,
    select: !takenOver() || String(state.pick || '') !== pick ? connection.model : null,
    profile,
  });
  await record({
    state: 'connected',
    signature,
    pick,
    connectionSignature,
    profileSignature: sha256(readText(configFile(profile))),
    gateway: found.gateway,
    models: found.models.length,
    magpie: result.magpie,
    presets: result.presets,
    mainMode: result.mainMode,
    activeId: result.activeId,
    source: found.source,
    reason: null,
  });
  return { action: result.changed ? 'patched' : 'unchanged', connection, result, models: found.models.length };
}

/** A catalog that keeps itself fresh from the gateway on a timer. */
export function liveCatalog(options = {}) {
  return new Catalog({ intervalMs: 15000, ...options });
}

/**
 * One scheduled check-in pass.
 *
 * Kept separate from `reconcile` because it has its own clock and its own failure
 * semantics: a check-in that did not land must stay pending so the next pass
 * retries, while a signed-out account waits for the user instead of hammering.
 */
export async function reconcileCheckin({ now = Date.now(), checkinFile, token, profile, force = false } = {}) {
  const file = checkinFile || path.join(configDir(), 'checkin.json');
  const state = loadCheckin(readJSON, file);
  if (!force && !checkinDue(state, now)) {
    return { action: 'idle', state };
  }
  const access = token || readDesktopToken(profile);
  const outcome = await checkinOnce({ token: access, now });
  const next = applyReport(state, outcome, now);
  await atomicWrite(file, `${JSON.stringify(next, null, 2)}
`);
  return { action: outcome.outcome, outcome, state: next };
}

/** The token the Raccoon app is signed in with. Read only; never refreshed here. */
export function readDesktopToken(profile = raccoonProfile()) {
  const file = path.join(profile, 'agent', 'config', 'auth.json');
  const auth = readJSON(file) || {};
  const value = auth.access_token || auth.accessToken;
  return typeof value === 'string' ? value : '';
}
