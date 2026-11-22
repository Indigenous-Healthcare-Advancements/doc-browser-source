// mp-shadow-log.js: LAB ONLY (multiplayer room M2, doc-ops
// MULTIPLAYER_SERVER.md 6.4). The first piece of the live shadow seat: the
// seat's input and applied-frame log on the wire, and the room's frame
// store that bounds every claim in the log by times the room saw itself.
// The shadow board that replays the log is designed in host/README.md
// (M2 section); this module gives it what it consumes.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// One log entry per seat vblank, written by the seat's link worker while the
// board waits at its vblank barrier (mp-seat-link-worker.js):
//   vblank   the board's guest vblank count k (the barrier word)
//   upSeq    the wire sequence of the slot frame sent up at this tick (0: none)
//   downSeq  the wire sequence of the room frame delivered at this tick, so
//            applied from vblank k + 1 on (0: none, the board keeps the last)
//   input    the port 0 joypad mask the board applied for its latest frame
// 16 bytes an entry, little-endian u32s, after a u16 count. Entries go on the
// reliable control channel (the shadow needs every one); at most
// LOG_MAX_ENTRIES a message so a message stays under about 1,150 bytes.

export const LOG_ENTRY_BYTES = 16;
export const LOG_MAX_ENTRIES = 64;

export function encodeLog(entries) {
  const n = Math.min(entries.length, LOG_MAX_ENTRIES);
  const out = new Uint8Array(2 + n * LOG_ENTRY_BYTES);
  const v = new DataView(out.buffer);
  v.setUint16(0, n, true);
  for (let i = 0; i < n; i++) {
    const e = entries[i];
    const o = 2 + i * LOG_ENTRY_BYTES;
    v.setUint32(o, e.vblank >>> 0, true);
    v.setUint32(o + 4, e.upSeq >>> 0, true);
    v.setUint32(o + 8, e.downSeq >>> 0, true);
    v.setUint32(o + 12, e.input >>> 0, true);
  }
  return out;
}

export function decodeLog(body) {
  if (!body || body.length < 2) return null;
  const v = new DataView(body.buffer, body.byteOffset, body.length);
  const n = v.getUint16(0, true);
  if (n > LOG_MAX_ENTRIES || body.length !== 2 + n * LOG_ENTRY_BYTES) return null;
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = 2 + i * LOG_ENTRY_BYTES;
    out.push({ vblank: v.getUint32(o, true), upSeq: v.getUint32(o + 4, true), downSeq: v.getUint32(o + 8, true), input: v.getUint32(o + 12, true) });
  }
  return out;
}

// Seat side: collects entries and hands out a message body every flushEvery
// entries (default 6, about 100 ms at 60 Hz) or when full.
export function createSeatLogger({ flushEvery = 6 } = {}) {
  let pending = [];
  const stats = { entries: 0, messages: 0 };
  return {
    push(e) {
      pending.push(e);
      stats.entries++;
      if (pending.length >= Math.min(flushEvery, LOG_MAX_ENTRIES)) return this.flush();
      return null;
    },
    flush() {
      if (!pending.length) return null;
      const body = encodeLog(pending);
      pending = [];
      stats.messages++;
      return body;
    },
    stats,
  };
}

// Room side: the frames the room sent down to one seat (its own copies, by
// wire sequence, with the send time), the arrival time of each slot frame
// the seat sent up, and the judge of each log claim (6.4):
//   a claim "frame s applied after vblank k" is accepted only if the room
//   sent s before the slot frame the seat sent at k arrived (a(k)), and s
//   is not older than the newest frame the room had sent by a(k) minus the
//   admission limit L. The room's copy of s is what the shadow consumes,
//   never bytes from the seat. Refused claims are counted, not trusted.
// Bounded: keepMs of history (default 10 s).
export function createRoomFrameStore({ keepMs = 10000, admissionMs = 300 } = {}) {
  const sent = new Map(); // seq -> { at, frame }
  const sentOrder = []; // [seq, at] in send order
  const arrivals = new Map(); // upSeq -> at
  const inputs = []; // accepted entries for the shadow: { vblank, downSeq, input }
  const stats = { sent: 0, arrivals: 0, entries: 0, ok: 0, noApply: 0, future: 0, tooOld: 0, unknown: 0, noArrival: 0, lagMax: 0 };
  const trim = (now) => {
    while (sentOrder.length && now - sentOrder[0][1] > keepMs) sent.delete(sentOrder.shift()[0]);
    for (const [k, at] of arrivals) { if (now - at <= keepMs) break; arrivals.delete(k); }
    while (inputs.length > keepMs / 16) inputs.shift();
  };
  // The newest sequence sent at or before time t.
  const newestSentBy = (t) => {
    let lo = 0;
    let hi = sentOrder.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sentOrder[mid][1] <= t) { best = sentOrder[mid][0]; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  };
  // An entry is bounded by the arrival a of its own slot frame, or, when it
  // sent none (upSeq 0) or that packet was lost, by the arrival of the next
  // later entry whose frame did arrive: the seat applied the frame before
  // it sent that later frame, so the room must have sent it before a. The
  // bound is looser, never wrong. Entries wait in order (at most
  // MAX_PENDING) until such an arrival is known.
  const MAX_PENDING = 240;
  const pending = [];
  const decided = new WeakMap();
  const decide = (e, verdict) => {
    stats[verdict]++;
    decided.set(e, verdict);
    if (verdict === 'ok' || verdict === 'noApply') inputs.push({ vblank: e.vblank, downSeq: e.downSeq, input: e.input });
  };
  const verdictAt = (e, a) => {
    if (!e.downSeq) return 'noApply';
    const s = sent.get(e.downSeq);
    if (!s) return 'unknown';
    if (s.at > a) return 'future';
    if (e.downSeq < newestSentBy(a - admissionMs)) return 'tooOld';
    const lag = newestSentBy(a) - e.downSeq;
    if (lag > stats.lagMax) stats.lagMax = lag;
    return 'ok';
  };
  const drain = () => {
    for (;;) {
      while (pending.length && !pending[0].downSeq) decide(pending.shift(), 'noApply');
      if (!pending.length) return;
      const j = pending.findIndex((x) => x.upSeq && arrivals.has(x.upSeq));
      if (j < 0) {
        if (pending.length > MAX_PENDING) { decide(pending.shift(), 'noArrival'); continue; }
        return;
      }
      const a = arrivals.get(pending[j].upSeq);
      for (const x of pending.splice(0, j + 1)) decide(x, verdictAt(x, a));
    }
  };
  return {
    sentFrame(seq, frame, at) {
      sent.set(seq, { at, frame });
      sentOrder.push([seq, at]);
      stats.sent++;
      trim(at);
    },
    arrived(upSeq, at) {
      if (!upSeq) return;
      arrivals.set(upSeq, at);
      stats.arrivals++;
      drain();
    },
    // Queue one log entry and judge every entry that can be judged now;
    // returns this entry's verdict, or 'pending' while it waits for an
    // arrival to bound it.
    judge(e) {
      stats.entries++;
      pending.push(e);
      drain();
      return decided.get(e) || 'pending';
    },
    // Judge whatever still waits (end of the session) as noArrival.
    flush() {
      while (pending.length) decide(pending.shift(), 'noArrival');
    },
    frame: (seq) => (sent.get(seq) || {}).frame || null,
    newestSentBy,
    inputs,
    stats,
  };
}
