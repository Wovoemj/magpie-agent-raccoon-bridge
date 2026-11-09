/**
 * Magpie's OpenCode-side entry (`main`).
 *
 * This half runs inside Magpie's plugin host with full Node access, so all the
 * real work lives here: watching Magpie's connection file, hugging the gateway
 * catalog, and rewriting Raccoon's model menu. `agent.js` is only the descriptor
 * Magpie evaluates in its locked sandbox.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { configDir } from './lib/util.js';
import { connectionStamp, connectionState, liveCatalog, reconcile, record } from './lib/supervise.js';

const LOG = path.join(configDir(), 'plugin.log');

async function note(line) {
  try {
    await fsp.mkdir(configDir(), { recursive: true, mode: 0o700 });
    await fsp.appendFile(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

let catalog = null;
let timer = null;
let stamp = '';

/** The one catalog both the poll loop and the plugin share. */
function ensureCatalog() {
  if (!catalog) catalog = liveCatalog();
  return catalog;
}

/**
 * Magpie rewrites the connection file when the user toggles the agent or picks a
 * model. The host only re-evaluates this module on a model-list refresh, so a
 * light poll is what makes the switch work without a restart.
 */
function watchConnection() {
  stamp = connectionStamp();
  if (timer) return timer;
  timer = setInterval(async () => {
    try {
      const now = connectionStamp();
      if (now === stamp) return;
      stamp = now;
      await run();
    } catch (error) {
      await note(`watch: ${error?.message || error}`);
    }
  }, 5000);
  timer.unref?.();
  return timer;
}

async function run() {
  const result = await reconcile({ catalog: ensureCatalog() });
  if (result.action !== 'unchanged' && result.action !== 'idle') {
    await note(`reconcile ${result.action}${result.reason ? ` (${result.reason})` : ''}`);
  }
  return result;
}

export default {
  id: 'raccoon-bridge',
  server: async () => {
    // Magpie re-evaluates this module whenever it refreshes its model list, which
    // is exactly what happens when the user flips the switch or picks a model. That
    // load is the reliable trigger: a timer inside the host is not guaranteed to
    // survive between evaluations, so every load reconciles — on as well as off.
    const connection = connectionState();
    watchConnection();
    void (async () => {
      try {
        const result = await run();
        if (result.action !== 'unchanged') {
          await note(`plugin loaded; ${connection.enabled ? 'enabled' : 'off'} (${connection.model || 'no model'}) ${result.action}`);
        }
      } catch (error) {
        await record({ state: 'error', reason: String(error?.message || error) });
        await note(`load: ${error?.message || error}`);
      }
    })();
    return {};
  },
};
