import path from 'node:path';
import { configDir, home, readJSON, atomicWrite, sleep } from './util.js';

// Magpie always serves its OpenAI-compatible gateway on this loopback port, and
// the bridge key it hands an agent is stable per agent, so these are only the
// fallback when no connection descriptor exists yet.
export const DEFAULT_GATEWAY = 'http://127.0.0.1:3425/v1';
export const DEFAULT_KEY = 'magpie-raccoon-bridge';

/** Files Magpie (or a sibling bridge's setup) may leave a gateway descriptor in. */
export function connectionFiles() {
  const h = home();
  return [
    path.join(configDir(), 'connection.json'),
    path.join(h, '.config', 'magpie-cursor-bridge', 'connection.json'),
  ];
}

export function ownConnectionFile() {
  return connectionFiles()[0];
}

/**
 * Only this agent's own descriptor may supply a fallback catalog.
 *
 * Another bridge's connection file is a legitimate place to find the gateway and
 * key, but its `models` are that agent's trimmed view — using them here would make
 * Raccoon show a catalog nobody verified, and would report the gateway as healthy
 * while it is actually down.
 */
export function ownsFile(file) {
  return path.resolve(file) === path.resolve(ownConnectionFile());
}

export function normalizeGateway(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let value = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  try {
    const url = new URL(value);
    if (!url.pathname || url.pathname === '/') url.pathname = '/v1';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * Turn one `/v1/models` entry into what the model menu needs.
 *
 * Magpie publishes routing groups as `auto/<group>` ids carrying a `magpie_label`,
 * plus `context_window` / `max_output_tokens` and a vision modality. Those are the
 * numbers Raccoon's per-preset fields want, so no guessing is needed.
 */
export function asModel(entry) {
  if (typeof entry === 'string') {
    return { id: entry, label: entry, context: 128000, output: 8192, vision: false, group: '' };
  }
  const id = typeof entry?.id === 'string' ? entry.id : '';
  if (!id) return null;
  const label = String(entry.magpie_label || entry.display_name || entry.name || id);
  const context =
    Number(entry.max_input_tokens ?? entry.context_window ?? entry.context_length) || 0;
  const output = Number(entry.max_output_tokens) || 0;
  return {
    id,
    label,
    context: context || 128000,
    output: output || 8192,
    vision: Boolean(entry?.modalities?.input?.includes?.('image')),
    group: id.includes('/') ? id.split('/')[0] : '',
    owner: typeof entry?.owned_by === 'string' ? entry.owned_by : '',
  };
}

export function asModels(payload) {
  const list = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const model = asModel(entry);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

async function fetchJSON(url, key, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the gateway from whatever Magpie left on disk, then read the live
 * catalog from the gateway itself. The connection file's `models` are only a
 * fallback: they are trimmed to {id,name,context}, while the gateway also knows
 * the output limit and vision support.
 */
export async function discover({ gateway, key, probe = true } = {}) {
  let resolvedGateway = normalizeGateway(gateway);
  let resolvedKey = typeof key === 'string' && key ? key : null;
  let fallback = [];
  const notes = [];

  for (const file of connectionFiles()) {
    const connection = readJSON(file);
    if (!connection || typeof connection !== 'object') continue;
    if (!resolvedGateway && connection.gateway) {
      resolvedGateway = normalizeGateway(connection.gateway);
      if (resolvedGateway) notes.push(`gateway from ${path.basename(file)}`);
    }
    if (!resolvedKey && typeof connection.key === 'string' && connection.key) {
      resolvedKey = connection.key;
      notes.push(`key from ${path.basename(file)}`);
    }
    if (
      ownsFile(file) &&
      !fallback.length &&
      Array.isArray(connection.models) &&
      connection.models.length
    ) {
      fallback = connection.models;
      notes.push(`fallback catalog from ${path.basename(file)}`);
    }
  }

  resolvedGateway = resolvedGateway || DEFAULT_GATEWAY;
  resolvedKey = resolvedKey || DEFAULT_KEY;

  if (probe) {
    try {
      const payload = await fetchJSON(`${resolvedGateway}/models`, resolvedKey);
      const models = asModels(payload);
      if (models.length) {
        return {
          ok: true,
          gateway: resolvedGateway,
          key: resolvedKey,
          models,
          source: 'gateway',
          notes,
          updatedAt: new Date().toISOString(),
        };
      }
      notes.push('gateway returned no models');
    } catch (error) {
      notes.push(`probe failed: ${error?.message || error}`);
    }
  }

  const models = asModels({ models: fallback });
  return {
    ok: models.length > 0,
    gateway: resolvedGateway,
    key: resolvedKey,
    models,
    source: models.length ? 'connection' : 'none',
    notes,
    updatedAt: new Date().toISOString(),
  };
}

/** A persisted descriptor, kept so a later run needs no probe to find the gateway. */
export async function saveConnection({ gateway, key, models } = {}) {
  const file = ownConnectionFile();
  const before = readJSON(file) || {};
  const payload = {
    ...before,
    gateway: normalizeGateway(gateway) || before.gateway || DEFAULT_GATEWAY,
    key: key || before.key || DEFAULT_KEY,
    enabled: true,
    updatedAt: new Date().toISOString(),
  };
  if (Array.isArray(models) && models.length) {
    payload.models = models.map((model) => ({
      id: model.id,
      name: model.label || model.name || model.id,
      context: model.context ?? null,
    }));
  }
  await atomicWrite(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

/** Keeps a live snapshot of the gateway catalog for the supervisor's poll loop. */
export class Catalog {
  constructor(options = {}) {
    this.options = { intervalMs: 15000, ...options };
    this.snapshot = {
      ok: false,
      gateway: normalizeGateway(options.gateway) || DEFAULT_GATEWAY,
      key: options.key || DEFAULT_KEY,
      models: [],
      source: 'init',
      notes: [],
      updatedAt: null,
    };
    this._timer = null;
    this._inflight = null;
  }

  async refresh() {
    if (this._inflight) return this._inflight;
    this._inflight = (async () => {
      const next = await discover(this.options);
      // A failed probe must not wipe a working catalog: an empty model menu is
      // worse than one that is a few minutes stale.
      if (next.ok || !this.snapshot.models.length) this.snapshot = next;
      else {
        this.snapshot = {
          ...this.snapshot,
          ok: true,
          notes: [...next.notes, 'kept previous catalog'],
          updatedAt: next.updatedAt,
        };
      }
      return this.snapshot;
    })()
      .catch((error) => {
        this.snapshot = {
          ...this.snapshot,
          notes: [...(this.snapshot.notes || []), String(error?.message || error)],
        };
        return this.snapshot;
      })
      .finally(() => {
        this._inflight = null;
      });
    return this._inflight;
  }

  start() {
    if (this._timer) return this;
    void this.refresh();
    this._timer = setInterval(() => void this.refresh(), this.options.intervalMs);
    this._timer.unref?.();
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  publicCatalog() {
    const snapshot = this.snapshot;
    return {
      ok: snapshot.ok,
      gateway: snapshot.gateway,
      key: snapshot.key,
      source: snapshot.source,
      updatedAt: snapshot.updatedAt,
      count: snapshot.models.length,
      groups: [...new Set(snapshot.models.map((model) => model.group).filter(Boolean))].sort(),
      models: snapshot.models,
    };
  }
}

export async function waitFor(predicate, { timeoutMs = 8000, stepMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}
