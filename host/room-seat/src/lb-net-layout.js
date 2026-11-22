// lb-net-layout.js: LAB ONLY. Shared word layout of the net delay experiment
// (lb-net-delay.js, lb-hub-worker.js runNet, lb-cabinet.js net option).
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later

// Control words (Int32, the cabinet's ctl SharedArrayBuffer) beyond [0] stop,
// [1] pacing period in microseconds and [2] catch-up limit in ms.
export const NET_CTL = Object.freeze({
  mode: 3, // 0 off (the normal hub), 1 strict barrier with delay, 2 relaxed (no cross-board barrier)
  gen: 4, // bumped by the page after it changes the delay words
  seed: 5, // jitter generator seed
  cover: 6, // relaxed hub only: cover a satellite slot after this many ticks with no new sized frame (0 off; lb-net-delay.js createSlotCover)
  up: 16, down: 32, jitter: 48, // microseconds, one word per ring node (16 nodes)
  absent: 64, // nonzero: that seat's board is stopped (rejoin test), one word per node
  uncover: 80, // relaxed hub only: bumped by the page to drop that node's cover (mp-room-return.js resultsDropCover), one word per node
  // relaxed hub only: the slot's generation, bumped by the page each time a
  // fresh board is put in the slot (lb-cabinet.js fillSlot, restartBoard);
  // the hub warms each new generation up outside the peer lockstep. One
  // word per node.
  slotGen: 96,
  words: 112,
});

// Net status words (Int32, netStatus SharedArrayBuffer): single words, then
// 16 per ring node for each per-node counter. lateResets counts the relaxed
// hub's tick clock resets; boardLateResets counts, per board, the resets of
// that board's own deadline clock (its debt passed the catch-up limit and
// was forgiven, lb-hub-worker.js runNet). Peer lockstep, per board:
// peerTimeouts (a wait for a local peer's frame passed its bound and the
// board went on with a HOLD), peerWaitMs (the time it waited for peers) and
// peerSkips (peer frames it passed over: only after a counted timeout or a
// clock reset). unpacedTimeouts: unpaced, a tick went on without a present
// board that was not at its barrier within the wait bound. Warm-up (a new
// slot generation, NET_CTL.slotGen), per board: warmState (1 while the
// board warms up outside the peer lockstep, else 0) and warmCapHits (warm-
// ups that hit the 30 s cap and entered without qualifying). skipsFrom:
// peerSkips split by source, word skipsFrom + 16 * target + source.
// relHist: per board, its paced release intervals by the hub's own clock,
// REL_HIST_BINS words per board (word relHist + REL_HIST_BINS * board +
// bin): bin k counts intervals up to the period plus REL_HIST_OVER_MS[k] ms,
// the last bin those over the period plus 10 ms. Intervals across a clock
// restart (a stop of pacing, an absent mark, a reboot) are not counted.
// warmClean and warmDirty (appended; no earlier word moved): per board,
// the vblanks of its warm-ups past its own vblank 1100 whose work the hub
// saw under 15 ms (clean) or not (dirty, those over 2 periods included),
// lb-hub-worker.js runNet. Then (appended): warmLookLateUs,
// warmLookLateMaxUs and warmLookLateN, per board, the look deadlines the hub
// took at or after their time (a first look past 2 periods counts both; their
// sum and largest lateness in us, and how many); warmOver2P, per board, the vblanks it saw over 2 periods.
// warmCapDeferred (appended): per board, its cap exits at speed and
// settled, held to the cap by the room's deferral (other cap exits are in
// warmCapHits; a capped release at speed, settled and not deferred is a
// natural exit, in neither).
export const REL_HIST_OVER_MS = Object.freeze([0, 1, 2, 5, 10]);
export const REL_HIST_BINS = REL_HIST_OVER_MS.length + 1;
export const NET_STATUS = Object.freeze({
  tick: 0, mode: 1, running: 2, waitingSeat: 3, ageAvgUs: 4, ageMaxUs: 5, slotSize: 6, lateResets: 7, gen: 8, unpacedTimeouts: 9,
  txFrames: 16, txBytes: 32, changedBytes: 48, deltaBytes: 64, deliveries: 80, rxBytes: 96, released: 112, absentSeen: 128,
  backlog: 144, covered: 160, sized: 176, boardLateResets: 192, peerTimeouts: 208, peerWaitMs: 224, peerSkips: 240,
  warmCapHits: 256, warmState: 272, skipsFrom: 288, relHist: 544, warmClean: 640, warmDirty: 656,
  warmLookLateUs: 672, warmLookLateMaxUs: 688, warmLookLateN: 704, warmOver2P: 720, warmCapDeferred: 736, words: 752,
});

export const NET_MODES = Object.freeze({ off: 0, strict: 1, relaxed: 2 });

// The lab page's net mode from its query: 'strict' or 'relaxed' only on a
// loopback lab server (tools/serve.mjs binds 127.0.0.1), the same gate as the
// player page's ?seats=8 (cabinet-game.js playerPageSeats); null anywhere
// else, so no other URL can turn the delay injector on.
const LAB_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
export function labNetMode(search, hostname) {
  const asked = new URLSearchParams(search || '').get('net');
  if (asked !== 'strict' && asked !== 'relaxed') return null;
  return LAB_HOSTS.has(String(hostname || '').toLowerCase()) ? asked : null;
}
