import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { apply, loginState, mergePresets, presetFor, readJournal, readState, restore, takenOver } from '../lib/sync.js';
import { readLlmBlock, readSavedModels } from '../lib/yaml.js';
import { configFile, presetId, raccoonProfile } from '../lib/util.js';

const GATEWAY = 'http://127.0.0.1:3425/v1';
const KEY = 'magpie-raccoon-bridge';

function model(id, label, context = 400000, output = 64000) {
  return { id, label, context, output, vision: false, group: id.split('/')[0] };
}

const BASE = `# Box Agent Configuration
api_key: "box-agent-no-auth"
api_base: "https://xiaohuanxiong.com/api/web/llm/v2"
model: "sn-deepseek-v4-1-flash-1017"
provider: "openai"
context_window: 1000000
max_output_tokens: 100000
officev3:
  llm:
    type: "remote_server"
    user_configured: true
    use_default_remote_preset: true
    remote_provider: "openai"
    remote_base_url: "https://xiaohuanxiong.com/api/web/llm/v2"
    remote_api_key: ""
    remote_model_id: "sn-deepseek-v4-1-flash-1017"
    context_window: 1000000
    max_output_tokens: 100000
    saved_models_json: "[{\\"id\\":\\"mine\\",\\"name\\":\\"My own service\\",\\"remoteBaseUrl\\":\\"https://api.example.com/v1\\",\\"remoteApiKey\\":\\"sk-x\\",\\"remoteModelId\\":\\"gpt-4\\"}]"
    active_saved_model_id: "mine"
  permissions:
    filesystem:
      scope: "session_workspace"
image_generation:
  type: "remote"
  timeout: 1000
`;

/** Each test gets its own profile and state dir so nothing touches the real app. */
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raccoon-sync-'));
  const profile = path.join(root, 'profile');
  const state = path.join(root, 'state');
  fs.mkdirSync(path.join(profile, 'agent', 'config'), { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  process.env.MAGPIE_RACCOON_CONFIG_DIR = state;
  process.env.MAGPIE_RACCOON_PROFILE = profile;
  fs.writeFileSync(configFile(profile), BASE);
  t?.after?.(() => {
    delete process.env.MAGPIE_RACCOON_CONFIG_DIR;
    delete process.env.MAGPIE_RACCOON_PROFILE;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, profile, state };
}

/** Rewrite the main-model fields the way Raccoon's own model picker does. */
function pickInApp(profile, { baseUrl, key, modelId, preset }) {
  const text = fs
    .readFileSync(configFile(profile), 'utf8')
    .replace(/^( {4}remote_base_url: ).*$/m, `$1"${baseUrl}"`)
    .replace(/^( {4}remote_api_key: ).*$/m, `$1"${key}"`)
    .replace(/^( {4}remote_model_id: ).*$/m, `$1"${modelId}"`)
    .replace(/^( {4}active_saved_model_id: ).*$/m, `$1"${preset}"`)
    .replace(/^( {4}use_default_remote_preset: ).*$/m, '$1false');
  fs.writeFileSync(configFile(profile), text);
}

const read = (profile) => fs.readFileSync(configFile(profile), 'utf8');

export default {
  'a Magpie preset mirrors the catalog entry exactly'() {
    const preset = presetFor(model('auto/gpt-6-luna', 'GPT-6 Luna · routing group', 922000, 128000), {
      gateway: GATEWAY,
      key: KEY,
    });
    assert.equal(preset.remoteBaseUrl, GATEWAY);
    assert.equal(preset.remoteApiKey, KEY);
    assert.equal(preset.remoteModelId, 'auto/gpt-6-luna');
    assert.equal(preset.contextWindow, 922000);
    assert.equal(preset.maxOutputTokens, 128000);
    assert.equal(preset.remoteProvider, 'openai');
    // The image model is the user's own concern; a chat preset must not claim it.
    assert.equal('imageGeneration' in preset, false);
    assert.equal(preset.id, presetId('auto/gpt-6-luna'));
  },

  'user presets keep their place and Magpie entries follow them'() {
    const existing = [
      { id: 'mine', name: 'Mine', remoteModelId: 'gpt-4' },
      { id: 'other', name: 'Other', remoteModelId: 'x' },
    ];
    const merged = mergePresets(existing, [model('auto/a', 'A'), model('auto/b', 'B')], {
      gateway: GATEWAY,
      key: KEY,
      ownedIds: [],
    });
    assert.deepEqual(
      merged.presets.map((item) => item.id),
      ['mine', 'other', presetId('auto/a'), presetId('auto/b')],
    );
    assert.deepEqual(merged.ownedIds, [presetId('auto/a'), presetId('auto/b')]);
  },

  'a rename the user made survives a catalog refresh'() {
    const first = mergePresets([], [model('auto/a', 'A')], { gateway: GATEWAY, key: KEY, ownedIds: [] });
    const renamed = first.presets.map((item) => ({ ...item, name: 'My name for it' }));
    const second = mergePresets(renamed, [model('auto/a', 'A'), model('auto/b', 'B')], {
      gateway: GATEWAY,
      key: KEY,
      ownedIds: first.ownedIds,
    });
    assert.equal(second.presets.find((item) => item.id === presetId('auto/a')).name, 'My name for it');
    assert.equal(second.presets.length, 2);
  },

  async 'applying the catalog leaves every untouched line byte-identical'(t) {
    const { profile } = sandbox(t);
    const result = await apply({
      models: [model('auto/gpt-6-luna', 'GPT-6 Luna · routing group')],
      gateway: GATEWAY,
      key: KEY,
      select: null,
      profile,
    });
    assert.equal(result.changed, true);
    const text = read(profile);
    assert.ok(text.includes('# Box Agent Configuration'));
    assert.ok(text.includes('image_generation:'));
    assert.ok(text.includes('      scope: "session_workspace"'));
    // Same number of lines: only owned scalars were replaced, nothing was added.
    assert.equal(text.split('\n').length, BASE.split('\n').length);
    const llm = readLlmBlock(text);
    assert.equal(llm.remote_base_url, GATEWAY);
    assert.equal(llm.remote_api_key, KEY);
    assert.equal(llm.remote_model_id, 'auto/gpt-6-luna');
    assert.equal(llm.use_default_remote_preset, false);
    // The user's own preset survives untouched.
    assert.ok(readSavedModels(text).some((item) => item.id === 'mine'));
  },

  async 'a large catalog still yields exactly one menu entry'(t) {
    const { profile } = sandbox(t);
    // The whole point: Magpie may know hundreds of models, but Raccoon's menu
    // should only carry the one Magpie is set to.
    const many = Array.from({ length: 120 }, (_, index) => model(`auto/m${index}`, `Model ${index}`));
    const result = await apply({
      models: many,
      gateway: GATEWAY,
      key: KEY,
      select: 'auto/m7',
      profile,
    });
    assert.equal(result.magpie, 1);
    const presets = readSavedModels(read(profile));
    assert.equal(presets.length, 2, "one Magpie entry plus the user's own");
    assert.equal(presets.filter((item) => String(item.id).startsWith('magpie-')).length, 1);
    assert.equal(readLlmBlock(read(profile)).remote_model_id, 'auto/m7');
  },

  async 'switching the Magpie model replaces the entry instead of adding one'(t) {
    const { profile } = sandbox(t);
    const models = [model('auto/a', 'A'), model('auto/b', 'B')];
    await apply({ models, gateway: GATEWAY, key: KEY, select: 'auto/a', profile });
    assert.equal(readLlmBlock(read(profile)).remote_model_id, 'auto/a');
    await apply({ models, gateway: GATEWAY, key: KEY, select: 'auto/b', profile });
    const presets = readSavedModels(read(profile));
    assert.equal(presets.filter((item) => String(item.id).startsWith('magpie-')).length, 1);
    assert.equal(presets.find((item) => String(item.id).startsWith('magpie-')).remoteModelId, 'auto/b');
    assert.equal(readLlmBlock(read(profile)).remote_model_id, 'auto/b');
  },

  async 'restoring puts the original bytes back'(t) {
    const { profile } = sandbox(t);
    await apply({ models: [model('auto/a', 'A')], gateway: GATEWAY, key: KEY, select: null, profile });
    assert.notEqual(read(profile), BASE);
    assert.equal(takenOver(), true, 'the profile is journalled');
    const result = await restore({ profile });
    assert.equal(result.restored, true);
    assert.equal(read(profile), BASE);
    assert.equal(readJournal(), null);
    assert.equal(takenOver(), false);
  },

  async 'a model picked in the app is not overwritten by the next sync'(t) {
    const { profile } = sandbox(t);
    await apply({
      models: [model('auto/a', 'A'), model('auto/b', 'B')],
      gateway: GATEWAY,
      key: KEY,
      select: null,
      profile,
    });
    // The user picks their own saved service; the app writes the main-model fields.
    pickInApp(profile, {
      baseUrl: 'https://api.example.com/v1',
      key: 'sk-x',
      modelId: 'gpt-4',
      preset: 'mine',
    });

    const result = await apply({
      models: [model('auto/a', 'A'), model('auto/b', 'B'), model('auto/c', 'C')],
      gateway: GATEWAY,
      key: KEY,
      select: null,
      profile,
    });
    assert.equal(result.mainMode, 'user', 'the app choice is respected');
    const after = readLlmBlock(read(profile));
    assert.equal(after.remote_base_url, 'https://api.example.com/v1');
    assert.equal(after.remote_model_id, 'gpt-4');
    assert.equal(after.active_saved_model_id, 'mine');
    // One Magpie entry plus the user's own — never the whole catalog.
    const presets = readSavedModels(read(profile));
    assert.equal(presets.length, 2);
    assert.equal(presets.filter((item) => String(item.id).startsWith('magpie-')).length, 1);
  },

  async 'an explicit pick in Magpie takes the main model back'(t) {
    const { profile } = sandbox(t);
    await apply({ models: [model('auto/a', 'A')], gateway: GATEWAY, key: KEY, select: null, profile });
    pickInApp(profile, {
      baseUrl: 'https://api.example.com/v1',
      key: 'sk-x',
      modelId: 'gpt-4',
      preset: 'mine',
    });
    await apply({
      models: [model('auto/a', 'A'), model('auto/b', 'B')],
      gateway: GATEWAY,
      key: KEY,
      select: 'auto/b',
      profile,
    });
    const llm = readLlmBlock(read(profile));
    assert.equal(llm.remote_base_url, GATEWAY);
    assert.equal(llm.remote_model_id, 'auto/b');
    assert.equal(llm.active_saved_model_id, presetId('auto/b'));
  },

  async 'the entry the user deletes in the app is not re-added on the next sync'(t) {
    const { profile } = sandbox(t);
    const models = [model('auto/a', 'A'), model('auto/b', 'B')];
    await apply({ models, gateway: GATEWAY, key: KEY, select: 'auto/a', profile });

    // The app removes the single Magpie entry from the saved list.
    const goneId = presetId('auto/a');
    const kept = readSavedModels(read(profile)).filter((item) => item.id !== goneId);
    const text = read(profile).replace(
      /^( {4}saved_models_json: ).*$/m,
      `$1${JSON.stringify(JSON.stringify(kept))}`,
    );
    fs.writeFileSync(configFile(profile), text);

    await apply({ models, gateway: GATEWAY, key: KEY, select: null, profile });
    const after = readSavedModels(read(profile)).map((item) => item.id);
    assert.equal(after.includes(goneId), false, 'the deletion sticks');

    // An explicit pick in Magpie is a fresh instruction, so it comes back.
    await apply({ models, gateway: GATEWAY, key: KEY, select: 'auto/a', profile });
    assert.equal(readSavedModels(read(profile)).some((item) => item.id === goneId), true);
  },

  async 'restore keeps a model the user chose after the takeover'(t) {
    const { profile } = sandbox(t);
    await apply({ models: [model('auto/a', 'A')], gateway: GATEWAY, key: KEY, select: null, profile });
    pickInApp(profile, {
      baseUrl: 'https://api.example.com/v1',
      key: 'sk-x',
      modelId: 'gpt-4',
      preset: 'mine',
    });
    const result = await restore({ profile });
    assert.equal(result.restored, true);
    assert.equal(result.keptUserModel, true);
    const llm = readLlmBlock(read(profile));
    assert.equal(llm.remote_model_id, 'gpt-4');
    assert.equal(llm.remote_base_url, 'https://api.example.com/v1');
    // No Magpie preset is left behind; the user's own is still there.
    const presets = readSavedModels(read(profile));
    assert.equal(presets.length, 1);
    assert.equal(presets[0].id, 'mine');
  },

  async 'a second apply with an unchanged catalog is a no-op'(t) {
    const { profile } = sandbox(t);
    const models = [model('auto/a', 'A')];
    const first = await apply({ models, gateway: GATEWAY, key: KEY, select: null, profile });
    assert.equal(first.changed, true);
    const stamp = fs.statSync(configFile(profile)).mtimeMs;
    const second = await apply({ models, gateway: GATEWAY, key: KEY, select: null, profile });
    assert.equal(second.changed, false);
    assert.equal(fs.statSync(configFile(profile)).mtimeMs, stamp, 'the file is not rewritten');
  },

  async 'a missing config is reported instead of invented'(t) {
    const { profile } = sandbox(t);
    fs.rmSync(configFile(profile), { force: true });
    await assert.rejects(
      apply({ models: [model('auto/a', 'A')], gateway: GATEWAY, key: KEY, select: null, profile }),
      /Raccoon config not found/,
    );
  },

  async 'the takeover state is recorded where status can read it'(t) {
    const { profile } = sandbox(t);
    await apply({ models: [model('auto/a', 'A')], gateway: GATEWAY, key: KEY, select: 'auto/a', profile });
    const state = readState();
    assert.equal(state.mainMode, 'bridge');
    assert.equal(readLlmBlock(read(profile)).remote_model_id, 'auto/a');
    assert.equal(readJournal().writtenMain.includes('auto/a'), true, 'what the bridge wrote is recorded');
  },

  'the login is read in the shape the desktop client writes and never modified'(t) {
    const { profile } = sandbox(t);
    const file = path.join(profile, 'agent', 'config', 'auth.json');
    const auth = { access_token: 'not-a-real-token', office_identity: 'personal' };
    fs.writeFileSync(file, JSON.stringify(auth));
    const before = fs.readFileSync(file);
    const state = loginState(profile);
    assert.equal(state.signedIn, true);
    assert.equal(state.identity, 'personal');
    // Reading must have no side effect: the token is the user's, not ours.
    assert.deepEqual(fs.readFileSync(file), before);
  },

  'a client that stores camelCase tokens is understood too'(t) {
    const { profile } = sandbox(t);
    fs.writeFileSync(
      path.join(profile, 'agent', 'config', 'auth.json'),
      JSON.stringify({ accessToken: 'a.b.c', officeIdentity: 'org-7' }),
    );
    const state = loginState(profile);
    assert.equal(state.signedIn, true);
    assert.equal(state.identity, 'org-7');
  },

  'a missing auth file reads as signed out, not as an error'(t) {
    const { profile } = sandbox(t);
    const state = loginState(profile);
    assert.equal(state.signedIn, false);
    assert.equal(state.identity, null);
  },

  'the profile resolves to the real Raccoon directory'() {
    assert.ok(raccoonProfile().includes('office-raccoon'));
  },
};
