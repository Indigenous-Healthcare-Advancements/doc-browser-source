// mp-seat-auto.js: LAB ONLY (multiplayer room M2). Pure helpers for the seat
// page (mp-seat.js), so a remote seat can run a test with nobody at it:
//   - autoleave: the seat clicks its own "Leave seat" (reason 'finish', the
//     same leave path as the button) a set time after its post-race card
//     write, or after the race results when no write comes;
//   - the seat report: the seat's own status and error counts, sent to the
//     room (mp-wire.js encodeSeatReport) so the room log covers it.
// No network code, no storage, no DOM.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later

export const AUTOLEAVE_MAX_S = 600;
// With no card write after the race, the seat waits at least this long
// after the results before it leaves (the game writes the card about 30 to
// 60 s after the results screen).
export const AUTOLEAVE_NO_WRITE_MIN_S = 120;

// autoleave=<seconds>, autorace=<n> (default 2). Off (null) unless
// autoleave is a whole number of seconds from 0 to AUTOLEAVE_MAX_S.
export function parseAutoLeave(q) {
  const v = q.get('autoleave');
  if (v === null || !/^[0-9]{1,3}$/.test(v)) return null;
  const seconds = Number(v);
  if (seconds > AUTOLEAVE_MAX_S) return null;
  const r = q.get('autorace');
  const race = r !== null && /^[1-9]$/.test(r) ? Number(r) : 2;
  return { seconds, race };
}

// The seat's race count: the board's done_mask word reaching 4095 (every
// entrant finished), as the runner counts it on the room's boards.
export const racesOf = (watch) => watch.filter((w) => w[1] === 'done_mask' && w[2] === 4095).length;

// createAutoLeave({ seconds, race }): step({ races, cardWrites, now }) returns
// true once, when the seat should leave. The time starts at the first card
// write after race `race` finished, or, if none comes, at the results plus
// at least AUTOLEAVE_NO_WRITE_MIN_S.
export function createAutoLeave({ seconds, race }) {
  let raceAt = null;
  let writesAtRace = -1;
  let writeAt = null;
  let fired = false;
  const s = { get raceAt() { return raceAt; }, get writeAt() { return writeAt; }, get fired() { return fired; } };
  s.step = ({ races, cardWrites, now }) => {
    if (fired) return false;
    if (raceAt === null && races >= race) { raceAt = now; writesAtRace = cardWrites; }
    if (raceAt === null) return false;
    if (writeAt === null && cardWrites > writesAtRace) writeAt = now;
    const due = writeAt !== null ? writeAt + seconds * 1000 : raceAt + Math.max(seconds, AUTOLEAVE_NO_WRITE_MIN_S) * 1000;
    if (now >= due) { fired = true; return true; }
    return false;
  };
  return s;
}

// Running counts of the watched words the report needs, kept as each watch
// change arrives (so the report never rescans the whole watch list).
// races: done_mask reaching 4095, which every linked board sees (room-wide,
// logs only). M3 R-1 seat witness: at the race_on rising edge the seat's own
// STATE says whether the game built this player's horse (STATE 6 or more at
// sat_race_setup); entries counts those races, entered is the current one.
// The room trusts its master's latch, not this; a mismatch is logged.
import { ENTERED_STATE } from './mp-entry-watch.js';

export const stateOf = (v) => (Number.isInteger(v) ? v & 0xff : null);
export const newWatchCounts = () => ({ scene: null, races: 0, netErr: 0, netErrOn: 0, state: null, raceOn: 0, entries: 0, entered: false, station: null });
export function countWatch(c, w) {
  if (w[1] === 'scene') c.scene = w[2];
  else if (w[1] === 'done_mask' && w[2] === 4095) c.races++;
  else if (w[1] === 'net_err') { c.netErr = w[2]; if (w[2] !== 0) c.netErrOn++; }
  else if (w[1] === 'state') c.state = stateOf(w[2]);
  // The station id (expected to equal the ring node id, 1..4 or 1..8) is
  // the low byte of the word.
  else if (w[1] === 'station') c.station = Number.isInteger(w[2]) ? w[2] & 0xff : null;
  else if (w[1] === 'race_on') {
    const on = w[2] !== 0 ? 1 : 0;
    if (on && !c.raceOn) { c.entered = (c.state ?? 0) >= ENTERED_STATE; if (c.entered) c.entries++; }
    if (!on) c.entered = false;
    c.raceOn = on;
  }
  return c;
}

// The report the seat sends (fields as mp-wire.js cleans them).
export function seatReportOf(state, pageErrors) {
  const b = state.board;
  const smp = b.samples.length ? b.samples[b.samples.length - 1] : null;
  const c = b.counts || b.watch.reduce(countWatch, newWatchCounts());
  return {
    phase: state.phase, f: smp ? smp.f : 0, comm2: smp && smp.status ? smp.status.comm2 : null, scene: c.scene, races: c.races,
    entries: c.entries, entered: c.entered === true, station: c.station, state: c.state,
    netErr: c.netErr, netErrOn: c.netErrOn, cardWrites: state.cardWrites, boardErrors: b.errors.length, pageErrors: pageErrors.count,
    lastError: pageErrors.last || (b.errors.length ? String(b.errors[b.errors.length - 1]) : null),
    closing: state.leaseClosing || null,
  };
}
