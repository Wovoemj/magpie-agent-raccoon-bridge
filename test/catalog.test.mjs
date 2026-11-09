import assert from 'node:assert/strict';
import { agent, connect } from '../agent.js';
import { asModel, asModels, normalizeGateway } from '../lib/magpie.js';
import { mergePresets, normalizePick, presetFor } from '../lib/sync.js';

export default {
  'the descriptor is valid Magpie data'() {
    assert.equal(agent.id, 'raccoon-bridge');
    assert.equal(agent.format, 'json');
    assert.equal(agent.model, 'model');
    assert.ok(agent.config.endsWith('magpie-raccoon-bridge/connection.json'));
    assert.ok(agent.ua.includes('raccoon-magpie-bridge'));
    assert.match(agent.notice, /login/);
  },

  'connect answers at once with the catalog Magpie handed it'() {
    const result = connect({
      gateway: { v1: 'http://127.0.0.1:3425/v1', key: 'k' },
      model: 'auto/gpt-6-luna',
      models: [{ id: 'auto/gpt-6-luna', name: 'GPT-6 Luna', context: 922000 }],
    });
    assert.equal(result.enabled, true);
    assert.equal(result.gateway, 'http://127.0.0.1:3425/v1');
    assert.equal(result.key, 'k');
    assert.equal(result.model, 'auto/gpt-6-luna');
    assert.deepEqual(result.models, [{ id: 'auto/gpt-6-luna', name: 'GPT-6 Luna', context: 922000 }]);
  },

  'connect accepts a plain gateway string'() {
    const result = connect({ gateway: 'http://127.0.0.1:3425/v1', models: [] });
    assert.equal(result.gateway, 'http://127.0.0.1:3425/v1');
    assert.deepEqual(result.models, []);
  },

  'gateway URLs are normalised to /v1'() {
    assert.equal(normalizeGateway('127.0.0.1:3425'), 'http://127.0.0.1:3425/v1');
    assert.equal(normalizeGateway('http://127.0.0.1:3425/v1/'), 'http://127.0.0.1:3425/v1');
    assert.equal(normalizeGateway('http://127.0.0.1:3425'), 'http://127.0.0.1:3425/v1');
    assert.equal(normalizeGateway(''), null);
    assert.equal(normalizeGateway(undefined), null);
  },

  'a routing group keeps its label, context and vision flag'() {
    const model = asModel({
      id: 'auto/gpt-6-luna',
      magpie_label: 'GPT-6 Luna · routing group',
      display_name: 'GPT-6 Luna',
      context_window: 922000,
      max_output_tokens: 128000,
      modalities: { input: ['text', 'image'] },
    });
    assert.equal(model.id, 'auto/gpt-6-luna');
    assert.equal(model.label, 'GPT-6 Luna · routing group');
    assert.equal(model.context, 922000);
    assert.equal(model.output, 128000);
    assert.equal(model.vision, true);
    assert.equal(model.group, 'auto');
  },

  'a model without limits gets workable defaults, never zero'() {
    const model = asModel({ id: 'plain' });
    assert.equal(model.context, 128000);
    assert.equal(model.output, 8192);
    assert.equal(model.group, '');
  },

  'the catalog reader accepts strings, duplicates and junk'() {
    const models = asModels({ data: ['a', { id: 'a' }, { id: 'b' }, {}, null] });
    assert.deepEqual(models.map((item) => item.id), ['a', 'b']);
    assert.deepEqual(asModels({}), []);
    assert.deepEqual(asModels({ data: 'nope' }), []);
  },

  'every Magpie preset points at the same gateway and its own model'() {
    const presets = mergePresets([], asModels({
      data: [
        { id: 'auto/gpt-6-luna', magpie_label: 'GPT-6 Luna', context_window: 922000, max_output_tokens: 128000 },
        { id: 'wjapi/deepseek', magpie_label: 'DeepSeek', context_window: 256000, max_output_tokens: 64000 },
      ],
    }), { gateway: 'http://127.0.0.1:3425/v1', key: 'k', ownedIds: [] });
    assert.equal(presets.presets.length, 2);
    for (const preset of presets.presets) {
      assert.equal(preset.remoteBaseUrl, 'http://127.0.0.1:3425/v1');
      assert.equal(preset.remoteApiKey, 'k');
      assert.equal(preset.llmMode, 'remote_server');
    }
    assert.deepEqual(
      presets.presets.map((item) => item.remoteModelId),
      ['auto/gpt-6-luna', 'wjapi/deepseek'],
    );
    assert.equal(presets.presets[0].contextWindow, 922000);
    assert.equal(presets.presets[1].maxOutputTokens, 64000);
  },

  'a picker value is understood with or without the magpie/ prefix'() {
    // Magpie shows `magpie/<id>` in its own picker but writes `<id>` to the
    // connection file. Both must resolve to the same catalog model.
    assert.equal(normalizePick('magpie/auto/gpt-6-luna'), 'auto/gpt-6-luna');
    assert.equal(normalizePick('auto/gpt-6-luna'), 'auto/gpt-6-luna');
    assert.equal(normalizePick(''), '');
    assert.equal(normalizePick(undefined), '');
  },

  'a preset id is stable for the same model and unique across models'() {
    const a = presetFor({ id: 'auto/x', label: 'X', context: 1, output: 1 }, { gateway: 'g', key: 'k' }).id;
    const b = presetFor({ id: 'auto/x', label: 'X renamed', context: 9, output: 9 }, { gateway: 'g', key: 'k' }).id;
    const c = presetFor({ id: 'auto/y', label: 'Y', context: 1, output: 1 }, { gateway: 'g', key: 'k' }).id;
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^magpie-[0-9a-f]{16}$/);
  },
};
