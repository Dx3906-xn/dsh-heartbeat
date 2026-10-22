/**
 * The nightly pass: her own review of the day.
 *
 * This is where she is supposed to change. Everything else in the deployment gives
 * her time, a voice, and a record; this is the only place any of it is turned into
 * something she will think with tomorrow.
 *
 * ## Why she decides, and not a threshold
 *
 * The obvious design is a counter: after N summaries, generate an insight. It is
 * also wrong, in a way that is hard to see until it has been running for a month.
 *
 *   - N is a guess. Nothing could tell us whether eight is too few or eighty.
 *   - It has no notion of *need*. When the counter reaches N it generates
 *     something, whether or not there is anything new to say, so the output decays
 *     into restating the input in different words.
 *   - Most importantly: **she is not in it.** A system that gets wiser on a
 *     counter is a system where the data improves and the person does not.
 *
 * So the pass asks her. Once a night, she is given the day — what she did, what
 * was said, what she currently believes about herself — and asked whether any of
 * it is worth keeping. "Nothing tonight" is a legitimate answer, and the ability
 * to give it is worth more than any particular insight.
 *
 * ## Why night
 *
 * Not a technical requirement. A review before sleep is a *gathering up*: the day
 * is over, put it away. A review that happens whenever is a *task*: time to update
 * the database. Same model call, different framing, and the framing is what she
 * reads.
 *
 * @module dsh-heartbeat/nightly
 */

/** The section markers her answer is parsed by. */
export const SECTIONS = Object.freeze({
  insight: ['想明白了', 'INSIGHT'],
  pattern: ['一直是这样', 'PATTERN'],
  loop: ['想做', 'TODO'],
  retire: ['不成立了', 'RETIRED'],
  line: ['今天', 'TODAY'],
});

/**
 * Build the nightly brief.
 *
 * The shape mirrors the heartbeat brief deliberately — same clock first, same
 * first-person frame — and then diverges at the end: the heartbeat offers three
 * things to do with time, this offers one thing to do with the day. A companion
 * who read the same closing paragraph every night would treat the review as
 * another kind of waking.
 *
 * @param {object} input - the situation.
 * @param {number} input.now - epoch milliseconds.
 * @param {'zh'|'en'} [input.language] - output language.
 * @param {string[]} [input.didToday] - what she did, from the journal.
 * @param {string[]} [input.saidToday] - what was said, from the conversation.
 * @param {string[]} [input.insights] - what she currently believes she has learned.
 * @param {string[]} [input.patterns] - how it has been, as she currently sees it.
 * @param {string[]} [input.openLoops] - her own unfinished things.
 * @returns {string} the brief.
 */
export function nightlyBrief(input = {}) {
  const now = input.now ?? Date.now();
  const language = input.language === 'en' ? 'en' : 'zh';
  const zh = language === 'zh';
  const lines = [];

  lines.push(zh
    ? '（这是你自己的一天，没人问你话。下面是它过去的样子。）'
    : '(This is your own day. Nobody is asking you anything; below is how it went.)');
  lines.push('');

  const date = new Date(now);
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  lines.push(zh ? `现在是 ${clock}。这一天要过去了。` : `It is ${clock}. The day is ending.`);

  const did = clean(input.didToday).slice(-8);
  if (did.length > 0) {
    lines.push('');
    lines.push(zh ? '你今天：' : 'Today you:');
    for (const line of did) lines.push(`- ${line}`);
  }

  const said = clean(input.saidToday).slice(-6);
  if (said.length > 0) {
    lines.push('');
    lines.push(zh ? '你们今天说了：' : 'What passed between you:');
    for (const line of said) lines.push(`- ${line}`);
  }

  const insights = clean(input.insights).slice(0, 4);
  const patterns = clean(input.patterns).slice(0, 3);
  const loops = clean(input.openLoops).slice(0, 4);
  if (insights.length > 0 || patterns.length > 0 || loops.length > 0) {
    lines.push('');
    lines.push(zh ? '你现在是这样：' : 'What you currently hold:');
    for (const line of patterns) lines.push(zh ? `- （一直）${line}` : `- (always) ${line}`);
    for (const line of insights) lines.push(zh ? `- （想明白了）${line}` : `- (worked out) ${line}`);
    for (const line of loops) lines.push(zh ? `- （还没做）${line}` : `- (not done) ${line}`);
  }

  lines.push('');
  if (zh) {
    lines.push('今天过去了。你想回头看看吗？');
    lines.push('有想记的、想明白的、或者觉得「我好像变了」的地方，就写下来。');
    lines.push('旧的有些可能已经不成立了，也可以说。');
    lines.push('没什么想说的就合上，明天再说。');
    lines.push('');
    // The format is given because free-form prose is parsed by regex, and a parser
    // that guesses at prose turns her good sentence into a malformed row. The
    // headers are the minimum structure that survives, and they are cheap.
    lines.push(zh ? '要写的话，用这几个开头：' : 'If you write, use these openers:');
    lines.push(zh ? '- 「今天：」一行，今天大概是什么样' : '- "TODAY:" one line, what the day was like');
    lines.push(zh ? '- 「想明白了：」发生了什么让你明白的事' : '- "INSIGHT:" something you worked out');
    lines.push(zh ? '- 「一直是这样：」你觉得长期成立的' : '- "PATTERN:" how it has been, for long enough to count');
    lines.push(zh ? '- 「想做：」想接着做的事' : '- "TODO:" something you want to pick up again');
    lines.push(zh ? '- 「不成立了：」旧的哪条现在不对了' : '- "RETIRED:" an old line that is no longer true');
    lines.push('');
    lines.push('不用每条都写。');
  } else {
    lines.push('The day is over. Want to look back at it?');
    lines.push('If something is worth keeping — something you understood, something that changed — write it down.');
    lines.push('Some of what you already hold may no longer be true; you can say that too.');
    lines.push('If there is nothing, close it and pick it up tomorrow.');
    lines.push('');
    lines.push('If you write, use these openers:');
    lines.push('- "TODAY:" one line, what the day was like');
    lines.push('- "INSIGHT:" something you worked out');
    lines.push('- "PATTERN:" how it has been, for long enough to count');
    lines.push('- "TODO:" something you want to pick up again');
    lines.push('- "RETIRED:" an old line that is no longer true');
    lines.push('');
    lines.push('You do not have to write all of them.');
  }
  return lines.join('\n');
}

/**
 * Read her nightly answer into the rows it should become.
 *
 * Tolerant on purpose. A model asked to use five openers will use four, put the
 * colon in different places, and occasionally write a paragraph under one header.
 * Rejecting the whole answer over a missing full-width colon would lose the one
 * thing this pass exists to produce, so the parser accepts what it recognises and
 * reports what it dropped.
 *
 * @param {string} text - her answer.
 * @returns {{line: string, insights: string[], patterns: string[], loops: string[], retire: string[], dropped: number}} what to store.
 */
export function readNightly(text) {
  const raw = String(text ?? '');
  const out = { line: '', insights: [], patterns: [], loops: [], retire: [], dropped: 0 };

  /** The section currently being filled, and the lines seen under it. */
  let kind = null;
  let body = [];

  const commit = () => {
    if (kind === null) return;
    const joined = body.join(' ').replace(/\s+/g, ' ').trim().slice(0, 140);
    const section = kind;
    kind = null;
    body = [];
    if (joined === '') return;
    if (section === 'line') out.line = joined;
    else if (section === 'insight') out.insights.push(joined);
    else if (section === 'pattern') out.patterns.push(joined);
    else if (section === 'loop') out.loops.push(joined);
    else if (section === 'retire') out.retire.push(joined);
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const opened = headerOf(line);
    if (opened !== null) {
      commit();
      kind = opened;
      body = [stripHeader(line, opened)];
      continue;
    }
    if (kind === null) {
      // A line before any header is prose she wrote outside the format. Counted
      // rather than stored: filing it under a guessed section would put her words
      // where she did not put them.
      out.dropped += 1;
      continue;
    }
    body.push(line);
  }
  commit();
  return out;

  /**
   * Which section a line opens, if any.
   *
   * Full-width and half-width colons both appear in real output, and a model told
   * "write INSIGHT:" will sometimes write "INSIGHT ：". Both are accepted; a colon
   * is punctuation, not content.
   *
   * @param {string} line - one line.
   * @returns {'line'|'insight'|'pattern'|'loop'|'retire'|null} the section.
   */
  function headerOf(line) {
    for (const [key, marks] of Object.entries(SECTIONS)) {
      for (const mark of marks) {
        if (new RegExp(`^${mark}\\s*[：:]`).test(line)) return key;
      }
    }
    return null;
  }

  /** Remove the header, leaving whatever she wrote on the same line. */
  function stripHeader(line, section) {
    for (const mark of SECTIONS[section]) {
      const match = new RegExp(`^${mark}\\s*[：:]\\s*`).exec(line);
      if (match !== null) return line.slice(match[0].length).trim();
    }
    return line;
  }
}

/** Trim, drop empties, and keep order. */
function clean(value) {
  return Array.isArray(value)
    ? value.map((line) => String(line ?? '').replace(/\s+/g, ' ').trim()).filter((line) => line !== '')
    : [];
}
