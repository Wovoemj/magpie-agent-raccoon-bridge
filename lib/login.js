/**
 * Browser sign-in for Raccoon.
 *
 * The desktop client signs in through the web login flow: `/code/authorize`
 * redirects back to a loopback URL with a one-time `code`, and that code is
 * exchanged at `/api/web/auth/v1/login_with_authorization_code`. Doing the same
 * from this bridge means a machine that never installed the Raccoon client can
 * still sign in — which is exactly the case where the model menu has nothing to
 * attach to, because the client's own `auth.json` does not exist yet.
 *
 * The rules the authorize page enforces, all copied from the flow the Raccoon
 * web app uses:
 *   - `desktop_callback=loopback` selects the loopback return;
 *   - `state` must be 64 hex characters and is echoed back untouched;
 *   - the callback host must be exactly `127.0.0.1:<port>` and the path
 *     `/auth/callback`.
 * A mismatch in any of them is refused before the code is touched, so a stray
 * page cannot hand us someone else's authorization code.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { defaultBase } from './checkin.js';
import { atomicWrite, readText } from './util.js';

export const CALLBACK_PATH = '/auth/callback';
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** A fresh 64-hex state value, which is what the authorize page demands. */
export function newState() {
  return randomBytes(32).toString('hex');
}

export function authorizeUrl({ state, redirect, base = defaultBase() }) {
  const url = new URL('/code/authorize', base);
  url.searchParams.set('login_source', 'desktop');
  url.searchParams.set('appname', '办公小浣熊客户端');
  url.searchParams.set('state', state);
  url.searchParams.set('desktop_callback', 'loopback');
  if (redirect) url.searchParams.set('redirect', redirect);
  return url.toString();
}

export function stripBearer(value) {
  return String(value ?? '').trim().replace(/^Bearer\s+/i, '').trim();
}

export function decodeJwtClaims(token) {
  const parts = stripBearer(token).split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Seconds-since-epoch expiry, or 0 when the token does not say. */
export function jwtExpiryMs(token) {
  const claims = decodeJwtClaims(token);
  const exp = Number(claims?.exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
}

/**
 * Exchange an authorization code for tokens.
 *
 * The vendor answers `code: 200035` for an expired or reused code, which is a
 * "start over", not a transient failure — saying so is what stops a caller from
 * retrying with the same dead code.
 */
export async function exchangeCode({ code, base = defaultBase(), timeoutMs = 30000 } = {}) {
  const response = await fetch(`${base}/api/web/auth/v1/login_with_authorization_code`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ authorization_code: code }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (payload?.code === 200035) {
    const error = new Error('授权码已失效，请重新发起登录');
    error.code = 'CODE_EXPIRED';
    throw error;
  }
  const data = payload?.data ?? {};
  const access = stripBearer(data?.access_token);
  const refresh = stripBearer(data?.refresh_token);
  if (!response.ok || !access) {
    const message = payload?.message || payload?.msg || `HTTP ${response.status}`;
    throw new Error(`换取凭证失败：${message}`);
  }
  return { access, refresh, expires: jwtExpiryMs(access), claims: decodeJwtClaims(access) };
}

const PAGE = (title, detail, ok) => `<!doctype html>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>
  :root { color-scheme: light dark }
  body { font: 15px/1.7 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0;
         display: grid; place-items: center; min-height: 100vh; background: #faf9f7; color: #23201c }
  @media (prefers-color-scheme: dark) { body { background: #1b1a18; color: #ecebe8 } }
  main { max-width: 30rem; padding: 2rem; text-align: center }
  h1 { font-size: 1.1rem; margin: 0 0 .6rem; color: ${ok ? '#2f7d4f' : '#a63a2f'} }
  p { margin: 0; color: #6c675f }
  @media (prefers-color-scheme: dark) { p { color: #a8a39a } }
</style>
<main><h1>${title}</h1><p>${detail}</p></main>`;

/**
 * Run one browser sign-in and resolve with the tokens.
 *
 * `open` receives the authorize URL; it returns nothing and is allowed to fail
 * (a headless machine still prints the URL so the user can paste it elsewhere).
 */
export async function browserSignIn({
  open,
  base = defaultBase(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onUrl,
} = {}) {
  const state = newState();
  let server;
  let settle;
  let settled = false;
  let received = false;
  let timer;

  const done = new Promise((resolve) => {
    settle = resolve;
  });

  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    settle(result);
    // close() stops new connections; idle ones would otherwise keep the event
    // loop alive for the rest of the browser's keep-alive window.
    try {
      server.close();
      server.closeIdleConnections?.();
    } catch {}
  };

  server = createServer(async (request, response) => {
    const reply = (status, title, detail, ok = false) => {
      const body = PAGE(title, detail, ok);
      response.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      });
      response.end(body);
    };

    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.headers.host !== origin || url.pathname !== CALLBACK_PATH) {
      return reply(404, '页面不存在', '这个地址不是本次登录的回调。');
    }
    if (request.method !== 'GET') {
      return reply(405, '方法不允许', '请用浏览器打开授权页。');
    }
    const params = url.searchParams;
    if (params.getAll('state').length !== 1 || params.get('state') !== state) {
      // Deliberately does not end the login: a stray tab must not cancel the
      // attempt the user is still making in the real one.
      return reply(400, '回调不属于本次登录', '请回到授权页重新完成登录。');
    }
    if (settled || received) {
      return reply(409, '这次回调已处理', '可以关闭此页。');
    }
    if (params.get('error')) {
      reply(400, '登录未获授权', '已取消或未同意授权，请重新发起登录。');
      finish({ ok: false, error: 'authorization was declined' });
      return;
    }
    const code = params.get('code') || '';
    if (params.getAll('code').length !== 1 || !code || code.length > 4096) {
      return reply(400, '回调缺少授权码', '请回到授权页重新完成登录。');
    }

    received = true;
    try {
      const tokens = await exchangeCode({ code, base });
      if (settled) return reply(408, '登录已超时', '请重新发起登录。');
      reply(200, '已登录', '授权完成，可以关闭此页并回到编辑器。', true);
      finish({ ok: true, ...tokens, state });
    } catch (error) {
      reply(502, '登录未完成', '换取凭证失败，请回到终端查看原因后重试。');
      finish({ ok: false, error: error?.message || String(error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const origin = `127.0.0.1:${port}`;
  const redirect = `http://${origin}${CALLBACK_PATH}`;
  const url = authorizeUrl({ state, redirect, base });

  timer = setTimeout(() => finish({ ok: false, error: '登录超时' }), timeoutMs);
  timer.unref?.();

  if (onUrl) onUrl(url);
  if (open) {
    try {
      await open(url);
    } catch {
      // A browser that will not open is not a failure yet: the URL was reported.
    }
  }

  try {
    return await done;
  } finally {
    try {
      server.close();
      server.closeIdleConnections?.();
    } catch {}
  }
}

// ---- Persisting the sign-in -------------------------------------------------

/**
 * Write the tokens the way the desktop client stores them.
 *
 * The client keeps only `access_token` and `office_identity` in this file, so the
 * bridge writes exactly those two and leaves anything else it finds alone. The
 * file is 0600: it is the account's own credential, not something to share.
 */
export async function saveLogin(profile, tokens, { identity = 'personal', atomicWrite: injected } = {}) {
  // Static imports: a dynamic `import('node:path')` resolves to the module's
  // namespace, which has no `path` member, so destructuring it yields undefined.
  const file = join(profile, 'agent', 'config', 'auth.json');
  const write = injected || atomicWrite;

  let existing = {};
  const text = readText(file);
  if (text) {
    try {
      existing = JSON.parse(text);
    } catch {
      // A half-written file is replaced rather than merged: merging into garbage
      // would carry the garbage forward.
      existing = {};
    }
  }

  const next = {
    ...existing,
    access_token: tokens.access,
  };
  if (identity) next.office_identity = identity;

  await write(file, `${JSON.stringify(next)}\n`, 0o600);
  return { file, identity: next.office_identity || null, expires: tokens.expires || 0 };
}
