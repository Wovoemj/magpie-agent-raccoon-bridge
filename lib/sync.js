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
import { applyPatch, readLlmBlock, readSavedModels, readTopLevel } from './yaml.js';

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
    contextWindow: model.context,
    maxOutputTokens: model.output,
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
export function mergePresets(existing, models, { gateway, key, ownedIds, suppressed }) {
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
      prior.name.trim() !== String(prior.remoteModelId || '');
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
 * A takeover left a stale loopback address behind once, and the next pass has to
 * recognise its own writing even though that port is now closed.
 */
function gatewayCovers(baseUrl, gateway) {
  const value = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!value) return false;
  if (value === String(gateway || '').replace(/\/+$/, '')) return true;
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/v1$/.test(value);
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
  const file = configFile(profile);
  const text = readText(file);
  if (text == null) throw new Error(`Raccoon config not found: ${file}`);

  const journal = readJournal();
  if (journal && journal.file !== file) {
    throw new Error('Raccoon config path differs from the one taken over; run restore before connecting again');
  }
  const state = readState();
  const llmBefore = readLlmBlock(text);
  const topBefore = readTopLevel(text);
  const existing = readSavedModels(text);

  // Presets we wrote earlier, so the ones this version no longer writes are known
  // to be ours and get cleaned up rather than mistaken for user entries.
  const present = new Set(existing.map((item) => item?.id).filter(Boolean));
  const previousOwned = journal?.ownedIds || [];

  // Only the model Magpie is actually set to belongs in the menu. Writing the
  // whole catalog made the list unusable, and switching models is Magpie's job —
  // Raccoon just needs the one entry it should be using right now.
  const pick = normalizePick(select);
  const wanted = pick && models.some((model) => model.id === pick) ? pick : null;
  const beforeActiveId = String(llmBefore.active_saved_model_id || '');

  // Carry the previous pick forward when Magpie has not chosen again, so a plain
  // refresh (or a restart) does not drop the entry the main model depends on.
  const carriedId = existing
    .filter((item) => previousOwned.includes(item?.id))
    .map((item) => String(item?.remoteModelId || ''))
    .find((id) => models.some((model) => model.id === id));
  const targetModelId = wanted || carriedId || models[0].id;
  const target = models.find((model) => model.id === targetModelId);

  // A vanished entry is only the user's deletion when it is the one we still
  // wanted to keep; everything else vanished because this version stopped writing
  // it, and must not be remembered as "deleted by hand".
  const intendedId = presetId(targetModelId);
  const vanished = previousOwned.filter((id) => !present.has(id));
  const userDeleted = vanished.filter((id) => id === intendedId);
  let suppressed = [...new Set([...(journal?.suppressed || []), ...userDeleted])];
  // An explicit pick in Magpie overrides an earlier deletion of that same entry.
  if (wanted) suppressed = suppressed.filter((id) => id !== intendedId);

  const merged = mergePresets(existing, [target], {
    gateway,
    key,
    ownedIds: previousOwned,
    suppressed,
  });

  // Who leads the main model?
  //
  // Taking it over is only justified when Magpie has an explicit pick, or when the
  // main model is already the Magpie entry (so its limits stay fresh). A model the
  // user chose in the app — a saved service of their own, or a builtin — is not
  // touched: silently switching it back would be a bug, not a sync.
  const activeIsMagpie = (id) => merged.ownedIds.includes(String(id || ''));
  let mainMode;
  if (select) mainMode = 'bridge';
  else if (state.mainMode === 'user') mainMode = 'user';
  else if (activeIsMagpie(beforeActiveId)) mainMode = 'bridge';
  else if (llmBefore.use_default_remote_preset === true) mainMode = 'bridge';
  else if (gatewayCovers(llmBefore.remote_base_url, gateway)) mainMode = 'bridge';
  else mainMode = 'user';

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
    llm.remote_model_id = active ? active.remoteModelId : targetModelId;
    llm.context_window = active ? active.contextWindow : target?.context ?? llmBefore.context_window ?? 0;
    llm.max_output_tokens = active
      ? active.maxOutputTokens
      : target?.output ?? llmBefore.max_output_tokens ?? 0;
    llm.active_saved_model_id = active ? active.id : '';
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

  if (nextText !== text) {
    const nextJournal = journal
      ? {
          ...journal,
          ownedIds: nextOwned,
          suppressed,
          writtenMain: mainModel(readLlmBlock(nextText)),
          appliedAt: new Date().toISOString(),
        }
      : {
          version: 1,
          file,
          createdAt: new Date().toISOString(),
          originalText: text,
          originalActiveId: String(llmBefore.active_saved_model_id || ''),
          originalMain: mainModel(llmBefore),
          writtenMain: mainModel(readLlmBlock(nextText)),
          ownedIds: nextOwned,
          suppressed,
        };
    // Journal first: a crash between the two writes must stay recoverable.
    await atomicWrite(journalFile(), `${JSON.stringify(nextJournal, null, 2)}\n`);
    await atomicWrite(file, nextText);
  } else if (
    JSON.stringify(nextOwned) !== JSON.stringify(previousOwned) ||
    JSON.stringify(suppressed) !== JSON.stringify(journal?.suppressed || [])
  ) {
    await atomicWrite(
      journalFile(),
      `${JSON.stringify({ ...journal, ownedIds: nextOwned, suppressed }, null, 2)}\n`,
    );
  }

  await writeState({ mainMode });

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

  let nextText = journal.originalText;
  if (mainMoved && !activeIsOurs) {
    // The user is on their own model now: keep it, only drop the Magpie entries.
    nextText = applyPatch(journal.originalText, {
      llm: {
        use_default_remote_preset: now.use_default_remote_preset ?? original.use_default_remote_preset,
        remote_provider: now.remote_provider,
        remote_base_url: now.remote_base_url,
        remote_api_key: now.remote_api_key,
        remote_model_id: now.remote_model_id,
        context_window: now.context_window,
        max_output_tokens: now.max_output_tokens,
        active_saved_model_id: activeId,
        saved_models_json: JSON.stringify(
          readSavedModels(journal.originalText).filter((item) => !ownedIds.has(item?.id)),
        ),
      },
      top: {
        api_key: now.remote_api_key,
        api_base: now.remote_base_url,
        model: now.remote_model_id,
      },
    });
  }

  if (nextText !== text) await atomicWrite(file, nextText);
  await fs.promises.rm(journalFile(), { force: true });
  await fs.promises.rm(path.join(configDir(), STATE), { force: true });
  return { restored: true, keptUserModel: mainMoved && !activeIsOurs, file };
}

/** Whether the bridge currently holds a journal, i.e. Raccoon is taken over. */
export function takenOver() {
  const journal = readJournal();
  return Boolean(journal && exists(journal.file));
}

/** A cheap fingerprint used both for polling and for skipping no-op work. */
export function catalogSignature(models) {
  return sha256(models.map((model) => `${model.id}:${model.label}:${model.context}:${model.output}`).join('\n'));
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
