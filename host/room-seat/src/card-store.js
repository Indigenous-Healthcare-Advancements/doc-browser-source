// card-store.js: lab horse cards for the Sanwa CRP-1231 card reader that
// Flycast emulates for Derby Owners Club (core/hw/naomi/card_reader.cpp).
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// A card is the reader's three magnetic tracks, 3 x 0x45 = 207 bytes. The
// core reads and writes it as <save>/reicast/<game file name>.card: it
// loads the file when the insert button goes down (CardReaderWriter::
// insertCard) and rewrites it after every CARD_WRITE command. This module
// keeps the player's picked card in the browser's Origin Private File
// System (folder "cards"), copies it into the core's file system before
// boot, and saves the card the game wrote back into the same OPFS folder.
// Nothing here uses the network (test/policy.test.mjs).

export const CARD_DIR_NAME = 'cards';
export const CARD_TRACK_BYTES = 0x45;
export const CARD_BYTES = CARD_TRACK_BYTES * 3; // 207
export const CARD_EXTENSION = '.card';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;

// Returns null when the name is acceptable, or a short reason string.
export function checkCardName(name) {
  if (typeof name !== 'string' || name.length === 0) return 'empty name';
  if (name.includes('/') || name.includes('\\')) return 'path separators not allowed';
  if (name.includes('..')) return 'dot segments not allowed';
  if (!NAME_RE.test(name)) return 'unsupported characters';
  if (!name.toLowerCase().endsWith(CARD_EXTENSION)) return 'not a .card file';
  return null;
}

export function checkCardSize(size) {
  if (size !== CARD_BYTES) return `a card file is ${CARD_BYTES} bytes, this one is ${size}`;
  return null;
}

// Where the core looks for the card: Flycast's libretro build sets the
// arcade flash base to <save dir>/reicast/<content file name> (extension
// kept), and the card reader appends ".card".
export function coreCardPath(saveDir, gameFileName) {
  if (typeof gameFileName !== 'string' || gameFileName.includes('/') || gameFileName.includes('..')) {
    throw new Error('bad game file name');
  }
  return `${saveDir}/reicast/${gameFileName}${CARD_EXTENSION}`;
}

function mkdirp(FS, path) {
  let cur = '';
  for (const part of path.split('/').filter(Boolean)) {
    cur += `/${part}`;
    try { FS.mkdir(cur); } catch { /* exists */ }
  }
}

// Copies card bytes into the core's in-memory FS (Emscripten Module.FS).
export function mountCard(FS, saveDir, gameFileName, bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('card bytes must be a Uint8Array');
  const sizeErr = checkCardSize(bytes.length);
  if (sizeErr) throw new Error(sizeErr);
  const path = coreCardPath(saveDir, gameFileName);
  mkdirp(FS, path.slice(0, path.lastIndexOf('/')));
  FS.writeFile(path, bytes);
  return path;
}

// A NEW HORSE: no card is put in the reader. The core's reader then holds no card (CardReaderWriter::insertCard
// finds no file and stays empty), and the game's own new horse flow asks the reader for a new card from its stock
// (the Sanwa reader's "new card" command, CARD_NEW, which the core answers with a card present and no file read),
// then writes the horse onto it: CARD_WRITE makes the card file (saveCard, fopen "wb"). So "no card" is NO FILE at
// the card path; there are no blank card bytes to make up, and none are written here. This only makes the folder
// the core will write into and returns the path to watch (createCardWatcher with no initial bytes: the first
// write is the new card). A file already there would be taken for the new horse's card, so it is refused.
export function prepareNewCard(FS, saveDir, gameFileName) {
  const path = coreCardPath(saveDir, gameFileName);
  mkdirp(FS, path.slice(0, path.lastIndexOf('/')));
  if (readCoreCard(FS, path) !== null) throw new Error('a card file is already in the reader');
  return path;
}

// Reads the card file back from the core's FS; null when there is none.
export function readCoreCard(FS, path) {
  try {
    return FS.readFile(path);
  } catch {
    return null;
  }
}

export function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Watches the core's card file and calls onChange(bytes) once per change.
// poll() is cheap (one 207-byte MEMFS read) and is called every few frames.
export function createCardWatcher(FS, path, initial, onChange) {
  let last = initial ? new Uint8Array(initial) : null;
  let changes = 0;
  return {
    poll() {
      const now = readCoreCard(FS, path);
      // A zero-length read (the file mid-rewrite, or emptied) is no card.
      if (!now || now.length === 0 || sameBytes(now, last)) return false;
      last = new Uint8Array(now);
      changes++;
      onChange(last);
      return true;
    },
    changes: () => changes,
    current: () => (last ? new Uint8Array(last) : null),
  };
}

// CHANGING THE CARD IN THE READER WHILE THE BOARD RUNS (the room seat's horse change; lb-board-worker.js
// 'card-swap'). The card in the reader is the file at the core's card path, and the core reads that file only when
// the insert button goes down, so the file can be changed between two frames:
//   1. one LAST poll of the old watcher: a change the game made to the old card is reported through the OLD
//      watcher's own onChange (so the page gets it under the old card's generation), before anything is touched;
//   2. the new card is written at the path (bytes), or the file is REMOVED (bytes null: an empty reader, for a new
//      horse the member makes in the game), or left as it is (adopt: the card the game itself wrote there is taken
//      as the new generation's);
//   3. a NEW watcher starts with the new bytes as its baseline, so the mount itself is never reported as a write.
//      With no bytes its baseline is "no card": the first card the game writes is the new card. With adopt the
//      baseline is also "no card", so the card already in the reader is reported ONCE, by the new watcher's first
//      poll, as the new generation's first write.
// Returns { path, watcher, lastChanged (step 1 reported a change), removed (a file was taken out) }. A card of the
// wrong size is refused before anything changes (the old watcher is still polled first: that is always safe).
export function swapCoreCard(FS, saveDir, gameFileName, oldWatcher, bytes, onChange, { adopt = false } = {}) {
  const path = coreCardPath(saveDir, gameFileName);
  if (bytes !== null && bytes !== undefined) {
    if (!(bytes instanceof Uint8Array)) throw new Error('card bytes must be a Uint8Array');
    const sizeErr = checkCardSize(bytes.length);
    if (sizeErr) throw new Error(sizeErr);
  }
  const lastChanged = oldWatcher ? oldWatcher.poll() : false;
  let removed = false;
  if (bytes) mountCard(FS, saveDir, gameFileName, bytes);
  else {
    mkdirp(FS, path.slice(0, path.lastIndexOf('/')));
    if (!adopt && readCoreCard(FS, path) !== null) {
      FS.unlink(path);
      if (readCoreCard(FS, path) !== null) throw new Error('the card could not be taken out of the reader');
      removed = true;
    }
  }
  return { path, watcher: createCardWatcher(FS, path, bytes || null, onChange), lastChanged, removed };
}

function defaultGetRoot() {
  const nav = globalThis.navigator;
  if (!nav || !nav.storage || typeof nav.storage.getDirectory !== 'function') {
    throw new Error('OPFS is not available in this browser');
  }
  return nav.storage.getDirectory();
}

// createCardStore({ getRoot }): OPFS folder "cards". Same shape as the ROM
// store, but cards are small and are written back by the page.
export function createCardStore(options = {}) {
  const getRoot = options.getRoot || defaultGetRoot;

  async function dir() {
    const root = await getRoot();
    return root.getDirectoryHandle(CARD_DIR_NAME, { create: true });
  }

  async function write(name, bytes) {
    const nameErr = checkCardName(name);
    if (nameErr) throw new Error(`rejected ${name}: ${nameErr}`);
    const sizeErr = checkCardSize(bytes.length);
    if (sizeErr) throw new Error(`rejected ${name}: ${sizeErr}`);
    const d = await dir();
    const handle = await d.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes);
      await writable.close();
    } catch (err) {
      if (typeof writable.abort === 'function') await writable.abort();
      throw err;
    }
    return { name, size: bytes.length };
  }

  // file: a File or Blob with .name and .size, from <input type=file>.
  async function save(file) {
    if (!file) throw new Error('no file');
    const nameErr = checkCardName(file.name);
    if (nameErr) throw new Error(`rejected ${file.name}: ${nameErr}`);
    const sizeErr = checkCardSize(file.size);
    if (sizeErr) throw new Error(`rejected ${file.name}: ${sizeErr}`);
    return write(file.name, new Uint8Array(await file.arrayBuffer()));
  }

  async function list() {
    const d = await dir();
    const out = [];
    for await (const [name, handle] of d.entries()) {
      if (handle.kind !== 'file' || checkCardName(name)) continue;
      const f = await handle.getFile();
      out.push({ name, size: f.size });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async function read(name) {
    const nameErr = checkCardName(name);
    if (nameErr) throw new Error(`bad name ${name}: ${nameErr}`);
    const d = await dir();
    const f = await (await d.getFileHandle(name)).getFile();
    return new Uint8Array(await f.arrayBuffer());
  }

  async function remove(name) {
    const nameErr = checkCardName(name);
    if (nameErr) throw new Error(`bad name ${name}: ${nameErr}`);
    await (await dir()).removeEntry(name);
  }

  return { save, write, list, read, remove };
}

// CardSource: where the host's card reader gets its card and where the
// game's card writes go. The host only calls this interface:
//   insert(): Promise<Uint8Array>  the 207-byte card to put in the reader
//   write(bytes): Promise<void>     called after every card write by the game
//   eject(): Promise<void>          the card leaves the reader
// Only LocalLabCardSource exists now (dev only: a lab card the developer
// stored in this browser; writes stay in browser storage). A later
// StableCardSource will load and save cards through the stable management
// service, so nothing here assumes a file picker, and the page never offers
// card bytes for download.
export function createLocalLabCardSource({ store, name }) {
  const nameErr = checkCardName(name);
  if (nameErr) throw new Error(`bad card name ${name}: ${nameErr}`);
  let saving = Promise.resolve();
  return {
    kind: 'local-lab',
    name,
    async insert() {
      const bytes = await store.read(name);
      const sizeErr = checkCardSize(bytes.length);
      if (sizeErr) throw new Error(sizeErr);
      return bytes;
    },
    // Writes run one after another, so the last write always wins.
    write(bytes) {
      const copy = new Uint8Array(bytes);
      saving = saving.then(() => store.write(name, copy));
      return saving;
    },
    async eject() { await saving; },
  };
}
