import fs from 'node:fs';
import path from 'node:path';
import {
  atomicWrite,
  configDir,
  configFile,
  exists,
  presetId,
  raccoonProfile,
  readJSON,
  readText,
  sha256,
  withLock,
} from './util.js';
import { applyPatch, OWNED_LLM_KEYS, OWNED_TOP_KEYS, readLlmBlock, readSavedModels, readTopLevel } from './yaml.js';

const JOURNAL = 'journal.json';
const STATE = 'state.json';

function journalFile() {
  return path.join(configDir(), JOURNAL);
}

export function readJournal() {
  const journal = readJSON(journalFile());
  if (!journal || typeof journal !== 'object') return null;
  if (!journal.file || typeof journal.originalText !== 'string') return null;
  return journal;
}

export function readState() {
  return readJSON(path.join(configDir(), STATE)) || {};
}

export async function writeState(patch) {
  const next = { ...readState(), ...patch, updatedAt: new Date().toISOString() };
  await atomicWrite(path.join(configDir(), STATE), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * Magpie's picker shows values like `magpie/auto/gpt-6-luna`, while the connection
 * file it writes drops that prefix. Accepting both keeps the chosen model
 * recognisable no matter which side of that conversion a caller saw.
 */
export function normalizePick(value) {
  const text = String(value || '').trim();
  return text.startsWith('magpie/') ? text.slice('magpie/'.length) : text;
}

/** One preset per Magpie model, shaped exactly like the client's own entries. */
export function presetFor(model, { gateway, key }) {
  return {
    id: presetId(model.id),
    name: model.label || model.id,
    llmMode: 'remote_server',
    remoteProvider: 'openai',
    remoteBaseUrl: gateway,
    remoteApiKey: key,
    remoteModelId: model.id,
    lightweightProvider: 'openai',
    lightweightBaseUrl: '',
    lightweightApiKey: '',
    lightweightModelId: '',
    enableLightweightModel: false,
    lightweightMaxOutputTokens: 0,
    // The client's saved-model format uses 0 for an unspecified limit. Reset
    // both fields when switching to one of these models, rather than carrying
    // the previously selected model's advertised limits into its requests.
    contextWindow: model.context ?? 0,
    maxOutputTokens: model.output ?? 0,
    localLlamaAutoStart: false,
    localLlamaServerPath: '',
    localLlamaModelPath: '',
    localLlamaModelId: '',
    localLlamaPort: 11435,
    localLlamaTemplateFile: '',
    localLlamaExtraArgs: '',
    // No imageGeneration key on purpose: that preset field would override the
    // user's image model, which has nothing to do with the chat gateway.
  };
}

/**
 * Merge the Magpie catalog into the existing preset list.
 *
 * User-owned presets keep their order and their place; Magpie entries form a
 * block after them so the two kinds stay distinguishable in the menu. Entries the
 * user deleted are dropped from `ownedIds` and never re-added — the app is the
 * authority on what the menu should contain.
 */
export function mergePresets(existing, models, { gateway, key, ownedIds, suppressed, priorLabels }) {
  const ours = new Set(ownedIds || []);
  const gone = new Set(suppressed || []);
  const user = [];
  const priorMagpie = [];
  for (const item of existing) {
    if (!item || typeof item.id !== 'string') continue;
    if (ours.has(item.id)) priorMagpie.push(item);
    else user.push(item);
  }

  const priorById = new Map(priorMagpie.map((item) => [item.id, item]));
  const nextMagpie = [];
  for (const model of models) {
    const id = presetId(model.id);
    if (gone.has(id)) continue;
    const prior = priorById.get(id);
    const fresh = presetFor(model, { gateway, key });
    // A rename the user made in the app survives a catalog refresh.
    const renamed =
      prior &&
      typeof prior.name === 'string' &&
      prior.name.trim() &&
      prior.name.trim() !== String(prior.remoteModelId || '') &&
      prior.name.trim() !== String(priorLabels?.[id] ?? fresh.name);
    nextMagpie.push(renamed ? { ...fresh, name: prior.name.trim() } : fresh);
  }

  const seen = new Set();
  const presets = [];
  for (const item of [...user, ...nextMagpie]) {
    if (!item || typeof item.id !== 'string' || seen.has(item.id)) continue;
    seen.add(item.id);
    presets.push(item);
  }
  return { presets, ownedIds: nextMagpie.map((item) => item.id) };
}

/**
 * Whether an endpoint is the Magpie gateway.
 *
 * Match the configured gateway exactly; another local service is not this bridge.
 */
function gatewayCovers(baseUrl, gateway) {
  const value = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!value) return false;
  return value === String(gateway || '').replace(/\/+$/, '');
}

/** The main-model fields, as one comparable value. */
function mainModel(block) {
  return JSON.stringify([
    block.remote_base_url ?? '',
    block.remote_api_key ?? '',
    block.remote_model_id ?? '',
    block.use_default_remote_preset ?? null,
  ]);
}

function unownedText(text) {
  return applyPatch(text, {
    llm: Object.fromEntries(OWNED_LLM_KEYS.map(key => [key, undefined])),
    top: Object.fromEntries(OWNED_TOP_KEYS.map(key => [key, undefined])),
  });
}

/**
 * Write the bridge's view into Raccoon's config.
 *
 * Two things are deliberately kept apart:
 *  - the preset list, which the bridge owns and refreshes from the catalog;
 *  - the active main model, which the bridge only points at Magpie until the user
 *    makes a choice of their own in the app. After that the bridge leaves it
 *    alone, because silently switching the model back would be a bug, not a sync.
 */
export async function apply(options) {
  // One writer at a time: the plugin host and the standalone watcher both sync.
  return withLock('apply', () => applyNow(options || {}));
}

async function applyNow({ models, gateway, key, select, profile = raccoonProfile() }) {
  if (!Array.isArray(models) || !models.length) throw new Error('Magpie 模型目录为空');
  const file = configFile(profile);
  const text = readText(file);
  if (text == null) throw new Error(`Raccoon config not found: ${file}`);

  const journal = readJournal();
  if (journal && journal.file !== file) {
    throw new Error('Raccoon config path differs from the one taken over; run restore before connecting again');
  }
  const state = readState();
  const llmBefore = readLlmBlock(text);
  const existing = readSavedModels(text);

  // Presets we wrote earlier, so the ones this version no longer writes are known
  // to be ours and get cleaned up rather than mistaken for user entries.
  const previousOwned = journal?.ownedIds || [];
  const byId = new Map(models.map(model => [model.id, model]));
  const pick = normalizePick(select);
  if (pick && !byId.has(pick)) throw new Error(`Magpie 选定的模型不在实时目录中：${pick}`);
  const beforeActiveId = String(llmBefore.active_saved_model_id || '');
  const current = llmBefore.use_default_remote_preset === true ? null :
    models.find(model => presetId(model.id) === beforeActiveId) ||
    (gatewayCovers(llmBefore.remote_base_url, gateway) ? byId.get(llmBefore.remote_model_id) : null);
  if (!pick && !current && gatewayCovers(llmBefore.remote_base_url, gateway) && llmBefore.remote_model_id) {
    throw new Error(`小浣熊当前使用的 Magpie 模型已不在目录中：${llmBefore.remote_model_id}`);
  }
  const target = pick ? byId.get(pick) : current;
  const intendedId = target ? presetId(target.id) : null;

  // Only the model Magpie is set to belongs in the menu. A full catalog made the
  // list unusable, and choosing a model is Magpie's job - the menu carries the one
  // entry the app should be using, replaced in place when Magpie picks another.
  //
  // The exposed model is: Magpie's pick, else whatever Magpie model the app is
  // already on, else the first catalog entry, so the menu is never empty.
  const shown = target || models[0];
  const merged = mergePresets(existing, shown ? [shown] : [], {
    gateway,
    key,
    ownedIds: previousOwned,
    priorLabels: journal?.catalogLabels,
  });
  const mainMode = target ? 'bridge' : 'user';

  // The entry the main model follows. Only a Magpie preset may supply the
  // endpoint: adopting the user's own saved service here would silently redirect
  // their chat to the gateway with someone else's key.
  const active = merged.presets.find((item) => item.id === intendedId) || null;

  const llm = {
    user_configured: true,
    saved_models_json: JSON.stringify(merged.presets),
  };
  const top = {};

  if (mainMode === 'bridge') {
    llm.use_default_remote_preset = false;
    llm.remote_provider = 'openai';
    llm.remote_base_url = gateway;
    llm.remote_api_key = key;
    llm.remote_model_id = active.remoteModelId;
    llm.context_window = active.contextWindow;
    llm.max_output_tokens = active.maxOutputTokens;
    llm.active_saved_model_id = active.id;
    top.api_key = llm.remote_api_key;
    top.api_base = llm.remote_base_url;
    top.model = llm.remote_model_id;
    top.provider = 'openai';
    top.context_window = llm.context_window;
    top.max_output_tokens = llm.max_output_tokens;
  } else {
    // Presets only: the main model stays exactly as the user left it.
    llm.active_saved_model_id = beforeActiveId;
  }

  const nextText = applyPatch(text, { llm, top });
  const nextOwned = merged.ownedIds;
  const catalogLabels = Object.fromEntries(models.map(model => [presetId(model.id), model.label || model.id]));

  if (nextText !== text) {
    const nextJournal = journal
      ? {
          ...journal,
          version: 2,
          ownedIds: nextOwned,
          suppressed: [],
          catalogLabels,
          writtenMain: mainModel(readLlmBlock(nextText)),
          appliedAt: new Date().toISOString(),
        }
      : {
          version: 2,
          file,
          createdAt: new Date().toISOString(),
          originalText: text,
          originalActiveId: String(llmBefore.active_saved_model_id || ''),
          originalMain: mainModel(llmBefore),
          writtenMain: mainModel(readLlmBlock(nextText)),
          ownedIds: nextOwned,
          suppressed: [],
          catalogLabels,
        };
    // Journal first: a crash between the two writes must stay recoverable.
    await atomicWrite(journalFile(), `${JSON.stringify(nextJournal, null, 2)}\n`);
    await atomicWrite(file, nextText);
  } else if (
    JSON.stringify(nextOwned) !== JSON.stringify(previousOwned) ||
    JSON.stringify(catalogLabels) !== JSON.stringify(journal?.catalogLabels || {})
  ) {
    await atomicWrite(
      journalFile(),
      `${JSON.stringify({ ...journal, version: 2, ownedIds: nextOwned, suppressed: [], catalogLabels }, null, 2)}\n`,
    );
  }

  // Count how often the bridge has put its model back in charge. The count is what
  // lets a later pass tell "the app reset to builtin" apart from "the user did".
  const takeovers = mainMode === 'bridge' && state.mainMode !== 'bridge'
    ? Number(state.takeovers || 0) + 1
    : Number(state.takeovers || 0);
  await writeState({ mainMode, takeovers });

  return {
    changed: nextText !== text,
    file,
    presets: merged.presets.length,
    magpie: nextOwned.length,
    activeId: String(readLlmBlock(nextText).active_saved_model_id || ''),
    mainMode,
  };
}

/**
 * Put Raccoon's own model menu back.
 *
 * The journalled bytes are restored verbatim, which is exact. If the user changed
 * models in the app since, their newer choice is grafted onto those bytes instead
 * of being thrown away — the takeover is undone, not their settings.
 */
export async function restore(options = {}) {
  return withLock('apply', () => restoreNow(options));
}

async function restoreNow({ profile = raccoonProfile() } = {}) {
  const journal = readJournal();
  if (!journal) return { restored: false, reason: 'no takeover journal to restore' };

  const file = journal.file || configFile(profile);
  const text = readText(file);
  if (text == null) {
    await fs.promises.rm(journalFile(), { force: true });
    return { restored: false, reason: `Raccoon config no longer exists: ${file}` };
  }

  const ownedIds = new Set(journal.ownedIds || []);
  const now = readLlmBlock(text);
  const original = readLlmBlock(journal.originalText);
  const activeId = String(now.active_saved_model_id || '');
  const activeIsOurs = ownedIds.has(activeId);
  // `writtenMain` is what the bridge itself last wrote. Anything else in the file
  // is the user's own doing, whichever direction it moved.
  const baseline = journal.writtenMain ?? journal.originalMain;
  const mainMoved = mainModel(now) !== baseline;

  const keptUserModel = mainMoved && !activeIsOurs;
  const remaining = readSavedModels(text).filter(item => !ownedIds.has(item?.id));
  const originalPresets = readSavedModels(journal.originalText);
  const untouched = !keptUserModel && unownedText(text) === unownedText(journal.originalText) &&
    JSON.stringify(remaining) === JSON.stringify(originalPresets);
  let nextText = journal.originalText;
  if (!untouched) {
    const llm = { saved_models_json: JSON.stringify(remaining) };
    const top = {};
    if (!keptUserModel) {
      for (const key of OWNED_LLM_KEYS) if (key !== 'saved_models_json') llm[key] = original[key];
      const originalTop = readTopLevel(journal.originalText);
      for (const key of OWNED_TOP_KEYS) top[key] = originalTop[key];
    } else {
      Object.assign(top, { api_key: now.remote_api_key, api_base: now.remote_base_url,
        model: now.remote_model_id, provider: now.remote_provider,
        context_window: now.context_window, max_output_tokens: now.max_output_tokens });
    }
    nextText = applyPatch(text, { llm, top });
  }

  if (nextText !== text) await atomicWrite(file, nextText);
  await fs.promises.rm(journalFile(), { force: true });
  await fs.promises.rm(path.join(configDir(), STATE), { force: true });
  return { restored: true, keptUserModel, file };
}

/** Whether the bridge currently holds a journal, i.e. Raccoon is taken over. */
export function takenOver() {
  const journal = readJournal();
  return Boolean(journal && exists(journal.file));
}

/** A cheap fingerprint used both for polling and for skipping no-op work. */
export function catalogSignature(models) {
  return sha256(`full-catalog-v1\n${models.map((model) => `${model.id}:${model.label}:${model.context}:${model.output}`).join('\n')}`);
}

/**
 * Raccoon's login as it stands. Read-only: the bridge never writes this file.
 *
 * The desktop client persists snake_case keys (`access_token`, `office_identity`),
 * while its own in-memory snapshots use camelCase; both shapes are accepted so the
 * report stays truthful across client versions.
 */
export function loginState(profile = raccoonProfile()) {
  const file = path.join(profile, 'agent', 'config', 'auth.json');
  const auth = readJSON(file) || {};
  const pick = (...keys) => {
    for (const key of keys) {
      const value = key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), auth);
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };
  const token = pick('access_token', 'accessToken', 'tokens.access_token');
  const refresh = pick('refresh_token', 'refreshToken', 'tokens.refresh_token');
  const identity = pick('office_identity', 'officeIdentity');
  return { signedIn: Boolean(token || refresh), identity: identity || null, file };
}
