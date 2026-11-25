// room-closing.js: DOC '99 rooms, L2 lease closing (doc-arcade
// docs/rooms/jp-close-grace.md, revision 9, on claude/m3-rooms-l2). What a
// lease reply says about closing, which clock applies, and when a seat must
// be ejected so its eject save lands before closing_until. Pure and
// browser-safe: the room server (tools/room-server/manager.mjs) uses it for
// its race, result and seat_ip replies, and a seat's lease client can use it
// for its heartbeat reply (same shape).
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The reply shapes (section 5, section 8, and the lease route):
//   200 { ok: true, closing: true, closing_until, race_nonce, ... }     a heartbeat on a closing lease (never extended)
//   200 { ok: true, closing: true, do_not_enter: true, ... }            a race_enter while closing (recorded while_closing)
//   200 { ok: true, closing: true, closing_until, closing_reason }      seat_ip at the household cap ('ip_cap')
//   200 { ok: true, closing: true, closing_until, closing_reason, already: true }   a retried seat_ip
//   409 { ok: false, error: 'closing', closing_until }                  a lease already in closing (seat_ip at the cap, race_enter, checkout)
//   200 { ok: true, closing: true, closing_until }                      a double close
// And the cap signal, closing or not (section 3): eject_after_race: true on
// the race_enter reply and the heartbeat reply.

// G and H (section 5, the proposed policy values). closing_until from the
// reply is the only clock (section 5, "closing_until is the only clock"); these
// are used only when a reply names no closing_until.
export const CLOSE_GRACE_S = 30;
export const INSERTED_HOLD_S = 600;
// The eject save (section 4), on DOC '99: "0. Read the slot. ... 1. Otherwise,
// press CARD and poll the slot every 0.5 s, for up to 10 s. ... 3. Before
// posting, persist the ejected bytes ... 4. Post the room write ... 5. Then
// close." Its time budget, from the doc's numbers and the seat's own steps:
export const CARD_POLL_MS = 500; // "poll the slot every 0.5 s"
export const CARD_POLL_TIMEOUT_MS = 10000; // "for up to 10 s"
// One frame: one card_reader::insertCard call, as standalone flycast makes per
// press (libretro calls it on every held frame of JOYPAD_L). Conductor
// ruling; lab run 4 tries a 6-frame hold as its case 2, for comparison only.
export const CARD_PRESS_FRAMES = 1;
export const CARD_FINAL_MS = 12000; // leave(): the board's last card look (its timeout, mp-seat.js)
export const LEAVE_SETTLE_MS = 300; // leave(): the last write reaches the link worker before the close
export const POST_MS = 3000; // the write and the close over the reliable channel, and the room's post
// The seat waits for the board's answer this long: the board's own 10 s poll
// plus a second for the last frame and the message (mp-seat-eject.js).
export const CARD_EJECT_WAIT_MS = CARD_POLL_TIMEOUT_MS + 1000;
// The whole save, on DOC '99 (with the CARD press) and on Rev C (none: the
// card file is present all along and each race has its own save).
export const EJECT_SAVE_MS = CARD_EJECT_WAIT_MS + CARD_FINAL_MS + LEAVE_SETTLE_MS + POST_MS; // 26300
export const REVC_SAVE_MS = CARD_FINAL_MS + LEAVE_SETTLE_MS + POST_MS; // 15300
// The room page lets the seat do the save for at most the whole save, and
// never past closing_until less a margin; the room server asks for the eject
// at least the save plus that margin before closing_until (EJECT_LEAD_MS).
export const DEADLINE_MARGIN_MS = 3000;
export const EJECT_GRACE_MAX_MS = EJECT_SAVE_MS;
export const EJECT_GRACE_MIN_MS = 2000;
export const EJECT_LEAD_MS = EJECT_SAVE_MS + DEADLINE_MARGIN_MS; // 29300

const HEX64 = /^[0-9a-f]{64}$/;
const at = (v) => {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

// closingFromReply(body, { nowMs, raceRunning }) -> null when the reply does
// not say closing, else
//   { untilMs, atMs, reason, raceNonce, raceRunning, doNotEnter, already, clock }
// clock names where untilMs came from: 'closing_until' (the reply), or the
// section 5 table when the reply names none: 'closing_at + G' (no race
// running) or 'closing_at + H' (a race running: entered, no result). Without
// closing_at the table starts from nowMs.
export function closingFromReply(body, { nowMs = Date.now(), raceRunning = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const closing = body.closing === true || body.error === 'closing' || body.code === 'closing';
  if (!closing) return null;
  const atMs = at(body.closing_at);
  const given = at(body.closing_until);
  const reason = typeof body.closing_reason === 'string' && /^[a-z_]{1,32}$/.test(body.closing_reason) ? body.closing_reason : null;
  const n = typeof body.race_nonce === 'string' ? body.race_nonce.toLowerCase() : '';
  const raceNonce = HEX64.test(n) ? n : null;
  // The heartbeat names the running race's nonce, or null (section 5).
  const running = raceRunning === true || raceNonce !== null;
  let untilMs = given;
  let clock = 'closing_until';
  if (untilMs === null) {
    untilMs = (atMs ?? nowMs) + (running ? INSERTED_HOLD_S : CLOSE_GRACE_S) * 1000;
    clock = running ? 'closing_at + H' : 'closing_at + G';
  }
  return { untilMs, atMs, reason, raceNonce, raceRunning: running, doNotEnter: body.do_not_enter === true, already: body.already === true, clock };
}

// The cap signal (section 3): eject after this race, closing or not.
export const ejectAfterRace = (body) => !!body && typeof body === 'object' && body.eject_after_race === true;

// Two views of one lease's closing. A hint (hint: true, the seat's own
// report, the player's) is weaker than every value from this server's own
// lease call, computed or named: a server value after a hint is taken
// outright, and a hint never replaces a server value. Between two server
// values (or two hints) the newer wins when it names closing_until (the
// server's clock), and a computed deadline never replaces a named one,
// except that a do_not_enter race reply (the race runs; the server holds the
// seat to closing_at + H) never lowers the deadline below its own. Between
// two computed hints the earlier deadline stays (a hint without
// closing_until must not slide on every poll).
export function mergeClosing(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  if (prev.hint && !next.hint) return { ...next, reason: next.reason ?? prev.reason ?? null, atMs: next.atMs ?? prev.atMs ?? null, ejectNow: !!next.ejectNow, hint: false };
  if (next.hint && !prev.hint) return prev;
  const serverNext = next.clock === 'closing_until';
  const serverPrev = prev.clock === 'closing_until';
  let keep = serverPrev && !serverNext ? prev : next;
  if (next.doNotEnter && keep !== next && next.untilMs > keep.untilMs) keep = next;
  if (prev.hint && next.hint && !serverPrev && !serverNext && prev.untilMs <= next.untilMs) keep = prev;
  return { ...keep, reason: keep.reason ?? prev.reason ?? next.reason, atMs: keep.atMs ?? prev.atMs ?? next.atMs, ejectNow: !!(prev.ejectNow || next.ejectNow), hint: !!(prev.hint && next.hint) };
}

// The running race's result arrived while closing (section 5 table, row 3):
// closing_until = least(closing_at + H, now + G), unless the result reply
// itself names closing_until (then that, through mergeClosing).
export function afterResult(c, nowMs) {
  if (!c) return c;
  const hold = c.atMs !== null && c.atMs !== undefined ? c.atMs + INSERTED_HOLD_S * 1000 : c.untilMs;
  return { ...c, untilMs: Math.min(hold, nowMs + CLOSE_GRACE_S * 1000), raceRunning: false, clock: c.clock === 'closing_until' ? 'least(closing_at + H, result + G)' : c.clock };
}

// When the seat must be ejected. The card cannot come out while a race runs
// (JP ignores CARD then, section 1), so with a race running the eject waits
// for its result, or until closing_until less the eject lead, whichever is
// first; with none it is now. ejectNow (L1's closed: the lease is closed
// already, nothing waits for a save) is at once.
export function ejectDue(c, { raceRunning, nowMs }) {
  if (!c) return false;
  if (c.ejectNow) return true;
  if (!raceRunning) return true;
  return nowMs >= c.untilMs - EJECT_LEAD_MS;
}

// How long the room page lets the seat do its own eject save before it ends
// the seat itself (the eject without the seat's help).
export function ejectGraceMs(c, nowMs) {
  const left = c ? c.untilMs - nowMs - DEADLINE_MARGIN_MS : EJECT_GRACE_MAX_MS;
  return Math.max(EJECT_GRACE_MIN_MS, Math.min(EJECT_GRACE_MAX_MS, Math.floor(left)));
}

// Batch 1: the room seat's notice for a closing room or a last race (mp-seat.js showClosingNotice). c is the seat's
// state.leaseClosing ({ until, reason, ejectAfterRace, closing } or null).
export function closingNoticeText(c, fmt = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) {
  if (!c) return '';
  if (c.closing) {
    const t = c.until ? Date.parse(c.until) : NaN;
    return `This room is closing${Number.isFinite(t) ? ` at ${fmt(t)}` : ' soon'}. Finish your race; your card is saved and you go back to the rooms.`;
  }
  if (c.ejectAfterRace) return 'This is your last race on this seat. Your card comes out and is saved after it.';
  return '';
}

// THE ROOM RESTART (the community pilot, 2026-11-24; approved by John R Reeves III, MHA). A room whose master board
// is stuck at a race build is restarted by the room server (mp-room.js hang watchdog, tools/room-server/manager.mjs).
// Before the room stops its hub it tells every seat, through the control message a seat already takes (T.eject, with
// this reason in place of 'closing'), so the seat page can say so at once, save what it still owes on its live
// lease, and go back to its return_path with a one-shot note for the lobby. The seat closes NO lease for this: a
// seat's own close is 'seat_closed' (a leave), and the no-fault endings are the room server's alone. The room page
// marks each told seat as ended by the room (mp-room-return.js markRoomEnd, why room_restart), and the room server
// closes its lease 'server_closed' after any owed 'server_lost' (doc-arcade docs/rooms/mid-race-leave.md: no fault,
// no rest, and a race with still no result is void).
export const ROOM_RESTART_REASON = 'restarting';
// The seats are told this long before the hub stops (their save queues post in that time).
export const ROOM_RESTART_NOTICE_MS = 5000;
// The build hang with no station changed: the restart is asked this long after the hang was seen (the hang dump's
// second sample is 5 s after it, its answers at most 3 s more).
export const HANG_FAST_RESTART_MS = 20000;
export const ROOM_RESTART_TEXT = 'The room is restarting. Your horse is safe. You will go back to the lobby in a moment; join again in about a minute.';
// The note for the lobby (doc-arcade lib/roomSeatHandoff takeRoomRestartNote): the time it was set, in sessionStorage
// (per tab, same origin, never a URL), read once and removed there. The lobby's words for it: "The room restarted.
// Your horse is as it was after its last saved race. You can join again now."
export const ROOM_RESTART_NOTE_KEY = 'doc.roomRestartNote';
export function markRoomRestartNote(now = Date.now(), storage = (() => { try { return globalThis.sessionStorage || null; } catch { return null; } })()) {
  if (!storage) return false;
  try { storage.setItem(ROOM_RESTART_NOTE_KEY, String(now)); return true; } catch { return false; }
}
// EVERY OTHER SEAT END (the first visit of 2026-11-24: a seat the room ended after 90 s went back to the lobby with its
// words in the status line for four seconds, which nobody saw). The seat page leaves a one-shot note for its way
// back at every end, the restart note's pattern: "<code>:<time>" in sessionStorage. The code names the end (the
// page's own why, or 'files': no game files were chosen); the lobby has the words (doc-arcade lib/roomSeatHandoff
// takeRoomSeatEndNote), and a code it does not know gets a plain line.
export const SEAT_END_NOTE_KEY = 'doc.roomSeatEndNote';
export function markSeatEndNote(code, now = Date.now(), storage = (() => { try { return globalThis.sessionStorage || null; } catch { return null; } })()) {
  if (!storage || !/^[a-z_]{1,24}$/.test(String(code))) return false;
  try { storage.setItem(SEAT_END_NOTE_KEY, `${code}:${Math.floor(now)}`); return true; } catch { return false; }
}
// THE ROOM WENT AWAY WHILE THE SEAT WAITED (2026-11-24): a seat page that was linked to its room but had no station
// yet (choosing its game files, or waiting for the race in progress) when the room or the room server restarted.
// Its note's code; the lobby's words: "The room restarted while you were waiting. You can join again now."
export const SEAT_WAITING_END_CODE = 'waiting_restart';
// THE SEAT THAT CANNOT KEEP UP, AND THE OPERATOR'S END (the community pilot, 2026-11-24; asked for by John R Reeves III,
// MHA). The room ends one seat and says why with the control message a seat already takes (T.eject) and one of these
// reasons in place of 'closing':
//   'slow'      the seat's board does not run at full speed (the room's speed test, mp-seat-speed.js): either it was
//               not handed its station (the gate, while it waited on its shadow link), or it lost it (the watch);
//   'operator'  the operator ended this one seat (the room server's debug port, POST /rooms/debug/end-seat).
// The seat page says the words at once, saves what it still owes on its live lease, and goes back to its return_path
// with a one-shot note for the lobby (markSeatEndNote, the codes below; the lobby has the same words). As for the
// restart, the seat closes NO lease for this: a seat that held its station is marked as ended by the room
// (mp-room-return.js markRoomEnd, why slow_seat or operator_end) and the room server closes its lease
// 'server_closed' (no fault, no rest, a race with no result is void; card saves already made stay made). A seat that
// never held the station gives its place back itself, as every seat that ends while it waits does.
export const SEAT_SLOW_REASON = 'slow';
export const SEAT_OPERATOR_REASON = 'operator';
// One note for the gate and for the watch (John R Reeves III, MHA: the same note).
export const SEAT_SLOW_TEXT = 'Your device could not keep the game at full speed, so you were not seated. Close other apps and tabs, or try a faster device or a steadier connection.';
export const SEAT_OPERATOR_TEXT = 'An operator ended your seat.';
// The lobby's note codes (room-closing.js markSeatEndNote: lower case letters and underscores, at most 24).
export const SEAT_SLOW_NOTE = 'slow_device';
export const SEAT_OPERATOR_NOTE = 'operator_end';
// What a seat page does with an eject reason of this kind: { note, text } or null (any other reason).
export function roomEndOfSeat(reason) {
  if (reason === SEAT_SLOW_REASON) return { note: SEAT_SLOW_NOTE, text: SEAT_SLOW_TEXT };
  if (reason === SEAT_OPERATOR_REASON) return { note: SEAT_OPERATOR_NOTE, text: SEAT_OPERATOR_TEXT };
  return null;
}
// The room waits this long between telling a seat and ending its link, so the words arrive and the seat's own
// close and saves go first.
export const SEAT_ROOM_END_NOTICE_MS = 5000;
// Did a station change boards around this build? The filler reboots of the hang watchdog (its steps 1 and 2) were
// made for that case only; with no change they have never freed a stuck master (0 of 4 on the live room), so the
// room goes to its restart. slots: the room's stations ({ slot, owner, returnedMs, takenAt }); buildAt and
// nowPerf on the page clock (performance.now), nowWall the wall clock (takenAt is wall time). Returns the station
// numbers that changed (an empty list: none).
const HANG_CHANGING_OWNERS = new Set(['returning', 'opening', 'connecting', 'handing', 'broken']);
export function hangChangedStations(slots, { buildAt, nowPerf, nowWall, recentMs }) {
  const buildWall = nowWall - (nowPerf - buildAt);
  const out = [];
  for (const x of slots) {
    const changed = HANG_CHANGING_OWNERS.has(x.owner)
      || (Number.isFinite(x.returnedMs) && buildAt - x.returnedMs < recentMs)
      || (Number.isFinite(x.takenAt) && x.takenAt > 0 && buildWall - x.takenAt < recentMs);
    if (changed) out.push(x.slot);
  }
  return out;
}
