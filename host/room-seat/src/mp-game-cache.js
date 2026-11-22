// mp-game-cache.js: LAB ONLY (multiplayer room M2). Opt-in cache of the two
// game files a lab seat page picked (cachegame=1 on mp-seat.html), so a
// later seat in the same browser profile does not need them picked again.
// The files stay on this machine: they go only into this page origin's own
// Origin Private File System (folder CACHE_DIR, apart from the player game's
// "roms" folder), with a record of each file's name, size and SHA-256. The
// record never leaves the browser and nothing here prints or logs it. No
// network code (test/policy.test.mjs).
// Before cached files are used, they pass the same checks a picked set
// does: the core's file-name and size rules (rom-store.js checkRomName,
// checkRomSize), the lab game set (lab-game-set.js pickLabGameSet: the
// edition's game file and naomi.zip), and the size and SHA-256 stored when
// they were cached, so a damaged or swapped copy is refused, not booted.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later

import { checkRomName, checkRomSize } from './rom-store.js';
import { pickLabGameSet } from './lab-game-set.js';

export const CACHE_DIR = 'mp-lab-game-cache';
export const CACHE_RECORD = 'cache.json';
const HEX64 = /^[0-9a-f]{64}$/;

async function sha256Hex(bytes, subtle) {
  const d = new Uint8Array(await subtle.digest('SHA-256', bytes));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

function defaultGetRoot() {
  const nav = globalThis.navigator;
  if (!nav || !nav.storage || typeof nav.storage.getDirectory !== 'function') throw new Error('OPFS is not available in this browser');
  return nav.storage.getDirectory();
}

// The checks a set of [name, ArrayBuffer] pairs must pass to boot: exactly
// the edition's game file and naomi.zip, names and sizes the core accepts.
// Returns null when fine, or a short reason.
export function gameSetProblem(files, edition = 'A') {
  if (!Array.isArray(files) || files.length !== 2) return 'need exactly the game file and naomi.zip';
  for (const [name, bytes] of files) {
    const n = checkRomName(name);
    if (n) return `${n}`;
    const z = checkRomSize(bytes && bytes.byteLength);
    if (z) return `${z}`;
  }
  const names = files.map(([name]) => String(name).toLowerCase());
  const set = pickLabGameSet(names, edition);
  if (set.error) return set.error;
  if (!names.includes(set.game) || !names.includes('naomi.zip')) return `need ${set.game} and naomi.zip`;
  return null;
}

// createGameCache({ getRoot, subtle }): getRoot returns the OPFS root
// (injectable for tests); subtle is Web Crypto's SubtleCrypto.
export function createGameCache({ getRoot = defaultGetRoot, subtle = globalThis.crypto && globalThis.crypto.subtle } = {}) {
  const dir = async (create) => (await getRoot()).getDirectoryHandle(CACHE_DIR, { create });

  // files: [[name, ArrayBuffer], ...] that already passed gameSetProblem.
  async function store(files, edition = 'A') {
    const why = gameSetProblem(files, edition);
    if (why) throw new Error(`not cached: ${why}`);
    if (!subtle) throw new Error('not cached: no Web Crypto');
    const d = await dir(true);
    const record = { v: 1, edition, files: [] };
    for (const [name, bytes] of files) {
      const h = await d.getFileHandle(name, { create: true });
      const w = await h.createWritable();
      try { await w.write(new Uint8Array(bytes)); await w.close(); } catch (err) { if (typeof w.abort === 'function') await w.abort(); throw err; }
      record.files.push({ name, size: bytes.byteLength, sha256: await sha256Hex(bytes, subtle) });
    }
    const rh = await d.getFileHandle(CACHE_RECORD, { create: true });
    const rw = await rh.createWritable();
    await rw.write(new TextEncoder().encode(JSON.stringify(record)));
    await rw.close();
    return { names: record.files.map((f) => f.name) };
  }

  // Returns { ok: true, files } with the cached [name, ArrayBuffer] pairs,
  // or { ok: false, reason } ('none' when nothing is cached).
  async function load(edition = 'A') {
    let d;
    try { d = await dir(false); } catch { return { ok: false, reason: 'none' }; }
    let record;
    try { record = JSON.parse(await (await (await d.getFileHandle(CACHE_RECORD)).getFile()).text()); } catch { return { ok: false, reason: 'none' }; }
    if (!record || record.v !== 1 || record.edition !== edition || !Array.isArray(record.files) || record.files.length !== 2) return { ok: false, reason: 'record' };
    if (!subtle) return { ok: false, reason: 'no Web Crypto' };
    const files = [];
    for (const f of record.files) {
      if (!f || checkRomName(f.name) || !Number.isInteger(f.size) || !HEX64.test(String(f.sha256))) return { ok: false, reason: 'record' };
      let bytes;
      try { bytes = await (await (await d.getFileHandle(f.name)).getFile()).arrayBuffer(); } catch { return { ok: false, reason: 'missing' }; }
      if (bytes.byteLength !== f.size || (await sha256Hex(bytes, subtle)) !== f.sha256) return { ok: false, reason: 'changed' };
      files.push([f.name, bytes]);
    }
    const why = gameSetProblem(files, edition);
    if (why) return { ok: false, reason: why };
    return { ok: true, files };
  }

  // Removes the cached files and the record (the whole cache folder).
  async function forget() {
    try { await (await getRoot()).removeEntry(CACHE_DIR, { recursive: true }); } catch { /* nothing cached */ }
  }

  return { store, load, forget };
}
