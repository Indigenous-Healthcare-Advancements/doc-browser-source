// lb-frame-time.js: LAB ONLY (boot stretch diagnosis). A board's time per
// run call (_shim_run_frame, lb-board-worker.js), split into the time the
// call spent blocked in Atomics.wait (the vblank barrier, the multiboard
// barriers: all of the core's waits are JS imports that call Atomics.wait)
// and the rest, its own work. A run call covers one rendered frame, about
// two guest vblanks in a room, so the work thresholds are applied per
// vblank (the call's work divided by the vblanks it ran). Kept per second
// of the board's own wall clock; each closed second becomes one record
// with the board's frame and vblank counts, which the room page echoes as
// one lab log line (the lab driver's logs/frame-time.jsonl).
// Off by default: the board keeps no aggregate, times no wait and posts
// nothing unless the room page was opened with its lab flag (mp-room.js; the
// room daemon sets it only with --lab). Timings and counts only.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later

export const FRAME_TIME_WINDOW_MS = 1000;
// Thresholds in ms: one 60 Hz vblank, one and a half, two.
export const FRAME_TIME_OVER = Object.freeze([16.7, 25, 33]);
export const FRAME_TIME_VERSION = 2;

const r2 = (x) => Math.round(x * 100) / 100;

// createFrameTimeAgg({ windowMs }): add(runMs, endMs, { f, vb, waitMs,
// vblanks }) after every run call (endMs: when the call returned; waitMs:
// its time in Atomics.wait; vblanks: the guest vblanks it ran, or null when
// the board has no vblank count, the graphics partner). Returns the record
// of the second it closes, or null. A window opens at the start of its
// first call and closes with the first call that ends at least windowMs
// later (that call counted in it), so no call is lost or counted twice.
// flush() closes an open window early (a board that stops), or returns null.
export function createFrameTimeAgg({ windowMs = FRAME_TIME_WINDOW_MS } = {}) {
  let w = null;
  const close = () => {
    const out = frameTimeRecord(w);
    w = null;
    return out;
  };
  return {
    add(runMs, endMs, { f = null, vb = null, waitMs = 0, vblanks = null } = {}) {
      if (!Number.isFinite(runMs) || !Number.isFinite(endMs)) return null;
      const wait = Number.isFinite(waitMs) && waitMs > 0 ? Math.min(waitMs, runMs) : 0;
      const work = runMs - wait;
      const nvb = Number.isInteger(vblanks) && vblanks > 0 ? vblanks : null;
      if (!w) {
        w = { t0: endMs - runMs, t1: endMs, f0: f, f, vb0: vb, vb, n: 0, sum: 0, max: 0, over: FRAME_TIME_OVER.map(() => 0),
          waitSum: 0, waitMax: 0, workSum: 0, workMax: 0, vblanks: 0, unknownVb: 0, workVbMax: 0, workVbOver: FRAME_TIME_OVER.map(() => 0) };
      }
      w.n++;
      w.sum += runMs;
      if (runMs > w.max) w.max = runMs;
      for (let i = 0; i < FRAME_TIME_OVER.length; i++) if (runMs > FRAME_TIME_OVER[i]) w.over[i]++;
      w.waitSum += wait;
      if (wait > w.waitMax) w.waitMax = wait;
      w.workSum += work;
      if (work > w.workMax) w.workMax = work;
      // Work per vblank: the call's work over the vblanks it ran (a call
      // with no known count, or none, counts as one).
      if (nvb) w.vblanks += nvb; else w.unknownVb++;
      const perVb = work / (nvb || 1);
      if (perVb > w.workVbMax) w.workVbMax = perVb;
      for (let i = 0; i < FRAME_TIME_OVER.length; i++) if (perVb > FRAME_TIME_OVER[i]) w.workVbOver[i]++;
      w.t1 = endMs;
      w.f = f;
      w.vb = vb;
      return endMs - w.t0 >= windowMs ? close() : null;
    },
    flush() { return w && w.n ? close() : null; },
  };
}

// The record of one window (the frame-time.jsonl format, version 2):
//   v: 2; f0, f: the board's frame count after its first and last call;
//   vb0, vb: its guest vblank count there (null for a board without a seat
//   mailbox, the graphics partner); spanMs: from the start of the first
//   call to the end of the last (all n calls); n: run calls;
//   sumMs, maxMs, meanMs, over16, over25, over33: the whole run call (work
//   and wait) and how many calls took over 16.7, 25 and 33 ms;
//   waitSumMs, waitMaxMs: the calls' time in Atomics.wait (the barriers);
//   workSumMs, workMaxMs: run minus wait, per call;
//   vblanks: guest vblanks run in the window's calls; unknownVb: calls with
//   no vblank count, or none run (each taken as one vblank below);
//   workVbMaxMs, workVbOver16, workVbOver25, workVbOver33: work per vblank
//   (a call's work over its vblanks): its maximum, and how many calls had
//   it over 16.7, 25 and 33 ms.
export function frameTimeRecord(w) {
  return {
    v: FRAME_TIME_VERSION, f0: w.f0, f: w.f, vb0: w.vb0, vb: w.vb, spanMs: r2(w.t1 - w.t0),
    n: w.n, sumMs: r2(w.sum), maxMs: r2(w.max), meanMs: w.n ? r2(w.sum / w.n) : 0,
    over16: w.over[0], over25: w.over[1], over33: w.over[2],
    waitSumMs: r2(w.waitSum), waitMaxMs: r2(w.waitMax), workSumMs: r2(w.workSum), workMaxMs: r2(w.workMax),
    vblanks: w.vblanks, unknownVb: w.unknownVb, workVbMaxMs: r2(w.workVbMax),
    workVbOver16: w.workVbOver[0], workVbOver25: w.workVbOver[1], workVbOver33: w.workVbOver[2],
  };
}

const INT_KEYS = ['n', 'over16', 'over25', 'over33', 'vblanks', 'unknownVb', 'workVbOver16', 'workVbOver25', 'workVbOver33'];
const NUM_KEYS = ['spanMs', 'sumMs', 'maxMs', 'meanMs', 'waitSumMs', 'waitMaxMs', 'workSumMs', 'workMaxMs', 'workVbMaxMs'];
export const FRAME_TIME_KEYS = Object.freeze(['v', 'f0', 'f', 'vb0', 'vb', 'spanMs', 'n', 'sumMs', 'maxMs', 'meanMs', 'over16', 'over25', 'over33',
  'waitSumMs', 'waitMaxMs', 'workSumMs', 'workMaxMs', 'vblanks', 'unknownVb', 'workVbMaxMs', 'workVbOver16', 'workVbOver25', 'workVbOver33']);
const int = (x) => Number.isInteger(x) && x >= 0;
const intOrNull = (x) => x === null || int(x);
const num = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;

// The room page's line: the board label, gen and the record, checked field
// by field so nothing but these numbers reaches the log. gen is the
// cabinet's slot generation for that board (lb-cabinet.js
// state.boards[i].generation): it steps at every vacateSlot or
// restartBoard, so a seat hand-over and its take-back step it twice; a new
// value marks a new board in the slot, it is not a refill count.
// Returns the JSON text, or null.
export function frameTimeLine({ at, board, gen = 0 }, rec) {
  if (typeof at !== 'string' || at.length > 40 || typeof board !== 'string' || !/^[a-z0-9]{1,16}$/.test(board) || !int(gen)) return null;
  if (!rec || typeof rec !== 'object' || rec.v !== FRAME_TIME_VERSION) return null;
  if (![rec.f0, rec.f, rec.vb0, rec.vb].every(intOrNull) || !INT_KEYS.every((k) => int(rec[k])) || !NUM_KEYS.every((k) => num(rec[k]))) return null;
  const out = { at, board, gen };
  for (const k of FRAME_TIME_KEYS) out[k] = rec[k];
  return JSON.stringify(out);
}

export const FRAME_TIME_PREFIX = '[frametime] ';
