// care-recorder.js: what a player chose in the care scenes (feeding, training,
// and the reply to the horse after a race), read from the seat's own board.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The seat's board worker (lb-board-worker.js, msg.careWatch) reads the words
// of CARE_WORDS once a frame and feeds them to createCareRecorder().frame(),
// which turns state changes into care events. The page keeps the events
// (createCareLog, bounded), shows them nowhere, and exposes them as
// window.seat.care(). Nothing is sent anywhere: createCareOutbox is the seam
// where they would be posted to the lobby with the lease, and it is OFF
// (docs/care-events.md under host/ has the proposed shape). No network code.
//
// STATUS OF EVERY ADDRESS AND EVERY DECODE RULE HERE: from the engine notes,
// not yet confirmed in a browser seat. Sources, by the tags used below (the project's own research notes, not
// published):
//   [note]   the care scene recording map (2026-11-22)
//   [e06]    the chooser decode (C1 to C10)
//   [c13]    the natural care paths (N1 to N6)
//   [care]   the care decode and its checks
//   [e05]    the heart writer inventory
//   [e07]    the post race decode, the reply presentation and the reply outcome
//   [w1]     the food gap review (2026-09-30)
//   [revc]   the confirmed Rev C notes
//   [rider]  a lab rider (diagnostic, never evidence)
// All of it is static decode of the stock Rev C program (or the rider); none
// has been read in a live browser session. docs/care-events.md has, for each
// word, the lab step that would confirm it. Rev C only (and Rev C Rebalanced,
// which changes code words, not the RAM layout: assumed, also unconfirmed);
// the other editions keep these words elsewhere and get no recorder.
//
// ROBUST TO BEING WRONG: a value outside its documented range never becomes a
// claim. The field is null and an 'unknown' event says which value it was;
// nothing here throws (a fault is counted and that frame gives no events).
// Addresses and small numbers only; nothing ROM-derived, and nothing that
// identifies anything beyond the horse's own card.

import { REVC_GAME } from './mp-entry-watch.js';

// [name, address]: aligned 32-bit words of the satellite board's RAM (the
// board reads only aligned words; a byte field is a byte OF its word, low
// byte first). Each line: what it is, its source, and "unconfirmed" for all.
export const CARE_WORDS = Object.freeze([
  // The game's STATE; 7 = the care screens. [note]; the 7 only from a secondary source (p0-full-decode
  // E01_NEW_GAME_BREEDING_ENTRY_RET3 "scene 17 sets care state := 7") and [rider]. Unconfirmed.
  ['state', 0x0C21A2A8],
  // The scene number (the result step writes 22: [e07] R5). Recorded with the reply, never used as a gate. Unconfirmed.
  ['scene', 0x0C21A0F0],
  // The care index; the care dispatcher runs slot (index mod 17). [c13] N1 (that it "carries the care index" is INFERRED there). Unconfirmed.
  ['care_index', 0x0C21A0F4],
  // The horse record (REC 0x0C21A5A8, [e07]): externals REC+98..+103 are bytes 2,3 of this word and 0..3 of the next
  // ([care] X1 to X3: committed gains, each 0..63; their order Start, Corner, Out of the box, Competing, Tenacious,
  // Spurt is [note] only). Unconfirmed.
  ['rec_ext_a', 0x0C21A608],
  ['rec_ext_b', 0x0C21A60C],
  // REC+104 hearts (byte 0: points 0..63, one heart drawn per 4, [e05], [revc]:467), REC+106 races run (byte 2,
  // [w1]:224 PROBABLE), REC+107 wins (byte 3, [revc]:532). Unconfirmed.
  ['rec_104', 0x0C21A610],
  // The race number (mod 6 gives the race class) and the career race count. [e07] R3. Unconfirmed.
  ['race_no', 0x0C21A294],
  ['career', 0x0C21A4CC],
  // TRAINING. The chosen mode (0 Turf, 1 Slope, 2 Dirt, 3 Wood, 4 Pool, 5 Rest; 6 = the horse refused) and its copy,
  // which keeps the chosen mode on a refusal. [e06] C5; names [w1]:219 PROBABLE-STRONG. Unconfirmed.
  ['train_mode', 0x0C3DC168],
  ['train_mode_copy', 0x0C3DC16C],
  // 0 = single, 1 = cooperate (with a partner). [e06] C5, [care] P4. Unconfirmed.
  ['partner', 0x0C3DC174],
  // A counter of training commits. [e06] C9. Recorded for cross-checking only. Unconfirmed.
  ['train_commits', 0x0C187320],
  // Run flags: byte 0 = 2 while the run is on, byte 1 = 2 once finished. [rider] ONLY (diagnostic). Unconfirmed.
  ['run_flags', 0x0C3DC358],
  // The training run's whip presses and holds. [revc]:511, 708 (September review). Unconfirmed.
  ['whips', 0x0C3DC498],
  ['holds', 0x0C3DC49C],
  // Cooperate: the gap bucket to the partner. [note] ONLY. Unconfirmed.
  ['coop_bucket', 0x0C3DC4A4],
  // The grade the game gave, 1 (best) to 10: the track modes' and the pool's. [w1]:222, [care] VERIFY_I4 T4; the
  // lab once saw 2 shown as "COOL!!" and 3 as "GOOD!" ([note]). Unconfirmed.
  ['grade_track', 0x0C3DC4A8],
  ['grade_pool', 0x0C3DC4AC],
  // The timing game: the target time in seconds (a float, starts 13.0, kept 6 to 99), the difference actual minus
  // target in centiseconds (a float), the run's frames. [note] ONLY (target, difference), [rider] (frames). Unconfirmed.
  ['target_s', 0x0C3DBD04],
  ['diff_cs', 0x0C3DE1B4],
  ['run_frames', 0x0C3DE1CC],
  // FEEDING. The four foods offered (ids 0..44, written only by care slot 10), the slot chosen (an index into
  // them), and the taste result (0..5; 3 or more: the horse refused it, no gain). [c13] N3, N4; [w1]:217. Unconfirmed.
  ['food0', 0x0C3DC1CC],
  ['food1', 0x0C3DC1D0],
  ['food2', 0x0C3DC1D4],
  ['food3', 0x0C3DC1D8],
  ['food_slot', 0x0C3DC164],
  ['taste', 0x0C187E60],
  // THE REPLY AFTER A RACE (the player answers the horse; work area 0x0C21D6B8, [e07]): its timer (809 frames at the
  // start, set to 431 when a reply is confirmed, to 1109 at the final step), the reply cursor (0..3; REWRITTEN after
  // the confirm, [e07-reply-outcome] C3), the stage, and the hearts as they were before the reply. Unconfirmed.
  ['reply_timer', 0x0C21D6BC],
  ['reply_cursor', 0x0C21D6C8],
  ['reply_stage', 0x0C21D6CC],
  ['reply_hearts', 0x0C21D6F8],
]);
const IX = Object.freeze(Object.fromEntries(CARE_WORDS.map(([name], i) => [name, i])));

/** The words a board reads for a game: Rev C's file only (Rev C and Rev C Rebalanced run it); [] for every other. */
export function careWordsFor(game) {
  return String(game || '').toLowerCase() === REVC_GAME ? CARE_WORDS : [];
}

export const CARE_STATE = 7;          // [note], secondary source
export const CARE_SLOTS = 17;         // [c13] N1
// Care slots with a known job ([e06] C1: 5; [c13]: 9 and 13 as fact, 10 INFERRED). Every other slot is unnamed.
export const SLOT_TRAIN_MENU = 5;
export const SLOT_TRAIN_RUN = 9;
export const SLOT_FOOD_LIST = 10;
export const SLOT_FEEDING = 13;
// The rider calls 11 the "feeding loop" ([rider]); it only widens where the feeding words are looked at.
const FEED_SLOTS = [SLOT_FOOD_LIST, 11, SLOT_FEEDING];
const SLOT_NAMES = Object.freeze({ [SLOT_TRAIN_MENU]: 'training_menu', [SLOT_TRAIN_RUN]: 'training_run', [SLOT_FOOD_LIST]: 'food_list', [SLOT_FEEDING]: 'feeding' });
export const TRAIN_MODES = Object.freeze(['turf', 'slope', 'dirt', 'wood', 'pool', 'rest']);
export const TRAIN_REFUSED = 6;
// Food names known so far ([note], [w1]:226 to 241); every other id is reported by number only.
export const FOOD_NAMES = Object.freeze({ 0: 'Carrot', 1: 'Bunch of Carrots', 2: 'Large Carrot', 3: 'Fodder', 4: 'Fodder with Green Tea', 5: 'Fodder with Garlic', 13: 'Large Cabbage' });
export const FOOD_MAX = 44;
// Hearts points the game adds for a taste result 0..5 ([revc]:495 to 497, table 0x0C146ACC). What the game should do,
// reported beside what the hearts actually did.
export const TASTE_HEARTS = Object.freeze([4, 3, 2, -2, -4, -8]);
export const GRADE_NAMES = Object.freeze({ 2: 'COOL!!', 3: 'GOOD!' }); // the only two seen ([note])
export const EXTERNALS = Object.freeze(['start', 'corner', 'out_of_box', 'competing', 'tenacious', 'spurt']); // order: [note] only
export const REPLY_TIMER = Object.freeze({ start: 809, confirm: 431, final: 1109 }); // [revc]:539, [e07]
// A reply that never reaches its end is given up after this many frames (about two minutes).
const REPLY_GIVE_UP = 7200;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const asFloat = (w) => { u32[0] = w >>> 0; return f32[0]; };
const byte = (w, n) => (w >>> (8 * n)) & 0xff;
const within = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const round = (v, d) => Math.round(v * d) / d;
// A raw value as an event may carry it: small numbers only (a wrong address could hold anything).
const raw = (v) => (Number.isInteger(v) && v >= 0 && v <= 0xffff ? v : null);

/**
 * The recorder. frame(n, words) takes the frame number and the words of CARE_WORDS in order (numbers, unsigned) and
 * returns the events that frame caused (usually none). Events carry: type, f (the frame), care (the number of the
 * care visit since this board started, or null), race ({ game, career, card }: the game's race number, the career
 * race count and the card's races run, each null when out of range), and their own fields. Types:
 *   care_enter { before }             the care screens opened; before = { externals, hearts }
 *   care_scene { slot, name }         the care slot changed (name: one of SLOT_NAMES, or null)
 *   training_chosen { mode, refused, partner, commits }
 *   training_result { mode, partner, whips, holds, grade, grade_kind, grade_name, grade_fresh, target_s, diff_cs,
 *                     actual_s, run_frames, coop_bucket, finished }     (at the end of the care visit)
 *   food_offered { foods: [{ slot, id, name }] }
 *   food_chosen { slot, id, name, taste, refused, hearts_expected, taste_fresh }   (at the end of the care visit)
 *   care_leave { after, delta, trained, fed }
 *   interaction { reply_slot, stage, scene, hearts_before, hearts_after, hearts_delta, final_seen }
 *   unknown { what, raw }             a value outside its documented range (the field it belonged to is null)
 * stats(): counters for the lab (frames, faults, visits, and signs that the care gate is wrong).
 */
export function createCareRecorder() {
  let prev = null;
  let visits = 0;
  let care = null;   // the open care visit
  let reply = null;  // the open reply
  let seq = 0;
  const st = { frames: 0, faults: 0, visits: 0, events: 0, unknowns: 0, replies: 0, commitsOutsideCare: 0, whipsOutsideCare: 0 };

  function step(n, w) {
    const out = [];
    const g = (name) => w[IX[name]] >>> 0;
    const p = (name) => prev[IX[name]] >>> 0;
    const raceKey = () => ({ game: within(g('race_no'), 0, 9999) ? g('race_no') : null, career: within(g('career'), 0, 999) ? g('career') : null, card: byte(g('rec_104'), 2) });
    const emit = (type, fields) => { out.push({ seq: ++seq, type, f: n, care: care ? care.n : null, race: raceKey(), ...fields }); };
    const unknown = (what, value) => { st.unknowns++; emit('unknown', { what, raw: raw(value) }); };
    const snap = () => {
      const a = g('rec_ext_a'); const b = g('rec_ext_b');
      const ext = [byte(a, 2), byte(a, 3), byte(b, 0), byte(b, 1), byte(b, 2), byte(b, 3)];
      const hearts = byte(g('rec_104'), 0);
      const ok = ext.every((x) => x <= 63);
      if (!ok) unknown('externals', null);
      if (hearts > 63) unknown('hearts', hearts);
      return { externals: ok ? Object.fromEntries(EXTERNALS.map((k, i) => [k, ext[i]])) : null, hearts: hearts <= 63 ? hearts : null };
    };
    const modeName = (m) => (within(m, 0, 5) ? TRAIN_MODES[m] : null);
    const partnerName = (v) => (v === 0 ? 'single' : v === 1 ? 'cooperate' : null);

    if (prev === null) { prev = Array.from(w, (x) => x >>> 0); return out; }

    // ---- The care screens ----
    const inCare = g('state') === CARE_STATE;
    if (inCare && !care) {
      visits++; st.visits = visits;
      care = { n: visits, slot: null, before: null, chosen: null, run: null, offered: null, feed: null, tasteAtEntry: g('taste') };
      care.before = snap();
      emit('care_enter', { before: care.before });
    }
    if (!inCare && !care) {
      // Signs that the gate (STATE 7) is wrong: the care words moving while "not in care". Counted, never an event.
      if (g('train_commits') !== p('train_commits')) st.commitsOutsideCare++;
      if (g('whips') > p('whips') && g('whips') - p('whips') <= 4) st.whipsOutsideCare++;
    }
    if (inCare && care) {
      const slot = g('care_index') % CARE_SLOTS;
      if (slot !== care.slot) {
        const left = care.slot;
        care.slot = slot;
        // Leaving the training menu: the choice is committed there, then the index moves on ([e06] C1, C5, C10).
        if (left === SLOT_TRAIN_MENU) {
          const copy = g('train_mode_copy'); const mode = g('train_mode');
          const chosen = within(copy, 0, 5) ? copy : null;
          if (chosen === null) unknown('training_mode', copy);
          const partner = partnerName(g('partner'));
          if (partner === null) unknown('training_partner', g('partner'));
          if (mode !== copy && mode !== TRAIN_REFUSED) unknown('training_mode_word', mode);
          care.chosen = { mode: chosen, partner };
          emit('training_chosen', { mode: modeName(chosen), refused: chosen === null ? null : mode === TRAIN_REFUSED, partner, commits: raw(g('train_commits')) });
        }
        // Leaving the food list builder: the four foods are final (slot 10 is their only writer, [w1]:217).
        if (left === SLOT_FOOD_LIST && !care.offered) offer();
        emit('care_scene', { slot, name: SLOT_NAMES[slot] || null });
        if ((slot === 11 || slot === SLOT_FEEDING) && !care.offered) offer();
        if (slot === SLOT_TRAIN_RUN && !care.run) {
          const t = asFloat(g('target_s'));
          care.run = { mode: care.chosen ? care.chosen.mode : (within(g('train_mode_copy'), 0, 5) ? g('train_mode_copy') : null), partner: care.chosen ? care.chosen.partner : partnerName(g('partner')),
            target: Number.isFinite(t) && t >= 6 && t <= 99 ? t : null, targetRaw: g('target_s'), whips: null, holds: null, grade: null, gradeFresh: false,
            gradeAtStart: [g('grade_track'), g('grade_pool')], diff: null, frames: null, bucket: null, finished: false };
        }
      }
      if (care.run) {
        const r = care.run;
        // The counters as last seen in the run's own slot; the result words as last seen until the visit ends.
        if (slot === SLOT_TRAIN_RUN) { r.whips = g('whips'); r.holds = g('holds'); r.frames = g('run_frames'); }
        if (byte(g('run_flags'), 1) === 2) r.finished = true;
        const pool = r.mode === 4;
        const gw = g(pool ? 'grade_pool' : 'grade_track');
        if (gw !== r.gradeAtStart[pool ? 1 : 0]) r.gradeFresh = true;
        r.gradeWord = gw;
        const d = asFloat(g('diff_cs'));
        r.diff = Number.isFinite(d) && Math.abs(d) <= 10000 ? d : null;
        r.bucket = g('coop_bucket');
      }
      if (FEED_SLOTS.includes(slot)) care.feed = { slot: g('food_slot') };
    }
    if (!inCare && care) {
      // The visit is over: what the training gave, what was fed, and the record before and after. The result words
      // are the last ones seen while the care screens were up (this frame's may already be another screen's).
      if (care.run) {
        const r = care.run;
        if (r.mode === null) unknown('training_mode', null);
        const grade = within(r.gradeWord, 1, 10) ? r.gradeWord : null;
        if (grade === null) unknown('training_grade', r.gradeWord);
        const whips = within(r.whips, 0, 9999) ? r.whips : null;
        const holds = within(r.holds, 0, 9999) ? r.holds : null;
        if (whips === null) unknown('training_whips', r.whips);
        if (holds === null) unknown('training_holds', r.holds);
        if (r.target === null) unknown('training_target', null);
        if (r.diff === null) unknown('training_time', null);
        const coop = r.partner === 'cooperate';
        emit('training_result', {
          mode: modeName(r.mode), partner: r.partner, whips, holds, grade, grade_kind: r.mode === null ? null : r.mode === 4 ? 'pool' : 'track',
          grade_name: grade !== null && GRADE_NAMES[grade] ? GRADE_NAMES[grade] : null, grade_fresh: r.gradeFresh,
          target_s: r.target === null ? null : round(r.target, 100), diff_cs: r.diff === null ? null : round(r.diff, 10),
          actual_s: r.target === null || r.diff === null ? null : round(r.target + r.diff / 100, 100),
          run_frames: within(r.frames, 0, 36000) ? r.frames : null, coop_bucket: coop && within(r.bucket, 0, 99) ? r.bucket : null, finished: r.finished,
        });
      }
      if (care.feed && care.offered) {
        const slotV = within(care.feed.slot, 0, 3) ? care.feed.slot : null;
        if (slotV === null) unknown('food_slot', care.feed.slot);
        const food = slotV === null ? null : care.offered[slotV];
        const tw = p('taste');
        const taste = within(tw, 0, 5) ? tw : null;
        if (taste === null) unknown('food_taste', tw);
        emit('food_chosen', { slot: slotV, id: food ? food.id : null, name: food ? food.name : null, taste, refused: taste === null ? null : taste >= 3,
          hearts_expected: taste === null ? null : TASTE_HEARTS[taste], taste_fresh: tw !== care.tasteAtEntry });
      }
      const after = snap();
      const b = care.before;
      const delta = { externals: b.externals && after.externals ? Object.fromEntries(EXTERNALS.map((k) => [k, after.externals[k] - b.externals[k]])) : null,
        hearts: b.hearts !== null && after.hearts !== null ? after.hearts - b.hearts : null };
      emit('care_leave', { after, delta, trained: !!care.run, fed: !!(care.feed && care.offered) });
      care = null;
    }

    // ---- The reply after a race (not a care screen) ----
    const t = g('reply_timer'); const pt = p('reply_timer');
    // A jump to a value (never the countdown passing through it: the frame before would be one above).
    const jumpedTo = (v) => t === v && pt !== v && pt !== v + 1;
    if (jumpedTo(REPLY_TIMER.start)) { reply = { from: n, confirmed: false, finalSeen: false, slot: null, stage: null, before: null, scene: g('scene') }; st.replies++; }
    else if (reply) {
      if (!reply.confirmed && jumpedTo(REPLY_TIMER.confirm)) {
        // The cursor as it was the frame BEFORE the confirm: the confirm rewrites it ([e07-reply-outcome] C3, C7).
        reply.confirmed = true;
        reply.slot = p('reply_cursor');
        reply.stage = g('reply_stage');
        reply.before = g('reply_hearts');
        reply.scene = g('scene');
      } else if (reply.confirmed && !reply.finalSeen && jumpedTo(REPLY_TIMER.final)) {
        reply.finalSeen = true;
      } else if (reply.confirmed && (g('scene') !== reply.scene || n - reply.from > REPLY_GIVE_UP)) {
        // The scene moved on: the hearts are final now.
        const slotV = within(reply.slot, 0, 3) ? reply.slot : null;
        if (slotV === null) unknown('reply_slot', reply.slot);
        const before = within(reply.before, 0, 63) ? reply.before : null;
        if (before === null) unknown('reply_hearts_before', reply.before);
        const hearts = byte(g('rec_104'), 0);
        const afterV = hearts <= 63 ? hearts : null;
        if (afterV === null) unknown('hearts', hearts);
        emit('interaction', { reply_slot: slotV, stage: within(reply.stage, 0, 255) ? reply.stage : null, scene: raw(reply.scene), hearts_before: before, hearts_after: afterV,
          hearts_delta: before !== null && afterV !== null ? afterV - before : null, final_seen: reply.finalSeen });
        reply = null;
      } else if (!reply.confirmed && (g('scene') !== reply.scene || n - reply.from > REPLY_GIVE_UP)) {
        // The reply screen went without a confirm being seen (a timeout, or these words are not what the notes say).
        unknown('reply_unconfirmed', null);
        reply = null;
      }
    }

    function offer() {
      const foods = [];
      for (let i = 0; i < 4; i++) {
        const id = g(`food${i}`);
        const ok = within(id, 0, FOOD_MAX);
        if (!ok) unknown('food_id', id);
        foods.push({ slot: i, id: ok ? id : null, name: ok && FOOD_NAMES[id] ? FOOD_NAMES[id] : null });
      }
      care.offered = foods;
      emit('food_offered', { foods });
    }

    for (let i = 0; i < prev.length; i++) prev[i] = w[i] >>> 0;
    return out;
  }

  return {
    frame(n, words) {
      st.frames++;
      if (!words || words.length !== CARE_WORDS.length) { st.faults++; return []; }
      try {
        const ev = step(n, words);
        st.events += ev.length;
        return ev;
      } catch {
        // Never a crash and never a half-told visit: the fault is counted and the recorder starts afresh.
        st.faults++; prev = null; care = null; reply = null;
        return [];
      }
    },
    stats: () => ({ ...st }),
  };
}

export const CARE_LOG_MAX = 400;
export const CARE_STATUS = 'unconfirmed: from the engine notes, not yet confirmed in a browser seat';

/**
 * The page's keep of care events: bounded (the oldest go first, counted), shown nowhere. view() is what
 * window.seat.care() returns.
 */
export function createCareLog({ max = CARE_LOG_MAX } = {}) {
  const events = [];
  let dropped = 0;
  let stats = null;
  return {
    add(list, boardStats = null) {
      if (boardStats && typeof boardStats === 'object') stats = boardStats;
      if (!Array.isArray(list)) return;
      for (const e of list) { if (e && typeof e === 'object' && typeof e.type === 'string') events.push(e); }
      while (events.length > max) { events.shift(); dropped++; }
    },
    view: () => ({ v: 1, status: CARE_STATUS, events: events.slice(), dropped, stats }),
    size: () => events.length,
  };
}

/**
 * THE SENDER SEAM, OFF BY DEFAULT. Where care events would go to the lobby with the lease, once the lobby has a
 * route for them (none exists: docs/care-events.md under host/ proposes the shape for the lobby developer). With
 * enabled false, or no send function, offer() does nothing at all. With both, it hands send() one batch
 * ({ v: 1, events }) of at most `batch` events at a time, oldest first, and keeps what a failed send did not take.
 * This module has no network code: send is the caller's.
 */
export function createCareOutbox({ enabled = false, send = null, batch = 20, max = CARE_LOG_MAX } = {}) {
  const on = enabled === true && typeof send === 'function';
  const queue = [];
  let busy = false;
  let sent = 0;
  let failed = 0;
  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const part = queue.slice(0, batch);
        let ok = false;
        try { ok = (await send({ v: 1, events: part })) === true; } catch { ok = false; }
        if (!ok) { failed++; break; }
        queue.splice(0, part.length);
        sent += part.length;
      }
    } finally { busy = false; }
  }
  return {
    on,
    offer(list) {
      if (!on || !Array.isArray(list) || !list.length) return;
      queue.push(...list);
      while (queue.length > max) queue.shift();
      pump();
    },
    retry() { if (on && queue.length) pump(); },
    state: () => ({ on, waiting: queue.length, sent, failed }),
  };
}
