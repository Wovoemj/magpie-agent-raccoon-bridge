import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { connectionStamp, connectionState, reconcile } from '../lib/supervise.js';
import { readJournal, readState, takenOver } from '../lib/sync.js';
import { configFile } from '../lib/util.js';
import { readLlmBlock, readSavedModels } from '../lib/yaml.js';

const GATEWAY = 'http://127.0.0.1:3425/v1';
const KEY = 'magpie-raccoon-bridge';

const BASE = `api_key: "box-agent-no-auth"
api_base: "https://xiaohuanxiong.com/api/web/llm/v2"
model: "sn-deepseek-v4-1-flash-1017"
provider: "openai"
officev3:
  llm:
    type: "remote_server"
    user_configured: true
    use_default_remote_preset: true
    remote_provider: "openai"
    remote_base_url: "https://xiaohuanxiong.com/api/web/llm/v2"
    remote_api_key: ""
    remote_model_id: "sn-deepseek-v4-1-flash-1017"
    saved_models_json: "[]"
    active_saved_model_id: ""
  permissions:
    filesystem:
      scope: "session_workspace"
`;

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raccoon-sup-'));
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
  return { root, profile, state, connection: path.join(state, 'connection.json') };
}

/** A catalog stub, so no network is involved. */
function catalogWith(models) {
  return {
    async refresh() { return this.snapshot; },
    snapshot: {
      ok: models.length > 0,
      gateway: GATEWAY,
      key: KEY,
      models,
      source: 'stub',
      notes: [],
      updatedAt: new Date().toISOString(),
    },
  };
}

const MODELS = [
  { id: 'auto/gpt-6-luna', label: 'GPT-6 Luna · routing group', context: 922000, output: 128000, group: 'auto' },
  { id: 'wjapi/deepseek', label: 'DeepSeek V4.1', context: 256000, output: 64000, group: 'wjapi' },
];

export default {
  'an unwritten connection file means the switch is off'(t) {
    const { connection } = sandbox(t);
    const state = connectionState(connection);
    assert.equal(state.present, false);
    assert.equal(state.enabled, false);
  },

  'an empty object is what Magpie writes when switched off'(t) {
    const { connection } = sandbox(t);
    fs.writeFileSync(connection, '{}');
    const state = connectionState(connection);
    assert.equal(state.present, true);
    assert.equal(state.enabled, false);
  },

  'a connection carrying enabled plus a model means on'(t) {
    const { connection } = sandbox(t);
    fs.writeFileSync(connection, JSON.stringify({ enabled: true, gateway: GATEWAY, key: KEY, model: 'auto/gpt-6-luna' }));
    const state = connectionState(connection);
    assert.equal(state.enabled, true);
    assert.equal(state.model, 'auto/gpt-6-luna');
  },

  'the stamp changes when Magpie picks another model'(t) {
    const { connection } = sandbox(t);
    fs.writeFileSync(connection, JSON.stringify({ enabled: true, model: 'a', models: [1] }));
    const first = connectionStamp(connection);
    fs.writeFileSync(connection, JSON.stringify({ enabled: true, model: 'b', models: [1] }));
    assert.notEqual(connectionStamp(connection), first);
    assert.equal(connectionStamp(connection), connectionStamp(connection));
  },

  'reconcile does nothing while Magpie has not switched the agent on'(t) {
    const { profile, connection } = sandbox(t);
    fs.writeFileSync(connection, '{}');
    return reconcile({ catalog: catalogWith(MODELS), profile }).then((result) => {
      assert.equal(result.action, 'idle');
      assert.equal(takenOver(), false);
      assert.equal(fs.readFileSync(configFile(profile), 'utf8'), BASE);
    });
  },

  'reconcile writes the catalog when the agent is on'(t) {
    const { profile, connection } = sandbox(t);
    fs.writeFileSync(connection, JSON.stringify({ enabled: true, gateway: GATEWAY, key: KEY, model: 'auto/gpt-6-luna' }));
    return reconcile({ catalog: catalogWith(MODELS), profile }).then((result) => {
      assert.equal(result.action, 'patched');
      const text = fs.readFileSync(configFile(profile), 'utf8');
      const llm = readLlmBlock(text);
      assert.equal(llm.remote_base_url, GATEWAY);
      assert.equal(llm.remote_model_id, 'auto/gpt-6-luna');
      // Only the picked model goes into the menu, not the whole catalog.
      const magpie = readSavedModels(text).filter((item) => String(item.id).startsWith('magpie-'));
      assert.equal(magpie.length, 1);
      assert.equal(magpie[0].remoteModelId, 'auto/gpt-6-luna');
      // This profile starts with no saved services, so one Magpie entry is all.
      assert.equal(readSavedModels(text).length, 1);
      assert.equal(takenOver(), true);
      assert.equal(readState().state, 'connected');
    });
  },

  'a second reconcile with the same catalog and same switch changes nothing'(t) {
    const { profile, connection } = sandbox(t);
    fs.writeFileSync(connection, JSON.stringify({ enabled: true, gateway: GATEWAY, key: KEY, model: 'auto/gpt-6-luna' }));
    return reconcile({ catalog: catalogWith(MODELS), profile })
      .then(() => reconcile({ catalog: catalogWith(MODELS), profile }))
      .then((second) => {
        assert.equal(second.action, 'unchanged');
      });
  },

  'picking a different model re-syncs even though the catalog is unchanged'(t) {
    const { profile, connection } = sandbox(t);
    fs.writeFileSync(connection, JSON.stringify({ enabled: true, gateway: GATEWAY, key: KEY, model: 'auto/gpt-6-luna' }));
    return reconcile({ catalog: catalogWith(MODELS), profile })
      .then(() => {
        assert.equal(readLlmBlock(fs.readFileSync(configFile(profile), 'utf8')).remote_model_id, 'auto/gpt-6-luna');
        // Same catalog, different pick: the de-dup key must notice the pick.
        fs.writeFileSync(connection, JSON.stringify({ enabled: true, gateway: GATEWAY, key: KEY, model: 'wjapi/deepseek' }));
        return reconcile({ catalog: catalogWith(MODELS), profile });
      })
      .then((result) => {
        assert.equal(result.action, 'patched');
        const text = fs.readFileSync(configFile(profile), 'utf8');
        assert.equal(readLlmBlock(text).remote_model_id, 'wjapi/deepseek');
        assert.equal(readSavedModels(text).filter((item) => String(item.id).startsWith('magpie-')).length, 1);
      });
  },

  'switching the agent off hands Raccoon its own menu back'(t) {
    const { profile, connection } = sandbox(t);
    fs.writeFileSync(connection, JSON.stringify({ enabled: true, gateway: GATEWAY, key: KEY, model: 'auto/gpt-6-luna' }));
    return reconcile({ catalog: catalogWith(MODELS), profile })
      .then(() => {
        assert.notEqual(fs.readFileSync(configFile(profile), 'utf8'), BASE);
        fs.writeFileSync(connection, '{}');
        return reconcile({ catalog: catalogWith(MODELS), profile });
      })
      .then((result) => {
        assert.equal(result.action, 'restored');
        assert.equal(fs.readFileSync(configFile(profile), 'utf8'), BASE);
        assert.equal(readJournal(), null);
      });
  },

  'an unreachable gateway keeps the old presets instead of emptying the menu'(t) {
    const { profile, connection } = sandbox(t);
    fs.writeFileSync(connection, JSON.stringify({ enabled: true, gateway: GATEWAY, key: KEY, model: 'auto/gpt-6-luna' }));
    return reconcile({ catalog: catalogWith(MODELS), profile })
      .then(() => {
        const before = fs.readFileSync(configFile(profile), 'utf8');
        // A closed port: discovery must fail without throwing, and the pass must
        // leave the working menu alone rather than replacing it with nothing.
        fs.writeFileSync(connection, JSON.stringify({ enabled: true, gateway: 'http://127.0.0.1:9/v1', key: KEY }));
        // No catalog stub this time: discovery really has to fail on a closed port.
        return reconcile({ profile, force: true }).then((result) => {
          assert.equal(result.action, 'error');
          assert.equal(fs.readFileSync(configFile(profile), 'utf8'), before);
        });
      });
  },

  async 'cached models do not turn a failed live refresh into a connection'(t) {
    const { profile, connection } = sandbox(t);
    fs.writeFileSync(connection, JSON.stringify({ enabled: true, gateway: GATEWAY, key: KEY, model: MODELS[0].id, models: MODELS }));
    const catalog = catalogWith(MODELS);
    await reconcile({ catalog, profile });
    const before = fs.readFileSync(configFile(profile), 'utf8');
    catalog.refresh = async () => ({ ...catalog.snapshot, ok: false, notes: ['HTTP 503'] });
    const result = await reconcile({ catalog, profile });
    assert.equal(result.action, 'error');
    assert.equal(readState().state, 'error');
    assert.match(readState().reason, /HTTP 503/);
    assert.equal(fs.readFileSync(configFile(profile), 'utf8'), before);
  },

  async 'same-sized catalog changes replace models without resetting the app pick'(t) {
    const { profile, connection } = sandbox(t);
    fs.writeFileSync(connection, JSON.stringify({ enabled: true, gateway: GATEWAY, key: KEY, model: MODELS[0].id }));
    const catalog = catalogWith(MODELS);
    await reconcile({ catalog, profile });
    catalog.snapshot.models = [MODELS[0], { ...MODELS[1], id: 'provider/new', label: 'New' }];
    await reconcile({ catalog, profile });
    const presets = readSavedModels(fs.readFileSync(configFile(profile), 'utf8'));
    // The pick did not change, so the menu still carries just that one model.
    const magpie = presets.filter(item => String(item.id).startsWith('magpie-'));
    assert.deepEqual(magpie.map(item => item.remoteModelId), [MODELS[0].id]);
  },
};
