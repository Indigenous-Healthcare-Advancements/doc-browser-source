// room-stash.js: the room seat's card stash in IndexedDB (M3 step 1d commit
// 3, docs/seat-1d-plan.md section 3). A card write the page could not save
// is kept here until it lands: through host-stable while the lease lives
// (the writer queue), or afterwards through A1's late save route (kept for
// an operator, never written to the stable).
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// One store per origin (/room-seat and /rooms are both doc-arcade's origin).
// An entry is exactly { lease_id, seq, horse_id, release, edition, card_b64,
// at, member_hash }, keyed by (lease_id, seq). Never a room token, a ticket,
// a Clerk token or the raw member id: put() copies only those fields.
// member_hash is SHA-256 of "doc-room-stash-v1:" + member id (memberHash): a
// page posts only entries whose hash is the signed-in member's (the route's
// own member check is the real enforcement).
// Supersede: once a seq of a lease lands, it and every lower seq of that
// lease are deleted (landed). Only the newest card of a lease is ever posted
// late (pending). Entries older than STASH_LIFETIME_MS are deleted on any
// visit, whoever is signed in (sweep).

export const STASH_DB = 'doc-room-stash';
export const STASH_STORE = 'cards';
export const STASH_VERSION = 1;
export const MEMBER_HASH_PREFIX = 'doc-room-stash-v1:';
// 7 days: a weekly player's next visit and a weekend, while the lease and its
// rows are still recent for the operator's restore. A1's late save route
// accepts this plus its margin.
export const STASH_LIFETIME_MS = 7 * 24 * 3600 * 1000;
// A room card is 207 bytes (276 base64 characters); the room's late save
// keep bounds what it decodes at 400 characters. Anything longer is refused.
export const CARD_B64_MAX = 400;
// An entry may be dated at most this far ahead of the page's clock.
export const FUTURE_MARGIN_MS = 60000;
// Every stash operation settles within this (an open blocked by another
// tab, a store that never answers).
export const STASH_OP_MS = 5000;

const LEASE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const FIELDS = Object.freeze(['lease_id', 'seq', 'horse_id', 'release', 'edition', 'card_b64', 'at', 'member_hash']);

/** The member's stash hash: lower case hex SHA-256 of the prefix and the id. */
export async function memberHash(subtle, memberId) {
  if (typeof memberId !== 'string' || memberId.length === 0) throw new Error('member id required');
  const d = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(MEMBER_HASH_PREFIX + memberId)));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

// The editions each release's stash entry may name.
const RELEASE_EDITIONS = Object.freeze({ revc: Object.freeze(['A', 'B']), doc99: Object.freeze(['J99']) });

/**
 * An entry, checked and copied (only its own fields), or null. `now` bounds
 * `at`: an entry dated more than FUTURE_MARGIN_MS ahead is refused (it would
 * never expire).
 */
export function stashEntry(x, now = Date.now()) {
  if (!x || typeof x !== 'object') return null;
  const e = {};
  for (const k of FIELDS) e[k] = x[k];
  if (typeof e.lease_id !== 'string' || !LEASE_RE.test(e.lease_id)) return null;
  if (!Number.isSafeInteger(e.seq) || e.seq < 1) return null;
  if (typeof e.horse_id !== 'string' || !LEASE_RE.test(e.horse_id)) return null;
  const eds = Object.prototype.hasOwnProperty.call(RELEASE_EDITIONS, e.release) ? RELEASE_EDITIONS[e.release] : null;
  if (!eds || !eds.includes(e.edition)) return null;
  if (typeof e.card_b64 !== 'string' || e.card_b64.length === 0 || e.card_b64.length > CARD_B64_MAX || !B64.test(e.card_b64)) return null;
  if (!Number.isFinite(e.at) || e.at <= 0 || e.at > now + FUTURE_MARGIN_MS) return null;
  if (typeof e.member_hash !== 'string' || !HEX64.test(e.member_hash)) return null;
  return e;
}

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error || new Error('indexeddb request failed'));
});
// A write is durable only once its transaction completes: a request's own
// success is not enough (the transaction can still abort).
const finished = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error || new Error('indexeddb transaction failed'));
  tx.onabort = () => reject(tx.error || new Error('indexeddb transaction aborted'));
});

/**
 * Open the stash. Every method returns a promise that settles within
 * limitMs: it resolves, or rejects (no indexedDB, an open that throws, fails,
 * is blocked by another tab or never answers, a failed or aborted
 * transaction). Nothing hangs.
 *   put(entry)            keep an entry (false if it is not a valid entry)
 *   landed(lease_id, seq) that seq landed: delete it and every lower seq of the lease
 *   pending(member_hash)  the newest live entry of each of that member's leases
 *   sweep()               delete every entry older than the lifetime, any member: the count
 *   has(member_hash)      whether that member has a live entry
 * opts: now, keyRange (IDBKeyRange), setTimer, clearTimer, limitMs.
 */
export async function openStash(idb, {
  now = () => Date.now(), keyRange = globalThis.IDBKeyRange,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t), limitMs = STASH_OP_MS,
} = {}) {
  const limit = (p, what) => new Promise((resolve, reject) => {
    const t = setTimer(() => reject(new Error(`stash ${what}: no answer`)), limitMs);
    p.then((v) => { clearTimer(t); resolve(v); }, (err) => { clearTimer(t); reject(err); });
  });
  if (!idb || typeof idb.open !== 'function') throw new Error('stash: no indexedDB');
  if (!keyRange || typeof keyRange.bound !== 'function') throw new Error('stash: no IDBKeyRange');
  // An open that lost to the limit or to onblocked but succeeds later is
  // closed at once (late), never left open.
  let late = false;
  let db;
  try {
    db = await limit(new Promise((resolve, reject) => {
      let open;
      try { open = idb.open(STASH_DB, STASH_VERSION); } catch (err) { reject(err); return; }
      open.onupgradeneeded = () => {
        try {
          const d = open.result;
          if (!d.objectStoreNames.contains(STASH_STORE)) d.createObjectStore(STASH_STORE, { keyPath: ['lease_id', 'seq'] });
        } catch (err) { reject(err); }
      };
      open.onblocked = () => reject(new Error('stash: open blocked'));
      open.onsuccess = () => { if (late) { try { open.result.close(); } catch { /* closed */ } return; } resolve(open.result); };
      open.onerror = () => reject(open.error || new Error('stash: open failed'));
    }), 'open');
  } catch (err) { late = true; throw err; }
  // Every operation: its own transaction, settled within limitMs; a throw
  // while it starts (a closed database) is a rejection too.
  const op = (what, fn) => limit(new Promise((resolve, reject) => { try { fn().then(resolve, reject); } catch (err) { reject(err); } }), what);
  const all = () => done(db.transaction(STASH_STORE, 'readonly').objectStore(STASH_STORE).getAll());
  const live = (e, t) => e.at > t - STASH_LIFETIME_MS;
  return {
    put(x) {
      return op('put', async () => {
        const e = stashEntry(x, now());
        if (!e) return false;
        const tx = db.transaction(STASH_STORE, 'readwrite');
        tx.objectStore(STASH_STORE).put(e);
        await finished(tx); // durable once the transaction completes
        return true;
      });
    },
    // One readwrite transaction: the key range [lease, 0] to [lease, seq].
    landed(leaseId, seq) {
      return op('landed', async () => {
        const tx = db.transaction(STASH_STORE, 'readwrite');
        tx.objectStore(STASH_STORE).delete(keyRange.bound([leaseId, 0], [leaseId, seq]));
        await finished(tx);
      });
    },
    pending(hash) {
      return op('pending', async () => {
        const t = now();
        const best = new Map();
        for (const e of await all()) {
          if (e.member_hash !== hash || !live(e, t)) continue;
          const b = best.get(e.lease_id);
          if (!b || e.seq > b.seq) best.set(e.lease_id, e);
        }
        return [...best.values()].sort((a, b) => a.at - b.at);
      });
    },
    // One readwrite transaction: read, then delete the expired entries in
    // the read's own success (no await in between, the transaction stays live).
    sweep() {
      return op('sweep', async () => {
        const t = now();
        const tx = db.transaction(STASH_STORE, 'readwrite');
        const st = tx.objectStore(STASH_STORE);
        let n = 0;
        const r = st.getAll();
        r.onsuccess = () => { for (const e of r.result) if (!live(e, t)) { st.delete([e.lease_id, e.seq]); n++; } };
        await finished(tx);
        return n;
      });
    },
    has(hash) {
      return op('has', async () => { const t = now(); return (await all()).some((e) => e.member_hash === hash && live(e, t)); });
    },
    close() { try { db.close(); } catch { /* closed */ } },
  };
}
