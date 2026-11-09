import assert from 'node:assert/strict';
import { applyPatch, locateOfficev3, readLlmBlock, readSavedModels, readTopLevel, scalar } from '../lib/yaml.js';

const SAMPLE = `# Box Agent Configuration
api_key: "box-agent-no-auth"
api_base: "https://xiaohuanxiong.com/api/web/llm/v2"
model: "sn-deepseek-v4-1-flash-1017"
provider: "openai"
context_window: 1000000
max_output_tokens: 100000
enable_memory: true
client_language: "zh"
officev3:
  llm:
    type: "remote_server"
    user_configured: true
    use_default_remote_preset: true
    remote_provider: "openai"
    remote_base_url: "https://xiaohuanxiong.com/api/web/llm/v2"
    remote_model_id: "sn-deepseek-v4-1-flash-1017"
    saved_models_json: "[]"
    active_saved_model_id: ""
  permissions:
    memory:
      openclaw_import: false
    filesystem:
      scope: "session_workspace"
  paths:
    session_workspace_root: "C:\\\\Users\\\\x\\\\.office-raccoon\\\\user-data"
image_generation:
  type: "remote"
  timeout: 1000
`;

export default {
  'locates the llm block without touching siblings'() {
    const rows = SAMPLE.split('\n').map((text) => ({ text, eol: '\n' }));
    const range = locateOfficev3(rows);
    assert.ok(range);
    assert.ok(range.llmStart > 0);
    assert.ok(range.llmEnd > range.llmStart);
  },

  'reads the llm block and top level scalars'() {
    const llm = readLlmBlock(SAMPLE);
    assert.equal(llm.user_configured, true);
    assert.equal(llm.remote_model_id, 'sn-deepseek-v4-1-flash-1017');
    assert.equal(llm.saved_models_json, '[]');
    const top = readTopLevel(SAMPLE);
    assert.equal(top.api_base, 'https://xiaohuanxiong.com/api/web/llm/v2');
    assert.equal(top.enable_memory, true);
  },

  'round trips an identical patch without rewriting anything'() {
    const same = applyPatch(SAMPLE, {
      llm: {
        user_configured: true,
        use_default_remote_preset: true,
        remote_model_id: 'sn-deepseek-v4-1-flash-1017',
        saved_models_json: '[]',
        active_saved_model_id: '',
      },
    });
    assert.equal(same, SAMPLE);
  },

  'only rewrites the lines it owns'() {
    const next = applyPatch(SAMPLE, {
      llm: { remote_base_url: 'http://127.0.0.1:3425/v1', active_saved_model_id: 'abc' },
      top: { api_base: 'http://127.0.0.1:3425/v1' },
    });
    assert.match(next, /^ {4}remote_base_url: "http:\/\/127\.0\.0\.1:3425\/v1"$/m);
    assert.match(next, /^api_base: "http:\/\/127\.0\.0\.1:3425\/v1"$/m);
    // Everything else is byte-identical, including the untouched comment header
    // and the unrelated blocks.
    assert.ok(next.includes('# Box Agent Configuration'));
    assert.ok(next.includes('image_generation:'));
    assert.ok(next.includes('      scope: "session_workspace"'));
    // Taken from the fixture itself, so the assertion cannot drift from it.
    const rootLine = SAMPLE.split(String.fromCharCode(10)).find((l) => l.includes('session_workspace_root'));
    assert.ok(rootLine && next.includes(rootLine));
    assert.equal(next.split('\n').length, SAMPLE.split('\n').length);
  },

  'removes a key when the value is undefined'() {
    const next = applyPatch(SAMPLE, { llm: { use_default_remote_preset: undefined } });
    assert.doesNotMatch(next, /use_default_remote_preset/);
    assert.equal(readLlmBlock(next).use_default_remote_preset, undefined);
  },

  'inserts a missing key inside the llm block, not at the end of the file'() {
    const next = applyPatch(SAMPLE, { llm: { active_saved_model_id: 'xyz' } });
    const rows = next.split('\n');
    const index = rows.findIndex((line) => line === '    active_saved_model_id: "xyz"');
    const permissions = rows.findIndex((line) => line === '  permissions:');
    assert.ok(index > 0 && index < permissions);
  },

  'creates the officev3 block when the file has none'() {
    const next = applyPatch('api_key: "x"\n', { llm: { remote_model_id: 'auto/gpt-6-luna' } });
    assert.match(next, /^officev3:$/m);
    assert.match(next, /^ {2}llm:$/m);
    assert.equal(readLlmBlock(next).remote_model_id, 'auto/gpt-6-luna');
  },

  'tolerates a preset list the client is midway through writing'() {
    const broken = SAMPLE.replace('saved_models_json: "[]"', 'saved_models_json: "[{"');
    assert.deepEqual(readSavedModels(broken), []);
  },

  'serialises scalars the way the client parses them'() {
    assert.equal(scalar('plain'), '"plain"');
    // A JSON-quoted URL round trips through the client's own JSON.parse path.
    assert.equal(JSON.parse(scalar('http://a/b')), 'http://a/b');
    assert.equal(scalar(0), '0');
    assert.equal(scalar(false), 'false');
  },

  'keeps CRLF files on CRLF'() {
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    const next = applyPatch(crlf, { llm: { active_saved_model_id: 'z' } });
    assert.ok(next.includes('\r\n'));
    assert.equal(next.split('\r\n').length, crlf.split('\r\n').length);
    assert.doesNotMatch(next, /[^\r]\n/);
  },
};
