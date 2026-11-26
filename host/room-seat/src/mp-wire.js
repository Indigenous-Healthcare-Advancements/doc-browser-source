// mp-wire.js: LAB ONLY (multiplayer room M1 and M2, doc-ops MULTIPLAYER_SERVER.md
// 3.3). The wire between a room (the server: master pair, hub, fillers) and
// one remote seat page: message framing, the frame codec (newest frame as
// runs of changed bytes against the last frame the other side
// acknowledged, so every packet decodes on its own and a lost packet costs
// one frame of freshness) and the lab seat ticket. Pure functions and small
// state machines; no network code, no game knowledge beyond frame bytes.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later

export const WIRE_MAGIC = 0x4d50; // "MP"
export const HEADER_BYTES = 16;
export const FRAME_HEADER_BYTES = HEADER_BYTES + 8; // + base u32, frame length u16, run count u16

// Message types.
export const T = Object.freeze({
  hello: 1, // seat -> room: the seat ticket (utf-8)
  welcome: 2, // room -> seat: the link settings (JSON, utf-8)
  refuse: 3, // room -> seat: why (utf-8); the room then closes
  up: 4, // seat -> room: the seat's newest slot frame (frame codec)
  down: 5, // room -> seat: the seat's newest assembled frame (frame codec)
  card: 6, // room -> seat: the checked-out card (bytes), once
  cardWrite: 7, // seat -> room: a card write: u32 write number, then the card bytes
  cardAck: 8, // room -> seat: the verdict of a card write (JSON)
  close: 9, // seat -> room: leaving (utf-8 reason: finish or abandon)
  log: 10, // seat -> room: the input and applied-frame log for the shadow (mp-shadow-log.js), reliable channel
  report: 11, // seat -> room: the seat's own status and error counts (JSON, utf-8; encodeSeatReport), reliable channel
  eject: 12, // room -> seat: L2 (DOC '99) the lease is closing: take the card out, save it and leave (utf-8 reason)
  taken: 13, // room -> seat: the warm join is over, the station is now this seat's (JSON; mp-room.js warm=1)
});

// The build a lab ticket is bound to (MULTIPLAYER_SERVER.md 4.1 item 3): a
// seat page of another build is refused.
export const MP_BUILD = 'm2';

// Header: magic u16, type u8, slot u8, room tag u32, seq u32, ack u32
// (the newest frame sequence this side has applied from the other side).
export function encodeHeader(out, { type, slot, roomTag, seq = 0, ack = 0 }) {
  const v = new DataView(out.buffer, out.byteOffset, HEADER_BYTES);
  v.setUint16(0, WIRE_MAGIC, true);
  v.setUint8(2, type);
  v.setUint8(3, slot);
  v.setUint32(4, roomTag >>> 0, true);
  v.setUint32(8, seq >>> 0, true);
  v.setUint32(12, ack >>> 0, true);
}

export function decodeHeader(bytes) {
  if (!bytes || bytes.length < HEADER_BYTES) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (v.getUint16(0, true) !== WIRE_MAGIC) return null;
  return { type: v.getUint8(2), slot: v.getUint8(3), roomTag: v.getUint32(4, true), seq: v.getUint32(8, true), ack: v.getUint32(12, true) };
}

// A control message: header plus a body (bytes).
export function encodeMessage(h, body = new Uint8Array(0)) {
  const out = new Uint8Array(HEADER_BYTES + body.length);
  encodeHeader(out, h);
  out.set(body, HEADER_BYTES);
  return out;
}

export const bodyOf = (bytes) => bytes.subarray(HEADER_BYTES);
export const utf8 = (s) => new TextEncoder().encode(s);
export const fromUtf8 = (b) => new TextDecoder().decode(b);

// ---- Seat report --------------------------------------------------------------
// A remote seat's own view, so the room log covers it without anyone at the
// seat relaying it: phase, frame, link word, scene, races, the game's net_err
// word, card writes, board and page error counts and the newest error text.
// Small and typed on both ends: the seat sends only these fields, and the
// room keeps only these fields, each clamped (a seat cannot put anything
// else into the room's log). No card bytes, no file names.
// Phase 'files' (2026-11-26): a seat whose board has not started because it waits for the player's own game files
// (mp-seat.js); without it the room heard nothing before the board booted, so "choosing files" and "stuck before
// boot" looked the same in the room's log.
export const SEAT_REPORT_MAX_BYTES = 1024;
const REPORT_PHASES = new Set(['connecting', 'retrying', 'welcomed', 'files', 'booting', 'linking', 'seated', 'ejecting', 'leaving', 'left', 'dropped', 'refused']);
const reportInt = (v, max = 0x7fffffff) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);
// Printable ASCII only, at most n characters.
export const reportText = (v, n = 120) => (typeof v === 'string' ? v.replace(/[^\x20-\x7e]/g, '?').slice(0, n) : null);

// L2 (DOC '99, jp-close-grace.md section 5): what the seat's OWN lease
// heartbeat said about closing, so the room server acts on a closing it
// would not see otherwise (a close from elsewhere, restart_owed, an expiry,
// max_lifetime): { until: closing_until (ISO, the server's clock), reason:
// closing_reason or null, ejectAfterRace, closing: the reply said closing,
// also one without closing_until }. null when not closing and no cap.
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,6})?)?(Z|[+-]\d\d:\d\d)$/;
function cleanClosing(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const until = typeof c.until === 'string' && c.until.length <= 40 && ISO.test(c.until) ? c.until : null;
  const reason = typeof c.reason === 'string' && /^[a-z_]{1,32}$/.test(c.reason) ? c.reason : null;
  const ejectAfterRace = c.ejectAfterRace === true;
  const closing = c.closing === true || until !== null;
  return closing || ejectAfterRace ? { until, reason, ejectAfterRace, closing } : null;
}

function cleanReport(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  return {
    phase: REPORT_PHASES.has(r.phase) ? r.phase : null,
    f: reportInt(r.f),
    comm2: typeof r.comm2 === 'string' && /^[0-9a-f]{1,8}$/i.test(r.comm2) ? r.comm2.toLowerCase() : null,
    scene: reportInt(r.scene, 0xffff),
    races: reportInt(r.races, 0xffff),
    // M3 R-1 seat witness (mp-seat-auto.js): races the game built this
    // seat's horse in, whether it is in the current one, its station id and
    // its STATE byte. The room's master latch decides; these are checked.
    entries: reportInt(r.entries, 0xffff),
    entered: r.entered === true,
    station: reportInt(r.station, 16),
    state: reportInt(r.state, 0xff),
    netErr: reportInt(r.netErr, 0xffff),
    netErrOn: reportInt(r.netErrOn, 0xffff),
    cardWrites: reportInt(r.cardWrites, 0xffff),
    boardErrors: reportInt(r.boardErrors, 0xffff),
    pageErrors: reportInt(r.pageErrors, 0xffff),
    lastError: reportText(r.lastError),
    closing: cleanClosing(r.closing),
  };
}

export function encodeSeatReport(r) {
  const c = cleanReport(r);
  if (!c) throw new Error('bad seat report');
  return utf8(JSON.stringify(c));
}

// Returns the cleaned report, or null for anything too big or not a report.
export function decodeSeatReport(body) {
  if (!body || body.length === 0 || body.length > SEAT_REPORT_MAX_BYTES) return null;
  let r;
  try { r = JSON.parse(fromUtf8(body)); } catch { return null; }
  return cleanReport(r);
}

// The room's gate for one link's reports: at most one every everyMs, plus
// one inside the window for the seat's last report (phase 'leaving', sent
// just before its close). take(body, now) returns the cleaned report or
// null (dropped: too soon, too big, or not a report).
export function createSeatReportGate({ everyMs = 500 } = {}) {
  let last = -Infinity;
  let leavingSeen = false;
  return {
    take(body, now) {
      const inWindow = now - last < everyMs;
      if (inWindow && leavingSeen) return null;
      // Inside the window only a report that names the leaving phase is
      // parsed at all.
      if (inWindow && !(body && body.length <= SEAT_REPORT_MAX_BYTES && fromUtf8(body).includes('"phase":"leaving"'))) return null;
      const r = decodeSeatReport(body);
      if (!r || (inWindow && r.phase !== 'leaving')) return null;
      if (r.phase === 'leaving') leavingSeen = true;
      last = now;
      return r;
    },
  };
}

// The room log budget for one slot's reports, so one seat cannot flood the
// room log. Each report is compared with the last one LOGGED (so a change
// that was skipped still shows on a later line): a line when an error field
// differs (at most once a second), when anything else that matters differs
// (at most every 5 s), when the phase first becomes 'leaving', and every
// 30 s regardless. decide(r, now) returns { log, skipped } and counts the
// reports it did not log while something differed.
export function createSeatReportLog() {
  let logged = -Infinity;
  let last = null;
  let skipped = 0;
  return {
    decide(r, now) {
      const p = last;
      const since = now - logged;
      const errChanged = !p || p.netErr !== r.netErr || p.netErrOn !== r.netErrOn || p.lastError !== r.lastError || p.boardErrors !== r.boardErrors || p.pageErrors !== r.pageErrors;
      const changed = errChanged || p.phase !== r.phase || p.cardWrites !== r.cardWrites || p.races !== r.races;
      const nowLeaving = r.phase === 'leaving' && (!p || p.phase !== 'leaving');
      if ((errChanged && since >= 1000) || (changed && since >= 5000) || since >= 30000 || nowLeaving) {
        const out = { log: true, skipped };
        logged = now;
        last = r;
        skipped = 0;
        return out;
      }
      if (changed) skipped++;
      return { log: false, skipped };
    },
  };
}

// One room log line for a report; the free text is quoted.
export const seatReportLine = (slot, r, skipped = 0) => `[room] slot ${slot} seat report: phase ${r.phase} f ${r.f} comm2 ${r.comm2} scene ${r.scene} races ${r.races} net_err ${r.netErr} (on ${r.netErrOn}) card writes ${r.cardWrites} board errors ${r.boardErrors} page errors ${r.pageErrors}${r.lastError ? ` last error: ${JSON.stringify(r.lastError)}` : ''}${skipped ? ` (${skipped} reports not logged)` : ''}`;

// ---- Run-length delta -------------------------------------------------------
// Runs of changed bytes: for each run, skip u16 (unchanged bytes since the
// previous run's end), length u16, then the bytes. Frames up to 64 KB.

export function deltaRuns(base, next) {
  const runs = [];
  let i = 0;
  let prevEnd = 0;
  const n = next.length;
  while (i < n) {
    if (next[i] === base[i]) { i++; continue; }
    const start = i;
    // A run ends after 4 equal bytes in a row (a gap that short costs less
    // to send than a new run header).
    let eq = 0;
    let end = i;
    while (i < n && eq < 4) {
      if (next[i] === base[i]) eq++; else { eq = 0; end = i + 1; }
      i++;
    }
    runs.push([start - prevEnd, start, end]);
    prevEnd = end;
    i = end;
  }
  return runs;
}

export function encodeDelta(base, next) {
  const runs = deltaRuns(base, next);
  let size = 0;
  for (const [, s, e] of runs) size += 4 + (e - s);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  let o = 0;
  for (const [skip, s, e] of runs) {
    v.setUint16(o, skip, true);
    v.setUint16(o + 2, e - s, true);
    out.set(next.subarray(s, e), o + 4);
    o += 4 + (e - s);
  }
  return { body: out, runs: runs.length };
}

export function applyDelta(base, body, runs) {
  const out = base.slice();
  const v = new DataView(body.buffer, body.byteOffset, body.length);
  let o = 0;
  let pos = 0;
  for (let r = 0; r < runs; r++) {
    if (o + 4 > body.length) throw new Error('delta truncated');
    pos += v.getUint16(o, true);
    const len = v.getUint16(o + 2, true);
    if (o + 4 + len > body.length || pos + len > out.length) throw new Error('delta out of range');
    out.set(body.subarray(o + 4, o + 4 + len), pos);
    pos += len;
    o += 4 + len;
  }
  if (o !== body.length) throw new Error('delta has trailing bytes');
  return out;
}

// ---- Frame sender and receiver ----------------------------------------------
// Each side of a link has one sender (its own frames) and one receiver (the
// other side's). The receiver's newest applied sequence travels back in
// every header's ack; the sender codes against that frame if it still has
// it and the ack is fresh, otherwise it sends the whole frame.

export function createFrameSender({ keep = 64, ackStaleMs = 250 } = {}) {
  const hist = new Map(); // seq -> frame bytes
  let seq = 0;
  let peerAck = 0;
  let peerAckAt = -Infinity;
  const stats = { sent: 0, full: 0, delta: 0, bytes: 0 };
  return {
    // A header ack from the other side.
    ack(a, now) {
      if (a > peerAck && hist.has(a)) { peerAck = a; peerAckAt = now; }
      else if (a === peerAck) peerAckAt = now;
    },
    // Encode `frame` as the next message of `type` for slot/roomTag; ackOut
    // is this side's receiver's newest applied sequence.
    encode(frame, { type, slot, roomTag, ackOut = 0, now = 0 }) {
      seq++;
      const base = peerAck > 0 && now - peerAckAt <= ackStaleMs ? hist.get(peerAck) : null;
      const useDelta = base && base.length === frame.length;
      const d = useDelta ? encodeDelta(base, frame) : null;
      const body = d ? d.body : frame;
      const out = new Uint8Array(FRAME_HEADER_BYTES + body.length);
      encodeHeader(out, { type, slot, roomTag, seq, ack: ackOut });
      const v = new DataView(out.buffer);
      v.setUint32(HEADER_BYTES, useDelta ? peerAck : 0, true);
      v.setUint16(HEADER_BYTES + 4, frame.length, true);
      v.setUint16(HEADER_BYTES + 6, d ? d.runs : 0, true);
      out.set(body, FRAME_HEADER_BYTES);
      hist.set(seq, frame.slice());
      for (const k of hist.keys()) { if (hist.size <= keep) break; if (k !== peerAck) hist.delete(k); }
      stats.sent++;
      stats.bytes += out.length;
      if (useDelta) stats.delta++; else stats.full++;
      return out;
    },
    stats,
    seq: () => seq,
  };
}

export function createFrameReceiver({ keep = 64 } = {}) {
  const hist = new Map(); // seq -> applied frame
  let newest = 0;
  const stats = { applied: 0, stale: 0, noBase: 0, bad: 0, late: 0 };
  return {
    // Decode one frame message. Returns { seq, frame } for a frame newer
    // than any applied, or null (stale, base missing or malformed: counted).
    // acceptLate (optional, the room's playout buffer, mp-playout.js): a
    // frame behind the newest is still decoded and returned (late: true,
    // counted in late, not stale) when acceptLate(seq) says its turn has not
    // passed; newest (what the peer is told as acked) does not move back.
    take(bytes, acceptLate = null) {
      const h = decodeHeader(bytes);
      if (!h || bytes.length < FRAME_HEADER_BYTES) { stats.bad++; return null; }
      const late = h.seq <= newest;
      if (late && !(acceptLate && !hist.has(h.seq) && acceptLate(h.seq))) { stats.stale++; return null; }
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      const base = v.getUint32(HEADER_BYTES, true);
      const len = v.getUint16(HEADER_BYTES + 4, true);
      const runs = v.getUint16(HEADER_BYTES + 6, true);
      const body = bytes.subarray(FRAME_HEADER_BYTES);
      let frame;
      try {
        if (base === 0) {
          if (body.length !== len) throw new Error('length');
          frame = body.slice();
        } else {
          const b = hist.get(base);
          if (!b) { stats.noBase++; return null; }
          if (b.length !== len) throw new Error('length');
          frame = applyDelta(b, body, runs);
        }
      } catch {
        stats.bad++;
        return null;
      }
      if (!late) newest = h.seq;
      hist.set(h.seq, frame);
      // The oldest by arrival goes first, but never the newest (the peer's delta base).
      for (const k of hist.keys()) { if (hist.size <= keep) break; if (k !== newest) hist.delete(k); }
      stats.applied++;
      if (late) { stats.late++; return { seq: h.seq, frame, ack: h.ack, late: true }; }
      return { seq: h.seq, frame, ack: h.ack };
    },
    newest: () => newest,
    stats,
  };
}

// ---- Lab seat ticket ----------------------------------------------------------
// LAB ONLY stand-in for the lobby's seat ticket (MULTIPLAYER_SERVER.md 4.1):
// base64url(JSON payload) "." base64url(HMAC-SHA-256). The room issues and
// verifies it with a key that never leaves the room page. In production the
// lobby signs and the room supervisor verifies (gate G2).

const b64u = (u8) => {
  let s = '';
  for (const c of u8) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (s) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export async function newTicketKey() {
  return crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signTicket(key, payload) {
  const body = utf8(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
  return `${b64u(body)}.${b64u(sig)}`;
}

// The payload without checking it (routing only: which room and slot).
export function peekTicket(ticket) {
  try {
    const [p] = String(ticket).split('.');
    return JSON.parse(fromUtf8(unb64u(p)));
  } catch {
    return null;
  }
}

// Verifies signature, expiry, room, the room's epoch and build, and single
// use (`used`: a Set of nonces). Returns { ok: true, payload } or
// { ok: false, reason }.
export async function verifyTicket(key, ticket, { now = Date.now(), roomId, epoch, build = MP_BUILD, used }) {
  const parts = String(ticket || '').split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  let body;
  let sig;
  try { body = unb64u(parts[0]); sig = unb64u(parts[1]); } catch { return { ok: false, reason: 'malformed' }; }
  if (!(await crypto.subtle.verify('HMAC', key, sig, body))) return { ok: false, reason: 'signature' };
  let p;
  try { p = JSON.parse(fromUtf8(body)); } catch { return { ok: false, reason: 'malformed' }; }
  if (p.room !== roomId) return { ok: false, reason: 'room' };
  if (p.epoch !== epoch) return { ok: false, reason: 'epoch' };
  if (p.build !== build) return { ok: false, reason: 'build' };
  if (!(p.exp > now)) return { ok: false, reason: 'expired' };
  if (!p.nonce || used.has(p.nonce)) return { ok: false, reason: 'used' };
  used.add(p.nonce);
  return { ok: true, payload: p };
}
