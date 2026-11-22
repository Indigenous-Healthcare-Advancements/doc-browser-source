// lb-ram-diff.js: LAB ONLY. An in-memory work RAM differ for the board
// worker (msg.labWatch.ramDiff). It answers "which RAM words changed between
// two moments of a run" (for example the lobby before and after a seat
// enters), so the entry words of another edition can be found from a lab run.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// What may leave the worker: addresses, word counts and SMALL values only.
// Snapshots stay in the worker's memory and are dropped once used. A value
// over 0xFFFF (and not a small negative) is never emitted: it is replaced by
// null, because work RAM can hold copies of program tables. No hash of RAM is
// ever computed. Ranges are limited to the work RAM window below.
//
// Costs: a snapshot reads each word through the shim in one frame (the whole
// window is about 671k reads), so it can stall that frame; each result
// carries snapMs. Lab words that change every frame grow the page's watch
// log, which lb-page does not cap: watch timers only for short runs.

export const WORK_RAM = [0x0C190000, 0x0C420000];
export const MAX_SNAPS = 6;
export const MAX_WORDS = (WORK_RAM[1] - WORK_RAM[0]) >>> 2;
export const MAX_OUT = 4000;

// A value that may be emitted: 0..0xFFFF, or -0xFFFF..-1 read as signed 32.
export const field = (v, shift, bits) => (bits ? (v >>> shift) & ((1 << bits) - 1) : v >>> 0);

export function small(v) {
  v >>>= 0;
  if (v <= 0xffff) return v;
  if (v > 0xffff0000) return v - 0x100000000;
  return null;
}

// The board worker's built-in watch names (lb-board-worker.js WATCH, net_err,
// wd_max); keep in step with it. Entry watch names come from mp-entry-watch.js.
export const BASE_WATCH_NAMES = ['scene', 'state', 'role', 'race_on', 'recv_state', 'phase', 'done_mask', 'rec_104', 'station', 'net_err', 'wd_max'];

// Validates a lab config; throws on anything outside the rules. names: the
// watched word names a { name, value } trigger may use (null: not checked).
export function checkRamDiff(cfg, names = null) {
  if (!cfg || typeof cfg !== 'object') throw new Error('ramDiff: config object required');
  const ranges = cfg.ranges || [WORK_RAM];
  if (!Array.isArray(ranges) || !ranges.length || ranges.length > 8) throw new Error('ramDiff: 1 to 8 ranges');
  let words = 0;
  for (const r of ranges) {
    if (!Array.isArray(r) || r.length !== 2 || !Number.isInteger(r[0]) || !Number.isInteger(r[1])) throw new Error('ramDiff: range is [lo, hi]');
    const [lo, hi] = r;
    if (lo % 4 || hi % 4 || lo >= hi || lo < WORK_RAM[0] || hi > WORK_RAM[1]) throw new Error('ramDiff: range must be word aligned inside work RAM');
    words += (hi - lo) >>> 2;
  }
  if (words > MAX_WORDS) throw new Error('ramDiff: ranges too large');
  const triggers = cfg.triggers || [];
  if (!Array.isArray(triggers) || !triggers.length || triggers.length > MAX_SNAPS) throw new Error(`ramDiff: 1 to ${MAX_SNAPS} triggers`);
  const labels = new Set();
  for (const t of triggers) {
    if (!t || typeof t.label !== 'string' || !/^[a-z0-9_-]{1,32}$/i.test(t.label) || labels.has(t.label)) throw new Error('ramDiff: each trigger needs a unique label');
    labels.add(t.label);
    const byFrame = Number.isInteger(t.frame) && t.frame > 0;
    const byWord = typeof t.name === 'string' && Number.isInteger(t.value);
    if (byFrame === byWord) throw new Error('ramDiff: a trigger is { frame } or { name, value }');
    if (byWord && names && !names.includes(t.name)) throw new Error(`ramDiff: trigger ${t.label} names a word that is not watched (${t.name})`);
    if (t.after !== undefined && !(Number.isInteger(t.after) && t.after >= 0)) throw new Error('ramDiff: after is a frame count');
  }
  const pairs = cfg.pairs || [];
  if (!Array.isArray(pairs) || !pairs.length) throw new Error('ramDiff: pairs required');
  for (const p of pairs) if (!Array.isArray(p) || p.length !== 2 || !labels.has(p[0]) || !labels.has(p[1]) || p[0] === p[1]) throw new Error('ramDiff: a pair names two trigger labels');
  const maxOut = cfg.maxOut === undefined ? MAX_OUT : cfg.maxOut;
  if (!Number.isInteger(maxOut) || maxOut < 1 || maxOut > MAX_OUT) throw new Error('ramDiff: maxOut out of range');
  return { ranges: ranges.map((r) => [r[0], r[1]]), triggers: triggers.map((t) => ({ ...t })), pairs: pairs.map((p) => [p[0], p[1]]), maxOut };
}

// readWord(addr) -> the 32-bit RAM word at addr (an SH4 address).
export function createRamDiffer(cfg, readWord, names = null) {
  const c = checkRamDiff(cfg, names);
  const snaps = new Map();
  const fired = new Set();
  const pending = []; // [label, dueFrame]
  const words = c.ranges.reduce((s, [lo, hi]) => s + ((hi - lo) >>> 2), 0);

  function snap(label, frame) {
    const out = new Uint32Array(words);
    let i = 0;
    for (const [lo, hi] of c.ranges) for (let a = lo; a < hi; a += 4) out[i++] = readWord(a) >>> 0;
    snaps.set(label, { frame, data: out });
  }
  let lastSnapMs = 0;

  function diff(a, b) {
    const A = snaps.get(a);
    const B = snaps.get(b);
    const changes = [];
    let changed = 0;
    let large = 0;
    let i = 0;
    for (const [lo, hi] of c.ranges) {
      for (let addr = lo; addr < hi; addr += 4, i++) {
        const x = A.data[i];
        const y = B.data[i];
        if (x === y) continue;
        changed++;
        const sx = small(x);
        const sy = small(y);
        if (sx === null && sy === null) large++;
        if (changes.length < c.maxOut) changes.push([addr, sx, sy]);
      }
    }
    return { a, b, aFrame: A.frame, bFrame: B.frame, words, changed, bothLarge: large, truncated: changed > changes.length, changes };
  }

  // Drop snapshots no later pair needs.
  function prune(done) {
    for (const label of snaps.keys()) {
      const needed = c.pairs.some((p, k) => !done.has(k) && p.includes(label));
      if (!needed) snaps.delete(label);
    }
  }
  const donePairs = new Set();

  function fire(label, frame) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    snap(label, frame);
    lastSnapMs = typeof performance !== 'undefined' ? Math.round(performance.now() - t0) : 0;
    const results = [];
    c.pairs.forEach((p, k) => {
      if (!donePairs.has(k) && snaps.has(p[0]) && snaps.has(p[1])) { results.push({ ...diff(p[0], p[1]), snapMs: lastSnapMs }); donePairs.add(k); }
    });
    prune(donePairs);
    return results;
  }

  return {
    words,
    // A watched word changed: arm any { name, value } trigger it matches.
    onChange(name, value, frame) {
      for (const t of c.triggers) {
        if (fired.has(t.label) || t.name !== name || (t.value >>> 0) !== (value >>> 0)) continue;
        fired.add(t.label);
        pending.push([t.label, frame + (t.after || 0)]);
      }
    },
    // After each frame: take any snapshot that is due. Returns diff results.
    onFrame(frame) {
      for (const t of c.triggers) {
        if (!fired.has(t.label) && t.frame === frame) { fired.add(t.label); pending.push([t.label, frame + (t.after || 0)]); }
      }
      const results = [];
      for (let k = pending.length - 1; k >= 0; k--) {
        if (pending[k][1] <= frame) { const [label] = pending.splice(k, 1)[0]; results.push(...fire(label, frame)); }
      }
      return results;
    },
    snapshots: () => [...snaps.keys()],
    done: () => donePairs.size === c.pairs.length,
  };
}

// Extra lab watch words (msg.labWatch.words): [name, addr] or
// [name, addr, shift, bits] (a field of the word: (word >>> shift) & mask of
// bits, 1 to 16 bits), inside work RAM, names not clashing with the built-in
// watch list. Returns [name, addr, shift, bits] (bits 0: the whole word).
// One word per address: two fields of one word (or a field and the whole
// word) together could rebuild a value over 0xFFFF, so a second is refused.
export function checkLabWords(words, taken = BASE_WATCH_NAMES) {
  if (!Array.isArray(words) || words.length > 16) throw new Error('labWatch: up to 16 words');
  const names = new Set(taken);
  const addrs = new Set();
  return words.map((w) => {
    if (!Array.isArray(w) || (w.length !== 2 && w.length !== 4) || typeof w[0] !== 'string' || !/^[a-z0-9_]{1,24}$/.test(w[0]) || names.has(w[0])) throw new Error('labWatch: word is [unique name, addr]');
    const a = w[1];
    if (!Number.isInteger(a) || a % 4 || a < WORK_RAM[0] || a >= WORK_RAM[1]) throw new Error('labWatch: word address must be word aligned inside work RAM');
    let shift = 0;
    let bits = 0;
    if (w.length === 4) {
      [, , shift, bits] = w;
      if (!Number.isInteger(shift) || !Number.isInteger(bits) || bits < 1 || bits > 16 || shift < 0 || shift + bits > 32) throw new Error('labWatch: field is shift and 1 to 16 bits inside the word');
    }
    if (addrs.has(a)) throw new Error('labWatch: one word per address');
    addrs.add(a);
    names.add(w[0]);
    return [w[0], a, shift, bits];
  });
}

// The whole lab config (msg.labWatch per board label), checked on the main
// thread before any worker starts. labels: the board labels; namesOf(label):
// that board's built-in watch names. Throws on any problem.
export function checkLabWatch(labWatch, labels, namesOf = () => BASE_WATCH_NAMES) {
  if (!labWatch || typeof labWatch !== 'object' || Array.isArray(labWatch)) throw new Error('labWatch: an object keyed by board label');
  for (const [label, v] of Object.entries(labWatch)) {
    if (!labels.includes(label)) throw new Error(`labWatch: ${label} is not a board`);
    if (!v || typeof v !== 'object') throw new Error(`labWatch: ${label} needs { words, ramDiff }`);
    const base = namesOf(label);
    const words = v.words ? checkLabWords(v.words, base) : [];
    if (v.ramDiff) checkRamDiff(v.ramDiff, [...base, ...words.map((w) => w[0])]);
  }
  return labWatch;
}
