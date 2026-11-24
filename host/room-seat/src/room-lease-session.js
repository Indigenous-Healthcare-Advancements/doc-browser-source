// room-lease-session.js: the leases of ONE room seat visit, in sequence (the owner's decision of 2026-11-23: a player
// holds the seat, horses come and go; doc-arcade docs/rooms/seat-horse-switch.md). Pure bookkeeping: the page
// (mp-seat.js) makes the lease clients and the save queues; this says which one a card write belongs to.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// A SESSION is one lease: its view of the hand-off (the same room, token and reservation; its own lease id, horse
// id and horse name), its lease client (seat-lease.js), its checkout, and its save queue (room-save-queue.js). A
// visit that never changes horses has exactly one, made from the hand-off as it is: nothing differs from before.
//
// CARD GENERATIONS. The board says which card a write is of: every card write after a card-swap carries the gen the
// page gave that swap (lb-board-worker.js); a write with no gen is of the card the board booted with (gen 0). Each
// generation belongs to one session (bind), or to NONE (an empty reader that no lease owns yet). So:
//   a write of the current session's generation   joins that session's queue (one queue per lease and generation)
//   a write of a FINISHED session's generation     (a late write: the old card's last change, reported after the
//                                                  change of horses) is given to that session's own queue, which
//                                                  is stopped: it is put in the stash under the OLD lease and never
//                                                  posted; the lobby's late save poster takes it from there
//   a write of a generation no session owns        is kept in memory only (the newest one), for the lease that
//                                                  takes that reader next (a new horse made on an empty reader)
// Nothing here can post a write under another lease: a queue only ever posts with its own view's lease id.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The hand-off as ONE lease reads it: everything of the base (the room, the token, the reservation, the clock skew,
 * the relay servers as they are refreshed) with this lease's own ids and name. A horse with a card never carries
 * new_horse, whatever the base says. null when the lobby's reply does not name a lease and a horse.
 */
export function leaseView(base, { lease_id, horse_id, horse_name = '', new_horse = false, heartbeat_s, expires_at, issued_at } = {}) {
  if (!base || typeof lease_id !== 'string' || !UUID.test(lease_id) || typeof horse_id !== 'string' || !UUID.test(horse_id)) return null;
  const v = Object.create(base);
  v.lease_id = lease_id;
  v.horse_id = horse_id;
  v.horse_name = new_horse ? '' : String(horse_name || '');
  v.new_horse = new_horse === true ? true : undefined;
  if (typeof heartbeat_s === 'number' && heartbeat_s >= 5 && heartbeat_s <= 60) v.heartbeat_s = heartbeat_s;
  if (typeof expires_at === 'string' && expires_at) v.lease_expires_at = expires_at;
  // The lease was opened (and so last renewed) when the lobby answered: the beat's give-up counts from here.
  v.issued_at = Number.isFinite(issued_at) ? issued_at : base.issued_at;
  return v;
}

/** A generation no lease owns (an empty reader between two horses). */
export const NO_SESSION = Object.freeze({ none: true });

export function createLeaseSessions({ onNote = () => {} } = {}) {
  const list = [];
  const byGen = new Map(); // gen -> session | NO_SESSION
  let current = null;
  let loose = null; // { gen, bytes }: the newest write of a generation no session owns
  const note = (t) => { try { onNote(t); } catch { /* the page's */ } };
  const copy = (bytes) => new Uint8Array(bytes instanceof ArrayBuffer ? bytes.slice(0) : new Uint8Array(bytes));

  return {
    /** A new session, made current. gen: the card generation its writes carry (0: the boot card), or null for none yet. */
    add({ view, lease, name = '', gen = null }) {
      const s = { n: list.length, view, lease, name, queue: null, newHorse: false, state: 'open', gen: null, card: null, writes: 0, late: 0 };
      list.push(s);
      current = s;
      if (gen !== null) { byGen.set(gen, s); s.gen = gen; }
      return s;
    },
    current: () => current,
    all: () => list.slice(),
    /** The sessions before the current one (their leases have ended; their queues take nothing new to post). */
    finished: () => list.filter((s) => s.state === 'finished'),
    /** Whose generation is this: a session, NO_SESSION, or null (never bound). */
    owner: (gen) => (byGen.has(gen) ? byGen.get(gen) : null),
    /** Give a generation to a session (the reader now holds that lease's card), or to none (owner null). */
    bind(gen, owner) {
      byGen.set(gen, owner || NO_SESSION);
      if (owner && owner !== NO_SESSION) owner.gen = gen;
    },
    /** The session is over: its lease is beaten no more and its queue posts nothing more (a later write is stashed). */
    finish(s) {
      if (!s || s.state === 'finished') return;
      s.state = 'finished';
      try { if (s.lease) s.lease.stop(); } catch { /* ended */ }
      try { if (s.queue) s.queue.stop('ended'); } catch { /* stopped */ }
    },
    /**
     * One card write of generation gen. Returns
     *   { session, seq, late: false }   it joined its lease's queue (the current session's)
     *   { session, seq, late: true }    a finished lease's: stashed under that lease by its stopped queue, never posted
     *   { loose: true }                 no lease owns that reader: kept here (takeLoose)
     *   { dropped: true }               nothing could take it (no queue yet, or an unknown generation): noted
     */
    write(gen, bytes) {
      const g = gen === undefined || gen === null ? 0 : gen;
      const o = byGen.has(g) ? byGen.get(g) : null;
      if (o === NO_SESSION) { loose = { gen: g, bytes: copy(bytes) }; return { loose: true }; }
      if (!o) { note(`card write of an unknown card (gen ${String(g).slice(0, 12)})`); return { dropped: true }; }
      if (!o.queue) { note('card write before checkout'); return { dropped: true }; }
      const late = o.state === 'finished';
      // A finished session's queue is stopped: write() stashes the bytes under ITS lease and holds them.
      if (late) { o.late++; try { if (!o.queue.state().stopped) o.queue.stop('ended'); } catch { /* stopped */ } }
      else o.card = copy(bytes);
      o.writes++;
      return { session: o, seq: o.queue.write(bytes), late };
    },
    /** The newest write of a reader no lease owned, taken once (for the lease that now takes that reader). */
    takeLoose() { const l = loose; loose = null; return l; },
    hasLoose: () => loose !== null,
    /** Writes not landed on finished leases (queued never; held, in the stash or not). */
    oldOwed() { let n = 0; for (const s of list) if (s.state === 'finished' && s.queue) { const q = s.queue.state(); n += q.pending + q.held; } return n; },
    /** Writes of ANY lease that are neither landed nor kept in the stash: what a closed tab would lose. */
    unstashed() { let n = 0; for (const s of list) if (s.queue) n += s.queue.unstashed(); return n; },
  };
}
