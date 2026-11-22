// mp-netem.js: LAB ONLY (multiplayer room M2, latency tolerance test). An
// artificial network on one link: every message the seat page sends to the
// room and every message it hands on from the room waits delayMs, plus or
// minus up to jitterMs (uniform), so each direction gets that much extra
// one-way latency. The ordered 'ctl' channel keeps its order (a message never
// overtakes the one before it); the unordered 'frm' channel may reorder under
// jitter, as a real network can, and loses a share `loss` of its messages
// (ctl is reliable, so it never loses any). Off unless the seat URL carries
// labnetem=1 together with netdelay / netjitter / netloss; any of those
// without labnetem=1 refuses the seat.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later

export const NETEM_MAX_DELAY_MS = 1000;
export const NETEM_MAX_JITTER_MS = 500;
export const NETEM_MAX_LOSS = 0.5;
const NETEM_KEYS = ['netdelay', 'netjitter', 'netloss'];

// parseNetem(q) -> { netem: null } (off) | { netem: { delayMs, jitterMs, loss } }
// | { error } (the seat must refuse).
export function parseNetem(q) {
  const any = NETEM_KEYS.some((k) => q.has(k));
  if (!any) return { netem: null };
  if (q.get('labnetem') !== '1') return { error: 'lab network emulation needs labnetem=1' };
  const int = (k, max) => {
    if (!q.has(k)) return 0;
    const v = q.get(k);
    if (!/^[0-9]{1,4}$/.test(v) || Number(v) > max) return null;
    return Number(v);
  };
  const delayMs = int('netdelay', NETEM_MAX_DELAY_MS);
  const jitterMs = int('netjitter', NETEM_MAX_JITTER_MS);
  let loss = 0;
  if (q.has('netloss')) {
    const v = q.get('netloss');
    loss = /^0(\.[0-9]{1,3})?$/.test(v) ? Number(v) : NaN;
    if (!(loss >= 0 && loss <= NETEM_MAX_LOSS)) return { error: 'netloss must be 0 to 0.5' };
  }
  if (delayMs === null) return { error: `netdelay must be 0 to ${NETEM_MAX_DELAY_MS}` };
  if (jitterMs === null) return { error: `netjitter must be 0 to ${NETEM_MAX_JITTER_MS}` };
  return { netem: { delayMs, jitterMs, loss } };
}

// createNetem({ delayMs, jitterMs, loss }, { now, setTimer, rand }) ->
// { schedule(dir, label, fn), stats }. dir is 'in' or 'out'; each direction
// and channel keeps its own ordering for ctl.
export function createNetem({ delayMs, jitterMs, loss }, { now = () => performance.now(), setTimer = (fn, ms) => setTimeout(fn, ms), rand = Math.random } = {}) {
  // ctl: one FIFO per direction, released strictly in order (a message
  // whose own time has come still waits for the one before it).
  // One timer chain per direction (armed), whatever the callbacks do; a
  // callback that throws costs only its own message.
  const ctlQ = { in: [], out: [] };
  const armed = { in: false, out: false };
  const stats = { delayed: 0, lost: 0, maxQueue: 0, fnErrors: 0 };
  let queued = 0;
  const run = (fn) => { queued--; try { fn(); } catch { stats.fnErrors++; } };
  const arm = (dir, ms) => { armed[dir] = true; setTimer(() => { armed[dir] = false; drainCtl(dir); }, Math.max(0, ms)); };
  const drainCtl = (dir) => {
    const qd = ctlQ[dir];
    const t = now();
    while (qd.length && qd[0].at <= t + 0.5) run(qd.shift().fn);
    if (qd.length && !armed[dir]) arm(dir, qd[0].at - now());
  };
  return {
    schedule(dir, label, fn) {
      if (label === 'frm' && loss > 0 && rand() < loss) { stats.lost++; return; }
      const t0 = now();
      let at = t0 + delayMs + (jitterMs ? jitterMs * (2 * rand() - 1) : 0);
      if (at < t0) at = t0;
      stats.delayed++;
      queued++;
      if (queued > stats.maxQueue) stats.maxQueue = queued;
      if (label === 'ctl') {
        const qd = ctlQ[dir];
        if (qd.length && at < qd[qd.length - 1].at) at = qd[qd.length - 1].at;
        qd.push({ at, fn });
        if (!armed[dir]) arm(dir, qd[0].at - t0);
        return;
      }
      setTimer(() => run(fn), at - t0);
    },
    stats,
  };
}
