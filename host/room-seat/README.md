# Room seat page

Copyright (C) 2026 John R Reeves III. GPL-2.0-or-later.

The page a player opens to take one seat in a shared room: the player's own
game board runs in the player's browser and is linked to a room that runs the
rest of the cabinet. This folder is the page exactly as it is served, copied
from doc-web commit 8d39654 (8d39654e1c7558e1bcd157129c4b4ebbe3b46b2f,
2026-11-26): the page and 54 modules. There is no build step; the modules are
served as written.

## Served layout

| Deployed path | From this folder |
|---|---|
| the seat page | `mp-seat.html` |
| `src/*.js` | `src/*.js` |
| `src/core/flycast_libretro.{js,wasm}` | the five-board core linked with the `shim_nvmem_copy` export (`../../SOURCE.md` section 9); `src/core-pin.js` holds its two SHA-256 digests and the page refuses any other core |

The page needs cross-origin isolation (COOP `same-origin`, COEP
`require-corp`) for SharedArrayBuffer.

## What is here

| Files | Contents |
|---|---|
| `mp-seat.html`, `src/mp-seat.js` | the page: the link to the room, the game board, the waiting card, the card slot |
| `src/mp-seat-link-worker.js`, `src/mp-wire.js`, `src/mp-rtc.js`, `src/mp-lan.js`, `src/mp-public.js`, `src/mp-netem.js`, `src/mp-shadow-log.js` | the link between the seat and the room |
| `src/lb-*.js`, `src/core-bridge.js`, `src/core-pin.js`, `src/race-pair.js`, `src/mp-hang-dump.js`, `src/room-nvmem.js` | the game board worker and the core it loads; the board worker also carries two read only helpers the room's own boards use (a word dump when a room stalls, and the copy of the battery memory), which a seat never calls |
| `src/room-*.js`, `src/seat-*.js`, `src/input-map.js`, `src/feel-trace.js`, `src/mp-seat-auto.js`, `src/mp-seat-eject.js`, `src/mp-entry-watch.js`, `src/care-recorder.js` | input, the touch pad and the phone layout, the main screen view, the seat's sound (`src/room-seat-audio.js`, `src/audio-worklet.js`), the seat's lease, card saves, changing horses without leaving the seat, the notices when a lease is closing or the room restarts, and the watch on the game's own state |
| `src/rom-store.js`, `src/mp-game-cache.js`, `src/card-store.js`, `src/audio-ring.js`, `src/editions.js`, `src/lab-game-set.js`, `src/edition-b.js`, `src/edition-b-spec.js`, `src/game-check.js`, `src/game-pin.js` | the player's game file store, the check that the player's files are known-good ones, the card store and the edition registry |
| `src/room-seat-report.js` | "Report a problem": when the player presses Send, one POST to the page's own origin with a small picture of the player's game screen, the seat's connection figures and its recent log; never game files, memory, card bytes, tokens or addresses (the module's header lists what is and is not sent) |

Several modules share a name with a module in `../src/` (the single page game
at `/pilot`). They are kept apart because the two pages are released
separately and each folder matches what its page serves.

The player supplies the game files, which stay in the browser. Nothing here
contains game data. `src/edition-b-spec.js` carries the two SHA-256 checks
described in `../README.md`. `src/mp-entry-watch.js`, `src/lb-board-worker.js`
and `src/lb-ram-diff.js` name memory addresses the page reads in the running
game (for example the game's phase and whether a seat has entered a race);
they are addresses only, with no bytes of the game.
`src/care-recorder.js` and `src/mp-hang-dump.js` do the same. `src/game-pin.js` is a table
of the standard game and BIOS file members by name, size, CRC32 and SHA-256
digest, so the page can refuse a file it does not know; digests identify a
file and are not game data.
