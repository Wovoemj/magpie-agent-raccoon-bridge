import fs from 'node:fs';
import path from 'node:path';
import { Catalog, discover } from './magpie.js';

import { apply, catalogSignature, readState, restore, takenOver, writeState } from './sync.js';
import { configDir, configFile, raccoonProfile, readJSON } from './util.js';

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
  const connection = connectionState(file);
  return `${connection.present ? 1 : 0}:${connection.enabled ? 1 : 0}:${connection.model || ''}:${connection.models}`;
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

  // The gateway is the authority on the catalog; Magpie's own `models` list is
  // only a fallback because it is trimmed to {id,name,context}.
  const found =
    catalog && catalog.snapshot && catalog.snapshot.models.length ? catalog.snapshot : await discover();
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
  if (
    !force &&
    state.signature === signature &&
    String(state.pick || '') === pick &&
    state.state === 'connected' &&
    takenOver()
  ) {
    return { action: 'unchanged', connection, models: found.models.length };
  }

  const result = await apply({
    models: found.models,
    gateway: found.gateway,
    key: found.key,
    select: connection.model || null,
    profile,
  });
  await record({
    state: 'connected',
    signature,
    pick,
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
  const catalog = new Catalog({ intervalMs: 15000, ...options });
  catalog.start();
  return catalog;
}
