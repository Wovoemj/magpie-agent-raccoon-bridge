import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function home() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

/**
 * Where this bridge keeps its own state.
 * MAGPIE_RACCOON_CONFIG_DIR overrides it, which is how tests stay away from
 * real state.
 */
export function configDir() {
  return process.env.MAGPIE_RACCOON_CONFIG_DIR || path.join(home(), '.config', 'magpie-raccoon-bridge');
}

/**
 * Raccoon's profile directory. The desktop client resolves it through its own
 * profile code; these are the locations it actually uses, newest first. Older
 * builds kept everything under `~/.box-agent`, which is why it is last.
 */
export function raccoonProfileCandidates() {
  const h = home();
  const local = process.env.LOCALAPPDATA || path.join(h, 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(h, 'AppData', 'Roaming');
  return [
    path.join(h, '.office-raccoon'),
    path.join(roaming, 'office-raccoon'),
    path.join(local, 'office-raccoon'),
    path.join(h, 'Library', 'Application Support', 'office-raccoon'),
    path.join(h, '.box-agent'),
  ];
}

/**
 * The profile that actually holds a Raccoon install.
 *
 * A candidate only counts when it has the config this bridge edits, so an empty
 * leftover directory from an older build cannot win over the real install.
 */
export function raccoonProfile() {
  const override = process.env.MAGPIE_RACCOON_PROFILE;
  if (override) return override;
  const candidates = raccoonProfileCandidates();
  for (const candidate of candidates) {
    try {
      if (fs.statSync(path.join(candidate, 'agent', 'config', 'config.yaml')).isFile()) return candidate;
    } catch {}
  }
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {}
  }
  return candidates[0];
}

/** The single file the model menu is persisted in. */
export function configFile(profile = raccoonProfile()) {
  return path.join(profile, 'agent', 'config', 'config.yaml');
}

/** Raccoon's own login. Read-only here — never written, never spent. */
export function authFile(profile = raccoonProfile()) {
  return path.join(profile, 'agent', 'config', 'auth.json');
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Windows rejects replacing a file another process holds open, and Raccoon holds
 * config.yaml open while it reads it, so a rename can fail for a few tens of ms.
 */
export async function atomicWrite(file, text, mode = 0o600) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`);
  const handle = await fsp.open(tmp, 'w', mode);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  let last;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (error) {
      last = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) break;
      await sleep(40 * (attempt + 1));
    }
  }
  // A rename that keeps failing usually means the target is held open. The Raccoon
  // client itself writes this file in place (it opens 'r+'), so writing in place is
  // the compatible fallback rather than a workaround — without it, a user whose
  // client is reading the file at that moment gets a failed sync instead.
  try {
    await fsp.writeFile(file, text, 'utf8');
    await fsp.rm(tmp, { force: true }).catch(() => {});
    return;
  } catch {}
  await fsp.rm(tmp, { force: true }).catch(() => {});
  if (last) throw last;
}

export function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function readJSON(file) {
  const text = readText(file);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON: ${file}`, { cause: error });
  }
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function exists(target) {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

/** A stable short id for a Magpie model, used as the model-preset id. */
export function presetId(modelId) {
  return `magpie-${sha256(String(modelId)).slice(0, 16)}`;
}

/**
 * Serialise work that rewrites Raccoon's config.
 *
 * Two processes can reconcile — Magpie's plugin host and, when it is installed,
 * the standalone watcher — and both read-modify-write the same file. mkdir is the
 * one primitive that is atomic on both Windows and macOS, so it is the lock. A
 * lock left behind by a killed process is reclaimed once it is old enough, and
 * the timeout keeps a stuck lock from blocking the user's switch forever.
 */
export async function withLock(name, task, { timeoutMs = 20000, staleMs = 60000 } = {}) {
  const dir = path.join(configDir(), `${name}.lock`);
  await fsp.mkdir(configDir(), { recursive: true, mode: 0o700 });
  const started = Date.now();
  let held = false;
  for (;;) {
    try {
      await fsp.mkdir(dir);
      held = true;
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = await fsp.stat(dir);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fsp.rm(dir, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() - started > timeoutMs) {
        // Do the work anyway rather than leaving the menu stale: the window is
        // short and the writes are atomic, so the worst case is a lost race, not
        // a corrupt file.
        break;
      }
      await sleep(120);
    }
  }
  try {
    return await task();
  } finally {
    if (held) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
