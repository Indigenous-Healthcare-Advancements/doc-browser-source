// room-save-queue.js: the room seat's writer queue (M3 step 1d commit 4,
// docs/seat-1d-plan.md section 2). Every card write the board makes is saved
// over HTTPS through doc-arcade's host-stable room branch, one POST at a
// time, in the order the game made them. One same-origin route only:
// POST /api/connector/host-stable.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Body { id: horse_id, card_b64, horse_name, lease_id, seq, race_nonce },
// header X-Cabinet-Token: room_token. Each write takes the next seq once
// (the first is checkout's last_seq + 1); a retry reuses it.
// Every write joins the queue at once, in game order, and is put in the
// stash (room-stash.js) BEFORE its first POST. It leaves the stash only when
// it lands (a 2xx: saved, or 'already'), with every lower seq of the lease
// (supersede). Anything that does not land stays in the stash: the page
// shows it as held, and the late save poster takes it after the lease ended.
//
// The answers (card-stable.js's rules; host-stable's lease_error codes, from
// doc-arcade src/lib/roomCabinet.ts LEASE_STATUS; docs/seat-contract.md's table):
//   2xx with ok not false     landed (a DOC '99 retry of the write that landed is
//                             ok with already, a 2xx too)
//   network, timeout, 502, 503, 504, a 2xx with ok false
//                             retry the same seq every RECONNECT_MS while the
//                             lease can live (timeLeft(): a lease length after
//                             the last 2xx beat, or closing_until less the
//                             margin while closing); then stop, all held
//   429                       wait retry_after_s (else RECONNECT_MS), within that
//   409 stale_seq             (1d commit 5, ruled: never a checkout, which ends a
//                             lease with a race owed) the refusal's last_seq: at
//                             or above this seq, an earlier attempt of this write
//                             landed (the seat is its lease's only writer; Rev C
//                             answers a retry of a landed write so): dropped, as
//                             landed; missing or below it: held, in the stash
//   409 race_running, place_required
//                             retry every RECONNECT_MS (the result comes), within
//                             the lease's time
//   409 nonce_mismatch, nonce_required
//                             one fresh beat for the nonce, one retry
//   410 (closed, expired, lock_lost, baseline_moved), 404 (no_lease, no_horse,
//   rooms off), 401 (the token), 402 and 403, 400 (a seat bug)
//                             the queue stops: every write left stays held
//   anything else (409 stint_open, closing and the rest, 422 a judge's
//   refusal, 500)             this write is held, the queue goes on

export const HOST_STABLE_API = '/api/connector/host-stable';
export const REQUEST_TIMEOUT_MS = 15000;
export const RECONNECT_MS = 5000;
const RETRY_STATUS = new Set([502, 503, 504]);
const HEX64 = /^[0-9a-f]{64}$/;

/** What a save answer means for the queue. */
export function classifySave(r) {
  if (!r || r.network) return 'blip';
  const s = r.status;
  const b = r.body && typeof r.body === 'object' ? r.body : {};
  if (s >= 200 && s < 300) return b.ok === false ? 'blip' : 'landed';
  if (RETRY_STATUS.has(s)) return 'blip';
  if (s === 429) return 'wait';
  if (s === 410 || s === 404 || s === 401 || s === 402 || s === 403 || s === 400) return 'stop';
  if (s === 409) {
    const e = b.lease_error;
    if (e === 'stale_seq') return 'stale';
    if (e === 'race_running' || e === 'place_required') return 'later';
    if (e === 'nonce_mismatch' || e === 'nonce_required') return 'nonce';
  }
  return 'held';
}

/** Why a 'stop' answer stopped the queue. */
export function stopReason(status) {
  if (status === 401) return 'token';
  if (status === 400) return 'bug';
  if (status === 402 || status === 403) return 'refused';
  return 'gone';
}

const toB64 = (bytes) => {
  let s = '';
  const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
};

/**
 * createSaveQueue({ handoff, firstSeq, stash, memberHash, edition, nonce,
 *   refreshNonce, timeLeft, onChange, fetchImpl, setTimer, clearTimer, now,
 *   timeoutMs })
 *   handoff       the room seat hand-off (lease_id, room_token, horse_id, horse_name, release)
 *   firstSeq      checkout's last_seq + 1
 *   stash         an open room-stash (put, landed); null keeps nothing
 *   memberHash    the stash entries' member_hash
 *   edition       the stash entries' edition
 *   nonce         () the last race_nonce a heartbeat named (or null)
 *   refreshNonce  () a promise of a fresh nonce (one beat)
 *   timeLeft      () ms the lease can still live: the bound on every retry
 *   onChange      ({ pending, held, stopped, next }) after every change
 *   onNote        (text) a page error the queue saw (a stale_seq last_seq above this seq)
 * Returns { write(bytes) -> seq, drain(ms) -> { left }, state(), stats(),
 *   unstashed() (writes neither landed nor kept in the stash, queued or held), stop() }.
 */
export function createSaveQueue({
  handoff, firstSeq, stash = null, memberHash = null, edition = null,
  nonce = () => null, refreshNonce = async () => null, timeLeft = () => 0,
  onChange = () => {}, onNote = () => {},
  fetchImpl = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t),
  now = () => Date.now(), timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  if (!handoff || typeof handoff.lease_id !== 'string' || typeof handoff.room_token !== 'string') throw new Error('no room seat hand-off');
  if (!Number.isSafeInteger(firstSeq) || firstSeq < 1) throw new Error('firstSeq must be a positive integer');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
  let next = firstSeq;
  const queue = []; // { seq, b64, stashed (its put, a promise), kept (true once in the stash), tries: { nonce } }
  // The held writes (refused, or left when the queue stopped). A later write
  // that lands supersedes every lower seq (the stash's own rule), so they go
  // (review P2-4): held is what is still owed, never a running count.
  const heldItems = [];
  // Every write neither landed nor kept in the stash (queued or held): what a
  // closed tab would lose (unstashed()).
  const loose = new Set();
  let stopped = null; // why the queue stopped
  let busy = false;
  let timer = null;
  const waiters = [];
  const stats = { posts: 0, landed: 0, held: 0, blips: 0, stashFails: 0, lastStatus: null, landedSeq: null }; // landedSeq: the highest seq landed

  const state = () => ({ pending: queue.length, held: heldItems.length, stopped, next });
  const note = (t) => { try { onNote(t); } catch { /* the page's */ } };
  const changed = () => {
    try { onChange(state()); } catch { /* the page's */ }
    if (queue.length === 0 || stopped) for (const w of waiters.splice(0)) w();
  };
  const entryOf = (q) => ({ lease_id: handoff.lease_id, seq: q.seq, horse_id: handoff.horse_id, release: handoff.release, edition, card_b64: q.b64, at: now(), member_hash: memberHash });
  // The stash put of one write: true when kept. Never rejects.
  const keep = async (q) => {
    if (!stash) return false;
    let ok = false;
    try { ok = (await stash.put(entryOf(q))) === true; } catch { ok = false; }
    if (!ok) stats.stashFails++;
    q.kept = ok;
    if (ok) loose.delete(q);
    changed(); // kept or not, the page's notice follows the put (review P2-1)
    return ok;
  };

  async function post(item, waitMs) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    let t = null;
    const timeout = new Promise((res) => { t = setTimer(() => { try { if (ctl) ctl.abort(); } catch { /* gone */ } res({ network: true, timeout: true }); }, waitMs); });
    const n = nonce();
    const body = { id: handoff.horse_id, card_b64: item.b64, horse_name: handoff.horse_name, lease_id: handoff.lease_id, seq: item.seq };
    if (typeof n === 'string' && HEX64.test(n)) body.race_nonce = n;
    const call = (async () => {
      let res;
      try {
        res = await fetchImpl(HOST_STABLE_API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-cabinet-token': handoff.room_token },
          body: JSON.stringify(body),
          cache: 'no-store', credentials: 'same-origin', ...(ctl ? { signal: ctl.signal } : {}),
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

  const later = (ms) => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => { timer = null; pump(); }, Math.max(0, ms));
  };

  async function landed(item) {
    queue.shift();
    await settled(item);
  }

  // A write the server holds: it leaves the stash with every lower seq.
  async function settled(item) {
    loose.delete(item);
    stats.landed++;
    if (stats.landedSeq === null || item.seq > stats.landedSeq) stats.landedSeq = item.seq;
    // Every held write below this seq is superseded (review P2-4).
    for (let i = heldItems.length - 1; i >= 0; i--) if (heldItems[i].seq < item.seq) { loose.delete(heldItems[i]); heldItems.splice(i, 1); }
    // This seq and every lower seq of the lease leave the stash (supersede).
    if (stash) { try { await stash.landed(handoff.lease_id, item.seq); } catch { /* the entry expires */ } }
  }

  async function afterStop(item, r) {
    stats.lastStatus = r.network ? 0 : r.status;
    const kind = classifySave(r);
    const ls = r.body ? r.body.last_seq : undefined;
    if (kind === 'stale' && Number.isSafeInteger(ls) && ls > item.seq) note(`stale_seq last_seq ${ls} above seq ${item.seq}`);
    if (kind !== 'landed' && !(kind === 'stale' && Number.isSafeInteger(ls) && ls >= item.seq)) return; // held, in the stash
    const i = heldItems.indexOf(item);
    if (i < 0) return;
    heldItems.splice(i, 1);
    stats.held--; // stop() counted it held
    await settled(item);
    changed();
  }

  function holdHead() {
    heldItems.push(queue.shift());
    stats.held++;
  }

  async function pump() {
    if (busy || stopped || timer !== null) return;
    busy = true;
    try {
      while (queue.length && !stopped) {
        const item = queue[0];
        // Stashed before it is sent (a put that failed is counted, the write still goes).
        await item.stashed;
        if (stopped) break;
        const left = timeLeft();
        if (left <= 0) { stop('lost'); break; }
        stats.posts++;
        const r = await post(item, Math.min(timeoutMs, left));
        // Stopped while this write was in flight (the drop): its answer still
        // counts. Landed leaves the stash; a refusal keeps it held, by the
        // same rules. Nothing new is sent (review P2, 79a70fe).
        if (stopped) { await afterStop(item, r); break; }
        stats.lastStatus = r.network ? 0 : r.status;
        const kind = classifySave(r);
        if (kind === 'landed') { await landed(item); changed(); continue; }
        if (kind === 'blip' || kind === 'later' || kind === 'wait') {
          stats.blips++;
          const ra = kind === 'wait' && r.body ? Number(r.body.retry_after_s) : NaN;
          const ms = Number.isFinite(ra) && ra > 0 ? ra * 1000 : RECONNECT_MS;
          if (ms >= timeLeft()) { stop('lost'); break; }
          later(ms);
          break;
        }
        // 1d commit 5 (ruled): stale_seq is judged by the refusal's own
        // last_seq, never by a checkout (one with a race owed ends the lease).
        if (kind === 'stale') {
          const ls = r.body ? r.body.last_seq : undefined;
          if (Number.isSafeInteger(ls) && ls > item.seq) note(`stale_seq last_seq ${ls} above seq ${item.seq}`); // only this seat writes this lease
          if (Number.isSafeInteger(ls) && ls >= item.seq) { await landed(item); changed(); continue; } // landed earlier
          holdHead(); // no last_seq, or a gap below this seq: held, in the stash
          changed();
          continue;
        }
        if (kind === 'nonce') {
          if (item.tries.nonce++ > 0) { holdHead(); changed(); continue; }
          try { await refreshNonce(); } catch { /* the retry names what it has */ }
          continue;
        }
        if (kind === 'stop') { stop(stopReason(r.status)); break; }
        holdHead(); // 'held': this write is refused, it stays in the stash; the next goes on
        changed();
      }
    } finally {
      busy = false;
    }
    changed();
  }

  function stop(why) {
    if (stopped) return;
    stopped = why;
    if (timer !== null) { clearTimer(timer); timer = null; }
    stats.held += queue.length;
    heldItems.push(...queue.splice(0)); // every write left stays in the stash
    changed();
  }

  return {
    /** Queue one card write (an ArrayBuffer or bytes): its seq. Stashed first, then sent, in order. */
    write(bytes) {
      const item = { seq: next++, b64: toB64(bytes), stashed: null, kept: false, tries: { nonce: 0 } };
      loose.add(item);
      item.stashed = keep(item);
      if (stopped) { heldItems.push(item); stats.held++; changed(); return item.seq; }
      queue.push(item);
      changed();
      pump();
      return item.seq;
    },
    /** Wait until the queue is empty or stopped, at most ms: { left } writes not landed yet. */
    drain(ms) {
      if (queue.length === 0 || stopped) return Promise.resolve({ left: queue.length });
      return new Promise((resolve) => {
        let t = null;
        const w = () => { clearTimer(t); resolve({ left: queue.length }); };
        waiters.push(w);
        t = setTimer(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); resolve({ left: queue.length }); }, ms);
      });
    },
    state,
    stats: () => ({ ...stats }),
    unstashed: () => loose.size,
    /** Stop for good (why: 'ended' when the lease has ended, the default 'stopped'). */
    stop: (why = 'stopped') => stop(why),
  };
}
