// room-nvmem.js: a room's battery memory (the main board's battery backed RAM and its EEPROM), read out of the
// core for the room server to keep, and written back before the game loads (multiplayer room, M3 W9).
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// What for. The game keeps its race calendar (the round), its track records and its bookkeeping in the NAOMI's
// battery backed RAM (32 KB) and its settings in the JVS board's EEPROM (128 bytes). A cabinet keeps both across a
// power cycle. A browser room kept neither: the core writes the battery RAM to a file only when the emulator is
// stopped, and a room's boards are ended, never stopped. So a room that closed or crashed came back on round 1.
//
// The core (Flycast, core/hw/flashrom/nvmem.cpp and core/hw/maple/maple_jvs.cpp, shell/libretro/libretro.cpp):
//   battery RAM  read once, when the game loads, from <save dir>/reicast/<game file name>-main.nvmem when the game's
//                boot header title starts with " DERBY" and the board is the master of a multiboard pair
//                (MultiboardSlaves 2 or more), else from <save dir>/reicast/<game file name>.nvmem. Every Derby Owners
//                Club edition's title starts with " DERBY" (read from the boot headers of drbyocwc, derbyocw, derbyoc
//                and derbyo2k in the lab, 2026-11-22), and a room's board0 is the master of its pair, so board0 reads
//                the -main name. The board worker checks it after the load (the copy must equal what was written).
//   EEPROM       read when the JVS board is made (at the game load) from <save dir>/reicast/<game file name>.eeprom,
//                and written to that file at once on every EEPROM write.
//   A graphics partner (settings.naomi.slave) reads and writes neither.
// The game file name keeps its extension (drbyocwc.zip-main.nvmem), as the card path does (card-store.js).
//
// What the game keeps there, as seen in a lab room (Rev C, 2026-11-22; offsets and counts only were looked at):
//   - A blank boot fills about 4.3 KB at its first lobby. A boot from saved memory does not fill it again: the game
//     takes the saved data as its own.
//   - One data block, held twice (two copies, each with its own check words). In it: the track record table (one
//     entry is rewritten, in both copies, when a course record falls) and the racing program the calendar is on
//     (rewritten once, when a program's sixth race is over).
//   - The game writes that block only at the start of the lobby after a race, within a second of the lobby phase.
//     The read 90 board frames into the lobby (about three seconds) comes after it.
//   - A counter in the first bytes ticks every few seconds, races or not, so two saves are never the same bytes.
//   - NOT kept: the race number within the program. After any boot the game starts the saved program at its 1R.
//     So a room that closed or crashed comes back on the racing program it was on (the calendar goes on from
//     there), at that program's first race, as a cabinet does after a power cycle. The game's race number word
//     (gameRaceWordFor) counts races over the calendar, six to a program, and comes back as the program's first.
//   - The EEPROM was never written in the lab (no .eeprom file appeared in six boots and eighteen races), so a
//     save there is the battery RAM alone; the EEPROM is kept when the core has written one.
// DOC '99, Rev D and DOC 2000 read the same file names (their titles start with " DERBY" too); what they keep was
// not looked at in a lab room.
//
// Reading: shim_nvmem_copy (host/shim/linkbus_shim.cpp) copies the battery RAM out between frames with no effect
// on the game (no guest read, nothing charged to the guest clock); the EEPROM is the core's own file. A read is
// kept only when a second read a few frames later is the same (createStableReader), so a copy taken while the
// game is in the middle of writing is never kept. Pure (no DOM, no clock): used by lb-board-worker.js, mp-room.js,
// the room server (tools/room-server/nvmem-store.mjs) and the node tests. No memory bytes are logged anywhere.

import { REVC_GAME } from './mp-entry-watch.js';

export const NVMEM_BYTES = 32768;
export const EEPROM_BYTES = 128;
// The names the room server keeps the two files under, and hands them to the room page's file input with.
export const NVMEM_FILE = 'board0.nvmem';
export const EEPROM_FILE = 'board0.eeprom';
// Frames (board0's own run calls) from the read request to the first read, the gap to the second, and how many
// pairs are tried before the read is given up as unstable.
export const READ_AFTER_FRAMES = 90;
export const READ_GAP_FRAMES = 4;
export const READ_TRIES = 6;

const okName = (n) => typeof n === 'string' && n !== '' && !n.includes('/') && !n.includes('\\') && !n.includes('..');

/** Where board0's core reads its battery RAM (main: the master of a multiboard pair of a " DERBY" game). */
export function coreNvmemPath(saveDir, gameFileName, { main = true } = {}) {
  if (!okName(gameFileName)) throw new Error('bad game file name');
  return `${saveDir}/reicast/${gameFileName}${main ? '-main.nvmem' : '.nvmem'}`;
}
/** Where the core reads and writes its EEPROM. */
export function coreEepromPath(saveDir, gameFileName) {
  if (!okName(gameFileName)) throw new Error('bad game file name');
  return `${saveDir}/reicast/${gameFileName}.eeprom`;
}

/** Why these are not a room's memory files, or null. eeprom may be null (the game wrote none). */
export function memoryBad(nvmem, eeprom = null) {
  if (!(nvmem instanceof Uint8Array)) return 'the battery memory is not bytes';
  if (nvmem.length !== NVMEM_BYTES) return `the battery memory is ${nvmem.length} bytes, not ${NVMEM_BYTES}`;
  if (eeprom !== null && !(eeprom instanceof Uint8Array)) return 'the EEPROM is not bytes';
  if (eeprom !== null && eeprom.length !== EEPROM_BYTES) return `the EEPROM is ${eeprom.length} bytes, not ${EEPROM_BYTES}`;
  return null;
}

function mkdirp(FS, path) {
  let cur = '';
  for (const part of path.split('/').filter(Boolean)) {
    cur += `/${part}`;
    try { FS.mkdir(cur); } catch { /* exists */ }
  }
}

/**
 * Writes a room's saved memory into the core's in-memory file system, before the game loads (as mountCard writes a
 * card). Returns { nvmem, eeprom }: the paths written (eeprom null when none was given). Throws on wrong sizes.
 */
export function mountMemory(FS, saveDir, gameFileName, { nvmem, eeprom = null }) {
  const bad = memoryBad(nvmem, eeprom);
  if (bad) throw new Error(bad);
  const np = coreNvmemPath(saveDir, gameFileName);
  mkdirp(FS, np.slice(0, np.lastIndexOf('/')));
  FS.writeFile(np, nvmem);
  let ep = null;
  if (eeprom) { ep = coreEepromPath(saveDir, gameFileName); FS.writeFile(ep, eeprom); }
  return { nvmem: np, eeprom: ep };
}

/** The core's EEPROM file as it stands (a copy), or null when the game has written none or it is not 128 bytes. */
export function readCoreEeprom(FS, saveDir, gameFileName) {
  let b;
  try { b = FS.readFile(coreEepromPath(saveDir, gameFileName)); } catch { return null; }
  return b instanceof Uint8Array && b.length === EEPROM_BYTES ? new Uint8Array(b) : null;
}

export function sameBytes(a, b) {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The RAM word that holds the game's own race number, or null where it is not known (Rev C only). It counts races
 * over the calendar, six to a racing program (0 is the first program's 1R, 6 the second program's 1R); at a lobby it
 * names the race to come. Recorded with a save for the log only.
 */
export function gameRaceWordFor(game) {
  return String(game || '').toLowerCase() === REVC_GAME ? 0x0C21A294 : null;
}

/**
 * The board worker's reader: a read asked for now is taken `after` frames later, and kept only when a second read
 * `gap` frames after it is the same; a pair that differs is tried again (the second read becomes the first), up to
 * `tries` pairs.
 *   read(): { nvmem: Uint8Array, eeprom: Uint8Array | null } (fresh copies), or null when the core gave nothing.
 *   request({ tag, after }): ask for a read (tag is handed back with the result). A request while one is pending
 *     takes the new tag, and brings the first read forward when its own `after` would come sooner.
 *   step(n): call after frame n; null, or the finished read once:
 *     { ok: true, tag, frame, tries, nvmem, eeprom } or { ok: false, tag, frame, why: 'unreadable' | 'unstable' }.
 */
export function createStableReader({ read, gap = READ_GAP_FRAMES, tries = READ_TRIES }) {
  const g = Math.max(1, gap | 0);
  const max = Math.max(1, tries | 0);
  let job = null; // { tag, after, due, first, pairs, rush }
  return {
    get pending() { return job !== null; },
    request({ tag = null, after = READ_AFTER_FRAMES } = {}) {
      const a = Math.max(0, after | 0);
      if (job) { job.tag = tag; if (job.due === null) job.after = Math.min(job.after, a); else if (job.first === null) job.rush = a; return; }
      job = { tag, after: a, due: null, first: null, pairs: 0, rush: null };
    },
    step(n) {
      if (!job) return null;
      if (job.due === null) job.due = n + job.after;
      if (job.rush !== null) { job.due = Math.min(job.due, n + job.rush); job.rush = null; }
      if (n < job.due) return null;
      const now = read();
      if (!now || memoryBad(now.nvmem, now.eeprom ?? null)) { const r = { ok: false, tag: job.tag, frame: n, why: 'unreadable' }; job = null; return r; }
      if (job.first === null) { job.first = now; job.due = n + g; return null; }
      job.pairs++;
      if (sameBytes(job.first.nvmem, now.nvmem) && sameBytes(job.first.eeprom ?? null, now.eeprom ?? null)) {
        const r = { ok: true, tag: job.tag, frame: n, tries: job.pairs, nvmem: now.nvmem, eeprom: now.eeprom ?? null };
        job = null;
        return r;
      }
      if (job.pairs >= max) { const r = { ok: false, tag: job.tag, frame: n, why: 'unstable' }; job = null; return r; }
      job.first = now; job.due = n + g;
      return null;
    },
  };
}

// ---- the page's side: base64 for the trip from the room page to the room server (page.evaluate returns JSON) ----

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x2000) s += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(s);
}
export function fromBase64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * The room page's keeper of the newest read for the room server.
 *   offer(r, info): a finished read of the board ({ ok, nvmem, eeprom, frame }); info: { why, gameRace, at }.
 *     Kept as the newest save (seq counts up) unless it failed. Returns the new seq, or null.
 *   status(): { seq, why, gameRace, frame, at, bytes, eeprom, failed } for the poll (numbers only), or null.
 *   take(seq): the save as JSON text (base64 bytes), once the server asks for that seq; else null. Kept until a
 *     newer one replaces it, so a take that failed on the way can be asked again.
 */
export function createMemoryOutbox() {
  let seq = 0;
  let cur = null;
  let failed = 0;
  return {
    offer(r, info = {}) {
      if (!r || r.ok !== true || memoryBad(r.nvmem, r.eeprom ?? null)) { failed++; return null; }
      seq++;
      cur = { seq, why: typeof info.why === 'string' ? info.why.slice(0, 24) : null, gameRace: Number.isInteger(info.gameRace) ? info.gameRace : null,
        frame: Number.isInteger(r.frame) ? r.frame : null, at: typeof info.at === 'string' ? info.at.slice(0, 40) : null, nvmem: r.nvmem, eeprom: r.eeprom ?? null };
      return seq;
    },
    status() {
      if (!cur) return failed ? { seq: 0, failed } : null;
      return { seq: cur.seq, why: cur.why, gameRace: cur.gameRace, frame: cur.frame, at: cur.at, bytes: cur.nvmem.length, eeprom: cur.eeprom ? cur.eeprom.length : 0, failed };
    },
    take(want) {
      if (!cur || cur.seq !== want) return null;
      return JSON.stringify({ seq: cur.seq, why: cur.why, gameRace: cur.gameRace, frame: cur.frame, at: cur.at, nvmem: toBase64(cur.nvmem), eeprom: cur.eeprom ? toBase64(cur.eeprom) : null });
    },
  };
}
