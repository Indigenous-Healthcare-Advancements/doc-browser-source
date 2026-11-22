// mp-seat-link-worker.js: LAB ONLY (multiplayer room M1 and M2). The seat
// side of the link (doc-ops MULTIPLAYER_SERVER.md 3, 6.4, 7). Owns the seat
// board's mailbox and the seat's 60 Hz clock, which replaces the hub's
// release for a remote seat (the relaxed model: each board runs its own
// vblank clock and takes the newest frame that has arrived). It talks to the
// room through the page's WebRTC DataChannels (mp-rtc.js) over a
// MessagePort and opens no network connection itself. Each tick, while the
// board waits at its vblank barrier:
//   1. its newest slot frame, if new, is coded and sent up;
//   2. the newest assembled frame from the room, if new, is delivered;
//   3. one shadow log entry is written (vblank, frame sent up, frame
//      delivered, input), and every few entries the log goes to the room on
//      the reliable channel (mp-shadow-log.js);
//   4. the board is released one vblank.
// Delivering only at the barrier makes "which link frame did the board read
// at vblank k" a fact the seat can log.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// init: { port, slot, roomTag, mailbox }; relink: { port, resume } (a new link to the held station). From the page: { type: 'start' }
// (the board is installed) starts the clock; { type: 'card-write', seq,
// bytes }; { type: 'report', body } (a seat report, mp-wire.js); { type: 'leave', reason }; { type: 'stall', ms } (lab: hold all
// sending and delivery for ms, a link stall test); { type: 'stop' }.
// To the page: { type: 'open' } | { type: 'welcome', settings } | { type: 'card', bytes } |
// { type: 'fault', where, message } (a handler threw; the link lives on) |
// { type: 'refused', reason } | { type: 'card-ack', verdict } | { type: 'eject', reason } (L2: the room
// asks for the eject save) | { type: 'gone', reason } | { type: 'stats' }.

import { mailboxViews, readTx, deliver, MB } from './lb-lockstep.js';
import { T, decodeHeader, encodeMessage, bodyOf, utf8, fromUtf8, createFrameSender, createFrameReceiver, MP_BUILD } from './mp-wire.js';
import { createSeatLogger } from './mp-shadow-log.js';

const TICK_MS = 1000 / 60;
let cfg = null;
let port = null;
let open = false;
let gone = false;
let views = null;
let running = false;
let stallUntil = 0;
// let: a relink (reconnect to the held station) starts both afresh; the room's new link starts at sequence 0.
let sender = createFrameSender();
let receiver = createFrameReceiver();
const logger = createSeatLogger();
let pendingDown = null; // newest decoded assembled frame not yet delivered: { seq, frame }
let lastTxSeq = 0;
const stats = { ticks: 0, released: 0, notAtBarrier: 0, upSent: 0, upBytes: 0, downApplied: 0, downDelivered: 0, downBytes: 0, lateResets: 0, stallTicks: 0, clockFaults: 0, logEntries: 0, logMessages: 0 };
// What the player sees: the gaps between released vblanks (frame times,
// buckets up to 20, 34, 50 and 100 ms, and over), and runs of vblanks in a
// row with no new frame from the room (the other boards look frozen): runs
// of 2 or more, 6 or more (100 ms) and 30 or more (500 ms), and the longest.
const feel = { gap20: 0, gap34: 0, gap50: 0, gap100: 0, gapOver: 0, gapMaxMs: 0, stale2: 0, stale6: 0, stale30: 0, staleMax: 0 };
let lastReleaseAt = 0;
let staleRun = 0;
const noteRelease = () => {
  const t = performance.now();
  if (lastReleaseAt) {
    const g = t - lastReleaseAt;
    if (g <= 20) feel.gap20++; else if (g <= 34) feel.gap34++; else if (g <= 50) feel.gap50++; else if (g <= 100) feel.gap100++; else feel.gapOver++;
    if (g > feel.gapMaxMs) feel.gapMaxMs = Math.round(g);
  }
  lastReleaseAt = t;
};
const endStale = () => {
  if (staleRun >= 2) feel.stale2++;
  if (staleRun >= 6) feel.stale6++;
  if (staleRun >= 30) feel.stale30++;
  staleRun = 0;
};

const post = (m) => self.postMessage(m);
const snapshot = () => ({ ...stats, feel: { ...feel, staleNow: staleRun }, sender: { ...sender.stats }, receiver: { ...receiver.stats } });

function sendOn(ch, bytes) {
  if (!open || gone) return false;
  const b = bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.length ? bytes.buffer : bytes.slice().buffer;
  port.postMessage({ ch, data: b }, [b]);
  return true;
}
const send = (type, body) => sendOn('ctl', encodeMessage({ type, slot: cfg.slot, roomTag: cfg.roomTag, ack: receiver.newest() }, body));

function tick() {
  stats.ticks++;
  const i32 = views.i32;
  const VB = MB.vblankCount >> 2;
  const HR = MB.hubRound >> 2;
  const reached = Atomics.load(i32, VB);
  const atBarrier = reached > Atomics.load(i32, HR);
  if (performance.now() < stallUntil) { stats.stallTicks++; if (atBarrier) { Atomics.store(i32, HR, reached); Atomics.notify(i32, HR); stats.released++; noteRelease(); if (stats.downDelivered) { staleRun++; if (staleRun > feel.staleMax) feel.staleMax = staleRun; } } return; }
  if (!atBarrier) { stats.notAtBarrier++; return; }
  // 1. Up: the board is blocked, so its slot frame is not being written.
  let upSeq = 0;
  const t = readTx(views);
  if (t.txSeq && t.txSeq !== lastTxSeq && open) {
    lastTxSeq = t.txSeq;
    const out = sender.encode(t.bytes, { type: T.up, slot: cfg.slot, roomTag: cfg.roomTag, ackOut: receiver.newest(), now: performance.now() });
    upSeq = sender.seq();
    sendOn('frm', out);
    stats.upSent++;
    stats.upBytes += out.length;
  }
  // 2. Down: the newest frame from the room, once.
  let downSeq = 0;
  if (pendingDown) {
    deliver(views, pendingDown.frame);
    downSeq = pendingDown.seq;
    pendingDown = null;
    stats.downDelivered++;
    endStale();
  } else if (stats.downDelivered) {
    staleRun++;
    if (staleRun > feel.staleMax) feel.staleMax = staleRun;
  }
  // 3. The shadow log entry for this vblank.
  const body = logger.push({ vblank: reached, upSeq, downSeq, input: Atomics.load(i32, MB.inputMask >> 2) });
  stats.logEntries++;
  if (body && send(T.log, body)) stats.logMessages++;
  // 4. Release one vblank.
  Atomics.store(i32, HR, reached);
  Atomics.notify(i32, HR);
  stats.released++;
  noteRelease();
}

function startClock() {
  if (running) return;
  running = true;
  let t0 = performance.now();
  let k = 0;
  const step = () => {
    if (!running) return;
    k++;
    let due = t0 + k * TICK_MS;
    const behind = performance.now() - due;
    if (behind > 250) { t0 += behind; due += behind; stats.lateResets++; }
    // A tick that throws stops the clock for good and is reported as a
    // 'clock' fault: the page then releases the board's barrier (freeBoard),
    // as for a dead worker, so the card look and the eject still run. It is
    // not rescheduled, and 'running' stays set, so no later start revives it.
    try { tick(); } catch (err) { stats.clockFaults++; post({ type: 'fault', where: 'clock', message: faultText(err) }); return; }
    setTimeout(step, Math.max(0, due + TICK_MS - performance.now()));
  };
  setTimeout(step, TICK_MS);
}

function onMessage(data, ch) {
  const bytes = new Uint8Array(data);
  const h = decodeHeader(bytes);
  if (!h || h.slot !== cfg.slot || (cfg.roomTag && h.roomTag !== cfg.roomTag)) return;
  if ((h.type === T.down) !== (ch === 'frm')) return; // frames on frm only, everything else on ctl only
  sender.ack(h.ack, performance.now());
  if (h.type === T.down) {
    if (performance.now() < stallUntil) return; // lab stall: as if lost
    const got = receiver.take(bytes);
    if (got) { pendingDown = { seq: got.seq, frame: got.frame }; stats.downApplied++; stats.downBytes += bytes.length; }
    return;
  }
  const body = bodyOf(bytes);
  if (h.type === T.welcome) post({ type: 'welcome', settings: JSON.parse(fromUtf8(body)) });
  else if (h.type === T.card) { const c = body.slice(); post({ type: 'card', bytes: c.buffer }, [c.buffer]); }
  else if (h.type === T.refuse) post({ type: 'refused', reason: fromUtf8(body) });
  else if (h.type === T.cardAck) post({ type: 'card-ack', verdict: JSON.parse(fromUtf8(body)) });
  else if (h.type === T.taken) { let info = null; try { info = JSON.parse(fromUtf8(body)); } catch { info = null; } post({ type: 'taken', info: info && typeof info === 'object' ? info : null }); }
  else if (h.type === T.eject) post({ type: 'eject', reason: fromUtf8(body).slice(0, 40).replace(/[^\x20-\x7e]/g, '?') });
}

// A handler that throws is a fault, not the worker's death: it is reported
// to the page and the worker goes on (the page's onerror then means the
// worker itself is gone).
function guarded(where, fn) {
  return (ev) => {
    try { fn(ev); } catch (err) { post({ type: 'fault', where, message: faultText(err) }); }
  };
}
function faultText(err) { return String(err && err.message ? err.message : err).slice(0, 120); }

function bindPort(p0, resume) {
  port = p0;
  port.onmessage = guarded('port', (ev) => {
    const p = ev.data;
    if (p.type === 'open') { open = true; send(T.hello, utf8(JSON.stringify({ build: MP_BUILD, ...(resume ? { resume } : {}) }))); post({ type: 'open' }); return; }
    if (p.type === 'closed') { goneNow(p.reason || 'closed'); return; }
    if (p.data instanceof ArrayBuffer) onMessage(p.data, p.ch);
  });
}

function goneNow(reason) {
  if (gone) return;
  gone = true;
  open = false;
  post({ type: 'gone', reason, stats: snapshot() });
}

self.onmessage = guarded('page', (e) => {
  const m = e.data;
  if (m.type === 'init') {
    cfg = { ...m };
    views = mailboxViews(m.mailbox);
    bindPort(m.port, null);
    // direct (the room's standby, mp-room-standby.js): the port goes straight to the room's link worker and is open now.
    if (m.direct === true) { open = true; send(T.hello, utf8(JSON.stringify({ build: MP_BUILD }))); post({ type: 'open' }); }
    setInterval(() => post({ type: 'stats', stats: snapshot() }), 1000);
  } else if (m.type === 'relink') {
    // Reconnect: the old link is gone; the clock and the board ran on (the room held the station under its cover).
    // A new link to the same station, whose hello names the resume key from the welcome.
    if (!cfg || !m.port || typeof m.resume !== 'string') return;
    open = false;
    gone = false;
    sender = createFrameSender();
    receiver = createFrameReceiver();
    pendingDown = null;
    stats.relinks = (stats.relinks || 0) + 1;
    bindPort(m.port, m.resume);
  } else if (m.type === 'start') {
    startClock();
  } else if (m.type === 'card-write') {
    const card = new Uint8Array(m.bytes);
    const body = new Uint8Array(4 + card.length);
    new DataView(body.buffer).setUint32(0, m.seq >>> 0, true);
    body.set(card, 4);
    send(T.cardWrite, body);
  } else if (m.type === 'report') {
    if (m.body instanceof ArrayBuffer && m.body.byteLength > 0) send(T.report, new Uint8Array(m.body));
  } else if (m.type === 'leave') {
    const rest = logger.flush();
    if (rest) send(T.log, rest);
    send(T.close, utf8(m.reason || 'finish'));
    // The close goes out on the reliable channel before the peer ends; the
    // room ends the link when it reads it. Fallback close after 2 s.
    setTimeout(() => { if (!gone) { port.postMessage({ type: 'close' }); goneNow('left'); } }, 2000);
  } else if (m.type === 'stall') {
    stallUntil = performance.now() + (m.ms || 0);
  } else if (m.type === 'stop') {
    running = false;
    Atomics.store(views.i32, MB.barrierStop >> 2, 1);
    Atomics.notify(views.i32, MB.hubRound >> 2);
  }
});
