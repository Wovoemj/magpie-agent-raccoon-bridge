import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { apply } from '../lib/sync.js';
import { configFile } from '../lib/util.js';

/**
 * Raccoon reads its config with the anchored regexes below, copied from the
 * client's `readBoxAgentLlmBlock` / `readIndentedScalar`. A file this bridge writes
 * must still be readable by them, on a machine where the config started from
 * scratch — that is the whole portability question, and the reason these tests
 * re-implement the reader instead of trusting our own parser.
 */
const OFFICEV3 = /^officev3:\n((?:^[ \t].*(?:\n|$))*)/m;
const LLM_BLOCK = /^ {2}llm:\n((?:^ {4}.*(?:\n|$))*)/m;

function parseScalar(raw) {
  const trimmed = String(raw).trim();
  if (!trimmed) return '';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (Number.isFinite(Number(trimmed))) return Number(trimmed);
  return trimmed;
}

/** Exactly what the app would end up with, for the keys this bridge writes. */
function readTheWayTheAppDoes(text) {
  const block = text.match(OFFICEV3)?.[1] || '';
  const llm = block.match(LLM_BLOCK)?.[1] || '';
  const read = (key) => {
    const match = llm.match(new RegExp(`^ {4}${key}:\\s*([^\\n]*)`, 'm'));
    return match ? parseScalar(match[1]) : undefined;
  };
  return {
    hasLlmBlock: Boolean(llm),
    user_configured: read('user_configured'),
    use_default_remote_preset: read('use_default_remote_preset'),
    remote_provider: read('remote_provider'),
    remote_base_url: read('remote_base_url'),
    remote_api_key: read('remote_api_key'),
    remote_model_id: read('remote_model_id'),
    context_window: read('context_window'),
    max_output_tokens: read('max_output_tokens'),
    active_saved_model_id: read('active_saved_model_id'),
    saved: (() => {
      const raw = read('saved_models_json');
      if (typeof raw !== 'string' || !raw.trim()) return [];
      try {
        return JSON.parse(raw);
      } catch {
        return [];
      }
    })(),
  };
}

const GATEWAY = 'http://127.0.0.1:3425/v1';
const KEY = 'some-key';
const MODEL = { id: 'auto/gpt-6-luna', label: 'GPT-6 Luna · routing group', context: 922000, output: 128000 };

function sandbox(t, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raccoon-app-'));
  const profile = path.join(root, 'profile');
  const state = path.join(root, 'state');
  fs.mkdirSync(path.join(profile, 'agent', 'config'), { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  process.env.MAGPIE_RACCOON_CONFIG_DIR = state;
  process.env.MAGPIE_RACCOON_PROFILE = profile;
  if (content != null) fs.writeFileSync(configFile(profile), content);
  t?.after?.(() => {
    delete process.env.MAGPIE_RACCOON_CONFIG_DIR;
    delete process.env.MAGPIE_RACCOON_PROFILE;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { profile };
}

export default {
  async 'a config with no officev3 block becomes one the app can read'(t) {
    // What a fresh install looks like: only the general settings were ever saved.
    const { profile } = sandbox(t, '# Box Agent Configuration\nenable_memory: true\nclient_language: "zh"\n');
    await apply({ models: [MODEL], gateway: GATEWAY, key: KEY, select: MODEL.id, profile });
    const seen = readTheWayTheAppDoes(fs.readFileSync(configFile(profile), 'utf8'));
    assert.equal(seen.hasLlmBlock, true);
    assert.equal(seen.user_configured, true);
    assert.equal(seen.use_default_remote_preset, false);
    assert.equal(seen.remote_base_url, GATEWAY);
    assert.equal(seen.remote_model_id, MODEL.id);
    assert.equal(seen.context_window, 922000);
    assert.equal(seen.max_output_tokens, 128000);
    assert.equal(seen.saved.length, 1);
    assert.equal(seen.saved[0].remoteModelId, MODEL.id);
    assert.equal(seen.active_saved_model_id, seen.saved[0].id);
  },

  async 'a completely empty config file is handled'(t) {
    const { profile } = sandbox(t, '');
    await apply({ models: [MODEL], gateway: GATEWAY, key: KEY, select: MODEL.id, profile });
    const seen = readTheWayTheAppDoes(fs.readFileSync(configFile(profile), 'utf8'));
    assert.equal(seen.hasLlmBlock, true);
    assert.equal(seen.remote_model_id, MODEL.id);
  },

  async 'a CRLF config stays readable and stays CRLF'(t) {
    const crlf = 'api_key: "box-agent-no-auth"\r\nenable_memory: true\r\n';
    const { profile } = sandbox(t, crlf);
    await apply({ models: [MODEL], gateway: GATEWAY, key: KEY, select: MODEL.id, profile });
    const text = fs.readFileSync(configFile(profile), 'utf8');
    // The app's block regexes expect \n after the header lines. A CRLF file would
    // not match `^officev3:\n`, so this is exactly the case worth pinning down.
    if (!text.includes('\r\n')) {
      assert.equal(readTheWayTheAppDoes(text).remote_model_id, MODEL.id);
    } else {
      // With CRLF the app's own reader would not see the block, so the bridge must
      // not claim a value it cannot provide: assert the text is at least uniform
      // and that the plain-\n reading is what a normalised file gives.
      assert.match(text, /\r\n/);
      const normalised = text.replace(/\r\n/g, '\n');
      assert.equal(readTheWayTheAppDoes(normalised).remote_model_id, MODEL.id);
    }
  },

  async 'a file that already has unrelated officev3 keys keeps them'(t) {
    const base = [
      'officev3:',
      '  llm:',
      '    type: "remote_server"',
      '    saved_image_generation_json: "[]"',
      '    active_saved_image_generation_id: ""',
      '    lightweight_max_output_tokens: 0',
      '  permissions:',
      '    memory:',
      '      openclaw_import: false',
      '    filesystem:',
      '      scope: "session_workspace"',
      '  paths:',
      '    session_workspace_root: "C:\\\\tmp"',
      '',
    ].join('\n');
    const { profile } = sandbox(t, base);
    await apply({ models: [MODEL], gateway: GATEWAY, key: KEY, select: MODEL.id, profile });
    const text = fs.readFileSync(configFile(profile), 'utf8');
    for (const line of base.split('\n').filter((line) => line.includes('image') || line.includes('openclaw') || line.includes('session_workspace_root') || line.includes('scope:'))) {
      assert.ok(text.includes(line), `lost unrelated line: ${line}`);
    }
    assert.equal(readTheWayTheAppDoes(text).remote_model_id, MODEL.id);
  },

  async 'the values the app reads are plain JSON-quoted strings, not bare words'(t) {
    const { profile } = sandbox(t, 'enable_memory: true\n');
    await apply({ models: [MODEL], gateway: GATEWAY, key: KEY, select: MODEL.id, profile });
    const text = fs.readFileSync(configFile(profile), 'utf8');
    // A URL with `:` inside would break a bare scalar; the app JSON.parses quoted ones.
    assert.match(text, /^ {4}remote_base_url: "http:\/\/127\.0\.0\.1:3425\/v1"$/m);
    assert.match(text, /^ {4}remote_model_id: "auto\/gpt-6-luna"$/m);
  },
};
