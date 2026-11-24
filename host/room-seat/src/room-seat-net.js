// room-seat-net.js: the room seat's calls for a HORSE CHANGE (room-seat-swap.js; doc-arcade
// docs/rooms/seat-horse-switch.md), and the GIVE-BACK of a hand-off the page refused (giveBackRefusedSeat, at the
// end). Two destinations and no other:
//   the lobby        POST /api/room/lease (same origin, X-Cabinet-Token: the hand-off's room_token), for the two
//                    actions of a change only: "horses" (the chooser's list) and "swap" (the change)
//   the room server  POST <room_server_url>/hold, /release-hold and /rebind, each with { reservation } (rebind also
//                    the seat ticket the swap answered with). room_server_url is the hand-off's, which the page
//                    checked against its own meta before it took the hand-off (room-seat-handoff.js). No cookie and
//                    no token go to the room server: the reservation names the seat and the ticket is the proof.
// Every call answers { status, body } or { network: true } (no answer, or its timeout); nothing here retries,
// decides or stores anything, and no card bytes pass through.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later

import { LEASE_API } from './seat-lease.js';

export const CALL_TIMEOUT_MS = 15000;
export const LOBBY_ACTIONS = Object.freeze(['horses', 'swap']);
export const ROOM_PATHS = Object.freeze(['hold', 'release-hold', 'rebind']);

// The one sender of this file, made for a fetch and its timers: one POST of a JSON body, raced against its own
// timeout. { status, body } or { network: true }.
function poster({ fetchImpl, setTimer, clearTimer, timeoutMs }) {
  return async function post(url, body, init) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    let t = null;
    const timeout = new Promise((res) => { t = setTimer(() => { try { if (ctl) ctl.abort(); } catch { /* gone */ } res({ network: true, timeout: true }); }, timeoutMs); });
    const call = (async () => {
      let res;
      try {
        res = await fetchImpl(url, { method: 'POST', body: JSON.stringify(body), cache: 'no-store', ...init, ...(ctl ? { signal: ctl.signal } : {}) });
      } catch { return { network: true }; }
      let json = {};
      try { json = await res.json(); } catch { json = {}; }
      return { status: res.status, body: json && typeof json === 'object' && !Array.isArray(json) ? json : {} };
    })();
    const r = await Promise.race([call, timeout]);
    clearTimer(t);
    return r;
  };
}

export function createSeatCalls({
  handoff,
  fetchImpl = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t),
  timeoutMs = CALL_TIMEOUT_MS,
} = {}) {
  if (!handoff || typeof handoff.room_token !== 'string' || typeof handoff.room_server_url !== 'string' || !handoff.room_server_url.startsWith('https://') || typeof handoff.reservation !== 'string') throw new Error('no room seat hand-off');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
  const base = handoff.room_server_url.replace(/\/+$/, '');
  const post = poster({ fetchImpl, setTimer, clearTimer, timeoutMs });

  return {
    /** The lobby: { action: 'horses' | 'swap', lease_id, ... } on the lease route, with the room token. */
    lobby(body) {
      if (!body || !LOBBY_ACTIONS.includes(body.action)) throw new Error('not a horse change action');
      return post(LEASE_API, body, { headers: { 'content-type': 'application/json', 'x-cabinet-token': handoff.room_token }, credentials: 'same-origin' });
    },
    /** The room server: hold, release-hold or rebind for this seat's reservation. */
    room(path, extra = {}) {
      if (!ROOM_PATHS.includes(path)) throw new Error('not a horse change call');
      return post(`${base}/${path}`, { ...extra, reservation: handoff.reservation }, { headers: { 'content-type': 'application/json' }, mode: 'cors', credentials: 'omit' });
    },
  };
}

/**
 * THE GIVE-BACK OF A REFUSED HAND-OFF (room-seat-handoff.js refusedGiveBack; the test of 2026-11-24). The lobby had
 * reserved the place and opened the lease before it handed off; a seat page that refuses the entry gives both back
 * before it goes, exactly as the lobby gives up a join that is cancelled:
 *   the room server  POST <roomServerUrl>/leave { reservation }, as text/plain (a CORS simple request: no preflight,
 *                    so it is on its way before the page leaves), no cookie and no token
 *   the lobby        POST /api/room/lease { action: "close", lease_id } with the room token: a lease closed before
 *                    its checkout starts no seat cooldown and owes no race (the lobby's own rule for a seat that
 *                    never started). Left out when the entry's token or lease id was not readable.
 * Both keepalive, so they outlive the way back; nothing is retried and nothing is read from the answers but their
 * status. g: what refusedGiveBack returned (roomServerUrl is the page's own meta, never the entry's word alone).
 * Resolves to the answers, in that order; never throws.
 */
export function giveBackRefusedSeat(g, {
  fetchImpl = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t),
  timeoutMs = CALL_TIMEOUT_MS,
} = {}) {
  if (!g || typeof fetchImpl !== 'function' || typeof g.roomServerUrl !== 'string' || !g.roomServerUrl.startsWith('https://') || typeof g.reservation !== 'string') return Promise.resolve([]);
  const post = poster({ fetchImpl, setTimer, clearTimer, timeoutMs });
  const jobs = [post(`${g.roomServerUrl.replace(/\/+$/, '')}/leave`, { reservation: g.reservation }, { keepalive: true, headers: { 'content-type': 'text/plain;charset=UTF-8' }, mode: 'cors', credentials: 'omit' })];
  if (typeof g.roomToken === 'string' && typeof g.leaseId === 'string') {
    jobs.push(post(LEASE_API, { action: 'close', lease_id: g.leaseId }, { keepalive: true, headers: { 'content-type': 'application/json', 'x-cabinet-token': g.roomToken }, credentials: 'same-origin' }));
  }
  return Promise.all(jobs).catch(() => []);
}
