/**
 * Line-based editor for Raccoon's `config.yaml`.
 *
 * The file is not a general YAML document: the client writes it by hand and reads
 * it back with anchored regexes (`^    key: value`), so the only compatible edit
 * is the same one — replace the scalar on its own line and leave every other line
 * byte-for-byte alone. Anything else risks the client rejecting a file it wrote
 * itself, or silently dropping settings we never touched.
 */

const LLM_INDENT = '    ';
const LLM_HEADER = '  llm:';
const CR = '\r';
const LF = '\n';

/**
 * Split into rows. A trailing CR is held separately so a bare key line still
 * compares equal in a CRLF file, while the join keeps the original endings.
 */
function lines(text) {
  const out = [];
  let start = 0;
  const push = (raw, eol) => {
    let body = raw;
    let cr = '';
    if (body.endsWith(CR)) {
      cr = CR;
      body = body.slice(0, -1);
    }
    out.push({ text: body, cr, eol });
  };
  for (let i = 0; i < text.length; i++) {
    if (text[i] === LF) {
      push(text.slice(start, i), LF);
      start = i + 1;
    }
  }
  if (start < text.length) push(text.slice(start), '');
  return out;
}

function join(rows) {
  return rows.map((row) => row.text + row.cr + row.eol).join('');
}

/** The line ending this file already uses, so an inserted line matches it. */
function eolOf(rows) {
  return rows.some((row) => row.cr === CR) ? { cr: CR, eol: LF } : { cr: '', eol: LF };
}

/** Ranges of the `officev3:` block and its `llm:` child, as [start, end) indexes. */
export function locateOfficev3(rows) {
  const top = rows.findIndex((row) => /^officev3:\s*$/.test(row.text));
  if (top < 0) return null;
  let blockEnd = rows.length;
  for (let i = top + 1; i < rows.length; i++) {
    const line = rows[i].text;
    if (!line.trim()) continue;
    if (!/^[ \t]/.test(line)) {
      blockEnd = i;
      break;
    }
  }
  let llmStart = -1;
  for (let i = top + 1; i < blockEnd; i++) {
    if (rows[i].text === LLM_HEADER) {
      llmStart = i;
      break;
    }
  }
  if (llmStart < 0) return { top, blockEnd, llmStart: -1, llmEnd: -1 };
  let llmEnd = blockEnd;
  for (let i = llmStart + 1; i < blockEnd; i++) {
    const line = rows[i].text;
    if (!line.trim()) continue;
    if (!line.startsWith(LLM_INDENT)) {
      llmEnd = i;
      break;
    }
  }
  return { top, blockEnd, llmStart, llmEnd };
}

/** Raccoon parses every quoted scalar as JSON, so serialise the same way. */
export function scalar(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function parseScalar(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  if (quoted) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  const bare = trimmed.replace(/\s+#.*$/, '').trim();
  if (bare === 'true') return true;
  if (bare === 'false') return false;
  if (bare && Number.isFinite(Number(bare))) return Number(bare);
  return bare;
}

function readRows(text) {
  return lines(String(text ?? ''));
}

/** Every indent-4 `key: value` inside `officev3.llm`, as a plain object. */
export function readLlmBlock(text) {
  const rows = readRows(text);
  const range = locateOfficev3(rows);
  if (!range || range.llmStart < 0) return {};
  const out = {};
  for (let i = range.llmStart + 1; i < range.llmEnd; i++) {
    const match = rows[i].text.match(/^ {4}([A-Za-z0-9_]+):\s?(.*)$/);
    if (match) out[match[1]] = parseScalar(match[2]);
  }
  return out;
}

/** Top-level scalars, which the client keeps as a mirror of the llm block. */
export function readTopLevel(text) {
  const out = {};
  for (const row of readRows(text)) {
    const match = row.text.match(/^([A-Za-z0-9_]+):\s?(.*)$/);
    if (match) out[match[1]] = parseScalar(match[2]);
  }
  return out;
}

function upsertInsideLlm(rows, key, value) {
  const range = locateOfficev3(rows);
  if (!range) return rows;
  if (range.llmStart < 0) {
    // No llm block yet: create it at the top of officev3, which is exactly where
    // the client puts it when it writes the block itself.
    rows.splice(range.top + 1, 0, { text: LLM_HEADER, ...eolOf(rows) });
    return upsertInsideLlm(rows, key, value);
  }
  const pattern = new RegExp(`^ {4}${key}:`);
  for (let i = range.llmStart + 1; i < range.llmEnd; i++) {
    if (!pattern.test(rows[i].text)) continue;
    if (value === undefined) {
      rows.splice(i, 1);
    } else {
      rows[i] = { ...rows[i], text: `${LLM_INDENT}${key}: ${scalar(value)}` };
    }
    return rows;
  }
  if (value === undefined) return rows;
  // Insert at the end of the llm block, never after its indent-2 siblings.
  rows.splice(range.llmEnd, 0, { text: `${LLM_INDENT}${key}: ${scalar(value)}`, ...eolOf(rows) });
  return rows;
}

function upsertTopLevel(rows, key, value) {
  const pattern = new RegExp(`^${key}:`);
  for (let i = 0; i < rows.length; i++) {
    if (!pattern.test(rows[i].text)) continue;
    if (value === undefined) {
      rows.splice(i, 1);
    } else {
      rows[i] = { ...rows[i], text: `${key}: ${scalar(value)}` };
    }
    return rows;
  }
  if (value === undefined) return rows;
  const range = locateOfficev3(rows);
  rows.splice(range ? range.top : rows.length, 0, { text: `${key}: ${scalar(value)}`, ...eolOf(rows) });
  return rows;
}

/**
 * Apply a patch to the llm block plus its top-level mirrors.
 *
 * `llm` holds indent-4 keys, `top` the mirrored top-level ones. A key whose value
 * is `undefined` is removed, which is how `use_default_remote_preset` gets out of
 * the way when Magpie takes over the main model.
 */
export function applyPatch(text, { llm = {}, top = {} } = {}) {
  let rows = readRows(text && text.trim() ? text : '# Box Agent Configuration\n');
  if (!locateOfficev3(rows)) {
    const eol = eolOf(rows);
    rows.push({ text: '', ...eol });
    rows.push({ text: 'officev3:', ...eol });
    rows.push({ text: LLM_HEADER, ...eol });
  }
  for (const [key, value] of Object.entries(llm)) rows = upsertInsideLlm(rows, key, value);
  for (const [key, value] of Object.entries(top)) rows = upsertTopLevel(rows, key, value);
  const out = join(rows);
  return out.endsWith(LF) ? out : `${out}${LF}`;
}

/** The llm keys this bridge may rewrite, for journalling and diffing. */
export const OWNED_LLM_KEYS = [
  'user_configured',
  'use_default_remote_preset',
  'remote_provider',
  'remote_base_url',
  'remote_api_key',
  'remote_model_id',
  'context_window',
  'max_output_tokens',
  'saved_models_json',
  'active_saved_model_id',
];

export const OWNED_TOP_KEYS = [
  'api_key',
  'api_base',
  'model',
  'provider',
  'context_window',
  'max_output_tokens',
];

/** Snapshot of exactly the keys this bridge may rewrite. */
export function snapshot(text) {
  const llm = readLlmBlock(text);
  const top = readTopLevel(text);
  const owned = {};
  for (const key of OWNED_LLM_KEYS) owned[key] = llm[key];
  for (const key of OWNED_TOP_KEYS) owned[`top.${key}`] = top[key];
  return owned;
}

/** The saved model presets, tolerating a file the client is midway through writing. */
export function readSavedModels(text) {
  const raw = readLlmBlock(text).saved_models_json;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
