import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  authorizeUrl,
  decodeJwtClaims,
  exchangeCode,
  jwtExpiryMs,
  newState,
  saveLogin,
  stripBearer,
} from '../lib/login.js';

const BASE = 'https://xiaohuanxiong.com';

/** A JWT shaped token, so expiry and claims parsing are exercised for real. */
function fakeJwt(payload) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${enc({ alg: 'HS256' })}.${enc(payload)}.signature`;
}

export default {
  'the state is 64 hex characters, which is what the page demands'() {
    const value = newState();
    assert.match(value, /^[0-9a-f]{64}$/);
    assert.notEqual(newState(), newState(), 'a fresh value each time');
  },

  'the authorize URL carries the four parameters the web flow needs'() {
    const state = newState();
    const url = new URL(authorizeUrl({ state, redirect: 'http://127.0.0.1:1234/auth/callback', base: BASE }));
    assert.equal(url.origin + url.pathname, `${BASE}/code/authorize`);
    assert.equal(url.searchParams.get('login_source'), 'desktop');
    assert.equal(url.searchParams.get('state'), state);
    assert.equal(url.searchParams.get('desktop_callback'), 'loopback');
    assert.equal(url.searchParams.get('redirect'), 'http://127.0.0.1:1234/auth/callback');
    assert.ok(url.searchParams.get('appname'), 'the page shows an app name');
  },

  'claims and expiry come out of the token itself'() {
    const token = fakeJwt({ sub: 'u1', office_identity: 'corp', exp: 1900000000 });
    assert.equal(decodeJwtClaims(token).sub, 'u1');
    assert.equal(jwtExpiryMs(token), 1900000000 * 1000);
    // A token without exp, or one that is not a JWT, must not invent an expiry.
    assert.equal(jwtExpiryMs(fakeJwt({ sub: 'u2' })), 0);
    assert.equal(jwtExpiryMs('not-a-jwt'), 0);
    assert.equal(decodeJwtClaims('nope'), null);
  },

  'a Bearer prefix is stripped once, not twice'() {
    assert.equal(stripBearer('Bearer abc'), 'abc');
    assert.equal(stripBearer('bearer abc'), 'abc');
    assert.equal(stripBearer('  abc  '), 'abc');
    assert.equal(stripBearer('Bearer Bearer abc'), 'Bearer abc');
    assert.equal(stripBearer(null), '');
  },

  async 'an expired code is reported as such, not as a network error'() {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 200,
      json: async () => ({ code: 200035, message: 'code expired' }),
    });
    try {
      await assert.rejects(
        exchangeCode({ code: 'x', base: BASE }),
        (error) => error.code === 'CODE_EXPIRED',
      );
    } finally {
      globalThis.fetch = original;
    }
  },

  async 'a refusal without tokens is an error, never a half sign-in'() {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: {} }),
    });
    try {
      await assert.rejects(exchangeCode({ code: 'x', base: BASE }), /换取凭证失败/);
    } finally {
      globalThis.fetch = original;
    }
  },

  'the code is posted as authorization_code, not as a query'() {
    // The vendor takes a JSON body; sending it as a query string would be
    // silently ignored and look like an empty token response.
    const original = globalThis.fetch;
    let seen;
    globalThis.fetch = async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, json: async () => ({ data: { access_token: 'a', refresh_token: 'r' } }) };
    };
    return exchangeCode({ code: 'the-code', base: BASE })
      .then((result) => {
        assert.equal(seen.url, `${BASE}/api/web/auth/v1/login_with_authorization_code`);
        assert.equal(seen.init.method, 'POST');
        assert.deepEqual(JSON.parse(seen.init.body), { authorization_code: 'the-code' });
        assert.equal(result.access, 'a');
        assert.equal(result.refresh, 'r');
      })
      .finally(() => {
        globalThis.fetch = original;
      });
  },

  async 'saving keeps the keys the client wrote and writes only its own'() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raccoon-login-'));
    const profile = path.join(root, 'profile');
    fs.mkdirSync(path.join(profile, 'agent', 'config'), { recursive: true });
    const file = path.join(profile, 'agent', 'config', 'auth.json');
    fs.writeFileSync(file, JSON.stringify({ access_token: 'old', office_identity: 'personal', extra: 'kept' }));

    const saved = await saveLogin(profile, { access: 'new-token', refresh: '', expires: 0 }, { identity: 'corp' });
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.access_token, 'new-token');
    assert.equal(written.office_identity, 'corp');
    assert.equal(written.extra, 'kept', 'unrelated keys survive');
    assert.equal(saved.file, file);
    fs.rmSync(root, { recursive: true, force: true });
  },

  async 'a corrupt auth file is replaced, not merged into'() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raccoon-login-'));
    const profile = path.join(root, 'profile');
    fs.mkdirSync(path.join(profile, 'agent', 'config'), { recursive: true });
    const file = path.join(profile, 'agent', 'config', 'auth.json');
    fs.writeFileSync(file, '{"access_token": "half');

    await saveLogin(profile, { access: 'fresh', expires: 0 }, { identity: 'personal' });
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.access_token, 'fresh');
    // Carrying the broken fragment forward would keep the corruption alive.
    assert.equal('half' in written, false);
    fs.rmSync(root, { recursive: true, force: true });
  },
};

// ---- Renewal and the paste fallback ----------------------------------------

export const renewal = {
  async 'a refresh returns a new access token and keeps the old refresh token'(t) {
    const original = globalThis.fetch;
    let seen;
    globalThis.fetch = async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, json: async () => ({ data: { access_token: 'new-access' } }) };
    };
    try {
      const { refreshAccess } = await import('../lib/login.js');
      const result = await refreshAccess({ refresh: 'old-refresh', base: BASE });
      assert.equal(seen.url, `${BASE}/api/web/auth/v1/refresh`);
      assert.deepEqual(JSON.parse(seen.init.body), { refresh_token: 'old-refresh' });
      assert.equal(result.access, 'new-access');
      // The vendor did not rotate it; keeping it is what stops the session ending.
      assert.equal(result.refresh, 'old-refresh');
    } finally {
      globalThis.fetch = original;
    }
  },

  async 'a rotated refresh token is stored, not the old one'() {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { access_token: 'a2', refresh_token: 'r2' } }),
    });
    try {
      const { refreshAccess } = await import('../lib/login.js');
      const result = await refreshAccess({ refresh: 'r1', base: BASE });
      assert.equal(result.refresh, 'r2');
    } finally {
      globalThis.fetch = original;
    }
  },

  async 'a rejected refresh token is reported as a sign-in problem'() {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ message: 'refresh token expired' }),
    });
    try {
      const { refreshAccess } = await import('../lib/login.js');
      // A 4xx cannot be fixed by retrying, so it must be distinguishable from a
      // network error — otherwise the loop retries a dead credential forever.
      await assert.rejects(
        refreshAccess({ refresh: 'dead', base: BASE }),
        (error) => error.code === 'SIGNED_OUT',
      );
    } finally {
      globalThis.fetch = original;
    }
  },

  'renewing without a refresh token says so instead of calling the API'() {
    return import('../lib/login.js').then(async ({ refreshAccess }) => {
      await assert.rejects(refreshAccess({ refresh: '' }), (error) => error.code === 'NO_REFRESH');
    });
  },

  'staleness is measured against the token expiry, not a fixed age'() {
    return import('../lib/login.js').then(({ isStale }) => {
      const soon = { expires: Date.now() + 60 * 1000 };
      const far = { expires: Date.now() + 60 * 60 * 1000 };
      assert.equal(isStale(soon), true, 'inside the 5 minute margin');
      assert.equal(isStale(far), false);
      // A token with no exp cannot be judged, and must not be refreshed blindly.
      assert.equal(isStale({ expires: 0 }), false);
    });
  },
};

export const paste = {
  async 'a callback URL yields its code'() {
    const { parsePasted } = await import('../lib/login.js');
    const parsed = parsePasted('http://127.0.0.1:5000/auth/callback?code=abc123&state=ff');
    assert.equal(parsed.code, 'abc123');
  },

  async 'a callback with the wrong state is refused'() {
    const { parsePasted } = await import('../lib/login.js');
    assert.throws(
      () => parsePasted('http://127.0.0.1:5000/auth/callback?code=abc&state=other', { expectedState: 'mine' }),
      /state/,
    );
  },

  async 'a bare JWT is taken as the access token'() {
    const { parsePasted } = await import('../lib/login.js');
    const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: 1900000000 })).toString('base64url')}.sig`;
    const parsed = parsePasted(token);
    assert.equal(parsed.access, token);
    assert.equal(parsed.expires, 1900000000 * 1000);
  },

  async 'a JSON pair is taken as both tokens'() {
    const { parsePasted } = await import('../lib/login.js');
    const parsed = parsePasted(JSON.stringify({ access_token: 'a', refresh_token: 'r' }));
    assert.equal(parsed.access, 'a');
    assert.equal(parsed.refresh, 'r');
  },

  async 'junk is rejected with a useful message'() {
    const { parsePasted } = await import('../lib/login.js');
    assert.throws(() => parsePasted(''), /请粘贴/);
    assert.throws(() => parsePasted('not a url'), /无效/);
    assert.throws(() => parsePasted('http://127.0.0.1:1/auth/callback'), /没有授权码/);
    assert.throws(() => parsePasted('{"broken":'), /JSON/);
  },
};
