// mp-hang-dump.js: the room's hang dump. A read only diagnostic of the hang watchdog (mp-room.js): when the watchdog
// first sees a hang (a race built, the master still in the lobby 15 s on), the room writes down where every room board
// stands, once at that moment and once 5 s later, each as ONE line of the room page log:
//   [room] HANG dump 1/2 race <n>: {json}
//   [room] HANG dump 2/2 race <n>: {json}
// A dump that cannot be taken is one line too ([room] HANG dump 1/2 race <n> failed: <why>) and is never thrown: the
// watchdog's steps do not wait for a dump and never see it.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// What a dump holds (status words, counts and hashes only; no game memory, no card, no file contents):
//   n, race, at, phase   which dump (1 or 2), the race number, the wall time, the master PHASE the page last saw
//   hub                  the hub's counters as the page reads them (round, waitingSeat, running, lateResets, per node
//                        txSeq, refused, sizeMismatch, unsized)
//   net                  the relaxed hub's counters (tick, lateResets, per node boardLateResets, peerTimeouts, backlog,
//                        covered, sized, absentSeen, released), or null
//   frames, vb           every board's frame count and every ring node's guest vblank count
//   boards               per room board (the master board0 and each station's board; the graphics partner is not
//                        asked): { w: { scene, sub, phase, state, recv_state, net_err, entry, nodes, station }, pc,
//                        ram, regs, cycles, last } where pc is the program counter, ram and regs are the hashes the
//                        board's samples already carry, cycles is the guest cycle count and last is the page's last
//                        three samples of that board as [frame, pc, ram hash]. A board that gave no answer is
//                        { why, last } (why: 'no board' for a station a remote seat or nothing holds, 'timeout',
//                        'not running').
// Reading two dumps: a board whose RAM hash and cycle count are the same in both is not running at all; a master
// whose cycles go on while SCENE, SUB, PHASE and STATE stay (the cabinets' freeze reads SCENE 6, SUB 2, PHASE 1,
// STATE 2) is a game standing in its main loop.
//
// The first dump's page side values (hub, net, frames, vb, last) are read at once, in the watchdog's own tick, before
// its step 1 runs. The board words come back from each board's worker between two frames (lb-board-worker.js
// 'hang-peek'), so a filler that step 1 or step 2 reboots in that time gives no answer; the master is never rebooted
// by the watchdog's steps 1 and 2, and it is the board the dump is for.
import { REVC_GAME } from './mp-entry-watch.js';

// The words a board reads for a dump: Rev C (drbyocwc) addresses, each a status word of the game's own (SCENE and SUB
// the scene and its sub scene, PHASE and STATE the room's race phase and link state, recv_state the master STATE a
// satellite holds, NETWORK ERROR, the entry word, NODES, the board's own station). A fixed list in the worker: the
// page cannot ask a board for any other address.
export const HANG_DUMP_WORDS = Object.freeze([['scene', 0x0C21A0F0], ['sub', 0x0C21A0F4], ['phase', 0x0C21A284], ['state', 0x0C21A2A8],
  ['recv_state', 0x0C21A2AC], ['net_err', 0x0C3B7748], ['entry', 0x0C21A518], ['nodes', 0x0C21A130], ['station', 0x0C21A144]]);
// Another game has other addresses: no words are read there (the program counter and the hashes still are).
export const hangDumpWordsFor = (game) => (String(game || '').toLowerCase() === REVC_GAME ? HANG_DUMP_WORDS : []);

export const HANG_DUMP_SECOND_MS = 5000;
export const HANG_DUMP_PEEK_MS = 3000;

const why = (err) => String(err && err.message ? err.message : err).replace(/\s+/g, ' ').slice(0, 160);

// THE BOARD'S HALF (lb-board-worker.js 'hang-peek', answered between two frames). word(address): one RAM word, copied
// out of the core's RAM array (shim_dbg_ram_word: no guest read, nothing charged to the guest clock). hash(): the
// board's state hash, the one its samples carry ({ ram, regs, pc, cycles }), or null. running: the frame loop has
// begun (before it there is no game to read). Nothing is written and no address comes from the page.
export function hangPeekReply({ game, running, word, hash }) {
  if (!running) return { ok: false, why: 'not running' };
  try {
    const list = hangDumpWordsFor(game);
    const words = list.map((w) => word(w[1]) >>> 0);
    const h = hash();
    return { ok: true, names: list.map((w) => w[0]), words, pc: h ? h.pc : null, ram: h ? h.ram : null, regs: h ? h.regs : null, cycles: h ? h.cycles : null };
  } catch (err) { return { ok: false, why: why(err).slice(0, 80) }; }
}

// One board's answer ({ ok, names, words, pc, ram, regs, cycles } from the worker) as the dump keeps it.
function boardEntry(r, last) {
  if (!r || r.ok !== true) return { why: r && typeof r.why === 'string' ? r.why.slice(0, 80) : 'no answer', last };
  const w = {};
  const names = Array.isArray(r.names) ? r.names : [];
  for (let i = 0; i < names.length; i++) w[String(names[i])] = Number.isFinite(r.words && r.words[i]) ? r.words[i] >>> 0 : null;
  return { w, pc: r.pc ?? null, ram: r.ram ?? null, regs: r.regs ?? null, cycles: Number.isFinite(r.cycles) ? r.cycles : null, last };
}

// cab: the cabinet (lb-cabinet.js: boards, workers, state, hubStatus, netStatus, frameCounts, vblankCounts, hangPeek).
// log: the room page log. phase: the master PHASE the page last saw. setTimer: setTimeout (tests pass their own).
export function createHangDump({ cab, log, phase = () => null, setTimer = (fn, ms) => setTimeout(fn, ms), secondMs = HANG_DUMP_SECOND_MS, peekMs = HANG_DUMP_PEEK_MS }) {
  const say = (t) => { try { log(t); } catch { /* the log is the only way out */ } };
  const pick = (o, keys) => (o ? Object.fromEntries(keys.map((k) => [k, o[k] ?? null])) : null);
  // The page's own last samples of a board (lb-cabinet.js state.boards[i].samples), newest last.
  const lastOf = (i) => {
    const sb = cab.state && cab.state.boards ? cab.state.boards[i] : null;
    return sb && Array.isArray(sb.samples) ? sb.samples.slice(-3).map((x) => [x.f, x.hash ? x.hash.pc : null, x.hash ? x.hash.ram : null]) : null;
  };
  // Everything up to the first await is read in the caller's own tick.
  async function snapshot(seq, n) {
    const out = { n, race: seq, at: new Date().toISOString(), phase: phase() };
    out.hub = pick(cab.hubStatus(), ['round', 'waitingSeat', 'running', 'lateResets', 'txSeq', 'refused', 'sizeMismatch', 'unsized']);
    out.net = pick(typeof cab.netStatus === 'function' ? cab.netStatus() : null, ['tick', 'lateResets', 'boardLateResets', 'peerTimeouts', 'backlog', 'covered', 'sized', 'absentSeen', 'released']);
    out.frames = cab.frameCounts();
    out.vb = cab.vblankCounts();
    const asked = cab.boards.filter((b) => b.label !== 'partner').map((b) => {
      const last = lastOf(b.index);
      // Asked now (the message is posted in this tick); one board's failure is that board's entry only.
      let p;
      try { p = cab.workers[b.index] ? Promise.resolve(cab.hangPeek(b.label, peekMs)) : Promise.resolve({ ok: false, why: 'no board' }); } catch (err) { p = Promise.resolve({ ok: false, why: why(err) }); }
      return p.catch((err) => ({ ok: false, why: why(err) })).then((r) => [b.label, boardEntry(r, last)]);
    });
    out.boards = Object.fromEntries(await Promise.all(asked));
    return out;
  }
  const one = (seq, n) => {
    const failed = (err) => say(`[room] HANG dump ${n}/2 race ${seq} failed: ${why(err)}`);
    try { snapshot(seq, n).then((d) => say(`[room] HANG dump ${n}/2 race ${seq}: ${JSON.stringify(d)}`)).catch(failed); } catch (err) { failed(err); }
  };
  return {
    // The two dumps of one hang: the first now, the second secondMs on. Returns at once; never throws.
    take(seq) {
      one(seq, 1);
      try { setTimer(() => one(seq, 2), secondMs); } catch (err) { say(`[room] HANG dump 2/2 race ${seq} failed: ${why(err)}`); }
    },
  };
}
