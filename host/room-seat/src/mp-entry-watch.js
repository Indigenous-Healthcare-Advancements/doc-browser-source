// mp-entry-watch.js: M3 R-1, which seats the game itself entered in a race.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Rev C, static decode (the project's link timing boundary
// EVIDENCE E3 to E5 and REPRO; a01-growth-rng slots CLAIM S1). The master
// board keeps each station's STATE as received over the ring in RX slot k
// (byte +43, the top byte of the aligned word at +40). When the master's own
// STATE goes to 2, every satellite builds its race (sat_race_setup), and the
// game gives the player's horse only to a station whose STATE is 6 or more.
// Latching the master's RX states on that frame therefore says which seats
// are in the race, from the room's own board, with nothing taken from the
// seat. To be confirmed in lab run 2 (the slot to ring node mapping too).
// Addresses only; nothing ROM-derived.

export const REVC_GAME = 'drbyocwc.zip';
export const DOC99_GAME = 'derbyoc.zip';
export const REVD_GAME = 'derbyocw.zip';
export const DOC2K_GAME = 'derbyo2k.zip';

// The game state words a board watches every frame (lb-board-worker.js),
// per game, under the names the pages read: 'phase' is the master PHASE
// (mp-room.js masterPhase), 'state' the STATE. Only changes are reported.
// Rev C (drbyocwc): tools/probe-page.mjs WATCH.
export const REVC_WATCH = Object.freeze([['scene', 0x0C21A0F0], ['state', 0x0C21A2A8], ['role', 0x0C21A134], ['race_on', 0x0C3C12B8],
  ['recv_state', 0x0C21A2AC], ['phase', 0x0C21A284], ['done_mask', 0x0C21A278], ['rec_104', 0x0C21A610],
  ['station', 0x0C21A144]]);
// DOC '99 (derbyoc): lab run 3 J99 (the lab watch configs' j_phase and
// j_state): PHASE is 1 at the lobby, 2 to 4 at entry, 5 to 7 in the race, 8
// at the results and 0 between, as Rev C's. Only these two are pinned; the
// other Rev C words have no J99 address yet and are not watched.
export const J99_PHASE_WORD = 0x0C211078;
export const J99_STATE_WORD = 0x0C21109C;
export const J99_WATCH = Object.freeze([['state', J99_STATE_WORD], ['phase', J99_PHASE_WORD]]);
// The watch for a game file name: DOC '99's own, else Rev C's (the other
// editions keep today's lab behaviour until their words are pinned).
// Rev D (derbyocw): the same words as Rev C, moved (the project's link timing boundary notes and
// ram_map.json): every game word sits 0x2DCC above Rev C's, the RX bases 0x3410 above. Rev C's own words read 0 on
// Rev D (EDITION_PORTS_REVD_CORE.md), so it must have its own table. Only PHASE and STATE (and the entry words below).
export const REVD_PHASE_WORD = 0x0C21D050;
export const REVD_STATE_WORD = 0x0C21D074;
export const REVD_WATCH = Object.freeze([['state', REVD_STATE_WORD], ['phase', REVD_PHASE_WORD]]);
// DOC 2000 (derbyo2k), found statically 2026-11-13 (Claude): in each game's program ROM (ic22) the PHASE and STATE
// words are the pair of literals 0x24 apart referenced ~30 and ~23 times; that rule picks Rev C's, Rev D's and
// DOC '99's known words first, and in DOC 2000 gives one pair. Its entry and slot_sel words (PHASE + 0x294 and
// PHASE - 0x14C, as on Rev C and Rev D) are referenced 6 and 7 times, as on Rev C and Rev D, and its RX bases are
// the one 0x0C3x literal pair 0x1EF0 apart referenced 6 times each, as Rev C's and Rev D's: World Edition's layout
// (it was built from DOC 2000). To be confirmed in a lab room (the PHASE values per screen).
export const J2K_PHASE_WORD = 0x0C228224;
export const J2K_STATE_WORD = 0x0C228248;
export const J2K_WATCH = Object.freeze([['state', J2K_STATE_WORD], ['phase', J2K_PHASE_WORD]]);
export function gameWatchFor(game) {
  const g = String(game || '').toLowerCase();
  return g === DOC99_GAME ? J99_WATCH : g === REVD_GAME ? REVD_WATCH : g === DOC2K_GAME ? J2K_WATCH : REVC_WATCH;
}
// The entry latch words per game: entry, slot_sel, and the RX base of the 816-byte (4 seats) and 576-byte (8 seats)
// paths. Not known for DOC '99 (another layout).
const ENTRY_WORDS = Object.freeze({
  [REVC_GAME]: Object.freeze({ entry: 0x0C21A518, slotSel: 0x0C21A138, rx4: 0x0C3B7FF8, rx8: 0x0C3B9EE8 }),
  [REVD_GAME]: Object.freeze({ entry: 0x0C21D2E4, slotSel: 0x0C21CF04, rx4: 0x0C3BB408, rx8: 0x0C3BD2F8 }),
  [DOC2K_GAME]: Object.freeze({ entry: 0x0C2284B8, slotSel: 0x0C2280D8, rx4: 0x0C3C4D30, rx8: 0x0C3C6C20 }),
});
export const hasEntryWatch = (game) => Object.hasOwn(ENTRY_WORDS, String(game || '').toLowerCase());
export const ENTERED_STATE = 6;
export const MASTER_BUILD_STATE = 2;

// The extra board0 watch words for a room of `seats` (4: the 816-byte RX
// path; 8: the 576-byte path, selector 0x0C21A138), Rev C's or Rev D's.
export function entryWatchFor(seats, game = REVC_GAME) {
  const w = ENTRY_WORDS[String(game || '').toLowerCase()] || ENTRY_WORDS[REVC_GAME];
  const [base, size] = seats === 8 ? [w.rx8, 576] : [w.rx4, 816];
  const out = [['entry', w.entry], ['slot_sel', w.slotSel]];
  for (let k = 1; k <= seats; k++) out.push([`rx${k}`, base + size * k + 40]);
  return out;
}

// LAB ONLY (the room debug page): which runners each station hosts, as the master holds them. A station's RX slot
// carries one 240-byte record per runner it hosts (from +96); the aligned word at +76 of a record holds the
// runner's controller (byte 0: 13 a CPU horse, below 13 a player's), its lane (byte 1, 0 to 11) and its finish
// state (byte 2). Static decode (the project's virtual station protocol notes, 3.1 and 3.2),
// to be confirmed in a lab room; that lane + 1 is the number on the horse is not established. Four seat rooms
// only (three records a station, the 816-byte path); Rev C, Rev D and DOC 2000 share the layout. Addresses only.
export const OWNER_RECORDS = 3;
// Eight seat rooms (2026-11-23): the 576-byte path, two records on stations 1 to 4 and one on stations 5 to 8 (the
// game's seat table; mp-race-telemetry.js SEAT_RECORDS).
export const OWNER_RECORDS_8 = Object.freeze([2, 2, 2, 2, 1, 1, 1, 1]);
export function ownerWatchFor(seats, game = REVC_GAME) {
  const w = ENTRY_WORDS[String(game || '').toLowerCase()];
  if (!w || (seats !== 4 && seats !== 8)) return [];
  const out = [];
  for (let k = 1; k <= seats; k++) for (let j = 0; j < (seats === 8 ? OWNER_RECORDS_8[k - 1] : OWNER_RECORDS); j++) out.push([`own${k}_${j}`, (seats === 8 ? w.rx8 + 576 * k : w.rx4 + 816 * k) + 96 + 240 * j + 76]);
  return out;
}
export const ownerOf = (word) => ({ controller: word & 0xff, lane: (word >>> 8) & 0xff, finish: (word >>> 16) & 0xff });

// The STATE byte inside an RX slot word (+43 of the slot is byte 3 of +40).
export const rxStateOf = (word) => (word >>> 24) & 0xff;

// The master latch: feed board0 watch changes; returns a new latch on the
// frame the master's STATE goes to MASTER_BUILD_STATE, else null.
export function createEntryLatch() {
  const rx = new Map();
  let masterState = null;
  let entryWord = null;
  let slotSel = null;
  let seq = 0;
  return {
    // frame: the board0 frame the change was sampled on; sizedAt: the hub's
    // per-node sized-frame counts the board read on that frame (both carried
    // on the latch).
    feed(name, value, frame = null, sizedAt = null) {
      if (/^rx\d$/.test(name)) { rx.set(Number(name.slice(2)), rxStateOf(value >>> 0)); return null; }
      if (name === 'entry') { entryWord = value >>> 0; return null; }
      if (name === 'slot_sel') { slotSel = value >>> 0; return null; }
      if (name !== 'state') return null;
      const st = value & 0xff;
      const rising = st === MASTER_BUILD_STATE && masterState !== MASTER_BUILD_STATE;
      masterState = st;
      if (!rising || !rx.size) return null;
      const slots = {};
      for (const [k, s] of rx) slots[k] = { entered: s >= ENTERED_STATE, state: s };
      seq++;
      return { seq, frame: Number.isInteger(frame) ? frame : null, sizedAt: Array.isArray(sizedAt) ? sizedAt : null, slots, mask: entryWord === null ? null : entryWord & 0xff, slotSel };
    },
  };
}

// A slot's RX state is its current occupant's only once that occupant's own
// board has sent enough sized frames since it took the slot: until then the
// hub's cover replays the previous occupant's last frame (lb-net-delay.js
// createSlotCover), so the master would still hold that occupant's STATE.
// The counts are the hub's (NET_STATUS.sized: frames the hub took from each
// board itself, never cover replays), read by board0's worker on the very
// frame it sampled the RX words for the latch (sizedAt), so no allowance for
// later frames is needed. base is the count when the slot's current
// occupant took it (read at the owner change; one read after the snapshot
// only makes the slot stale). RX_FRESH_FRAMES covers the ring and link delay
// from the hub to the master's RX copy (2 s at 60 Hz). Anything not known is
// stale: never entered.
export const RX_FRESH_FRAMES = 120;
export function freshSlots(slots, { sizedAt, baseOf }) {
  const out = {};
  for (const [k, v] of Object.entries(slots || {})) {
    const at = Array.isArray(sizedAt) ? sizedAt[Number(k)] : null;
    const base = baseOf(Number(k));
    const fresh = Number.isInteger(at) && Number.isInteger(base) && ((at - base) | 0) >= RX_FRESH_FRAMES;
    out[k] = fresh ? v : { ...v, entered: false, stale: true };
  }
  return out;
}

// A room slot's owner, watched: each change re-reads the slot's sized-frame
// base and calls onChange; each take by a remote seat steps gen (the room
// server settles a lease whose slot changed hands between two polls).
export function watchSlotOwner(o, { sizedOf, onChange = () => {} }) {
  let owner = o.owner;
  o.gen = 0;
  Object.defineProperty(o, 'owner', {
    enumerable: true,
    get: () => owner,
    set: (v) => { if (v !== owner) { owner = v; o.sizedBase = sizedOf(o.slot); if (v === 'remote') o.gen++; onChange(o); } },
  });
  return o;
}

// A latch taken while PHASE is still at the lobby releases the lobby (the
// page steps its race number) once this many master frames pass with PHASE
// still there, so a STATE 2 that is not a race build cannot hold the lobby
// closed. Counted in master frames, not wall time: about 120 s at the
// master's 30 rendered frames a second (60 s only at 60 Hz). Far longer
// than the STATE 2 to PHASE 2 gap of a real lobby end (to be measured in lab
// run 2); if it ever fires on a real race, that race's seats are not entered
// (the safe direction) and it is logged.
export const LOBBY_LATCH_FRAMES = 3600;
// Without a frame number (not expected), wall time: LOBBY_LATCH_MS.
export const LOBBY_LATCH_MS = 60000;
export function lobbyLatchExpired({ latchFrame, nowFrame, phase, latchMs = null, nowMs = null }) {
  if (phase !== 0 && phase !== 1) return false;
  if (Number.isInteger(latchFrame) && Number.isInteger(nowFrame)) return ((nowFrame - latchFrame) | 0) > LOBBY_LATCH_FRAMES;
  return Number.isFinite(latchMs) && Number.isFinite(nowMs) && nowMs - latchMs > LOBBY_LATCH_MS;
}

// Board watch changes ([frame, name, value, ...]) in frame order, a frame's
// PHASE change first (so a latch on the frame the master returns to the lobby
// takes the new race number).
export const orderChanges = (changes) => [...changes].sort((a, b) => (a[0] - b[0]) || ((b[1] === 'phase') - (a[1] === 'phase')));
