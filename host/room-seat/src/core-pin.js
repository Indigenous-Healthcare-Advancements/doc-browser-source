// core-pin.js: the room seat's core pin (M3 step 1d commit 2,
// docs/seat-1d-plan.md section 6). The board worker of a ROOM seat loads the
// core only through here: it fetches the glue and the wasm beside it
// (./core/, same origin), digests both with crypto.subtle, and refuses
// unless both equal the SHIPPED_CORE constants below. The glue is then
// imported from a blob: URL of the very bytes that were checked (never
// fetched a second time), and the checked wasm goes to the core as
// wasmBinary (with locateFile, so the glue never resolves a URL against the
// blob). Any throw on the way is a refusal ('throw'), never a stuck board.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The constants are the source of truth: no pin file is fetched, so a core
// copied before or without its pin file can never pass with freshly computed
// hashes, and there is no deploy order to get wrong. A future core change is
// a reviewed commit that changes these constants. doc-arcade's
// sync-pilot-game only copies the core and refuses on a mismatch with the
// same constants (A1).
// What the pin is for: an accidental or stale core mismatch (an old core left
// in a cache or a deploy, a wrong build copied, or a core built for other
// editions). It is NOT a
// guard against a same-origin attacker, who could replace both the core and
// this page.
// A future CSP needs script-src blob: (and worker-src as fits) for the glue.

import { EDITION_REGISTRY } from './editions.js';

export const CORE_JS_FILE = 'flycast_libretro.js';
export const CORE_WASM_FILE = 'flycast_libretro.wasm';

/**
 * The shipped core: Flycast commit b3e207a43 (the library of doc-browser-source tag web-2026.11.05-1, unchanged),
 * linked with one more host shim export, shim_nvmem_copy (host/shim/linkbus_shim.cpp; scripts/BUILD.md, change note
 * 2026-11-22), which copies the battery memory out for the room server (room-nvmem.js). The link before it, without
 * that export, was js d7bd2e87... wasm 6b4022ed... (web-2026.11.05-1).
 */
export const SHIPPED_CORE = Object.freeze({
  core: 'b3e207a43',
  js: 'a0b6f61ae6476b03f9ca7c34e8d6eab8e040b08dba62d3b8c4db57c9a2ce03f8',
  wasm: '428cc0ccb66f64f56a834a5e34548d629fbabb693e8f0decd784ed66635e1be1',
  editions: Object.freeze(['A', 'B', 'J99']),
});

export async function sha256Hex(subtle, bytes) {
  const d = new Uint8Array(await subtle.digest('SHA-256', bytes));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

/** The stock edition whose files a room seat of this release picks and runs: 'A', 'J99', or null. */
export function releaseEdition(release) {
  return release === 'revc' ? 'A' : release === 'doc99' ? 'J99' : release === 'revcb' ? 'B' : null;
}

/**
 * The seat's edition, from the hand-off's release and the room's welcome:
 * { edition } or { refused } (a reason word). The welcome's link tag names
 * the edition; its release must be the hand-off's, its game file that
 * release's set, and the edition one this seat can run (stock files).
 */
export function seatEdition(release, settings) {
  const want = release === 'revc' || release === 'revcb' ? 'drbyocwc' : release === 'doc99' ? 'derbyoc' : null;
  if (!want) return { refused: 'release' };
  if (!settings || typeof settings !== 'object') return { refused: 'settings' };
  const def = EDITION_REGISTRY.find((e) => e.linkTag === settings.edition);
  if (!def) return { refused: 'edition' };
  if (def.release !== want) return { refused: 'edition' };
  if (settings.game !== `${want}.zip`) return { refused: 'game' };
  // The release names its edition: revc and doc99 run stock files; revcb is Rev C Rebalanced, built in page memory
  // from the stock Rev C files (edition-b.js; the seat checks the rebuilt image against the room's session tag).
  if (def.id !== releaseEdition(release)) return { refused: 'build' };
  return { edition: def.id };
}

/**
 * Fetch and check the pinned core in `base` (a URL of the core folder)
 * against `pin` (SHIPPED_CORE): { ok: true, pin, glue, wasm } (the checked
 * bytes) or { ok: false, why } with why one of 'edition', 'fetch', 'js',
 * 'wasm', 'throw'.
 */
export async function checkCore({ base, edition, subtle, fetchFn = globalThis.fetch, pin = SHIPPED_CORE }) {
  if (!pin.editions.includes(edition)) return { ok: false, why: 'edition', pin };
  const get = async (name) => {
    const r = await fetchFn(new URL(name, base), { cache: 'no-store', credentials: 'same-origin' });
    if (!r || !r.ok) throw new Error(`core file ${name}: ${r ? r.status : 0}`);
    return new Uint8Array(await r.arrayBuffer());
  };
  let glue;
  let wasm;
  try {
    glue = await get(CORE_JS_FILE);
    wasm = await get(CORE_WASM_FILE);
  } catch { return { ok: false, why: 'fetch', pin }; }
  try {
    if (await sha256Hex(subtle, glue) !== pin.js) return { ok: false, why: 'js', pin };
    if (await sha256Hex(subtle, wasm) !== pin.wasm) return { ok: false, why: 'wasm', pin };
  } catch { return { ok: false, why: 'throw', pin }; }
  return { ok: true, pin, glue, wasm };
}

/**
 * Load the pinned core: { ok: true, create, options } (create is the glue's
 * factory, options go into its Module argument) or { ok: false, why }.
 * makeUrl turns the checked glue bytes into a blob: URL; importFn imports it;
 * revokeUrl drops it once the import is done (a revoke that throws changes nothing).
 * Never throws: any throw is { ok: false, why: 'throw' }.
 */
export async function loadPinnedCore({ base, edition, subtle, importFn, makeUrl, revokeUrl = () => {}, fetchFn, pin = SHIPPED_CORE }) {
  let c;
  try { c = await checkCore({ base, edition, subtle, fetchFn, pin }); } catch { return { ok: false, why: 'throw', pin }; }
  if (!c.ok) return c;
  let url;
  try { url = makeUrl(c.glue); } catch { return { ok: false, why: 'throw', pin }; }
  let mod;
  let failed = false;
  try { mod = await importFn(url); } catch { failed = true; }
  try { revokeUrl(url); } catch { /* the import's outcome stands */ }
  if (failed || !mod || typeof mod.default !== 'function') return { ok: false, why: 'import', pin };
  // wasmBinary: the checked bytes; locateFile: the glue never builds a URL
  // against its blob: base (it would fetch nothing, the bytes are given).
  return { ok: true, create: mod.default, options: { wasmBinary: c.wasm, locateFile: (f) => f }, pin };
}
