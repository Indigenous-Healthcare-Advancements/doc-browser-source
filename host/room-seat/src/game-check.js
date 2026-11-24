// game-check.js: a seat runs only known-good game files (docs/game-file-check.md).
// The game zip and the BIOS zip a seat was given are checked against the pin
// table (game-pin.js) by the CONTENTS of the members the core loads, never by
// the zip's own hash (which depends on how it was packed).
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// WHICH MEMBERS: the core (Flycast core/hw/naomi/naomi_cart.cpp loadMameRom
// and loadBios, core/archive/ZipArchive.cpp, at b3e207a43) finds each file of
// its ROM table first by the CRC32 the zip DECLARES for a member (the first
// such member, whatever its name), then by the table's file name. A seat
// mounts only the game zip and the BIOS zip (no parent set), and the core
// looks for the BIOS in the game zip before the BIOS zip. So, for every
// pinned member, EVERY zip member the core could take for it (a declared
// CRC32 equal to the pin's, or the pin's name, in any folder and any case)
// must hold the pinned contents, and there must be at least one. That does
// not depend on the order the core looks in. A member the core never looks
// for (other revisions in a merged set, other BIOS regions) is ignored.
//
// WHAT IS COMPARED: the member's real size and the SHA-256 of its inflated
// contents; a pin row without a SHA-256 falls back to size and the CRC32 of
// the contents (weak: a CRC32 can be forged).
// Rev C Rebalanced: the page checks the files it was GIVEN as the stock Rev C
// set (built: false); the board worker checks the zip it is HANDED, whose
// program member must be the recipe's reviewed image (built: true,
// edition-b-spec.js output_sha256) and every other member stock.
//
// This stops accidental and casual modified files. It is not protection
// against a player who changes this page (see the doc). No network code.

import { GAME_PIN_JSON } from './game-pin.js';
import { editionDef, filesEditionOf } from './editions.js';
import { readZip, memberBytes, crc32, sha256Hex, shippedSpec, EditionBrowserError } from './edition-b.js';

const HEX8 = /^[0-9A-F]{8}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MEMBER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ZIP = /^[a-z0-9]{1,16}\.zip$/;
const TOP_KEYS = ['format', 'sets', 'bios'];
const SET_KEYS = ['files', 'zip', 'members'];
const BIOS_KEYS = ['zip', 'region', 'any_of'];

export class GamePinError extends Error {}
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
function fail(m) { throw new GamePinError(m); }
function onlyKeys(v, keys, what) {
  if (!isRecord(v)) fail(`${what} must be an object`);
  for (const k of Object.keys(v)) if (!keys.includes(k)) fail(`${what} key ${k} is not allowed`);
  for (const k of keys) if (!(k in v)) fail(`${what} lacks ${k}`);
}
function memberRow(r, what) {
  if (!isRecord(r)) fail(`${what} must be an object`);
  for (const k of Object.keys(r)) if (!['name', 'size', 'crc32', 'sha256'].includes(k)) fail(`${what} key ${k} is not allowed`);
  if (typeof r.name !== 'string' || !MEMBER.test(r.name)) fail(`${what} name must be a plain lower case file name`);
  if (!Number.isSafeInteger(r.size) || r.size <= 0) fail(`${what} size must be a positive integer`);
  if (typeof r.crc32 !== 'string' || !HEX8.test(r.crc32) || r.crc32 === '00000000') fail(`${what} crc32 must be 8 upper hex digits, not zero`);
  if (r.sha256 !== undefined && (typeof r.sha256 !== 'string' || !HEX64.test(r.sha256))) fail(`${what} sha256 must be 64 lower hex digits`);
  return Object.freeze({ name: r.name, size: r.size, crc: parseInt(r.crc32, 16) >>> 0, sha256: r.sha256 ?? null });
}
function memberList(list, what) {
  if (!Array.isArray(list) || list.length === 0 || list.length > 64) fail(`${what} must be a list of 1 to 64 members`);
  const rows = list.map((r, i) => memberRow(r, `${what} ${i}`));
  if (new Set(rows.map((r) => r.name)).size !== rows.length || new Set(rows.map((r) => r.crc)).size !== rows.length) fail(`${what} repeats a name or a crc32`);
  return Object.freeze(rows);
}

/** Validate an untrusted pin table (the parsed GAME_PIN_JSON). Unknown keys are refused: the table holds only names, sizes and digests. */
export function parseGamePin(value) {
  onlyKeys(value, TOP_KEYS, 'game pin');
  if (value.format !== 'doc-game-pin/1') fail('unsupported game pin format');
  if (!Array.isArray(value.sets) || value.sets.length === 0 || value.sets.length > 16) fail('sets must be a list of 1 to 16');
  const sets = value.sets.map((s, i) => {
    onlyKeys(s, SET_KEYS, `set ${i}`);
    if (typeof s.files !== 'string' || !/^[A-Z0-9]{1,8}$/.test(s.files)) fail(`set ${i} files must be an edition id`);
    if (typeof s.zip !== 'string' || !ZIP.test(s.zip)) fail(`set ${i} zip must be a lower case zip name`);
    return Object.freeze({ files: s.files, zip: s.zip, members: memberList(s.members, `set ${i} member`) });
  });
  if (new Set(sets.map((s) => s.files)).size !== sets.length) fail('sets repeat an edition');
  onlyKeys(value.bios, BIOS_KEYS, 'bios');
  if (typeof value.bios.zip !== 'string' || !ZIP.test(value.bios.zip)) fail('bios zip must be a lower case zip name');
  if (!Number.isInteger(value.bios.region) || value.bios.region < 0 || value.bios.region > 3) fail('bios region must be 0 to 3');
  return Object.freeze({ format: value.format, sets: Object.freeze(sets),
    bios: Object.freeze({ zip: value.bios.zip, region: value.bios.region, anyOf: memberList(value.bios.any_of, 'bios member') }) });
}

let shipped = null;
/** The pin table this page ships, parsed and checked once. */
export function shippedGamePin() {
  if (!shipped) shipped = parseGamePin(JSON.parse(GAME_PIN_JSON));
  return shipped;
}

/**
 * The pin for one edition: { edition, files, name, zip, members, bios, rebuilt } or null (no such edition, or no
 * pinned set for its files). files: the edition whose stored files it runs from (B runs from A's); name: that
 * edition's player-facing name ("Rev C" for Rev C Rebalanced too: it is the Rev C file the player brings).
 */
export function gamePinFor(edition, pin = shippedGamePin()) {
  const def = editionDef(edition);
  const from = def ? editionDef(filesEditionOf(edition)) : null;
  if (!def || !from) return null;
  const set = pin.sets.find((s) => s.files === from.id);
  if (!set || set.zip !== `${from.release}.zip`) return null;
  return Object.freeze({ edition: def.id, files: from.id, name: from.name, zip: set.zip, members: set.members, bios: pin.bios, rebuilt: def.build === 'edition-b' });
}

const baseName = (n) => String(n).toLowerCase().split(/[\\/]/).pop();
const isCandidate = (e, row) => (e.crc >>> 0) === row.crc || baseName(e.name) === row.name;

// One zip member against what it must hold ({ size, sha256 | null, crc }): true when it holds exactly that.
async function holds(entry, want, subtle) {
  if (entry.usize !== want.size) return false;
  let bytes;
  try { bytes = await memberBytes(entry); } catch (err) { if (err instanceof EditionBrowserError) throw err; return false; }
  if (bytes.length !== want.size) return false;
  if (want.sha256) return (await sha256Hex(bytes, subtle)) === want.sha256;
  return crc32(bytes) === want.crc;
}

/**
 * Check the files a seat was given, or a board is handed, against the pin.
 *   edition: the registry id the seat runs ('A', 'B', 'J99', ...).
 *   files: [[name, ArrayBuffer | Uint8Array], ...] (the game zip and the BIOS zip, any order, names in any case).
 *   built: false = the files as the player brought them (stock, also for Rev C Rebalanced); true = the files the
 *     board runs (for Rev C Rebalanced the program member must be the recipe's reviewed image).
 * Returns { ok: true, weak } (weak: the member names that could only be checked by CRC32) or { ok: false, which,
 * why, member, name } with which 'game' | 'bios' and why one of:
 *   'no-pin' (nothing is known about this edition's files), 'no-file' (the zip was not given), 'unreadable' (not a
 *   plain zip), 'missing' (no member the core could take for a pinned one), 'changed' (such a member holds other
 *   contents), 'browser' (this browser cannot inflate or digest).
 * Never throws, and its result carries no digest.
 */
export async function checkGameFiles({ edition, files, built = false, pin = shippedGamePin(), spec = null, subtle = globalThis.crypto && globalThis.crypto.subtle }) {
  const p = gamePinFor(edition, pin);
  const bad = (which, why, member = null) => ({ ok: false, which, why, member, name: p ? p.name : null });
  if (!p) return bad('game', 'no-pin');
  if (!subtle || typeof subtle.digest !== 'function') return bad('game', 'browser');
  try {
    const zips = {};
    for (const which of ['game', 'bios']) {
      const want = which === 'game' ? p.zip : p.bios.zip;
      const f = Array.isArray(files) ? files.find((x) => Array.isArray(x) && String(x[0]).toLowerCase() === want) : null;
      if (!f || !f[1]) return bad(which, 'no-file');
      const u8 = f[1] instanceof Uint8Array ? f[1] : new Uint8Array(f[1]);
      try { zips[which] = readZip(u8); } catch { return bad(which, 'unreadable'); }
    }
    const weak = [];
    // Rev C Rebalanced as the board runs it: the program member is the recipe's image (found by the core by name,
    // or by the stock CRC32 if a second copy were left in: such a copy must be the built image too, or it is refused).
    const s = built && p.rebuilt ? (spec || shippedSpec()) : null;
    for (const row of p.members) {
      const want = s && row.name === s.member.toLowerCase() ? { size: s.source_size, sha256: s.output_sha256, crc: row.crc } : row;
      const cands = zips.game.filter((e) => isCandidate(e, row));
      if (cands.length === 0) return bad('game', 'missing', row.name);
      for (const e of cands) if (!(await holds(e, want, subtle))) return bad('game', 'changed', row.name);
      if (!want.sha256) weak.push(row.name);
    }
    // The BIOS: the core takes the first of the region's files it finds, in the game zip or the BIOS zip.
    let found = 0;
    for (const row of p.bios.anyOf) {
      const cands = [...zips.game, ...zips.bios].filter((e) => isCandidate(e, row));
      for (const e of cands) if (!(await holds(e, row, subtle))) return bad('bios', 'changed', row.name);
      if (cands.length && !row.sha256) weak.push(row.name);
      found += cands.length;
    }
    if (found === 0) return bad('bios', 'missing', p.bios.anyOf[0].name);
    return { ok: true, weak };
  } catch (err) {
    return bad('game', err instanceof EditionBrowserError ? 'browser' : 'unreadable');
  }
}

/**
 * The plain words for a refusal (never a digest, a size or a member's contents): what is wrong and what to use.
 * r: a checkGameFiles refusal.
 */
export function gameRefusalText(r) {
  const game = r && r.name ? `${r.name} game file` : 'game file';
  if (!r || r.ok) return '';
  if (r.why === 'browser') return 'This browser cannot check the game files. Use a current version of Chrome (or Edge) and try again.';
  if (r.why === 'no-pin') return 'This seat cannot check the files of this game, so it cannot start. Please tell the staff.';
  if (r.which === 'bios') {
    if (r.why === 'no-file') return 'The BIOS file (naomi.zip) is missing. Pick it with the game file.';
    if (r.why === 'unreadable') return 'This BIOS file (naomi.zip) cannot be read as a zip file. Use an unmodified copy.';
    if (r.why === 'missing') return 'This BIOS file (naomi.zip) does not hold the standard USA BIOS. Use an unmodified, complete copy.';
    return 'This BIOS file (naomi.zip) is not the standard release. Use an unmodified copy.';
  }
  if (r.why === 'no-file') return `The ${game} is missing. Pick it with naomi.zip.`;
  if (r.why === 'unreadable') return `This ${game} cannot be read as a zip file. Use an unmodified copy.`;
  if (r.why === 'missing') return `This ${game} is not the complete standard release (a file inside it is missing). Use an unmodified, complete copy.`;
  return `This ${game} is not the standard release. Use an unmodified copy.`;
}

/**
 * Whether a seat page checks its game files. A ROOM seat always does, whatever the address says. The lab seat does
 * too, unless its address carries gamepin=off (LAB ONLY: a lab run with files that are changed on purpose).
 */
export function gameCheckWanted({ roomSeat, param = null }) {
  if (roomSeat) return true;
  return param !== 'off';
}

/**
 * The edition a BOARD checks its files for, from its init message: a room seat's board (corePin) always checks, for
 * the pinned core's edition; any other board only when the page asked (gamePin). null: no check (the host's own
 * boards and the lab cabinet, which run the host's files).
 */
export function boardCheckEdition(msg) {
  if (msg && msg.corePin && typeof msg.corePin.edition === 'string') return msg.corePin.edition;
  if (msg && msg.gamePin && typeof msg.gamePin.edition === 'string') return msg.gamePin.edition;
  return null;
}
