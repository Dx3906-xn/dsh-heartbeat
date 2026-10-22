/**
 * What she sees when she wakes up.
 *
 * This is the only text the heartbeat writes, and everything about her behaviour
 * follows from it: a brief that reads like a task list produces task-shaped
 * behaviour, a brief that reads like a schedule produces a schedule. So the shape
 * is deliberate.
 *
 * Three things are load-bearing:
 *
 *   - **The time comes first and is stated plainly.** Not as a permission gate but
 *     as a fact. A companion who cannot see the clock cannot be trusted to decide
 *     whether it is late, and one whose code decides for her never learns to.
 *
 *   - **Her own self comes before the person.** `hippo` renders that section as a
 *     system prompt section, so it arrives above this text; what this file adds is
 *     the frame that makes it *hers* rather than a briefing about a file.
 *
 *   - **Speaking is offered before doing.** The first thing offered is a sentence
 *     to somebody; work is the second. A brief that opens with "what do you want
 *     to work on" produces a worker. She is not a worker.
 *
 * The `SILENT` escape exists for the same reason it does in `dsh-proactive`: a
 * model given material and told to react will always react, and a companion that
 * cannot decline to speak is not choosing. Here it means "not tonight", which is a
 * legitimate answer to being awake.
 *
 * @module dsh-heartbeat/brief
 */

/** The one word that means "I have nothing to say to this". */
export const SILENT = 'SILENT';

const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * A clock reading a person would write.
 *
 * The hour is included, unlike `renderTimeContext` in hippo, because the whole
 * point of the heartbeat is that (a) she can see it is 03:14 and (b) the decision
 * about whether that matters is hers. "凌晨" alone is too coarse to act on and too
 * suggestive of a rule.
 *
 * @param {number} now - epoch milliseconds.
 * @param {'zh'|'en'} language - output language.
 * @returns {string} the clock line.
 */
export function clockLine(now, language = 'zh') {
  const date = new Date(now);
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  if (language === 'en') {
    return `It is ${hour}:${minute}, ${WEEKDAYS_EN[date.getDay()]}.`;
  }
  return `现在是 ${hour}:${minute}，${WEEKDAYS_ZH[date.getDay()]}。`;
}

/**
 * How long since she last woke, in words.
 *
 * Reported rather than computed-against-threshold: "四十分钟前" lets her notice a
 * rhythm, "不到九十分钟所以不能说话" would be a rule wearing a fact's clothes.
 *
 * @param {number} now - epoch milliseconds.
 * @param {number} lastBeatAt - when the previous beat ran, or 0.
 * @param {'zh'|'en'} language - output language.
 * @returns {string} one clause, or '' when there is nothing to say.
 */
export function sinceLastBeat(now, lastBeatAt, language = 'zh') {
  if (!Number.isFinite(lastBeatAt) || lastBeatAt <= 0) return '';
  const minutes = Math.max(0, Math.round((now - lastBeatAt) / 60_000));
  if (minutes < 2) return '';
  const phrase = minutes < 60
    ? (language === 'en' ? `${minutes} minutes` : `${minutes} 分钟`)
    : (() => {
      const hours = Math.round(minutes / 60);
      return language === 'en' ? `${hours} hours` : `${hours} 个小时`;
    })();
  return language === 'en' ? `Last time you were awake ${phrase} ago.` : `上次醒着是 ${phrase} 前。`;
}

/**
 * The other side: what the person is doing, as far as she can tell.
 *
 * Kept to facts the caller actually knows. An empty answer is correct and common
 * — inventing "he is probably busy" is how a companion starts narrating a person
 * instead of talking to one.
 *
 * @param {object} input - what the caller knows.
 * @param {number} [input.lastHeardAt] - when the person last said anything.
 * @param {number} [input.now] - epoch milliseconds.
 * @param {'zh'|'en'} [input.language] - output language.
 * @returns {string} one line, or ''.
 */
export function personLine(input = {}) {
  const now = input.now ?? Date.now();
  const language = input.language ?? 'zh';
  const last = Number(input.lastHeardAt ?? 0);
  if (!Number.isFinite(last) || last <= 0) return '';
  const minutes = Math.max(0, Math.round((now - last) / 60_000));
  if (minutes < 120) return '';
  const hours = Math.round(minutes / 60);
  if (language === 'en') {
    return hours < 48 ? `He has not said anything for about ${hours} hours.` : `He has been quiet for days.`;
  }
  return hours < 48 ? `他大概 ${hours} 小时没说话了。` : '他好几天没出声了。';
}

/**
 * Build the brief.
 *
 * @param {object} input - the situation.
 * @param {number} input.now - epoch milliseconds.
 * @param {'zh'|'en'} [input.language] - output language.
 * @param {number} [input.lastBeatAt] - previous wake, for the rhythm line.
 * @param {number} [input.lastHeardAt] - last thing the person said.
 * @param {string[]} [input.selfLines] - what she was doing lately, newest last.
 * @param {boolean} [input.canSpeak] - whether a channel can deliver a message.
 * @returns {string} the brief.
 */
export function beatBrief(input = {}) {
  const now = input.now ?? Date.now();
  const language = input.language === 'en' ? 'en' : 'zh';
  const zh = language === 'zh';
  const lines = [];

  // Said first, because the frame decides how everything after it is read.
  //
  // Without this opening the model reads the whole brief as a *request from
  // somebody* — "here is your situation, now respond" — and the cheapest way to
  // respond to a request for output is a short answer. Three of the first five
  // real wakes came back as a bare `SILENT`, which is the shape of a model that
  // believes it is being asked to produce something and cannot think of anything.
  //
  // The brief is not a request. It is time passing, and she is in it.
  lines.push(zh ? '（这是你自己的时间，没人问你话。下面是你醒来看到的东西。）' : '(This is your own time. Nobody is asking you anything; below is what you wake up to.)');
  lines.push('');

  lines.push(clockLine(now, language));

  const rhythm = sinceLastBeat(now, Number(input.lastBeatAt ?? 0), language);
  if (rhythm !== '') lines.push(rhythm);

  const selfLines = Array.isArray(input.selfLines)
    ? input.selfLines.map((line) => String(line ?? '').trim()).filter((line) => line !== '').slice(-5)
    : [];
  if (selfLines.length > 0) {
    lines.push('');
    // A heading, not a log label: the lines under it are fragments of her own
    // narration, and a bracketed field name would read like a database column.
    lines.push(zh ? '这几天你：' : 'Lately you:');
    for (const line of selfLines) lines.push(`- ${line}`);
  }

  const person = personLine({ now, language, lastHeardAt: input.lastHeardAt });
  if (person !== '') {
    lines.push('');
    lines.push(person);
  }

  lines.push('');
  if (zh) {
    // Order matters and it is the whole message: speak, then be quiet, then work.
    // An earlier draft put "what do you want to do" first, and the agent answered
    // it like a work queue.
    //
    // The last line is the important one. A brief that ends on "or say SILENT"
    // reads as an offer to opt out, and opting out is always the cheapest path —
    // the first real wakes all took it. Ending on "do whatever you feel like"
    // makes staying quiet one of the things she might feel like rather than the
    // exit from the question.
    lines.push('想找他说话就说。');
    lines.push('想自己待着也行。');
    lines.push('想干点什么就干——你的房间在 DFYDJ，可以看看、写点、翻翻东西。');
    lines.push('');
    lines.push('干什么都行，发会儿呆也算。不用交差。');
  } else {
    lines.push('Say something to him if you want to.');
    lines.push('Or keep to yourself.');
    lines.push('Or work on something — your room is DFYDJ; you can look around, write, dig into things.');
    lines.push('');
    lines.push('Anything is fine, including just sitting there. Nobody is grading this.');
  }
  return lines.join('\n');
}

/**
 * Read what she did with her time.
 *
 * Two independent channels, because they can disagree and the disagreement is
 * information:
 *
 *   - the **text** is what she said to the world; empty, a sentence, or `SILENT`
 *   - the **acts** are tool calls she made, which are the difference between an
 *     agent that sat still and one that read six pages and decided nothing was
 *     worth saying
 *
 * Judging only by text would file a productive afternoon as a wasted one, and
 * judging only by tools would file "wrote a draft she then deleted" as an
 * achievement.
 *
 * @param {object} input - the turn's observable output.
 * @param {string} [input.text] - the final assistant text.
 * @param {string[]} [input.tools] - names of tools called, in order.
 * @returns {{said: string, silent: boolean, tools: string[], didSomething: boolean}} what happened.
 */
export function readOutcome(input = {}) {
  const raw = String(input.text ?? '').trim();
  const tools = Array.isArray(input.tools) ? input.tools.map(String) : [];
  // `SILENT` counts only as the whole answer. "I'll stay SILENT" is a message a
  // person would read, and swallowing it hides a bug instead of preventing one.
  const silent = /^[\s"'“”「」『』`*]*SILENT[\s"'“”」』`*。.!！]*$/u.test(raw);
  return {
    said: silent ? '' : raw,
    silent,
    tools,
    didSomething: tools.length > 0,
  };
}

/**
 * One line of self-narration for the journal.
 *
 * Deliberately terse and derived rather than composed: this is a ledger the next
 * brief reads back, not prose. A model-written summary here would cost a call per
 * beat and drift into the same register as her conversation.
 *
 * @param {object} input - what happened.
 * @param {string} [input.said] - what she said, if anything.
 * @param {boolean} [input.silent] - whether she declined.
 * @param {string[]} [input.tools] - tools she used.
 * @param {'zh'|'en'} [input.language] - output language.
 * @returns {string} one line, at most ~40 characters.
 */
export function selfLine(input = {}) {
  const language = input.language === 'en' ? 'en' : 'zh';
  const zh = language === 'zh';
  const tools = Array.isArray(input.tools) ? input.tools.map(String) : [];
  // Whitespace is collapsed before anything else. Her replies are multi-line, and
  // a raw slice let a newline through into the journal — which then re-entered the
  // next brief as a broken list item. The line is one line by contract, so the
  // contract is enforced here rather than trusted at the call site.
  const said = String(input.said ?? '').replace(/\s+/g, ' ').trim();
  const parts = [];
  if (tools.length > 0) {
    const unique = [...new Set(tools)].slice(0, 3);
    parts.push(zh ? `动了动手（${unique.join('、')}）` : `worked (${unique.join(', ')})`);
  }
  if (said !== '') {
    parts.push(zh ? `说了句「${said.slice(0, 18)}」` : `said "${said.slice(0, 18)}"`);
  } else if (input.silent === true) {
    parts.push(zh ? '没说话' : 'stayed quiet');
  }
  if (parts.length === 0) parts.push(zh ? '醒着，什么也没干' : 'was awake and did nothing');
  const line = parts.join(zh ? '，' : ', ');
  return line.length <= 40 ? line : `${line.slice(0, 39)}…`;
}
