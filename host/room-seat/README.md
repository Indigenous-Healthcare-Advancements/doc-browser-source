# Room seat page

Copyright (C) 2026 John R Reeves III. GPL-2.0-or-later.

The page a player opens to take one seat in a shared room: the player's own
game board runs in the player's browser and is linked to a room that runs the
rest of the cabinet. This folder is the page exactly as it is served, copied
from doc-web commit 537364b (2026-11-22). There is no build step; the modules
are served as written.

## Served layout

| Deployed path | From this folder |
|---|---|
| the seat page | `mp-seat.html` |
| `src/*.js` | `src/*.js` |
| `src/core/flycast_libretro.{js,wasm}` | the five-board core of release `web-2026.11.05-1` (`../../SOURCE.md`); `src/core-pin.js` holds its two SHA-256 digests and the page refuses any other core |

The page needs cross-origin isolation (COOP `same-origin`, COEP
`require-corp`) for SharedArrayBuffer.

## What is here

| Files | Contents |
|---|---|
| `mp-seat.html`, `src/mp-seat.js` | the page: the link to the room, the game board, the waiting card, the card slot |
| `src/mp-seat-link-worker.js`, `src/mp-wire.js`, `src/mp-rtc.js`, `src/mp-lan.js`, `src/mp-public.js`, `src/mp-netem.js`, `src/mp-shadow-log.js` | the link between the seat and the room |
| `src/lb-*.js`, `src/core-bridge.js`, `src/core-pin.js`, `src/race-pair.js` | the game board worker and the core it loads |
| `src/room-*.js`, `src/seat-*.js`, `src/input-map.js`, `src/feel-trace.js`, `src/mp-seat-auto.js`, `src/mp-seat-eject.js`, `src/mp-entry-watch.js` | input, the touch pad, the main screen view, the seat's lease, card saves, and the watch on the game's own state |
| `src/rom-store.js`, `src/mp-game-cache.js`, `src/card-store.js`, `src/audio-ring.js`, `src/editions.js`, `src/lab-game-set.js`, `src/edition-b.js`, `src/edition-b-spec.js` | the player's game file store, the card store and the edition registry |

Several modules share a name with a module in `../src/` (the single page game
at `/pilot`). They are kept apart because the two pages are released
separately and each folder matches what its page serves.

The player supplies the game files, which stay in the browser. Nothing here
contains game data. `src/edition-b-spec.js` carries the two SHA-256 checks
described in `../README.md`. `src/mp-entry-watch.js`, `src/lb-board-worker.js`
and `src/lb-ram-diff.js` name memory addresses the page reads in the running
game (for example the game's phase and whether a seat has entered a race);
they are addresses only, with no bytes of the game.
