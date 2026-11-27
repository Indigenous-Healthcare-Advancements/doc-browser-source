// lb-board-worker.js: one DOC board of the single-page cabinet, in a module
// worker (doc-wasm/linkbus2). Loads the core, sets the board's link role,
// installs the LinkBus mailbox (seats, frame sync) and the SAB multiboard
// backend (master pair), then runs frames. No network code.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Board settings follow the native lab (lab_config.py, start_lab.ps1):
//   board 0, seat 0:  NetworkEnable, ActAsServer, MultiboardSlaves 2, SAB multiboard
//   partner:          BoardId 1 (graphics board of the master pair), same options,
//                     SAB multiboard, no ring; started only when board 0
//                     posts linkbus-start-partners (multiboard.cpp startSlave)
//   boards 1..N:      seats 1..N (N = 4 or 8), NetworkEnable, ActAsServer off, MultiboardSlaves 1
//
// The core is the linkbus2 link output, served at ./core/ by tools/serve.mjs.
// A ROOM seat's board (init corePin: { edition }) loads it only through the
// pin (core-pin.js: digests checked, the glue from a blob: of the checked
// bytes, the wasm as wasmBinary); a refused core posts 'core-refused' and
// the board never starts. Every other board imports ./core/ as before.

import { loadPinnedCore } from './core-pin.js';
import { checkGameFiles, boardCheckEdition } from './game-check.js';
import { FS_PATHS, DEFAULT_CORE_OPTIONS, mountRom } from './core-bridge.js';
import { mountCard, createCardWatcher, prepareNewCard, swapCoreCard } from './card-store.js';
import { NVMEM_BYTES, mountMemory, readCoreEeprom, sameBytes, createStableReader } from './room-nvmem.js';
import { cardEjectSteps, CARD_PRESS_MASK } from './mp-seat-eject.js';
import { AudioRing } from './audio-ring.js';
import { syncHeaderOffset } from './race-pair.js';
import { takeInputMask, readPaceClock, readSeatLate, createLateLatch, absNowMs } from './seat-feel.js';
import { traceWrite } from './feel-trace.js';

// MB.inputMask (lb-lockstep.js) as an Int32 index: the port 0 mask of the latest frame, for a remote seat's input log.
const MB_INPUT_MASK_WORD = 48 >> 2;

// Game state words watched every frame, per game (mp-entry-watch.js
// gameWatchFor: Rev C's, or DOC '99's own PHASE and STATE): only changes are
// reported, as [frame, name, value].
// M3 R-1 (msg.entryWatch): the room's master board0 also watches the
// master entry words (mp-entry-watch.js), Rev C only.
// LAB ONLY (net delay experiment, msg.netWatch): the game's link watchdog
// (the project's link timing decode: NETWORK ERROR flag 0x0C3B7748,
// set after more than 32 polls with an unchanged comm packet number; poll
// count 0x0C40A1B8), Rev C addresses. net_err is watched like the words
// above; the poll count is reported as its maximum per 60 frames (wd_max),
// only when above 1.
const NET_ERR = 0x0C3B7748;
const WD_COUNT = 0x0C40A1B8;

import { hasEntryWatch, entryWatchFor, ownerWatchFor, gameWatchFor } from './mp-entry-watch.js';
import { careWordsFor, createCareRecorder } from './care-recorder.js';
import { hangPeekReply } from './mp-hang-dump.js';
import { NET_STATUS } from './lb-net-layout.js';
import { createRamDiffer, checkLabWords, small, field } from './lb-ram-diff.js';
import { createFrameTimeAgg } from './lb-frame-time.js';

const BIOS = new Set(['naomi.zip', 'naomi2.zip', 'awbios.zip', 'dc_boot.bin', 'dc_flash.bin']);
const hex32 = (v) => (v >>> 0).toString(16).padStart(8, '0');
const hex16 = (v) => (v >>> 0).toString(16).padStart(4, '0');
const RING_STAT_NAMES = ['published', 'taken', 'stale', 'dropped', 'badEdition', 'badSize', 'badHeader', 'staleTick'];

let cfg = null;
const hasCabinet = () => !!(cfg && cfg.cabinet);
let initDone = null;
let Module = null;
let buf = 0;
// The frame loop is running (the room's hang dump reads a board only then: 'hang-peek' below).
let frameLoopOn = false;
const logs = [];
// Card seat (stable game): the card file watcher; its writes go to the page.
let cardWatch = null;
// L2 (mp-seat-eject.js): a CARD press the page asked for, held for its
// frames on player 1's mask, beside the scripted presses and the live pad.
let ejectPress = null;
// The watcher's change count at the stint's last insert: 0 at the mount,
// then changes() at each insert press this board sees (the input mask's
// CARD bit rising, never the eject's own press), and at the page's
// 'card-base' (the seat is seated): a write the game made at registration
// (a new horse's card) is then not taken for the eject's write-back.
let insertBase = 0;
let insertHeld = false;
let ejecting = false;
// THE CARD'S GENERATION (the room seat's horse change, 'card-swap' below). A watcher reports every card write through
// the writer it was made with, and a writer carries ITS generation for good: null for the card the board booted with
// (the message then has no gen field, exactly as before any change), else the gen the page gave with the swap. So a
// write the old watcher reports in its last poll goes out under the OLD generation, and every write after a swap
// carries the new one.
let cardGen = null;
const cardWriter = (gen) => (b) => {
  const copy = new Uint8Array(b);
  self.postMessage({ type: 'card-write', board: cfg.label, bytes: copy.buffer, ...(gen === null ? {} : { gen }) }, [copy.buffer]);
};
// 'card-swap' { bytes | null, gen, adopt? }: change the card in the reader between two frames (card-store.js
// swapCoreCard has the order: the old watcher's last poll, the file, the new watcher). Refused, with nothing
// changed, while an eject save is pressing, for a gen that is not a whole number above the current one, or for a
// card of the wrong size. The answer comes after any card-write the last poll caused, so the page sees them in order.
function cardSwap(m) {
  const gen = m.gen;
  if (!Number.isSafeInteger(gen) || gen < 1 || (cardGen !== null && gen <= cardGen)) return { ok: false, gen: gen ?? null, why: 'bad gen' };
  if (ejecting) return { ok: false, gen, why: 'busy' };
  if (!Module || !cfg) return { ok: false, gen, why: 'not started' };
  const bytes = m.bytes ? new Uint8Array(m.bytes) : null;
  let r;
  try { r = swapCoreCard(Module.FS, FS_PATHS.save, cfg.game, cardWatch, bytes, cardWriter(gen), { adopt: m.adopt === true && !bytes }); } catch (err) { return { ok: false, gen, why: String(err && err.message ? err.message : err).slice(0, 80) }; }
  cardWatch = r.watcher;
  cardGen = gen;
  insertBase = 0; // the new card's stint starts here
  post('log', { text: `[board] card changed in the reader (gen ${gen}: ${bytes ? 'a card' : m.adopt === true ? 'the card the game wrote is kept' : 'no card'})` });
  return { ok: true, gen, lastChanged: r.lastChanged, removed: r.removed, card: !!bytes };
}
// THE CARD READER'S OWN EVENTS (msg.readerEvents, the room seat only; nothing is posted without it):
//   'card-in'   { f, gen? }  the insert button went down on this board (the core loads the card file then, if there is one)
//   'card-out'  { f, gen?, writes }  THE GAME TOLD THE READER TO EJECT THE CARD: the core says so in its own log
//               ("Card ejected", flycast core/hw/naomi/card_reader.cpp), on the game's eject at the end of a card's
//               game. Lab run of 2026-11-22 on Rev C (the eject probe): the game writes
//               the card, its STATE goes to 0 about 16 s later, and the eject follows within about a second. Posted
//               after the frame the core logged it in, and after one more look at the card file, so a write the game
//               made just before its eject reaches the page first.
// The log line is the core's (the room seat's core is pinned by digest, so it cannot change under the page); a core
// that words it differently simply posts no 'card-out', and the page then offers no automatic chooser.
const CARD_EJECT_LOG = /card_reader\.cpp[^\n]*Card ejected/;
let cardOutSeen = false;
let cardInHeld = false;
// The room's battery memory (room-nvmem.js; the room's board0 only). memoryGiven: the saved memory this board was
// started with (msg.memory), kept until the load has been checked against it. memoryReader: the between-frames
// reader (msg.memorySave), fed by the page's 'nvmem-read'. nvBuf: the 32 KB copy buffer in the core's heap.
let memoryGiven = null;
let memoryReader = null;
let nvBuf = 0;
// The battery RAM as the core holds it now (a copy), or null when the core gives none (an older core without the
// export, or no game loaded). No guest read and nothing charged to the guest clock (linkbus_shim.cpp).
function copyNvmem() {
  if (typeof Module._shim_nvmem_copy !== 'function') return null;
  if (!nvBuf) nvBuf = Module._malloc(NVMEM_BYTES);
  const n = Module._shim_nvmem_copy(nvBuf, NVMEM_BYTES) >>> 0;
  return n === NVMEM_BYTES ? Module.HEAPU8.slice(nvBuf, nvBuf + NVMEM_BYTES) : null;
}
// Race screen board (msg.present): { canvas, sync } and whether the last
// retro_run drew a new frame (the core's video refresh with a valid frame).
let present = null;
let rendered = false;
// This board's audio ring (msg.audio), or null. A posted race frame carries
// the ring's write index (aw) and the audio batches since the last frame
// (ab), so the page can line the picture up with its sound (diagnostics).
let audioRing = null;
let audioBatches = 0;
// Absolute time of the first linkbus post (slot frame, right after the
// vblank barrier) since the current retro_run began; 0 for none yet.
let firstPostAt = 0;
// Absolute time the current run first entered the vblank barrier (0 none).
let barrierAt = 0;
let tracking = false;

// After a retro_run on a race screen board: a newly drawn frame goes to the
// page with its frame count and sync index; nothing is posted for a run
// that drew nothing (the canvas would hand over an empty buffer). A failure
// here (a lost GPU context, say) drops that frame only: the board keeps
// emulating, failures are counted (present.failed) and the page gets one
// log line.
function postFrame(n) {
  if (!rendered) return;
  rendered = false;
  try {
    const bmp = present.canvas.transferToImageBitmap();
    const s = present.sync ? present.sync[1] + 1 : -1;
    const aw = audioRing ? audioRing.load(1) : -1;
    const ab = audioBatches;
    audioBatches = 0;
    self.postMessage({ type: 'frame', board: cfg.label, f: n, s, aw, ab, bmp }, [bmp]);
  } catch (err) {
    if (present.failed++ === 0) post('log', { text: `[board] a race frame was not handed over (frame ${n}); the board goes on: ${err && err.message ? err.message : err}` });
  }
}

function post(type, data = {}) {
  self.postMessage({ type, board: cfg ? cfg.label : '?', ...data });
}

function mkdirp(FS, path) {
  let cur = '';
  for (const part of path.split('/').filter(Boolean)) {
    cur += `/${part}`;
    try { FS.mkdir(cur); } catch { /* exists */ }
  }
}

function yieldTask() {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

function words(n) {
  return Array.from(Module.HEAPU32.subarray(buf >> 2, (buf >> 2) + n));
}

function stateHash() {
  if (!Module._shim_dbg_state_hash(buf)) return null;
  const w = words(8);
  return { ram: hex32(w[1]) + hex32(w[0]), regs: hex32(w[3]) + hex32(w[2]), pc: hex32(w[4]), cycles: w[7] * 4294967296 + w[6] };
}

function linkStatus() {
  Module._shim_lb_status(buf);
  const s = words(8);
  const out = { comm1: hex16(s[0]), comm2: hex16(s[1]), boardId: s[2], net: s[3], server: s[4], mbSlaves: s[5], multiboard: s[6], slave: s[7] };
  const k = Module._linkbus_ring_stats(buf);
  if (k > 0) {
    const r = words(k);
    out.ring = Object.fromEntries(RING_STAT_NAMES.map((name, i) => [name, r[i]]));
  }
  Module._linkbus_mb_stats(buf);
  const m = words(10);
  out.mb = { vblanks: m[0], vblankTimeout: m[1], vblankReleased: m[2], firstTimeout: m[3], secondTimeout: m[4],
    syncMismatch: m[5], nondeterministic: m[6] };
  if (hasCabinet()) out.bank = { syncs: m[7], hash: hex32(m[9]) + hex32(m[8]) };
  return out;
}

// LAB ONLY: Emscripten's instantiateWasm hook for the core module board0
// compiled (WebAssembly.Module, posted with the init message).
let labCoreUsed = false;
// LAB ONLY (msg.labFrameTime): the time this worker has spent blocked in
// Atomics.wait. Every wait of the core (the vblank barrier lb_vb_barrier,
// the multiboard barriers, the ring) is an EM_JS function that calls the
// global Atomics.wait at call time, so a timing wrapper sees them all. The
// wrapper is installed only under the flag (labTimeWaits); by default
// Atomics.wait is untouched and this stays 0.
let labWaitMs = 0;
// Wrapped once per worker, however often runBoard starts.
let labWaitsTimed = false;
function labTimeWaits() {
  if (labWaitsTimed) return;
  labWaitsTimed = true;
  const orig = Atomics.wait;
  Atomics.wait = function timedWait(...args) {
    const t = performance.now();
    try { return orig.apply(Atomics, args); } finally { labWaitMs += performance.now() - t; }
  };
}
// LAB ONLY (msg.labCoreShare, board0 under lb-cabinet.js labSharedCore): the
// core glue loads and compiles the core exactly as by default; this only
// watches WebAssembly's instantiate calls for the compiled module the glue
// gets back and posts it to the page once ('core-module'). Undone after
// the core is up.
function labWatchCoreCompile() {
  const W = WebAssembly;
  const orig = { instantiateStreaming: W.instantiateStreaming, instantiate: W.instantiate };
  let sent = false;
  const wrap = (fn) => function watched(...args) {
    return fn.apply(W, args).then((r) => {
      if (!sent && r && r.module instanceof W.Module) {
        sent = true;
        // A failed hand-over never fails this board: the page then gets
        // 'ready' with no module and every board compiles its own.
        try { self.postMessage({ type: 'core-module', board: cfg.label, module: r.module }); } catch { /* the page falls back */ }
      }
      return r;
    });
  };
  for (const k of Object.keys(orig)) if (typeof orig[k] === 'function') W[k] = wrap(orig[k]);
  return () => { for (const k of Object.keys(orig)) W[k] = orig[k]; };
}
// A failed instantiate rejects fail(): init fails loudly (an 'error' to the
// page) rather than waiting forever for the glue. There is no per-board
// fallback compile here: the host source may not load the core itself
// (policy.test.mjs, no network API in src), only the core glue does.
function labInstantiate(mod, fail) {
  return (imports, receiveInstance) => {
    WebAssembly.instantiate(mod, imports).then((inst) => { labCoreUsed = true; receiveInstance(inst, mod); })
      .catch((err) => fail(new Error(`shared core instantiate failed, this board does not start: ${err && err.message ? err.message : err}`)));
    return {};
  };
}

async function init(msg) {
  cfg = msg;
  // KNOWN-GOOD GAME FILES (game-check.js): a room seat's board (corePin), and a lab seat's that asks (gamePin),
  // checks the very bytes it is about to hand the core (msg.files, the copies this worker owns) against the pin
  // table, member by member, before the core is even loaded. So a file swapped between the page's own check and
  // this load is caught. A refusal posts 'game-refused' (which file, why; never a digest) and the board never
  // starts. The host's own boards and the lab cabinet carry neither flag: nothing is checked, as before.
  const checkEdition = boardCheckEdition(msg);
  if (checkEdition !== null) {
    let g;
    try { g = await checkGameFiles({ edition: checkEdition, files: msg.files, built: true, subtle: crypto.subtle }); } catch { g = { ok: false, which: 'game', why: 'unreadable', member: null, name: null }; }
    if (!g.ok) { post('game-refused', { which: g.which, why: g.why, name: g.name }); return false; }
  }
  // Race screen boards (msg.present, race-pair.js): the core draws into an
  // OffscreenCanvas of this worker, and every rendered frame goes to the page
  // as an ImageBitmap, which shows the two halves together. Other boards draw
  // into the page canvas they were handed (transferControlToOffscreen).
  // A board with no page canvas (msg.hidden: a seat nobody watches) draws
  // into a worker canvas that is never shown.
  const canvas = msg.present ? new OffscreenCanvas(msg.present.width || 640, msg.present.height || 480)
    : msg.hidden ? new OffscreenCanvas(640, 480) : msg.canvas;
  if (msg.present) {
    present = { canvas, sync: null, failed: 0 };
    // The board's own sync index in the snapshot bank (race-pair.js frame key).
    if (msg.cabinet && msg.bank !== 'live') present.sync = new Int32Array(msg.cabinet, syncHeaderOffset(msg.boardId), 4);
  }
  const coreArgs = {
    canvas,
    print: (t) => { logs.push(t); if (cfg.verbose) post('log', { text: t }); },
    printErr: (t) => { logs.push(t); if (cfg.verbose) post('log', { text: t }); },
    onCoreLog: (level, t) => { logs.push(t); if (cfg.verbose || level >= 3) post('log', { text: t }); if (cfg.readerEvents && CARD_EJECT_LOG.test(String(t))) cardOutSeen = true; },
    onRetroFrame: (valid) => { if (valid) rendered = true; },
  };
  if (msg.corePin) {
    // A room seat's board: the pinned core only. Any throw here (the load,
    // the core's own start) is a refusal the page ends the seat on.
    // The lab core sharing flags (labCore, labCoreShare) never apply here:
    // the pinned wasm is the checked bytes, never a module another board
    // compiled.
    try {
      const c = await loadPinnedCore({
        base: new URL('./core/', import.meta.url), edition: msg.corePin.edition, subtle: crypto.subtle,
        importFn: (u) => import(u),
        makeUrl: (bytes) => URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' })),
        revokeUrl: (u) => URL.revokeObjectURL(u),
      });
      if (!c.ok) { post('core-refused', { why: c.why }); return false; }
      Module = await c.create({ ...c.options, ...coreArgs });
    } catch { post('core-refused', { why: 'throw' }); return false; }
  } else {
    const createFlycastCore = (await import('./core/flycast_libretro.js')).default;
    // LAB ONLY (msg.labCore): rejected when the shared module cannot be instantiated.
    let labFail = null;
    const labFailed = msg.labCore ? new Promise((_, reject) => { labFail = reject; }) : null;
    const coreOptions = {
      ...coreArgs,
      // LAB ONLY (msg.labCore, lb-cabinet.js labSharedCore): the core module
      // board0's glue compiled from the same served file; this board only
      // instantiates it. Absent by default: the core glue loads and compiles
      // its own copy, as always.
      ...(msg.labCore ? { instantiateWasm: labInstantiate(msg.labCore, (e) => labFail(e)) } : {}),
    };
    const undoWatch = msg.labCoreShare ? labWatchCoreCompile() : null;
    try {
      Module = await (labFailed ? Promise.race([createFlycastCore(coreOptions), labFailed]) : createFlycastCore(coreOptions));
    } finally {
      if (undoWatch) undoWatch();
    }
    if (msg.labCore) post('log', { text: `[lab] core: ${labCoreUsed ? 'instantiated from the module board0 compiled' : 'the shared module was not used: the core glue compiled its own'}` });
  }
  Module.specialHTMLTargets['#screen'] = canvas;
  // No AudioContext in a worker: the core's worklet glue (audiostream.cpp
  // fly_worklet_push) then falls back to the libretro audio callback.
  // Its samples are dropped except on the player's seat (msg.audio, below).
  // Audio never feeds guest state.
  Module._flyAud = { failed: true };
  // The player's seat (msg.audio): the libretro audio callback pushes into a
  // shared ring that the page's AudioWorklet plays. Other seats are silent.
  if (msg.audio && msg.audio.buffer) {
    const ring = new AudioRing(msg.audio.buffer, msg.audio.capacityFrames);
    audioRing = ring;
    Module.onAudioBatch = (ptr, frames) => { audioBatches++; ring.push(Module.HEAP16.subarray(ptr >> 1, (ptr >> 1) + frames * 2), frames); };
  }
  Module.linkbus = {
    mailbox: msg.mailbox || undefined,
    cabinet: msg.cabinet || undefined,
    // The core posts linkbus-tx after every slot frame; only the partner
    // start request matters to the page.
    post: (m) => {
      if (tracking && firstPostAt === 0) firstPostAt = absNowMs();
      if (m && m.type === 'linkbus-start-partners') post('start-partners', { slaves: m.slaves });
    },
  };
  // Barrier entry time for the seat's late latch and the lab trace: the
  // core's vblank barrier glue (linkbus_web.cpp lb_vb_barrier) reads
  // Module.linkbus._vbI32 once per vblank, so an accessor on it marks the
  // moment this board reached its barrier. Timing only; the value it hands
  // back is the glue's own cached view. A core whose glue no longer reads it
  // simply gives no barrier times (the latch then keeps its start lead and
  // the hub's lateness reports).
  if (msg.seat >= 0 && ((msg.lateLatch && msg.pace) || msg.trace)) {
    let cached;
    Object.defineProperty(Module.linkbus, '_vbI32', {
      configurable: true,
      get() { if (tracking && barrierAt === 0) barrierAt = absNowMs(); return cached; },
      set(v) { cached = v; },
    });
  }
  for (const [name, bytes] of msg.files) {
    const u8 = new Uint8Array(bytes);
    if (BIOS.has(name.toLowerCase())) {
      const dir = `${FS_PATHS.system}/dc`;
      mkdirp(Module.FS, dir);
      Module.FS.writeFile(`${dir}/${name}`, u8);
    } else {
      mountRom(Module.FS, name, u8);
    }
  }
  const call = (name, ret, types, args) => Module.ccall(name, ret, types, args);
  for (const [k, v] of Object.entries(DEFAULT_CORE_OPTIONS)) call('shim_set_option', 'number', ['string', 'string'], [k, v]);
  for (const [k, v] of Object.entries(msg.options || {})) call('shim_set_option', 'number', ['string', 'string'], [k, v]);
  call('shim_set_dirs', null, ['string', 'string'], [FS_PATHS.system, FS_PATHS.save]);
  call('shim_set_gl_preserve', null, ['number'], [msg.preserve ? 1 : 0]);
  call('shim_init', 'number', [], []);
  Module._shim_set_lockstep(1);
  // dynarec 0: interpreter (no JIT modules; for browsers that cannot hold
  // six JIT cores, see tools/linked-run.mjs --dynarec).
  if (msg.dynarec === 0) Module._shim_set_dynarec(0);
  if (msg.pinTime !== undefined) Module._shim_dbg_pin_time(1, msg.pinTime);
  Module._shim_dbg_set_jit_det(msg.jitDet === undefined ? 1 : msg.jitDet);
  buf = Module._malloc(4096);
  if (msg.card) {
    const bytes = new Uint8Array(msg.card);
    const p = mountCard(Module.FS, FS_PATHS.save, msg.game, bytes);
    post('log', { text: `[board] card mounted at ${p}` });
    // watchCard: every change of the core's card file (a CARD_WRITE by the
    // game) goes to the page in game order, as a copy in memory. The page
    // hands it to the CardSource; nothing here stores it.
    if (msg.watchCard) {
      cardWatch = createCardWatcher(Module.FS, p, bytes, cardWriter(null));
    }
  } else if (msg.watchCard && msg.newCard === true) {
    // A NEW HORSE (the room seat, mp-seat.js): no card in the reader (no card file; card-store.js prepareNewCard).
    // The game's own new horse flow takes a new card from the reader and writes the horse onto it; that first
    // write, and every later one, goes to the page as any card write does.
    const p = prepareNewCard(Module.FS, FS_PATHS.save, msg.game);
    post('log', { text: `[board] no card in the reader (a new horse); watching ${p}` });
    cardWatch = createCardWatcher(Module.FS, p, null, cardWriter(null));
  }
  // The room's saved battery memory (msg.memory: { nvmem, eeprom }, the room's board0 only): written where the
  // core reads it when the game loads (room-nvmem.js mountMemory), as a card is. A fault here never stops the
  // board: it then boots from the game's own fresh memory, and the page is told.
  if (msg.memory && msg.memory.nvmem) {
    try {
      const given = { nvmem: new Uint8Array(msg.memory.nvmem), eeprom: msg.memory.eeprom ? new Uint8Array(msg.memory.eeprom) : null };
      mountMemory(Module.FS, FS_PATHS.save, msg.game, given);
      memoryGiven = given;
    } catch (err) {
      post('nvmem-restored', { ok: false, why: 'mount' });
      post('log', { text: `[board] saved memory not written; the game boots from fresh memory: ${err && err.message ? err.message : err}` });
    }
  }
  Module._shim_lb_configure(msg.boardId, 1, msg.actAsServer ? 1 : 0, msg.multiboardSlaves);
  if (msg.seat >= 0) {
    // Vblank sync: plain mailbox (take() never waits) plus the core's vblank
    // barrier, so every seat advances one guest vblank per hub round
    // (lb-hub-worker.js). Installed before the game loads, so it runs before
    // the comm board's own vblank listener.
    let rc = Module._linkbus_install_mailbox(msg.seat, msg.n, msg.edition, msg.sessionTag >>> 0, 0);
    if (rc !== 0) throw new Error(`linkbus_install_mailbox returned ${rc}`);
    rc = Module._linkbus_install_vblank_barrier(msg.barrierTimeoutMs || 10000);
    if (rc !== 0) throw new Error(`linkbus_install_vblank_barrier returned ${rc}`);
  }
  // Master pair: snapshot bank by default (deterministic; writes cross at
  // the sync points), or the live shared bank (bank=live, native timing).
  if (msg.cabinet && msg.bank === 'live') Module._linkbus_install_sab_multiboard();
  else if (msg.cabinet) Module._linkbus_install_sab_multiboard_snapshot();
  post('ready', { status: linkStatus() });
}

async function runBoard() {
  const msg = cfg;
  const loaded = Module.ccall('shim_load_game', 'number', ['string', 'string'], [`${FS_PATHS.roms}/${msg.game}`, '#screen']);
  if (loaded !== 1) { post('error', { message: `shim_load_game returned ${loaded}`, logs: logs.slice(-40) }); return; }
  post('loaded', { status: linkStatus() });
  // The saved memory, checked: the core read its battery RAM when the game loaded, so a copy taken now (before the
  // first frame) must be the bytes that were written. Not equal: the core read another file name, or none.
  if (memoryGiven) {
    const now = copyNvmem();
    const ok = !!now && sameBytes(now, memoryGiven.nvmem);
    post('nvmem-restored', { ok, why: ok ? null : now ? 'differs' : 'no copy', eeprom: !!memoryGiven.eeprom });
    memoryGiven = null;
  }
  // The room's memory saves (msg.memorySave: { raceWord }, the room's board0 only): the page asks ('nvmem-read')
  // and the read is taken between frames, kept only when two reads a few frames apart agree (room-nvmem.js).
  if (msg.memorySave) {
    memoryReader = createStableReader({ read: () => { const nvmem = copyNvmem(); return nvmem ? { nvmem, eeprom: readCoreEeprom(Module.FS, FS_PATHS.save, msg.game) } : null; } });
  }
  const memoryRaceWord = msg.memorySave && Number.isInteger(msg.memorySave.raceWord) ? msg.memorySave.raceWord : null;
  const ctl = new Int32Array(msg.ctl);
  const frameCounts = new Int32Array(msg.frameCounts);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const presses = msg.presses || [];
  // Live input (the player's seat): Int32 joypad masks for ports 0..3 and
  // their sticky pressed bits (seat-feel.js), written by the page.
  const live = msg.input ? new Int32Array(msg.input) : null;
  // Late latch (the player's seat on a paced cabinet): start each run just
  // before the hub releases its round, so the input it takes is fresh.
  // Wall-clock only: the frames and the inputs they read are unchanged.
  const pace = msg.pace ? new BigInt64Array(msg.pace) : null;
  const latch = pace && msg.lateLatch && msg.seat >= 0 ? createLateLatch() : null;
  // Lab timing trace (feel-trace.js), never on a player page.
  const trace = msg.trace ? new Float64Array(msg.trace) : null;
  tracking = !!(latch || trace);
  const yieldEvery = Math.max(1, msg.yieldEvery || 1);
  let runMs = 0;
  const tStart = performance.now();
  let nextDue = 0;
  const entryWatch = msg.entryWatch && msg.boardId === 0 && hasEntryWatch(msg.game) ? entryWatchFor(msg.n - 1, msg.game) : [];
  // LAB ONLY (msg.labWatch, lb-ram-diff.js): extra watched words of another
  // edition, reported as small values only, and the in-memory RAM differ.
  const lab = msg.labWatch || null;
  // LAB ONLY (msg.ownerWatch, the room debug page): the master also watches each station's runner records.
  const ownerWatch = msg.ownerWatch && msg.boardId === 0 ? ownerWatchFor(msg.n - 1, msg.game) : [];
  const baseWatch = [...gameWatchFor(msg.game), ...(msg.netWatch ? [['net_err', NET_ERR]] : []), ...entryWatch, ...ownerWatch];
  const labWords = lab && lab.words ? checkLabWords(lab.words, [...baseWatch.map((w) => w[0]), 'wd_max']) : [];
  const watch = [...baseWatch, ...labWords];
  const labFrom = baseWatch.length;
  const differ = lab && lab.ramDiff ? createRamDiffer(lab.ramDiff, (a) => Module._shim_dbg_ram_word(a & 0x1ffffff), watch.map((w) => w[0])) : null;
  if (differ) post('log', { text: `[lab] ram differ armed: ${differ.words} words` });
  const sizedI32 = entryWatch.length && msg.netStatus ? new Int32Array(msg.netStatus) : null;
  const sizedPrev = sizedI32 ? new Array(msg.n).fill(null) : null;
  const prev = watch.map(() => null);
  // Race telemetry (msg.telemetry, board0 only; mp-race-telemetry.js): every `every` frames the listed RAM words go
  // out as one message. motion: [x word, z word] pairs (floats) checked EVERY frame, so a runner that stands still
  // for a frame while it was moving, or covers far more than its usual step, is counted between two messages
  // (running totals). Addresses only come in; numbers only go out.
  const tel = msg.telemetry && msg.boardId === 0 && Array.isArray(msg.telemetry.words) ? msg.telemetry : null;
  const telEvery = tel ? Math.max(1, Math.min(600, tel.every | 0 || 6)) : 0;
  const telMotion = tel && Array.isArray(tel.motion) ? tel.motion : [];
  const telF32 = new Float32Array(1); const telU32 = new Uint32Array(telF32.buffer);
  const asFloat = (u) => { telU32[0] = u; return telF32[0]; };
  const mo = telMotion.map(() => ({ x: NaN, z: NaN, step: 0, age: 999, still: 0, jump: 0, moved: 0 }));
  // edges: [word, bit mask] pairs; each frame in which the masked bits go from clear to set is counted.
  const telEdges = tel && Array.isArray(tel.edges) ? tel.edges : [];
  const ed = telEdges.map(() => ({ on: false, n: 0 }));
  // THE CARE RECORDER (msg.careWatch, a player's seat; care-recorder.js): what the player chose in the care scenes.
  // Its words are read once a frame, after the frame, exactly as the watched words above: shim_dbg_ram_word copies
  // one word out of the core's RAM array (host/shim/debug_state_shim.cpp: a memcpy, no guest read, nothing charged
  // to the guest clock), so reading them changes nothing in the game. Never the core's wasm_mem_read exports: those
  // go through the guest's memory handlers and add a read penalty to the guest clock. Rev C only (no words for
  // another game: nothing is read). Only events go to the page ('care'), with the recorder's counters.
  const careWords = msg.careWatch ? careWordsFor(msg.game) : [];
  const care = careWords.length ? createCareRecorder() : null;
  const careVals = care ? new Array(careWords.length).fill(0) : null;
  let wdMax = 0;
  let changes = [];
  let flushWatch = false;
  // Seats: guest vblank count (vblank barrier), recorded with each watched change.
  const vbI32 = msg.mailbox ? new Int32Array(msg.mailbox, 0, 16) : null;
  // LAB ONLY (msg.labFrameTime, lb-frame-time.js): the run call's time per
  // frame, one record per second on the watch message. Null by default:
  // nothing kept, nothing posted.
  const ft = msg.labFrameTime ? createFrameTimeAgg() : null;
  if (ft) labTimeWaits();
  // A partial second goes out when the loop ends (stop or error).
  const flushFt = () => { const r = ft ? ft.flush() : null; if (r) post('watch', { changes: [], ft: r }); };
  let w0 = 0;
  let vbBefore = null;
  frameLoopOn = true;
  for (let f = 0; ; f++) {
    if (Atomics.load(ctl, 0)) break;
    let dueAbs = 0;
    if (latch || trace) {
      const clock = pace ? readPaceClock(pace) : null;
      // The next barrier this run reaches is vblank vb + 1, released at
      // t0 + (vb + 1) * period.
      if (clock && vbI32) dueAbs = clock.t0Ms + (Atomics.load(vbI32, 8) + 1) * clock.periodMs;
    }
    if (latch && dueAbs > 0) {
      const wait = latch.nextStart(dueAbs) - absNowMs();
      if (wait > 0.2 && wait < 40) {
        latch.stats.waits++;
        latch.stats.waitMs += wait;
        Atomics.wait(sleeper, 0, 0, wait);
      }
    }
    let mask = 0;
    for (const [from, to, m] of presses) if (f >= from && f < to) mask |= m;
    if (live) mask |= takeInputMask(live, 0);
    const insertNow = (mask & CARD_PRESS_MASK) !== 0;
    if (insertNow && !insertHeld && cardWatch) insertBase = cardWatch.changes();
    insertHeld = insertNow;
    if (ejectPress && ejectPress.left > 0) { mask |= ejectPress.mask; ejectPress.left--; }
    Module._shim_set_input(0, mask);
    if (vbI32) Atomics.store(vbI32, MB_INPUT_MASK_WORD, mask);
    // The room seat hears the insert button's rising edge (insertNow: read before the eject save's own press is added).
    if (insertNow && !cardInHeld && msg.readerEvents) post('card-in', { f, ...(cardGen === null ? {} : { gen: cardGen }) });
    cardInHeld = insertNow;
    for (let p = 1; p < 4; p++) Module._shim_set_input(p, live ? takeInputMask(live, p) : 0);
    // The feel trace's vblank at the frame start (-1 with no mailbox).
    const vbStart = vbI32 ? Atomics.load(vbI32, 8) : -1;
    firstPostAt = 0;
    barrierAt = 0;
    const startAbs = tracking ? absNowMs() : 0;
    if (ft) { w0 = labWaitMs; vbBefore = vbI32 ? Atomics.load(vbI32, 8) : null; }
    const t0 = performance.now();
    try {
      Module._shim_run_frame();
    } catch (err) {
      // On stop the page releases the barriers and asks the partner to
      // exit (multiboard "Slave exit"): not an error.
      if (Atomics.load(ctl, 0)) break;
      flushFt();
      post('error', { message: `retro_run threw at frame ${f}: ${err && err.stack ? err.stack : err}`, logs: logs.slice(-40) });
      return;
    }
    const dt = performance.now() - t0;
    runMs += dt;
    if (ft) {
      const vbNow = vbI32 ? Atomics.load(vbI32, 8) : null;
      const rec = ft.add(dt, t0 + dt, { f: f + 1, vb: vbNow, waitMs: labWaitMs - w0, vblanks: vbNow === null ? null : vbNow - vbBefore });
      if (rec) post('watch', { changes: [], ft: rec });
    }
    if (latch) latch.update({ preMs: barrierAt > 0 ? barrierAt - startAbs : NaN, lateMs: dueAbs > 0 ? readSeatLate(pace, msg.seat) : NaN });
    if (trace) traceWrite(trace, [f + 1, startAbs, absNowMs(), firstPostAt, mask, vbStart, dueAbs, latch ? latch.leadMs : -1, barrierAt]);
    if (present) postFrame(f + 1);
    if (cardWatch && (f + 1) % 30 === 0) cardWatch.poll();
    // The game ejected the card in this frame (the core's log): the card file's last look, then the page is told.
    if (cardOutSeen) { cardOutSeen = false; if (cardWatch) cardWatch.poll(); post('card-out', { f: f + 1, writes: cardWatch ? cardWatch.changes() : 0, ...(cardGen === null ? {} : { gen: cardGen }) }); }
    if (memoryReader && memoryReader.pending) {
      const r = memoryReader.step(f + 1);
      if (r && r.ok) {
        const gameRace = memoryRaceWord === null ? null : Module._shim_dbg_ram_word(memoryRaceWord & 0x1ffffff) | 0;
        self.postMessage({ type: 'nvmem', board: cfg.label, ok: true, tag: r.tag, f: r.frame, tries: r.tries, gameRace, nvmem: r.nvmem.buffer, eeprom: r.eeprom ? r.eeprom.buffer : null }, r.eeprom ? [r.nvmem.buffer, r.eeprom.buffer] : [r.nvmem.buffer]);
      } else if (r) post('nvmem', { ok: false, tag: r.tag, f: r.frame, why: r.why });
    }
    Atomics.store(frameCounts, msg.index, f + 1);
    Atomics.notify(frameCounts, msg.index);
    const n = f + 1;
    for (let k = 0; k < watch.length; k++) {
      const raw = Module._shim_dbg_ram_word(watch[k][1] & 0x1ffffff) >>> 0;
      const v = k >= labFrom ? field(raw, watch[k][2], watch[k][3]) : raw;
      if (v !== prev[k]) {
        // A word trigger matches a change, never the first reading.
        const first = prev[k] === null;
        prev[k] = v;
        const c = [n, watch[k][0], k >= labFrom ? small(v) : v, vbI32 ? Atomics.load(vbI32, 8) : null];
        if (differ && !first) differ.onChange(watch[k][0], v, n);
        if (watch[k][0] === 'state') {
          flushWatch = true;
          // The room's entry latch: the hub's sized-frame counts as of the
          // end of the previous frame, the frame whose RX words the latch
          // reads (mp-entry-watch.js freshSlots).
          if (sizedPrev) c.push(sizedPrev.slice());
        }
        changes.push(c);
      }
    }
    if (differ && !differ.done()) for (const r of differ.onFrame(n)) post('ramdiff', r);
    if (care) {
      for (let k = 0; k < careWords.length; k++) careVals[k] = Module._shim_dbg_ram_word(careWords[k][1] & 0x1ffffff) >>> 0;
      const events = care.frame(n, careVals);
      if (events.length) post('care', { events, stats: care.stats() });
    }
    if (tel) {
      for (let i = 0; i < telMotion.length; i++) {
        const m = mo[i];
        const x = asFloat(Module._shim_dbg_ram_word(telMotion[i][0] & 0x1ffffff) >>> 0);
        const z = asFloat(Module._shim_dbg_ram_word(telMotion[i][1] & 0x1ffffff) >>> 0);
        const d = Math.hypot(x - m.x, z - m.z);
        if (d > 0 && Number.isFinite(d)) {
          // A step past 1.7 times the usual one, straight after standing still or not: a jump. Past 50 times: a
          // placement (the start gate, a new race), not counted.
          if (m.step > 0 && m.age <= 30 && d > 1.7 * m.step && d < 50 * m.step) m.jump++;
          // The usual step follows every move (a jump too, lightly), so a wrong first value cannot stick.
          m.step = m.step > 0 && m.age <= 30 && d < 50 * m.step ? m.step * 0.9 + d * 0.1 : d;
          m.moved++;
          m.age = 0;
        } else if (m.age < 999) { m.age++; if (m.age <= 30) m.still++; }
        m.x = x; m.z = z;
      }
      for (let i = 0; i < telEdges.length; i++) {
        const on = ((Module._shim_dbg_ram_word(telEdges[i][0] & 0x1ffffff) >>> 0) & telEdges[i][1]) !== 0;
        if (on && !ed[i].on) ed[i].n++;
        ed[i].on = on;
      }
      if (n % telEvery === 0) {
        const words = new Array(tel.words.length);
        for (let i = 0; i < words.length; i++) words[i] = Module._shim_dbg_ram_word(tel.words[i] & 0x1ffffff) >>> 0;
        post('telemetry', { f: n, vb: vbI32 ? Atomics.load(vbI32, 8) : null, words, still: mo.map((m) => m.still), jump: mo.map((m) => m.jump), moved: mo.map((m) => m.moved), edges: ed.map((e) => e.n) });
      }
    }
    if (msg.netWatch) {
      const wd = Module._shim_dbg_ram_word(WD_COUNT & 0x1ffffff) >>> 0;
      if (wd > wdMax) wdMax = wd;
      if (n % 60 === 0) { if (wdMax > 1) changes.push([n, 'wd_max', wdMax, vbI32 ? Atomics.load(vbI32, 8) : null]); wdMax = 0; }
    }
    // A STATE change goes out at once (the room's entry latch; its counts
    // travel with the change as sizedAt).
    if (sizedPrev) for (let i = 0; i < msg.n; i++) sizedPrev[i] = Atomics.load(sizedI32, NET_STATUS.sized + i);
    if (changes.length && (n % 60 === 0 || changes.length > 200 || flushWatch)) { post('watch', { changes }); changes = []; flushWatch = false; }
    if (n <= msg.frames && (n % msg.hashEvery === 0 || n === msg.frames)) {
      post('sample', { f: n, hash: stateHash(), status: linkStatus(), runMs, wallMs: performance.now() - tStart });
    }
    if (n === msg.frames) post('done', { f: n, hash: stateHash(), status: linkStatus(), runMs, wallMs: performance.now() - tStart });
    if (msg.realtimeHz > 0) {
      // Unlinked boards pace themselves; linked boards are paced by the hub.
      const period = 1000 / msg.realtimeHz;
      if (nextDue === 0) nextDue = performance.now();
      nextDue += period;
      const left = nextDue - performance.now();
      if (left > 0.05) Atomics.wait(sleeper, 0, 0, left);
      else if (left < -100) nextDue = performance.now();
    }
    if (n % yieldEvery === 0) await yieldTask(); // lets the OffscreenCanvas commit
  }
  frameLoopOn = false;
  flushFt();
  post('stopped', { status: linkStatus() });
}

// The eject save's slot steps 0 and 1 (mp-seat-eject.js cardEjectSteps).
async function cardEject(m) {
  if (ejecting) return { out: false, pressed: 0, why: 'busy' };
  ejecting = true;
  try {
    const int = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
    return await cardEjectSteps({
      watcher: cardWatch,
      // The stint's insert: the mount (0), or the last insert press seen; the
      // game writes the card back only on its eject (jp-close-grace.md section 1).
      insertBase,
      press: (mask, left) => { ejectPress = { mask, left }; },
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => performance.now(),
      mask: int(m.mask, 1, 0xffff, 0), holdFrames: int(m.holdFrames, 1, 60, 1),
      pollMs: int(m.pollMs, 50, 2000, 500), timeoutMs: int(m.timeoutMs, 0, 20000, 10000),
    });
  } finally { ejecting = false; ejectPress = null; }
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      initDone = init(m);
      const ok = await initDone;
      if (m.autoStart && ok !== false) await runBoard();
    } else if (m.type === 'go') {
      // The partner's go can arrive while its init is still awaiting the core.
      if (!initDone) throw new Error('go before init');
      if (await initDone === false) return;
      await runBoard();
    } else if (m.type === 'card-final') {
      // Before the page ejects: one last look at the card file, then a reply
      // (after any card-write it caused, so the page sees them in order).
      const changed = cardWatch ? cardWatch.poll() : false;
      post('card-final', { changed, writes: cardWatch ? cardWatch.changes() : 0 });
    } else if (m.type === 'card-swap') {
      post('card-swap', cardSwap(m));
    } else if (m.type === 'card-base') {
      if (cardWatch) { cardWatch.poll(); insertBase = cardWatch.changes(); }
      post('card-base', { base: insertBase });
    } else if (m.type === 'card-eject') {
      post('card-eject', await cardEject(m));
    } else if (m.type === 'nvmem-read') {
      // The room page asks for the battery memory (room-nvmem.js): taken by the frame loop, `after` frames on.
      if (memoryReader) memoryReader.request({ tag: m.tag ?? null, after: Number.isInteger(m.after) && m.after >= 0 && m.after <= 3600 ? m.after : undefined });
      else post('nvmem', { ok: false, tag: m.tag ?? null, f: null, why: 'off' });
    } else if (m.type === 'hang-peek') {
      // The room's hang dump (mp-hang-dump.js): this board's status words (a fixed list there, Rev C only), its
      // program counter and its state hashes, read between two frames. Read only: shim_dbg_ram_word copies a word out
      // of the core's RAM array and the hash is the one every sample already takes; nothing is written.
      post('hang-peek', { id: m.id, ...hangPeekReply({ game: cfg && cfg.game, running: frameLoopOn, word: (a) => Module._shim_dbg_ram_word(a & 0x1ffffff), hash: stateHash }) });
    } else if (m.type === 'shot') {
      post('shot', { status: linkStatus() });
    }
  } catch (err) {
    post('error', { message: String(err && err.stack ? err.stack : err), logs: logs.slice(-40) });
  }
};
