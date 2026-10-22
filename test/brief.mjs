/**
 * The brief, the rhythm, and the ledger.
 *
 * These three are where a heartbeat either feels like one or does not, and none of
 * them is observable from a running deployment in a way that tells you which part
 * drifted. So they are pinned here: what she is told, how often she is told it, and
 * what survives a restart.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SILENT,
  beatBrief,
  clockLine,
  personLine,
  readOutcome,
  selfLine,
  sinceLastBeat,
} from '../lib/brief.js';
import {
  JOURNAL_KEEP,
  blankState,
  loadState,
  nextBeatAt,
  pushJournal,
  recentJournal,
  rollDay,
  saveState,
  underCeiling,
} from '../lib/schedule.js';

let failures = 0;
function check(ok, label) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'heartbeat-'));
const noon = Date.parse('2026-10-22T12:00:00+08:00');

// ---- the clock --------------------------------------------------------------
{
  console.log('she can see the time');
  const line = clockLine(noon, 'zh');
  check(line.includes('12:00'), `the hour and minute are stated (${line})`);
  check(line.includes('周四'), 'and the weekday, so "he said yesterday" has an anchor');
  // Coarse periods ("早上", "late night") are what the person-facing prompt uses.
  // Here it has to be exact, because the whole design hands her the judgement
  // about whether it is late — and she cannot make it from a fuzzy label.
  const late = clockLine(Date.parse('2026-10-22T03:14:00+08:00'), 'zh');
  check(late.includes('03:14'), 'including an hour a quiet-hours rule would have hidden from her');
  check(clockLine(noon, 'en').includes('12:00'), 'and in English');
}

// ---- the rhythm -------------------------------------------------------------
{
  console.log('the gap is a window, not an interval');
  const low = nextBeatAt({ now: noon, minMinutes: 30, maxMinutes: 90, random: () => 0 });
  const high = nextBeatAt({ now: noon, minMinutes: 30, maxMinutes: 90, random: () => 0.999 });
  check(low === noon + 30 * 60_000, `the floor is exact (${(low - noon) / 60_000}m)`);
  check(high > noon + 89 * 60_000 && high <= noon + 90 * 60_000, `the ceiling is respected (${Math.round((high - noon) / 60_000)}m)`);

  let inside = true;
  for (let i = 0; i < 200; i++) {
    const at = nextBeatAt({ now: noon, minMinutes: 30, maxMinutes: 90 });
    const gap = (at - noon) / 60_000;
    if (gap < 30 || gap > 90) inside = false;
  }
  check(inside === true, 'two hundred draws all land inside the window');

  // A fixed interval is a cron. The window is the difference, and it is only real
  // if the draws differ.
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(nextBeatAt({ now: noon, minMinutes: 30, maxMinutes: 90 }));
  check(seen.size > 20, `and they are actually spread (${seen.size}/40 distinct)`);

  // A misconfiguration must not become a busy loop.
  check(nextBeatAt({ now: noon, minMinutes: 0, maxMinutes: 0 }) >= noon + 60_000, 'a zero window still waits a minute');
  check(nextBeatAt({ now: noon, minMinutes: 90, maxMinutes: 30 }) >= noon + 90 * 60_000, 'an inverted window uses the larger value');
}

// ---- the brief --------------------------------------------------------------
{
  console.log('what she reads when she wakes');
  const brief = beatBrief({
    now: noon,
    language: 'zh',
    lastBeatAt: noon - 45 * 60_000,
    selfLines: ['翻了一下午搁浅的鲸鱼', '想跟他说那个视频，他在忙'],
  });

  check(brief.includes('12:00'), 'it opens with the time');
  check(brief.includes('45 分钟'), 'and how long since she last woke');
  check(brief.includes('搁浅的鲸鱼'), 'her own recent narration is carried in');
  check(brief.includes('想找他说话就说'), 'speaking is offered');
  check(brief.includes('不用交差'), 'and it ends by lifting the pressure to produce');
  check(brief.includes('DFYDJ'), 'her room is named, so "work on something" is not abstract');

  // The frame comes before the situation. Three of the first five real wakes
  // answered a bare `SILENT` because the brief read as a request for output, and
  // the cheapest response to a request is a short one.
  check(brief.startsWith('（这是你自己的时间'), `the brief opens by saying it is not a request (${brief.slice(0, 20)})`);

  // `SILENT` is still honoured by the parser, but it is no longer advertised: an
  // explicit opt-out at the bottom of a brief is an exit, and taking the exit is
  // always cheaper than staying in the moment.
  check(!brief.includes('SILENT'), 'the brief does not offer an explicit way out');

  // Order is the message: an earlier draft opened with "what do you want to work
  // on" and the agent answered it like a work queue.
  const speakAt = brief.indexOf('想找他说话');
  const workAt = brief.indexOf('想干点什么');
  check(speakAt >= 0 && workAt > speakAt, `speaking is offered before working (${speakAt} < ${workAt})`);

  // Nothing that reads like a permission check. If a future edit adds one, this
  // fails and the reviewer has to argue for it deliberately.
  for (const forbidden of ['不能', '禁止', '不允许', '配额', '额度']) {
    check(!brief.includes(forbidden), `the brief does not say 「${forbidden}」`);
  }

  const english = beatBrief({ now: noon, language: 'en' });
  check(english.includes('DFYDJ') && english.includes('Nobody is grading this'), 'the English brief is complete');
}

{
  console.log('a fresh agent gets a brief that does not mention an empty past');
  const brief = beatBrief({ now: noon, language: 'zh', selfLines: [] });
  check(!brief.includes('这几天你'), 'no empty "lately you" heading');
  check(brief.includes('12:00'), 'but the time is still there');
}

{
  console.log('the person is described only from facts the caller has');
  check(personLine({ now: noon, lastHeardAt: 0 }) === '', 'no data means no line');
  check(personLine({ now: noon, lastHeardAt: noon - 10 * 60_000 }) === '', 'a recent conversation is not narrated');
  check(personLine({ now: noon, lastHeardAt: noon - 5 * 3_600_000 }).includes('5 小时'), 'a long silence is stated as hours');
  check(personLine({ now: noon, lastHeardAt: noon - 100 * 3_600_000 }).includes('好几天'), 'and a very long one as days');
  check(sinceLastBeat(noon, 0) === '', 'the first wake mentions no previous wake');
}

// ---- reading what she did ---------------------------------------------------
{
  console.log('her answer is read, not assumed');
  const empty = readOutcome({ text: '', tools: [] });
  check(empty.said === '' && empty.silent === false && empty.didSomething === false, 'silence with no work is nothing at all');

  const declined = readOutcome({ text: SILENT, tools: [] });
  check(declined.silent === true, 'the bare word is a refusal');
  check(declined.said === '', 'and produces nothing to send');

  const quoted = readOutcome({ text: '「SILENT」', tools: [] });
  check(quoted.silent === true, 'a quoted form is still a refusal');

  const sentence = readOutcome({ text: '我不说 SILENT 那个词，但我在', tools: [] });
  check(sentence.silent === false, 'a sentence containing the word is a sentence');
  check(sentence.said === '我不说 SILENT 那个词，但我在', 'and is kept whole');

  const worked = readOutcome({ text: '', tools: ['read', 'read', 'write'] });
  check(worked.didSomething === true, 'an afternoon of work with no reply still counts as doing something');
  check(worked.said === '', 'and nothing gets sent because of it');

  const both = readOutcome({ text: '看到个东西', tools: ['web_search'] });
  check(both.said === '看到个东西' && both.didSomething === true, 'and the two can both be true');
}

// ---- the journal line -------------------------------------------------------
{
  console.log('one line per wake');
  check(selfLine({ silent: true }).includes('没说话'), 'a quiet wake says so');
  check(selfLine({ tools: ['read'] }).includes('read'), 'a working wake names what she touched');
  check(selfLine({ said: '看到个东西' }).includes('看到个东西'), 'a speaking wake quotes her');
  check(selfLine({}).includes('什么也没干'), 'and a wake with nothing says that');
  check(selfLine({ tools: ['a', 'b', 'c', 'd'] }).length <= 40, 'a line stays inside its length');
  check(selfLine({ said: '一'.repeat(100) }).length <= 40, 'even a long sentence is bounded');

  // Her replies are multi-line, and a newline let through here broke the next
  // brief's list layout — the journal is one line by contract.
  const multiline = selfLine({ said: '想去翻房间 结果发现爪子伸不到那儿\n\n算了 就趴着吧' });
  check(!multiline.includes('\n'), `a multi-line reply stays on one line (${JSON.stringify(multiline)})`);
}

// ---- the ledger -------------------------------------------------------------
{
  console.log('the ledger survives a restart');
  const path = join(dir, 'state.json');
  const fresh = loadState(path);
  check(fresh.lastBeatAt === 0, 'a missing file is a fresh state');
  check(Array.isArray(fresh.journal) && fresh.journal.length === 0, 'with an empty journal');

  const state = blankState();
  state.lastBeatAt = noon;
  state.beatsToday = 7;
  pushJournal(state, '醒着，什么也没干', noon);
  saveState(path, state);
  const back = loadState(path);
  check(back.lastBeatAt === noon, 'the last wake survived');
  check(back.beatsToday === 7, 'and the day count');
  check(recentJournal(back, 5).length === 1, 'and the journal');

  // A truncated write is the expected crash shape. Losing the rhythm is
  // recoverable; refusing to start is not.
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{"lastBeatAt": 12', 'utf8');
  const degraded = loadState(broken);
  check(degraded.lastBeatAt === 0, 'a corrupt file degrades to a fresh state');
  check(degraded.journal.length === 0, 'rather than throwing');

  // The journal is bounded, because it is read into every brief.
  const long = blankState();
  for (let i = 0; i < JOURNAL_KEEP + 20; i++) pushJournal(long, `第 ${i} 条`, noon + i);
  check(long.journal.length === JOURNAL_KEEP, `the journal is capped (${long.journal.length})`);
  check(recentJournal(long, 5).at(-1).includes(`${JOURNAL_KEEP + 19}`), 'and keeps the newest');

  // A hand-edited file must not inject a wall of text into her prompt.
  const hostile = join(dir, 'hostile.json');
  writeFileSync(
    hostile,
    JSON.stringify({ journal: [{ at: noon, line: '一'.repeat(500) }] }),
    'utf8',
  );
  const clipped = loadState(hostile);
  check(clipped.journal[0].line.length <= 40, `an over-long line is clipped on read (${clipped.journal[0].line.length})`);

  const raw = readFileSync(path, 'utf8');
  check(raw.includes('"version": 1'), 'the file carries a version');
  check(raw.endsWith('\n'), 'and ends with a newline, so a diff is readable');
}

// ---- crash detection, not a quota -------------------------------------------
{
  console.log('the ceiling is a runaway detector');
  const state = rollDay(blankState(), noon);
  check(underCeiling(state, 60) === true, 'a fresh day is under the ceiling');
  state.beatsToday = 60;
  check(underCeiling(state, 60) === false, 'a runaway day is stopped');
  check(underCeiling(state, 0) === true, 'and zero means no ceiling at all');

  // The roll must happen at local midnight, not at a fixed offset: a companion
  // that resets at 08:00 UTC starts counting again in the middle of their evening.
  const lateNight = rollDay({ ...blankState(), day: 'Wed Oct 21 2026', beatsToday: 40 }, noon);
  check(lateNight.beatsToday === 0, 'a new local day resets the count');
  const sameDay = rollDay({ ...blankState(), day: new Date(noon).toDateString(), beatsToday: 40 }, noon + 3_600_000);
  check(sameDay.beatsToday === 40, 'and the same day does not');
}

rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nheartbeat: all checks passed');
