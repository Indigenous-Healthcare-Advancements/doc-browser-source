// room-seat-pad-layout.js: where the room seat's on-screen buttons sit, and how that survives a reload (M3, batch 1
// step 4). The layout maths of the DOC Online cabinet seat's pad (doc-arcade src/lib/padLayout.ts), in plain
// JavaScript, in the same format as the cabinet seat's store ("doc_padlayout_v1"), kept in its own record (ROOM_PAD_STORAGE_KEY below), so
// the player's style, sizes and opacity carry over from the cabinet seat; positions are this page's own.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// THE RULES THAT SHAPE THIS (as padLayout.ts)
//  * Saved positions are PERCENTAGES of the viewport, and each one is the button's CENTRE, so a button's size can
//    change without the layout drifting.
//  * Portrait and landscape are stored SEPARATELY, under "landscape" and "portrait"; the panel size under "scales",
//    the per-button sizes under "perScales" (both per orientation), the button style under "style" and the opacity
//    under "opacity" (both per device).
//  * The DEFAULTS are COMPUTED from the viewport, never written down.
//
// WHAT IS DIFFERENT HERE: the screen. The cabinet seat has two race screens over the player's satellite and a
// button column at top-right. The room seat has ONE game picture (#stage, canvas#screen, 4:3, fit to the window)
// under a header row of page buttons. So the zones are:
//   picture  the game picture. SOFT, as the cabinet's satellite: buttons stay off it where there is room, and only
//            cover it when nothing else fits (a phone held upright, where the picture is the whole width).
//   header   the page's own buttons (and the notice line under them) across the top. HARD, as the cabinet's button
//            column: no button may be dropped on it. In full screen there is no header.
// The page measures both from the DOM (padGeometry's `measured`); without a measurement they come from the page's
// own CSS (pictureRect, fallbackHeaderPx), which is what the tests use.
// Every function takes a geometry g (padGeometry) where padLayout.ts took (vw, vh), and storage functions take the
// storage they read (the page passes its own; this module names no global storage).

export const PAD_ACTIONS = Object.freeze(['up', 'down', 'left', 'right', 'a', 'start', 'whip', 'b', 'card']);
export const PAD_STORAGE_KEY = 'doc_padlayout_v1';
// The room seat keeps its OWN record (same format): its page is laid out differently from the cabinet seat's, so a
// layout arranged here must never move the player's cabinet pad. The first time, it starts from the cabinet record's
// style, sizes and opacity (the player's preferences); positions start from this page's computed defaults.
export const ROOM_PAD_STORAGE_KEY = 'doc_room_padlayout_v1';
const SEEDED = ['style', 'scales', 'perScales', 'opacity'];
const ORIENTATIONS = ['landscape', 'portrait'];
const isPlainObject = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

// ---- Sizes the player chooses (padLayout.ts, unchanged) --------------------------------------------------------
export const PAD_SCALE_MIN = 0.4;
export const PAD_SCALE_MAX = 1.8;
export const PAD_SCALE_STEP = 0.05;
export const PAD_SCALE_DEFAULT = 1;
export function clampUserScale(n) {
  const v = finite(n) ? n : PAD_SCALE_DEFAULT;
  return Math.min(PAD_SCALE_MAX, Math.max(PAD_SCALE_MIN, v));
}
export const PAD_PER_MIN = 0.4;
export const PAD_PER_MAX = 2;
export const PAD_PER_DEFAULT = 1;
// Ceiling and floor on panel scale times button scale, so the two multipliers cannot compound absurdly.
export const PAD_TOTAL_MIN = 0.3;
export const PAD_TOTAL_MAX = 2.4;
export function clampPerScale(n) {
  const v = finite(n) ? n : PAD_PER_DEFAULT;
  return Math.min(PAD_PER_MAX, Math.max(PAD_PER_MIN, v));
}
export function effectiveScale(action, user = PAD_SCALE_DEFAULT, per) {
  const one = clampPerScale(per && per[action] !== undefined ? per[action] : PAD_PER_DEFAULT);
  return Math.min(PAD_TOTAL_MAX, Math.max(PAD_TOTAL_MIN, clampUserScale(user) * one));
}

// ---- The store ----------------------------------------------------------------------------------------------
// The whole record, or {} for nothing or junk. Never throws.
function readAll(storage) {
  try {
    if (!storage) return {};
    const own = storage.getItem(ROOM_PAD_STORAGE_KEY);
    if (own) { const all = JSON.parse(own); return isPlainObject(all) ? all : {}; }
    const raw = storage.getItem(PAD_STORAGE_KEY);
    const cab = raw ? JSON.parse(raw) : null;
    const seed = {};
    if (isPlainObject(cab)) for (const k of SEEDED) if (k in cab) seed[k] = cab[k];
    return seed;
  } catch {
    return {};
  }
}
// Change one part of the record and write it back. Unreadable or blocked storage: nothing persists, nothing throws.
function writeAll(storage, change) {
  try {
    const all = readAll(storage);
    change(all);
    storage.setItem(ROOM_PAD_STORAGE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

// ---- Button style: "cabinet" (the deck) or "classic" (labelled caps). A skin only. ----------------------------
export const PAD_STYLE_DEFAULT = 'cabinet';
export function isPadStyle(v) { return v === 'cabinet' || v === 'classic'; }
export function loadStyle(storage) {
  const s = readAll(storage).style;
  return isPadStyle(s) ? s : PAD_STYLE_DEFAULT;
}
export function saveStyle(storage, style) {
  if (!isPadStyle(style)) return false;
  return writeAll(storage, (all) => { all.style = style; });
}

// ---- The panel's shape (padLayout.ts, unchanged) --------------------------------------------------------------
/** Keep controls off the very edge so a thumb can still reach them on a phone with rounded corners. */
export const EDGE_MARGIN_PX = 8;
/** Base rendered size of each control, in px, at full scale. A ceiling: a small screen gets whatever fits. */
export const PAD_SIZE = Object.freeze({ up: 76, down: 76, left: 76, right: 76, a: 76, card: 76, start: 76, whip: 114, b: 114 });
/** Centre-to-centre distance across the d-pad cross, at full scale: a button plus a hairline. */
export const STEP_PX = 82;
// The cross around OK in one corner; START and the card above Hold and Whip in the other (John, 2026-09-16).
const LEFT_CLUSTER = Object.freeze({ a: [0, 0], up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] });
// Landscape: the horse buttons side by side. Portrait: stacked, Hold above Whip.
const RIGHT_WIDE = Object.freeze({ start: [0, -1.25], card: [1.9, -1.25], b: [0, 0], whip: [1.9, 0] });
const RIGHT_TALL = Object.freeze({ start: [0, -2.75], card: [1.05, -2.75], b: [0.525, -1.5], whip: [0.525, 0] });
const rightCluster = (o) => (o === 'portrait' ? RIGHT_TALL : RIGHT_WIDE);
export function panelOffsets(o) { return { ...LEFT_CLUSTER, ...rightCluster(o) }; }
/** Smallest air between the two clusters, so they never read as one crowded mass. */
const CLUSTER_GAP_PX = 16;
/** The smallest a player may shrink a control to, in px (only limits SHRINKING, as padLayout.ts). */
export const MIN_TAP_PX = 32;

function clusterStep(group, scale, sizeAt, floored) {
  let step = STEP_PX * scale;
  const gap = (STEP_PX - PAD_SIZE.a) * scale;
  const members = PAD_ACTIONS.filter((a) => group[a]);
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const p = group[members[i]], q = group[members[j]];
      const sep = Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]));
      if (sep <= 0 || !(floored(members[i]) || floored(members[j]))) continue;
      const need = ((sizeAt(members[i]) + sizeAt(members[j])) / 2 + gap) / sep;
      if (need > step) step = need;
    }
  }
  return step;
}

function span(group, sizeAt, step) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const a of PAD_ACTIONS) {
    const off = group[a];
    if (!off) continue;
    const half = sizeAt(a) / 2;
    minX = Math.min(minX, off[0] * step - half);
    maxX = Math.max(maxX, off[0] * step + half);
    minY = Math.min(minY, off[1] * step - half);
    maxY = Math.max(maxY, off[1] * step + half);
  }
  return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY };
}

export function orientationOf(w, h) { return w >= h ? 'landscape' : 'portrait'; }

const hits = (a, z) => a.l < z.r && z.l < a.r && a.t < z.b && z.t < a.b;

// ---- The room seat's screen ---------------------------------------------------------------------------------
// mp-seat.html's own CSS: #stage { margin: 6px 12px }, the canvas min(100vw - 24px, (100vh - 120px) * 4 / 3, 1280px)
// wide, 4:3, at least 320 wide, centred while the pad shows (body.pad-on); in full screen min(100vw, 100vh * 4 / 3),
// centred both ways.
export const STAGE_MARGIN_PX = 6;
export function pictureRect(vw, vh, headerBottom = 0, fullscreen = false) {
  if (fullscreen) {
    const w = Math.min(vw, (vh * 4) / 3), h = (w * 3) / 4;
    return { l: (vw - w) / 2, t: (vh - h) / 2, r: (vw + w) / 2, b: (vh + h) / 2 };
  }
  const w = Math.max(320, Math.min(vw - 24, ((vh - 120) * 4) / 3, 1280)), h = (w * 3) / 4;
  const t = headerBottom + STAGE_MARGIN_PX;
  return { l: (vw - w) / 2, t, r: (vw + w) / 2, b: t + h };
}
// A guess at the header row's height when the page cannot be measured: about 900px of controls in 30px lines.
export function fallbackHeaderPx(vw) {
  const lines = Math.max(1, Math.ceil(900 / Math.max(1, vw - 24)));
  return 16 + lines * 30;
}
const rectOf = (r) => (r && finite(r.l) && finite(r.t) && finite(r.r) && finite(r.b) && r.r > r.l && r.b > r.t ? { l: r.l, t: r.t, r: r.r, b: r.b } : null);

/**
 * The geometry every other function reads: the viewport and its two zones, in px.
 * measured: { picture: {l,t,r,b}, headerBottom: px, fullscreen: bool }, any part missing is computed (above).
 */
export function padGeometry(vw, vh, measured = {}) {
  const m = isPlainObject(measured) ? measured : {};
  const fullscreen = !!m.fullscreen;
  const hb = fullscreen ? 0 : finite(m.headerBottom) ? Math.max(0, Math.min(vh, m.headerBottom)) : Math.min(vh, fallbackHeaderPx(vw));
  const picture = rectOf(m.picture) || pictureRect(vw, vh, hb, fullscreen);
  const header = { l: 0, t: 0, r: vw, b: hb };
  const key = `${vw}x${vh}|${picture.l},${picture.t},${picture.r},${picture.b}|${hb}`;
  return Object.freeze({ vw, vh, picture, header, key });
}
export function seatZones(g) { return { picture: g.picture, header: g.header }; }

/** Where one cluster's buttons land at a given scale, anchored into its bottom corner (padLayout.ts). */
function placeCluster(group, scale, g, side, floorFit) {
  const raw = (a) => Math.round(PAD_SIZE[a] * scale);
  const size = (a) => (floorFit === undefined ? raw(a) : Math.max(raw(a), Math.min(MIN_TAP_PX, Math.round(PAD_SIZE[a] * floorFit))));
  const step = floorFit === undefined ? STEP_PX * scale : clusterStep(group, scale, size, (a) => size(a) > raw(a));
  const box = span(group, size, step);
  const floor = g.vh - EDGE_MARGIN_PX;
  const ox = side === 'left' ? EDGE_MARGIN_PX - box.minX : g.vw - EDGE_MARGIN_PX - box.maxX;
  const oy = floor - box.maxY;
  const out = [];
  for (const a of PAD_ACTIONS) {
    const off = group[a];
    if (!off) continue;
    const s = size(a), cx = ox + off[0] * step, cy = oy + off[1] * step;
    out.push({ action: a, cx, cy, size: s, rect: { l: cx - s / 2, t: cy - s / 2, r: cx + s / 2, b: cy + s / 2 } });
  }
  return out;
}

// The biggest each cluster can be (a sweep, as padLayout.ts): on screen and off the header always; off the picture
// where any size allows, else covering it rather than shrinking to nothing.
let fitCache = null;
export function padFit(g) {
  if (fitCache && fitCache.key === g.key) return fitCache.fit;
  const fit = computeFit(g);
  fitCache = { key: g.key, fit };
  return fit;
}
function computeFit(g) {
  const { vw, vh } = g;
  if (!vw || !vh) return { left: 1, right: 1 };
  const right = rightCluster(orientationOf(vw, vh));
  const nl = span(LEFT_CLUSTER, (a) => PAD_SIZE[a], STEP_PX);
  const nr = span(right, (a) => PAD_SIZE[a], STEP_PX);
  const usable = vw - 2 * EDGE_MARGIN_PX - CLUSTER_GAP_PX;
  const shareCap = Math.min(1, usable / (nl.w + nr.w));
  const best = (group, side, usePicture) => {
    for (let s = Math.min(1, shareCap); s >= 0.3; s -= 0.01) {
      const placed = placeCluster(group, s, g, side);
      const bad = placed.some((p) => p.rect.l < 0 || p.rect.t < 0 || p.rect.r > vw || p.rect.b > vh ||
        hits(p.rect, g.header) || (usePicture && hits(p.rect, g.picture)));
      if (!bad) return s;
    }
    return 0;
  };
  const fit = (group, side) => best(group, side, true) || best(group, side, false) || 0.3;
  return { left: fit(LEFT_CLUSTER, 'left'), right: fit(right, 'right') };
}

/** The scale in force for one control: its cluster's fit, times whatever size the player chose. */
export function scaleFor(action, g, user = PAD_SCALE_DEFAULT, per) {
  const f = padFit(g);
  return (LEFT_CLUSTER[action] ? f.left : f.right) * effectiveScale(action, user, per);
}
/** Rendered size of one control on this screen, at the player's chosen sizes. */
export function sizeOf(action, g, user = PAD_SCALE_DEFAULT, per) {
  const chosen = Math.round(PAD_SIZE[action] * scaleFor(action, g, user, per));
  const atDefault = Math.round(PAD_SIZE[action] * scaleFor(action, g));
  return Math.max(chosen, Math.min(MIN_TAP_PX, atDefault));
}

/** The out-of-the-box arrangement: the cross bottom-left, the action cluster bottom-right. */
export function defaultLayout(g, user = PAD_SCALE_DEFAULT) {
  const f = padFit(g);
  const u = clampUserScale(user);
  const out = {};
  for (const side of ['left', 'right']) {
    const group = side === 'left' ? LEFT_CLUSTER : rightCluster(orientationOf(g.vw, g.vh));
    const fit = side === 'left' ? f.left : f.right;
    for (const p of placeCluster(group, fit * u, g, side, fit)) out[p.action] = { x: (p.cx / g.vw) * 100, y: (p.cy / g.vh) * 100 };
  }
  return out;
}

// The lowest a button's centre may sit (px) to clear the header, or null when the screen is too short for that
// (then only the edges apply, rather than an inverted range).
function headerFloor(g, half) {
  const y = g.header.b + EDGE_MARGIN_PX + half;
  return g.header.b > 0 && y <= g.vh - EDGE_MARGIN_PX - half ? y : null;
}

/** Pull one control back inside the usable area: on screen, and below the header. */
export function clampSpot(spot, action, g, user = PAD_SCALE_DEFAULT, per) {
  const { vw, vh } = g;
  if (!vw || !vh) return spot;
  const half = sizeOf(action, g, user, per) / 2;
  const minX = ((half + EDGE_MARGIN_PX) / vw) * 100;
  const maxX = 100 - minX;
  let minY = ((half + EDGE_MARGIN_PX) / vh) * 100;
  const maxY = 100 - minY;
  const hf = headerFloor(g, half);
  if (hf !== null) minY = Math.max(minY, (hf / vh) * 100);
  const y = minY >= maxY ? 50 : Math.min(maxY, Math.max(minY, spot.y));
  // A control sized up past the screen's width is centred: visibly too big rather than half off screen.
  if (minX >= maxX) return { x: 50, y };
  return { x: Math.min(maxX, Math.max(minX, spot.x)), y };
}
export function clampLayout(layout, g, user = PAD_SCALE_DEFAULT, per) {
  const out = {};
  for (const a of PAD_ACTIONS) out[a] = clampSpot(layout[a], a, g, user, per);
  return out;
}

/** Snap the four arrows back into a cross around wherever OK is now (padLayout.ts), clear of the header. */
export function groupArrowsAroundOk(layout, g, user = PAD_SCALE_DEFAULT, per) {
  const { vw, vh } = g;
  if (!vw || !vh) return layout;
  const sz = (a) => sizeOf(a, g, user, per);
  const okS = sz('a');
  const gap = Math.max(3, Math.round((okS * (STEP_PX - PAD_SIZE.a)) / PAD_SIZE.a));
  const reach = (a) => (okS + sz(a)) / 2 + gap;
  const off = { up: [0, -reach('up')], down: [0, reach('down')], left: [-reach('left'), 0], right: [reach('right'), 0] };
  const ext = { l: reach('left') + sz('left') / 2, r: reach('right') + sz('right') / 2, t: reach('up') + sz('up') / 2, b: reach('down') + sz('down') / 2 };
  let cx = (layout.a.x / 100) * vw, cy = (layout.a.y / 100) * vh;
  let top = EDGE_MARGIN_PX + ext.t;
  if (g.header.b > 0 && g.header.b + EDGE_MARGIN_PX + ext.t <= vh - EDGE_MARGIN_PX - ext.b) top = g.header.b + EDGE_MARGIN_PX + ext.t;
  cy = Math.min(vh - EDGE_MARGIN_PX - ext.b, Math.max(top, cy));
  cx = Math.min(vw - EDGE_MARGIN_PX - ext.r, Math.max(EDGE_MARGIN_PX + ext.l, cx));
  const out = { ...layout, a: { x: (cx / vw) * 100, y: (cy / vh) * 100 } };
  for (const k of ['up', 'down', 'left', 'right']) out[k] = { x: ((cx + off[k][0]) / vw) * 100, y: ((cy + off[k][1]) / vh) * 100 };
  return out;
}

// ---- Positions and sizes in the store (padLayout.ts formats) ---------------------------------------------------
function sane(v) {
  return isPlainObject(v) && finite(v.x) && finite(v.y) && v.x >= -20 && v.x <= 120 && v.y >= -20 && v.y <= 120;
}
/** Stored layout for one orientation, falling back to the default for anything missing or corrupt. */
export function loadLayout(storage, o, g, user = PAD_SCALE_DEFAULT) {
  const base = defaultLayout(g, user);
  const mine = readAll(storage)[o];
  if (!isPlainObject(mine)) return base;
  for (const a of PAD_ACTIONS) if (sane(mine[a])) base[a] = { x: mine[a].x, y: mine[a].y };
  return base;
}
export function saveLayout(storage, o, layout) {
  if (!ORIENTATIONS.includes(o)) return false;
  const clean = {};
  for (const a of PAD_ACTIONS) if (layout && sane(layout[a])) clean[a] = { x: layout[a].x, y: layout[a].y };
  return writeAll(storage, (all) => { all[o] = clean; });
}
export function loadScale(storage, o) {
  const scales = readAll(storage).scales;
  const v = isPlainObject(scales) ? scales[o] : undefined;
  return v === undefined ? PAD_SCALE_DEFAULT : clampUserScale(v);
}
export function saveScale(storage, o, scale) {
  if (!ORIENTATIONS.includes(o)) return false;
  return writeAll(storage, (all) => {
    const scales = isPlainObject(all.scales) ? all.scales : {};
    scales[o] = clampUserScale(scale);
    all.scales = scales;
  });
}
export function loadPerScales(storage, o) {
  const bag = readAll(storage).perScales;
  const mine = isPlainObject(bag) ? bag[o] : null;
  if (!isPlainObject(mine)) return {};
  const out = {};
  for (const a of PAD_ACTIONS) if (finite(mine[a])) out[a] = clampPerScale(mine[a]);
  return out;
}
export function savePerScales(storage, o, per) {
  if (!ORIENTATIONS.includes(o)) return false;
  return writeAll(storage, (all) => {
    const bag = isPlainObject(all.perScales) ? all.perScales : {};
    const clean = {};
    // Only the ones actually bent, as padLayout.ts.
    for (const a of PAD_ACTIONS) { const v = per ? per[a] : undefined; if (finite(v) && Math.abs(v - PAD_PER_DEFAULT) > 0.001) clean[a] = clampPerScale(v); }
    bag[o] = clean;
    all.perScales = bag;
  });
}
/** Forget one orientation's layout, its panel size and every per-control size. */
export function resetLayout(storage, o) {
  const all = readAll(storage);
  if (!Object.keys(all).length) return false;
  return writeAll(storage, (a) => {
    delete a[o];
    if (isPlainObject(a.scales)) delete a.scales[o];
    if (isPlainObject(a.perScales)) delete a.perScales[o];
  });
}

// ---- Opacity: one number for the panel plus optional per-control overrides, per device (padLayout.ts) ---------
export const PAD_OPACITY_MIN = 0.25;
export const PAD_OPACITY_MAX = 1;
export const PAD_OPACITY_STEP = 0.05;
export const PAD_OPACITY_DEFAULT = 1;
export function clampOpacity(n) {
  const v = finite(n) ? n : PAD_OPACITY_DEFAULT;
  return Math.min(PAD_OPACITY_MAX, Math.max(PAD_OPACITY_MIN, v));
}
export function defaultOpacity() { return { all: PAD_OPACITY_DEFAULT, per: {} }; }
export function parseOpacity(v) {
  const out = defaultOpacity();
  if (!isPlainObject(v)) return out;
  if (typeof v.all === 'number') out.all = clampOpacity(v.all);
  if (isPlainObject(v.per)) for (const a of PAD_ACTIONS) if (finite(v.per[a])) out.per[a] = clampOpacity(v.per[a]);
  return out;
}
export function opacityOf(action, op) { return clampOpacity(op.per[action] !== undefined ? op.per[action] : op.all); }
export function loadOpacity(storage) { return parseOpacity(readAll(storage).opacity); }
export function saveOpacity(storage, op) {
  return writeAll(storage, (all) => {
    const per = {};
    for (const a of PAD_ACTIONS) if (typeof op.per[a] === 'number') per[a] = clampOpacity(op.per[a]);
    all.opacity = { all: clampOpacity(op.all), per };
  });
}
export function resetOpacity(storage) {
  const all = readAll(storage);
  if (!Object.keys(all).length) return false;
  return writeAll(storage, (a) => { delete a.opacity; });
}
