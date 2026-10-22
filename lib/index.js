/**
 * The heartbeat.
 *
 * What this plugin is for, in one paragraph: an agent that only exists when
 * somebody talks to it is answering, not living. Most of what makes a companion
 * feel present is that time passes on her side of the conversation too — she
 * thinks about something, reads something, grows bored, and occasionally has
 * something to say that nobody asked for. This plugin produces those moments by
 * waking her on a random interval, handing her a brief that states what time it
 * is and offers three things to do with the time (speak, stay quiet, work), and
 * writing down what she chose.
 *
 * Four boundaries are load-bearing.
 *
 *   - **It wakes her; it does not script her.** Nothing here decides what she
 *     says or whether she says it. The brief offers, the model answers, and an
 *     empty answer is a legitimate result. A plugin that composed her sentences
 *     would be a second writer with a worse model of the relationship.
 *
 *   - **The decision to speak is split from the act of speaking.** Her own time
 *     runs in a session with no conversation in it, so a message written there
 *     would be written blind. She writes an intent; the intent is delivered into
 *     the conversation that knows the person, and the sentence is written there.
 *     Two calls, and worth both: a line composed with the conversation in view
 *     reads like a line, and one composed without it reads like a bulletin.
 *
 *   - **What she does is recorded, or the whole thing is pointless.** A wake that
 *     leaves no trace is a wake that never happened, and a hundred of them are
 *     still nothing. The journal line and the `self` episode are the mechanism by
 *     which her own time accumulates into a self.
 *
 *   - **Only crash detection gates her.** No daily speaking quota, no unanswered
 *     ladder, no quiet-hours prohibition — those were in the first draft and were
 *     wrong: a rule in code makes the corresponding judgement in her persona dead
 *     weight. What remains (`dailyBeats`, `failurePauseAfter`) answers "is this
 *     plugin broken", not "should she talk".
 *
 * @module dsh-heartbeat
 */

import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';

import { beatBrief, readOutcome, selfLine } from './brief.js';
import { nightlyBrief, readNightly } from './nightly.js';
import {
  blankState,
  loadState,
  localDayKey,
  nextBeatAt,
  nightlyDue,
  pushJournal,
  recentJournal,
  resolveStatePath,
  rollDay,
  saveState,
  underCeiling,
} from './schedule.js';

export const name = 'heartbeat';

/**
 * Plugin configuration.
 *
 * The defaults describe a companion who wakes about twenty times a day, mostly
 * finds nothing worth doing, and writes a line about it. `minMinutes`/`maxMinutes`
 * bracket the rhythm; nothing here is a permission.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('Mount the heartbeat. Off means she only exists when spoken to.'),
  statePath: z
    .string()
    .default('')
    .description('Where the rhythm and journal live. Empty uses $DSH_HOME/heartbeat/state.json.'),
  room: z
    .string()
    .default('D:\\A\\DSH-L\\DFYDJ')
    .description('Her own directory. Files she writes land here, and the sandbox keeps it that way.'),
  sessionPrefix: z
    .string()
    .default('hb:')
    .description('Prefix of the heartbeat session id. The rest is the preset, so two personas cannot collide.'),
  preset: z
    .string()
    .default('companion')
    .description('Agent preset her own time runs under. Empty uses the profile default.'),
  minMinutes: z.number().default(30).description('Shortest gap between two wakes.'),
  maxMinutes: z.number().default(90).description('Longest gap between two wakes.'),
  dailyBeats: z
    .number()
    .default(60)
    .description('Hard ceiling on wakes per day. Not a quota — a runaway-timer detector. 0 disables it.'),
  failurePauseAfter: z
    .number()
    .default(3)
    .description('After this many wakes in a row that produced nothing, stop retrying into the same wall.'),
  failurePauseMinutes: z.number().default(30).description('How long to stay stopped once that happens.'),
  journalShown: z.number().default(5).description('How many of her recent lines the brief shows.'),
  language: z.union(['zh', 'en']).default('zh').description('Language of the brief.'),
  provider: z.string().default('').description('Provider route for the wake turn.'),
  model: z.string().default('').description('Model for the wake turn. Empty uses the profile default.'),
  /** Where an intent goes: the service that owns the conversation with the person. */
  channel: z.string().default('qq').description('Service that can deliver a message into a real conversation.'),
  idleTimeoutMs: z
    .number()
    .default(10 * 60_000)
    .description('Give up waiting for one wake after this long, so a stuck turn cannot stop the rhythm.'),
  nightly: z.boolean().default(true).description('Mount the nightly review: her own look back at the day, where she decides what to keep.'),
  nightlyAt: z
    .string()
    .default('01:30')
    .description('Local time for the review, HH:mm. It runs once per local day, at or after this time.'),
});

/**
 * Mount the plugin.
 *
 * @param {any} ctx - plugin context.
 * @param {z.infer<typeof Config>} config - validated configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  if (config.enabled !== true) {
    process.emitWarning('heartbeat: disabled by configuration; she will only exist when spoken to');
    return;
  }

  const statePath = resolveStatePath(config.statePath);
  const state = loadState(statePath);
  let timer = null;
  let running = false;
  let stopped = false;

  process.emitWarning(
    `heartbeat: mounted (every ${config.minMinutes}-${config.maxMinutes}m, room ${config.room})`,
  );

  /** The conversation service, looked up per call so load order does not matter. */
  const channel = () => (typeof ctx.get === 'function' ? ctx.get(String(config.channel || 'qq')) : undefined);

  /** The agent's own session id, fixed for this deployment. */
  const sessionId = () => `${String(config.sessionPrefix || 'hb:')}${String(config.preset || 'default')}`;

  /**
   * Open or resume the agent she runs as during her own time.
   *
   * `resume`, not `create`, once the session exists: `create` on an existing id
   * either throws or silently starts over, and starting over would erase her own
   * history on every restart — which is the failure this whole design exists to
   * prevent, so it must not be reintroduced by the plumbing.
   *
   * @returns {Promise<any>} the live agent.
   */
  async function ensureAgent() {
    const agents = ctx.get('agents');
    if (agents === undefined) throw new Error('no agents service');
    const id = sessionId();
    const already = typeof agents.get === 'function' ? agents.get(id) : undefined;
    if (already !== undefined) return already;

    const selection = route();
    const setup = async (agentCtx) => {
      const presets = ctx.get('agentPresets');
      if (presets === undefined) return;
      const wanted = String(config.preset ?? '').trim();
      const resolved = (await presets.resolve(wanted === '' ? undefined : wanted)).id;
      await presets.mount(agentCtx, resolved);
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
    };

    const store = ctx.get('sessionPersistence');
    const exists = store !== undefined && typeof store.stat === 'function'
      ? (await store.stat(id)) !== undefined
      : false;

    const handle = exists
      ? await agents.resume({ resumeSessionId: id, agentOptions: selection, setup })
      : await agents.create({ sessionId: id, meta: { cwd: config.room }, agentOptions: selection, setup });
    await handle.agent.whenIdle();
    return handle.agent;
  }

  /** The model route for her own turns. */
  function route() {
    const provider = String(config.provider ?? '').trim();
    const model = String(config.model ?? '').trim();
    if (provider !== '' && model !== '') return { provider, model };
    const defaults = ctx.get('agentDefaultModel');
    if (defaults !== undefined && typeof defaults.currentSelection === 'function') {
      const selection = defaults.currentSelection();
      return { provider: selection.provider, model: selection.model };
    }
    return {};
  }

  /**
   * One wake.
   *
   * @param {boolean} [force] - run even when paused, for a manual test.
   * @returns {Promise<object>} what happened.
   */
  async function beat(force = false) {
    if (stopped) return { woke: false, reason: 'stopped' };
    if (running) return { woke: false, reason: 'already awake' };

    const now = Date.now();
    rollDay(state, now);
    if (!force) {
      if (state.pausedUntil > now) {
        const wait = Math.ceil((state.pausedUntil - now) / 60_000);
        return { woke: false, reason: `paused for ${wait} more minutes after repeated failures` };
      }
      if (!underCeiling(state, config.dailyBeats)) {
        return { woke: false, reason: `woke ${state.beatsToday} times today; that is a bug, not a rhythm` };
      }
    }

    running = true;
    try {
      const agent = await ensureAgent();
      const before = agent.session.seq;
      const bridge = channel();

      const brief = beatBrief({
        now,
        language: config.language,
        lastBeatAt: state.lastBeatAt,
        lastHeardAt: typeof bridge?.lastActiveAt === 'function' ? bridge.lastActiveAt(recentTarget()) : 0,
        selfLines: recentJournal(state, config.journalShown),
      });

      agent.followup(createUserMessage({
        content: [{ type: 'text', text: brief }],
        source: {
          // Session v4 refuses a bare `kind: 'plugin'`: the producer has to name
          // itself. `form: 'instructions'` is the marker that keeps memory
          // plugins from filing this text as something a person said — without it
          // she would later believe the owner had told her to go do something.
          kind: `plugin:${name}`,
          form: 'instructions',
          summary: 'her own time, not a message from anyone',
        },
      }));

      const outcome = await withTimeout(agent.whenIdle(), config.idleTimeoutMs);
      const turn = readOutcome({
        text: lastAssistantText(agent.session, before),
        tools: toolNames(agent.session, before),
      });

      state.lastBeatAt = now;
      state.beatsToday += 1;
      pushJournal(state, selfLine({ ...turn, language: config.language }), now);

      // What she did is the point. An episode and a journal line are the same
      // fact recorded twice on purpose: the episode is queryable and ages with
      // the rest of memory, the line is cheap and survives compaction.
      recordSelf(agent.session, before, turn);

      if (!turn.said && !turn.didSomething && !turn.silent) {
        // Only a wake that produced *nothing at all* counts as a failure: no
        // words, no tools, no refusal. A bare `SILENT` is her decision, and the
        // first live run proved why this distinction matters — three quiet wakes
        // in a row were counted as three failures and parked the plugin for half
        // an hour, which turned "she did not feel like talking" into "she is
        // broken". `dsh-proactive` already made this distinction; the heartbeat
        // has to as well, or it punishes her for the one behaviour the brief
        // explicitly permits.
        state.consecutiveFailures += 1;
        if (state.consecutiveFailures >= Math.max(1, Number(config.failurePauseAfter) || 3)) {
          state.pausedUntil = now + Math.max(1, Number(config.failurePauseMinutes) || 30) * 60_000;
          state.consecutiveFailures = 0;
        }
      } else {
        // Anything at all — a sentence, a tool call, or a deliberate silence —
        // means the turn worked.
        state.consecutiveFailures = 0;
      }

      let delivered = null;
      if (turn.said !== '') delivered = await forward(turn.said);

      state.nextBeatAt = nextBeatAt({ now, minMinutes: config.minMinutes, maxMinutes: config.maxMinutes });
      saveState(statePath, state);
      return { woke: true, ...turn, delivered, nextBeatAt: state.nextBeatAt };
    } catch (error) {
      state.consecutiveFailures += 1;
      state.nextBeatAt = nextBeatAt({ now, minMinutes: config.minMinutes, maxMinutes: config.maxMinutes });
      saveState(statePath, state);
      return { woke: false, reason: String(error?.message ?? error) };
    } finally {
      running = false;
    }
  }

  /**
   * The conversation her intent should land in.
   *
   * `conversations()` first, `recentTarget()` second — and the order is a bug fix,
   * not a preference. `recentTarget()` reads only the in-process recency list,
   * which is empty after a restart until somebody speaks; a heartbeat that starts
   * five seconds after boot therefore had nowhere to deliver to and reported "no
   * conversation to speak into" for every wake until a person happened to message
   * first. The channel's own roster is the durable answer, and it already exists.
   *
   * @returns {string} a conversation key, or ''.
   */
  function recentTarget() {
    const bridge = channel();
    if (bridge === undefined) return '';
    if (typeof bridge.conversations === 'function') {
      const rooms = bridge.conversations();
      // Private first: a message meant for one person belongs in the conversation
      // with them, and a room is the fallback rather than the default.
      const ordered = [...rooms].sort((a, b) => {
        const rank = (entry) => (entry?.target?.kind === 'group' ? 1 : 0);
        return rank(a) - rank(b);
      });
      const first = ordered.find((entry) => String(entry?.key ?? '') !== '');
      if (first !== undefined) return String(first.key);
    }
    if (typeof bridge.recentTarget === 'function') return String(bridge.recentTarget() ?? '');
    return '';
  }

  /**
   * Deliver one intent into the conversation, and let that side write the words.
   *
   * The two-step split is the whole reason her message reads like a message. The
   * heartbeat turn knows what she thought and nothing about the room; the
   * conversation turn knows the room and nothing about what she was thinking. The
   * brief carries the thought; the conversation carries the voice.
   *
   * @param {string} said - what she decided to say, in her own words.
   * @returns {Promise<{ok: boolean, error?: string}|null>} the delivery result.
   */
  async function forward(said) {
    const bridge = channel();
    const key = recentTarget();
    if (bridge === undefined) {
      process.emitWarning(`heartbeat: no channel service named "${config.channel}"; what she said was not delivered`);
      return { ok: false, error: `no channel service named "${config.channel}"` };
    }
    if (key === '') {
      process.emitWarning('heartbeat: the channel knows no conversation; what she said was not delivered');
      return { ok: false, error: 'no conversation to speak into' };
    }
    const text = String(said).trim();
    if (text === '') return null;
    try {
      // `send` rather than `speak`: the words already exist. Running another
      // model turn here would rewrite what she just decided into something a
      // second inference thinks she meant.
      if (typeof bridge.send !== 'function') {
        process.emitWarning('heartbeat: the channel cannot deliver a message');
        return { ok: false, error: 'the channel cannot deliver a message' };
      }
      const result = await bridge.send(key, text);
      // A failed delivery is the one thing here that must never be silent: she
      // decided to say something, and if it did not go out the journal will show
      // a wake where she spoke and nothing happened, which reads as a bug in her
      // rather than a bug in the channel.
      if (result?.ok !== true) {
        process.emitWarning(`heartbeat: could not deliver to ${key}: ${result?.error ?? 'unknown error'}`);
      }
      return result;
    } catch (error) {
      process.emitWarning(`heartbeat: could not deliver to ${key}: ${error?.message ?? error}`);
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /**
   * File what she did as an episode under her own voice.
   *
   * `actor: 'self'` is the third voice added in hippo's migration 17, and the
   * distinction matters: `agent` means "this is what I answered you", which is a
   * line inside a conversation. What she did on her own time is not part of any
   * conversation, and filing it as one makes it unrecallable as experience.
   *
   * Written through the hippo service when present, and skipped quietly when it
   * is not: a profile without memory should still be able to wake her up.
   *
   * @param {any} session - her session.
   * @param {number} before - the seq the wake started at.
   * @param {object} turn - the outcome.
   * @returns {void}
   */
  function recordSelf(session, before, turn) {
    const memory = ctx.get('hippo');
    if (memory === undefined || typeof memory.recordSelf !== 'function') return;
    const text = turn.said !== ''
      ? turn.said
      : `${turn.didSomething ? turn.tools.join(', ') : 'awake'}: ${selfLine({ ...turn, language: config.language })}`;
    try {
      memory.recordSelf({ sessionId: String(session.header?.id ?? sessionId()), text, at: Date.now() });
    } catch (error) {
      process.emitWarning(`heartbeat: could not record what she did: ${error?.message ?? error}`);
    }
  }

  /**
   * The nightly review: the one place where the day becomes something she thinks
   * with tomorrow.
   *
   * Deliberately a separate turn from a wake, not a branch inside one. A wake asks
   * what she wants to do with the next hour; this asks what she makes of the last
   * day. Those are different stances, and merging them produces a companion who
   * reviews her life as a chore between activities.
   *
   * @param {boolean} [force] - run even if it already ran today, for a test.
   * @returns {Promise<object>} what came of it.
   */
  async function nightly(force = false) {
    if (stopped) return { ran: false, reason: 'stopped' };
    if (config.nightly === false) return { ran: false, reason: 'nightly review is turned off' };
    if (running) return { ran: false, reason: 'already awake' };
    const now = Date.now();
    const today = localDayKey(now);
    if (!force && state.nightlyDay === today) {
      return { ran: false, reason: `already reviewed ${today}` };
    }

    running = true;
    try {
      const agent = await ensureAgent();
      const before = agent.session.seq;
      const memory = ctx.get('hippo');

      // What she did, from her own journal; what was said, from the conversation
      // her channel knows. Both are optional: a day with no memory and no messages
      // is a day worth asking about too, and a pass that refused without material
      // would silently stop the only growth mechanism this design has.
      const didToday = recentJournal(state, 8);
      const saidToday = typeof memory?.dayDigest === 'function' ? memory.dayDigest({ now, language: config.language }) : [];
      const insights = typeof memory?.reflections === 'function'
        ? memory.reflections({ minLevel: 1, limit: 20 }).filter((row) => Number(row.level) === 1).map((row) => String(row.text))
        : [];
      const patterns = typeof memory?.reflections === 'function'
        ? memory.reflections({ minLevel: 2, limit: 20 }).filter((row) => Number(row.level) === 2).map((row) => String(row.text))
        : [];
      const loops = typeof memory?.openLoops === 'function'
        ? memory.openLoops({ subject: 'agent', limit: 6 }).map((row) => String(row.text ?? ''))
        : [];

      const brief = nightlyBrief({ now, language: config.language, didToday, saidToday, insights, patterns, openLoops: loops });

      agent.followup(createUserMessage({
        content: [{ type: 'text', text: brief }],
        source: {
          kind: `plugin:${name}`,
          form: 'instructions',
          summary: 'her own look back at the day',
        },
      }));

      await withTimeout(agent.whenIdle(), config.idleTimeoutMs);
      const answer = lastAssistantText(agent.session, before);
      const parsed = readNightly(answer);

      // Store before recording the day as done. If the write fails, the pass did
      // not happen, and marking it complete would skip tomorrow's only chance to
      // correct that.
      const stored = applyNightly(memory, parsed);

      state.nightlyDay = today;
      state.nightlyAt = now;
      if (parsed.line !== '') pushJournal(state, `夜里想：${parsed.line}`, now);
      saveState(statePath, state);

      // A review that produced nothing at all is worth saying out loud: it is the
      // difference between "she had no thoughts today" and "the parse dropped
      // everything she wrote", and only one of those is a bug.
      if (stored.insights + stored.patterns + stored.loops + stored.retired === 0) {
        process.emitWarning(
          `heartbeat: the nightly review produced nothing (${parsed.dropped} line(s) outside the format, answer ${answer.trim() === '' ? 'empty' : `${answer.trim().length} chars`})`,
        );
      }
      return { ran: true, parsed, stored, said: answer };
    } catch (error) {
      return { ran: false, reason: String(error?.message ?? error) };
    } finally {
      running = false;
    }
  }

  /**
   * Turn her parsed answer into rows.
   *
   * Each kind goes somewhere different because each means something different:
   * an insight is a conclusion, a pattern is a conclusion that outlived a week, a
   * loop is a thing to do, and a retirement is a belief she is giving up. Writing
   * them all as reflections would lose the distinction between "I work out that X"
   * and "I have decided to pick X up tomorrow".
   *
   * @param {any} memory - the hippo service, or undefined.
   * @param {object} parsed - the read answer.
   * @returns {{insights: number, patterns: number, loops: number, retired: number}} counts.
   */
  function applyNightly(memory, parsed) {
    const counts = { insights: 0, patterns: 0, loops: 0, retired: 0 };
    if (memory === undefined) return counts;

    for (const text of parsed.insights) {
      if (typeof memory.addReflection === 'function' && memory.addReflection({ text, level: 1 }).stored === true) counts.insights += 1;
    }
    for (const text of parsed.patterns) {
      if (typeof memory.addReflection === 'function' && memory.addReflection({ text, level: 2 }).stored === true) counts.patterns += 1;
    }
    for (const text of parsed.loops) {
      if (typeof memory.addSelfLoop === 'function' && memory.addSelfLoop(text).stored === true) counts.loops += 1;
    }
    // RETIRED is matched by text against what she currently holds, not by id: she
    // was shown her beliefs as sentences, so asking her to quote an id nobody gave
    // her would be asking her to fail.
    for (const text of parsed.retire) {
      if (typeof memory.retireReflectionByText !== 'function') continue;
      if (memory.retireReflectionByText(text).retired === true) counts.retired += 1;
    }
    return counts;
  }

  /** Schedule the next wake from the stored target, re-deriving if it has passed. */
  function schedule() {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    const now = Date.now();
    if (state.nextBeatAt <= now) {
      state.nextBeatAt = nextBeatAt({ now, minMinutes: config.minMinutes, maxMinutes: config.maxMinutes });
      saveState(statePath, state);
    }
    const delay = Math.max(1000, state.nextBeatAt - now);
    timer = setTimeout(() => {
      timer = null;
      // The review is checked before the wake, and it does not consume the beat.
      // They are different questions about different spans of time, and letting a
      // review take the slot would silently halve the number of wakes on the night
      // it runs.
      void maybeNightly()
        .then(() => beat())
        .finally(schedule);
    }, delay);
    // A heartbeat must not be the reason a process refuses to exit.
    timer.unref?.();
  }

  /**
   * Run the review if it is due.
   *
   * The due check lives here rather than on its own timer because one timer is
   * one thing to get wrong. A second `setTimeout` would drift against this one,
   * fire during a wake, and need its own pause logic; asking before each wake
   * costs a string comparison.
   *
   * @returns {Promise<void>} resolves when any due review has run.
   */
  async function maybeNightly() {
    if (config.nightly === false) return;
    if (!nightlyDue(Date.now(), config.nightlyAt, state.nightlyDay)) return;
    // A review takes as long as a wake and matters less than the person waiting
    // for a reply, so it is skipped rather than queued when one is already running.
    if (running) return;
    const result = await nightly();
    if (result.ran === true) {
      process.emitWarning(
        `heartbeat: nightly review done (${result.stored.insights} insight, ${result.stored.patterns} pattern, ${result.stored.loops} todo, ${result.stored.retired} retired)`,
      );
    }
  }

  const service = {
    /** Wake her now, ignoring the rhythm. Policy ceilings still apply unless forced. */
    async beat(options = {}) {
      const result = await beat(options.force === true);
      if (result.woke === true) schedule();
      return result;
    },
    /**
     * Run the nightly review now.
     *
     * Exposed so it can be tested and so an operator can make it happen without
     * waiting for 01:30. `force` skips the once-per-day check; without it, calling
     * this twice in one evening runs it once, which is what a status poller wants.
     */
    async nightly(options = {}) {
      return nightly(options.force === true);
    },
    /** What the rhythm has been doing. */
    status() {
      return {
        sessionId: sessionId(),
        room: config.room,
        lastBeatAt: state.lastBeatAt,
        nextBeatAt: state.nextBeatAt,
        beatsToday: state.beatsToday,
        consecutiveFailures: state.consecutiveFailures,
        pausedUntil: state.pausedUntil,
        nightlyDay: state.nightlyDay,
        nightlyAt: state.nightlyAt,
        nightlyDue: config.nightly === false ? false : nightlyDue(Date.now(), config.nightlyAt, state.nightlyDay),
        journal: state.journal.slice(-10),
        statePath,
      };
    },
    /** Stop the rhythm (the timer only; a running wake finishes). */
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };

  ctx.effect(() => ctx.provide('heartbeat', service));

  // The rhythm starts on the next tick rather than here: during `apply` the
  // session persistence and preset registry are not necessarily up yet, and a
  // first wake that fails for that reason would count against the failure budget.
  ctx.effect(() => {
    const start = setTimeout(() => {
      if (state.nextBeatAt <= Date.now()) {
        state.nextBeatAt = nextBeatAt({
          now: Date.now(),
          minMinutes: config.minMinutes,
          maxMinutes: config.maxMinutes,
        });
        saveState(statePath, state);
      }
      schedule();
    }, 5_000);
    start.unref?.();
    return () => {
      stopped = true;
      clearTimeout(start);
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
  });
}

/**
 * Wait for a promise, but not forever.
 *
 * A wake that hangs must not stop the rhythm: the whole value of a heartbeat is
 * that it keeps happening. Losing one wake is cheap; losing the beat is not.
 *
 * @template T
 * @param {Promise<T>} promise - what to wait for.
 * @param {number} ms - the ceiling.
 * @returns {Promise<T|undefined>} the value, or undefined on timeout.
 */
async function withTimeout(promise, ms) {
  const limit = Math.max(1000, Number(ms) || 600_000);
  let handle;
  const timeout = new Promise((resolve) => {
    handle = setTimeout(() => resolve(undefined), limit);
    handle.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(handle);
  }
}

/**
 * The last assistant text produced after `firstSeq`.
 *
 * @param {any} session - the session.
 * @param {number} firstSeq - where the wake started.
 * @returns {string} the text, or ''.
 */
function lastAssistantText(session, firstSeq) {
  let text = '';
  const end = session.seq;
  for (let seq = firstSeq; seq < end; seq += 1) {
    const event = session.eventAt(seq);
    if (event === undefined) break;
    if (event.type !== 'assistant/message') continue;
    const joined = event.data.message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (joined !== '') text = joined;
  }
  return text;
}

/**
 * Names of the tools she called after `firstSeq`, in order.
 *
 * @param {any} session - the session.
 * @param {number} firstSeq - where the wake started.
 * @returns {string[]} tool names.
 */
function toolNames(session, firstSeq) {
  const names = [];
  const end = session.seq;
  for (let seq = firstSeq; seq < end; seq += 1) {
    const event = session.eventAt(seq);
    if (event === undefined) break;
    if (event.type === 'tool/call') names.push(String(event.data.name ?? ''));
  }
  return names.filter((entry) => entry !== '');
}

export { blankState, loadState, saveState };
