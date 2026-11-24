// room-seat-handoff.js: the hand-off from doc-arcade's /rooms to the room
// seat page (M3 step 1b, docs/seat-contract.md). A port of doc-arcade's
// src/lib/roomSeatHandoff.ts (branch claude/m3-rooms-a2, a48ca16): the same
// key, version, age limit, field shapes and checks. Change nothing here
// without changing it there (the version is `v`). No network, no card bytes.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The contract, as the header of roomSeatHandoff.ts states it:
// - /rooms writes ONE entry under ROOM_SEAT_HANDOFF_KEY in sessionStorage and
//   navigates to /room-seat in the same tab. Nothing in it is in the URL.
// - The seat page takes the entry ONCE at start-up and REMOVES it in the same
//   step (takeRoomSeatHandoff), so the room token and the tickets never sit
//   in storage while the seat runs, and a reload cannot reuse them.
// - A reload sets the one-shot ROOM_SEAT_REPLACE_KEY flag (the time it was
//   set) and goes back to return_path with no query (markRoomSeatReplace).
// - An entry is refused when it is malformed, of another version, older than
//   one lease length, or past its room ticket's expiry. The page's metas
//   (doc-room-server-url, doc-room-signal-host, injected by doc-arcade's
//   app/room-seat route) are the `expect`: an entry naming any other room
//   server is refused.
// - CLOCKS. room_ticket_exp is in THIS BROWSER's clock (the ticket's own exp
//   less clock_skew_ms): compare it with Date.now() as it is. ice_expires_at
//   (and every other ISO time a server sends, such as closing_until) is the
//   servers' clock: compare it with Date.now() + clock_skew_ms (serverNow).
// - A REFUSED ENTRY'S PLACE IS GIVEN BACK (the test of 2026-11-24: the lobby had already reserved the seat and opened
//   the lease, the seat page refused the entry and went back at once, and the place stayed reserved for ten
//   minutes). A refusal names what to give back (refusedGiveBack: the reservation, and the lease with its room token
//   when both are readable) when the entry names this page's own room server; the page then leaves the reservation
//   and closes the lease before it goes back (room-seat-net.js giveBackRefusedSeat; a lease closed before its
//   checkout costs nothing). An entry that names another room server, or a page with no metas, is not acted on
//   here: the entry is left as it was under ROOM_SEAT_REFUSED_KEY for the lobby, which wrote it, knows its own room
//   server and frees it on arrival (doc-arcade lib/roomSeatHandoff takeStrandedSeats, which removes it).
// Stricter than roomSeatHandoff.ts in two places (the seat refuses what a2
// would pass; a2 aligns in its 0b round): slot must be 1 to MAX_ROOM_SLOT
// (what the room server hands out), and return_path must be /rooms, the lobby page "/" or under
// /rooms/.

import { isHostName } from './mp-public.js';

export const ROOM_SEAT_HANDOFF_KEY = 'doc.roomSeat';
export const ROOM_SEAT_HANDOFF_VERSION = 1;
export const ROOM_SEAT_PATH = '/room-seat';
export const ROOMS_PATH = '/rooms';
/** The lobby's own page: its browser room card joins a member in place and is the way back from that seat. */
export const LOBBY_PATH = '/';
/**
 * The page's words for the way back, by the hand-off's return_path: "/" is the lobby, anything else (/rooms and
 * under it) the rooms page. going: the line an end says; link: the link's text; say(text): a line written for the
 * rooms page (room-seat-swap.js, room-closing.js) said for this way back. The lobby's own sentences ("the rooms
 * page") are the sender's words and are never changed.
 */
export function wayBackWords(path) {
  const place = path === LOBBY_PATH ? 'the lobby' : 'the rooms';
  const say = (t) => (place === 'the rooms' || typeof t !== 'string' ? t : t.replace(/\b([Gg]o(?:ing)? back to) the rooms\b(?! page)/g, `$1 ${place}`));
  return Object.freeze({ place, going: `Going back to ${place}.`, link: `Back to ${place}`, say });
}
/** The lease length (doc-arcade lib/roomCabinet ROOM_LEASE_S): an entry older than this is useless. */
export const HANDOFF_MAX_AGE_MS = 120_000;
export const ROOM_SEAT_REPLACE_KEY = 'doc.roomSeatReplace';
/** A refused entry this page could not give back itself, left for the lobby to free on arrival (see the header). */
export const ROOM_SEAT_REFUSED_KEY = 'doc.roomSeatRefused';
/** The doc-build meta the room seat route injects (app/room-seat route.ts). */
export const ROOM_SEAT_BUILD = 'room-seat';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKENISH = /^[A-Za-z0-9._-]{8,4096}$/;
// The room tag: 8 hex (mp-room.js, the room id's first 8), so parseInt(tag, 16) >>> 0 keeps it whole.
const HEX_TAG = /^[0-9a-f]{8}$/i;
const MAX_SKEW_MS = 24 * 3600_000;
// The room slots are the satellite seats of lb-cabinet.js cabinetBoards(seats):
// 1..seats (board0, seat 0, is the house master and never a room slot; the
// partner is -1), and mp-room.js opens slots only for seat > 0. SEAT_COUNTS
// is [4, 8], so the largest slot is 8. A literal here: importing
// lb-cabinet.js would widen the seat page's module closure (pinned in
// doc-arcade's sync list); test/room-seat-handoff.test.mjs checks it equals
// the largest of SEAT_COUNTS.
export const MAX_ROOM_SLOT = 8;
/** A room slot the room server can hand out: an integer from 1 to MAX_ROOM_SLOT. */
export const isRoomSlot = (s) => Number.isSafeInteger(s) && s >= 1 && s <= MAX_ROOM_SLOT;

/** A same-origin path: exactly ROOMS_PATH, exactly LOBBY_PATH (the lobby's own page, whose room card seats a member in place), or under ROOMS_PATH + "/" (and no backslash or control anywhere). */
export function safeReturnPath(p) {
  if (typeof p !== 'string' || !p) return false;
  if (p === ROOMS_PATH || p === LOBBY_PATH) return true;
  if (p.length > 512 || !p.startsWith(`${ROOMS_PATH}/`)) return false;
  if (/\/(?:\.|%2e){1,2}(?=[/?#]|$)/i.test(p)) return false; // no dot segment climbs out of /rooms/
  for (const ch of p) { const c = ch.charCodeAt(0); if (c < 32 || c === 127 || ch === '\\') return false; }
  return true;
}

/** The signalling URL for a room tag and slot. host is a bare host name (ROOM_SIGNAL_HOST), never a URL. */
export function seatSignalUrl(host, tag, slot) {
  return `wss://${host}/rooms/signal?role=seat&room=${encodeURIComponent(tag)}&slot=${encodeURIComponent(String(slot))}`;
}

// A signal_url with its host in lower case (hosts are case-insensitive), the
// rest as written; null when it has no wss:// host.
function signalUrlKey(url) {
  const m = /^wss:\/\/([^/?#]+)([/?#][\s\S]*)?$/.exec(url);
  return m ? `wss://${m[1].toLowerCase()}${m[2] || ''}` : null;
}

/** Is this a usable entry right now? Checks every field's shape, the version and both clocks (roomSeatHandoff.ts validRoomSeatHandoff). */
export function validRoomSeatHandoff(h, now = Date.now(), expect) {
  if (!h || typeof h !== 'object') return false;
  const x = h;
  const str = (k) => typeof x[k] === 'string' && x[k].length > 0;
  if (x.v !== ROOM_SEAT_HANDOFF_VERSION) return false;
  if (typeof x.issued_at !== 'number' || !Number.isFinite(x.issued_at)) return false;
  if (now - x.issued_at > HANDOFF_MAX_AGE_MS || x.issued_at - now > 60_000) return false;
  if (typeof x.room_ticket_exp !== 'number' || !(x.room_ticket_exp > now)) return false;
  if (!str('room_token') || !TOKENISH.test(x.room_token)) return false;
  if (!str('room_ticket') || !TOKENISH.test(x.room_ticket)) return false;
  if (!str('lease_id') || !UUID.test(x.lease_id) || !str('horse_id') || !UUID.test(x.horse_id)) return false;
  if (x.release !== 'doc99' && x.release !== 'revc') return false;
  if (!str('cabinet_id') || !str('lease_expires_at') || !str('rom') || typeof x.horse_name !== 'string') return false;
  // A new horse (roomSeatHandoff.ts checklist item 6): new_horse is true or absent, never anything else.
  if (x.new_horse !== undefined && x.new_horse !== true) return false;
  if (!str('room')|| !str('room_tag') || !HEX_TAG.test(x.room_tag) || !str('reservation')) return false;
  if (!isRoomSlot(x.slot)) return false;
  if (!(typeof x.heartbeat_s === 'number' && x.heartbeat_s >= 5 && x.heartbeat_s <= 60)) return false;
  if (!str('signal_url') || !x.signal_url.startsWith('wss://')) return false;
  if (!str('room_server_url') || !x.room_server_url.startsWith('https://')) return false;
  if (expect) {
    if (x.room_server_url !== expect.roomServerUrl) return false;
    // The host compares in lower case (as the meta is kept); the rest exactly.
    if (signalUrlKey(x.signal_url) !== seatSignalUrl(expect.signalHost, x.room_tag, x.slot)) return false;
  }
  if (!safeReturnPath(x.return_path)) return false;
  if (x.ice_servers !== undefined && x.ice_servers !== null && !Array.isArray(x.ice_servers)) return false;
  if (x.turn_s !== undefined && x.turn_s !== null && !(Number.isSafeInteger(x.turn_s) && x.turn_s > 0)) return false;
  if (x.ice_expires_at !== undefined && x.ice_expires_at !== null && !(typeof x.ice_expires_at === 'string' && Number.isFinite(Date.parse(x.ice_expires_at)))) return false;
  if (!(typeof x.clock_skew_ms === 'number' && Number.isFinite(x.clock_skew_ms) && Math.abs(x.clock_skew_ms) <= MAX_SKEW_MS)) return false;
  return true;
}

/**
 * A NEW HORSE's seat (the pilot stable; roomSeatHandoff.ts checklist item 6): the entry carries new_horse: true, its
 * horse_id is the id the lobby made for the horse, and its horse_name is "" (the horse has no name yet). There is no
 * card to load: the seat starts the game with an empty card slot and the member makes the horse in the game. An entry
 * without new_horse is a horse with a card, exactly as before.
 */
export const isNewHorse = (h) => !!h && h.new_horse === true;
/** What the page calls a horse that has no name yet (never the empty name). */
export const NEW_HORSE_LABEL = 'New horse';
/**
 * The horse's name for the page: `name` (the name the lobby read from the saved card) when it has one, else the
 * hand-off's, else NEW_HORSE_LABEL. Never an empty string, and no control characters.
 */
export function horseLabel(h, name = null) {
  const clean = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) : '');
  return clean(name) || clean(h && h.horse_name) || NEW_HORSE_LABEL;
}

const session = () => { try { return globalThis.sessionStorage || null; } catch { return null; } };

// A room server reservation (manager.mjs RID): what /leave takes.
const RESERVATION = /^[0-9a-f]{32}$/;
const REFUSED_MAX_CHARS = 16384;
/**
 * What a REFUSED entry lets this page give back, or null. Only for an entry that names this page's own room server
 * (expect, from the metas): { roomServerUrl, reservation, roomToken, leaseId }. roomToken and leaseId are both null
 * when either is unreadable (the lease then runs out by itself, 120 s after its last beat).
 */
export function refusedGiveBack(h, expect) {
  if (!h || typeof h !== 'object' || !expect || typeof expect.roomServerUrl !== 'string' || !expect.roomServerUrl.startsWith('https://')) return null;
  if (h.room_server_url !== expect.roomServerUrl) return null;
  if (typeof h.reservation !== 'string' || !RESERVATION.test(h.reservation)) return null;
  const lease = typeof h.room_token === 'string' && TOKENISH.test(h.room_token) && typeof h.lease_id === 'string' && UUID.test(h.lease_id);
  return { roomServerUrl: expect.roomServerUrl, reservation: h.reservation, roomToken: lease ? h.room_token : null, leaseId: lease ? h.lease_id : null };
}

/**
 * Read the hand-off and remove it at once (roomSeatHandoff.ts
 * takeRoomSeatHandoff). Returns
 *   { status: 'ok', handoff, returnPath }       a usable entry
 *   { status: 'invalid', handoff: null, returnPath, giveBack, stashed }   an entry, refused. giveBack: what the
 *       page gives back before it goes (refusedGiveBack), or null; stashed: the entry was left for the lobby under
 *       ROOM_SEAT_REFUSED_KEY instead (it names a reservation, and this page may not act on it)
 *   { status: 'none', handoff: null, returnPath }      no entry (or no storage)
 * returnPath is the entry's own return_path when it is a safe same-origin
 * path, else ROOMS_PATH. expect is required here: a seat page without its
 * room server metas refuses every entry.
 */
export function takeRoomSeatHandoff({ storage = session(), now = Date.now(), expect = null } = {}) {
  const none = { status: 'none', handoff: null, returnPath: ROOMS_PATH };
  if (!storage) return none;
  let raw = null;
  try { raw = storage.getItem(ROOM_SEAT_HANDOFF_KEY); } catch { return none; }
  try { storage.removeItem(ROOM_SEAT_HANDOFF_KEY); } catch { /* storage off: nothing stored */ }
  if (!raw) return none;
  let h = null;
  try { h = JSON.parse(raw); } catch { h = null; }
  const back = h && typeof h === 'object' && safeReturnPath(h.return_path) ? h.return_path : ROOMS_PATH;
  if (!expect || !expect.roomServerUrl || !expect.signalHost || !validRoomSeatHandoff(h, now, expect)) {
    const giveBack = refusedGiveBack(h, expect);
    let stashed = false;
    if (!giveBack && h && typeof h === 'object' && typeof h.reservation === 'string' && RESERVATION.test(h.reservation) && raw.length <= REFUSED_MAX_CHARS) {
      try { storage.setItem(ROOM_SEAT_REFUSED_KEY, raw); stashed = true; } catch { /* storage off: the place runs out by itself */ }
    }
    return { status: 'invalid', handoff: null, returnPath: back, giveBack, stashed };
  }
  return { status: 'ok', handoff: h, returnPath: h.return_path };
}

/** The seat page, on its own reload, before it goes back to return_path. false when storage is off. */
export function markRoomSeatReplace(now = Date.now(), storage = session()) {
  if (!storage) return false;
  try { storage.setItem(ROOM_SEAT_REPLACE_KEY, String(now)); return true; } catch { return false; }
}

/** The servers' clock now: this browser's clock plus the skew /rooms measured (CLOCKS). */
export const serverNow = (h, now = Date.now()) => now + (h && Number.isFinite(h.clock_skew_ms) ? h.clock_skew_ms : 0);

/**
 * The ICE servers for the seat's peer link: the hand-off's list when it has
 * one and its relay has not run out (ice_expires_at, the servers' clock,
 * against serverNow), else none (the page's own default). A refresh before
 * then is step 1e.
 */
export function handoffIceServers(h, now = Date.now()) {
  if (!h || !Array.isArray(h.ice_servers) || !h.ice_servers.length) return [];
  if (typeof h.ice_expires_at === 'string') {
    const t = Date.parse(h.ice_expires_at);
    if (Number.isFinite(t) && t <= serverNow(h, now)) return [];
  }
  return h.ice_servers;
}

/**
 * ICE servers for the main view (room-main-view.js): the hand-off's relay hosts as plain STUN (no credentials, so
 * they never run out) and, while its credentials live, the relay itself. With them the viewer names its public
 * address in the WHEP offer. No relay in the hand-off: an empty list, as before.
 */
export function mainViewIceServers(h, now = Date.now()) {
  const stun = [];
  for (const s of (h && Array.isArray(h.ice_servers) ? h.ice_servers : [])) {
    for (const u of (Array.isArray(s && s.urls) ? s.urls : [s && s.urls])) {
      const m = /^turns?:([a-z0-9.-]+)(?::(\d{1,5}))?(?:\?|$)/i.exec(String(u || ''));
      if (!m) continue;
      const x = `stun:${m[1].toLowerCase()}:${m[2] || 3478}`;
      if (!stun.includes(x)) stun.push(x);
    }
  }
  return [...(stun.length ? [{ urls: stun }] : []), ...handoffIceServers(h, now)];
}

/**
 * The waiting card over the player's own screen, from the moment the seat page opens until the station is the
 * player's: a title, a line saying what is happening, and which of the four steps this is (1 to 4). Null: no card
 * (the game is on the screen and the station is the player's, or the seat has ended and the page's own message says
 * why).
 *   phase: the seat's phase (mp-seat.js state.phase); linkOpen: the link to the room is up; warm: the room runs the
 *   warm join (the game starts at once and the station is handed over later; mp-room.js warm=1) and has not handed
 *   the station over yet; waitedS: seconds in this step; mainOn: the main screen is showing above.
 * Cold (no warm join): connect, wait for the race, start the game, join. Warm: connect, start the game, join, wait
 * for the race.
 */
export function seatWaitCard({ phase, linkOpen = false, warm = false, waitedS = 0, mainOn = false } = {}) {
  const long = waitedS >= 150;
  const watch = mainOn ? ' You can watch it on the main screen above.' : '';
  const race = { title: 'You are in. Waiting for the race in progress to finish',
    text: `You take your seat between races, so the wait depends on the race now running: up to about two minutes.${watch}${long ? ' Still waiting: the room has not reached the lobby yet.' : ''}` };
  if (phase === 'connecting' && !linkOpen) return { step: 1, title: 'Connecting to your room', text: long ? 'This is taking longer than it should. You can keep waiting, or leave and try again.' : 'Finding your seat.' };
  if (phase === 'connecting') return warm ? { step: 1, title: 'Connecting to your room', text: 'Finding your seat.' } : { step: 2, ...race };
  if (phase === 'welcomed' || phase === 'booting') return { step: warm ? 2 : 3, title: 'Starting the game on your device', text: long ? 'This is taking longer than it should on this device.' : 'This takes a few seconds.' };
  if (phase === 'linking') return { step: warm ? 3 : 4, title: 'Joining the cabinet', text: warm ? 'About twenty seconds.' : 'Your screen comes up in a moment. You can enter the next race from the lobby.' };
  if (phase === 'seated' && warm) return { step: 4, ...race };
  return null;
}

/** The metas the room seat route injects (doc-arcade app/room-seat route.ts). */
export function seatMetas(doc = globalThis.document) {
  const read = (name) => {
    const m = doc && typeof doc.querySelector === 'function' ? doc.querySelector(`meta[name="${name}"]`) : null;
    return m && typeof m.content === 'string' ? m.content : null;
  };
  const roomServerUrl = read('doc-room-server-url');
  // A bare DNS name only: anything else leaves no expect, so every entry is
  // refused at the take (and the public policy is never built on a bad host).
  const host = read('doc-room-signal-host');
  const lower = host ? host.toLowerCase() : '';
  const signalHost = lower && isHostName(lower) ? lower : null; // kept as validated, lower case
  const roomSeat = read('doc-build') === ROOM_SEAT_BUILD;
  // expect only with the room seat build: a page without it has no expect,
  // so a hand-off is refused there even if the other metas are present.
  return {
    build: read('doc-build'),
    roomSeat,
    expect: roomSeat && roomServerUrl && signalHost ? { roomServerUrl, signalHost } : null,
  };
}

/** This page load is a reload (the Navigation Timing entry's type). */
export function isReload(perf = globalThis.performance) {
  try {
    const e = perf && typeof perf.getEntriesByType === 'function' ? perf.getEntriesByType('navigation')[0] : null;
    return !!e && e.type === 'reload';
  } catch { return false; }
}

/**
 * The room seat page's intake, once at start-up: take the entry (removed in
 * the same step). A usable entry: { go: null, handoff }. Anything else:
 * { go: <path> }, the page goes there at once and starts nothing (a refused
 * entry's place is given back first: giveBack, see takeRoomSeatHandoff); with no
 * entry on a reload of the page, the replace flag is set first so /rooms
 * provisions with { replace: true }. The seat no longer holds return_path
 * after its own reload (the entry is gone), so that way back is ROOMS_PATH.
 */
export function roomSeatIntake({ storage = session(), now = Date.now(), expect = null, reload = false } = {}) {
  const t = takeRoomSeatHandoff({ storage, now, expect });
  if (t.status === 'ok') return { go: null, handoff: t.handoff, status: 'ok' };
  if (t.status === 'none' && reload) markRoomSeatReplace(now, storage);
  return { go: t.returnPath, handoff: null, status: t.status, replace: t.status === 'none' && reload, giveBack: t.giveBack ?? null };
}
