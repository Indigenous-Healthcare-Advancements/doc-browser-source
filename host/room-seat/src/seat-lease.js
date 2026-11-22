// seat-lease.js: the room seat's lease heartbeat (M3 step 1b,
// docs/seat-contract.md section (iii); doc-arcade roomSeatHandoff.ts
// checklist step 1). One same-origin route only: POST /api/room/lease.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The beat: AT ONCE, then every heartbeat_s (from the send of the last
// beat): { action: "heartbeat", lease_id } with X-Cabinet-Token: room_token
// (and the same-origin cookie). Each 2xx reply's body goes to onReply (the
// page's closing logic), and its race_nonce and entry_sha are kept for the
// saves (facts(); the saves are step 1d).
//
// The refusal table (section (iii)), for a heartbeat:
//   200 ok, 200 closing      keep beating; the body goes to onReply
//   410 closed / expired     end 'gone'
//   404 (no_lease, no_horse, rooms off)   end 'gone' (as 410)
//   409 wrong_room           end 'wrong_room'
//   401 invalid room token   end 'token' (the token was replaced)
//   402, 403                 end 'refused', with the route's message
//   400                      end 'bug' (a seat bug: stop, report)
//   503, 502, 504, no answer, a timeout     the network rule below
//   429 (any)                wait, then retry, within the network rule:
//                            retry_after_s when it is a positive number,
//                            else RECONNECT_MS; at least RECONNECT_MS, at
//                            most half a lease (card-stable.js retries every
//                            429 too)
//   any other answer         end 'refused' (as /rooms' heartbeat: 0 and 503
//                            are a blip, the rest is refused)
// An end stops the beat for good; the page stops the board and goes back.
// Nothing here sends a close: that is step 1e (the page's TODO hook).
//
// Step 1d commit 5: checkout() checks the card out once, { action:
// "checkout", lease_id } on the same route and token (doc-arcade
// roomSeatHandoff.ts step 3): its answer gives the card, last_seq and the
// lease member's member_hash. Its blips are retried as a beat's (the network
// rule); any other refusal ends the lease as a beat's would. beatNow() beats
// at once (a fresh race_nonce for a save); timeLeft() is the network rule's
// bound, for the save queue: 0 once the lease has ended, still counting
// after stop() (the seat's end stops the beat, its late writes still save).
//
// The network rule (card-stable.js's: a 15 s request timeout, a retry every
// RECONNECT_MS while in trouble). It applies only while in trouble (the last
// answer was a blip): a healthy lease is never given up here.
//   not closing   give up ROOM_LEASE_MS after the send of the last beat that
//                 got a 2xx (before the first: issued_at, /rooms' own last
//                 beat), end 'lost'
//   closing       retry until closing_until less DEADLINE_MARGIN_MS (the
//                 servers' clock, serverNow), then end 'lost'. The 120 s
//                 rule does not apply while closing (conductor's ruling (b)).
// Closing, once a reply says it, stays: a closing lease is never extended. A
// healthy closing lease keeps beating (for the nonce) until the route's 410
// 'closed' ends it as 'gone'.

import { closingFromReply, DEADLINE_MARGIN_MS } from './room-closing.js';
import { serverNow } from './room-seat-handoff.js';

export const LEASE_API = '/api/room/lease';
export const REQUEST_TIMEOUT_MS = 15000;
export const RECONNECT_MS = 5000;
/** doc-arcade lib/roomCabinet ROOM_LEASE_S: the lease lives this long from its last beat. */
export const ROOM_LEASE_MS = 120000;
const RETRY_STATUS = new Set([502, 503, 504]);
const HEX64 = /^[0-9a-f]{64}$/;

/** What a heartbeat answer means: 'ok', 'blip' (the network rule), or the end it causes. */
export function classifyBeat(r) {
  if (!r || r.network) return 'blip';
  const s = r.status;
  if (s >= 200 && s < 300) return r.body && r.body.ok === false ? 'blip' : 'ok';
  if (RETRY_STATUS.has(s)) return 'blip';
  if (s === 429) return 'wait';
  if (s === 410 || s === 404) return 'gone';
  if (s === 401) return 'token';
  if (s === 402 || s === 403) return 'refused';
  if (s === 400) return 'bug';
  if (s === 409 && r.body && (r.body.code === 'wrong_room' || r.body.error === 'wrong_room')) return 'wrong_room';
  return 'refused';
}

const message = (body) => (body && typeof body.error === 'string' ? body.error.replace(/[^\x20-\x7e]/g, '').slice(0, 200) : null);

/**
 * createSeatLease({ handoff, onReply, onEnd, onTrouble, ... })
 *   handoff    a valid room seat hand-off (room-seat-handoff.js)
 *   onReply    (body) for each 2xx reply (the closing logic)
 *   onEnd      ({ kind, status, code, message }) once, when the beat ends
 *   onTrouble  (on) when the connection goes into or out of trouble
 *   fetchImpl, setTimer, clearTimer, now, timeoutMs: injectable for tests
 */
export function createSeatLease({
  handoff,
  onReply = () => {},
  onEnd = () => {},
  onTrouble = () => {},
  fetchImpl = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  now = () => Date.now(),
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (!handoff || typeof handoff.lease_id !== 'string' || typeof handoff.room_token !== 'string') throw new Error('no room seat hand-off');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
  const beatMs = handoff.heartbeat_s * 1000;
  let state = 'new'; // new, beating, ended, stopped
  let timer = null;
  let lastOk = handoff.issued_at; // /rooms beat the lease last at issued_at or just before
  let closing = null; // { untilMs (the servers' clock), clock, reason }
  let trouble = false;
  let lastBlip = null; // the last failed answer, named by a give-up
  let facts = { race_nonce: null, entry_sha: null, at: null };
  let checkedOut = false;
  const stats = { beats: 0, ok: 0, blips: 0, lastStatus: null, sentAt: [] };
  const live = () => state === 'beating';
  // Review of 92fe3de (P2-2): beats can overlap (a refresh beside a slow
  // end beat). Each send is numbered; an answer applies only when its send
  // is newer than the last one applied, so a slow old answer never puts a
  // stale race_nonce over a fresh one.
  let sendSeq = 0;
  let appliedSeq = 0;

  // One POST, raced against its own timeout (so the timeout runs on the
  // injected timers). { status, body } or { network: true }.
  // The timeout is cut short at the give-up, so a request in flight then
  // ends the beat on time.
  // keepalive (the close only): the request outlives the page's way back to /rooms.
  async function post(waitMs, body = { action: 'heartbeat', lease_id: handoff.lease_id }, { keepalive = false } = {}) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    let t = null;
    const timeout = new Promise((res) => { t = setTimer(() => { try { if (ctl) ctl.abort(); } catch { /* gone */ } res({ network: true, timeout: true }); }, waitMs); });
    const call = (async () => {
      let res;
      try {
        res = await fetchImpl(LEASE_API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-cabinet-token': handoff.room_token },
          body: JSON.stringify(body),
          cache: 'no-store', credentials: 'same-origin', ...(keepalive ? { keepalive: true } : {}), ...(ctl ? { signal: ctl.signal } : {}),
        });
      } catch { return { network: true }; }
      let json = {};
      try { json = await res.json(); } catch { json = {}; }
      return { status: res.status, body: json && typeof json === 'object' && !Array.isArray(json) ? json : {} };
    })();
    const r = await Promise.race([call, timeout]);
    clearTimer(t);
    return r;
  }

  // Time left before the give-up, in ms: the closing deadline (the servers'
  // clock) while closing, else a lease length after the last 2xx.
  const left = () => (closing ? closing.untilMs - DEADLINE_MARGIN_MS - serverNow(handoff, now()) : lastOk + ROOM_LEASE_MS - now());

  function schedule(ms) {
    if (timer !== null) clearTimer(timer);
    timer = live() ? setTimer(beat, Math.max(0, ms)) : null;
  }

  function end(kind, r) {
    if (!live()) return;
    state = 'ended';
    if (timer !== null) { clearTimer(timer); timer = null; }
    const body = r && r.body ? r.body : {};
    const code = typeof body.code === 'string' ? body.code : typeof body.error === 'string' && /^[a-z_]{1,32}$/.test(body.error) ? body.error : null;
    const info = { kind, status: r && !r.network ? r.status : 0, code, message: r && !r.network ? message(body) : null };
    try { onEnd(info); } catch { /* the page's */ }
  }

  function setTrouble(on) {
    if (trouble === on) return;
    trouble = on;
    try { onTrouble(on); } catch { /* the page's */ }
  }

  // The first beat always goes (the lease may well be alive: /rooms beat it
  // last at issued_at or just before). In trouble, a retry goes only before
  // the give-up, and its timeout is cut short there.
  async function beat(first = false) {
    timer = null;
    if (!live()) return;
    const l0 = left();
    const cut = !first && trouble;
    if (cut && l0 <= 0) { end('lost', lastBlip || { network: true }); return; }
    const sentAt = now();
    stats.beats++;
    stats.sentAt.push(sentAt);
    if (stats.sentAt.length > 50) stats.sentAt.shift();
    const mine = ++sendSeq;
    const r = await post(cut ? Math.min(timeoutMs, l0) : timeoutMs);
    if (!live()) return;
    if (mine <= appliedSeq) { stats.stale = (stats.stale || 0) + 1; return; } // a newer send answered first
    appliedSeq = mine;
    stats.lastStatus = r.network ? 0 : r.status;
    const kind = classifyBeat(r);
    if (kind === 'ok') {
      stats.ok++;
      lastOk = sentAt; // the server renewed the lease no earlier than this send
      setTrouble(false);
      const b = r.body;
      const n = typeof b.race_nonce === 'string' ? b.race_nonce.toLowerCase() : '';
      const e = typeof b.entry_sha === 'string' ? b.entry_sha.toLowerCase() : '';
      facts = { race_nonce: HEX64.test(n) ? n : null, entry_sha: HEX64.test(e) ? e : null, at: lastOk };
      const c = closingFromReply(b, { nowMs: serverNow(handoff, now()) });
      if (c) closing = { untilMs: c.untilMs, clock: c.clock, reason: c.reason };
      try { onReply(b); } catch { /* the page's */ }
      if (!live()) return;
      schedule(sentAt + beatMs - now());
      return;
    }
    if (kind === 'blip') {
      stats.blips++;
      lastBlip = r;
      setTrouble(true);
      const l = left();
      if (l <= 0) { end('lost', r); return; }
      schedule(Math.min(RECONNECT_MS, l));
      return;
    }
    if (kind === 'wait') {
      stats.blips++;
      lastBlip = r;
      setTrouble(true);
      const l = left();
      if (l <= 0) { end('lost', r); return; }
      const ra = Number(r.body && r.body.retry_after_s);
      const wait = Math.min(ROOM_LEASE_MS / 2, Math.max(RECONNECT_MS, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0));
      schedule(Math.min(wait, l));
      return;
    }
    end(kind, r);
  }

  return {
    /** Beat at once, then every heartbeat_s. Once only. */
    start() { if (state !== 'new') return; state = 'beating'; beat(true); },
    /** Stop beating without an end (a leave that closes the lease itself: step 1e). */
    stop() { if (state === 'ended') return; state = 'stopped'; if (timer !== null) { clearTimer(timer); timer = null; } },
    /**
     * Step 1e: the seat's own close on a Leave, { action: "close", lease_id } (doc-arcade /api/room/lease: recorded
     * 'seat_closed', an abandon only if a race is owed). Once per page; from a beating or a stopped lease (the
     * page stops the beat after its save drain); the beat stops first. One POST, no retry on a status (a refused
     * close leaves the lease to expire, as before); one retry for a network error with no answer.
     * { ok, status, code }.
     */
    async close() {
      if (state === 'ended' || state === 'new' || stats.closeSent) return { ok: false, status: 0, code: 'not open' };
      stats.closeSent = true;
      if (state === 'beating') { state = 'stopped'; if (timer !== null) { clearTimer(timer); timer = null; } }
      const ask = { action: 'close', lease_id: handoff.lease_id };
    let r = await post(timeoutMs, ask, { keepalive: true });
    if (r.network && !r.timeout) r = await post(timeoutMs, ask, { keepalive: true });
      const body = r && r.body ? r.body : {};
      const code = typeof body.code === 'string' ? body.code : typeof body.error === 'string' && /^[a-z_]{1,32}$/.test(body.error) ? body.error : null;
      stats.closeStatus = r.network ? 0 : r.status;
      return { ok: !r.network && r.status >= 200 && r.status < 300, status: stats.closeStatus, code };
    },
    /**
     * Check the card out (once per page load, before the board boots):
     * { ok: true, body } with the 2xx body, or { ok: false } once the lease
     * has ended (this refusal ends it, onEnd). Ruled (review P2-6, A1: a
     * second checkout after a race_enter ends or closes the lease): ONE
     * retry, only for a network error where no response arrived, and only
     * while canRetry() (the board has not booted); never on any status. A
     * 429 ends as 'resting' (return_path with the resting text); a 5xx, a
     * timeout or a second network error ends as 'lost' (at most two
     * timeouts and RECONNECT_MS, about 35 s).
     */
    async checkout({ canRetry = () => true } = {}) {
      if (checkedOut) return { ok: false };
      checkedOut = true;
      let retried = false;
      for (;;) {
        if (!live()) return { ok: false };
        const l0 = left();
        if (l0 <= 0) { end('lost', lastBlip || { network: true }); return { ok: false }; }
        const r = await post(Math.min(timeoutMs, l0), { action: 'checkout', lease_id: handoff.lease_id });
        if (!live()) return { ok: false };
        const kind = classifyBeat(r);
        if (kind === 'ok') return { ok: true, body: r.body };
        if (kind === 'wait') { end('resting', r); return { ok: false }; }
        if (r.network && !r.timeout && !retried && canRetry()) {
          retried = true;
          lastBlip = r;
          await new Promise((res) => setTimer(res, Math.min(RECONNECT_MS, Math.max(0, left()))));
          if (!canRetry()) { end('lost', r); return { ok: false }; }
          continue;
        }
        end(kind === 'blip' ? 'lost' : kind, r);
        return { ok: false };
      }
    },
    /** Beat at once (a save's fresh race_nonce): the nonce after it, or null. */
    async beatNow() {
      if (!live()) return null;
      if (timer !== null) { clearTimer(timer); timer = null; }
      await beat();
      return facts.race_nonce;
    },
    /** The network rule's bound in ms (the save queue's): 0 once the lease ended. */
    timeLeft: () => (state === 'ended' || state === 'new' ? 0 : Math.max(0, left())),
    /** The last 2xx's race_nonce and entry_sha (for step 1d's saves; null when none). */
    facts: () => ({ ...facts }),
    /** The lease's closing as the beat knows it (untilMs in the servers' clock), or null. */
    closing: () => (closing ? { ...closing } : null),
    state: () => state,
    trouble: () => trouble,
    stats,
  };
}
