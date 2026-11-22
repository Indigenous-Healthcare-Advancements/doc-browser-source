// room-seat-controls.js: the room seat's "Customize controls" panel (M3, batch 1 step 3).
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The same panel as the DOC Online cabinet seat (doc-arcade src/components/ControlsMapper.tsx), in plain DOM, writing
// the same store (localStorage "doc_controls_v1", controls.ts ControlPrefs), so one mapping serves the cabinets and the
// rooms on this device. Two pages:
//   KEYBOARD   one key per action. Click a row, press a key. Escape and F can never be taken.
//   CONTROLLER any number of buttons per action, one action per button. Set, then press a button or trigger; a
//              bound button comes off on its own; one tap swaps LT and RT.
// Taking a key or button that is in use moves it here (as the cabinet seat). Reset puts one device kind back to the
// published defaults (room-seat-input.js seatDefaultControls, the same maps as controls.ts DEFAULT_KEYMAP/DEFAULT_GP).
// While the panel is open the seat's input is suspended (input-map.js suspend), so a capture press never reaches the
// board. On close the seat stays suspended until every controller button is let go, so the press that set a binding
// (or one resting on a trigger) never reaches the board; the capture poll ignores anything already down when it starts.
//
// Batch 1 step 4: the cabinet's 'On-screen buttons: Auto / On / Off' row (ControlsMapper.tsx, its foot) writes showPad
// (null = auto: shown on a touch screen); every save tells the page with the cabinet's own window event
// (CONTROLS_EVENT, controls.ts), so the on-screen pad (room-seat-pad.js) follows at once.
//
// The seat applies the stored map with its own rule (room-seat-input.js seatControlsFrom): a device kind that leaves an
// action with nothing falls back to the defaults. The panel says so, so the player is never surprised by it.

import { SEAT_CONTROLS_KEY, SEAT_RESERVED_KEYS, SEAT_ACTION_IDS, seatDefaultControls, seatControlsFrom } from './room-seat-input.js';

export const SEAT_ACTIONS = Object.freeze([
  ['up', 'Up', 'select'], ['down', 'Down', 'select'], ['left', 'Left', 'select'], ['right', 'Right', 'select'],
  ['a', 'OK', 'confirm'], ['start', 'Start', 'the yellow button'], ['b', 'Hold', 'save the gauge'],
  ['whip', 'Whip', 'go'], ['card', 'Insert card', 'at the card screen'],
].map(([action, label, hint]) => Object.freeze({ action, label, hint })));
const VALID = new Set(Object.keys(SEAT_ACTION_IDS));
const MAX_PAD_INDEX = 31;
export const LT = 6;
export const RT = 7;
const isPlainObject = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
// The cabinet seat's 'the controls changed' event (controls.ts CONTROLS_EVENT).
export const CONTROLS_EVENT = 'doc-controls-changed';

// The store as the cabinet seat reads it (controls.ts sanitizeControls): per field, junk falls back to the defaults;
// a controller map emptied on purpose stays empty.
export function sanitizePrefs(j) {
  const d = seatDefaultControls();
  const base = { keys: { ...d.keys }, pads: { ...d.pads }, showPad: null };
  if (!isPlainObject(j)) return base;
  if (isPlainObject(j.keys)) {
    const keys = {};
    for (const [code, act] of Object.entries(j.keys)) if (code && !SEAT_RESERVED_KEYS.has(code) && VALID.has(act)) keys[code] = act;
    if (Object.keys(keys).length) base.keys = keys;
  }
  if (isPlainObject(j.pads)) {
    const entries = Object.entries(j.pads);
    const pads = {};
    for (const [idx, act] of entries) {
      const n = Number(idx);
      if (Number.isInteger(n) && n >= 0 && n <= MAX_PAD_INDEX && VALID.has(act)) pads[n] = act;
    }
    if (Object.keys(pads).length || entries.length === 0) base.pads = pads;
  }
  if (typeof j.showPad === 'boolean') base.showPad = j.showPad;
  return base;
}

export function keyBindable(code, key = '') {
  if (!code || String(key).startsWith('Gamepad')) return 'not-a-key';
  if (SEAT_RESERVED_KEYS.has(code)) return 'reserved';
  return 'ok';
}
export function bindKey(keys, code, action) {
  if (!VALID.has(action) || keyBindable(code) !== 'ok') return { keys: { ...keys }, stolen: null };
  const next = Object.fromEntries(Object.entries(keys).filter(([, a]) => a !== action));
  const stolen = next[code] && next[code] !== action ? next[code] : null;
  next[code] = action;
  return { keys: next, stolen };
}
export function bindPad(pads, idx, action) {
  const next = { ...pads };
  if (!VALID.has(action) || !Number.isInteger(idx) || idx < 0 || idx > MAX_PAD_INDEX) return { pads: next, stolen: null };
  const prev = next[idx];
  next[idx] = action;
  return { pads: next, stolen: prev && prev !== action ? prev : null };
}
export function unbindPad(pads, idx) { const next = { ...pads }; delete next[idx]; return next; }
export function swapTriggers(pads) {
  const next = { ...pads };
  const a = pads[LT], b = pads[RT];
  delete next[LT]; delete next[RT];
  if (b) next[LT] = b;
  if (a) next[RT] = a;
  return next;
}
export function padsForAction(pads, action) {
  return Object.entries(pads).filter(([, a]) => a === action).map(([i]) => Number(i)).sort((x, y) => x - y);
}
export function keyLabel(code) {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }[code] || code;
}
export function padLabel(idx) {
  return ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Select', 'Start', 'L3', 'R3', 'D-Up', 'D-Down', 'D-Left', 'D-Right'][idx] || `Btn ${idx}`;
}
const label = (action) => (SEAT_ACTIONS.find((a) => a.action === action) || { label: action }).label;

export function loadPrefs(storage) {
  try { const raw = storage ? storage.getItem(SEAT_CONTROLS_KEY) : null; return sanitizePrefs(raw ? JSON.parse(raw) : null); } catch { return sanitizePrefs(null); }
}
export function savePrefs(storage, p) {
  try { storage.setItem(SEAT_CONTROLS_KEY, JSON.stringify(p)); return true; } catch { return false; }
}

// createControlsPanel({ doc, win, storage, seatInput }): { open(), close(), isOpen() }.
// seatInput is room-seat-input.js's handle (null before the seat has one: the panel still edits the store).
export function createControlsPanel({ doc = globalThis.document, win = globalThis.window, storage, seatInput = null } = {}) {
  if (storage === undefined) { try { storage = win.localStorage; } catch { storage = null; } }
  let prefs = loadPrefs(storage);
  let tab = 'keys';
  let listening = null;
  let note = '';
  let root = null;
  let raf = 0;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const firstPad = () => { try { return Array.from((win.navigator.getGamepads && win.navigator.getGamepads()) || []).find((p) => p && p.connected) || null; } catch { return null; } };

  function commit(next) {
    prefs = next;
    if (!savePrefs(storage, prefs)) note = 'This browser would not save the controls (storage blocked); they last until you leave.';
    if (seatInput) seatInput.reload();
    try { if (win && typeof win.dispatchEvent === 'function' && typeof Event === 'function') win.dispatchEvent(new Event(CONTROLS_EVENT)); } catch { /* nobody listening */ }
    render();
  }
  function setListening(a) { listening = a; note = ''; render(); watchPad(); }

  function onKey(e) {
    if (!root) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (listening) setListening(null); else close(); return; }
    if (!listening) return;
    e.preventDefault(); e.stopPropagation();
    if (tab !== 'keys') { note = 'Press a button on the controller, or Esc to cancel.'; render(); return; }
    const ok = keyBindable(e.code, e.key);
    if (ok === 'reserved') { note = `${keyLabel(e.code)} is reserved (Esc closes pop-ups, F is full screen).`; render(); return; }
    if (ok !== 'ok') return;
    const act = listening;
    listening = null;
    const r = bindKey(prefs.keys, e.code, act);
    note = r.stolen ? `${keyLabel(e.code)} moved here (was ${label(r.stolen)}).` : '';
    commit({ ...prefs, keys: r.keys });
  }

  // A FRESH controller press while listening on the Controller page: whatever is down when listening starts is ignored
  // until it is let go.
  function watchPad() {
    if (raf) { win.cancelAnimationFrame(raf); raf = 0; }
    if (!root || !listening || tab !== 'pad') return;
    const baseline = new Set();
    let first = true;
    const poll = () => {
      raf = 0;
      if (!root || !listening || tab !== 'pad') return;
      const gp = firstPad();
      if (gp) {
        let hit = -1;
        gp.buttons.forEach((b, i) => {
          if (!b) return;
          if (first && b.pressed) baseline.add(i);
          else if (!first && b.pressed && !baseline.has(i) && hit < 0) hit = i;
          if (!b.pressed) baseline.delete(i);
        });
        first = false;
        if (hit >= 0) {
          const act = listening;
          listening = null;
          const r = bindPad(prefs.pads, hit, act);
          note = r.stolen ? `${padLabel(hit)} moved here (was ${label(r.stolen)}).` : `${padLabel(hit)} is now ${label(act)}.`;
          commit({ ...prefs, pads: r.pads });
          return;
        }
      }
      raf = win.requestAnimationFrame(poll);
    };
    raf = win.requestAnimationFrame(poll);
  }

  function render() {
    if (!root) return;
    const body = root.querySelector('.cm-body');
    body.replaceChildren();
    const tabs = el('div', 'cm-tabs');
    for (const [t, name] of [['keys', 'Keyboard'], ['pad', 'Controller']]) {
      const b = el('button', `cm-tab${tab === t ? ' on' : ''}`, name);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(tab === t));
      b.addEventListener('click', () => { tab = t; listening = null; note = ''; render(); watchPad(); });
      tabs.append(b);
    }
    body.append(tabs);
    const used = seatControlsFrom(prefs);
    const kind = tab === 'keys' ? 'keys' : 'pads';
    const d = seatDefaultControls();
    const custom = JSON.stringify(prefs[kind]) !== JSON.stringify(d[kind]);
    const hint = el('p', 'cm-hint', tab === 'keys'
      ? 'Click an action, then press the key you want. Esc and F stay reserved. Saved on this device, for the cabinets and the rooms.'
      : 'Tap Set on an action, then press any controller button or trigger. A button does one thing; an action can have several buttons. Saved on this device.');
    body.append(hint);
    if (custom && !used.custom[kind]) body.append(el('p', 'cm-note', 'Some action has nothing on it, so this seat uses the defaults until every action has one.'));
    if (tab === 'pad' && !firstPad()) body.append(el('p', 'cm-note', 'No controller found yet. Connect one and press any button on it.'));
    if (note) { const n = el('p', 'cm-note', note); n.setAttribute('role', 'status'); body.append(n); }
    if (tab === 'pad') {
      const sw = el('div', 'cm-swap');
      const lt = prefs.pads[LT], rt = prefs.pads[RT];
      sw.append(el('span', '', `Triggers: LT = ${lt ? label(lt) : 'nothing'}, RT = ${rt ? label(rt) : 'nothing'}`));
      const b = el('button', 'cm-swap-btn', 'Swap LT and RT');
      b.type = 'button';
      b.addEventListener('click', () => { const pads = swapTriggers(prefs.pads); listening = null; note = `Swapped. LT = ${pads[LT] ? label(pads[LT]) : 'nothing'}, RT = ${pads[RT] ? label(pads[RT]) : 'nothing'}.`; commit({ ...prefs, pads }); });
      sw.append(b);
      body.append(sw);
    }
    const rows = el('div', 'cm-rows');
    for (const a of SEAT_ACTIONS) {
      const isL = listening === a.action;
      const row = el(tab === 'keys' ? 'button' : 'div', `cm-row${isL ? ' is-listening' : ''}`);
      const act = el('span', 'cm-act');
      act.append(el('b', '', a.label), el('span', '', ` ${a.hint}`));
      const binds = el('span', 'cm-binds');
      if (tab === 'keys') {
        row.type = 'button';
        const k = Object.entries(prefs.keys).find(([, x]) => x === a.action);
        binds.append(isL ? el('span', 'cm-listen', 'press a key…') : el('kbd', '', k ? keyLabel(k[0]) : 'none'));
        row.addEventListener('click', () => setListening(isL ? null : a.action));
      } else {
        if (isL) binds.append(el('span', 'cm-listen', 'press a controller button…'));
        else {
          const pads = padsForAction(prefs.pads, a.action);
          if (!pads.length) binds.append(el('span', 'cm-none', 'none'));
          for (const i of pads) {
            const chip = el('button', 'cm-chip', `${padLabel(i)} ×`);
            chip.type = 'button';
            chip.title = 'Remove';
            chip.setAttribute('aria-label', `Remove ${padLabel(i)} from ${a.label}`);
            chip.addEventListener('click', () => { note = `${padLabel(i)} removed from ${a.label}.`; commit({ ...prefs, pads: unbindPad(prefs.pads, i) }); });
            binds.append(chip);
          }
        }
        const set = el('button', 'cm-set', isL ? 'Cancel' : 'Set');
        set.type = 'button';
        set.addEventListener('click', () => setListening(isL ? null : a.action));
        binds.append(set);
      }
      row.append(act, binds);
      rows.append(row);
    }
    body.append(rows);
    if (tab === 'pad') body.append(el('p', 'cm-hint', 'The left stick always moves the arrows as well.'));
    const foot = el('div', 'cm-foot');
    const reset = el('button', 'cm-reset', tab === 'keys' ? 'Reset keyboard' : 'Reset controller');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      listening = null;
      note = tab === 'keys' ? 'Keyboard is back to the defaults.' : 'Controller is back to the defaults (LT = Whip, RT = Hold).';
      commit(tab === 'keys' ? { ...prefs, keys: { ...d.keys } } : { ...prefs, pads: { ...d.pads } });
    });
    foot.append(reset);
    body.append(foot);
    // Auto is what the cabinet's Reset restored: on for touch screens, off otherwise.
    const ov = el('div', 'cm-overlay');
    ov.setAttribute('role', 'radiogroup');
    ov.setAttribute('aria-label', 'On-screen buttons');
    const ovl = el('span', '', 'On-screen buttons ');
    ovl.append(el('small', '', '(turn off for a clean view with a controller)'));
    const seg = el('span', 'cm-seg');
    for (const [v, name] of [[null, 'Auto'], [true, 'On'], [false, 'Off']]) {
      const b = el('button', `cm-seg-opt${prefs.showPad === v ? ' on' : ''}`, name);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(prefs.showPad === v));
      b.addEventListener('click', () => commit({ ...prefs, showPad: v }));
      seg.append(b);
    }
    ov.append(ovl, seg);
    body.append(ov);
  }

  function open() {
    if (root) return;
    prefs = loadPrefs(storage);
    tab = firstPad() ? 'pad' : 'keys';
    listening = null;
    note = '';
    if (seatInput) seatInput.input.suspend(true);
    root = el('div', 'cm-ov');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Customize controls');
    const modal = el('div', 'cm-modal');
    const head = el('div', 'cm-head');
    const x = el('button', 'cm-x', '✕');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', close);
    head.append(el('h2', '', 'Customize controls'), x);
    modal.append(head, el('div', 'cm-body'));
    modal.addEventListener('click', (e) => e.stopPropagation());
    root.addEventListener('click', close);
    root.append(modal);
    doc.body.append(root);
    win.addEventListener('keydown', onKey, true);
    render();
    x.focus();
  }
  function close() {
    if (!root) return;
    if (raf) { win.cancelAnimationFrame(raf); raf = 0; }
    win.removeEventListener('keydown', onKey, true);
    root.remove();
    root = null;
    listening = null;
    if (seatInput) { seatInput.reload(); resumeWhenReleased(); }
  }
  function resumeWhenReleased() {
    const held = () => { const gp = firstPad(); return !!gp && gp.buttons.some((b) => b && b.pressed); };
    const step = () => { if (root) return; if (held()) { win.requestAnimationFrame(step); return; } seatInput.input.suspend(false); };
    step();
  }
  return { open, close, isOpen: () => !!root, get prefs() { return prefs; } };
}
