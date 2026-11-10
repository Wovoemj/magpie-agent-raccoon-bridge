#!/usr/bin/env node
/**
 * Management CLI.
 *
 * `watch` is what the Startup entry runs: it keeps a hidden process alive that
 * re-syncs Raccoon whenever Magpie's switch or catalog changes. Everything else
 * is for a person at a terminal.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { disable, enable, status as autostartStatus } from '../lib/autostart.js';
import { discover, saveConnection } from '../lib/magpie.js';
import { apply, loginState, readJournal, readState, restore, takenOver } from '../lib/sync.js';
import {
  connectionStamp,
  connectionState,
  liveCatalog,
  reconcile,
  reconcileCheckin,
} from '../lib/supervise.js';
import { loadCheckin } from '../lib/checkin.js';
import {
  browserSignIn,
  exchangeCode,
  isStale,
  parsePasted,
  readLogin,
  refreshAccess,
  saveLogin,
} from '../lib/login.js';
import { normalizeAt } from '../lib/clock.js';
import { atomicWrite, configDir, configFile, raccoonProfile, readJSON, sleep } from '../lib/util.js';

const LOG = path.join(configDir(), 'plugin.log');

async function note(line) {
  try {
    await fsp.mkdir(configDir(), { recursive: true, mode: 0o700 });
    await fsp.appendFile(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function out(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

async function syncOnce({ force = false } = {}) {
  const catalog = liveCatalog();
  try {
    await catalog.refresh();
    return await reconcile({ catalog, force });
  } finally {
    catalog.stop();
  }
}

async function cmdStatus() {
  const connection = connectionState();
  const state = readState();
  const journal = readJournal();
  const login = loginState();
  out({
    magpie: {
      connectionFile: connection.file,
      present: connection.present,
      enabled: connection.enabled,
      pickedModel: connection.model,
      gateway: connection.gateway,
      models: connection.models,
    },
    raccoon: {
      profile: raccoonProfile(),
      config: configFile(),
      configPresent: await fsp
        .access(configFile())
        .then(() => true)
        .catch(() => false),
      signedIn: login.signedIn,
    },
    bridge: {
      takenOver: takenOver(),
      journal: journal ? { file: journal.file, magpiePresets: journal.ownedIds?.length ?? 0 } : null,
      autostart: autostartStatus(),
      checkin: loadCheckin(readJSON, path.join(configDir(), 'checkin.json')),
      state,
    },
  });
}

async function cmdSync({ force }) {
  const result = await syncOnce({ force });
  out(result);
  return result.action === 'error' ? 1 : 0;
}

async function cmdRestore() {
  const result = await restore();
  out(result);
  return 0;
}

async function cmdCheckinConfig(args) {
  // `checkin` with a time argument is how the schedule is set: Magpie's agent
  // descriptor has no writable field for it, so the CLI is the honest surface.
  const file = path.join(configDir(), 'checkin.json');
  const state = loadCheckin(readJSON, file);
  const action = args[0];
  if (!action || action === 'status') {
    out(state);
    return 0;
  }
  let next = state;
  if (action === 'off') next = { ...state, enabled: false };
  else if (action === 'on') next = { ...state, enabled: true };
  else if (action === 'at') {
    const at = normalizeAt(args[1]);
    if (!/^\d{2}:\d{2}$/.test(at)) {
      out('usage: raccoon-magpie.js checkin at HH:MM | on | off');
      return 2;
    }
    next = { ...state, enabled: true, at };
  } else if (action === 'now') {
    return cmdCheckinNow();
  } else {
    out('usage: raccoon-magpie.js checkin [status|at HH:MM|on|off|now]');
    return 2;
  }
  await atomicWrite(file, JSON.stringify(next, null, 2) + '\n');
  out({ saved: file, state: next });
  return 0;
}

async function cmdCheckinNow() {
  // A person at a terminal means "check in now", so the schedule and the
  // already-done-today guard are both bypassed. The diff still decides the
  // outcome, so a repeat run honestly reports "already checked in".
  const file = path.join(configDir(), 'checkin.json');
  const before = loadCheckin(readJSON, file);
  const result = await reconcileCheckin({ checkinFile: file, now: Date.now(), force: true });
  out({
    outcome: result.outcome?.outcome ?? result.action,
    message: result.outcome?.message ?? null,
    credits: result.outcome?.credits ?? null,
    previous: before.lastResult,
    state: result.state,
  });
  const bad = ['failed', 'signed-out'].includes(result.outcome?.outcome);
  return bad ? 1 : 0;
}

async function openInBrowser(url) {
  // Report the URL first: on a headless or locked-down machine the browser may
  // never start, and the URL is still the way to sign in.
  process.stdout.write(`\n在浏览器完成登录：\n${url}\n\n`);
  const { spawn } = await import('node:child_process');
  const command =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(command[0], command[1], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch {
    // Pasting the callback URL still works, which is why it is printed above.
  }
}

/** Read a line from stdin, for the paste fallback. */
async function ask(question) {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function cmdLogin(args) {
  // Three ways in, in the order the Raccoon web flow offers them:
  //   1. browser + automatic loopback return (the default)
  //   2. the desktop client's existing sign-in (read only, never spent)
  //   3. paste a callback link or token, for browsers where 1 cannot work
  const profile = raccoonProfile();
  const mode = args[0] || 'browser';

  if (mode === 'desktop') {
    const existing = readLogin(profile);
    if (!existing) {
      out({ ok: false, error: '没有找到小浣熊客户端的登录态，请改用 login（浏览器）' });
      return 1;
    }
    out({
      ok: true,
      source: 'desktop',
      file: existing.file,
      identity: existing.identity,
      expires: existing.expires ? new Date(existing.expires).toISOString() : null,
    });
    return 0;
  }

  if (mode === 'manual' || mode === 'paste') {
    const pasted = await ask('粘贴回调链接、access_token，或包含两者的 JSON：\n> ');
    let tokens;
    try {
      const parsed = parsePasted(pasted, {});
      tokens = parsed.code ? await exchangeCode({ code: parsed.code }) : parsed;
    } catch (error) {
      out({ ok: false, error: error.message });
      return 1;
    }
    const saved = await saveLogin(profile, tokens, { identity: guessIdentity(tokens.claims) });
    out({
      ok: true,
      source: 'manual',
      file: saved.file,
      identity: saved.identity,
      expires: saved.expires ? new Date(saved.expires).toISOString() : null,
    });
    return 0;
  }

  const result = await browserSignIn({ open: openInBrowser });
  if (!result.ok) {
    out({ ok: false, error: result.error, hint: '可改用 login manual 粘贴回调链接' });
    return 1;
  }
  const saved = await saveLogin(profile, result, { identity: guessIdentity(result.claims) });
  out({
    ok: true,
    source: 'browser',
    file: saved.file,
    identity: saved.identity,
    expires: saved.expires ? new Date(saved.expires).toISOString() : null,
  });
  return 0;
}

/**
 * Bring the stored sign-in back to life before a request needs it.
 *
 * Called from the sync loop rather than on every request: refreshing on a timer
 * that is already running costs nothing, while refreshing inside a request path
 * would put a network round trip in front of the user's menu.
 */
async function cmdRenew() {
  const profile = raccoonProfile();
  const current = readLogin(profile);
  if (!current) {
    out({ ok: false, reason: 'not signed in' });
    return 1;
  }
  if (!isStale(current)) {
    out({ ok: true, renewed: false, expires: new Date(current.expires).toISOString() });
    return 0;
  }
  try {
    const next = await refreshAccess({ refresh: current.refresh });
    const saved = await saveLogin(profile, next, { identity: current.identity });
    out({
      ok: true,
      renewed: true,
      file: saved.file,
      expires: saved.expires ? new Date(saved.expires).toISOString() : null,
    });
    return 0;
  } catch (error) {
    // A dead refresh token is a sign-in problem, not a bug: say so once instead of
    // retrying a credential the server has already refused.
    out({ ok: false, renewed: false, error: error.message, needLogin: error.code !== 'REFRESH_FAILED' });
    return 1;
  }
}

async function cmdWhoami() {
  const profile = raccoonProfile();
  const current = readLogin(profile);
  if (!current) {
    out({ signedIn: false });
    return 0;
  }
  out({
    signedIn: true,
    source: 'desktop auth.json',
    file: current.file,
    identity: current.identity,
    // Deliberately not the token itself: it is a credential, and this output is
    // the kind of thing that ends up pasted into an issue.
    expires: current.expires ? new Date(current.expires).toISOString() : null,
    stale: isStale(current),
    canRenew: Boolean(current.refresh),
  });
  return 0;
}

/** The account's identity, as the client records it. Corporate seats answer more. */
function guessIdentity(claims) {
  const value = claims && (claims.office_identity || claims.org || claims.tenant);
  return typeof value === 'string' && value.trim() ? value.trim() : 'personal';
}

async function cmdLogout() {
  // Removing the token is the honest way out: it cannot be un-refreshed, and the
  // next sync will refuse to invent a sign-in.
  const file = path.join(raccoonProfile(), 'agent', 'config', 'auth.json');
  const existing = readJSON(file);
  if (!existing) {
    out({ ok: true, removed: false, reason: 'not signed in' });
    return 0;
  }
  const next = { ...existing };
  delete next.access_token;
  delete next.accessToken;
  await atomicWrite(file, JSON.stringify(next) + '\n', 0o600);
  out({ ok: true, removed: true, file });
  return 0;
}

async function cmdDoctor() {
  const found = await discover();
  const login = loginState();
  out({
    gateway: found.gateway,
    gatewayReachable: found.ok,
    source: found.source,
    models: found.models.length,
    groups: [...new Set(found.models.map((model) => model.group).filter(Boolean))],
    sample: found.models.slice(0, 8).map((model) => ({ id: model.id, label: model.label, context: model.context })),
    notes: found.notes,
    raccoon: { profile: raccoonProfile(), config: configFile(), signedIn: login.signedIn },
  });
  return found.ok ? 0 : 1;
}

async function cmdInstall() {
  // Optional: keeps the sync alive independently of Magpie's plugin host. The
  // gateway only exists while Magpie runs, so an unreachable host leaves the
  // written presets untouched rather than emptying the menu.
  const found = await discover();
  if (found.ok) await saveConnection(found);
  const file = await enable(0);
  out({ autostart: file, gateway: found.gateway, gatewayReachable: found.ok, models: found.models.length });
  return 0;
}

async function cmdUninstall() {
  const restored = await restore();
  const autostart = await disable();
  out({ restored, autostart });
  return 0;
}

async function cmdWatch() {
  await fsp.mkdir(configDir(), { recursive: true, mode: 0o700 });
  const catalog = liveCatalog();
  let stamp = '';
  let stopping = false;
  const signals = process.platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGTERM'] : ['SIGTERM', 'SIGINT'];
  for (const signal of signals) {
    process.on(signal, () => {
      stopping = true;
    });
  }
  process.on('uncaughtException', (error) => void note(`watch crashed: ${error?.message || error}`));
  await note('watch started');
  while (!stopping) {
    try {
      const next = connectionStamp();
      // Always reconcile on the first pass so a restart repairs a half-applied sync.
      if (next !== stamp || stamp === '') {
        stamp = next;
        const result = await reconcile({ catalog });
        if (result.action !== 'unchanged' && result.action !== 'idle') {
          await note(`reconcile ${result.action}${result.reason ? ` (${result.reason})` : ''}`);
        }
        // The schedule is independent of the switch: Magpie may be off while the
        // account still wants its daily credits.
        try {
          const done = await reconcileCheckin();
          if (done.action !== 'idle') {
            await note(`checkin ${done.action}${done.outcome?.message ? ` (${done.outcome.message})` : ''}`);
          }
        } catch (error) {
          await note(`checkin pass failed: ${error?.message || error}`);
        }
        // Renew a soon-to-expire sign-in here rather than in a request path: the
        // loop is already awake, and the menu never waits on a network round trip.
        try {
          const current = readLogin(raccoonProfile());
          if (current && current.refresh && isStale(current)) {
            const next = await refreshAccess({ refresh: current.refresh });
            await saveLogin(raccoonProfile(), next, { identity: current.identity });
            await note(`renewed the sign-in until ${new Date(next.expires || 0).toISOString()}`);
          }
        } catch (error) {
          await note(`renew failed: ${error?.message || error}`);
        }
      }
    } catch (error) {
      await note(`watch pass failed: ${error?.message || error}`);
    }
    await sleep(5000);
  }
  catalog.stop();
  await note('watch stopped');
  return 0;
}

async function main(argv) {
  const command = argv[0] || 'status';
  const force = argv.includes('--force');
  switch (command) {
    case 'status':
      await cmdStatus();
      return 0;
    case 'sync':
      return cmdSync({ force });
    case 'restore':
      return cmdRestore();
    case 'checkin':
      return cmdCheckinConfig(argv.slice(1));
    case 'login':
      return cmdLogin(argv.slice(1));
    case 'logout':
      return cmdLogout();
    case 'renew':
      return cmdRenew();
    case 'whoami':
      return cmdWhoami();
    case 'doctor':
      return cmdDoctor();
    case 'install':
      return cmdInstall();
    case 'uninstall':
      return cmdUninstall();
    case 'watch':
      return cmdWatch();
    case 'apply': {
      // Manual apply, mainly for tests and for a one-shot repair.
      const found = await discover();
      if (!found.ok) {
        out({ ok: false, notes: found.notes });
        return 1;
      }
      const result = await apply({
        models: found.models,
        gateway: found.gateway,
        key: found.key,
        select: connectionState().model || null,
      });
      out(result);
      return 0;
    }
    default:
      out('usage: raccoon-magpie.js <status|sync|apply|restore|checkin|login [browser|desktop|manual]|logout|renew|whoami|doctor|install|uninstall|watch>');
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
