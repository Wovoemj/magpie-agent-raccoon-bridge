import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, home } from './util.js';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(HERE, 'bin', 'raccoon-magpie.js');

/**
 * Where the hidden daemon is registered to start with the user session.
 *
 * Without it, a login that happens after Magpie starts would leave Raccoon on its
 * own models until the agent is toggled again.
 */
export function autostartPath() {
  const h = home();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(h, 'AppData', 'Roaming');
    return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'magpie-raccoon-bridge.vbs');
  }
  return path.join(h, 'Library', 'LaunchAgents', 'com.magpie.raccoon-bridge.plist');
}

function payload(port) {
  const node = process.execPath;
  if (process.platform === 'win32') {
    const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
    return [
      "' magpie-raccoon-bridge — hidden catalog daemon",
      `CreateObject("WScript.Shell").Run ${quote(`${quote(node)} ${quote(CLI)} watch --port ${port}`)}, 0, False`,
      '',
    ].join('\r\n');
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.magpie.raccoon-bridge</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${CLI}</string><string>watch</string><string>--port</string><string>${port}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${path.join(home(), '.config', 'magpie-raccoon-bridge', 'daemon.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(home(), '.config', 'magpie-raccoon-bridge', 'daemon.log')}</string>
</dict></plist>
`;
}

/**
 * Windows Script Host decodes a .vbs with the ANSI code page unless the file
 * starts with a UTF-16 LE BOM. The payload embeds an absolute path that may well
 * be non-ASCII, and without the BOM the hidden Run dies instantly with no trace.
 */
export function scriptText(text, platform = process.platform) {
  return platform === 'win32' ? `\uFEFF${text}` : text;
}

export function scriptEncoding(platform = process.platform) {
  return platform === 'win32' ? 'utf16le' : 'utf8';
}

export async function enable(port) {
  const file = autostartPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, scriptText(payload(port)), scriptEncoding());
  return file;
}

export async function disable() {
  const file = autostartPath();
  if (!exists(file)) return { removed: false, file };
  await fsp.rm(file, { force: true });
  return { removed: true, file };
}

export function status() {
  const file = autostartPath();
  return { file, enabled: exists(file) };
}
