/**
 * The beat schedule and the small ledger that has to survive a restart.
 *
 * Two different kinds of state live here, and conflating them is a real mistake:
 *
 *   - **The rhythm** is when the next beat happens. It is derived from a random
 *     interval and the time the last one ran, so losing it costs at most one
 *     restart's worth of timing — recoverable, and not worth a database.
 *
 *   - **The journal** is what she did with the last few wakes. It is the only
 *     thing that survives a compaction of her conversation, because `hippo`'s
 *     resident section carries facts and reflections but not the shape of an
 *     afternoon. Losing it means the next brief tells her nothing about herself.
 *
 * Both are small enough for one JSON file, and both must be written with the same
 * care: a truncated write must degrade to "start fresh", never to "refuse to
 * start". A companion that will not wake up because its journal is unreadable has
 * turned a cosmetic problem into an outage.
 *
 * Note what is deliberately *not* here: no daily counter, no unanswered ladder, no
 * gate that answers "may she speak". The design settled on giving her the decision
 * and keeping only crash detection — `dailyBeats` and `failureRun` below are that
 * detection, not a quota.
 *
 * @module dsh-heartbeat/schedule
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** How many journal lines are kept. Five are shown; the rest are history. */
export const JOURNAL_KEEP = 30;

/** How many characters one journal line may occupy. */
export const JOURNAL_LINE_MAX = 40;

/**
 * Resolve the state path without depending on a home-paths plugin.
 *
 * @param {string} configured - the configured path, possibly empty.
 * @returns {string} absolute path to the JSON state file.
 */
export function resolveStatePath(configured) {
  const text = String(configured ?? '').trim();
  if (text !== '') return text;
  const home = process.env.DSH_HOME?.trim();
  const root = home === undefined || home === '' ? join(homedir(), '.dsh') : home;
  return join(root, 'heartbeat', 'state.json');
}

/** @returns {void} */
function warn(message, detail) {
  process.emitWarning(
    detail === undefined ? message : `${message}: ${detail instanceof Error ? detail.message : String(detail)}`,
  );
}

/**
 * A blank ledger.
 *
 * `consecutiveFailures` and `pausedUntil` are crash detection. Without them a dead
 * model means every beat burns a call against the same wall forever — the exact
 * shape of the incident that put nine copies of one video title into her history
 * under `dsh-proactive`.
 *
 * @returns {object} fresh state.
 */
export function blankState() {
  return {
    lastBeatAt: 0,
    nextBeatAt: 0,
    beatsToday: 0,
    day: '',
    consecutiveFailures: 0,
    pausedUntil: 0,
    // When the review last completed, and the local day it covered. Two fields
    // rather than one: `nightlyDay` answers "has today been reviewed", and
    // `nightlyAt` answers "when was the last one at all", which is what a status
    // report needs when the first question comes back true.
    nightlyDay: '',
    nightlyAt: 0,
    journal: [],
  };
}

/**
 * Read the ledger.
 *
 * Every field is normalised rather than trusted: this file is edited by hand
 * during debugging, and a string where a number belongs must not become a NaN
 * that silently disables every comparison downstream.
 *
 * @param {string} path - the JSON file.
 * @param {(message: string, detail?: unknown) => void} [sink] - diagnostic sink.
 * @returns {object} the state.
 */
export function loadState(path, sink = warn) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return blankState();
  }
  try {
    const parsed = JSON.parse(raw);
    const journal = Array.isArray(parsed?.journal)
      ? parsed.journal
        .filter((row) => row !== null && typeof row === 'object')
        .map((row) => ({
          at: Math.max(0, Number(row.at) || 0),
          line: String(row.line ?? '').trim().slice(0, JOURNAL_LINE_MAX),
        }))
        .filter((row) => row.line !== '')
        .slice(-JOURNAL_KEEP)
      : [];
    return {
      lastBeatAt: Math.max(0, Number(parsed?.lastBeatAt) || 0),
      nextBeatAt: Math.max(0, Number(parsed?.nextBeatAt) || 0),
      beatsToday: Math.max(0, Number(parsed?.beatsToday) || 0),
      day: String(parsed?.day ?? ''),
      consecutiveFailures: Math.max(0, Number(parsed?.consecutiveFailures) || 0),
      pausedUntil: Math.max(0, Number(parsed?.pausedUntil) || 0),
      nightlyDay: String(parsed?.nightlyDay ?? ''),
      nightlyAt: Math.max(0, Number(parsed?.nightlyAt) || 0),
      journal,
    };
  } catch (error) {
    sink(`heartbeat: ignoring an unreadable state file at ${path}`, error);
    return blankState();
  }
}

/**
 * Write the ledger back.
 *
 * @param {string} path - the JSON file.
 * @param {object} state - what to keep.
 * @param {(message: string, detail?: unknown) => void} [sink] - diagnostic sink.
 * @returns {boolean} whether the write succeeded.
 */
export function saveState(path, state, sink = warn) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const payload = {
      version: 1,
      lastBeatAt: state.lastBeatAt ?? 0,
      nextBeatAt: state.nextBeatAt ?? 0,
      beatsToday: state.beatsToday ?? 0,
      day: state.day ?? '',
      consecutiveFailures: state.consecutiveFailures ?? 0,
      pausedUntil: state.pausedUntil ?? 0,
      nightlyDay: state.nightlyDay ?? '',
      nightlyAt: state.nightlyAt ?? 0,
      journal: Array.isArray(state.journal) ? state.journal.slice(-JOURNAL_KEEP) : [],
    };
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return true;
  } catch (error) {
    sink(`heartbeat: could not write state to ${path}`, error);
    return false;
  }
}

/**
 * The local day, as a key.
 *
 * Local, not UTC: a companion's day ends when theirs does, and a review keyed on
 * UTC midnight would run at eight in the morning in this timezone — reviewing a
 * day that already has a morning in it.
 *
 * @param {number} now - epoch milliseconds.
 * @returns {string} a stable per-day key.
 */
export function localDayKey(now) {
  return new Date(now).toDateString();
}

/**
 * When the nightly review is due, given a target clock time.
 *
 * Returns the most recent moment that target time passed, so a check that runs
 * after midnight but before the target still sees yesterday's as due rather than
 * waiting a full day.
 *
 * @param {number} now - epoch milliseconds.
 * @param {string} at - local HH:mm.
 * @returns {number} the epoch millisecond of the most recent due time.
 */
export function nightlyDueAt(now, at) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(at ?? '').trim());
  const hours = match === null ? 1 : Math.min(23, Math.max(0, Number(match[1])));
  const minutes = match === null ? 30 : Math.min(59, Math.max(0, Number(match[2])));
  const due = new Date(now);
  due.setHours(hours, minutes, 0, 0);
  if (due.getTime() > now) due.setDate(due.getDate() - 1);
  return due.getTime();
}

/**
 * Whether the review should run now.
 *
 * @param {number} now - epoch milliseconds.
 * @param {string} at - local HH:mm.
 * @param {string} lastDay - the day key of the last completed review, or ''.
 * @returns {boolean} whether it is due and not yet done.
 */
export function nightlyDue(now, at, lastDay) {
  const due = nightlyDueAt(now, at);
  const key = localDayKey(due);
  return lastDay !== key;
}

/**
 * Append one narration line, keeping the journal bounded.
 *
 * @param {object} state - the mutable state.
 * @param {string} line - one line, already trimmed.
 * @param {number} now - epoch milliseconds.
 * @returns {object} the same state, for chaining.
 */
export function pushJournal(state, line, now = Date.now()) {
  const text = String(line ?? '').trim().slice(0, JOURNAL_LINE_MAX);
  if (text === '') return state;
  const journal = Array.isArray(state.journal) ? state.journal : [];
  journal.push({ at: now, line: text });
  while (journal.length > JOURNAL_KEEP) journal.shift();
  state.journal = journal;
  return state;
}

/**
 * The last few narration lines, newest last, ready for the brief.
 *
 * @param {object} state - the state.
 * @param {number} [limit] - how many.
 * @returns {string[]} the lines.
 */
export function recentJournal(state, limit = 5) {
  const journal = Array.isArray(state?.journal) ? state.journal : [];
  return journal.slice(-Math.max(1, limit)).map((row) => String(row.line));
}

/**
 * The next wake time.
 *
 * Uniform over the window rather than a fixed interval, because a fixed interval
 * is a cron and reads as one: the visible difference between "wakes every ninety
 * minutes" and "wakes between thirty and ninety" is the difference between a
 * scheduler and a rhythm. The minimum is floored at one minute so a
 * misconfiguration cannot produce a busy loop.
 *
 * @param {object} input - the window.
 * @param {number} input.now - epoch milliseconds.
 * @param {number} [input.minMinutes] - shortest gap.
 * @param {number} [input.maxMinutes] - longest gap.
 * @param {() => number} [input.random] - injectable, for tests.
 * @returns {number} the next wake time.
 */
export function nextBeatAt(input) {
  const now = input.now;
  const random = input.random ?? Math.random;
  const low = Math.max(1, Number(input.minMinutes) || 30);
  const high = Math.max(low, Number(input.maxMinutes) || 90);
  const gap = low + random() * (high - low);
  return now + Math.round(gap * 60_000);
}

/**
 * Roll the per-day counter.
 *
 * This is crash detection, not a quota: `dailyBeats` is set high enough that only
 * a runaway timer reaches it. It exists because "she woke up two hundred times
 * today" is a bug in this plugin, and a bug that spends money silently for a month
 * is worse than one that announces itself.
 *
 * @param {object} state - the mutable state.
 * @param {number} now - epoch milliseconds.
 * @returns {object} the state.
 */
export function rollDay(state, now) {
  const day = new Date(now).toDateString();
  if (state.day !== day) {
    state.day = day;
    state.beatsToday = 0;
  }
  return state;
}

/**
 * Whether more wakes are allowed today.
 *
 * @param {object} state - the state, already rolled.
 * @param {number} ceiling - the hard ceiling.
 * @returns {boolean} whether a wake is allowed.
 */
export function underCeiling(state, ceiling) {
  const cap = Math.max(0, Number(ceiling) || 0);
  if (cap === 0) return true;
  return Number(state.beatsToday ?? 0) < cap;
}
