// mp-seat-eject.js: the seat's eject save when its lease is closing (L2,
// doc-arcade docs/rooms/jp-close-grace.md section 4), asked by the room
// (T.eject). Pure: the seat page (mp-seat.js) gives it the board call and
// its leave; the board worker (lb-board-worker.js 'card-eject') presses.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Section 4, "What the seat does":
//   "0. Read the slot. If the card file is present, it is the card. No press is needed.
//    1. Otherwise, press CARD and poll the slot every 0.5 s, for up to 10 s.
//    ...
//    3. Before posting, persist the ejected bytes in the tab (IndexedDB, keyed by lease and seq).
//    4. Post the room write: the lease, the next seq, and the nonce of the stint's last race.
//    5. Then close."
// Section 1: "The card is written back only on the IN-GAME eject (the CARD
// press), never after each race." In this core the card file stays in the
// board's file system all along (flycast reads it at insert and rewrites it
// on the game's CARD_WRITE), so "the slot holds the card" is read as "the
// game wrote the card back since the board last reported it" (the board
// worker's step 0), and "poll the slot" as "poll for that write-back". Steps
// 3 and 4 (persist in the tab, then the room write with the next seq and the
// stint's last race nonce) are NOT done here: they belong to the seat
// hand-off contract (heartbeat, checkout, saves, close, TURN retry), which
// doc-web owns in its own round. Here every
// card write the board makes goes up the link to the lab room's desk
// (mp-room.js), and the seat's leave('finish') then closes (step 5).
// Rev C keeps today's behaviour: its card file is present all along and each
// race has its own save, so no press: leave('finish') alone.
//
// NOTE (2026-11-09): this header and cardEjectSteps predate lab run 4
// (2026-11-08, run after this file's last change) and are superseded by
// docs/seat-1d-plan.md section 11. Run 4 measured, on DOC '99 in this core:
// the CARD press (JOYPAD_L) reloads the card instead of ejecting it, and the
// game writes the card on its own at registration and about 33 s into PHASE 8
// of every race the horse entered. So "written back only on the IN-GAME
// eject" and "poll for the write-back after a press" do not hold here.
// Section 11 rules: never press CARD on DOC '99; retake the card baseline at
// each race entry (the J99 latch); "card out" means no change owed since that
// entry's baseline; a leave with a race owed holds the seat in L2 closing
// until the post-race write lands. The press path below stays only until the
// J99 latch work replaces it. DOC '99 rooms are launch blocked until then.
//
// LAB-UNVERIFIED: the CARD press. This core's only card input is JOYPAD_L
// (NAOMI Button 6, race-rider BTN.insert), and flycast's libretro build maps
// it to card_reader::insertCard, not to a game button. Lab run 4 showed the
// press reloads the card in this core (see the NOTE above); section 11
// removes it.

import { CARD_POLL_MS, CARD_POLL_TIMEOUT_MS, CARD_PRESS_FRAMES, CARD_EJECT_WAIT_MS } from './room-closing.js';

export { CARD_EJECT_WAIT_MS };
export const CARD_PRESS_MASK = 1 << 10;

// The eject save's slot steps (section 4, steps 0 and 1), run by the board
// worker. The board's frame loop polls the same watcher every 30 frames, so
// a poll's own answer says nothing (the loop may have taken the change
// first): the steps judge by watcher.changes() against a baseline.
// Step 0: the card was written back since the stint's insert (changes()
// above insertBase), so it is out: no press (a press could put it back in).
// Step 1: base = changes() before the press; press CARD, then look every
// pollMs for up to timeoutMs until changes() passes base. Every write-back
// goes up as a card-write first (the watcher's onChange), so the page and
// the room see the bytes before this answer.
export async function cardEjectSteps({ watcher, press, wait, now, mask, holdFrames, pollMs, timeoutMs, insertBase = 0 }) {
  if (!watcher) return { out: false, pressed: 0, why: 'no card' };
  watcher.poll();
  if (watcher.changes() > insertBase) return { out: true, pressed: 0, writes: watcher.changes() };
  const base = watcher.changes();
  press(mask, holdFrames);
  const end = now() + timeoutMs;
  while (now() < end) {
    await wait(pollMs);
    watcher.poll();
    if (watcher.changes() > base) return { out: true, pressed: 1, writes: watcher.changes() };
  }
  return { out: false, pressed: 1, writes: watcher.changes(), why: 'timeout' };
}

// The board worker's request (lb-board-worker.js 'card-eject').
export function cardEjectRequest() {
  return { type: 'card-eject', mask: CARD_PRESS_MASK, holdFrames: CARD_PRESS_FRAMES, pollMs: CARD_POLL_MS, timeoutMs: CARD_POLL_TIMEOUT_MS };
}

// The messages the player sees, each true when shown.
export const EJECT_TEXT = Object.freeze({
  saving: 'This seat is closing: your card is being saved.',
  taking: 'Taking your card out of the reader.',
  out: 'Your card is out and is being saved.',
  missed: 'Your card did not come out in time. The room keeps the last card it saved.',
});

// jp: DOC '99 with a card in the reader. ejectCard(): asks the board,
// resolves { out, pressed } (never rejects; a timeout is { out: false }).
// leave(): the seat's own leave (its card look, then the close).
// show(text): the seat's message line. notice: show the Rev C line (the
// room's eject ask; a player's own Rev C leave shows nothing new).
export async function ejectSave({ jp, ejectCard, leave, show, notice = true }) {
  if (!jp) {
    if (notice) show(EJECT_TEXT.saving);
    return { jp: false, pressed: 0, out: true, left: await leave() };
  }
  show(EJECT_TEXT.taking);
  let r = null;
  try { r = await ejectCard(); } catch { r = null; }
  const out = !!(r && r.out === true);
  show(out ? EJECT_TEXT.out : EJECT_TEXT.missed);
  return { jp: true, pressed: r && Number.isInteger(r.pressed) ? r.pressed : 0, out, left: await leave() };
}

// EVERY leave of the seat page (#169: a DOC '99 leave that stops the board
// with the card inside loses the card): the Leave button, autoLeave, the
// room's eject ask, the page unload and window.seat.leave all call
// leave(reason). On DOC '99 with a card the CARD sequence runs first (phase
// 'ejecting', the button off), then the raw leave (its card look, then the
// close). One run at a time: a second call while one runs gets the same
// promise, so a Leave during the eject never closes before the card is out.
// isJp(): DOC '99 with a card in. rawLeave(reason): mp-seat.js leave.
export function createSeatLeave({ isJp, ejectCard, rawLeave, show, setPhase = () => {}, setBusy = () => {} }) {
  let running = null;
  function leave(reason = 'finish', { asked = false } = {}) {
    if (running) return running;
    const jp = !!isJp();
    if (jp) { setPhase('ejecting'); setBusy(true); }
    running = ejectSave({ jp, ejectCard, leave: () => rawLeave(reason), show, notice: asked });
    return running;
  }
  return { leave, get running() { return running !== null; } };
}
