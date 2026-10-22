/**
 * The nightly review: the one place she is supposed to change.
 *
 * Two halves, and both are pinned here because both fail silently. The brief can
 * be written so that a model reads it as a chore and produces a summary of a
 * summary; the parser can be strict enough that a good answer is thrown away over
 * punctuation. Neither shows up as an error — the pass simply stops producing
 * anything, and a deployment that has stopped growing looks exactly like one that
 * has nothing to grow into.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nightlyBrief, readNightly, SECTIONS } from '../lib/nightly.js';
import { localDayKey, nightlyDue, nightlyDueAt } from '../lib/schedule.js';

let failures = 0;
function check(ok, label) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'nightly-'));
const evening = new Date(2026, 9, 22, 1, 30, 0).getTime();

// ---- the brief --------------------------------------------------------------
{
  console.log('what she reads at night');
  const brief = nightlyBrief({
    now: evening,
    language: 'zh',
    didToday: ['翻了一下午搁浅的鲸鱼', '写了点东西，删了'],
    saidToday: ['他说绘本稿还没交', '他说周末可能空'],
    insights: ['他忙的时候不太想说话'],
    patterns: ['周中他基本不出现'],
    openLoops: ['把鲸鱼资料看完'],
  });

  check(brief.includes('这一天要过去了'), 'it opens by closing the day');
  check(brief.includes('搁浅的鲸鱼'), 'what she did is carried in');
  check(brief.includes('绘本稿'), 'and what was said');
  check(brief.includes('（一直）'), 'her patterns are marked as patterns');
  check(brief.includes('（想明白了）'), 'and her insights as insights');
  check(brief.includes('还没做'), 'and what she is carrying');
  check(brief.includes('没什么想说的就合上'), 'doing nothing is a named option');

  // The frame, same as a wake: it is not a request. A model that reads a review as
  // a request writes a report, and a report is not a reflection.
  check(brief.startsWith('（这是你自己的一天'), 'the brief says nobody is asking');

  // The format is given, because the answer is parsed. Free-form prose would be
  // guessed at, and a guessed parse puts her words where she did not put them.
  for (const mark of ['今天：', '想明白了：', '一直是这样：', '想做：', '不成立了：']) {
    check(brief.includes(mark), `the brief offers the opener 「${mark}」`);
  }
  check(brief.includes('不用每条都写'), 'and says not every opener is required');

  const english = nightlyBrief({ now: evening, language: 'en' });
  check(english.includes('TODAY:') && english.includes('INSIGHT:'), 'the English brief has its openers');
  check(!english.includes('一天'), 'and no stray Chinese');
}

{
  console.log('an empty day is still a day worth asking about');
  const brief = nightlyBrief({ now: evening, language: 'zh' });
  check(!brief.includes('你今天：'), 'no empty "today you" heading');
  check(brief.includes('这一天要过去了'), 'but the day is still closed');
  check(brief.includes('没什么想说的就合上'), 'and she may still say nothing');
}

// ---- reading the answer -----------------------------------------------------
{
  console.log('her answer becomes rows');
  const answer = [
    '今天：翻了一下午搁浅的鲸鱼，没搞明白',
    '想明白了：他忙的时候真的不想说话，不是生气',
    '一直是这样：周中他基本不出现',
    '想做：把那个鲸鱼资料看完',
    '不成立了：他喜欢被问在干嘛',
  ].join('\n');
  const parsed = readNightly(answer);
  check(parsed.line.includes('搁浅的鲸鱼'), 'the day line is kept');
  check(parsed.insights.length === 1 && parsed.insights[0].includes('不是生气'), 'the insight is kept');
  check(parsed.patterns.length === 1 && parsed.patterns[0].includes('周中'), 'the pattern is kept');
  check(parsed.loops.length === 1 && parsed.loops[0].includes('资料'), 'the todo is kept');
  check(parsed.retire.length === 1 && parsed.retire[0].includes('被问'), 'the retirement is kept');
}

{
  console.log('the parse survives how models actually write');
  // Half-width colon, which a model told to write 「想明白了：」 still produces.
  const halfWidth = readNightly('INSIGHT: he does not like being asked');
  check(halfWidth.insights[0] === 'he does not like being asked', 'a half-width colon is accepted');

  // A space before the colon.
  const spaced = readNightly('想明白了 ：他其实挺累的');
  check(spaced.insights[0] === '他其实挺累的', 'a space before the colon is accepted');

  // A paragraph under one header wraps rather than becoming a second row.
  const wrapped = readNightly('想明白了：他忙的时候\n不想说话\n而不是生气');
  check(wrapped.insights.length === 1, 'a wrapped body stays one row');
  check(wrapped.insights[0].includes('不想说话'), 'and keeps all of it');

  // Nothing at all. "Tonight there is nothing" is a legitimate answer and must
  // produce no rows, not an error.
  const nothing = readNightly('今天没什么');
  check(nothing.insights.length === 0 && nothing.patterns.length === 0, 'a refusal produces nothing');
  check(nothing.line === '', 'and no invented day line');

  // Prose outside the format is counted, not filed. Filing it under a guessed
  // section would put her words where she did not put them.
  const stray = readNightly('随便写点什么\n没有标头');
  check(stray.dropped > 0, `unheadered prose is counted (${stray.dropped})`);
  check(stray.insights.length === 0 && stray.patterns.length === 0, 'and not filed anywhere');

  // A very long body is clipped rather than stored whole: this text goes into a
  // prompt every turn afterwards.
  const long = readNightly(`想明白了：${'一'.repeat(500)}`);
  check(long.insights[0].length <= 140, `an over-long line is clipped (${long.insights[0].length})`);

  const empty = readNightly('');
  check(empty.insights.length === 0 && empty.dropped === 0, 'an empty answer is not a parse failure');
}

// ---- when it runs -----------------------------------------------------------
{
  console.log('the review is due once per local day');
  const at0130 = new Date(2026, 9, 23, 2, 0, 0).getTime();
  check(nightlyDue(at0130, '01:30', '') === true, 'a review never done is due');
  check(nightlyDue(at0130, '01:30', localDayKey(new Date(2026, 9, 22, 1, 30, 0).getTime())) === true, 'and is due again the next day');
  check(nightlyDue(at0130, '01:30', localDayKey(at0130)) === false, 'but not twice on one day');

  // Before the target time, the most recent due moment is *yesterday's*. So a
  // process that starts at 01:20 and has not reviewed since yesterday still sees
  // a review as due rather than waiting a whole day for the next one.
  const at0120 = new Date(2026, 9, 23, 1, 20, 0).getTime();
  const yesterday = localDayKey(new Date(2026, 9, 22, 1, 30, 0).getTime());
  check(nightlyDue(at0120, '01:30', yesterday) === false, 'just before the hour, yesterday\'s review counts');
  check(nightlyDue(at0120, '01:30', '') === true, 'unless there was none');

  check(nightlyDueAt(at0130, '01:30') <= at0130, 'the due moment is in the past');
  check(nightlyDueAt(at0130, '01:30') > at0130 - 25 * 3_600_000, 'and less than a day ago');

  // A malformed time must not throw during a wake, and must not silently mean
  // "every minute".
  const broken = nightlyDueAt(at0130, 'nonsense');
  check(Number.isFinite(broken) === true, 'a malformed hour still resolves');

  check(localDayKey(new Date(2026, 9, 22, 23, 59, 0).getTime()) !== localDayKey(new Date(2026, 9, 23, 0, 1, 0).getTime()), 'the day key turns at local midnight');
}

rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nnightly: all checks passed');
