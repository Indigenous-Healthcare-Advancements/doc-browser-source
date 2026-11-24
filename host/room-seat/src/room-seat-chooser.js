// room-seat-chooser.js: "Which horse next?", the room seat's horse chooser (the owner's decision of 2026-11-23:
// a player holds the seat, horses come and go). Two parts: chooserView (pure: the lobby's `horses` answer turned into
// what the panel shows) and createHorseChooser (the panel in the page). The change itself is room-seat-swap.js.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The list is the lobby's (POST /api/room/lease { action: "horses", lease_id }; doc-arcade
// docs/rooms/seat-horse-switch.md section 3): names exactly as sent, the lease's own horse marked, a resting horse
// shown with the time the lobby gave, a horse waiting on a race check shown as that (it can still be chosen), "New
// horse (N of 3 left)" only when the lobby offers it (new_horse true and new_left above 0), and "Keep [name]".
// Every refusal is shown in the sender's own words (room-seat-swap.js refusalWords); nothing here invents a reason.
//
// The panel: a dialog over the page. While it is open every game input is held (the page's onOpen and onClose hold
// and release them), so a key or a touch at the question never reaches the game. Keyboard: Tab and Shift+Tab stay
// inside it, Up and Down move between the choices, Enter or Space takes one, Escape is "Keep". Touch: every choice is
// a button at least 48 px high with 16 px text in the touch layout (mp-seat.html); the list scrolls inside the panel,
// which is never taller than the screen, so it works at every viewport of docs/seat-phone-layout.md. Focus is always
// visible (the page's own :focus-visible rule). The colours are CHOOSER_COLORS below; the test computes each pair's
// contrast against what is really behind it (4.5 to 1 or more).
//
// LEAVE SEAT is always one press away (the seat test of 2026-11-24: the panel opens by itself after the game gives
// the card back, and it covers the page's own Leave button, so a press meant for Leave landed on the panel). The
// panel carries its own "Leave seat" under Keep (mp-seat.html #horse-leave): the page keeps the horse and then leaves
// as its own button does (onLeaveSeat). The other horse's panel has it already (its last button). Escape is still Keep.

import { refusalWords } from './room-seat-swap.js';

/** The pilot lets a member make this many horses (the lobby's own rule; the answer carries only how many are left). */
export const PILOT_NEW_MAX = 3;
export const CHOOSER_TITLE = 'Which horse next?';
/** The panel's own leave (createHorseChooser onLeaveSeat). */
export const CHOOSER_LEAVE = 'Leave seat';
/** Text and what is really behind it, as mp-seat.html draws the panel (the test checks both the ratio and the file). */
export const CHOOSER_COLORS = Object.freeze({
  panel: Object.freeze({ fg: '#eeeeee', bg: '#1d1d1d' }),
  row: Object.freeze({ fg: '#ffffff', bg: '#333333' }),
  rowNote: Object.freeze({ fg: '#c8c8c8', bg: '#333333' }),
  rowOff: Object.freeze({ fg: '#c8c8c8', bg: '#262626' }),
  status: Object.freeze({ fg: '#ffe7a8', bg: '#4a3a10' }),
  keep: Object.freeze({ fg: '#1a1408', bg: '#d8a630' }),
  leave: Object.freeze({ fg: '#ffffff', bg: '#7a2a1f' }),
  foot: Object.freeze({ fg: '#c8c8c8', bg: '#1d1d1d' }),
});

const clean = (s, n = 64) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n) : '');
/** A time of day for "resting until", in the player's own clock and words; '' when the lobby's time cannot be read. */
export function restText(iso, { now = Date.now(), fmt = null } = {}) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  if (t <= now) return 'Resting';
  let at = '';
  try { at = fmt ? fmt(new Date(t)) : new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { at = ''; }
  return at ? `Resting until ${at}` : 'Resting';
}

/**
 * chooserView(body, opts) -> what the panel shows. Pure.
 *   body   the lobby's 200 answer to `horses`
 *   opts   currentName: the name of the horse in the seat now (for "Keep [name]");
 *          mode: 'change' (the member asked) or 'other' (the card in the reader is a horse the member just made in
 *          the game: the choices are keeping that new horse, or leaving the seat);
 *          now, fmt: for the rest time
 * Returns { ok, title, lead, rows, keep, foot, canSwap, code }:
 *   rows   [{ key, kind: 'horse' | 'new', label, notes: [..], current, disabled, pick }]; pick is what a swap is
 *          asked with ({ horseId, name } or { newHorse: true, name, adopt })
 *   keep   { label, action: 'keep' | 'leave' }
 * ok false: the answer is not a horses list (an older lobby): the page shows no chooser.
 */
export function chooserView(body, { currentName = '', mode = 'change', now = Date.now(), fmt = null } = {}) {
  const b = body && typeof body === 'object' ? body : null;
  if (!b || b.ok !== true || !Array.isArray(b.horses) || (b.scope !== 'pilot' && b.scope !== 'stable')) return { ok: false, title: CHOOSER_TITLE, lead: null, rows: [], keep: null, foot: null, canSwap: false, code: null };
  const canSwap = b.can_swap === true;
  const code = typeof b.code === 'string' ? b.code : null;
  const rows = [];
  // (The other horse's panel lists no other horse: the game is in the middle of the new horse's game, and a card put
  // in the reader under it would be written over by the game. Keeping the new horse, or leaving, are the two choices.)
  for (const h of mode === 'other' ? [] : b.horses) {
    if (!h || typeof h.id !== 'string' || !h.id) continue;
    const name = clean(h.name) || 'Unnamed horse';
    const current = h.current === true;
    const notes = [];
    if (current) notes.push('In your seat now');
    if (h.clone === true) notes.push('Your clone');
    const rest = restText(h.resting_until, { now, fmt });
    if (rest) notes.push(rest);
    if (h.check_hold === true) notes.push('Waiting on a race check');
    rows.push({ key: `h:${h.id}`, kind: 'horse', label: name, notes, current, disabled: !canSwap || current, pick: { horseId: h.id, name } });
  }
  const left = Number.isSafeInteger(b.new_left) ? b.new_left : 0;
  if (b.new_horse === true && left > 0) {
    const n = `${left} of ${PILOT_NEW_MAX} left`;
    rows.push(mode === 'other'
      ? { key: 'new', kind: 'new', label: `New horse (${n})`, notes: ['Keep the horse you just made in the game'], current: false, disabled: !canSwap, pick: { newHorse: true, name: 'your new horse', adopt: true } }
      : { key: 'new', kind: 'new', label: `New horse (${n})`, notes: ['Make it in the game; it can race once it is saved'], current: false, disabled: !canSwap, pick: { newHorse: true, name: 'a new horse' } });
  }
  const mine = clean(currentName);
  const keep = mode === 'other'
    ? { label: 'Leave seat', action: 'leave' }
    : { label: b.current_new === true && !mine ? 'Keep your new horse' : `Keep ${mine || 'this horse'}`, action: 'keep' };
  // can_swap false comes with the lobby's own words; they lead the panel.
  const lead = canSwap ? null : refusalWords({ error: b.message, code: b.code }, 409);
  const foot = b.rests_known === false && canSwap && rows.some((r) => r.kind === 'horse' && !r.current) ? 'Resting horses are not marked right now. A resting horse cannot be chosen.' : null;
  return { ok: true, title: CHOOSER_TITLE, lead, rows, keep, foot, canSwap, code };
}

/**
 * createHorseChooser({ doc, root, onPick, onKeep, onLeave, onOpen, onClose })
 *   root     the dialog element (mp-seat.html #horse-ask); its parts are found by id inside the page
 *   onPick   (pick) a choice was taken; the page runs the change and calls busy(), fail() or close()
 *   onKeep   () "Keep [name]" (or Escape)
 *   onLeave  () "Leave seat" (the other horse's panel has no keep)
 *   onLeaveSeat  () the panel's own "Leave seat" (every other panel): keep the horse, then leave. Not given, or a
 *            page without #horse-leave: the panel has no such button
 *   onOpen, onClose  the page holds and releases every game input
 * Returns { open(view, lead), close(), busy(text), fail(words), isOpen(), isBusy() }.
 */
export function createHorseChooser({ doc = globalThis.document, root, onPick = () => {}, onKeep = () => {}, onLeave = () => {}, onLeaveSeat = null, onOpen = () => {}, onClose = () => {} } = {}) {
  const $ = (id) => (doc && typeof doc.getElementById === 'function' ? doc.getElementById(id) : null);
  const titleEl = $('horse-q');
  const leadEl = $('horse-lead');
  const listEl = $('horse-list');
  const statusEl = $('horse-status');
  const footEl = $('horse-foot');
  const keepEl = $('horse-keep');
  const leaveAny = $('horse-leave');
  const leaveEl = typeof onLeaveSeat === 'function' ? leaveAny : null;
  if (!leaveEl && leaveAny) leaveAny.hidden = true;
  if (!root || !listEl || !keepEl || typeof doc.createElement !== 'function') return null;
  let open = false;
  let busy = false;
  let view = null;
  let buttons = []; // the choices, in order, then keep, then leave seat
  let before = null; // what had the focus before the panel
  const show = (el, text) => { if (!el) return; el.textContent = text || ''; el.hidden = !text; };
  const enabled = () => buttons.filter((x) => !x.disabled);
  const focusOn = (el) => { try { if (el && typeof el.focus === 'function') el.focus(); } catch { /* not focusable */ } };
  const active = () => { try { return doc.activeElement || null; } catch { return null; } };

  function render() {
    if (titleEl) titleEl.textContent = view.title;
    show(leadEl, view.extraLead ? [view.extraLead, view.lead].filter(Boolean).join(' ') : view.lead);
    show(footEl, view.foot);
    if (typeof listEl.replaceChildren === 'function') listEl.replaceChildren(); else listEl.textContent = '';
    buttons = [];
    for (const r of view.rows) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = `hc-row${r.current ? ' cur' : ''}${r.kind === 'new' ? ' new' : ''}`;
      const name = doc.createElement('span');
      name.className = 'hc-name';
      name.textContent = r.label;
      b.append(name);
      if (r.notes.length) { const n = doc.createElement('span'); n.className = 'hc-note'; n.textContent = r.notes.join('. '); b.append(n); }
      b.disabled = r.disabled || busy;
      if (r.current && typeof b.setAttribute === 'function') b.setAttribute('aria-current', 'true');
      b.addEventListener('click', () => { if (!open || busy || r.disabled) return; onPick(r.pick); });
      listEl.append(b);
      buttons.push(b);
    }
    keepEl.textContent = view.keep.label;
    keepEl.disabled = busy;
    buttons.push(keepEl);
    if (leaveEl) {
      leaveEl.hidden = view.keep.action !== 'keep'; // the other horse's panel: its last button is Leave seat already
      leaveEl.textContent = CHOOSER_LEAVE;
      leaveEl.disabled = busy;
      if (!leaveEl.hidden) buttons.push(leaveEl);
    }
  }

  function onKey(e) {
    if (!open) return;
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); if (typeof e.stopPropagation === 'function') e.stopPropagation(); if (!busy) keep(); return; }
    if (k !== 'Tab' && k !== 'ArrowDown' && k !== 'ArrowUp' && k !== 'Home' && k !== 'End') return;
    const list = enabled();
    if (!list.length) { e.preventDefault(); return; }
    const i = list.indexOf(active());
    let to = null;
    if (k === 'Tab') {
      // Tab stays inside the panel: past the last choice it goes round to the first.
      if (e.shiftKey && i <= 0) to = list[list.length - 1];
      else if (!e.shiftKey && (i < 0 || i === list.length - 1)) to = list[0];
      else return; // the browser's own Tab moves between two choices
    } else if (k === 'ArrowDown') to = list[i < 0 ? 0 : (i + 1) % list.length];
    else if (k === 'ArrowUp') to = list[i < 0 ? list.length - 1 : (i + list.length - 1) % list.length];
    else if (k === 'Home') to = list[0];
    else to = list[list.length - 1];
    e.preventDefault();
    focusOn(to);
  }
  function keep() {
    if (!open || busy) return;
    if (view && view.keep.action === 'leave') onLeave(); else onKeep();
  }
  keepEl.addEventListener('click', keep);
  if (leaveEl) leaveEl.addEventListener('click', () => { if (!open || busy || !view || view.keep.action !== 'keep') return; onLeaveSeat(); });
  root.addEventListener('keydown', onKey);

  return {
    /**
     * Show the panel for a chooserView; lead: a line of the page's own before the lobby's (why the panel opened).
     * focusKeep: the focus starts on Keep (the panel the game's own eject opens after every race: keeping the horse
     * is then one key, Enter, or Escape); else on the first horse that can be taken.
     */
    open(v, lead = null, { focusKeep = false } = {}) {
      view = { ...v, extraLead: lead };
      busy = false;
      if (!open) { before = active(); open = true; root.hidden = false; try { onOpen(); } catch { /* the page's */ } }
      show(statusEl, '');
      render();
      const first = enabled();
      focusOn(first.length && !focusKeep ? first[0] : keepEl);
    },
    close() {
      if (!open) return;
      open = false; busy = false;
      root.hidden = true;
      try { onClose(); } catch { /* the page's */ }
      if (before && before !== (doc.body || null)) focusOn(before);
      before = null;
    },
    /** A change is running: every choice is off and the line says what is happening. */
    busy(text) { if (!open) return; busy = true; for (const b of buttons) b.disabled = true; show(statusEl, text); },
    /** A change was refused and nothing changed: the sender's words, and the choices are back. */
    fail(words) {
      if (!open) return;
      busy = false;
      render();
      show(statusEl, words);
      const first = enabled();
      focusOn(first.length ? first[0] : keepEl);
    },
    isOpen: () => open,
    isBusy: () => busy,
  };
}
