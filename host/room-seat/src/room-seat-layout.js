// room-seat-layout.js: where everything on the room seat page sits on a phone or a tablet (docs/seat-phone-layout.md).
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Pure arithmetic: a viewport and its safe area in, rectangles out (CSS pixels, viewport coordinates). No DOM, no
// storage, no clock. The page (mp-seat.js) measures the viewport, calls seatLayout once per resize or turn of the
// device (never per frame), writes the rectangles as CSS variables, and hands the button places to the on-screen pad
// (room-seat-pad.js) as its default arrangement. A desktop (a fine pointer) does not use this at all.
//
// THE RULES (the spec's, each checked by test/room-seat-layout.test.mjs at every viewport):
//  * Everything is inside the safe area (the notch, the rounded corners, the home bar).
//  * While racing the player sees the main screen (the race) AND their own screen (their horse, their gauge), and
//    has all nine buttons. Nothing overlaps anything.
//  * Every button is at least TAP_MIN square and at least GAP from the next; Hold and Whip are BIG_RATIO times the
//    others, side by side or stacked in the bottom right corner, Whip outermost, under the right thumb.
//  * The cabinet's shape is kept (room-seat-pad-layout.js): the cross around OK on the left, START and the card over
//    Hold and Whip on the right.
//
// UPRIGHT (portrait): a bar across the top (Menu, the status line, Leave), the main screen at the full width, the
// player's own screen under it at the full width, the buttons in a band along the bottom. The width limits both
// pictures, and there is height to spare, so nothing has to be chosen between.
// SIDEWAYS (landscape): no bar (the height is the scarce thing): a Menu button in the top left corner, the main
// screen across the top, the player's own screen under it in the middle, the cross in the bottom left corner and the
// horse buttons in the bottom right, each beside the player's screen. The two pictures share the height, and THE
// PLAYER'S OWN SCREEN IS THE LARGE ONE (the owner's test of 2026-11-24: it is the picture with the text to read: the
// stable, the feed, the entry): the main screen gets MAIN_SHARE of the height and never less than MAIN_MIN_H (so it
// is never under 320 px wide), the player's own the rest. One tap on the main screen swaps the emphasis (large:
// 'main'): the main screen then gets MAIN_SHARE_BIG, for a player who wants the race larger. The buttons stay beside
// the player's screen, never over it, in both.
// THE STATUS LINE sideways is a strip of its own beside the main screen (to its right, in the band the main screen is
// in): it lies over neither picture and over no button.
// WHO GETS THIS LAYOUT (touchLayoutWanted): the room seat on a device whose main pointer is a finger, and on any
// window as small as a phone (its shorter side SMALL_VIEW or less) whatever the pointer: the desktop page cannot be
// read at that size (its own screen comes out about 200 px wide and its header wraps over three rows).

export const TAP_MIN = 48;
export const GAP = 8;
export const EDGE = 8;
export const BAR_H = 48;
export const SMALL_MAX = 76;
export const BIG_RATIO = 1.5;
export const CLUSTER_GAP = 16;
export const LEAVE_W = 96;
export const MIN_SCREEN_W = 200;
// Sideways: the main screen's share of the height the two pictures have between them (the player's own screen is the
// large picture), its least height (8:3, so 320 px wide), and its share when the player has swapped the emphasis.
export const MAIN_SHARE = 0.3;
export const MAIN_MIN_H = 120;
export const MAIN_SHARE_BIG = 0.44;
// The status strip sideways: its line height, its padding top and bottom together, and the least width it is given
// beside a picture (under that it goes back over the top edge of the first picture, one line).
export const MSG_LINE = 20;
export const MSG_PAD = 8;
export const MSG_MIN_W = 90;
// A window whose shorter side is this or less is laid out as a phone whatever its pointer.
export const SMALL_VIEW = 500;
// Upright, when not everything fits at the full width: the pictures give up to this much so the buttons can grow.
export const PICTURE_FLOOR = 0.85;
export const COMFORT = 56;
export const TOUCH_ACTIONS = Object.freeze(['up', 'down', 'left', 'right', 'a', 'start', 'whip', 'b', 'card']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const R = (l, t, w, h) => ({ l, t, r: l + w, b: t + h, w, h });
const sq = (cx, cy, size) => ({ cx, cy, size, l: cx - size / 2, t: cy - size / 2, r: cx + size / 2, b: cy + size / 2 });
const big = (s) => Math.round(s * BIG_RATIO);
// The sound prompt: 220 px wide, or what the picture under it has.
const askW = (r) => Math.max(120, Math.min(220, r.w - 2 * GAP));

/** Whether the page lays itself out this way: the room seat on a device whose main pointer is a finger, or in a
 * window as small as a phone (vw, vh: the viewport; its shorter side SMALL_VIEW or less). */
export function touchLayoutWanted({ roomSeat = false, coarse = false, vw = 0, vh = 0 } = {}) {
  const short = Math.min(num(vw), num(vh));
  return !!roomSeat && (!!coarse || (short > 0 && short <= SMALL_VIEW));
}

/** The two clusters' sizes for a small button of s pixels. arr: 'wide' (Hold beside Whip) or 'tall' (Hold over Whip). */
export function padDims(s, arr = 'wide') {
  const b = big(s);
  const cross = 3 * s + 2 * GAP;
  const rightW = arr === 'tall' ? Math.max(b, 2 * s + GAP) : 2 * b + GAP;
  const rightH = arr === 'tall' ? s + GAP + b + GAP + b : s + GAP + b;
  return { s, b, cross, rightW, rightH, w: cross + CLUSTER_GAP + rightW, h: Math.max(cross, rightH) };
}

// The nine buttons: the cross with its bottom left corner at (x0, yb), the horse cluster with its bottom right
// corner at (xr, yb).
function placePads(s, arr, x0, xr, yb) {
  const d = padDims(s, arr);
  const out = {};
  const cx = x0 + s + GAP + s / 2, cy = yb - s - GAP - s / 2;
  out.a = sq(cx, cy, s);
  out.up = sq(cx, cy - s - GAP, s);
  out.down = sq(cx, cy + s + GAP, s);
  out.left = sq(cx - s - GAP, cy, s);
  out.right = sq(cx + s + GAP, cy, s);
  if (arr === 'tall') {
    // Flush with the right edge: Whip in the corner itself, Hold over it, START and the card over that.
    out.whip = sq(xr - d.b / 2, yb - d.b / 2, d.b);
    out.b = sq(xr - d.b / 2, yb - d.b - GAP - d.b / 2, d.b);
    const top = yb - d.rightH + s / 2;
    out.start = sq(xr - s - GAP - s / 2, top, s);
    out.card = sq(xr - s / 2, top, s);
  } else {
    out.whip = sq(xr - d.b / 2, yb - d.b / 2, d.b);
    out.b = sq(xr - d.b - GAP - d.b / 2, yb - d.b / 2, d.b);
    const top = yb - d.b - GAP - s / 2;
    out.start = sq(out.b.cx, top, s);
    out.card = sq(out.whip.cx, top, s);
  }
  return out;
}

/**
 * seatLayout({ vw, vh, insets: { t, r, b, l }, main, pad, large })
 *   vw, vh   the layout viewport (window.innerWidth and innerHeight: the dynamic viewport, what 100dvh is)
 *   insets   the safe area insets (env(safe-area-inset-*)), in px
 *   main     the room's main screen is shown; pad: the on-screen buttons are shown
 *   large    sideways only: 'screen' (the default: the player's own screen is the large picture) or 'main'
 * Returns { mode: 'portrait' | 'landscape', large: 'screen' | 'main', safe, bar, menu, leave, msg, main, screen, wait, ask, pads, small, big,
 * arrangement, scale }: rectangles { l, t, r, b, w, h }; pads is { action: { cx, cy, size, l, t, r, b } } or null;
 * bar and leave are null sideways; main is null without the main screen; scale is the share of the full width the
 * pictures got (1 unless the viewport is too short for everything).
 */
export function seatLayout({ vw, vh, insets = {}, main = true, pad = true, large = 'screen' } = {}) {
  const W = Math.max(1, num(vw)), H = Math.max(1, num(vh));
  const safe = R(num(insets.l), num(insets.t), Math.max(1, W - num(insets.l) - num(insets.r)), Math.max(1, H - num(insets.t) - num(insets.b)));
  return W > H ? sideways(safe, main, pad, large === 'main' ? 'main' : 'screen') : upright(safe, main, pad);
}

function upright(safe, main, pad) {
  const bar = R(safe.l, safe.t, safe.w, BAR_H);
  const menu = R(safe.l + EDGE, safe.t, TAP_MIN + 24, BAR_H);
  const leave = R(safe.r - EDGE - LEAVE_W, safe.t, LEAVE_W, BAR_H);
  const msg = R(menu.r + GAP, safe.t, Math.max(0, leave.l - GAP - menu.r - GAP), BAR_H);
  const top = bar.b + GAP;
  const bottom = safe.b - EDGE;
  const room = bottom - top;
  const inner = safe.w - 2 * EDGE;
  // The share of the full width the pictures can have with `h` px of height between them (and the gap between the two).
  const share = (h) => (h - (main ? GAP : 0)) / (safe.w * (main ? 9 / 8 : 3 / 4));
  // The biggest buttons that fit the width, in either shape, with the pictures at no less than `floor` of the width.
  const biggest = (floor) => {
    let best = null;
    for (const arr of ['wide', 'tall']) {
      for (let s = SMALL_MAX; s >= TAP_MIN; s--) {
        const d = padDims(s, arr);
        if (d.w > inner || share(room - d.h - GAP) < floor) continue;
        if (!best || s > best.s) best = { s, arr };
        break;
      }
    }
    return best;
  };
  let pick = null;
  if (pad) {
    // The pictures at their full width when that leaves comfortable buttons; else the pictures give a little.
    pick = biggest(1);
    if (!pick || pick.s < COMFORT) { const more = biggest(PICTURE_FLOOR); if (more && (!pick || more.s > pick.s)) pick = { s: Math.min(more.s, Math.max(COMFORT, pick ? pick.s : 0, 64)), arr: more.arr }; }
    if (!pick) pick = { s: TAP_MIN, arr: 'wide' };
  }
  const d = pick ? padDims(pick.s, pick.arr) : null;
  const left = room - (d ? d.h + GAP : 0);
  // Too short for everything at full width: the pictures shrink together, the buttons never go under TAP_MIN.
  const k = Math.max(0.3, Math.min(1, share(left)));
  const mw = Math.floor(safe.w * k), mh = Math.floor(mw * 3 / 8);
  const sw = mw, sh = Math.floor(sw * 3 / 4);
  const x = safe.l + (safe.w - mw) / 2;
  const mainRect = main ? R(x, top, mw, mh) : null;
  const screen = R(x, main ? top + mh + GAP : top, sw, sh);
  const pads = d ? placePads(pick.s, pick.arr, safe.l + EDGE, safe.r - EDGE, bottom) : null;
  const first = mainRect || screen;
  return {
    mode: 'portrait', large: 'screen', safe, bar, menu, leave, msg, main: mainRect, screen, wait: { ...screen },
    ask: R(first.l + (first.w - askW(first)) / 2, first.t + GAP, askW(first), 56),
    pads, small: d ? d.s : 0, big: d ? d.b : 0, arrangement: pick ? pick.arr : null, scale: k,
  };
}

function sideways(safe, main, pad, emphasis) {
  const A = R(safe.l + EDGE, safe.t + EDGE, safe.w - 2 * EDGE, safe.h - 2 * EDGE);
  const corner = TAP_MIN + GAP; // the Menu button's corner, kept clear on both sides so the main screen stays centred
  // The main screen's height: its share (the small one unless the player swapped), never under MAIN_MIN_H.
  const balanced = main ? Math.max(MAIN_MIN_H, (A.h - GAP) * (emphasis === 'main' ? MAIN_SHARE_BIG : MAIN_SHARE)) : 0;
  let s = 0;
  if (pad) {
    // The cross must fit under the main screen; and the player's screen needs its width between the clusters.
    s = Math.max(TAP_MIN, Math.min(SMALL_MAX, Math.floor((A.h - GAP - balanced - 2 * GAP - (main ? 0 : corner)) / 3)));
    while (s > TAP_MIN && A.w - padDims(s).cross - padDims(s).rightW - 2 * CLUSTER_GAP < Math.max(MIN_SCREEN_W, (A.h - balanced - GAP) * 4 / 3)) s--;
  }
  const d = pad ? padDims(s, 'wide') : null;
  const padH = d ? d.h : 0;
  // (Its width also leaves the status strip its least width beside it, and the same on the Menu side: centred.)
  const mh = main ? Math.floor(Math.max(60, Math.min(balanced, A.h - GAP - padH, (A.w - 2 * Math.max(corner, MSG_MIN_W + GAP)) * 3 / 8))) : 0;
  const mw = Math.floor(mh * 8 / 3);
  const mainRect = main ? R(A.l + (A.w - mw) / 2, A.t, mw, mh) : null;
  const gapL = A.l + (d ? d.cross + CLUSTER_GAP : corner), gapR = A.r - (d ? d.rightW + CLUSTER_GAP : corner);
  const stop = main ? A.t + mh + GAP : A.t;
  const sw = Math.floor(Math.max(1, Math.min(gapR - gapL, (A.b - stop) * 4 / 3)));
  const sh = Math.floor(sw * 3 / 4);
  const screen = R(gapL + (gapR - gapL - sw) / 2, stop, sw, sh);
  const menu = R(A.l, A.t, TAP_MIN, TAP_MIN);
  const first = mainRect || screen;
  // The status line: a strip of its own to the right of the first picture, over neither picture and over no button
  // (beside the main screen it has the main screen's band; with no main screen, the room above the horse buttons).
  // Whole lines only. With no room for it there (no main screen on a narrow phone) it is one line over the top edge
  // of the player's screen, as it was.
  const beside = A.r - first.r - GAP;
  const room = mainRect ? mainRect.h : (d ? A.b - d.rightH - GAP : A.b) - A.t;
  const lines = Math.floor((room - MSG_PAD) / MSG_LINE);
  const msg = beside >= MSG_MIN_W && lines >= 1 ? R(first.r + GAP, A.t, beside, lines * MSG_LINE + MSG_PAD) : R(first.l, first.t, first.w, MSG_LINE + MSG_PAD);
  return {
    mode: 'landscape', large: main ? emphasis : 'screen', safe, bar: null, menu, leave: null,
    msg,
    main: mainRect, screen,
    // The waiting card: the whole band under the main screen (the buttons do nothing while the player waits).
    wait: R(A.l, stop, A.w, A.b - stop),
    ask: R(first.l + (first.w - askW(first)) / 2, first.t + Math.max(GAP, (first.h - 56) / 2), askW(first), 56),
    pads: d ? placePads(s, 'wide', A.l, A.r, A.b) : null, small: d ? d.s : 0, big: d ? d.b : 0, arrangement: d ? 'wide' : null,
    scale: main ? mw / (safe.w) : sw / safe.w,
  };
}

/** The layout as the CSS variables the page's style sheet reads (px strings), for one element's style. */
export function layoutVars(L) {
  const v = {};
  const put = (name, r) => { if (!r) return; v[`--${name}-x`] = `${Math.round(r.l)}px`; v[`--${name}-y`] = `${Math.round(r.t)}px`; v[`--${name}-w`] = `${Math.round(r.w)}px`; v[`--${name}-h`] = `${Math.round(r.h)}px`; };
  put('bar', L.bar); put('menu', L.menu); put('leave', L.leave); put('msg', L.msg); put('main', L.main); put('screen', L.screen); put('wait', L.wait); put('ask', L.ask);
  return v;
}

/** The button places for the pad (room-seat-pad-layout.js padGeometry's `preset`): centres and sizes in px. */
export function padPreset(L) {
  if (!L || !L.pads) return null;
  const out = {};
  for (const a of TOUCH_ACTIONS) out[a] = { cx: L.pads[a].cx, cy: L.pads[a].cy, size: L.pads[a].size };
  return out;
}

// ---- Colours: what is read on the touch layout, and its contrast (WCAG 2.2, 1.4.3: at least 4.5 to 1) -------------
// Each pair is the text's colour and the colour really behind it (a translucent panel is composited over what is
// under it first: compositeOver). mp-seat.html uses exactly these values (the test reads both).
export const TOUCH_COLORS = Object.freeze({
  page: '#111111',
  barText: '#f2f0e8',
  panel: '#1d1d1d',
  panelText: '#eeeeee',
  panelBorder: '#555555',
  buttonBg: '#333333',
  buttonText: '#ffffff',
  hintText: '#c8c8c8',
  gold: '#d8a630',
  goldText: '#1a1408',
  waitBg: 'rgba(8, 12, 10, 0.92)',
  waitTitle: '#f2f0e8',
  waitText: '#d6d2c4',
  waitTime: '#b8b5ac',
  stripBg: 'rgba(0, 0, 0, 0.8)',
});
export function parseColor(c) {
  const s = String(c).trim();
  let m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
  if (m) return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16), a: 1 };
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (m) return { r: parseInt(m[1] + m[1], 16), g: parseInt(m[2] + m[2], 16), b: parseInt(m[3] + m[3], 16), a: 1 };
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i.exec(s);
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
  return null;
}
/** A colour drawn over an opaque one: the opaque colour the eye gets. */
export function compositeOver(top, under) {
  const t = typeof top === 'string' ? parseColor(top) : top, u = typeof under === 'string' ? parseColor(under) : under;
  const mix = (a, b) => Math.round(a * t.a + b * (1 - t.a));
  return { r: mix(t.r, u.r), g: mix(t.g, u.g), b: mix(t.b, u.b), a: 1 };
}
export function luminance(c) {
  const x = typeof c === 'string' ? parseColor(c) : c;
  const lin = (v) => { const n = v / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(x.r) + 0.7152 * lin(x.g) + 0.0722 * lin(x.b);
}
/** The WCAG contrast ratio of two opaque colours (1 to 21). */
export function contrastRatio(fg, bg) {
  const a = luminance(fg), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
