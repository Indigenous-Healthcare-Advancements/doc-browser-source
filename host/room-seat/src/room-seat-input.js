// room-seat-input.js: the room seat's live controls (M3, batch 1 step 1).
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// In a room the player's own satellite board runs in this page (the "bring your own cab" seat), so the player's
// keys and controller go straight into that board: no network in the loop. The board reads the seat-feel.js input
// buffer once per retro_run (lb-board-worker.js takeInputMask), so this module only has to keep port 0's mask in
// that buffer.
//
// The mapping is the player's own, from the DOC Online cabinet seat (doc-arcade src/lib/controls.ts): localStorage
// "doc_controls_v1", { keys: { KeyboardEvent.code: action }, pads: { button index: action }, showPad }. The room
// seat is served from the same site (/room-seat), so a player who remapped for the cabinets has the same keys here.
// Anything unreadable falls back to the published defaults, one device kind at a time (as controls.ts does).
//
// Safety (as the cabinet seat and the browser pilot):
// - Coin, Test and Service can never be pressed (input-map.js PLAYER_BLOCKED, enforced again by the input state).
// - Escape and F stay the page's (controls.ts RESERVED_KEYS); a stored binding on either is ignored.
// - Keys release when the page loses focus or is hidden, so nothing sticks down.
// - Typing in a text field never reaches the game (input-map.js bindKeyboard isTyping).
// - suspend(true) holds every input at nothing (the rebind panel and the leave check use it).
//
// Batch 1 step 4, the on-screen pad (room-seat-pad.js): padPress(action) and padRelease(action) press an action by
// its cabinet name (SEAT_ACTION_IDS, nothing else), on port 0 beside the keys and the controller. The same rules
// hold: Coin, Test and Service are never pressable; while input is suspended a pad press presses nothing; blur,
// hidden, releaseAll, setMaps and suspend all let go of the pad's presses too. hold(reason, on) suspends input for a
// named reason (the pad's arrange mode) beside suspend(), so closing the rebind panel or the leave check while the
// pad is being arranged does not let input through; unholdWhenIdle(reason) lifts it only once no controller button
// is down, so a press resting when arrange mode ends never reaches the game.

import { createInputState, bindKeyboard, PLAYER_BLOCKED, STANDARD_GAMEPAD_MAP, DEFAULT_KEYBOARD_MAP, JOYPAD, RETRO_DEVICE_JOYPAD, RETRO_DEVICE_ID_JOYPAD_MASK } from './input-map.js';
import { allocateInputBuffer, writeInputMask, clearInput } from './seat-feel.js';

export const SEAT_CONTROLS_KEY = 'doc_controls_v1';
// The cabinet seat's actions and their joypad ids (controls.ts ACTIONS; controls.js ACTION_IDS).
export const SEAT_ACTION_IDS = Object.freeze({
  up: JOYPAD.UP, down: JOYPAD.DOWN, left: JOYPAD.LEFT, right: JOYPAD.RIGHT,
  a: JOYPAD.B, b: JOYPAD.A, whip: JOYPAD.Y, card: JOYPAD.L, start: JOYPAD.START,
});
export const SEAT_RESERVED_KEYS = Object.freeze(new Set(['Escape', 'KeyF']));
// The seat page's own buttons, outside every dialog (mp-seat.html): the header and its menu, the touch bar's two and
// the sound prompt. A game key is never theirs, and a pointer press does not leave the focus on them
// (createRoomSeatInput). SEAT_SHEET_BUTTONS: the report sheet's Send and Cancel, which give the focus back the same
// way after a pointer press but keep Enter and Space (the sheet is used from the keyboard too).
export const SEAT_PAGE_BUTTONS = '#seat-menu, #menu-btn, #bar-leave, #sound-ask';
export const SEAT_SHEET_BUTTONS = '#report-row';
const MAX_PAD_INDEX = 31;
const CODE_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const ACTIONS = Object.keys(SEAT_ACTION_IDS);
const BLOCKED = new Set(PLAYER_BLOCKED);
const BLOCKED_MASK = PLAYER_BLOCKED.reduce((m, id) => m | (1 << id), 0);
const isPlainObject = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
// The elements and roles that use Space themselves (they keep it; see onSpace in createRoomSeatInput).
const SPACE_TAGS = new Set(['BUTTON', 'A', 'SUMMARY', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'LABEL', 'VIDEO', 'AUDIO']);
const SPACE_ROLES = new Set(['button', 'checkbox', 'switch', 'radio', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'slider', 'link', 'textbox']);
function usesSpace(t) {
  if (!t || typeof t !== 'object') return false;
  if (t.isContentEditable) return true;
  if (SPACE_TAGS.has(typeof t.tagName === 'string' ? t.tagName.toUpperCase() : '')) return true;
  let role = '';
  try { role = typeof t.getAttribute === 'function' ? String(t.getAttribute('role') || '').toLowerCase() : ''; } catch { role = ''; }
  return SPACE_ROLES.has(role);
}

const idAction = new Map(Object.entries(SEAT_ACTION_IDS).map(([a, id]) => [id, a]));
// The published defaults, derived from input-map.js so they never drift from the pilot's.
export function seatDefaultControls() {
  const keys = {};
  for (const [code, id] of Object.entries(DEFAULT_KEYBOARD_MAP)) keys[code] = idAction.get(id);
  const pads = {};
  STANDARD_GAMEPAD_MAP.forEach((id, i) => { if (id !== null && id !== undefined) pads[i] = idAction.get(id); });
  return { keys, pads };
}

// A stored map is usable when every action is reachable. Single entries that are unusable (a reserved key, an
// unknown action, a bad code or index) are dropped one by one; if that leaves an action with nothing, the whole
// device kind falls back to the defaults, so a player is never left unable to press OK or insert the card.
function cleanKind(o, isKeys) {
  if (!isPlainObject(o)) return null;
  const out = {};
  for (const [k, act] of Object.entries(o)) {
    if (typeof act !== 'string' || !Object.prototype.hasOwnProperty.call(SEAT_ACTION_IDS, act)) continue;
    if (isKeys) {
      if (!CODE_RE.test(k) || SEAT_RESERVED_KEYS.has(k)) continue;
      out[k] = act;
    } else {
      if (!/^\d{1,2}$/.test(k) || Number(k) > MAX_PAD_INDEX) continue;
      out[Number(k)] = act;
    }
  }
  const covered = new Set(Object.values(out));
  return ACTIONS.every((a) => covered.has(a)) ? out : null;
}

// Whatever is stored (or nothing): a usable { keys, pads, custom: { keys, pads } }.
export function seatControlsFrom(stored) {
  const d = seatDefaultControls();
  const keys = isPlainObject(stored) ? cleanKind(stored.keys, true) : null;
  const pads = isPlainObject(stored) ? cleanKind(stored.pads, false) : null;
  return { keys: keys || d.keys, pads: pads || d.pads, custom: { keys: !!keys, pads: !!pads } };
}

export function loadSeatControls(storage) {
  let parsed = null;
  try {
    const raw = storage ? storage.getItem(SEAT_CONTROLS_KEY) : null;
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  return seatControlsFrom(parsed);
}

// The maps input-map.js reads. Only SEAT_ACTION_IDS values appear; a blocked id is dropped on top.
export function seatKeyboardMap(c) {
  const out = {};
  for (const [code, act] of Object.entries(c.keys)) {
    const id = SEAT_ACTION_IDS[act];
    if (id === undefined || BLOCKED.has(id) || SEAT_RESERVED_KEYS.has(code)) continue;
    out[code] = id;
  }
  return Object.freeze(out);
}
export function seatGamepadMap(c) {
  const out = new Array(MAX_PAD_INDEX + 1).fill(null);
  for (const [idx, act] of Object.entries(c.pads)) {
    const id = SEAT_ACTION_IDS[act];
    const n = Number(idx);
    if (id === undefined || BLOCKED.has(id) || !(n >= 0 && n <= MAX_PAD_INDEX)) continue;
    out[n] = id;
  }
  return Object.freeze(out);
}

// createRoomSeatInput({ win, storage }): { buffer, input, controls, reload(), stop() }.
// buffer goes to the board's init message as `input` (lb-board-worker.js). The page keeps the buffer's port 0 in
// step with the input state on every change, and polls connected controllers once per animation frame.
// storage defaults to the page's localStorage, READ ONLY here (this module never writes it).
export function createRoomSeatInput({ win = globalThis.window, storage } = {}) {
  if (storage === undefined) { try { storage = win && win.localStorage ? win.localStorage : null; } catch { storage = null; } }
  const buffer = allocateInputBuffer();
  const i32 = new Int32Array(buffer);
  let controls = loadSeatControls(storage);
  const inner = createInputState({ keyboardMap: seatKeyboardMap(controls), gamepadMap: seatGamepadMap(controls) });
  // The pad's presses: how many pointers hold each action, and the mask they make (port 0 only).
  const touch = new Map();
  let touchMask = 0;
  const padListeners = new Set();
  const padChanged = () => { for (const fn of padListeners) { try { fn(); } catch { /* a listener's own problem */ } } };
  const clearTouch = () => { const had = touchMask !== 0; touch.clear(); touchMask = 0; return had; };
  // Suspended when asked (suspend) or while any named hold is on (hold).
  let asked = false;
  const holds = new Set();
  const applySuspend = () => { const on = asked || holds.size > 0; if (on) clearTouch(); inner.suspend(on); };
  const mask = (port) => (port === 0 && !inner.suspended() ? (inner.mask(0) | touchMask) & ~BLOCKED_MASK : inner.mask(port));
  // The input state as input-map.js makes it, with the pad's presses folded into port 0.
  const input = Object.freeze({
    onKey: inner.onKey,
    pollGamepads: inner.pollGamepads,
    mask,
    inputState(port, device, index, id) {
      if (device !== RETRO_DEVICE_JOYPAD || index !== 0) return 0;
      const m = mask(port);
      if (id === RETRO_DEVICE_ID_JOYPAD_MASK) return m;
      if (id < 0 || id > 15) return 0;
      return (m >> id) & 1;
    },
    releaseAll() { clearTouch(); inner.releaseAll(); },
    setMaps(maps) { clearTouch(); inner.setMaps(maps); },
    suspend(on) { asked = !!on; applySuspend(); },
    suspended: inner.suspended,
    onChange(fn) { const off = inner.onChange(fn); padListeners.add(fn); return () => { off(); padListeners.delete(fn); }; },
  });
  input.onChange(() => writeInputMask(i32, 0, input.mask(0)));
  // The pad: an action by its cabinet name. Anything else (Coin, Test, Service, a typo) presses nothing.
  function padPress(action) {
    if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(SEAT_ACTION_IDS, action)) return false;
    const id = SEAT_ACTION_IDS[action];
    if (BLOCKED.has(id) || inner.suspended()) return false;
    touch.set(action, (touch.get(action) || 0) + 1);
    const before = touchMask;
    touchMask |= 1 << id;
    if (touchMask !== before) padChanged();
    return true;
  }
  function padRelease(action) {
    const n = touch.get(action);
    if (!n) return false;
    if (n > 1) { touch.set(action, n - 1); return true; }
    touch.delete(action);
    touchMask &= ~(1 << SEAT_ACTION_IDS[action]);
    padChanged();
    return true;
  }
  function padReleaseAll() { if (clearTouch()) padChanged(); }
  function hold(reason, on) {
    if (on) holds.add(String(reason)); else holds.delete(String(reason));
    applySuspend();
  }
  // GAME KEYS AND THE PAGE'S OWN BUTTONS (the report sheet test of 2026-11-24). The seat's buttons (the header and
  // its menu, the touch bar, the sound prompt: SEAT_PAGE_BUTTONS) never keep a game key: a mapped key pressed while
  // one of them has the focus goes to the game, Enter and Space included, and does not press the button again. A
  // dialog's buttons (the leave check, the chooser, the Controls panel) are not in that list and keep their keys,
  // and so does any button while the input is suspended or for a key the game does not use.
  const inPageButtons = (t) => { try { return !!(t && typeof t.closest === 'function' && t.closest(SEAT_PAGE_BUTTONS)); } catch { return false; } };
  const unbind = win && typeof win.addEventListener === 'function' ? bindKeyboard(win, input, { gameFirst: (e) => inPageButtons(e && e.target) }) : () => {};
  // SPACE NEVER SCROLLS THE SEAT PAGE (the pilot test of 2026-11-24: Space pressed just after the Sound button was
  // clicked scrolled the page a screen down mid race). A clicked seat button gives the focus back to the page (below)
  // and Space is no default game key, so the browser scrolled. On the page itself Space now does nothing (a Space
  // mapped to an action still reaches the game, above); a control that uses Space keeps it (a dialog's button, a
  // link, a field, a checkbox, or a seat button reached from the keyboard).
  const onSpace = (e) => { if (e && e.code === 'Space' && !e.defaultPrevented && !usesSpace(e.target) && typeof e.preventDefault === 'function') e.preventDefault(); };
  if (win && typeof win.addEventListener === 'function') win.addEventListener('keydown', onSpace);
  // And a seat button pressed with the mouse or a finger does not keep the focus (a keyboard press, detail 0, does:
  // its user is walking the buttons). The focus goes back to the page, where every key is the game's. Whatever the
  // click itself focused is let go too when it is another seat button (the menu's own), never a dialog's.
  const doc = win && win.document ? win.document : null;
  const onPageClick = (e) => {
    const t = e && e.target;
    if (!t || !(e.detail > 0) || typeof t.closest !== 'function') return;
    let btn = null;
    try { btn = t.closest('button'); } catch { btn = null; }
    if (!btn || !(inPageButtons(btn) || (() => { try { return !!btn.closest(SEAT_SHEET_BUTTONS); } catch { return false; } })())) return;
    for (const el of [btn, doc.activeElement]) {
      if (el && el === doc.activeElement && typeof el.blur === 'function' && String(el.tagName || '').toUpperCase() === 'BUTTON' && (el === btn || inPageButtons(el))) { try { el.blur(); } catch { /* not focused */ } }
    }
  };
  if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('click', onPageClick);
  const release = () => input.releaseAll();
  const onVisibility = () => { if (win.document && win.document.visibilityState === 'hidden') release(); };
  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('blur', release);
    win.addEventListener('visibilitychange', onVisibility);
    if (win.document && typeof win.document.addEventListener === 'function') win.document.addEventListener('visibilitychange', onVisibility);
  }
  let raf = 0;
  let stopped = false;
  const poll = () => {
    if (stopped) return;
    try { input.pollGamepads(win.navigator && win.navigator.getGamepads ? win.navigator.getGamepads() : null); } catch { /* no pads */ }
    raf = win.requestAnimationFrame ? win.requestAnimationFrame(poll) : 0;
  };
  if (win && win.requestAnimationFrame) raf = win.requestAnimationFrame(poll);
  // A storage change from another tab (the cabinet seat's mapper, or a later panel here) applies at once.
  const reload = () => { controls = loadSeatControls(storage); input.setMaps({ keyboardMap: seatKeyboardMap(controls), gamepadMap: seatGamepadMap(controls) }); };
  const onStorage = (e) => { if (!e || e.key === SEAT_CONTROLS_KEY || e.key === null) reload(); };
  if (win && typeof win.addEventListener === 'function') win.addEventListener('storage', onStorage);
  // Lift a hold once no controller button is down (the rebind panel's close does the same), so a button resting when
  // the hold ends never reaches the game. Held keys were let go when the hold began.
  function unholdWhenIdle(reason) {
    const key = String(reason);
    const held = () => {
      try {
        const pads = win && win.navigator && win.navigator.getGamepads ? win.navigator.getGamepads() : null;
        return !!pads && Array.from(pads).some((p) => p && p.connected && Array.from(p.buttons || []).some((b) => b && (b.pressed || b.value > 0.5)));
      } catch { return false; }
    };
    const step = () => {
      if (stopped || !holds.has(key)) return;
      if (held() && win.requestAnimationFrame) { win.requestAnimationFrame(step); return; }
      hold(key, false);
    };
    step();
  }
  function stop() {
    stopped = true;
    if (raf && win.cancelAnimationFrame) win.cancelAnimationFrame(raf);
    unbind();
    if (win && typeof win.removeEventListener === 'function') {
      win.removeEventListener('blur', release);
      win.removeEventListener('keydown', onSpace);
      win.removeEventListener('visibilitychange', onVisibility);
      win.removeEventListener('storage', onStorage);
      if (win.document && typeof win.document.removeEventListener === 'function') { win.document.removeEventListener('visibilitychange', onVisibility); win.document.removeEventListener('click', onPageClick); }
    }
    input.releaseAll();
    clearInput(i32);
  }
  return { buffer, input, get controls() { return controls; }, reload, stop, padPress, padRelease, padReleaseAll, hold, unholdWhenIdle, held: () => holds.size > 0 };
}
