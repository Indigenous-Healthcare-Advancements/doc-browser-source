// room-seat-phone.js: what a phone or a tablet needs from the room seat page beyond its layout (docs/seat-phone-layout.md):
// the screen kept awake while the seat runs, a short buzz on Whip and Hold where the device can, the browser's own
// touch gestures kept off the play area, and the safe area read from the page.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Nothing here can stop the seat: every browser call is tried and, when it is missing or refused, left out (state()
// says so). No network. The one stored thing is the player's buzz choice, on this device.

export const HAPTIC_KEY = 'doc_room_haptic_v1';
/** One short tick: long enough to feel under a thumb, short enough for dozens of presses a race. */
export const HAPTIC_MS = 10;
/** The two race buttons only: the ones hammered without looking. The menu buttons are looked at. */
export const HAPTIC_ACTIONS = Object.freeze(['whip', 'b']);

/** Whether the device's main pointer is a finger. */
export function coarsePointer(win) {
  try { return !!(win && typeof win.matchMedia === 'function' && win.matchMedia('(pointer: coarse)').matches); } catch { return false; }
}

/** The player's buzz choice: on unless they turned it off here. Never throws. */
export function loadHaptic(storage) {
  try { return (storage ? storage.getItem(HAPTIC_KEY) : null) !== 'off'; } catch { return true; }
}
export function saveHaptic(storage, on) {
  try { if (!storage) return false; storage.setItem(HAPTIC_KEY, on ? 'on' : 'off'); return true; } catch { return false; }
}

/**
 * createHaptics({ win, storage }): { supported, on(), set(bool), pulse(action) }.
 * supported: the browser has navigator.vibrate (Android Chrome; iPhone Safari has none, so nothing happens there).
 * pulse(action) is called by the pad on every press that went in: one vibrate call, no page work.
 */
export function createHaptics({ win = globalThis.window, storage } = {}) {
  if (storage === undefined) { try { storage = win ? win.localStorage : null; } catch { storage = null; } }
  const nav = win && win.navigator ? win.navigator : null;
  const supported = !!nav && typeof nav.vibrate === 'function';
  let on = loadHaptic(storage);
  let pulses = 0;
  return {
    supported,
    on: () => supported && on,
    set(v) { on = !!v; saveHaptic(storage, on); },
    pulse(action) {
      if (!supported || !on || !HAPTIC_ACTIONS.includes(action)) return false;
      try { nav.vibrate(HAPTIC_MS); pulses++; return true; } catch { return false; }
    },
    state: () => ({ supported, on: supported && on, pulses }),
  };
}

/**
 * createWakeLock({ nav, doc }): { start(), stop(), state() }. The screen stays awake from start() to stop() where
 * the browser has the Screen Wake Lock API (Android Chrome, iPhone Safari 16.4 and later). The browser drops the
 * lock whenever the page is hidden; it is asked for again when the page is shown again. stop() (the seat's end)
 * releases it for good.
 */
export function createWakeLock({ nav = globalThis.navigator, doc = globalThis.document } = {}) {
  const supported = !!nav && !!nav.wakeLock && typeof nav.wakeLock.request === 'function';
  let wanted = false;
  let sentinel = null;
  let asking = false;
  let fault = null;
  let grants = 0;
  function ask() {
    if (!supported || !wanted || sentinel || asking) return;
    if (doc && doc.visibilityState === 'hidden') return; // the browser refuses a hidden page: the next show asks
    asking = true;
    let p;
    try { p = nav.wakeLock.request('screen'); } catch (err) { p = Promise.reject(err); }
    Promise.resolve(p).then((s) => {
      asking = false;
      if (!s) return;
      if (!wanted) { try { const r = s.release(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch { /* gone */ } return; }
      sentinel = s;
      grants++;
      fault = null;
      if (typeof s.addEventListener === 'function') s.addEventListener('release', () => { if (sentinel === s) sentinel = null; });
    }, (err) => { asking = false; fault = String(err && err.name ? err.name : err).slice(0, 40) || 'refused'; });
  }
  const onVisible = () => { if (doc && doc.visibilityState !== 'hidden') ask(); };
  return {
    supported,
    start() {
      if (wanted) return;
      wanted = true;
      if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisible);
      ask();
    },
    stop() {
      if (!wanted) return;
      wanted = false;
      if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisible);
      const s = sentinel;
      sentinel = null;
      if (s) { try { const r = s.release(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch { /* gone */ } }
    },
    state: () => ({ supported, wanted, held: !!sentinel, grants, fault }),
  };
}

/** The safe area insets, read from an element whose padding is env(safe-area-inset-*) (the page's #safe-probe). */
export function readInsets(el, getStyle = globalThis.getComputedStyle) {
  const zero = { t: 0, r: 0, b: 0, l: 0 };
  try {
    if (!el || typeof getStyle !== 'function') return zero;
    const cs = getStyle(el);
    const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : 0; };
    return { t: px(cs.paddingTop), r: px(cs.paddingRight), b: px(cs.paddingBottom), l: px(cs.paddingLeft) };
  } catch { return zero; }
}

/** The events whose default the browser must not run inside the play area (scroll and pull to refresh, the long
 * press menu, pinch and double tap zoom, text selection). Outside it everything is the browser's, so a player who
 * needs to zoom still can, on the bar and in the menu. */
export const GUARDED = Object.freeze(['touchmove', 'contextmenu', 'gesturestart', 'gesturechange', 'dblclick', 'selectstart']);
/**
 * guardPlayArea({ root, isPlay }): stops those defaults for events inside root whose target isPlay(target) accepts.
 * Returns a function that removes the guard.
 */
export function guardPlayArea({ root, isPlay = () => true } = {}) {
  if (!root || typeof root.addEventListener !== 'function') return () => {};
  const stop = (e) => {
    let play = false;
    try { play = !!isPlay(e.target); } catch { play = false; }
    if (play && e.cancelable !== false && typeof e.preventDefault === 'function') e.preventDefault();
  };
  for (const t of GUARDED) root.addEventListener(t, stop, { passive: false });
  return () => { for (const t of GUARDED) root.removeEventListener(t, stop); };
}
