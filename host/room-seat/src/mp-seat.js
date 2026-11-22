// mp-seat.js: LAB ONLY (multiplayer room M1 and M2, doc-ops
// MULTIPLAYER_SERVER.md). The seat page (mp-seat.html): one seat board in
// this page, linked to a lab room over WebRTC DataChannels (mp-rtc.js),
// signalled through the room supervisor. The link worker
// (mp-seat-link-worker.js) owns the board's 60 Hz clock and the shadow log;
// this page boots the board with the settings and the card the room sends,
// passes the card writes back, and leaves on request (a last card look,
// then the close).
// The ticket comes in the URL fragment (#ticket=...), which is never sent
// to a server, and is removed from the address bar at once; it goes to the
// room only inside the signalling offer.
// Query: signal=<ws://ip:port/mp> (default: this page's own server),
// lan=<CIDR,...> (LAN allowlist, default 127.0.0.0/8), every=<n>,
// presses=<JSON [[from, to, mask], ...]> (lab input script for this board),
// autoleave=<s> and autorace=<n> (off by default: leave by itself with
// reason 'finish' s seconds after the card write that follows race n, as
// the "Leave seat" button does; mp-seat-auto.js), cachegame=1 (off by
// default: keep the two picked game files in this browser profile's own
// storage and use them next time; mp-game-cache.js).
// The seat reports its own status and errors to the room on the link
// (mp-wire.js seat report), so the room log covers a remote seat.
// M3 step 1b (docs/seat-contract.md): served by doc-arcade at /room-seat
// (<meta name="doc-build" content="room-seat">), the page is the ROOM SEAT:
// it reads no fragment ticket and no query param, only the hand-off /rooms
// left in sessionStorage (room-seat-handoff.js, taken and removed at once),
// beats the lease at once and every heartbeat_s (seat-lease.js), signals to
// the hand-off's signal_url under the public policy (mp-public.js) with its
// ice_servers, and goes back to return_path when the lease ends. Without
// that meta it is the LAB seat as before.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later

import { MB_TOTAL_BYTES, HUB_STATUS, MB } from './lb-lockstep.js';
import { pickLabGameSet, pageGameSet, editionForLinkTag } from './lab-game-set.js';
import { peekTicket } from './mp-wire.js';
import { pageAllowlist } from './mp-lan.js';
import { openSignal, createPeerLink } from './mp-rtc.js';
import { parseAutoLeave, createAutoLeave, seatReportOf, newWatchCounts, countWatch } from './mp-seat-auto.js';
import { createGameCache } from './mp-game-cache.js';
import { parseNetem, createNetem } from './mp-netem.js';
import { encodeSeatReport, reportText } from './mp-wire.js';
import { createSeatLeave, cardEjectRequest, CARD_EJECT_WAIT_MS } from './mp-seat-eject.js';
import { closingFromReply, ejectAfterRace, closingNoticeText, LEAVE_SETTLE_MS, POST_MS, EJECT_SAVE_MS } from './room-closing.js';
import { REVC_GAME } from './mp-entry-watch.js';
import { createPublicPolicy } from './mp-public.js';
import { roomSeatIntake, seatMetas, isReload, handoffIceServers, mainViewIceServers, isRoomSlot, seatWaitCard } from './room-seat-handoff.js';
import { createSeatLease } from './seat-lease.js';
import { seatEdition, releaseEdition } from './core-pin.js';
import { editionFiles, linkTags } from './edition-b.js';
import { editionDef } from './editions.js';
import { openStash } from './room-stash.js';
import { createSaveQueue, REQUEST_TIMEOUT_MS as SAVE_REQUEST_MS } from './room-save-queue.js';
import { createRoomSeatInput } from './room-seat-input.js';
import { createControlsPanel } from './room-seat-controls.js';
import { createMainView, mainWhepUrl, mainViewSupported } from './room-main-view.js';
import { createRoomSeatPad, padLangFor } from './room-seat-pad.js';

// THE GATE (step 1b). The room seat build runs from the hand-off only; the
// lab's #ticket=, ?signal= and every other lab param are never read there.
// A missing or refused hand-off goes back at once and starts nothing (on a
// reload, with the replace flag set first: room-seat-handoff.js). The gate
// fails closed: a page under /room-seat is the room seat even without its
// meta (then it has no expect either, so every entry is refused).
const metas = seatMetas(document);
const roomSeat = metas.roomSeat || /^\/room-seat(?:\/|$)/.test(location.pathname);
// 1d commit 5: the card stash, opened on EVERY visit of the room seat page,
// before the hand-off intake; its expiry sweep runs at once, whoever is
// signed in. A stash that cannot open does not stop the seat: its saves
// still go (noted as a page error).
let stash = null;
const stashOpen = roomSeat
  ? openStash(globalThis.indexedDB).then((st) => { stash = st; st.sweep().catch(() => {}); return st; }, (err) => { state.stashFault = true; notePageError(`stash not opened (${String(err && err.message ? err.message : err).slice(0, 60)})`); return null; })
  : Promise.resolve(null);
const intake = roomSeat ? roomSeatIntake({ now: Date.now(), expect: metas.expect, reload: isReload() }) : null;
const handoff = intake ? intake.handoff : null;
if (intake && intake.go) location.replace(intake.go);
// Batch 1 step 1: the room seat's live controls (room-seat-input.js). The player's keys and controller go straight
// into this page's own seat board, with the player's DOC Online mapping (doc_controls_v1, read by that module,
// which never writes; this page still writes nothing to storage). The lab
// seat keeps its scripted presses only.
let seatInput = null;
// Option A step 2: the room's main screen view (set where the page builds it; read by the seat's end paths).
let mainView = null;
// (notePageError is defined further down: a start fault is kept here and noted once the page is set up.)
let seatInputFault = null;
if (handoff) { try { seatInput = createRoomSeatInput({ win: window }); } catch (err) { seatInputFault = `controls not started (${String(err && err.message ? err.message : err).slice(0, 60)})`; } }
// How long a refusal's own words stay on the page before it goes back.
const RETURN_NOTICE_MS = 4000;
// A seat bug (400) before the link is open: how long its report waits for
// the link to open. Then the seat stops, with or without the report.
const BUG_REPORT_WAIT_MS = 10000;
// The eject save's drain floor from the card look's end (ejectDrain): one post, a refresh beat and one retry.
const EJECT_DRAIN_FLOOR_MS = POST_MS + SAVE_REQUEST_MS + POST_MS; // 21000
// stopBoard: the board worker ends this long after its stop; the way back
// starts only after that (and BACK_AFTER_BOARD_MS more), so no card write
// can still arrive once it has started.
const BOARD_END_MS = 500;
const BACK_AFTER_BOARD_MS = 50;
// A room seat's board must post 'ready' this long after it was started (the
// pinned core's download and digest, the core's own start, the game files'
// mount), or the seat ends with the plain notice instead of sitting in
// 'booting'. The game's own load (shim_load_game) runs after 'ready', so it
// is not covered here: a load that fails posts 'error', which ends the seat.
const BOOT_LIMIT_MS = 60000;
// What the page says when the seat ends (the lease's end, or the link's).
const END_TEXT = {
  gone: 'Your lease has ended. Going back to the rooms.',
  wrong_room: 'This seat is not for this room. Going back to the rooms.',
  token: 'This room was opened again elsewhere. Going back to the rooms.',
  lost: 'The connection to the rooms was lost for too long. Going back to the rooms.',
  bug: 'This seat hit a problem and has stopped.',
  dropped: 'The room ended this seat. Going back to the rooms.',
  linkLost: 'The connection to the room was lost. Going back to the rooms.',
  left: 'You left the seat. Going back to the rooms.',
  core: 'This seat could not load the right game for this room. Please tell the staff.',
  boot: 'This seat could not start the game. Please tell the staff.',
  // A checkout 429 (cooldown, too_many_checkouts): /rooms' resting text.
  resting: 'This horse is resting. Going back to the rooms.',
};
// A card change that could not be saved (the save queue held or still has
// it once the seat dropped): said plainly, with no codes, so the member
// knows to tell staff. HELD_TEXT when it is not kept in the stash either (a
// closed page loses it); HELD_KEPT_TEXT when the stash keeps it.
const HELD_TEXT = 'The connection to the room ended, and your latest card change could not be saved. Please tell the staff. Leaving or closing this page loses that change.';
const HELD_KEPT_TEXT = 'Your latest card change could not be saved yet. It is kept in this browser for the staff to check. Please tell the staff.';
// The held change saved after all: the way back is offered.
const SAVED_LATE_TEXT = 'Your latest card change was saved.';
// The queue has stopped (an ended lease takes no save) with every write
// kept in the stash: said for KEPT_NOTICE_MS, then the normal way back
// (ruled 2026-11-09: /rooms' late poster posts it at once, the lease ended).
const KEPT_GO_TEXT = 'Your card is kept in this browser and will be saved when you go back to Rooms.';
const KEPT_NOTICE_MS = 5000;
// The queue stopped while the lease is healthy (review P2-8, ruled wording):
// the member plays on, the writes stay in the stash.
const SAVES_PAUSED_TEXT = 'Your card saves are paused; changes are kept in this browser.';
// A DOC '99 eject that failed or timed out (the link up or not): nothing is
// held in the page, but the card was not saved either.
const MISSED_TEXT = 'Your card did not come out of the reader, so it could not be saved. Please tell the staff.';
// A later write landed after a missed eject: the card IS saved (ruled
// 2026-11-09, the conductor). One line; the miss stays in the log for staff.
const MISSED_SAVED_TEXT = 'Your card was saved to your stable. It did not eject cleanly, but nothing was lost.';
// The eject save's drain with writes pending (conductor's condition for its
// worst case, about 54 s): shown for the whole drain, with the seconds left.
const SAVING_TEXT = 'Saving your card, please wait';

const q = new URLSearchParams(roomSeat ? '' : location.search);
const num = (k, d) => (q.has(k) ? Number(q.get(k)) : d);
const input = document.getElementById('rom-input');
const msg = document.getElementById('msg');
const statusEl = document.getElementById('status');
const leaveBtn = document.getElementById('leave');
const forgetBtn = document.getElementById('forget');
// Page errors, counted for the seat report (text clipped, printable only).
const pageErrors = { count: 0, last: null };
const notePageError = (t) => { pageErrors.count++; pageErrors.last = reportText(String(t)); };
if (seatInputFault) notePageError(seatInputFault);
if (typeof window.addEventListener === 'function') {
  window.addEventListener('error', (e) => notePageError(e && e.message ? e.message : 'error'));
  window.addEventListener('unhandledrejection', (e) => notePageError(e && e.reason && e.reason.message ? e.reason.message : 'unhandled rejection'));
}
const autoLeave = (() => { const a = parseAutoLeave(q); return a ? createAutoLeave(a) : null; })();
// The room seat keeps the player's game files in this browser (batch 1): picked once, used again next time. The lab: cachegame=1.
const cache = roomSeat || q.get('cachegame') === '1' ? createGameCache() : null;
// LAB ONLY: artificial delay, jitter and loss on this seat's link (latency
// tolerance test). Off unless labnetem=1 comes with the netem params.
const netemParsed = parseNetem(q);
const netem = netemParsed.netem ? createNetem(netemParsed.netem) : null;
let picking = false;
let fileSource = null; // 'picked' | 'cached'
const frag = new URLSearchParams(location.hash.slice(1));
const ticket = roomSeat ? (handoff ? handoff.room_ticket : '') : frag.get('ticket') || '';
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
// The room seat: the public policy, its one signal host (the page's meta,
// which the hand-off's signal_url was checked against) and the hand-off's
// ICE servers while their relay lives (the servers' clock), built afresh for
// each join so a retry never reuses expired relay credentials. The lab: the
// LAN allowlist, no ICE servers.
const labAllow = handoff ? null : pageAllowlist(q, location.hostname);
const allowFor = () => (handoff ? createPublicPolicy({ role: 'seat', signalHosts: [metas.expect.signalHost], iceServers: handoffIceServers(handoff, Date.now()) }) : labAllow);
const signalBase = q.get('signal') || `ws://${location.host}/mp`;
// The room seat's tag, slot and expiry are the hand-off's (room_ticket_exp
// is this browser's clock already: CLOCKS); the lab reads them from its
// ticket.
const peek = handoff ? { tag: handoff.room_tag, slot: handoff.slot, exp: handoff.room_ticket_exp, edition: (peekTicket(handoff.room_ticket) || {}).edition } : peekTicket(ticket);
// The seat ticket's edition (the room's link tag, mp-room.js signTicket), or null.
const ticketEdition = editionForLinkTag(peek && peek.edition);
const signalUrlFor = (p) => (handoff ? handoff.signal_url : `${signalBase}?role=seat&room=${p.tag}&slot=${p.slot}`);
let presses = [];
try { presses = JSON.parse(q.get('presses') || '[]'); } catch { presses = []; }

const state = { phase: 'connecting', refused: null, settings: null, hasCard: false, board: { ready: false, loaded: false, samples: [], watch: [], errors: [], logs: [], counts: newWatchCounts() },
  cardWrites: 0, cardAcks: [], link: null, rtc: null, gone: false, goneReason: null, left: null, mode: roomSeat ? 'room' : 'lab', leaseEnd: null, roomEnd: null };
window.seat = { state };
if (netem) { state.netem = { ...netemParsed.netem, stats: netem.stats }; }

let files = null;
let settings = null;
let card = null;
let board = null;
let started = false;
// Read by stopBoard() and sendReport(), which the end paths reach: declared
// before any of them can run.
let ctl = null;
let writeSeq = 0;
let finalWait = null;
let ejectWait = null;
let reportSent = '';
let reportAt = 0;
// The link worker said 'open' (a report sent before it is dropped).
let linkOpen = false;
// A bug report waiting for the link to open (endRoomSeat).
let bugWait = null;
// The board worker failed (its card look cannot run).
let boardDead = false;
// 1d commit 5: the room seat's save queue (room-save-queue.js), made once the
// card is checked out. Every board write goes to it (never to the link).
let saveQueue = null;
// The DOC '99 eject's card came out (the room seat: its write is then in the
// save queue, counted by unstashed() until the stash keeps it).
let ejectOut = false;
// Why it did not come out (the board's word, or 'no answer'): for the log.
let ejectMissWhy = null;
// The seq of the last board write queued (the room seat), and the card
// look's outcome when it answered (leave()): null when it did not answer (a
// timeout) or did not run; else { wrote: the seq of the write it queued, or
// null for none }. A missed eject says the card IS saved only when the
// card's state after the miss is known to have landed (missedSaved).
let lastQueuedSeq = null;
let cardLook = null;
// The seat dropped with a write not landed: the way back waits (savesChanged).
let savesHold = false;
// The saves stopped in play, said once (savesChanged).
let savesPaused = false;
// The end's own notice and cause (dropRoomSeat), kept so a save notice adds
// to it and a held write that lands resumes the way back.
let endText = '';
let endWhy = null;
// The kept write's way back (showHeld): armed once, and again in full when
// a write still in its put at the last notice is kept (heldLoose: the
// unstashed count then).
let keptTimer = null;
let heldLoose = 0;
let checkoutStarted = false;
// The way back link (showWayBack): one, moved if shown again.
let wayBack = null;
// A DOC '99 eject that did not come out (cardFirst): the way back waits, as
// for a held card.
let ejectMissed = false;
// The link worker's last message (any), and a pending check after its
// onerror: a worker that still talks is alive (linkDead).
let linkHeardAt = 0;
let linkDeadCheck = null;
// When the board worker is terminated (stopBoard): no card write after it.
let boardEndsAt = 0;
// After the seat's close is posted: waits for the link's own end (linkClosed).
let goneWait = null;
// The pending way back (finishRoomSeat), cancelled by a late held card.
let backTimer = null;
// #169: every leave goes through seatLeave (mp-seat-eject.js createSeatLeave):
// on DOC '99 with a card in, the CARD sequence runs before leave()'s card
// look and its close. Rev C: leave() as before. Every room seat end runs it
// too, before the board stops (endRoomSeat).
const seatLeave = createSeatLeave({
  isJp: () => jpCardIn(),
  ejectCard: () => ejectCard().then((r) => {
    if (r && r.out === true) { ejectOut = true; return r; }
    // For staff (the page log, so the seat's last report carries it): the reason only, never card bytes.
    ejectMissWhy = r && typeof r.why === 'string' && /^[a-z_ ]{1,32}$/.test(r.why) ? r.why : 'no answer';
    notePageError(`eject missed (${ejectMissWhy})`);
    return r;
  }),
  rawLeave: leave,
  show: (t) => { msg.textContent = t; },
  setPhase: (ph) => { state.phase = ph; },
  setBusy: (on) => { leaveBtn.disabled = on; },
});
// The board needs SharedArrayBuffer: a secure, cross-origin isolated page.
// Over a plain http LAN address that takes the browser flag
// --unsafely-treat-insecure-origin-as-secure=http://<room ip>:8790 (lab only).
const isolated = typeof SharedArrayBuffer === 'function' && globalThis.isSecureContext && globalThis.crossOriginIsolated;
const mailbox = isolated ? new SharedArrayBuffer(MB_TOTAL_BYTES) : null;
const link = isolated ? new Worker(new URL('./mp-seat-link-worker.js', import.meta.url), { type: 'module' }) : { postMessage() {}, terminate() {} };

link.onmessage = (e) => {
  const m = e.data;
  linkHeardAt = Date.now();
  // A handler in the link worker threw: noted, the link lives on. Its clock
  // (where 'clock') stopped for good: release the board's barrier, as for a
  // dead worker (freeBoard), and end the seat as 'lost' at once, so the card
  // look runs promptly (the card first, its write up the link still open).
  if (m.type === 'fault') {
    state.linkFaults = (state.linkFaults || 0) + 1;
    notePageError(`link worker fault (${m.where})`);
    if (m.where === 'clock') linkClockFault();
    return;
  }
  if (m.type === 'stats') { state.link = m.stats; if (peer) state.rtc = { ...peer.stats }; return; }
  // Linked: the room hands the station over at the start of the next results screen (the hand window), so say so.
  if (m.type === 'open') { linkOpen = true; if (bugWait) bugWait(true); if (!settings) msg.textContent = 'Connected. You take your seat between races and can enter the race after that. This can take a couple of minutes.'; return; } // the room ends signalling (bye) once it has taken the seat
  if (m.type === 'welcome') {
    // A welcome on a reconnect: the board ran on, nothing restarts; the seat is back on its station.
    if (m.settings && m.settings.resumed && reconnect) { reconnectDone(m.settings); return; }
    settings = m.settings; state.settings = settings; state.phase = 'welcomed';
    // The warm join (the room's warm=1): the game starts now, but the station is the room's until it says 'taken'.
    // Until then this seat's buttons do nothing in the room, so they are held and the waiting card stays up.
    if (settings && settings.warm === true) { state.warm = true; if (seatInput) seatInput.hold('warm', true); }
    if (settings && typeof settings.resume === 'string') resumeInfo = { key: settings.resume, ms: Number(settings.resumeMs) || 0 };
    maybeStart(); return;
  }
  // The room seat's card comes from its own checkout (checkOut), never the
  // room's link (1c); the lab keeps the room's card.
  if (m.type === 'card') { if (handoff) return; card = m.bytes; state.hasCard = true; maybeStart(); return; }
  if (m.type === 'refused') { state.refused = m.reason; state.phase = 'refused'; msg.textContent = `The room refused this seat (${m.reason}).`; offerEnded(); return; }
  if (m.type === 'taken') { if (m.info && typeof m.info.resume === 'string') resumeInfo = { key: m.info.resume, ms: Number(m.info.resumeMs) || 0 }; if (state.warm) { state.warm = false; if (seatInput) seatInput.unholdWhenIdle('warm'); msg.textContent = settings ? `Seat ${settings.slot}. You can enter the next race.` : msg.textContent; } return; }
  if (m.type === 'card-ack') { state.cardAcks.push(m.verdict); return; }
  // L2 (DOC '99 closing): the room asks for the eject save now. The seat's
  // own leave takes the card out (its last card look, whose write goes up
  // first) and closes as a finish; the room ends the seat itself if this does
  // not come in time.
  if (m.type === 'eject') {
    state.ejectAsked = (state.ejectAsked || 0) + 1;
    if (state.phase === 'leaving' || state.phase === 'left') return;
    seatLeave.leave('finish', { asked: true }).then((r) => { state.eject = { jp: r.jp, out: r.out, pressed: r.pressed }; });
    return;
  }
  if (m.type === 'gone') {
    state.gone = true; state.goneReason = m.reason; state.link = m.stats; if (peer) state.rtc = { ...peer.stats };
    linkOpen = false;
    // A link lost while seated: the room holds the station; keep the board and link again (reconnect).
    if (reconnectStart(m.reason)) return;
    // The room seat: the link's end is the seat's end (endRoomSeat: the beat
    // stops at once, the card is made safe, then the board stops).
    if (handoff) { if (bugWait) bugWait(false); roomLinkEnded(m.reason); return; }
    state.phase = state.phase === 'leaving' || state.phase === 'ejecting' ? 'left' : 'dropped';
    stopBoard();
  }
};
// The room seat: a link worker that fails is a lost link.
// An error event alone is not a death (the worker reports its own handler
// faults; a stray one may still come): only a worker that then says nothing
// for LINK_DEAD_MS (it posts stats every second) is gone. Its 60 Hz clock
// went with it, so the board would wait out its vblank barrier (10 s a
// frame): the page releases the barrier itself (freeBoard), so the eject and
// the card look still run.
const LINK_DEAD_MS = 2500;
link.onerror = () => {
  if (!handoff || linkDeadCheck) return;
  const at = Date.now();
  linkDeadCheck = setTimeout(() => { linkDeadCheck = null; if (linkHeardAt > at) { state.linkFaults = (state.linkFaults || 0) + 1; return; } linkDead(); }, LINK_DEAD_MS);
};
let sig = null;
let peer = null;
// Reconnect (mp-room.js resumeMs): the room's welcome names a resume key and how long it holds the station after
// the link drops. The board runs on meanwhile (its link worker keeps the clock); the seat links again with
// <ticket route>.r.<key> in place of the ticket until the hold ends. Not for a seat leaving or already ended.
let resumeInfo = null;
let reconnect = null;
const RECONNECT_ENDS = new Set(['no resume']);
// A leave asked while reconnecting waits for the reconnect to end (back on the station, or given up): its close and
// last card write need the link, and a reconnect finishing under it would put the seat back as seated.
let reconnectWaiters = [];
const reconnectSettled = () => { const w = reconnectWaiters; reconnectWaiters = []; w.forEach((f) => f()); };
function reconnectStart(reason) {
  if (reconnect) { reconnectRetry(reason); return true; }
  if (!resumeInfo || !resumeInfo.ms || !started || !(state.phase === 'linking' || state.phase === 'seated' || state.phase === 'welcomed')) return false;
  if (state.roomEnd) return false;
  reconnect = { since: Date.now(), until: Date.now() + resumeInfo.ms - 1500, tries: 0, prevPhase: state.phase, why: reason, timer: null, sig: null, peer: null };
  state.phase = 'reconnecting';
  state.reconnects = (state.reconnects || 0) + 1;
  msg.textContent = 'Connection lost. Reconnecting to your seat...';
  reconnectTry();
  return true;
}
function reconnectTry() {
  const r = reconnect;
  if (!r) return;
  if (Date.now() >= r.until) { reconnectGiveUp('not back in time'); return; }
  r.tries++;
  const ch = new MessageChannel();
  link.postMessage({ type: 'relink', port: ch.port2, resume: resumeInfo.key }, [ch.port2]);
  const allow = allowFor();
  const mySig = openSignal(signalUrlFor(peek), allow);
  const myPeer = createPeerLink({ role: 'seat', allow, signal: (o) => mySig.send(o), port: ch.port1, slot: peek.slot, netem });
  r.sig = mySig; r.peer = myPeer; sig = mySig; peer = myPeer;
  mySig.onmessage = (sm) => {
    if (reconnect !== r || r.sig !== mySig) return;
    if (sm.t === 'refuse') { if (RECONNECT_ENDS.has(sm.reason)) reconnectGiveUp(`refused (${sm.reason})`); else reconnectRetry(sm.reason); return; }
    myPeer.onSignal(sm).catch(() => {});
  };
  mySig.onclose = () => { if (reconnect === r && r.sig === mySig && !myPeer.stats.verified) reconnectRetry('signalling closed'); };
  const cred = `${String(ticket).split('.')[0]}.r.${resumeInfo.key}`;
  myPeer.offer(cred).catch(() => { if (reconnect === r && r.sig === mySig) reconnectRetry('offer'); });
}
function reconnectRetry(why) {
  const r = reconnect;
  if (!r || r.timer) return;
  r.lastWhy = why;
  try { if (r.peer) r.peer.discard(); } catch { /* gone */ }
  try { if (r.sig) r.sig.close(); } catch { /* gone */ }
  r.sig = null; r.peer = null;
  r.timer = setTimeout(() => { r.timer = null; reconnectTry(); }, Math.min(2000, 300 * 2 ** Math.min(r.tries, 3)));
}
function reconnectDone(set) {
  const r = reconnect;
  reconnect = null;
  if (set && typeof set.resume === 'string') resumeInfo = { key: set.resume, ms: Number(set.resumeMs) || resumeInfo.ms };
  state.phase = r ? r.prevPhase : 'seated';
  state.gone = false;
  state.lastReconnect = { ms: r ? Date.now() - r.since : null, tries: r ? r.tries : null, why: r ? r.why : null };
  linkOpen = true;
  msg.textContent = 'Reconnected.';
  reconnectSettled();
}
function reconnectGiveUp(why) {
  const r = reconnect;
  reconnect = null;
  if (r && r.timer) clearTimeout(r.timer);
  try { if (r && r.peer) r.peer.discard(); } catch { /* gone */ }
  try { if (r && r.sig) r.sig.close(); } catch { /* gone */ }
  state.reconnectFailed = why;
  // The end the lost link would have had: the link's own gone path, with no resume left to try.
  resumeInfo = null;
  if (r) state.phase = r.prevPhase;
  link.onmessage({ data: { type: 'gone', reason: r ? r.why : why, stats: state.link } });
  reconnectSettled();
}
// THE LEASE (step 1b): beat AT ONCE, then every heartbeat_s. A room seat only.
const lease = handoff ? createSeatLease({ handoff, onReply: leaseReply, onEnd: leaseEnded, onTrouble: (on) => { state.leaseTrouble = on; } }) : null;
if (lease) window.seat.lease = { state: lease.state, stats: lease.stats }; // no nonce on window
if (intake && intake.go) {
  state.phase = 'refused';
  state.refused = `no hand-off (${intake.status})`;
  msg.textContent = 'Going back to the rooms.';
} else if (netemParsed.error) {
  state.phase = 'refused';
  state.refused = netemParsed.error;
  msg.textContent = netemParsed.error;
} else if (!isolated) {
  state.phase = 'refused';
  state.refused = 'not a secure, isolated page';
  msg.textContent = handoff ? 'This page is not cross-origin isolated, so the seat cannot run.' : `This page is not a secure context, so the seat cannot run. Lab only: start Chrome with --unsafely-treat-insecure-origin-as-secure=${location.origin} and a separate --user-data-dir, then open this link again.`;
  offerEnded();
} else if (!peek || !peek.tag || !isRoomSlot(peek.slot)) {
  msg.textContent = 'No seat ticket.';
  offerEnded();
} else {
  // Only a page that can run beats the lease (isolated, a room slot).
  if (lease) { lease.start(); msg.textContent = 'Joining your room.'; }
  const ch = new MessageChannel();
  link.postMessage({ type: 'init', port: ch.port2, slot: peek.slot, roomTag: parseInt(peek.tag, 16) >>> 0, mailbox }, [ch.port2]);
  // A refusal that may clear by itself is not final: 'busy' and 'slot busy'
  // (another seat is being checked, or the slot has its pending sockets),
  // 'no such room' and 'slot not open' (the room's signalling is
  // reconnecting and has not announced its slots yet), and a signalling
  // socket that closes before the link is up. The seat tries again with
  // backoff (at most RETRY_CAP_MS apart) until its ticket expires. The ticket
  // is only spent when the room answers it, so a retry may present it again.
  const RETRY_REASONS = new Set(['busy', 'slot busy', 'no such room', 'slot not open']);
  const RETRY_CAP_MS = 4000;
  const expiresAt = Number(peek.exp) || 0;
  state.tries = 0;
  // A seat whose link has dropped or left stays so: nothing here
  // overwrites that phase.
  const ended = () => state.phase === 'dropped' || state.phase === 'left' || state.phase === 'leaving';
  const setPhase = (ph) => { if (!ended()) state.phase = ph; };
  const fail = (err) => { if (ended()) return; state.refused = String(err && err.message ? err.message : err); state.phase = 'refused'; msg.textContent = state.refused; offerEnded(); };
  const join = () => {
    if (ended()) return;
    state.tries++;
    setPhase('connecting');
    state.refused = null;
    let final = false;
    const allow = allowFor();
    const mySig = openSignal(signalUrlFor(peek), allow);
    const myPeer = createPeerLink({ role: 'seat', allow, signal: (o) => mySig.send(o), port: ch.port1, slot: peek.slot, netem });
    sig = mySig;
    peer = myPeer;
    // Retry once for this socket, if the link never came up and the ticket
    // has time left; returns false when it will not.
    const retry = (why) => {
      if (sig !== mySig || myPeer.stats.verified || ended()) return false;
      // This seat's own link has ended (it failed, not discarded for a
      // retry): the attempt is over, do not start another.
      if (myPeer.closedLink && !myPeer.discarded) return false;
      const wait = Math.min(RETRY_CAP_MS, 500 * 2 ** state.tries) + Math.floor(Math.random() * 250);
      if (!(Date.now() + wait < expiresAt)) return false;
      setPhase('retrying');
      state.retryWhy = why;
      msg.textContent = `Waiting for the room (${why}); trying again in ${Math.round(wait / 1000)} s.`;
      sig = null;
      myPeer.discard();
      mySig.close();
      setTimeout(() => { try { join(); } catch (err) { fail(err); } }, wait);
      return true;
    };
    mySig.onmessage = (m) => {
      if (sig !== mySig) return;
      if (m.t === 'refuse') {
        if (RETRY_REASONS.has(m.reason) && retry(m.reason)) return;
        final = true;
        if (ended()) return;
        state.refused = m.reason; state.phase = 'refused'; msg.textContent = `The room refused this seat (${m.reason}).`;
        offerEnded();
        return;
      }
      if (peer === myPeer) myPeer.onSignal(m).catch(() => {});
    };
    // A bare close before the link is up (the room's signalling went down,
    // or the supervisor restarted): retry. After the link is up, the room's
    // bye closes this socket on purpose and nothing happens.
    mySig.onclose = () => {
      if (sig !== mySig || final || myPeer.stats.verified || ended()) return;
      if (myPeer.closedLink && !myPeer.discarded) return; // the link's own end decides
      if (!retry('signalling closed')) { final = true; state.refused = 'signalling closed'; state.phase = 'refused'; msg.textContent = 'The room could not be reached before the ticket expired.'; offerEnded(); }
    };
    // An offer still in flight when its link was discarded (a retry) fails
    // harmlessly: only the current link's errors count.
    myPeer.offer(ticket).catch((err) => { if (sig !== mySig || peer !== myPeer || ended()) return; state.refused = `offer: ${err && err.message}`; state.phase = 'refused'; offerEnded(); });
  };
  try {
    join();
  } catch (err) {
    state.refused = String(err && err.message ? err.message : err);
    state.phase = 'refused';
    msg.textContent = state.refused;
    offerEnded();
  }
}

let filesEdition = null;
// Rev C Rebalanced: the game file rebuilt in page memory once (maybeStart).
let rebuilding = false;
let rebuilt = false;
async function onFilesPicked() {
  if (netemParsed.error) return; // the seat refused; keep its message
  if (state.roomEnd) return; // the room seat has ended: no board after that
  const picked = Array.from(input.files || []);
  // The room seat picks the files of its hand-off's release (Rev C: A's
  // drbyocwc.zip; DOC '99: J99's derbyoc.zip); its ticket's edition must
  // agree (maybeStart). The lab seat: the seat ticket's edition (the room's
  // link tag), or the picked game file's own; a mismatch is refused, never
  // run as 'A'.
  const set = handoff ? pickLabGameSet(picked.map((f) => f.name), releaseEdition(handoff.release)) : pageGameSet(picked.map((f) => f.name), ticketEdition);
  const game = set.game && picked.find((f) => f.name.toLowerCase() === set.game);
  const bios = picked.find((f) => f.name.toLowerCase() === 'naomi.zip');
  if (set.error || !game || !bios) { msg.textContent = set.error || 'Need naomi.zip.'; return; }
  if (files || picking) {
    if (fileSource === 'cached') msg.textContent = 'Using the cached game files. To pick others, forget them and reload this page.';
    return;
  }
  // From here the pick owns the files: a cache load that finishes meanwhile
  // is not used (it checks `picking`).
  picking = true;
  try {
    const b = await bios.arrayBuffer();
    const g = await game.arrayBuffer();
    files = [['naomi.zip', b], [set.game, g]];
    fileSource = 'picked';
    filesEdition = set.edition;
  } catch {
    msg.textContent = 'The game files could not be read; pick them again.';
    return;
  } finally {
    picking = false;
  }
  if (cache) {
    // Kept in this browser profile only; a failure does not stop the seat.
    cache.store(files.map(([n, b]) => [n, b.slice(0)]), filesEdition).then(() => { forgetBtn.hidden = false; }, (err) => { msg.textContent = `Game files not cached (${reportText(String(err && err.message ? err.message : err), 80)}).`; });
  }
  maybeStart();
}
input.addEventListener('change', onFilesPicked);
// Files picked before this script ran (the page is up before its module loads) fired their change unheard: take them
// now, or the seat waits for files it already has (the no-boot after "welcomed", runs 8 and 12).
if (input.files && input.files.length > 0) onFilesPicked();

// The cache is read only on a page that can run a seat (isolated, with a
// ticket), and its files are used only if nothing was picked first.
if (cache && isolated && peek && peek.tag && !netemParsed.error) {
  forgetBtn.hidden = true;
  forgetBtn.addEventListener('click', async () => {
    await cache.forget();
    forgetBtn.hidden = true;
    msg.textContent = fileSource === 'cached' ? 'Cached game files forgotten (this page keeps using them until it is reloaded).' : 'Cached game files forgotten.';
  });
  // The ticket's edition; a ticket without one loads the A set, and the
  // room's welcome then refuses a game that is not the room's (maybeStart).
  // A room seat: its hand-off's release (as the pick, pickLabGameSet), so a DOC '99 room never loads the A set.
  const cacheEdition = handoff ? releaseEdition(handoff.release) : ticketEdition ?? 'A';
  cache.load(cacheEdition).then((r) => {
    if (state.roomEnd) return; // after an end: keep its notice
    if (r.ok) {
      forgetBtn.hidden = false;
      if (!files && !picking) { files = r.files; fileSource = 'cached'; filesEdition = cacheEdition; msg.textContent = 'Using the game files cached in this browser.'; maybeStart(); }
    } else if (r.reason !== 'none') {
      forgetBtn.hidden = false;
      if (files || picking) return; // a pick already won; nothing to ask for
      msg.textContent = `Cached game files not used (${r.reason}); pick them again.`;
    }
  }, () => {});
}

// L2: the board presses CARD and polls for the card's write-back (mp-seat-eject.js).
// Lab run 4: once the seat is seated (the card long since inserted), the
// board's card-base sets its eject baseline (insertBase) to the writes so
// far, so a card the game wrote at registration is not taken for 'out'.
function ejectCard() {
  if (!board) return Promise.resolve({ out: false, pressed: 0 });
  return new Promise((resolve) => {
    ejectWait = resolve;
    board.postMessage(cardEjectRequest());
    setTimeout(() => { if (ejectWait === resolve) { ejectWait = null; resolve({ out: false, pressed: 1 }); } }, CARD_EJECT_WAIT_MS);
  });
}

function maybeStart() {
  // The room seat (review P1-a): only once the card is checked out and its
  // save queue exists, whatever the welcome's card flag (production sends
  // card: false). The lab: the room's card when its welcome says so.
  if (started || state.roomEnd || !files || !settings || (handoff ? (!saveQueue || !card) : (settings.card && !card))) return;
  // The lab seat: the room's game must be the one this seat loaded (never
  // another edition's). The room seat ends instead (below), so its lease and
  // way back follow the end path.
  if (!handoff && files[1][0] !== settings.game) {
    state.phase = 'refused';
    state.refused = 'wrong game';
    msg.textContent = `This room runs ${String(settings.game).slice(0, 40)}, but this seat loaded ${files[1][0]}. Pick that game's files and open the link again.`;
    return;
  }
  if (!crossOriginIsolated) { msg.textContent = 'Not cross-origin isolated.'; return; }
  // The room seat: the welcome's edition and game must be the hand-off's
  // release (core-pin.js seatEdition); the board then loads the core only
  // through the pin, for that edition (a refusal ends the seat, 'core-refused').
  const ed = handoff ? seatEdition(handoff.release, settings) : null;
  if (ed && ed.refused) { endRoomSeat('bug', END_TEXT.core, 0, `edition refused (${ed.refused})`); return; }
  // ...and the files the board will run must hold the welcome's game.
  if (ed && !files.some(([name]) => name === settings.game)) { endRoomSeat('bug', END_TEXT.core, 0, 'edition refused (files)'); return; }
  // ...and the room ticket's edition (its link tag), when it names one, must
  // be the release's: both agree, or the seat refuses with the plain notice.
  if (ed && ticketEdition !== null && ticketEdition !== ed.edition) { endRoomSeat('bug', END_TEXT.core, 0, 'edition refused (ticket)'); return; }
  // ...and the room's game is the one this seat loaded.
  if (ed && files[1][0] !== settings.game) { endRoomSeat('bug', END_TEXT.core, 0, 'edition refused (wrong game)'); return; }
  // Rev C Rebalanced (B): the game is rebuilt in page memory from the stock Rev C file, as the room did; the seat
  // joins only if its rebuilt image gives the room's session tag (editions and images never mix).
  const runEdition = ed ? ed.edition : (ticketEdition ?? filesEdition);
  const runDef = editionDef(runEdition);
  if (runDef && runDef.build === 'edition-b' && !rebuilt) {
    if (rebuilding) return;
    rebuilding = true;
    msg.textContent = 'Building Rev C Rebalanced from your game files on this device.';
    const byName = new Map(files);
    editionFiles({ edition: runEdition, setup: { files: [{ role: 'game', name: settings.game }] }, read: async (n) => new Uint8Array(byName.get(n)) }).then((built) => {
      rebuilding = false;
      const tags = linkTags(runEdition, built.joinHash);
      if (tags.sessionTag !== settings.sessionTag || tags.edition !== settings.edition) {
        if (handoff) { endRoomSeat('bug', END_TEXT.core, 0, 'edition refused (image)'); return; }
        state.phase = 'refused'; state.refused = 'image';
        msg.textContent = 'This seat built a different Rev C Rebalanced image than the room. Check your Rev C files.';
        return;
      }
      files = files.map(([n, b]) => (n === settings.game ? [n, built.files[0][1].slice().buffer] : [n, b]));
      rebuilt = true;
      maybeStart();
    }, (err) => {
      rebuilding = false;
      if (handoff) { endRoomSeat('bug', END_TEXT.core, 0, 'edition refused (build)'); return; }
      state.phase = 'refused'; state.refused = 'build';
      msg.textContent = `Cannot build Rev C Rebalanced: ${reportText(String(err && err.message ? err.message : err), 80)}.`;
    });
    return;
  }
  started = true;
  state.phase = 'booting';
  const s = settings;
  ctl = new SharedArrayBuffer(16);
  const frameCounts = new SharedArrayBuffer(4);
  const hubStatus = new SharedArrayBuffer(HUB_STATUS.words * 4);
  const canvas = document.getElementById('screen').transferControlToOffscreen();
  board = new Worker(new URL('./lb-board-worker.js', import.meta.url), { type: 'module' });
  const st = state.board;
  let bootTimer = null;
  // The room seat: a board worker that fails ends the seat as a seat bug.
  board.onerror = () => { st.errors.push('board worker error'); if (handoff) { boardDead = true; endRoomSeat('bug', END_TEXT.bug, 0, 'board worker error'); } };
  board.onmessage = (e) => {
    const m = e.data;
    switch (m.type) {
      case 'ready': st.ready = true; if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; } link.postMessage({ type: 'start' }); state.phase = 'linking'; break;
      case 'loaded': st.loaded = true; break;
      case 'sample': st.samples.push({ f: m.f, status: m.status }); if (st.samples.length > 2000) st.samples.shift(); if (state.phase === 'linking' && parseInt(m.status.comm2 || '0', 16) >> 8 === settings.seats) { state.phase = 'seated'; board.postMessage({ type: 'card-base' }); } break;
      case 'watch':
        st.watch.push(...m.changes);
        for (const w of m.changes) countWatch(st.counts, w);
        break;
      case 'card-write': {
        writeSeq++;
        state.cardWrites++;
        // The room seat (1d commit 5): every write goes to the save queue
        // (stashed, then host-stable), whatever the link's state; no card
        // bytes on the link. The lab: up the link, as before.
        if (handoff) {
          if (!saveQueue) { notePageError('card write before checkout'); break; }
          lastQueuedSeq = saveQueue.write(m.bytes);
          // The first write after a no change card look (the board's eject finishing late): the card's state after the miss.
          if (cardLook && cardLook.wrote === null && cardLook.after === null) cardLook.after = lastQueuedSeq;
          break;
        }
        link.postMessage({ type: 'card-write', seq: writeSeq, bytes: m.bytes }, [m.bytes]);
        break;
      }
      case 'card-final': if (finalWait) { const r = finalWait; finalWait = null; r(m); } break;
      case 'card-base': state.cardBase = m.base; break; // the board's eject baseline (lab view)
      case 'card-eject': if (ejectWait) { const r = ejectWait; ejectWait = null; r(m); } break;
      // Every board 'error' is fatal (the core's start, the game's load, a
      // retro_run that threw), so a room seat ends as 'bug' with the plain
      // notice. Before 'ready' the board never started: it is dead, no card
      // look. After 'ready' (the game load failed, or retro_run threw) the
      // worker still answers, so the card look runs first, as on every end.
      case 'error':
        st.errors.push(m.message);
        if (handoff && !state.roomEnd) {
          if (!st.ready) { boardDead = true; endRoomSeat('bug', END_TEXT.boot, 0, 'board error before ready'); } else endRoomSeat('bug', END_TEXT.bug, 0, 'board error after ready');
        }
        break;
      case 'core-refused': st.errors.push(`core refused (${m.why})`); if (handoff) { boardDead = true; endRoomSeat('bug', END_TEXT.core, 0, `core refused (${m.why})`); } break;
      case 'log': st.logs.push(m.text); if (st.logs.length > 200) st.logs.shift(); break;
      default: break;
    }
  };
  const fileCopies = files.map(([name, bytes]) => [name, bytes.slice(0)]);
  board.postMessage({
    type: 'init', label: `board${s.slot}`, index: 0, boardId: 0, seat: s.slot, n: s.n, actAsServer: false, multiboardSlaves: 1,
    edition: s.edition, sessionTag: s.sessionTag, mailbox, cabinet: null, canvas, files: fileCopies, game: s.game,
    frames: 100000000, hashEvery: num('every', 300), pinTime: s.pinTime, jitDet: 1, preserve: true, bank: 'snapshot', dynarec: 1, barrierTimeoutMs: 10000,
    ctl, frameCounts, hubStatus, autoStart: true, realtimeHz: 0, presses, yieldEvery: 1, verbose: false,
    card: card ? card.slice(0) : null, watchCard: !!card, netWatch: true, input: seatInput ? seatInput.buffer : null, audio: null, present: null, hidden: false,
    corePin: ed ? { edition: ed.edition } : null,
  }, [canvas, ...fileCopies.map(([, a]) => a)]);
  if (handoff) bootTimer = setTimeout(() => { bootTimer = null; if (!st.ready && !state.roomEnd) { boardDead = true; endRoomSeat('bug', END_TEXT.boot, 0, 'board boot timeout'); } }, BOOT_LIMIT_MS);
  // The checked-out card lives only in the board's memory file system now.
  card = null;
  leaveBtn.disabled = false;
  msg.textContent = `Seat ${s.slot} in room ${s.room}.`;
}

function stopBoard() {
  // An eject save still waiting for the board ends now (the board is gone).
  if (ejectWait) { const r = ejectWait; ejectWait = null; r({ out: false, pressed: 1 }); }
  if (seatInput) { seatInput.input.releaseAll(); }
  if (!board) return;
  Atomics.store(new Int32Array(ctl), 0, 1);
  link.postMessage({ type: 'stop' });
  const b = board;
  board = null;
  boardEndsAt = Date.now() + BOARD_END_MS;
  setTimeout(() => b.terminate(), BOARD_END_MS);
}

// Leave: one last look at the card file (its write goes up first), then
// the close; the room closes the card session and takes the slot back.
async function leave(reason = 'finish') {
  if (reconnect) {
    leaveBtn.disabled = true;
    msg.textContent = 'Reconnecting to your seat before leaving...';
    await new Promise((res) => { reconnectWaiters.push(res); });
  }
  if (state.phase === 'leaving' || state.phase === 'left' || state.phase === 'dropped') return state.left;
  state.phase = 'leaving';
  state.closePosted = false;
  leaveBtn.disabled = true;
  let final = null;
  if (board) {
    const seqBefore = lastQueuedSeq;
    final = await new Promise((resolve) => {
      finalWait = resolve;
      board.postMessage({ type: 'card-final' });
      setTimeout(() => { if (finalWait) { finalWait = null; resolve(null); } }, 12000);
    });
    // Recorded as it answers (review of 7d24d79, P1): the write it queued, if any; no answer, no outcome.
    cardLook = final ? { wrote: lastQueuedSeq !== seqBefore ? lastQueuedSeq : null, after: null } : null;
  }
  // Give the last write a moment to reach the link worker before the close.
  await new Promise((r) => setTimeout(r, 300));
  sendReport(true); // the room keeps this last report (phase leaving, final writes)
  link.postMessage({ type: 'leave', reason });
  state.closePosted = true;
  state.left = { reason, finalChanged: final ? final.changed : null, writes: state.cardWrites };
  return state.left;
}
window.seat.leave = (reason = 'finish') => seatLeave.leave(reason);
// DOC '99 with the card in a running board.
function jpCardIn() { return !!(settings && settings.game && settings.game !== REVC_GAME && state.hasCard && board); }
// The page unload (a closed tab or a reload), ONE rule (1d commit 6): it
// asks first only while a write is neither saved nor kept in the stash, or
// while a DOC '99 card is in and its eject save is not in the stash yet. A
// DOC '99 seat with the card in starts its eject save, so the card is not
// lost with the board (live: also while leaving, until the close is
// posted). The room seat's eject write, once the card is out, is the
// queue's (unstashed); the lab's goes up the link. A browser that leaves
// anyway is the room's to end.
if (typeof window.addEventListener === 'function') window.addEventListener('beforeunload', (e) => {
  const owed = !!(saveQueue && saveQueue.unstashed() > 0);
  const live = state.phase === 'linking' || state.phase === 'seated' || state.phase === 'ejecting' || (state.phase === 'leaving' && !state.closePosted);
  const cardIn = jpCardIn() && live && !(handoff && ejectOut);
  if (cardIn) seatLeave.leave('finish');
  if (!owed && !cardIn) return;
  e.preventDefault();
  e.returnValue = '';
});
// L2: the seat's own lease heartbeat reply (step 1b: seat-lease.js calls
// this with each 2xx reply's body). A closing, or the cap signal, goes to the
// room server in the seat report (mp-wire.js cleanClosing), which acts on it
// for this lease and seat; closing_until stays the server's own string.
function leaseReply(body) {
  // Fresh relay servers with a beat (doc-arcade ROOM_TURN_FIRST): kept on the hand-off, where the next join (a
  // reconnect) and the main view read them, so neither is left with a set that has run out.
  if (handoff && body && Array.isArray(body.ice_servers) && body.ice_servers.length && typeof body.ice_expires_at === 'string' && Number.isFinite(Date.parse(body.ice_expires_at))) {
    handoff.ice_servers = body.ice_servers;
    handoff.ice_expires_at = body.ice_expires_at;
  }
  if (handoff && lease && !checkoutStarted) { checkoutStarted = true; checkOut(); }
  const c = closingFromReply(body, { nowMs: Date.now() });
  const cap = ejectAfterRace(body);
  const until = c && body && typeof body.closing_until === 'string' ? body.closing_until : null;
  // closing: true also when the reply names no closing_until (the room
  // server then logs it and uses the section 5 table until its own call).
  const next = c || cap ? { until, reason: c ? c.reason : null, ejectAfterRace: cap, closing: !!c } : null;
  const changed = JSON.stringify(next) !== JSON.stringify(state.leaseClosing || null);
  state.leaseClosing = next;
  if (changed) { sendReport(true); showClosingNotice(next); }
  return next;
}
// Batch 1: the room seat says so when its room is closing or this is its last race (the same reply the room server
// acts on), so the end is never a surprise. Plain words, no codes; the time is the player's own clock.
const noticeEl = roomSeat ? document.getElementById('notice') : null;
function showClosingNotice(c) {
  if (!noticeEl || state.roomEnd) return;
  const text = closingNoticeText(c);
  noticeEl.textContent = text;
  noticeEl.hidden = !text;
}
// LAB ONLY: the same, by hand (no lease client in the lab). The room seat
// has no such hook: its replies come from its own lease client only.
if (!roomSeat) window.seat.leaseHeartbeat = leaseReply;

// The room seat ends (step 1b). The lease is over (seat-lease.js onEnd: the
// refusal table of docs/seat-contract.md), the room's offer was refused or
// ran out, or the link ended: stop beating at once, make the card safe (the
// #169 leave: CARD on DOC '99, then the card look), stop the board LAST, and
// go back to return_path. A 400 is a seat bug: it reports, stops, and stays.
// A card change not saved yet holds the way back (savesOwed, showHeld).
// Step 1e: the seat's own Leave closes its lease (seat_lease close, recorded 'seat_closed'), once nothing is left to
// save (the drain is over: a held write keeps the lease open for its late save), so the member is free at once instead
// of waiting out the lease. A drop (the room ended the seat, or the link failed) is left to the room and the abandon rules.
function closeHook(why) {
  if (why !== 'left' || !lease || savesOwed() > 0) return;
  lease.close().then((r) => { state.leaseClose = r; if (!r.ok) notePageError(`lease close ${r.status}${r.code ? ` ${r.code}` : ''}`); }, () => { state.leaseClose = { ok: false, status: 0, code: 'threw' }; });
}
// The link's end: the board, signalling and the peer.
function dropLink() {
  stopBoard();
  if (sig) { const s = sig; sig = null; try { s.close(); } catch { /* closed */ } }
  if (peer && typeof peer.discard === 'function') { try { peer.discard(); } catch { /* closed */ } }
}
// 1d commit 6, the eject order (P2-5): a lease still live with a card to
// make safe (a running board) or a write pending beats ONCE at the end (a
// fresh race_nonce for the eject save), the card is made safe (its write
// joins the queue), the queue drains within EJECT_SAVE_MS of the end, and
// only then does the lease stop, so a nonce refusal of the eject save can
// still beat for a new one. The beat runs beside the eject (the queue reads
// the nonce when it posts). Otherwise the beat stops at once, as before.
function endRoomSeat(why, text, delayMs, bugNote = null) {
  if (!handoff || state.roomEnd) return;
  state.roomEnd = { why, at: Date.now(), back: null };
  const saving = !!(lease && lease.state() === 'beating' && saveQueue && ((board && !boardDead) || saveQueue.state().pending > 0));
  if (saving) lease.beatNow().catch(() => null);
  else if (lease) lease.stop(); // nothing to save: the beat never outlives the seat
  input.disabled = true; // no game files after the end
  if (text) msg.textContent = text;
  if (why === 'bug') { notePageError(bugNote || `lease answer ${state.leaseEnd ? state.leaseEnd.status : 0}`); showWayBack(handoff.return_path); }
  const report = why === 'bug' ? reportFirst() : Promise.resolve();
  report.then(cardFirst).then(closeFirst).then(() => ejectDrain(saving, text)).then(() => finishRoomSeat(why, text, delayMs));
}
// The seat's close goes up BEFORE the drain (commit 8), so the drain never
// holds the room's slot. A card look's leave posted it already (leave());
// with no card leave (no board, or a dead one) on an open link, the last
// report and the close go here. finishRoomSeat then posts nothing more.
function closeFirst() {
  if (!linkOpen || state.gone || state.closePosted) return;
  if (!state.roomEnd.reportedAt) sendReport(true); // a seat bug's report went up already (reportFirst)
  link.postMessage({ type: 'leave', reason: 'finish' });
  state.closePosted = true;
}
// A missed eject says the card IS saved (ruled) only when the card's state
// after the miss is known to have landed (review of 7d24d79, P1): the card
// look answered and queued seq S (or, after a no change look, the board's
// first write S), and a seq >= S landed. Anything else is the staff text: a
// look that timed out, its write not landed, or a look that answered with
// no write and no write after it (ruled 2026-11-09, the conductor: under lab
// run 4 a missed DOC '99 eject means no game write since 'seated', so menu
// purchases can live only in game memory; earlier writes landing proves
// nothing about them).
function missedSaved() {
  if (!ejectMissed || !saveQueue || !cardLook) return false;
  const s = cardLook.wrote !== null ? cardLook.wrote : cardLook.after;
  if (s === null) return false;
  const ls = saveQueue.stats().landedSeq;
  return ls !== null && ls >= s;
}
// The missed eject's line, at the drop and on the saved-late path: saved
// (missedSaved), else the staff text. Ruled 2026-11-09 (the conductor,
// replacing commit 10's no change line): on DOC '99 a missed eject means
// the game never wrote the card back, so a card look's "no change" proves
// nothing. The miss and its reason are in the log already (seatLeave's
// ejectCard).
function missedText() {
  if (missedSaved()) return MISSED_SAVED_TEXT;
  return MISSED_TEXT;
}
// The eject save's drain, then the lease's stop (the end's own, above).
// Review of 92fe3de (P2-1): the report wait and the card look can spend the
// whole EJECT_SAVE_MS, so the drain has its own floor from the card look's
// end (EJECT_DRAIN_FLOOR_MS): one post, a refresh beat and one retry. The
// lease stops at most max(the end + EJECT_SAVE_MS, the card look's end +
// EJECT_DRAIN_FLOOR_MS).
function ejectDrain(saving, text) {
  if (!saving) return Promise.resolve();
  state.roomEnd.cardDoneAt = Date.now();
  const left = Math.max(EJECT_DRAIN_FLOOR_MS, state.roomEnd.at + EJECT_SAVE_MS - Date.now());
  // Writes pending: the saving notice, with the seconds left to the drain's bound, for the whole drain.
  let tick = null;
  if (saveQueue.state().pending > 0) {
    const until = Date.now() + left;
    const show = () => { msg.textContent = `${SAVING_TEXT} (${Math.max(0, Math.ceil((until - Date.now()) / 1000))} s)`; };
    show();
    tick = setInterval(show, 1000);
  }
  return saveQueue.drain(left).then(() => {}, () => {}).then(() => {
    if (tick !== null) { clearInterval(tick); msg.textContent = text || ''; } // the end's own text, until the drop says more
    if (lease) lease.stop();
    state.roomEnd.leaseStoppedAt = Date.now();
  });
}
// A seat bug's report goes up the link before the seat stops: at once when
// the link is open, else when it opens, waiting at most BUG_REPORT_WAIT_MS
// (then no report). The link stays up LEAVE_SETTLE_MS after it.
function reportFirst() {
  return new Promise((resolve) => {
    const send = () => { sendReport(true); state.roomEnd.reportedAt = Date.now(); setTimeout(resolve, LEAVE_SETTLE_MS); };
    if (linkOpen) { send(); return; }
    if (state.gone) { resolve(); return; }
    const t = setTimeout(() => { bugWait = null; resolve(); }, BUG_REPORT_WAIT_MS);
    bugWait = (open) => { clearTimeout(t); bugWait = null; if (open) send(); else resolve(); };
  });
}
// The card first: with a board running, the #169 leave (CARD on DOC '99,
// then the card look, whose write goes to the save queue). The queue then
// drains (ejectDrain), before the board stops.
// A DOC '99 eject that did not come out (the link up or gone) is noted
// (ejectMissed): the member is told, as for a held card.
function cardFirst() {
  if (!board || boardDead) return Promise.resolve();
  return seatLeave.leave('finish').then((r) => {
    if (!(r && r.jp && !r.out)) return;
    ejectMissed = true;
    state.roomEnd.ejectMiss = ejectMissWhy || 'no answer'; // logged when it missed (seatLeave's ejectCard)
  }, () => {});
}
// Once the seat's close is posted, the report, the card writes and the close
// are still on their way through the link worker to the peer: the link's own
// end (the room read the close and ended it, or the worker's fallback close)
// is the sign they left. At most POST_MS.
function linkClosed() {
  if (state.gone || !state.closePosted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => { goneWait = null; resolve(); }, POST_MS);
    goneWait = () => { clearTimeout(t); goneWait = null; resolve(); };
  });
}
function finishRoomSeat(why, text, delayMs) {
  // The close went up before the drain (closeFirst); the link's own end is
  // still awaited, so the last report and the close reach the room before
  // the peer goes (the same bounded wait).
  closeFirst(); // posted before the drain already (commit 8): nothing twice
  return linkClosed().then(() => dropRoomSeat(why, text, delayMs));
}
function dropRoomSeat(why, text, delayMs) {
  if (why === 'left') state.phase = 'left';
  else if (state.phase !== 'left' && state.phase !== 'refused') state.phase = 'dropped';
  dropLink(); // the board stops last
  if (mainView) { mainView.stop(); mainView = null; }
  state.roomEnd.droppedAt = Date.now();
  closeHook(why);
  endText = text || '';
  endWhy = why;
  // The lease has ended, or nothing is left to send with writes held
  // (review P2-3): nothing more is tried here, the queue stops (the kept path).
  if (saveQueue && (state.leaseEnd || (saveQueue.state().pending === 0 && saveQueue.state().held > 0))) saveQueue.stop('ended');
  if (savesOwed() > 0) { showHeld(); return; }
  // A missed eject: its later write landed (in the drain): saved, said so (ruled); else the staff text. Never a way back on its own.
  if (ejectMissed) { msg.textContent = missedText(); showWayBack(handoff.return_path); return; }
  if (text) msg.textContent = text;
  if (why === 'bug') { showWayBack(handoff.return_path); return; }
  state.roomEnd.back = handoff.return_path;
  // Not before the board has ended (a queued card write is held instead).
  const wait = Math.max(0, state.roomEnd.at + delayMs - Date.now(), boardEndsAt ? boardEndsAt + BACK_AFTER_BOARD_MS - Date.now() : 0);
  backTimer = setTimeout(() => { backTimer = null; if (savesOwed() === 0) location.replace(handoff.return_path); }, wait);
}
// The link's end, for the room seat: the room dropped or ended the seat
// ('dropped'), the link failed ('lost'), or the seat itself left ('left').
function linkEndCause(reason) {
  if (state.closePosted || reason === 'left' || reason === 'worker') return 'left';
  if (/^(peer failed|pair |flood|bad channel|sdp refused|worker error)/.test(String(reason))) return 'lost';
  return 'dropped';
}
function roomLinkEnded(reason) {
  if (goneWait) goneWait();
  const why = linkEndCause(reason);
  state.linkEnd = { why };
  endRoomSeat(why, why === 'lost' ? END_TEXT.linkLost : END_TEXT[why], why === 'left' ? 0 : RETURN_NOTICE_MS);
}
// 1d commit 5: the writes not landed yet (queued or held).
function savesOwed() {
  if (!saveQueue) return 0;
  const q = saveQueue.state();
  return q.pending + q.held;
}
// The seat dropped with a write owed: the way back waits (a pending replace
// is cancelled, so the page never prompts on its own navigation) and the
// member is told whether the stash keeps it.
function showHeld() {
  savesHold = true;
  if (backTimer) { clearTimeout(backTimer); backTimer = null; }
  state.roomEnd.back = null;
  const lost = saveQueue && saveQueue.unstashed() > 0;
  // The queue stopped with every write in the stash: nothing more is tried
  // here, so the member is told and goes back after the notice (a seat bug
  // stays; a card that did not come out stays: staff). No stash at all:
  // never a redirect (the lost text and the link).
  const goBack = !!(stash && !lost && saveQueue && saveQueue.state().stopped && endWhy !== 'bug' && !ejectMissed);
  // Not kept: the loss is said on its own. Kept: the end's own notice (not
  // its going back unless the page goes), then that. A card that did not
  // come out (review P3): its own notice first.
  const lead = ejectMissed ? MISSED_TEXT : endText.replace(/ ?Going back to the rooms\.$/, '');
  msg.textContent = lost ? [ejectMissed ? MISSED_TEXT : '', HELD_TEXT].filter(Boolean).join(' ') : [lead, goBack ? KEPT_GO_TEXT : HELD_KEPT_TEXT].filter(Boolean).join(' ');
  showWayBack(handoff.return_path);
  // A lost write (review P2-2): no way back on its own.
  if (lost && keptTimer !== null) { clearTimeout(keptTimer); keptTimer = null; }
  // A put that settled kept since the last notice: the notice's full time
  // again (review P3). Re-checked when it fires: still kept, nothing lost.
  const settledKept = heldLoose > 0 && !lost;
  heldLoose = saveQueue ? saveQueue.unstashed() : 0;
  if (goBack && settledKept && keptTimer !== null) { clearTimeout(keptTimer); keptTimer = null; }
  if (goBack && keptTimer === null) keptTimer = setTimeout(() => { keptTimer = null; if (stash && saveQueue && saveQueue.unstashed() === 0) location.replace(handoff.return_path); }, KEPT_NOTICE_MS);
}
// The save queue's every change: the lab view, and the hold after the drop.
function savesChanged(q) {
  state.saves = { pending: q.pending, held: q.held, stopped: q.stopped };
  if (!state.roomEnd || state.roomEnd.droppedAt === undefined) {
    // In play (review P2-8): a stop is said, the writes go on to the stash.
    if (q.stopped && !savesPaused && !state.roomEnd) { savesPaused = true; msg.textContent = SAVES_PAUSED_TEXT; notePageError(`saves stopped (${q.stopped} ${saveQueue ? saveQueue.stats().lastStatus : 0})`); }
    return;
  }
  // After the drop (review P2-3): nothing left to send and writes held, so
  // nothing more is tried here: the queue stops ('ended'), the kept path.
  if (saveQueue && !q.stopped && q.pending === 0 && q.held > 0) { saveQueue.stop('ended'); return; }
  if (q.pending + q.held > 0) { showHeld(); return; }
  if (!savesHold) return;
  // The held write landed after all: said, and the way back resumes after the
  // notice (a seat bug still stays, with its link back).
  savesHold = false;
  // The kept way back is not owed any more (an in-flight write landed after the stop).
  if (keptTimer !== null) { clearTimeout(keptTimer); keptTimer = null; }
  // A card that did not come out keeps its notice and its link, never an
  // automatic way back (as dropRoomSeat; review of 0e29340).
  msg.textContent = ejectMissed ? missedText() : [endText, SAVED_LATE_TEXT].filter(Boolean).join(' ');
  showWayBack(handoff.return_path);
  if (endWhy === 'bug' || ejectMissed) return;
  state.roomEnd.back = handoff.return_path;
  backTimer = setTimeout(() => { backTimer = null; if (savesOwed() === 0) location.replace(handoff.return_path); }, RETURN_NOTICE_MS);
}
// 1d commit 5: the card is checked out once, after the lease's first 2xx
// beat. A missing or malformed member_hash (the stash's key) is a seat bug
// before play: a seat that cannot stash could lose a card.
async function checkOut() {
  const r = await lease.checkout({ canRetry: () => !started });
  if (!r.ok || state.roomEnd) return; // a refusal ended the lease: leaseEnded ends the seat
  const b = r.body || {};
  const mh = typeof b.member_hash === 'string' ? b.member_hash : '';
  if (!/^[0-9a-f]{64}$/.test(mh)) { endRoomSeat('bug', END_TEXT.bug, 0, 'checkout without member_hash'); return; }
  let bytes = null;
  try { bytes = Uint8Array.from(atob(String(b.card_b64 || '')), (ch) => ch.charCodeAt(0)); } catch { bytes = null; }
  if (!bytes || bytes.length === 0 || !Number.isSafeInteger(b.last_seq) || b.last_seq < 0 || b.horse_id !== handoff.horse_id) { endRoomSeat('bug', END_TEXT.bug, 0, 'checkout answer refused'); return; }
  await stashOpen;
  if (state.roomEnd) return;
  saveQueue = createSaveQueue({
    handoff, firstSeq: b.last_seq + 1, stash, memberHash: mh, edition: releaseEdition(handoff.release),
    nonce: () => lease.facts().race_nonce, refreshNonce: () => lease.beatNow(), timeLeft: () => lease.timeLeft(),
    onChange: savesChanged, onNote: (t) => notePageError(t),
  });
  state.checkedOut = { lastSeq: b.last_seq };
  card = bytes.buffer;
  state.hasCard = true;
  maybeStart();
}
// The link worker is gone (onerror, then silence): its clock went with it.
function linkDead() {
  freeBoard();
  if (state.gone) return;
  state.gone = true; state.goneReason = 'worker error'; linkOpen = false;
  if (bugWait) bugWait(false);
  roomLinkEnded('worker error');
}
// The link clock's fault (review fix 5): the board runs free, and the seat
// ends as 'lost' at once (endRoomSeat: the card first, then the close).
function linkClockFault() {
  freeBoard();
  endRoomSeat('lost', END_TEXT.linkLost, RETURN_NOTICE_MS);
}
// A link worker that failed took the board's clock: release the board's
// vblank barrier for good (MB.barrierStop), so it runs free to the end.
function freeBoard() {
  if (!mailbox) return;
  const i32 = new Int32Array(mailbox);
  Atomics.store(i32, MB.barrierStop >> 2, 1);
  Atomics.notify(i32, MB.hubRound >> 2);
}
// A same-origin link back, after the message (one link, moved if shown again).
function showWayBack(path) {
  if (typeof document.createElement !== 'function' || typeof msg.append !== 'function') return;
  if (!wayBack) { wayBack = document.createElement('a'); wayBack.textContent = 'Back to the rooms'; }
  wayBack.href = path;
  msg.append(' ', wayBack);
}
// The room's offer is over without a seat (a final refusal, the ticket ran
// out, the page cannot run): the room seat goes back. The lab keeps showing
// it. Always on a later task: some of these come during the page's own
// start-up, and no end path runs in the middle of it.
function offerEnded() {
  if (handoff) setTimeout(() => endRoomSeat('refused', null, RETURN_NOTICE_MS), 0);
}
function leaseEnded(info) {
  state.leaseEnd = info;
  // 402, 403 and the rest: the route's own message, for a moment. A bare
  // code (an answer with no message of its own) is not shown as words.
  const own = info.message && !/^[a-z_]{1,32}$/.test(info.message) ? info.message : null;
  if (info.kind === 'refused') endRoomSeat('refused', own || 'The rooms refused this seat. Going back to the rooms.', RETURN_NOTICE_MS);
  else if (info.kind === 'resting') endRoomSeat('resting', END_TEXT.resting, RETURN_NOTICE_MS);
  else endRoomSeat(info.kind, END_TEXT[info.kind] || END_TEXT.gone, 0);
}
// LAB ONLY: hold the link (no sending, no delivery) for ms, a stall test.
if (!roomSeat) window.seat.stall = (ms) => link.postMessage({ type: 'stall', ms });
// LAB ONLY: cut the link as a network drop would (the peer closes; the seat then reconnects if the room holds it).
if (!roomSeat) window.seat.dropLink = () => { if (peer) peer.close('lab drop'); };
// Batch 1, the room seat only: the controls panel (room-seat-controls.js, the cabinet seat's store), full screen (the
// button or F; Escape leaves it, the browser's own), and a check before a Leave while the board runs (the card comes
// out and is saved first, so a stray click never ends a stint). The lab seat keeps its plain button.
const controlsBtn = document.getElementById('controls');
const fullBtn = document.getElementById('fullscreen');
const stage = document.getElementById('stage');
const leaveAsk = roomSeat ? document.getElementById('leave-confirm') : null;
const controlsPanel = roomSeat && controlsBtn ? createControlsPanel({ win: window, doc: document, seatInput }) : null;
if (controlsPanel) { controlsBtn.hidden = false; controlsBtn.addEventListener('click', () => controlsPanel.open()); }
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (stage && stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
}
if (roomSeat && fullBtn && stage && typeof stage.requestFullscreen === 'function') {
  fullBtn.hidden = false;
  fullBtn.addEventListener('click', toggleFullscreen);
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyF' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if ((controlsPanel && controlsPanel.isOpen()) || (leaveAsk && !leaveAsk.hidden)) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    toggleFullscreen();
  });
}
function closeLeaveAsk() { if (!leaveAsk || leaveAsk.hidden) return; leaveAsk.hidden = true; if (seatInput) seatInput.input.suspend(false); }
function askLeave() {
  if (!leaveAsk || !(state.phase === 'linking' || state.phase === 'seated')) { seatLeave.leave('finish'); return; }
  if (!leaveAsk.hidden) return;
  leaveAsk.hidden = false;
  if (seatInput) seatInput.input.suspend(true); // a key pressed at the question never reaches the game
  document.getElementById('leave-no').focus();
}
if (leaveAsk) {
  document.getElementById('leave-yes').addEventListener('click', () => { closeLeaveAsk(); seatLeave.leave('finish'); });
  document.getElementById('leave-no').addEventListener('click', closeLeaveAsk);
  leaveAsk.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeLeaveAsk(); } });
  leaveAsk.addEventListener('click', (e) => { if (e.target === leaveAsk) closeLeaveAsk(); });
}
leaveBtn.addEventListener('click', askLeave);
// Option A step 2, the room seat only: the room's main screen (both halves of the race screen, published once per room
// by the room, room-main-view.js) on top, the player's own board below, as the cabinet seat lays out its mains and its
// satellite. Read only, from the room host this seat signals to. A view that cannot start never stops the seat.
const mainVideo = document.getElementById('main');
function fitMain() {
  if (!mainVideo || mainVideo.hidden) return;
  const full = !!document.fullscreenElement;
  const top = full ? 0 : Math.max(0, stage.getBoundingClientRect().top + window.scrollY);
  const avail = Math.max(240, window.innerHeight - top - (full ? 0 : 12));
  const mw = Math.max(320, Math.min(window.innerWidth - (full ? 0 : 24), avail * 4 / 3));
  const sh = Math.max(150, avail - mw * 3 / 8 - 6);
  const sw = Math.min(mw, sh * 4 / 3);
  stage.style.setProperty('--mw', `${Math.floor(mw)}px`);
  stage.style.setProperty('--sw', `${Math.floor(sw)}px`);
}
if (roomSeat && mainVideo && stage && handoff && metas.expect && mainViewSupported()) {
  const whep = mainWhepUrl(metas.expect.signalHost, handoff.room_tag);
  if (whep) {
    try {
      mainView = createMainView({ video: mainVideo, whepUrl: whep, iceServers: () => mainViewIceServers(handoff, Date.now()) });
      mainVideo.hidden = false;
      if (document.body && document.body.classList) document.body.classList.add('main-on');
      fitMain();
      window.addEventListener('resize', fitMain);
      document.addEventListener('fullscreenchange', () => setTimeout(fitMain, 50));
      mainView.start();
    } catch (err) {
      mainView = null;
      mainVideo.hidden = true;
      if (document.body && document.body.classList) document.body.classList.remove('main-on');
      notePageError(`main view not started (${String(err && err.message ? err.message : err).slice(0, 60)})`);
    }
  }
}
// Batch 1 step 4, the room seat only: the on-screen buttons (room-seat-pad.js, the cabinet seat's touch pad with its
// stored layout), shown per the player's "On-screen buttons" choice in the Controls panel (auto: a touch screen), with
// a header button to show or hide them for this visit and one to arrange them. A pad press goes into the seat's own
// input (seatInput.padPress, the same safety rules as the keys); while the pad is arranged every game input is held
// (seatInput.hold), and the hold lifts only once no controller button is down. The lab seat has no pad.
const padBtn = document.getElementById('pad');
const arrangeBtn = document.getElementById('pad-arrange');
let seatPad = null; // set below; padButtons runs while it is made
function padButtons() {
  if (!seatPad) return;
  padBtn.hidden = false;
  padBtn.textContent = seatPad.shown() ? 'Hide buttons' : 'Show buttons';
  padBtn.setAttribute('aria-pressed', String(seatPad.shown()));
  arrangeBtn.hidden = !seatPad.shown();
  arrangeBtn.textContent = seatPad.arranging() ? 'Done arranging' : 'Arrange buttons';
}
function padArrange(on) {
  if (!seatInput) return;
  if (on) seatInput.hold('pad-arrange', true);
  else seatInput.unholdWhenIdle('pad-arrange'); // a press resting when arranging ends never reaches the game
}
if (roomSeat && padBtn && arrangeBtn && stage && typeof stage.appendChild === 'function' && typeof window.matchMedia === 'function') {
  // A pad that cannot start never stops the seat: the keys and the controller still play.
  try {
    seatPad = createRoomSeatPad({
      win: window, doc: document, parent: stage, picture: document.getElementById('screen'),
      chrome: [document.querySelector('header'), noticeEl, mainVideo && !mainVideo.hidden ? mainVideo : null], lang: padLangFor(handoff && handoff.release),
      press: (a) => !!seatInput && seatInput.padPress(a), release: (a) => !!seatInput && seatInput.padRelease(a),
      releaseAll: () => { if (seatInput) seatInput.padReleaseAll(); }, onArrange: padArrange, onState: padButtons,
    });
  } catch (err) {
    seatPad = null;
    notePageError(`pad not started (${String(err && err.message ? err.message : err).slice(0, 60)})`);
  }
  if (seatPad) {
    padButtons();
    padBtn.addEventListener('click', () => seatPad.toggle());
    arrangeBtn.addEventListener('click', () => seatPad.setArranging(!seatPad.arranging()));
  }
}

// Autoleave and the seat report, once the board runs.
function sendReport(force = false) {
  let body;
  try { body = encodeSeatReport(seatReportOf(state, pageErrors)); } catch { return; }
  const key = new TextDecoder().decode(body).replace(/"f":[0-9]+,/, '');
  if (!force && key === reportSent && Date.now() - reportAt < 5000) return;
  reportSent = key;
  reportAt = Date.now();
  const buf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  link.postMessage({ type: 'report', body: buf }, [buf]);
}
setInterval(() => {
  if (!started || state.phase === 'left' || state.phase === 'dropped' || state.phase === 'refused') return;
  if (autoLeave && (state.phase === 'linking' || state.phase === 'seated') && autoLeave.step({ races: state.board.counts.races, cardWrites: state.cardWrites, now: Date.now() })) seatLeave.leave('finish');
  if (state.phase !== 'leaving') sendReport();
}, 1000);

// The waiting card (room-seat-handoff.js seatWaitCard): over the player's own screen until the station is theirs.
// On the room seat and on the lab seat page alike.
try {
  const waitEl = document.getElementById('wait');
  const screenEl = document.getElementById('screen');
  if (waitEl && screenEl) {
    const titleEl = document.getElementById('wait-title'); const textEl = document.getElementById('wait-text'); const timeEl = document.getElementById('wait-time');
    const bars = typeof document.querySelectorAll === 'function' ? [...document.querySelectorAll('#wait-steps i')] : [];
    let step = 0; let stepAt = performance.now(); const openedAt = performance.now();
    const ended = () => ['refused', 'left', 'dropped', 'leaving'].includes(state.phase) || state.gone;
    const paint = () => { try { paintCard(); } catch { /* the card is a nicety: it never stops the seat */ } };
    const paintCard = () => {
      const c = ended() ? null : seatWaitCard({ phase: state.phase, linkOpen, warm: state.warm === true, waitedS: (performance.now() - stepAt) / 1000, mainOn: !!(mainVideo && !mainVideo.hidden) });
      if (!c) { if (!waitEl.hidden) waitEl.hidden = true; return; }
      if (c.step !== step) { step = c.step; stepAt = performance.now(); }
      // Over the picture exactly, wherever the layout has put it.
      waitEl.style.left = `${screenEl.offsetLeft}px`; waitEl.style.top = `${screenEl.offsetTop}px`;
      waitEl.style.width = `${screenEl.offsetWidth}px`; waitEl.style.height = `${screenEl.offsetHeight}px`;
      if (titleEl.textContent !== c.title) titleEl.textContent = c.title;
      if (textEl.textContent !== c.text) textEl.textContent = c.text;
      bars.forEach((b, i) => { b.className = i + 1 < c.step ? 'done' : i + 1 === c.step ? 'now' : ''; });
      const s = Math.floor((performance.now() - openedAt) / 1000);
      timeEl.textContent = `Step ${c.step} of 4. Waiting ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (waitEl.hidden) waitEl.hidden = false;
    };
    setInterval(paint, 500);
    window.addEventListener('resize', paint);
    paint();
  }
} catch { /* no card on this page */ }

setInterval(() => {
  const st = state.board;
  const smp = st.samples.length ? st.samples[st.samples.length - 1] : null;
  const l = state.link;
  statusEl.textContent = [`phase ${state.phase}${state.refused ? ` (${state.refused})` : ''}`,
    smp ? `board f ${smp.f} comm2 ${smp.status.comm2}` : 'board -',
    l ? `link up ${l.upSent} down ${l.downDelivered} released ${l.released} not at barrier ${l.notAtBarrier}` : 'link -',
    `card writes ${state.cardWrites} acks ${state.cardAcks.map((a) => a.verdict).join(',')}`].join('\n');
}, 500);
