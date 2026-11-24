// room-seat-pad.js: the room seat's on-screen buttons (M3, batch 1 step 4). The DOC Online cabinet seat's touch pad
// (doc-arcade src/components/SeatPad.tsx), in plain DOM: the nine cabinet controls drawn like the deck (or as the
// classic labelled caps), placed where the player put them (room-seat-pad-layout.js, the cabinet's own store), and an
// arrange mode to move, size and fade them.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Two modes, as the cabinet seat:
//   PLAY     every button presses its action through press(action) / release(action) (room-seat-input.js padPress,
//            padRelease). A pointer is captured on press so a finger sliding off still lets go; a synthetic (scripted)
//            press is ignored. Several fingers at once are fine: each pointer holds its own button.
//   ARRANGE  every button is a drag handle and presses NOTHING: press and hold lifts a button, then it follows the
//            finger; a tap picks it for the size and opacity rows; arrow keys nudge a focused one. onArrange(true)
//            lets the page suspend all game input (the cabinet's inputSuspended); Done saves and calls
//            onArrange(false). A pointer that went down in arrange mode never presses, even after Done.
// Shown per the player's own "On-screen buttons" choice (doc_controls_v1 showPad: null = auto, a touch screen;
// true; false), which the Controls panel writes; the header button toggles it for this visit only. onState() is
// called whenever the pad shows, hides, or starts or ends arranging, so the page can label its buttons.
// The pad lives inside #stage, so it stays on screen in full screen, and lays itself out again on a resize, a turn
// of the device, full screen, or a change in the header's height. No image assets: every face is CSS and inline SVG.
// On a phone or a tablet the page lays itself out around the buttons (room-seat-layout.js) and hands their places in
// (preset): those are then the default arrangement, kept in records of their own (layoutSlot), and the page calls
// relayout() when they change. A press writes nothing to the page (the pressed look is the style sheet's :active, a
// transform), so hammering Whip costs no layout; haptic(action), when given, is told of every press that went in.

import {
  PAD_ACTIONS, PAD_STORAGE_KEY, ROOM_PAD_STORAGE_KEY, PAD_PER_DEFAULT, PAD_PER_MAX, PAD_PER_MIN, PAD_SCALE_DEFAULT, PAD_SCALE_MAX, PAD_SCALE_MIN,
  PAD_SCALE_STEP, PAD_STYLE_DEFAULT, PAD_OPACITY_MAX, PAD_OPACITY_MIN, PAD_OPACITY_STEP,
  padGeometry, orientationOf, clampLayout, clampSpot, clampPerScale, clampUserScale, clampOpacity, defaultLayout,
  defaultOpacity, groupArrowsAroundOk, layoutSlot, loadLayout, loadOpacity, loadPerScales, loadScale, loadStyle, opacityOf,
  resetLayout, resetOpacity, saveLayout, saveOpacity, savePerScales, saveScale, saveStyle, sizeOf,
} from './room-seat-pad-layout.js';

export const SEAT_CONTROLS_KEY = 'doc_controls_v1';
export const CONTROLS_EVENT = 'doc-controls-changed';
/** How long a press has to last in arrange mode before the button lifts (SeatPad.tsx HOLD_MS). */
export const HOLD_MS = 260;
// The horse buttons' words follow the CABINET's release: Rev C prints Hold and Whip, the JP '99 deck prints these.
export const PAD_COPY = Object.freeze({ en: Object.freeze({ hold: 'HOLD', whip: 'WHIP' }), ja: Object.freeze({ hold: '抑え', whip: 'ムチ' }) });
export function padLangFor(release) { return release === 'doc99' ? 'ja' : 'en'; }

/** The player's stored choice: true, false, or null (auto). Never throws. */
export function readShowPad(storage) {
  try {
    const raw = storage ? storage.getItem(SEAT_CONTROLS_KEY) : null;
    const j = raw ? JSON.parse(raw) : null;
    return j && typeof j === 'object' && typeof j.showPad === 'boolean' ? j.showPad : null;
  } catch {
    return null;
  }
}
/** Whether the pad shows: the stored choice, or on a coarse (touch) pointer when it is auto. */
export function padWanted(pref, coarse) { return typeof pref === 'boolean' ? pref : !!coarse; }
export function coarsePointer(win) {
  try { return !!(win && typeof win.matchMedia === 'function' && win.matchMedia('(pointer: coarse)').matches); } catch { return false; }
}

/** What each control is called and drawn as, per skin (SeatPad.tsx faceOf). */
export function faceOf(action, lang, style) {
  const w = PAD_COPY[lang] || PAD_COPY.en;
  const arrow = (dir, label) => ({ cls: `dpad ${dir}`, label, body: 'arrow' });
  switch (action) {
    case 'up': return arrow('up', 'Up');
    case 'down': return arrow('down', 'Down');
    case 'left': return arrow('left', 'Left');
    case 'right': return arrow('right', 'Right');
    case 'a': return { cls: 'ok', label: 'OK', body: 'text', text: 'OK' };
    case 'start': return { cls: 'start', label: 'Start', body: 'text', text: 'START' };
    case 'card': return style === 'classic' ? { cls: 'card', label: 'Insert card', body: 'text', text: 'CARD' } : { cls: 'card', label: 'Insert card', body: 'card' };
    case 'b': return { cls: 'hold', label: w.hold, body: 'word', text: w.hold };
    case 'whip': return { cls: 'whip', label: w.whip, body: 'word', text: w.whip };
    default: return null;
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function createRoomSeatPad({
  doc = globalThis.document, win = globalThis.window, storage, parent, picture = null, chrome = [], lang = 'en',
  press = () => false, release = () => false, releaseAll = () => {}, onArrange = () => {}, onState = () => {},
  preset = null, haptic = null,
} = {}) {
  if (storage === undefined) { try { storage = win.localStorage; } catch { storage = null; } }
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const svg = (tag, attrs) => { const e = doc.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };

  let shown = false;
  let override = null; // the header button's choice for this visit, or null to follow the stored one
  let arranging = false;
  let orient = 'landscape';
  let g = padGeometry(1, 1);
  let layout = null;
  let scale = PAD_SCALE_DEFAULT;
  let per = {};
  let style = PAD_STYLE_DEFAULT;
  let opacity = defaultOpacity();
  let sel = null;
  let lifted = null;
  let hold = null; // { timer, x, y, action, dx, dy }
  let drag = null; // { action, dx, dy }
  const pointers = new Map(); // pointerId -> { action, mode: 'play' | 'arrange' }

  const root = el('div', `docpad ${style}`);
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Game controls');
  root.hidden = true;
  const buttons = {};
  let panel = null;

  function face(action) {
    const f = faceOf(action, lang, style);
    const b = buttons[action];
    b.replaceChildren();
    if (f.body === 'arrow') {
      const s = svg('svg', { viewBox: '0 0 40 34', 'aria-hidden': 'true', focusable: 'false', class: 'dm-arrow' });
      s.append(svg('polygon', { points: '20,2.5 37.5,31.5 2.5,31.5', fill: 'currentColor', stroke: '#2b3138', 'stroke-width': '2.5', 'stroke-linejoin': 'round' }));
      b.append(s);
    } else if (f.body === 'card') {
      const s = svg('svg', { viewBox: '0 0 34 22', 'aria-hidden': 'true', focusable: 'false', class: 'dm-card' });
      s.append(svg('rect', { x: 1.5, y: 1.5, width: 31, height: 19, rx: 3, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }));
      s.append(svg('rect', { x: 5, y: 6, width: 14, height: 2.4, rx: 1.2, fill: 'currentColor' }));
      s.append(svg('rect', { x: 5, y: 11, width: 9, height: 2.4, rx: 1.2, fill: 'currentColor' }));
      b.append(s);
    } else if (f.body === 'word') {
      const w = el('span', 'dm-word', f.text);
      w.setAttribute('lang', lang);
      b.append(w);
    } else {
      b.append(el('span', 'dm-txt', f.text));
    }
    return f;
  }

  // ---- Play: the press goes to the game; arrange: the press picks the button up --------------------------------
  function down(action, e) {
    const b = buttons[action];
    if (arranging) { startHold(action, e, b); return; }
    if (e.isTrusted === false) return; // a scripted press, not a finger
    if (typeof e.preventDefault === 'function') e.preventDefault();
    try { b.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    if (pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { action, mode: 'play' });
    if (press(action) && haptic) { try { haptic(action); } catch { /* no buzz */ } }
  }
  function up(e, cancelled) {
    const p = pointers.get(e.pointerId);
    if (!p) { if (arranging) dropHeld(); return; }
    if (p.mode === 'play' && !cancelled && e.isTrusted === false) return; // a scripted release, as SeatPad
    pointers.delete(e.pointerId);
    if (p.mode === 'play') release(p.action);
    else dropHeld();
  }
  // Let go of everything this pad holds (hidden, arrange mode, the page going away).
  function letGo() {
    for (const [id, p] of pointers) if (p.mode === 'play') { pointers.delete(id); release(p.action); }
    releaseAll();
  }

  for (const action of PAD_ACTIONS) {
    const b = el('button', 'docbtn');
    b.type = 'button';
    b.dataset.action = action;
    b.addEventListener('pointerdown', (e) => down(action, e));
    b.addEventListener('pointerup', (e) => up(e, false));
    b.addEventListener('pointercancel', (e) => up(e, true));
    b.addEventListener('lostpointercapture', (e) => { if (pointers.has(e.pointerId)) up(e, true); });
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    b.addEventListener('keydown', (e) => {
      if (!arranging) return;
      const step = e.shiftKey ? 16 : 4;
      const by = { ArrowUp: [0, -step], ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] }[e.key];
      if (by) { e.preventDefault(); nudge(action, by[0], by[1]); }
    });
    buttons[action] = b;
    root.append(b);
  }
  parent.append(root);

  // ---- Arrange: hold to lift, drag to move, tap to pick ---------------------------------------------------------
  function cancelHold() { if (hold) win.clearTimeout(hold.timer); hold = null; }
  function startHold(action, e, b) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    const r = b.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    try { b.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    pointers.set(e.pointerId, { action, mode: 'arrange' });
    cancelHold();
    hold = {
      x: e.clientX, y: e.clientY, action,
      timer: win.setTimeout(() => {
        hold = null;
        drag = { action, dx, dy };
        lifted = action;
        paint();
        try { if (win.navigator && win.navigator.vibrate) win.navigator.vibrate(12); } catch { /* no buzz */ }
      }, HOLD_MS),
    };
  }
  function dropHeld() {
    // Let go before the lift: a tap, which picks this control for the size rows (again: back to the whole panel).
    if (hold && !drag) sel = sel === hold.action ? null : hold.action;
    cancelHold();
    drag = null;
    lifted = null;
    paint();
    updatePanel();
  }
  function onMove(e) {
    if (hold && !drag) {
      if (Math.abs(e.clientX - hold.x) > 10 || Math.abs(e.clientY - hold.y) > 10) cancelHold();
      return;
    }
    if (!drag || !layout) return;
    const next = { x: ((e.clientX - drag.dx) / g.vw) * 100, y: ((e.clientY - drag.dy) / g.vh) * 100 };
    layout = { ...layout, [drag.action]: clampSpot(next, drag.action, g, scale, per) };
    paint();
  }
  function nudge(action, dx, dy) {
    if (!layout) return;
    layout = { ...layout, [action]: clampSpot({ x: layout[action].x + (dx / g.vw) * 100, y: layout[action].y + (dy / g.vh) * 100 }, action, g, scale, per) };
    paint();
  }
  function resize(next) {
    if (sel) {
      per = { ...per, [sel]: clampPerScale(next) };
    } else {
      scale = clampUserScale(next);
    }
    layout = clampLayout(layout, g, scale, per);
    paint();
    updatePanel();
  }
  function setOpacityTo(next) {
    const v = clampOpacity(Math.round(next * 100) / 100);
    opacity = sel ? { ...opacity, per: { ...opacity.per, [sel]: v } } : { ...opacity, all: v };
    paint();
    updatePanel();
  }
  function clearOpacityOverride(a) { const p = { ...opacity.per }; delete p[a]; opacity = { ...opacity, per: p }; paint(); updatePanel(); }
  function snapArrows() { layout = groupArrowsAroundOk(layout, g, scale, per); paint(); }
  function chooseStyle(next) { style = next; saveStyle(storage, next); for (const a of PAD_ACTIONS) face(a); paint(); updatePanel(); }
  function restoreDefaults() {
    resetLayout(storage, layoutSlot(orient, g));
    resetOpacity(storage);
    opacity = defaultOpacity();
    scale = PAD_SCALE_DEFAULT;
    per = {};
    sel = null;
    layout = defaultLayout(g, PAD_SCALE_DEFAULT);
    paint();
    updatePanel();
  }

  // The arrange panel is built once per arrange session and then only updated, so a slider being dragged is never
  // replaced under the finger.
  let parts = null;
  function buildPanel() {
    panel.replaceChildren();
    panel.append(el('b', '', 'Press and hold a button, then drag it'));
    const note = el('small', '');
    panel.append(note);
    const st = el('div', 'padstyle');
    st.setAttribute('role', 'radiogroup');
    st.setAttribute('aria-label', 'Button style');
    st.append(el('span', 'padsize-lbl', 'Button style'));
    const seg = el('div', 'padstyle-seg');
    const styleBtns = {};
    for (const [v, name] of [['cabinet', 'Cabinet'], ['classic', 'Classic']]) {
      const b = el('button', 'padstyle-opt', name);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => chooseStyle(v));
      styleBtns[v] = b;
      seg.append(b);
    }
    st.append(seg);
    panel.append(st);
    const row = (extraText, onExtra, less, more, onSet) => {
      const r = el('div', 'padsize');
      const name = el('span', 'padsize-lbl');
      const extra = el('button', 'padsize-all', extraText);
      extra.type = 'button';
      extra.addEventListener('click', onExtra);
      const minus = el('button', 'padsize-step', '\u2212');
      minus.type = 'button';
      minus.setAttribute('aria-label', less);
      const range = el('input');
      range.type = 'range';
      const plus = el('button', 'padsize-step', '+');
      plus.type = 'button';
      plus.setAttribute('aria-label', more);
      const out = el('output', 'padsize-val');
      const x = { r, name, extra, minus, range, plus, out, value: 1, step: 0.05 };
      minus.addEventListener('click', () => onSet(x.value - x.step));
      plus.addEventListener('click', () => onSet(x.value + x.step));
      range.addEventListener('input', () => onSet(Number(range.value)));
      r.append(name, extra, minus, range, plus, out);
      panel.append(r);
      return x;
    };
    const size = row('All', () => { sel = null; paint(); updatePanel(); }, 'Smaller', 'Bigger', resize);
    const fade = row('Match all', () => { if (sel) clearOpacityOverride(sel); }, 'Fainter', 'More solid', setOpacityTo);
    const foot = el('div', 'padarrange-row');
    const mk = (cls, text, fn) => { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', fn); foot.append(b); };
    mk('pa-reset', 'Arrows around OK', snapArrows);
    mk('pa-reset', 'Reset to default', restoreDefaults);
    mk('pa-done', 'Done', () => setArranging(false));
    panel.append(foot);
    parts = { note, styleBtns, size, fade };
  }
  function setRow(x, { name, value, min, max, step, valueText, extra }) {
    x.value = value;
    x.step = step;
    x.name.textContent = name;
    x.extra.hidden = !extra;
    x.r.className = extra ? 'padsize has-extra' : 'padsize';
    x.range.min = String(min);
    x.range.max = String(max);
    x.range.step = String(step);
    if (Number(x.range.value) !== value) x.range.value = String(value);
    x.range.setAttribute('aria-label', name);
    x.range.setAttribute('aria-valuetext', valueText);
    x.minus.disabled = value <= min + 1e-9;
    x.plus.disabled = value >= max - 1e-9;
    x.out.textContent = `${Math.round(value * 100)}%`;
  }
  function updatePanel() {
    if (!panel) return;
    if (!parts) buildPanel();
    panel.style.top = `${Math.round(Math.max(14, g.header.b + 8))}px`;
    const label = (a) => faceOf(a, lang, style).label;
    parts.note.textContent = `Tap a button to size or fade just that one. Let go and it stays there. Saved on this device for ${orient} screens. Arrow keys nudge a focused button.`;
    for (const [v, b] of Object.entries(parts.styleBtns)) { b.className = `padstyle-opt${style === v ? ' on' : ''}`; b.setAttribute('aria-checked', String(style === v)); }
    const sizeValue = sel ? (per[sel] !== undefined ? per[sel] : PAD_PER_DEFAULT) : scale;
    setRow(parts.size, {
      name: sel ? `Size: ${label(sel)}` : 'Size: all buttons', value: sizeValue,
      min: sel ? PAD_PER_MIN : PAD_SCALE_MIN, max: sel ? PAD_PER_MAX : PAD_SCALE_MAX, step: PAD_SCALE_STEP,
      valueText: `${Math.round(sizeValue * 100)} percent`, extra: !!sel,
    });
    const opValue = sel ? opacityOf(sel, opacity) : opacity.all;
    setRow(parts.fade, {
      name: sel ? `Opacity: ${label(sel)}` : 'Opacity: all buttons', value: opValue,
      min: PAD_OPACITY_MIN, max: PAD_OPACITY_MAX, step: PAD_OPACITY_STEP,
      valueText: `${Math.round(opValue * 100)} percent solid`, extra: !!sel && opacity.per[sel] !== undefined,
    });
  }

  // ---- Paint and lay out ----------------------------------------------------------------------------------------
  function paint() {
    root.className = `docpad ${style}${arranging ? ' arranging' : ''}`;
    if (!layout) return;
    for (const action of PAD_ACTIONS) {
      const b = buttons[action];
      const spot = layout[action];
      const size = sizeOf(action, g, scale, per);
      const op = opacityOf(action, opacity);
      const f = faceOf(action, lang, style);
      b.className = `docbtn ${f.cls}${lifted === action ? ' lifted' : ''}${arranging && sel === action ? ' selected' : ''}`;
      b.style.left = `${spot.x}%`;
      b.style.top = `${spot.y}%`;
      b.style.width = `${size}px`;
      b.style.height = `${size}px`;
      b.style.opacity = op < 1 ? String(op) : '';
      b.setAttribute('aria-label', arranging ? `Move ${f.label}` : f.label);
      // Focusable only while arranging (the arrow-key nudge): in play a focused pad button would take Enter from Start.
      b.tabIndex = arranging ? 0 : -1;
    }
  }
  function measure() {
    const vw = win.innerWidth || 1, vh = win.innerHeight || 1;
    const fullscreen = !!doc.fullscreenElement;
    let headerBottom = 0;
    if (!fullscreen) {
      for (const e of chrome) {
        if (!e || e.hidden || typeof e.getBoundingClientRect !== 'function') continue;
        const r = e.getBoundingClientRect();
        if (r.height > 0) headerBottom = Math.max(headerBottom, r.bottom);
      }
    }
    let pic = null;
    if (picture && typeof picture.getBoundingClientRect === 'function') {
      const r = picture.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) pic = { l: r.left, t: r.top, r: r.right, b: r.bottom };
    }
    // The touch layout: the page says where the buttons go and where its bar ends.
    let slots = null;
    try { const p = typeof preset === 'function' ? preset() : null; if (p && p.slots) { slots = p.slots; if (typeof p.headerBottom === 'number') return padGeometry(vw, vh, { picture: pic, headerBottom: p.headerBottom, fullscreen: false, preset: slots }); } } catch { slots = null; }
    return padGeometry(vw, vh, { picture: pic, headerBottom, fullscreen, preset: slots });
  }
  function relayout() {
    if (!shown) return;
    g = measure();
    const o = orientationOf(g.vw, g.vh);
    if (arranging && o === orient && layout) {
      layout = clampLayout(layout, g, scale, per); // mid-arrange: keep what the player is doing
    } else {
      orient = o;
      const slot = layoutSlot(o, g);
      scale = loadScale(storage, slot);
      per = loadPerScales(storage, slot);
      const s = loadStyle(storage);
      if (s !== style) { style = s; for (const a of PAD_ACTIONS) face(a); }
      opacity = loadOpacity(storage);
      layout = clampLayout(loadLayout(storage, slot, g, scale), g, scale, per);
    }
    paint();
    updatePanel();
  }

  function setArranging(on) {
    on = !!on && shown;
    if (on === arranging) return;
    if (on) {
      letGo(); // a button held as arrange mode starts would never be let go
      arranging = true;
      sel = null;
      panel = el('div', 'padarrange');
      panel.setAttribute('role', 'group');
      panel.setAttribute('aria-label', 'Move the controls');
      parent.append(panel);
      win.addEventListener('pointermove', onMove);
      onArrange(true);
    } else {
      // Done is the save point (dragging writes to the page only).
      cancelHold();
      drag = null;
      lifted = null;
      const slot = layoutSlot(orient, g);
      if (layout) saveLayout(storage, slot, layout);
      saveScale(storage, slot, scale);
      savePerScales(storage, slot, per);
      saveOpacity(storage, opacity);
      sel = null;
      arranging = false;
      // A pointer that went down while arranging presses nothing when it lifts.
      for (const [id, p] of pointers) if (p.mode === 'arrange') pointers.delete(id);
      win.removeEventListener('pointermove', onMove);
      if (panel) { panel.remove(); panel = null; parts = null; }
      onArrange(false);
    }
    paint();
    updatePanel();
    onState();
  }

  function setShown(on) {
    on = !!on;
    if (on === shown) return;
    if (!on) { if (arranging) setArranging(false); letGo(); }
    shown = on;
    root.hidden = !on;
    if (doc.body && doc.body.classList) doc.body.classList.toggle('pad-on', on);
    if (on) relayout();
    onState();
  }
  const wanted = () => (override !== null ? override : padWanted(readShowPad(storage), coarsePointer(win)));
  function syncPref() { override = null; setShown(wanted()); }

  // Faces, then the events that move or show the pad.
  for (const a of PAD_ACTIONS) face(a);
  const onResize = () => relayout();
  const onControls = () => syncPref();
  const onStorage = (e) => {
    if (!e || e.key === null || e.key === SEAT_CONTROLS_KEY) syncPref();
    else if ((e.key === ROOM_PAD_STORAGE_KEY || e.key === PAD_STORAGE_KEY) && !arranging) relayout();
  };
  const onHidden = () => { if (doc.visibilityState === 'hidden') letGo(); };
  win.addEventListener('resize', onResize);
  win.addEventListener('orientationchange', onResize);
  doc.addEventListener('fullscreenchange', onResize);
  doc.addEventListener('visibilitychange', onHidden);
  win.addEventListener('blur', letGo);
  win.addEventListener(CONTROLS_EVENT, onControls);
  win.addEventListener('storage', onStorage);
  let ro = null;
  try {
    if (typeof win.ResizeObserver === 'function') {
      ro = new win.ResizeObserver(() => relayout());
      for (const e of [...chrome, picture]) if (e) ro.observe(e);
    }
  } catch { ro = null; }
  let mq = null;
  try {
    mq = typeof win.matchMedia === 'function' ? win.matchMedia('(pointer: coarse)') : null;
    if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', onControls);
  } catch { mq = null; }
  syncPref();

  function destroy() {
    setShown(false);
    win.removeEventListener('resize', onResize);
    win.removeEventListener('orientationchange', onResize);
    doc.removeEventListener('fullscreenchange', onResize);
    doc.removeEventListener('visibilitychange', onHidden);
    win.removeEventListener('blur', letGo);
    win.removeEventListener(CONTROLS_EVENT, onControls);
    win.removeEventListener('storage', onStorage);
    if (ro) ro.disconnect();
    if (mq && typeof mq.removeEventListener === 'function') mq.removeEventListener('change', onControls);
    root.remove();
  }

  return {
    shown: () => shown,
    toggle() { override = !shown; setShown(override); return shown; },
    setShown(on) { override = !!on; setShown(override); },
    syncPref,
    arranging: () => arranging,
    setArranging,
    relayout,
    destroy,
    get layout() { return layout; },
  };
}
