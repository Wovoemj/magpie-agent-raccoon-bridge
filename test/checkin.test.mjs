import assert from 'node:assert/strict';
import {
  applyReport,
  billKey,
  checkinDue,
  checkinOnce,
  isCheckinGrant,
  loadCheckin,
} from '../lib/checkin.js';
import { beijingDay, beijingMinutes, normalizeAt, parseAt } from '../lib/clock.js';

/** Beijing noon on a fixed day, so no test depends on when it runs. */
const NOON = Date.parse('2026-11-10T04:00:00Z'); // 12:00 Beijing
const DAY = '2026-11-10';

function grant(points, { at = `${DAY}T09:00:00+08:00`, biz = 'daily_grant', name = '每日签到' } = {}) {
  return { points, created_at: at, biz_type: biz, event_name: name, id: `${at}-${points}-${name}` };
}

/** A tiny fake of the two endpoints, so the diff logic is what gets tested. */
function fakeServer({ bills = [], settingInfo = () => {}, fail = {} } = {}) {
  const state = { bills: [...bills], calls: [] };
  const fetch = async (url, init = {}) => {
    const path = url.replace('https://xiaohuanxiong.com', '');
    state.calls.push(`${init.method || 'GET'} ${path.split('?')[0]}`);
    if (fail[path.split('?')[0]]) throw new Error('network down');
    if (path.startsWith('/api/web/points/v1/bills')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: { items: state.bills } }),
      };
    }
    if (path.startsWith('/api/web/office/v3/setting_info')) {
      // This is the grant trigger: it appends today's bill.
      const added = settingInfo(state.bills);
      if (Array.isArray(added)) state.bills = [...added, ...state.bills];
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { points: 1200 } }) };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };
  return { fetch, state };
}

async function withFetch(server, task) {
  const original = globalThis.fetch;
  globalThis.fetch = server.fetch;
  try {
    return await task();
  } finally {
    globalThis.fetch = original;
  }
}

export default {
  'a consumption bill never counts as a check-in'() {
    // The real account's bills are mostly negative consumption entries; reading
    // one of those as "checked in" would silently skip the day.
    assert.equal(isCheckinGrant({ points: -30, created_at: `${DAY}T13:49:54+08:00`, biz_type: 'desktop' }, DAY), false);
    assert.equal(isCheckinGrant(grant(300), DAY), true);
    assert.equal(isCheckinGrant(grant(300, { at: '2026-11-09T09:00:00+08:00' }), DAY), false, 'yesterday does not count');
    assert.equal(isCheckinGrant({ points: 0, created_at: `${DAY}T09:00:00+08:00` }, DAY), false, 'zero is not a grant');
  },

  'only grant business types count'() {
    assert.equal(isCheckinGrant(grant(300, { biz: 'daily_grant' }), DAY), true);
    assert.equal(isCheckinGrant(grant(3000, { biz: 'reward_grant' }), DAY), true);
    assert.equal(isCheckinGrant(grant(300, { biz: '' }), DAY), true, 'an older bill may carry no biz type');
    assert.equal(isCheckinGrant(grant(300, { biz: 'topup' }), DAY), false);
  },

  'the Beijing day and minute are used, not the host timezone'() {
    // 2026-11-10T00:30 Beijing is still 2026-11-09 in UTC.
    const justAfterMidnight = Date.parse('2026-11-09T16:30:00Z');
    assert.equal(beijingDay(justAfterMidnight), '2026-11-10');
    assert.equal(beijingMinutes(justAfterMidnight), 30);
    assert.equal(beijingDay(NOON), DAY);
    assert.equal(beijingMinutes(NOON), 12 * 60);
  },

  'the slot parses and normalises, and junk falls back to 09:00'() {
    assert.equal(parseAt('09:00'), 540);
    assert.equal(parseAt('0:05'), 5);
    assert.equal(parseAt('23:59'), 1439);
    assert.equal(parseAt('24:00'), 540);
    assert.equal(parseAt('9'), 540);
    assert.equal(parseAt(undefined), 540);
    assert.equal(normalizeAt('7:5'), '07:05');
    assert.equal(normalizeAt('bad'), '09:00');
  },

  'a day is due only after the slot, and only once'() {
    const state = { enabled: true, at: '09:00', lastDay: null };
    assert.equal(checkinDue(state, Date.parse('2026-11-10T08:59:00+08:00')), false, 'before the slot');
    assert.equal(checkinDue(state, Date.parse('2026-11-10T09:00:00+08:00')), true, 'at the slot');
    assert.equal(checkinDue({ ...state, lastDay: DAY }, NOON), false, 'already done today');
    assert.equal(checkinDue({ ...state, enabled: false }, NOON), false, 'switched off');
    assert.equal(checkinDue({ ...state, lastDay: '2026-11-09' }, NOON), true, 'a new day is due again');
  },

  async 'a fresh claim reports the credits that actually landed'(t) {
    const server = fakeServer({
      bills: [grant(-30, { biz: 'desktop', name: '任务消耗' })],
      settingInfo: () => [grant(300, { name: '每日签到' })],
    });
    const result = await withFetch(server, () => checkinOnce({ token: 'x', now: NOON }));
    assert.equal(result.outcome, 'claimed');
    assert.equal(result.credits, 300);
    assert.match(result.message, /\+300/);
  },

  async 'a second run on the same day does not claim again'(t) {
    // The bill from the first run is already there, so the diff is empty.
    const server = fakeServer({
      bills: [grant(300)],
      settingInfo: () => [grant(300)], // the vendor grants nothing new
    });
    const result = await withFetch(server, () => checkinOnce({ token: 'x', now: NOON }));
    assert.equal(result.outcome, 'done');
    assert.equal(result.credits, 0, 'no phantom credits');
    assert.doesNotMatch(result.message, /\+300/);
  },

  async 'an expired sign-in is reported as such, not retried as a failure'(t) {
    const server = {
      fetch: async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ code: 200001, message: 'unauthorized' }),
      }),
    };
    const result = await withFetch(server, () => checkinOnce({ token: 'x', now: NOON }));
    assert.equal(result.outcome, 'signed-out');
  },

  async 'no token means signed out, without any network call'(t) {
    const server = fakeServer();
    const result = await withFetch(server, () => checkinOnce({ token: '', now: NOON }));
    assert.equal(result.outcome, 'signed-out');
    assert.equal(server.state.calls.length, 0);
  },

  async 'a failing bills read keeps the day pending'(t) {
    const server = fakeServer({ bills: [], fail: { '/api/web/points/v1/bills': true } });
    server.fetch = (() => {
      const inner = server.fetch;
      return async (url, init) => {
        if (url.includes('/points/v1/bills')) throw new Error('network down');
        return inner(url, init);
      };
    })();
    const result = await withFetch(server, () => checkinOnce({ token: 'x', now: NOON }));
    assert.equal(result.outcome, 'failed');
    // A failed attempt must not mark the day done, or the credits are lost.
    const state = applyReport({ enabled: true, at: '09:00', lastDay: null }, result, NOON);
    assert.equal(state.lastDay, null);
  },

  'the report only settles a day that actually landed'() {
    const base = { enabled: true, at: '09:00', lastDay: null };
    assert.equal(applyReport(base, { outcome: 'claimed', credits: 300 }, NOON).lastDay, DAY);
    assert.equal(applyReport(base, { outcome: 'done' }, NOON).lastDay, DAY);
    assert.equal(applyReport(base, { outcome: 'failed' }, NOON).lastDay, null);
    assert.equal(applyReport(base, { outcome: 'signed-out' }, NOON).lastDay, null);
    const settled = applyReport(base, { outcome: 'claimed', credits: 300 }, NOON);
    assert.equal(settled.lastResult.credits, 300);
    assert.equal(settled.lastResult.ok, true);
  },

  'the persisted state survives junk and defaults to on at 09:00'() {
    assert.deepEqual(loadCheckin(() => null, 'x'), {
      enabled: true,
      at: '09:00',
      lastDay: null,
      lastResult: null,
    });
    const loaded = loadCheckin(() => ({ enabled: false, at: '7:5' }), 'x');
    assert.equal(loaded.enabled, false);
    assert.equal(loaded.at, '07:05');
    assert.equal(loadCheckin(() => 'nonsense', 'x').enabled, true);
  },
};
