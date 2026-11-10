/**
 * Beijing-time helpers.
 *
 * Raccoon's daily grant is cut at Beijing midnight, so the schedule is evaluated
 * in that zone regardless of where the machine is. Working on the epoch offset
 * avoids depending on the host's timezone database or ICU.
 */

export const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

/** `YYYY-MM-DD` in Beijing time, the key the vendor uses for a grant day. */
export function beijingDay(now = Date.now()) {
  return new Date(now + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/** Minutes since Beijing midnight. */
export function beijingMinutes(now = Date.now()) {
  const date = new Date(now + BEIJING_OFFSET_MS);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

export const DEFAULT_AT = '09:00';

/**
 * `HH:MM` to minutes.
 *
 * Minutes are accepted with or without a leading zero (`7:5`, `07:05`, `7:05`),
 * because a schedule field people type into should not reject the obvious input.
 * Anything else falls back to the default slot.
 */
export function parseAt(value) {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(String(value ?? '').trim());
  if (!match) return 9 * 60;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : 9 * 60;
}

export function normalizeAt(value) {
  const minutes = parseAt(value);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
