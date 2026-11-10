/**
 * Daily check-in for Raccoon.
 *
 * Raccoon grants its daily credits through a plain page load: requesting
 * `/api/web/office/v3/setting_info` with the account's token is what triggers the
 * grant. There is no dedicated "check in" endpoint, so a check-in is:
 *
 *   1. snapshot today's grant bills,
 *   2. touch setting_info (the trigger),
 *   3. read the bills again and diff, so "claimed" means credits actually landed
 *      rather than "the call returned 200".
 *
 * That diff is the whole reason this is more than a GET: without it a repeat run
 * would report +300 every time, and a silent failure would look like success.
 */
import { beijingDay, beijingMinutes, parseAt, normalizeAt, DEFAULT_AT } from './clock.js';


export const DEFAULTS = { enabled: true, at: DEFAULT_AT, lastDay: null, lastResult: null };

export function defaultBase() {
  return (process.env.MAGPIE_RACCOON_SITE || process.env.RACCOON_MAIN_SITE_URL || 'https://xiaohuanxiong.com').replace(/\/+$/, '');
}

function desktopHeaders(platform = process.platform) {
  return {
    'X-Client-Platform': platform === 'darwin' ? 'desktop-mac' : 'desktop-windows',
    'X-Client-Version': 'v1.0.0',
    'X-Raccoon-Language': 'zh',
  };
}

function stripBearer(value) {
  return String(value ?? '').trim().replace(/^Bearer\s+/i, '').trim();
}

/**
 * A bill counts toward today's check-in when it is a positive grant of today's
 * date. Consumption bills are negative and must never make a day look done.
 */
export function isCheckinGrant(item, today) {
  const points = Math.floor(Number(item?.points) || 0);
  if (points <= 0) return false;
  const createdAt = String(item?.created_at ?? '');
  if (createdAt.slice(0, 10) !== today) return false;
  const biz = String(item?.biz_type ?? '');
  return !biz || biz === 'daily_grant' || biz === 'reward_grant';
}

export function billKey(item) {
  return [item?.created_at, item?.biz_type, item?.points, item?.event_name, item?.event_id ?? item?.id].join('|');
}

async function apiJson(base, path, token, { method = 'GET', extraHeaders = {}, timeoutMs = 20000 } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    // redirect:'error' so a captive portal cannot answer in the API's place.
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer ' + stripBearer(token),
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = JSON.parse(text) ?? {};
  } catch {}
  const message =
    payload?.message || payload?.msg || payload?.error || `HTTP ${response.status}`;
  if (response.status === 401 || payload?.code === 200001 || payload?.code === 200003) {
    const error = new Error('the Raccoon sign-in has expired');
    error.code = 'SIGNED_OUT';
    throw error;
  }
  if (!response.ok) throw new Error(message);
  if (typeof payload?.code === 'number' && payload.code !== 0) throw new Error(message);
  return payload?.data ?? payload;
}

async function todayGrants(base, token, today) {
  const data = await apiJson(base, '/api/web/points/v1/bills?paging.limit=20&paging.offset=0', token);
  const items = Array.isArray(data?.items) ? data.items : [];
  const keys = new Set(items.filter((item) => isCheckinGrant(item, today)).map(billKey));
  return { keys, items };
}

/**
 * Run one check-in.
 *
 * Returns `claimed` only when new grant bills appeared; `done` when the account
 * was already credited today; `signed-out` when the token is refused, which the
 * caller must not retry (a retry cannot fix an expired sign-in).
 */
export async function checkinOnce({ token, base = defaultBase(), now = Date.now(), platform } = {}) {
  const access = stripBearer(token);
  if (!access) return { outcome: 'signed-out', message: 'not signed in', credits: null };
  const today = beijingDay(now);
  const headers = desktopHeaders(platform);

  let before;
  try {
    before = await todayGrants(base, access, today);
  } catch (error) {
    if (error.code === 'SIGNED_OUT') return { outcome: 'signed-out', message: error.message, credits: null };
    // Without a before-snapshot a diff would report historical bills as today's,
    // so the day is left pending rather than reported as claimed.
    return { outcome: 'failed', message: `could not read today's grants: ${error.message}`, credits: null };
  }

  try {
    await apiJson(base, '/api/web/office/v3/setting_info', access, { extraHeaders: headers });
  } catch (error) {
    if (error.code === 'SIGNED_OUT') return { outcome: 'signed-out', message: error.message, credits: null };
    return { outcome: 'failed', message: `check-in request failed: ${error.message}`, credits: null };
  }

  let after;
  try {
    after = await todayGrants(base, access, today);
  } catch (error) {
    if (error.code === 'SIGNED_OUT') return { outcome: 'signed-out', message: error.message, credits: null };
    // The trigger already ran. The grant may well have landed, so the day counts
    // as attempted and the next run re-checks instead of double-claiming.
    return { outcome: 'done', message: `check-in sent, could not confirm: ${error.message}`, credits: null, confirmed: false };
  }

  let credits = 0;
  const names = [];
  for (const item of after.items) {
    if (!isCheckinGrant(item, today)) continue;
    if (before.keys.has(billKey(item))) continue;
    credits += Math.floor(Number(item.points) || 0);
    const name = String(item.event_name || '积分发放');
    if (!names.includes(name)) names.push(name);
  }

  if (credits > 0) {
    return { outcome: 'claimed', message: `${names.join(' + ') || '今日积分'} +${credits}`, credits, confirmed: true };
  }
  return { outcome: 'done', message: 'already checked in today', credits: 0, confirmed: true };
}

/** Read the account's balance, for the status output. Never required for a check-in. */
export async function readBalance({ token, base = defaultBase() } = {}) {
  try {
    const setting = await apiJson(base, '/api/web/office/v3/setting_info', stripBearer(token), {
      extraHeaders: desktopHeaders(),
    });
    const value = Number(setting?.points ?? setting?.available_points ?? setting?.balance);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

// ---- Schedule state ---------------------------------------------------------

export function loadCheckin(readJSON, file) {
  const raw = readJSON(file);
  const state = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  state.at = normalizeAt(state.at);
  state.enabled = state.enabled !== false;
  return state;
}

/**
 * True when today's slot has passed in Beijing time and today is not done yet.
 *
 * The vendor cuts its day at Beijing midnight regardless of the machine's zone,
 * so the schedule is evaluated in Beijing time too — otherwise a laptop in another
 * timezone would check in twice or not at all.
 */
export function checkinDue(state, now = Date.now()) {
  if (!state || state.enabled === false) return false;
  if (state.lastDay === beijingDay(now)) return false;
  return beijingMinutes(now) >= parseAt(state.at);
}

/**
 * Fold one attempt into the persisted state.
 *
 * A failed attempt keeps `lastDay` unset so the next poll retries; a signed-out
 * account is also left pending, because the user may sign in again at any time.
 */
export function applyReport(state, outcome, now = Date.now()) {
  const day = beijingDay(now);
  const settled = outcome?.outcome === 'claimed' || outcome?.outcome === 'done';
  return {
    ...state,
    lastDay: settled ? day : state.lastDay,
    lastResult: {
      at: new Date(now).toISOString(),
      day,
      outcome: outcome?.outcome ?? 'failed',
      ok: settled,
      credits: Number.isFinite(outcome?.credits) ? outcome.credits : null,
      message: outcome?.message || '',
    },
  };
}

/** Options surfaced to Magpie's agent descriptor, so the switch has a schedule. */
export function scheduleOptions(state) {
  return [
    { key: 'at', label: 'check-in time (Beijing)', value: state.at || DEFAULT_AT, placeholder: 'HH:MM' },
  ];
}
