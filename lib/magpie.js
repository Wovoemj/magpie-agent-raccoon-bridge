import path from 'node:path';
import { configDir, readJSON, atomicWrite, sleep } from './util.js';

/** Only this agent's descriptor supplies its endpoint and caller key. */
export function connectionFiles() {
  return [path.join(configDir(), 'connection.json')];
}

export function ownConnectionFile() {
  return connectionFiles()[0];
}

/** Whether a file is this bridge's own connection descriptor. */
export function ownsFile(file) {
  return path.resolve(file) === path.resolve(ownConnectionFile());
}

export function normalizeGateway(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let value = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
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
 * numbers Raccoon's per-preset fields want. Imported models may omit either
 * limit: that is optional metadata, not a broken catalog or a limit to guess.
 */
export function asModel(entry) {
  const id = typeof entry?.id === 'string' ? entry.id : '';
  if (!id.trim()) throw new Error('Magpie 模型目录包含无效模型 ID');
  const label = String(entry.magpie_label || entry.display_name || entry.name || id);
  const context = tokenLimit(entry.max_input_tokens ?? entry.context_window ?? entry.context_length, id);
  const output = tokenLimit(entry.max_output_tokens, id);
  return {
    id,
    label,
    context,
    output,
    vision: Boolean(entry?.modalities?.input?.includes?.('image')),
    group: id.includes('/') ? id.split('/')[0] : '',
    owner: typeof entry?.owned_by === 'string' ? entry.owned_by : '',
  };
}

function tokenLimit(value, id) {
  if (value === undefined || value === null || value === 0) return null;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`Magpie 模型声明了无效的上下文或输出上限：${id}`);
  }
  return limit;
}

export function asModels(payload) {
  if (!Array.isArray(payload?.data)) throw new Error('Magpie /v1/models 响应格式无效');
  const list = payload.data;
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const model = asModel(entry);
    if (seen.has(model.id)) throw new Error(`Magpie 模型目录包含重复 ID：${model.id}`);
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
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'User-Agent': 'raccoon-magpie-bridge' },
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
 * Read the live gateway catalog. A failed request remains an error even when
 * connection.json still carries a previous catalog.
 */
export async function discover({ gateway, key } = {}) {
  let resolvedGateway = normalizeGateway(gateway);
  let resolvedKey = typeof key === 'string' && key ? key : null;
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
  }
  try {
      if (!resolvedGateway || !resolvedKey) throw new Error('请先在 Magpie 的 Agent 页面连接小浣熊桥接');
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
      throw new Error('Magpie 网关返回空模型目录');
  } catch (error) {
    notes.push(`模型目录读取失败：${error?.message || error}`);
  }
  return {
    ok: false,
    gateway: resolvedGateway,
    key: resolvedKey,
    models: [],
    source: 'error',
    notes,
    updatedAt: new Date().toISOString(),
  };
}

/** A persisted descriptor, kept so a later run needs no probe to find the gateway. */
export async function saveConnection({ gateway, key, models } = {}) {
  const file = ownConnectionFile();
  const before = readJSON(file) || {};
  const resolvedGateway = normalizeGateway(gateway ?? before.gateway);
  const resolvedKey = key ?? before.key;
  if (!resolvedGateway || typeof resolvedKey !== 'string' || !resolvedKey) {
    throw new Error('不能保存缺少 Magpie 网关地址或调用密钥的连接');
  }
  const payload = {
    ...before,
    gateway: resolvedGateway,
    key: resolvedKey,
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
      gateway: normalizeGateway(options.gateway),
      key: options.key || null,
      models: [],
      source: 'init',
      notes: [],
      updatedAt: null,
    };
    this._timer = null;
    this._inflight = null;
  }

  async refresh(options = {}) {
    this.options = { ...this.options, ...options };
    if (this._inflight) return this._inflight;
    this._inflight = (async () => {
      const next = await discover(this.options);
      this.snapshot = next;
      return this.snapshot;
    })()
      .catch((error) => {
        this.snapshot = {
          ...this.snapshot,
          ok: false,
          models: [],
          source: 'error',
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
