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
// CHANGE HORSE (2026-11-23, docs/seat-contract.md "Changing horses without leaving the seat"): the room seat can
// change to another of the member's horses, or a new one, without leaving the seat. One visit then runs several
// leases in sequence (room-lease-session.js: one lease client, one checkout and one save queue per lease, a card
// generation per card in the reader); the chooser is room-seat-chooser.js, the order of a change and its crash
// points room-seat-swap.js, its calls room-seat-net.js. A visit that never changes horses is exactly as before.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later

import { MB_TOTAL_BYTES, HUB_STATUS, MB } from './lb-lockstep.js';
import { pickLabGameSet, pageGameSet, editionForLinkTag, labGameSet } from './lab-game-set.js';
import { peekTicket } from './mp-wire.js';
import { pageAllowlist } from './mp-lan.js';
import { openSignal, createPeerLink } from './mp-rtc.js';
import { parseAutoLeave, createAutoLeave, seatReportOf, newWatchCounts, countWatch } from './mp-seat-auto.js';
import { createGameCache, playerGameFiles } from './mp-game-cache.js';
import { parseNetem, createNetem } from './mp-netem.js';
import { encodeSeatReport, reportText } from './mp-wire.js';
import { createSeatLeave, cardEjectRequest, CARD_EJECT_WAIT_MS } from './mp-seat-eject.js';
import { closingFromReply, ejectAfterRace, closingNoticeText, LEAVE_SETTLE_MS, POST_MS, EJECT_SAVE_MS } from './room-closing.js';
import { ROOM_RESTART_REASON, ROOM_RESTART_TEXT, markRoomRestartNote, markSeatEndNote } from './room-closing.js';
import { REVC_GAME } from './mp-entry-watch.js';
import { createPublicPolicy } from './mp-public.js';
import { roomSeatIntake, seatMetas, isReload, handoffIceServers, mainViewIceServers, isRoomSlot, seatWaitCard, horseLabel, serverNow, wayBackWords } from './room-seat-handoff.js';
import { createSeatLease, readCheckout } from './seat-lease.js';
import { seatEdition, releaseEdition } from './core-pin.js';
import { editionFiles, linkTags } from './edition-b.js';
import { editionDef } from './editions.js';
import { openStash } from './room-stash.js';
import { createSaveQueue, REQUEST_TIMEOUT_MS as SAVE_REQUEST_MS } from './room-save-queue.js';
import { createRoomSeatInput } from './room-seat-input.js';
import { createControlsPanel } from './room-seat-controls.js';
import { createMainView, mainWhepUrl, mainViewSupported } from './room-main-view.js';
import { createRoomSeatPad, padLangFor } from './room-seat-pad.js';
import { createSeatAudio, soundButtonView, mainButtonView, soundPromptView } from './room-seat-audio.js';
import { seatLayout, layoutVars, padPreset, touchLayoutWanted } from './room-seat-layout.js';
import { createWakeLock, createHaptics, guardPlayArea, readInsets, coarsePointer } from './room-seat-phone.js';
import { createLeaseSessions, leaseView } from './room-lease-session.js';
import { runHorseSwap, refusalWords, SWAP_TEXT, SWAP_FALLBACK_TEXT, isHandLine, stationLine, isSeatStartLine } from './room-seat-swap.js';
import { chooserView, createHorseChooser } from './room-seat-chooser.js';
import { createSeatCalls, giveBackRefusedSeat } from './room-seat-net.js';
import { checkGameFiles, gameRefusalText, gameCheckWanted } from './game-check.js';
import { createCareLog, createCareOutbox } from './care-recorder.js';
import { createSeatLog, createRateMeter, createReportSender, createReportSheet, buildSeatReport, capturePicture, seatStats, seatState, deviceFacts, facts as reportFacts, newReportId, reportCopy } from './room-seat-report.js';

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
// A refused entry: the lobby had already reserved the place and opened the lease, so both are given back before the
// page goes (keepalive, so they outlive the way back; room-seat-net.js giveBackRefusedSeat). An entry this page may
// not act on was left for the lobby instead, which frees it on arrival (room-seat-handoff.js).
if (intake && intake.giveBack) giveBackRefusedSeat(intake.giveBack);
// No seat to open: the lobby says so on arrival (room-closing.js markSeatEndNote), instead of a bounce with no words.
if (intake && intake.go && !isReload()) markSeatEndNote('no_seat');
if (intake && intake.go) location.replace(intake.go);
// Batch 1 step 1: the room seat's live controls (room-seat-input.js). The player's keys and controller go straight
// into this page's own seat board, with the player's DOC Online mapping (doc_controls_v1, read by that module,
// which never writes; this page still writes nothing to storage). The lab
// seat keeps its scripted presses only.
let seatInput = null;
// Option A step 2: the room's main screen view (set where the page builds it; read by the seat's end paths).
let mainView = null;
// The page's sound (room-seat-audio.js): made as soon as the page is set up (startSeatAudio, called once below, long
// before the board starts), so the main cabinet's sound plays while the player waits for the station; the board takes
// its ring from it when it starts (maybeStart); closed when the seat stops (stopBoard).
let seatAudio = null;
// The room's main cabinet sound as it arrives with the main screen (room-main-view.js onAudio), or null: kept here so
// it reaches the seat's sound whichever of the two is there first.
let mainSound = null;
// The phone and tablet layout in force (room-seat-layout.js; set by applyTouchLayout further down), or null: a desktop.
let touchLayout = null;
// The screen kept awake while the seat runs (room-seat-phone.js): asked for where the page is set up, let go in stopBoard.
let wakeLock = null;
// The place at the room server was given back (leavePlace, further down; here so every end path may read it).
let placeLeft = false;
// The station was handed to this seat at least once (seated, and past a warm join's wait): the room then sees the
// seat itself, and its place is no longer a reservation to give back.
let stationMine = false;
// The game files panel's elements and its hold timer (the panel itself is further down; here so every end path may read them).
const fileEl = (id) => { try { return typeof document.getElementById === 'function' ? document.getElementById(id) : null; } catch { return null; } };
const filesUi = handoff ? { box: fileEl('files-ask'), text: fileEl('files-text'), names: fileEl('files-names'), own: fileEl('files-own'), pick: fileEl('files-pick'), chooser: fileEl('files-input'), status: fileEl('files-status'), held: fileEl('files-held'), back: fileEl('files-back'), title: fileEl('files-title') } : null;
const filesUiOk = !!(filesUi && filesUi.box && filesUi.status && filesUi.chooser);
let filesTimer = null;
// (notePageError is defined further down: a start fault is kept here and noted once the page is set up.)
let seatInputFault = null;
if (handoff) { try { seatInput = createRoomSeatInput({ win: window }); } catch (err) { seatInputFault = `controls not started (${String(err && err.message ? err.message : err).slice(0, 60)})`; } }
// Keys typed in the page's first moments belong to the page before it: the F shortcut waits this long.
const TYPED_AHEAD_MS = 5000;
// How long a refusal's own words stay on the page before it goes back.
const RETURN_NOTICE_MS = 4000;
// THE GAME FILES PANEL (the first visit of 2026-11-24). A room seat with no usable game files in this browser shows
// the panel over its own screen and stays an ordinary waiting seat (the lease beaten, the link up) for as long as the
// room keeps it, and never longer than this. Then the seat ends WITH WORDS and gives its place back.
// How long a problem report's outcome stays in the status strip.
const REPORT_SAID_MS = 6000;
const FILES_HOLD_MS = 600000;
const FILES_ROOM_MS = 60000;
const FILES_HELD_TEXT = 'Your seat is held while you choose your game files.';
const FILES_READY_TEXT = 'Game files ready.';
const FILES_END_TEXT = 'Your seat was given back because no game files were chosen. Join again when you have them ready.';
const FILES_END_PICK_TEXT = 'You can still choose them here now, so they are ready when you join again.';
const FILES_LATE_TEXT = 'Game files ready. Go back to the lobby and join again.';
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
// The way back in words, by the hand-off's return_path (room-seat-handoff.js wayBackWords): "/" is the lobby (its
// room card seats a member in place), /rooms the rooms page. Every line that names the way back says it this way.
const BACK = wayBackWords(handoff ? handoff.return_path : intake ? intake.returnPath : null);
const noGoing = (t) => (t.endsWith(BACK.going) ? t.slice(0, -BACK.going.length).trimEnd() : t);
// What the page says when the seat ends (the lease's end, or the link's).
const END_TEXT = {
  gone: `Your lease has ended. ${BACK.going}`,
  wrong_room: `This seat is not for this room. ${BACK.going}`,
  token: `This room was opened again elsewhere. ${BACK.going}`,
  lost: `The connection to the rooms was lost for too long. ${BACK.going}`,
  bug: 'This seat hit a problem and has stopped.',
  dropped: `The room ended this seat. ${BACK.going}`,
  linkLost: `The connection to the room was lost. ${BACK.going}`,
  left: `You left the seat. ${BACK.going}`,
  core: 'This seat could not load the right game for this room. Please tell the staff.',
  boot: 'This seat could not start the game. Please tell the staff.',
  // A checkout 429 (cooldown, too_many_checkouts): /rooms' resting text.
  resting: `This horse is resting. ${BACK.going}`,
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
// A NEW HORSE (the hand-off's new_horse with the checkout's; room-seat-handoff.js isNewHorse). The seat starts the
// game with no card in the reader, the member makes the horse in the game, and the game's first card write creates it
// in the member's stable (room-save-queue.js newHorse). The horse cannot race before that write has landed (the lobby
// refuses the race entry until then), so from the game's first card write until the save lands the seat's buttons do
// nothing (seatInput.hold 'new-horse'), with one of these lines up. The hand-off's empty name is never shown.
const NEW_HORSE_START_TEXT = 'New horse: make your horse in the game. It can race once it is saved.';
const NEW_HORSE_SAVING_TEXT = 'Saving your new horse. Your buttons are off until it is saved.';
const NEW_HORSE_SAVED_TEXT = 'is saved. You can enter the next race.';
// The first save was refused for the card itself: said plainly, once per refusal, never retried (the queue holds it).
const NEW_HORSE_REFUSED_TEXT = {
  race_count: 'Your new horse could not be saved, because its card already shows a race. It cannot race from this seat. Please leave the seat and tell the staff.',
  rejected: 'Your new horse could not be saved: its card did not pass the checks. It cannot race from this seat. Please leave the seat and tell the staff.',
  refused: 'Your new horse could not be saved. It cannot race from this seat. Please leave the seat and tell the staff.',
};
// ...and once the seat has ended with that write still owed (showHeld): kept for the staff, in the stash.
const NEW_HORSE_KEPT_TEXT = 'Your new horse could not be saved. Its card is kept in this browser for the staff to check. Please tell the staff.';
// THE OTHER HORSE (room-save-queue.js onOtherHorse: a save refused with the code 'other_horse'). The card in this
// seat's reader is not the horse this seat was opened for: the member made a new horse in the game here, and the game
// wrote it over the card file. Nothing of it is saved (the lobby refused it; the write stays in the stash as any held
// write does), and the seat must not go on racing under the first horse's lease. So (otherHorse, below): the buttons
// are held at once; the queue drains; one fresh beat says whether a race is owed (the lobby clears race_nonce and
// entry_sha when a race settles). Nothing owed: the seat closes its own lease and ends, with OTHER_HORSE_TEXT. A race
// owed, or a beat that did not answer: the lease is NOT closed (a close with a race owed is an abandon), the buttons
// stay held, and the member is told to leave (OTHER_HORSE_OWED_TEXT); each later beat looks again. The name is the
// horse label (horseLabel: never an empty name).
const OTHER_HORSE_TEXT = (name) => `The card in your reader is not ${name}. Nothing was saved for the new horse. To make a new horse, go back to Rooms and choose New horse.`;
// What is true with a race owed: the seat keeps its lease (the Leave button's end closes no lease while a write is
// held), the buttons do nothing, and Leave seat ends the seat as it always does.
const OTHER_HORSE_OWED_TEXT = (name) => `The card in your reader is not ${name}. Nothing was saved for the new horse, and your buttons are off. A race is still open for ${name}, so this seat was not closed for you. Press Leave seat to finish.`;
// While the drain and the fresh beat run (and while a beat has not answered yet).
const OTHER_HORSE_CHECK_TEXT = (name) => `The card in your reader is not ${name}. Your buttons are off while this seat checks that no race is open.`;
// The drain before the fresh beat: one post and its timeout (a write behind the refused one).
const OTHER_HORSE_DRAIN_MS = SAVE_REQUEST_MS + POST_MS;
// CHANGE HORSE (the owner's decision of 2026-11-23: a player holds the seat, horses come and go; the lobby's contract
// is doc-arcade docs/rooms/seat-horse-switch.md, the order of work is room-seat-swap.js, the panel is
// room-seat-chooser.js, docs/seat-contract.md has the whole of it). The texts a refusal shows are the sender's own
// (the lobby's, or the room server's for a refused hold); these few are the page's, for what only the page knows.
// The other horse, where the lobby offers a new horse (the pilot, with a slot left): the station is held and the
// chooser opens with this line and two choices: "New horse" (the card the game wrote is saved as the new horse's,
// under a new lease) or "Leave seat". No other horse is offered there: the game is in the middle of the new horse's game.
const OTHER_HORSE_LEAD = (name) => `The card in your reader is not ${name}: you made a new horse in the game. It is not saved yet. Choose New horse to keep it and play on, or leave the seat.`;
const CHANGE_NOT_YET_TEXT = 'You can change horses once you are in your seat.';
const CHANGE_ASKING_TEXT = 'Asking for your horses.';
// THE GAME'S OWN EJECT (the board's card-out: the core's "Card ejected"). The game is done with the card and its last
// save has landed: the page takes the card out of the reader (so the game can write no other horse over it) and asks
// "Which horse next?" by itself, with this line. Keep puts the card back: "[A] is in your hand. Press Insert card to
// put it in."
const CARD_OUT_LEAD = (name) => `The game has given ${name}'s card back. Take another horse, or keep ${name}.`;
const CARD_OUT_TEXT = (name) => `The game has given ${name}'s card back.`;
const READER_STUCK_TEXT = 'Your card could not be put back in the reader. Leave the seat and sit down again to go on with this horse.';
// A card that went in and that the game never took up (its STATE stayed at the attract screen's) is not "in the game"
// after this long: Change horse is then not refused for it.
const CARD_IDLE_MS = 30000;
// The old card's last look (the board's answer) and its queue's drain before a change: one post and its timeout.
const SWAP_LOOK_MS = 12000;
const SWAP_DRAIN_MS = SAVE_REQUEST_MS + POST_MS;
// The board's answer to a card-swap.
const SWAP_BOARD_MS = 10000;
// A seat ticket is not used this close to its end (the room server's clock decides).
const TICKET_MARGIN_MS = 5000;

const q = new URLSearchParams(roomSeat ? '' : location.search);
const num = (k, d) => (q.has(k) ? Number(q.get(k)) : d);
const input = document.getElementById('rom-input');
const msg = document.getElementById('msg');
const statusEl = document.getElementById('status');
const leaveBtn = document.getElementById('leave');
const forgetBtn = document.getElementById('forget');
// "Change horse" (the header, and so the phone's Menu sheet): shown once the board runs, on a page that has the chooser.
const changeBtn = document.getElementById('change-horse');
// Page errors, counted for the seat report (text clipped, printable only).
const pageErrors = { count: 0, last: null };
// THE PAGE'S OWN LOG (room-seat-report.js; docs/problem-reports.md): its last lines, each with its time, kept in the
// page and bounded (80 of the page's own, 20 of the board's). Shown nowhere and sent nowhere, unless the player
// presses "Report a problem" and then Send. Every line is scrubbed as it is kept (no address, no token, no query).
const seatLog = createSeatLog({ max: 80 });
const boardLog = createSeatLog({ max: 20 });
const notePageError = (t) => { pageErrors.count++; pageErrors.last = reportText(String(t)); seatLog.add('error', t); };
if (seatInputFault) notePageError(seatInputFault);
if (typeof window.addEventListener === 'function') {
  window.addEventListener('error', (e) => notePageError(e && e.message ? e.message : 'error'));
  window.addEventListener('unhandledrejection', (e) => notePageError(e && e.reason && e.reason.message ? e.reason.message : 'unhandled rejection'));
}
const autoLeave = (() => { const a = parseAutoLeave(q); return a ? createAutoLeave(a) : null; })();
// The room seat keeps the player's game files in this browser (batch 1): picked once, used again next time. The lab: cachegame=1.
const cache = roomSeat || q.get('cachegame') === '1' ? createGameCache() : null;
// KNOWN-GOOD GAME FILES (game-check.js, docs/game-file-check.md): the files a seat is given are checked against the pin
// table before they are used or cached, and the board checks again what it is handed. A room seat always checks (its
// address carries no switches: q is empty). LAB ONLY: gamepin=off, for a lab run with files changed on purpose.
const gameCheck = gameCheckWanted({ roomSeat, param: q.get('gamepin') });
const CHECKING_TEXT = 'Checking the game files.';
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
// THE CARE EVENTS (care-recorder.js; docs/care-events.md under host/): what the player chose in feeding, training and
// the reply after a race, as this seat's own board saw it. Kept here (bounded), shown nowhere, for inspection only:
// window.seat.care(). Every address behind them is unconfirmed in a browser seat (the view says so).
const careLog = createCareLog();
// THE SENDER SEAM, OFF. Care events would be posted to the lobby with the lease from here, once the lobby has a route
// (it has none; the doc proposes the shape). Until then: enabled false and no send function, so nothing leaves the page.
const CARE_SEND = false;
const careOutbox = createCareOutbox({ enabled: CARE_SEND, send: null });
window.seat.care = () => careLog.view();
// Whether the seat's buttons are held off right now (the warm join, a new horse being saved, the pad's arrange mode): a
// yes or no for the page's own tests and the lab, nothing else.
window.seat.inputHeld = () => (seatInput ? seatInput.held() : null);
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
// A NEW HORSE: the checkout handed out no card (set with the save queue; the board then boots with no card in its
// reader and watches for the game's first write). False for every seat with a card.
let newCard = false;
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
// THIS VISIT'S LEASES (room-lease-session.js). One seat visit runs its leases in sequence, one at a time: the
// hand-off's first, then one more for each horse change. `session` is the lease the seat holds NOW (its view of the
// hand-off, its lease client, its save queue); the `lease` and `saveQueue` the rest of this page reads are always
// that session's. A visit with no change has one session, made from the hand-off as it is: nothing differs.
const sessions = createLeaseSessions({ onNote: (t) => notePageError(t) });
let session = null;
// A horse change in progress (changeTo): { old, session, step, oldEnd, newEnd }, else null.
let swapRun = null;
// The card generation last given to the board (lb-board-worker.js card-swap): 0 is the card it booted with.
let cardGen = 0;
// The board's answer to a card-swap (boardCardSwap).
let swapWait = null;
// The card generation the board has CONFIRMED (cardGen runs one ahead while a card-swap is on its way to the board).
let boardGen = 0;
// The horse chooser's panel (room-seat-chooser.js) and the calls a change makes (room-seat-net.js); made further
// down, where the page is set up. null: this page cannot change horses (the lab seat, or a page without the panel).
let chooser = null;
let seatCalls = null;
// The chooser is being asked for (the lobby's list is on its way): one ask at a time.
let chooserAsking = false;
// THE CARD READER as the page knows it (the board's card-in and card-out, lb-board-worker.js readerEvents). in: the card
// is in the game (the insert button went down with a card in the reader, or the game wrote a card, and the game has
// not ejected it since). empty: the page took the card out of the reader after the game's own eject, until the
// member chooses (cardCameOut). outs: ejects seen. inAt: when the card went in.
const reader = { in: false, inAt: 0, outs: 0, empty: false };
// The automatic chooser is on its way (cardCameOut): one at a time.
let cardOutBusy = false;
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
  if (m.type === 'open') { linkOpen = true; if (bugWait) bugWait(true); if (!settings) msg.textContent = filesAskUp() ? FILES_HELD_TEXT : 'Connected. You take your seat between races and can enter the race after that. This can take a couple of minutes.'; return; } // the room ends signalling (bye) once it has taken the seat
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
  if (m.type === 'taken') { stationMine = true; if (m.info && typeof m.info.resume === 'string') resumeInfo = { key: m.info.resume, ms: Number(m.info.resumeMs) || 0 }; if (state.warm) { state.warm = false; if (seatInput) seatInput.unholdWhenIdle('warm'); msg.textContent = settings ? (newHorseWaiting() ? `Seat ${settings.slot}. ${NEW_HORSE_START_TEXT}` : `Seat ${settings.slot}. You can enter the next race.`) : msg.textContent; } return; }
  if (m.type === 'card-ack') { state.cardAcks.push(m.verdict); return; }
  // The room is restarting (room-closing.js ROOM_RESTART_REASON): said at once, saved, and back to the lobby.
  if (m.type === 'eject' && m.reason === ROOM_RESTART_REASON) { roomRestarting(); return; }
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
  if (state.restarting) return false; // the room said it is restarting: there is no way back to this room
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
// One lease client per session (openSession), each with its own answers: a reply or an end of a lease the seat no
// longer holds never reaches the page's logic. `lease` is the CURRENT session's client, whichever that is: every
// call goes to session.lease, so the page's end paths, saves and closes always act on the lease held now.
function openSession(view, name, gen) {
  const s = sessions.add({ view, lease: null, name, gen });
  s.lease = createSeatLease({ handoff: view, onReply: (b) => leaseReply(b, s), onEnd: (i) => leaseEnded(i, s), onTrouble: (on) => { if (s === session) state.leaseTrouble = on; } });
  return s;
}
if (handoff) session = openSession(handoff, handoff.horse_name, 0);
const lease = handoff ? {
  start: () => session.lease.start(), stop: () => session.lease.stop(), close: () => session.lease.close(),
  checkout: (o) => session.lease.checkout(o), beatNow: () => session.lease.beatNow(), timeLeft: () => session.lease.timeLeft(),
  facts: () => session.lease.facts(), closing: () => session.lease.closing(), state: () => session.lease.state(), trouble: () => session.lease.trouble(),
  get stats() { return session.lease.stats; },
} : null;
if (lease) window.seat.lease = { state: lease.state, get stats() { return lease.stats; } }; // no nonce on window
if (intake && intake.go) {
  state.phase = 'refused';
  state.refused = `no hand-off (${intake.status})`;
  msg.textContent = BACK.going;
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

// THE GAME FILES PANEL (the first visit of 2026-11-24: a member's first seat on a new address had no game files in
// the browser, nothing said so, and the room ended the seat 90 s later). Shown when the cache has nothing usable and
// nothing was picked: a heading, what to choose, the file names this release needs, one large button (its own file
// input, the same handler as the header's), and the pick's own messages. It sits where the waiting card sits and
// blocks nothing else. state.filesAsk: { up, at }; state.filesEnd: the seat ended with no files chosen ({ at, by }).
function filesAskUp() { return !!(state.filesAsk && state.filesAsk.up); }
// The pick's messages: the status line, and the panel while it is up. After a seat that ended with no files, the
// status line keeps the end's own words and its way back, and the panel alone speaks.
function filesSay(t) {
  if (!state.filesEnd) msg.textContent = t;
  if (filesUiOk && (filesAskUp() || state.filesEnd)) filesUi.status.textContent = t;
}
function filesAskShow(why = null) {
  if (!filesUiOk || !handoff || files || picking || state.roomEnd) return;
  if (filesAskUp()) { if (why) filesUi.status.textContent = why; return; }
  state.filesAsk = { up: true, at: Date.now() };
  const set = labGameSet(releaseEdition(handoff.release));
  const label = handoff.release === 'revc' ? 'Rev C' : handoff.release === 'doc99' ? "DOC '99" : '';
  if (filesUi.text && label && label !== 'Rev C') filesUi.text.textContent = `This game runs from your own copy. Choose your ${label} game file and BIOS file (two .zip files; select both together). They stay in this browser, so you only do this once on each device.`;
  if (filesUi.names && set) { filesUi.names.textContent = `The two files: ${set.game} (the game) and naomi.zip (the BIOS).`; filesUi.names.hidden = false; }
  filesUi.status.textContent = why || '';
  filesUi.box.hidden = false;
  msg.textContent = FILES_HELD_TEXT;
  if (filesTimer === null) filesTimer = setTimeout(filesTimeout, FILES_HOLD_MS);
  // The player game's own copy on this origin, if it has both files: offered first, read only (mp-game-cache.js).
  if (set && filesUi.own && typeof filesUi.own.addEventListener === 'function') {
    playerGameFiles([set.game, 'naomi.zip']).then((got) => {
      if (!got || !filesAskUp() || files || picking) return;
      filesUi.own.hidden = false;
      filesUi.own.addEventListener('click', () => { if (!picking) onFilesPicked({ picked: got }); });
    }, () => {});
  }
}
function filesAskDone() {
  if (filesTimer !== null) { clearTimeout(filesTimer); filesTimer = null; }
  if (!filesAskUp()) return;
  state.filesAsk.up = false;
  if (filesUiOk) { filesUi.status.textContent = FILES_READY_TEXT; filesUi.box.hidden = true; }
  msg.textContent = FILES_READY_TEXT;
}
// Any other end takes the panel away (its own words stand); the end for no files keeps it, to choose for next time.
function filesAskEnd() {
  if (filesTimer !== null) { clearTimeout(filesTimer); filesTimer = null; }
  if (!filesUiOk || !state.filesAsk) return;
  if (!state.filesEnd) { state.filesAsk.up = false; filesUi.box.hidden = true; return; }
  state.filesAsk.up = false;
  if (filesUi.title) filesUi.title.textContent = 'Your seat was given back';
  if (filesUi.text) filesUi.text.textContent = `${FILES_END_TEXT} ${cache ? FILES_END_PICK_TEXT : ''}`.trim();
  if (filesUi.held) filesUi.held.hidden = true;
  if (!cache && filesUi.pick) filesUi.pick.hidden = true;
  if (!cache && filesUi.own) filesUi.own.hidden = true;
  filesUi.status.textContent = '';
  if (filesUi.back) { filesUi.back.href = handoff.return_path; filesUi.back.textContent = BACK.link; filesUi.back.hidden = false; }
}
// The hold ran out with nothing chosen: the seat's own Leave path, with these words (the lease closed, the place given back).
function filesTimeout() {
  filesTimer = null;
  if (state.roomEnd || files || !filesAskUp()) return;
  if (picking) { filesTimer = setTimeout(filesTimeout, 15000); return; } // a pick is being read and checked: let it finish
  state.filesEnd = { at: Date.now(), by: 'time' };
  endRoomSeat('left', FILES_END_TEXT, 0);
}
let filesEdition = null;
// Rev C Rebalanced: the game file rebuilt in page memory once (maybeStart).
let rebuilding = false;
let rebuilt = false;
async function onFilesPicked(ev = null) {
  if (netemParsed.error) return; // the seat refused; keep its message
  // A seat that ended with no files chosen still takes a pick, for the next join only: checked and kept, never run.
  const late = !!(state.roomEnd && state.filesEnd && cache);
  if (state.roomEnd && !late) return; // the room seat has ended: no board after that
  // The header's input, the panel's own, or files handed in (the player game's copy in this browser).
  const src = ev && ev.target && ev.target.files ? ev.target : input;
  const picked = ev && Array.isArray(ev.picked) ? ev.picked : Array.from(src.files || []);
  // The room seat picks the files of its hand-off's release (Rev C: A's
  // drbyocwc.zip; DOC '99: J99's derbyoc.zip); its ticket's edition must
  // agree (maybeStart). The lab seat: the seat ticket's edition (the room's
  // link tag), or the picked game file's own; a mismatch is refused, never
  // run as 'A'.
  const set = handoff ? pickLabGameSet(picked.map((f) => f.name), releaseEdition(handoff.release)) : pageGameSet(picked.map((f) => f.name), ticketEdition);
  const game = set.game && picked.find((f) => f.name.toLowerCase() === set.game);
  const bios = picked.find((f) => f.name.toLowerCase() === 'naomi.zip');
  if (set.error || !game || !bios) { filesSay(set.error || 'Need naomi.zip.'); return; }
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
    const got = [['naomi.zip', b], [set.game, g]];
    if (gameCheck) {
      // Refused files are never used and never cached; the player may pick again (nothing has started).
      const before = msg.textContent;
      filesSay(CHECKING_TEXT);
      const r = await checkGameFiles({ edition: set.edition, files: got });
      if (state.roomEnd && !(late && state.filesEnd)) return; // the seat ended meanwhile: keep its notice
      if (!r.ok) { state.gameRefused = { which: r.which, why: r.why }; filesSay(gameRefusalText(r)); return; }
      state.gameRefused = null;
      state.gameChecked = { edition: set.edition, weak: r.weak.length };
      if (msg.textContent === CHECKING_TEXT) msg.textContent = before;
      if (filesUiOk && filesUi.status.textContent === CHECKING_TEXT) filesUi.status.textContent = '';
    }
    if (state.roomEnd) {
      // The seat ended with no files (or ended while these were read): kept for the next join, never run here.
      if (!state.filesEnd || !cache) return;
      try { await cache.store(got, set.edition); filesSay(FILES_LATE_TEXT); if (filesUi && filesUi.pick) filesUi.pick.hidden = true; if (filesUi && filesUi.own) filesUi.own.hidden = true; } catch (err) { filesSay(`Game files not kept (${reportText(String(err && err.message ? err.message : err), 80)}).`); }
      return;
    }
    files = got;
    fileSource = 'picked';
    filesEdition = set.edition;
  } catch {
    filesSay('The game files could not be read; pick them again.');
    return;
  } finally {
    picking = false;
  }
  if (cache) {
    // Kept in this browser profile only; a failure does not stop the seat.
    cache.store(files.map(([n, b]) => [n, b.slice(0)]), filesEdition).then(() => { forgetBtn.hidden = false; }, (err) => { msg.textContent = `Game files not cached (${reportText(String(err && err.message ? err.message : err), 80)}).`; });
  }
  filesAskDone();
  maybeStart();
}
input.addEventListener('change', onFilesPicked);
if (filesUiOk && typeof filesUi.chooser.addEventListener === 'function') filesUi.chooser.addEventListener('change', onFilesPicked);
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
      const use = () => { files = r.files; fileSource = 'cached'; filesEdition = cacheEdition; msg.textContent = 'Using the game files cached in this browser.'; maybeStart(); };
      if (files || picking) return;
      if (!gameCheck) { use(); return; }
      // The cached copy passes the same check as a picked one; a refused copy is forgotten, and the player picks again.
      checkGameFiles({ edition: cacheEdition, files: r.files }).then((c) => {
        if (state.roomEnd || files || picking) return; // an end, or a pick, won meanwhile
        if (!c.ok) {
          state.gameRefused = { which: c.which, why: c.why };
          cache.forget().then(() => {}, () => {});
          forgetBtn.hidden = true;
          msg.textContent = `${gameRefusalText(c)} Pick the game files again.`;
          filesAskShow(`${gameRefusalText(c)} Choose the game files again.`);
          return;
        }
        state.gameChecked = { edition: cacheEdition, weak: c.weak.length };
        use();
      });
    } else if (r.reason !== 'none') {
      forgetBtn.hidden = false;
      if (files || picking) return; // a pick already won; nothing to ask for
      msg.textContent = `Cached game files not used (${r.reason}); pick them again.`;
      filesAskShow('The copy kept in this browser could not be used. Choose the game files again.');
    } else filesAskShow(); // nothing kept in this browser yet: the first visit on this device
  }, () => { filesAskShow(); });
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

// The page's sound: the ring the board's audio goes into, played by this page, and the main cabinet's sound beside it
// (room-seat-audio.js). On by default, with the header's mute buttons and levels. Made ONCE, when the page is set up:
// the context, the worklet and the main channel are there through the whole wait, and the board's start only takes
// the ring (no new context, nothing the main sound could click on). Made without waiting for anything, so the board
// starts as before; a page that cannot play sound runs the seat silent, as it always did. The browser plays nothing
// until the player has touched the page: until then the large prompt over the main screen (#sound-ask) says so, and
// it comes back whenever the browser takes the sound away. Returns the board's msg.audio, or null.
function startSeatAudio() {
  if (seatAudio) return seatAudio.source;
  try {
    const ask = document.getElementById('sound-ask');
    const mainEl = document.getElementById('main-audio');
    const btn = document.getElementById('sound');
    const lvl = document.getElementById('sound-level');
    const mbtn = document.getElementById('main-sound');
    const mlvl = document.getElementById('main-level');
    const paint = (a) => {
      state.audio = { context: a.context, built: a.built, muted: a.muted, level: a.level, fault: a.fault };
      // The prompt: over the main screen whenever the browser is holding sound the player has not muted.
      if (ask) { const p = soundPromptView(a); if (ask.hidden !== !p.shown) ask.hidden = !p.shown; }
      if (!btn) return;
      const v = soundButtonView(a);
      btn.textContent = v.text; btn.title = v.title; btn.disabled = v.disabled;
      if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-pressed', String(v.pressed));
      if (btn.classList) btn.classList.toggle('attn', v.attn);
      if (lvl) { lvl.disabled = v.disabled; if (document.activeElement !== lvl) lvl.value = String(Math.round(a.level * 100)); }
      // The second channel: the main cabinet's sound, on the page only once the room's sound has arrived.
      const mv = mainButtonView(a);
      if (mbtn) {
        mbtn.hidden = !mv.shown; mbtn.textContent = mv.text; mbtn.title = mv.title; mbtn.disabled = mv.disabled;
        if (typeof mbtn.setAttribute === 'function') mbtn.setAttribute('aria-pressed', String(mv.pressed));
        if (mbtn.classList) mbtn.classList.toggle('attn', mv.attn);
      }
      if (mlvl) {
        mlvl.hidden = !mv.shown; mlvl.disabled = mv.disabled || mv.levelFixed;
        // A browser that keeps the level to itself (an iPhone): the slider says where the level is.
        mlvl.title = mv.levelFixed ? 'On this device the main screen sound follows the volume buttons' : 'Main screen sound volume';
        if (document.activeElement !== mlvl && a.main) mlvl.value = String(Math.round(a.main.level * 100));
      }
    };
    // The main cabinet's sound plays through its own audio element (#main-audio) when the page has one: see
    // room-seat-audio.js for why, and for the other way (through the context) that is kept for a page without it.
    seatAudio = createSeatAudio({ win: window, onNote: (t) => notePageError(t), onState: paint, mainEl: mainEl && typeof mainEl.play === 'function' ? mainEl : null });
    // What the sound is doing and what happened to it (context states, touches that asked, the main sound's way and
    // state): read this on a phone that has no sound. mainPath('element' | 'graph' | 'auto') switches the main
    // sound's way for a test.
    window.seat.audio = () => (seatAudio ? seatAudio.state() : null);
    window.seat.mainPath = (p) => { if (seatAudio) seatAudio.setMainPath(p); return seatAudio ? seatAudio.state().main : null; };
    if (ask && typeof ask.addEventListener === 'function') ask.addEventListener('click', () => { if (seatAudio) seatAudio.unlock(); if (typeof ask.blur === 'function') ask.blur(); });
    if (btn) { btn.hidden = false; if (typeof btn.addEventListener === 'function') btn.addEventListener('click', () => { if (seatAudio) seatAudio.press(); if (typeof btn.blur === 'function') btn.blur(); }); }
    if (lvl && typeof lvl.addEventListener === 'function') {
      lvl.hidden = false;
      lvl.addEventListener('input', () => { if (seatAudio) seatAudio.setLevel(Number(lvl.value) / 100); });
      // The arrow keys are the game's: the slider never keeps the focus.
      lvl.addEventListener('change', () => { if (typeof lvl.blur === 'function') lvl.blur(); });
    }
    if (mbtn && typeof mbtn.addEventListener === 'function') mbtn.addEventListener('click', () => { if (seatAudio) seatAudio.pressMain(); if (typeof mbtn.blur === 'function') mbtn.blur(); });
    if (mlvl && typeof mlvl.addEventListener === 'function') {
      mlvl.addEventListener('input', () => { if (seatAudio) seatAudio.setMainLevel(Number(mlvl.value) / 100); });
      mlvl.addEventListener('change', () => { if (typeof mlvl.blur === 'function') mlvl.blur(); });
    }
    if (mainSound) seatAudio.setMain(mainSound);
    paint(seatAudio.state());
    seatAudio.start();
    return seatAudio.source;
  } catch (err) {
    notePageError(`sound not started (${String(err && err.message ? err.message : err).slice(0, 60)})`);
    return null;
  }
}

function maybeStart() {
  // The room seat (review P1-a): only once the card is checked out and its
  // save queue exists, whatever the welcome's card flag (production sends
  // card: false). The lab: the room's card when its welcome says so.
  // A NEW HORSE has no card to wait for (newCard, set with its save queue).
  if (started || state.roomEnd || !files || !settings || (handoff ? (!saveQueue || (!card && !newCard)) : (settings.card && !card))) return;
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
      case 'sample': st.samples.push({ f: m.f, status: m.status }); if (st.samples.length > 2000) st.samples.shift(); if (state.phase === 'linking' && parseInt(m.status.comm2 || '0', 16) >> 8 === settings.seats) { state.phase = 'seated'; if (!state.warm) stationMine = true; board.postMessage({ type: 'card-base' }); } break;
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
        if (handoff) { roomCardWrite(m.gen, m.bytes); break; }
        link.postMessage({ type: 'card-write', seq: writeSeq, bytes: m.bytes }, [m.bytes]);
        break;
      }
      case 'card-final': if (finalWait) { const r = finalWait; finalWait = null; r(m); } break;
      case 'card-base': state.cardBase = m.base; break; // the board's eject baseline (lab view)
      case 'card-eject': if (ejectWait) { const r = ejectWait; ejectWait = null; r(m); } break;
      case 'card-swap': if (m.ok === true && Number.isSafeInteger(m.gen)) boardGen = m.gen; if (swapWait) { const r = swapWait; swapWait = null; r(m); } break; // the card in the reader was changed (boardCardSwap)
      // The card reader's own events (room seat only): the insert button, and the game's own eject.
      // (An insert press the board saw just before it acted on a card-swap still names the generation it had.)
      case 'card-in': if (((m.gen ?? 0) === cardGen || (swapWait && (m.gen ?? 0) === boardGen)) && state.hasCard && !reader.empty) { reader.in = true; reader.inAt = Date.now(); cardNowIn(); } break;
      case 'card-out':
        if ((m.gen ?? 0) !== cardGen) break;
        if (reader.in) {
          reader.in = false;
          // (A "still in the game" line is no longer true.)
          if (!state.roomEnd && msg.textContent === SWAP_TEXT.cardIn(horseNow())) msg.textContent = CARD_OUT_TEXT(horseNow());
          cardCameOut(cardGen);
        }
        reader.outs++;
        state.cardOut = { at: Date.now(), gen: cardGen, n: reader.outs };
        break;
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
      // The board refused the files it was handed (game-check.js: they are not the ones the page checked, or the
      // page's check was skipped). The board never started. The cached copy is forgotten, so it is not used again.
      case 'game-refused': {
        const note = `game refused (${reportText(String(m.which), 8)} ${reportText(String(m.why), 12)})`;
        const text = gameRefusalText({ ok: false, which: m.which, why: m.why, name: typeof m.name === 'string' ? m.name.slice(0, 24) : null });
        st.errors.push(note);
        if (cache) cache.forget().then(() => {}, () => {});
        if (handoff) { boardDead = true; endRoomSeat('bug', text, 0, note); } else { state.phase = 'refused'; state.refused = 'game files'; msg.textContent = text; }
        break;
      }
      case 'care': careLog.add(m.events, m.stats); careOutbox.offer(m.events); break;
      case 'log': st.logs.push(m.text); if (st.logs.length > 200) st.logs.shift(); boardLog.add('board', m.text); break;
      default: break;
    }
  };
  const fileCopies = files.map(([name, bytes]) => [name, bytes.slice(0)]);
  const audio = startSeatAudio();
  if (seatAudio) seatAudio.mark('board started');
  board.postMessage({
    type: 'init', label: `board${s.slot}`, index: 0, boardId: 0, seat: s.slot, n: s.n, actAsServer: false, multiboardSlaves: 1,
    edition: s.edition, sessionTag: s.sessionTag, mailbox, cabinet: null, canvas, files: fileCopies, game: s.game,
    frames: 100000000, hashEvery: num('every', 300), pinTime: s.pinTime, jitDet: 1, preserve: true, bank: 'snapshot', dynarec: 1, barrierTimeoutMs: 10000,
    ctl, frameCounts, hubStatus, autoStart: true, realtimeHz: 0, presses, yieldEvery: 1, verbose: !roomSeat && q.get('verbose') === '1', // LAB ONLY: the core's own log lines
    card: card ? card.slice(0) : null, watchCard: !!card || newCard, netWatch: true, input: seatInput ? seatInput.buffer : null, audio, present: null, hidden: false,
    corePin: ed ? { edition: ed.edition } : null,
    // The board checks its files again: a room seat's always does (corePin names the edition); the lab seat's when its check is on.
    ...(gameCheck && !ed && runEdition ? { gamePin: { edition: runEdition } } : {}),
    // The care recorder: this player's own board reads a few words a frame (Rev C only; care-recorder.js).
    careWatch: true,
    // A NEW HORSE: no card in the reader; the board watches for the card the game writes (lb-board-worker.js).
    ...(newCard ? { newCard: true } : {}),
    // The room seat hears the card reader's own events (card-in, card-out): the horse change's eject signal.
    ...(handoff ? { readerEvents: true } : {}),
  }, [canvas, ...fileCopies.map(([, a]) => a)]);
  if (handoff) bootTimer = setTimeout(() => { bootTimer = null; if (!st.ready && !state.roomEnd) { boardDead = true; endRoomSeat('bug', END_TEXT.boot, 0, 'board boot timeout'); } }, BOOT_LIMIT_MS);
  // The checked-out card lives only in the board's memory file system now.
  card = null;
  leaveBtn.disabled = false;
  if (chooser && changeBtn) changeBtn.hidden = false; // Change horse, from here on (it says so itself while the seat is not seated yet)
  msg.textContent = newCard ? `Seat ${s.slot} in room ${s.room}. ${NEW_HORSE_START_TEXT}` : `Seat ${s.slot} in room ${s.room}.`;
}

// ONE CARD WRITE of the room seat's board. It joins the queue of ITS card's generation (room-lease-session.js): the
// lease the seat holds now; or, for a card of a lease that has ended (a late write after a horse change), that
// lease's own stopped queue, which only puts it in the stash under the old lease (never posted here, never under
// another lease); or nothing, when no lease owns that reader or no queue exists yet (noted there).
function roomCardWrite(gen, bytes) {
  const w = sessions.write(gen, bytes);
  if (!w.session) { if (w.loose) state.looseWrites = (state.looseWrites || 0) + 1; return; }
  if (w.late) { state.lateWrites = (state.lateWrites || 0) + 1; return; }
  lastQueuedSeq = w.seq;
  // A card the game writes is a card in the game (a new horse has no insert press to say so).
  if (!reader.in) { reader.in = true; reader.inAt = Date.now(); }
  cardNowIn();
  if (newHorseWaiting()) newHorseWrote();
  // The first write after a no change card look (the board's eject finishing late): the card's state after the miss.
  if (cardLook && cardLook.wrote === null && cardLook.after === null) cardLook.after = lastQueuedSeq;
}

// The card is in the game (the insert button, or the game wrote it): "[name] is in your hand. Press Insert card to
// put it in." is no longer true, and is taken down at once (the seat test of 2026-11-24: it stayed up through the
// whole race). The page's 1 s tick looks again, so the line is never up while the card is in.
function cardNowIn() {
  if (reader.in && !state.roomEnd && isHandLine(msg.textContent)) msg.textContent = SWAP_TEXT.cardNowIn(horseNow());
  paintStationLine();
}
// The line while the card is in the game says what is true now (room-seat-swap.js stationLine: the card in, a race
// running, the race over). It replaces only the seat's own lines (the one put up when the station became the
// seat's, the "in your hand" line, and the last one written here), never a notice, a refusal or a horse change's words.
let lineWritten = null; // the last line paintStationLine wrote
let raceWas = { on: false, entered: false, overAt: null }; // the board's race flag as last seen, and when this seat's own race ended
function paintStationLine() {
  if (!handoff || state.roomEnd || state.phase !== 'seated' || state.warm || !state.hasCard || reader.empty) return;
  const c = state.board.counts;
  const on = !!c.raceOn;
  if (raceWas.on && !on) raceWas.overAt = raceWas.entered ? Date.now() : null;
  if (on) raceWas.overAt = null;
  raceWas.on = on; if (on) raceWas.entered = !!c.entered;
  const cur = msg.textContent;
  if (cur !== lineWritten && !isSeatStartLine(cur) && cur !== SWAP_TEXT.cardNowIn(horseNow())) return;
  const line = stationLine({ name: horseNow(), cardIn: reader.in, raceOn: on, entered: raceWas.entered, overMs: raceWas.overAt === null ? null : Date.now() - raceWas.overAt });
  if (line === null || line === cur) return;
  msg.textContent = line;
  lineWritten = line;
}

function stopBoard() {
  // An eject save still waiting for the board ends now (the board is gone).
  if (ejectWait) { const r = ejectWait; ejectWait = null; r({ out: false, pressed: 1 }); }
  if (seatInput) { seatInput.input.releaseAll(); }
  if (seatAudio) { seatAudio.close(); }
  if (wakeLock) { wakeLock.stop(); }
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
  const owed = sessions.unstashed() > 0; // every lease of the visit: a write of any of them not kept would be lost
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
function leaseReply(body, s) {
  // A reply of a lease the seat no longer holds (an answer in flight when the horse was changed) is nobody's.
  if (s && s !== session) return null;
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
  // The other horse, with a race owed or no answer yet: each beat that answers looks again (otherHorseDecide).
  if (handoff && lease && state.otherHorse) otherHorseDecide();
  return next;
}
// Batch 1: the room seat says so when its room is closing or this is its last race (the same reply the room server
// acts on), so the end is never a surprise. Plain words, no codes; the time is the player's own clock.
const noticeEl = roomSeat ? document.getElementById('notice') : null;
function showClosingNotice(c) {
  if (!noticeEl || state.roomEnd) return;
  const text = BACK.say(closingNoticeText(c));
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
// THE PLACE AT THE ROOM SERVER is given back on every end, once (the third case of 2026-11-24: a Leave while still
// "waiting for the race in progress" left the reservation holding the seat for ten minutes, and the member's next
// join was refused). Only while the station was never this seat's (stationMine): once it was, the room itself sees
// the seat go and the place is not a reservation any more. Keepalive, no token (room-seat-net.js).
function leavePlace() {
  if (placeLeft || !handoff || stationMine) return;
  placeLeft = true;
  giveBackRefusedSeat({ roomServerUrl: handoff.room_server_url, reservation: handoff.reservation, roomToken: null, leaseId: null });
}
// A tab closed or sent elsewhere while the seat waits takes the same way.
if (roomSeat && handoff) window.addEventListener('pagehide', leavePlace);
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
  leavePlace(); // at once: the drain below can take a while, and a place that is not seated must not wait for it
  if (!handoff || state.roomEnd) return;
  state.roomEnd = { why, at: Date.now(), back: null };
  // The horse chooser does not outlive the seat (a change in progress closes it itself when it sees the end).
  if (chooser && chooser.isOpen() && !swapRun) chooser.close();
  const saving = !!(lease && lease.state() === 'beating' && saveQueue && ((board && !boardDead) || saveQueue.state().pending > 0));
  if (saving) lease.beatNow().catch(() => null);
  else if (lease) lease.stop(); // nothing to save: the beat never outlives the seat
  input.disabled = true; // no game files after the end (the files panel's own input still takes a pick for next time: filesAskEnd)
  filesAskEnd();
  // Every end leaves the lobby a line for the way back (room-closing.js markSeatEndNote); the restart has its own.
  if (why !== 'restart') state.roomEnd.note = markSeatEndNote(state.filesEnd ? 'files' : why);
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
  if (allOwed() > 0) { showHeld(); return; }
  // A missed eject: its later write landed (in the drain): saved, said so (ruled); else the staff text. Never a way back on its own.
  if (ejectMissed) { msg.textContent = missedText(); showWayBack(handoff.return_path); return; }
  if (text) msg.textContent = text;
  // No game files were chosen: the page stays, with its words, the panel (to choose them for next time) and the way back.
  if (state.filesEnd) { showWayBack(handoff.return_path); return; }
  // A seat bug stays; so does the other horse's end (its notice says where to go, and is not gone in a moment), and
  // a horse change that could not be finished ('swap': its words say what happened and what to do).
  if (why === 'bug' || why === 'other_horse' || why === 'swap') { showWayBack(handoff.return_path); return; }
  state.roomEnd.back = handoff.return_path;
  // Not before the board has ended (a queued card write is held instead).
  const wait = Math.max(0, state.roomEnd.at + delayMs - Date.now(), boardEndsAt ? boardEndsAt + BACK_AFTER_BOARD_MS - Date.now() : 0);
  backTimer = setTimeout(() => { backTimer = null; if (allOwed() === 0) location.replace(handoff.return_path); }, wait);
}
// THE ROOM RESTART (the pilot, 2026-11-24; room-closing.js has the whole of it). The room said it is restarting,
// before its hub stops: the words go up at once, in the status line and as a notice over the game that needs no
// press, and the seat ends by its ordinary end path (endRoomSeat: one fresh beat, the card made safe, the save queue
// drained on the live lease, the board stopped last), then goes back to return_path. The seat closes NO lease here
// (closeHook closes only on the member's own Leave): the room marked this seat as ended by the room, and the room
// server closes the lease with no fault. The note for the lobby is set first, so it is there however the page goes.
const RESTART_BACK_MS = 6000;
let restartNotice = null;
function roomRestarting() {
  if (state.restarting) return;
  state.restarting = { at: Date.now(), note: false };
  if (state.roomEnd) return; // the seat is ending by itself already: its own words stand
  msg.textContent = ROOM_RESTART_TEXT;
  try {
    if (!restartNotice && typeof document.createElement === 'function') {
      const d = document.createElement('div');
      d.id = 'room-restart-notice';
      d.setAttribute('role', 'alert');
      d.textContent = ROOM_RESTART_TEXT;
      d.style.cssText = 'position:fixed;left:50%;top:38%;transform:translate(-50%,-50%);z-index:2147483000;box-sizing:border-box;width:max-content;max-width:min(92vw,34rem);padding:1.1rem 1.3rem;border-radius:.6rem;background:rgba(12,16,24,.94);color:#fff;font:600 1.15rem/1.4 system-ui,sans-serif;text-align:center;box-shadow:0 .4rem 2rem rgba(0,0,0,.6);pointer-events:none';
      (document.fullscreenElement || document.body).append(d);
      restartNotice = d;
    }
  } catch { /* the status line says it */ }
  if (!handoff) return; // the lab seat only says it
  state.restarting.note = markRoomRestartNote();
  endRoomSeat('restart', ROOM_RESTART_TEXT, RESTART_BACK_MS);
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
  // THE 90 SECONDS (2026-11-24): the room ends a linked seat whose board has sent no frame in its first-frame time
  // (mp-room-link-worker.js firstFrameMs, 90 s). With the files panel up that is a seat with no game files: said so.
  // A link that FAILED early (the network) keeps its own words; one gone after FILES_ROOM_MS of waiting is that limit too.
  if (why !== 'left' && filesAskUp() && !files && (why === 'dropped' || Date.now() - state.filesAsk.at >= FILES_ROOM_MS)) { state.filesEnd = { at: Date.now(), by: 'room' }; endRoomSeat(why, FILES_END_TEXT, RETURN_NOTICE_MS); return; }
  endRoomSeat(why, why === 'lost' ? END_TEXT.linkLost : END_TEXT[why], why === 'left' ? 0 : RETURN_NOTICE_MS);
}
// 1d commit 5: the writes not landed yet (queued or held).
function savesOwed() {
  if (!saveQueue) return 0;
  const q = saveQueue.state();
  return q.pending + q.held;
}
// ...and with the writes of the visit's EARLIER leases that never landed (a late write after a horse change: held in
// the stash under its own, ended lease). They keep nothing open; they are only told at the end, as kept (showHeld).
function allOwed() { return savesOwed() + sessions.oldOwed(); }
// The seat dropped with a write owed: the way back waits (a pending replace
// is cancelled, so the page never prompts on its own navigation) and the
// member is told whether the stash keeps it.
function showHeld() {
  savesHold = true;
  if (backTimer) { clearTimeout(backTimer); backTimer = null; }
  state.roomEnd.back = null;
  const lost = sessions.unstashed() > 0;
  // THE OTHER HORSE: a held write that is another horse's card is never "saved when you go back", so its own notice
  // stands in for the kept texts, with the link back and no way back on its own. The seat's own end for it
  // (other_horse) shows that notice alone; any other end (a Leave with a race owed, or the write was the last card
  // look's) leads with its own words. A write of this horse's own still held adds its kept (or lost) line.
  if (state.otherHorse && !ejectMissed && (endWhy === 'other_horse' || ownSavesOwed() === 0)) {
    const notice = OTHER_HORSE_TEXT(otherHorseName());
    const lead0 = endWhy === 'other_horse' ? '' : noGoing(endText);
    msg.textContent = [lead0, notice, ownSavesOwed() > 0 ? (lost ? HELD_TEXT : HELD_KEPT_TEXT) : ''].filter(Boolean).join(' ');
    showWayBack(handoff.return_path);
    if (keptTimer !== null) { clearTimeout(keptTimer); keptTimer = null; }
    return;
  }
  // The queue stopped with every write in the stash: nothing more is tried
  // here, so the member is told and goes back after the notice (a seat bug
  // stays; a card that did not come out stays: staff). No stash at all:
  // never a redirect (the lost text and the link).
  // (After a horse change: the lease held now has nothing owed, or its queue has stopped; an earlier lease's queue
  // stopped when its lease was replaced.)
  const goBack = !!(stash && !lost && (saveQueue ? saveQueue.state().stopped || savesOwed() === 0 && sessions.oldOwed() > 0 : sessions.oldOwed() > 0) && endWhy !== 'bug' && endWhy !== 'swap' && !ejectMissed);
  // Not kept: the loss is said on its own. Kept: the end's own notice (not
  // its going back unless the page goes), then that. A card that did not
  // come out (review P3): its own notice first.
  const lead = ejectMissed ? MISSED_TEXT : noGoing(endText);
  // A new horse whose first save was refused for the card itself: it is kept for the staff, and never said to "be saved" later.
  const newRefused = !!(state.newHorse && !state.newHorse.created && state.newHorse.refused);
  msg.textContent = lost ? [ejectMissed ? MISSED_TEXT : '', HELD_TEXT].filter(Boolean).join(' ') : [lead, newRefused ? NEW_HORSE_KEPT_TEXT : goBack ? KEPT_GO_TEXT : HELD_KEPT_TEXT].filter(Boolean).join(' ');
  showWayBack(handoff.return_path);
  // A lost write (review P2-2): no way back on its own.
  if (lost && keptTimer !== null) { clearTimeout(keptTimer); keptTimer = null; }
  // A put that settled kept since the last notice: the notice's full time
  // again (review P3). Re-checked when it fires: still kept, nothing lost.
  const settledKept = heldLoose > 0 && !lost;
  heldLoose = sessions.unstashed();
  if (goBack && settledKept && keptTimer !== null) { clearTimeout(keptTimer); keptTimer = null; }
  if (goBack && keptTimer === null) keptTimer = setTimeout(() => { keptTimer = null; if (stash && sessions.unstashed() === 0) location.replace(handoff.return_path); }, KEPT_NOTICE_MS);
}
// The save queue's every change: the lab view, and the hold after the drop.
function savesChanged(q, s) {
  // The queue of a lease the seat no longer holds (a late write after a horse change, kept in the stash or not):
  // it changes nothing in play; once the seat has dropped, the end's notice says it is kept.
  if (s && s !== session) {
    if (state.roomEnd && state.roomEnd.droppedAt !== undefined && allOwed() > 0) showHeld();
    return;
  }
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
  if (endWhy === 'bug' || endWhy === 'swap' || ejectMissed) return;
  // An earlier lease's write is still kept in the stash: the kept notice and its way back stand (showHeld).
  if (sessions.oldOwed() > 0) { showHeld(); return; }
  state.roomEnd.back = handoff.return_path;
  backTimer = setTimeout(() => { backTimer = null; if (allOwed() === 0) location.replace(handoff.return_path); }, RETURN_NOTICE_MS);
}
// 1d commit 5: the card is checked out once, after the lease's first 2xx
// beat. A missing or malformed member_hash (the stash's key) is a seat bug
// before play: a seat that cannot stash could lose a card.
async function checkOut() {
  const r = await lease.checkout({ canRetry: () => !started });
  if (!r.ok || state.roomEnd) return; // a refusal ended the lease: leaseEnded ends the seat
  // The answer against the hand-off (seat-lease.js readCheckout): a card, or a NEW HORSE (both say new_horse and
  // there is no card), or a refusal.
  const c = readCheckout(r.body, handoff);
  if (!c.ok) { endRoomSeat('bug', END_TEXT.bug, 0, c.why); return; }
  await stashOpen;
  if (state.roomEnd) return;
  saveQueue = makeQueue(session, c);
  if (c.newHorse) {
    // No card to load: the board boots with an empty reader and the game makes the horse.
    state.checkedOut = { lastSeq: c.lastSeq, newHorse: true };
    state.newHorse = { created: false, writes: 0, held: false, refused: null, name: null };
    newCard = true;
    maybeStart();
    return;
  }
  state.checkedOut = { lastSeq: c.lastSeq };
  // The lease's card as it stands (its checkout's, then each write the game makes): kept in this page's memory
  // only, for putting the card back in the reader after the game's own eject (refillReader). Never stored.
  session.card = c.card.slice();
  card = c.card.buffer;
  state.hasCard = true;
  maybeStart();
}
// ONE SAVE QUEUE PER LEASE. Each card generation of the reader belongs to one lease (its card as checked out; and,
// when the member keeps the horse after the game's own eject, the same card put back under a new generation, which
// is the same lease's and joins the same queue). Every post
// of this queue carries s.view's lease id and horse id and reads s's own lease client for its nonce and its time:
// it can never post under another lease. What it tells the page reaches the page's logic only while s is the lease
// the seat holds (the callbacks below; savesChanged).
function makeQueue(s, c) {
  const mine = (fn) => (x) => { if (s === session) fn(x); };
  s.newHorse = c.newHorse === true;
  s.queue = createSaveQueue({
    handoff: s.view, firstSeq: c.lastSeq + 1, stash, memberHash: c.memberHash, edition: releaseEdition(handoff.release),
    nonce: () => s.lease.facts().race_nonce, refreshNonce: () => s.lease.beatNow(), timeLeft: () => s.lease.timeLeft(),
    onChange: (q) => savesChanged(q, s), onNote: (t) => notePageError(t), onOtherHorse: mine(otherHorse),
    // A NEW HORSE only. No cardName seam is passed: this repository holds no card layout to read a name from, so the
    // first save names nothing and the route answers with the card's own name (room-save-queue.js).
    ...(c.newHorse ? { newHorse: true, onCreated: mine(newHorseCreated), onFirstRefused: mine(newHorseRefused) } : {}),
  });
  return s.queue;
}
// The horse the seat holds now, as the page names it: the name the lobby showed for it (the hand-off's, or the
// chooser's after a change), the name its first save was given for a new horse, never an empty name.
function horseNow() { return horseLabel({ horse_name: session ? session.name : '' }, state.newHorse && state.newHorse.name ? state.newHorse.name : null); }
// A NEW HORSE whose first save has not landed yet (false for every seat with a card).
function newHorseWaiting() { return newCard && !!state.newHorse && !state.newHorse.created; }
// The game wrote the new horse's card (its save is in the queue): the buttons are off until it lands, so the horse
// cannot be entered in a race the lobby would refuse.
function newHorseWrote() {
  const n = state.newHorse;
  n.writes++;
  n.refused = null; // a new first save
  if (!n.held) { n.held = true; if (seatInput) seatInput.hold('new-horse', true); }
  // (A queue that has stopped sends nothing: its own paused notice stays.)
  if (!state.roomEnd && !saveQueue.state().stopped) msg.textContent = NEW_HORSE_SAVING_TEXT;
}
// The first save landed: a normal seat from here on.
function newHorseCreated({ name }) {
  const n = state.newHorse;
  if (!n) return;
  n.created = true; n.refused = null; n.name = name || null;
  if (n.name && session) session.name = n.name; // what the chooser's "Keep [name]" says from now on
  state.hasCard = true;
  if (n.held) { n.held = false; if (seatInput) seatInput.unholdWhenIdle('new-horse'); }
  if (!state.roomEnd) msg.textContent = `${n.name ? horseLabel(session.view, n.name) : 'Your new horse'} ${NEW_HORSE_SAVED_TEXT}`;
}
// The first save was refused for the card itself (409 race_count, 422, or another held answer): said plainly; the
// queue holds the write and tries nothing more; the buttons stay off (the horse cannot race), Leave still works.
function newHorseRefused({ status, why }) {
  const n = state.newHorse;
  if (!n || n.created) return;
  n.refused = { status, why };
  notePageError(`new horse save refused (${status} ${why})`);
  if (!state.roomEnd) msg.textContent = NEW_HORSE_REFUSED_TEXT[why] || NEW_HORSE_REFUSED_TEXT.refused;
}
// THE OTHER HORSE (the texts above). The queue tells this once, and only for a horse that has a card (a NEW HORSE's
// first save refused is newHorseRefused's, never this: room-save-queue.js sawHeld), so the two paths never both run.
function otherHorseName() { return horseNow(); }
// The held writes that are this horse's own (not the other horse's card): they keep the lease open for a late save.
function ownSavesOwed() { return saveQueue ? Math.max(0, savesOwed() - saveQueue.heldOther()) : 0; }
function otherHorse({ seq, status }) {
  if (state.otherHorse) return;
  const o = { seq, status, at: Date.now(), owed: null, closed: null, late: !!state.roomEnd, checking: false };
  state.otherHorse = o;
  notePageError(`the card is another horse (${status}, seq ${seq})`);
  // The seat is ending already (the write was its last card look's, or in flight at the drop): the end's own notice
  // says it (showHeld); nothing is closed here.
  if (state.roomEnd) { if (state.roomEnd.droppedAt !== undefined && savesOwed() > 0) showHeld(); return; }
  if (seatInput) seatInput.hold('other-horse', true); // at once: nothing more is played on this lease
  msg.textContent = OTHER_HORSE_CHECK_TEXT(otherHorseName());
  sendReport(true); // the room's log names it (the page error above)
  otherHorseCheck();
}
// The drain, then ONE fresh beat, then the decision on that beat's own facts.
async function otherHorseCheck() {
  const o = state.otherHorse;
  o.checking = true;
  let fresh = false;
  try {
    await saveQueue.drain(OTHER_HORSE_DRAIN_MS);
    if (state.roomEnd) return;
    const asked = Date.now();
    await lease.beatNow();
    const f = lease.facts();
    fresh = f.at !== null && f.at >= asked; // this beat answered 2xx (a blip leaves the old facts)
  } catch { fresh = false; } finally { o.checking = false; }
  if (state.roomEnd) return;
  if (fresh) otherHorseDecide();
  // No answer: nothing is known, so nothing is closed; the next beat that answers decides (leaseReply).
}
// On a beat's fresh facts: a race owed keeps the lease and the hold; nothing owed closes the lease and ends the seat.
function otherHorseDecide() {
  const o = state.otherHorse;
  if (!o || o.late || o.checking || o.owed === false || state.roomEnd) return;
  const f = lease.facts();
  const name = otherHorseName();
  // Owed: the lobby names a race (its nonce and entry sha are cleared when the race settles; on DOC '99 the nonce
  // stays for the stint), or the lease is closing (its own clock ends it).
  o.owed = f.race_nonce !== null || f.entry_sha !== null || !!(state.leaseClosing && state.leaseClosing.closing);
  if (o.owed) { msg.textContent = OTHER_HORSE_OWED_TEXT(name); return; }
  // Nothing owed. WHERE THE LOBBY OFFERS A NEW HORSE (the pilot, with a slot left) the seat is not ended: the station
  // is put on hold and the chooser opens, so the member can keep the horse they just made (the new horse flow) or
  // leave (otherHorseOffer). Asked once; everywhere else (the real stable, a full pilot, a
  // lobby or room server that cannot say), and when the member chooses to leave, the stopgap's safe ending below.
  if (o.offer === undefined && chooser && seatCalls) { otherHorseOffer(o); return; }
  if (o.offer === 'asking' || o.offer === 'open') return;
  otherHorseEnd();
}
// The other horse's safe ending (the stopgap of 2026-11-23, unchanged): the lease is closed and the seat ends.
function otherHorseEnd() {
  const o = state.otherHorse;
  if (!o || state.roomEnd) return;
  const name = otherHorseName();
  // The close first (seat-lease.js close: the normal path, once), so no race can be entered on this
  // lease from here on; then the seat's normal end (the card look, the link's close, the board last). A write of this
  // horse's own still held keeps the lease open for its late save, as on every end: then no close.
  if (ownSavesOwed() > 0) o.closed = { ok: false, status: 0, code: 'saves owed' };
  else lease.close().then((r) => { o.closed = r; state.leaseClose = r; if (!r.ok) notePageError(`lease close ${r.status}${r.code ? ` ${r.code}` : ''}`); }, () => { o.closed = { ok: false, status: 0, code: 'threw' }; });
  endRoomSeat('other_horse', OTHER_HORSE_TEXT(name), 0);
}
// The other horse, nothing owed: ask the lobby whether a new horse may be made here. Yes (the pilot, with a slot
// left): the station goes on hold at once (no race is entered under the first horse's lease while the member
// chooses) and the chooser opens. A hold refused for a race in flight is a race owed after all: the owed notice, and
// the next beat looks again. Anything else: the safe ending.
async function otherHorseOffer(o) {
  o.offer = 'asking';
  let view = null;
  try { view = (await askHorses('other')).view; } catch { view = null; }
  if (state.roomEnd || state.otherHorse !== o) return;
  if (!(view && view.ok && view.canSwap && view.rows.some((x) => x.kind === 'new' && !x.disabled))) { o.offer = 'none'; otherHorseEnd(); return; }
  let h = null;
  try { h = await seatCalls.room('hold'); } catch { h = null; }
  if (state.roomEnd || state.otherHorse !== o) return;
  if (!(h && !h.network && h.status >= 200 && h.status < 300 && h.body.ok !== false)) {
    if (h && !h.network && h.status === 409 && h.body && h.body.code === 'race_owed') { o.offer = undefined; o.owed = true; msg.textContent = OTHER_HORSE_OWED_TEXT(otherHorseName()); return; }
    o.offer = 'none';
    otherHorseEnd();
    return;
  }
  o.offer = 'open';
  msg.textContent = OTHER_HORSE_LEAD(otherHorseName());
  chooser.open(view, OTHER_HORSE_LEAD(otherHorseName()));
}

// ---- CHANGE HORSE: the chooser and the change (the texts above; room-seat-swap.js has the order and every crash
// point; docs/seat-contract.md the whole of it) ----

// The lobby's list for the lease held now, as the chooser shows it. { a: the answer, view: chooserView or null }.
async function askHorses(mode) {
  const a = await seatCalls.lobby({ action: 'horses', lease_id: session.view.lease_id });
  const ok = !!a && !a.network && a.status >= 200 && a.status < 300;
  return { a, view: ok ? chooserView(a.body, { currentName: state.newHorse && !state.newHorse.created ? '' : horseNow(), mode }) : null };
}
// "Change horse" was pressed: the list is asked for, and the panel opens with it. While the panel is open every game
// input is held (the chooser's onOpen); nothing else has happened yet (the station is put on hold only once a horse
// is chosen, so a player who only looks, or keeps the horse, costs the room nothing).
async function askChangeHorse() {
  if (!chooser || !seatCalls || state.roomEnd || swapRun || chooserAsking || cardOutBusy || chooser.isOpen() || state.otherHorse) return;
  if (!board || boardDead || state.phase !== 'seated' || state.warm) { msg.textContent = CHANGE_NOT_YET_TEXT; return; }
  // The card is in the game: the game would write THIS horse over any card put in the reader under it. A change
  // waits for the game's own eject (which opens this panel by itself).
  if (cardInPlay()) { msg.textContent = SWAP_TEXT.cardIn(horseNow()); return; }
  chooserAsking = true;
  // From the press on, the Insert button is kept from the game (lab run of 2026-11-22: a card that goes in while
  // its file is being changed comes out a mix of two cards): the panel holds the input itself once it is open.
  if (seatInput) seatInput.hold('change-ask', true);
  const before = msg.textContent;
  msg.textContent = CHANGE_ASKING_TEXT;
  let r = null;
  let opened = false;
  try {
    try { r = await askHorses('change'); } catch { r = null; }
    if (state.roomEnd || swapRun || state.otherHorse) return;
    if (msg.textContent === CHANGE_ASKING_TEXT) msg.textContent = before;
    // (A press the board saw in the frame of the click: the card is in the game after all.)
    if (cardInPlay()) { msg.textContent = SWAP_TEXT.cardIn(horseNow()); return; }
    const a = r ? r.a : null;
    // No list: the lobby's own words for a refusal (a lease that has ended is ended by its own beat, as ever).
    if (!r || !r.view) { msg.textContent = !a || a.network || a.status >= 500 ? SWAP_TEXT.lobbyUnreachable : refusalWords(a.body, a.status); return; }
    if (!r.view.ok) { msg.textContent = SWAP_FALLBACK_TEXT; return; }
    chooser.open(r.view);
    opened = true;
  } finally {
    chooserAsking = false;
    if (seatInput) { if (opened) seatInput.hold('change-ask', false); else seatInput.unholdWhenIdle('change-ask'); }
  }
}
// "Keep [name]" (or Escape): the panel closes and nothing has changed.
// (After the game's own eject the page had taken the card out of the reader: Keep puts it back.)
function chooserKeep() {
  if (chooser) chooser.close();
  if (reader.empty && !state.roomEnd && !swapRun) refillReader(session);
}
// The panel's own "Leave seat" (it covers the page's Leave button): one press. The horse is kept (after the game's
// own eject the card goes back in the reader, with nothing said), and then the seat leaves as its Leave button
// does, with no second question: the press was on a button that says so, in a panel that holds every game input.
// (A card that cannot be put back does not hold the leave: its last save had landed before the panel opened.)
async function chooserLeaveSeat() {
  if (!chooser || swapRun || state.roomEnd) return;
  chooser.close();
  if (reader.empty) { try { await refillReader(session, { quiet: true }); } catch { /* the leave goes on */ } }
  if (state.roomEnd) return;
  seatLeave.leave('finish');
}
// The other horse's panel has no keep: its last button leaves the seat (the safe ending), the hold given back first.
function chooserLeave() {
  if (chooser) chooser.close();
  const o = state.otherHorse;
  if (o) o.offer = 'left';
  if (seatCalls) Promise.resolve().then(() => seatCalls.room('release-hold')).catch(() => {});
  otherHorseEnd();
}
// The board changes the card in its reader (lb-board-worker.js card-swap): its answer, or { ok: false } after SWAP_BOARD_MS.
function boardCardSwap({ gen, bytes = null, adopt = false }) {
  if (!board || boardDead) return Promise.resolve({ ok: false, why: 'no board' });
  if (swapWait) return Promise.resolve({ ok: false, why: 'busy' });
  return new Promise((resolve) => {
    swapWait = resolve;
    board.postMessage({ type: 'card-swap', gen, bytes, adopt: adopt === true }, bytes ? [bytes] : []);
    setTimeout(() => { if (swapWait === resolve) { swapWait = null; resolve({ ok: false, why: 'no answer' }); } }, SWAP_BOARD_MS);
  });
}
// LAB ONLY: change the card in the lab seat's reader by hand (the room seat has no such hook).
if (!roomSeat) window.seat.cardSwap = (bytes, adopt = false) => boardCardSwap({ gen: ++cardGen, bytes: bytes || null, adopt });
// Step 1 of a change: the old card's last look (a change it finds joins the old lease's queue, under the old card's
// generation), then that queue's drain. A write of the old horse's own that has not landed stops the change: its
// lease is about to end, and a save after that is only ever a late save.
async function oldCardOut(old) {
  if (board && !boardDead) {
    if (finalWait) return { ok: false, words: SWAP_FALLBACK_TEXT }; // a leave is looking at the card
    await new Promise((resolve) => {
      finalWait = resolve;
      board.postMessage({ type: 'card-final' });
      setTimeout(() => { if (finalWait === resolve) { finalWait = null; resolve(null); } }, SWAP_LOOK_MS);
    });
  }
  if (state.roomEnd) return { ok: false, words: SWAP_FALLBACK_TEXT };
  if (old.queue) { try { await old.queue.drain(SWAP_DRAIN_MS); } catch { /* judged below */ } }
  const q = old.queue ? old.queue.state() : { pending: 0, held: 0 };
  const own = q.pending + q.held - (old.queue ? old.queue.heldOther() : 0);
  return own > 0 ? { ok: false, words: SWAP_TEXT.cardBusy(horseNow()) } : { ok: true };
}
// Step 4: the lobby has changed the lease. The new lease is the seat's from here: its session is made and beaten at
// once; the old lease is beaten no more and its id is never sent again (but in a retry of this same change), and its
// queue is stopped, so a later write of the old card is only put in the stash under the old lease. null: the answer
// does not name the lease and the horse that were asked for (the change is then not taken up).
function adoptLease(run, reply, pick) {
  const lower = (x) => (typeof x === 'string' ? x.toLowerCase() : x);
  const isNew = reply.new_horse === true;
  if (isNew !== (pick.newHorse === true)) return null;
  if (!isNew && lower(reply.horse_id) !== lower(pick.horseId)) return null;
  const view = leaseView(handoff, { lease_id: lower(reply.lease_id), horse_id: lower(reply.horse_id), horse_name: isNew ? '' : pick.name, new_horse: isNew, heartbeat_s: reply.heartbeat_s, expires_at: reply.expires_at, issued_at: Date.now() });
  if (!view) return null;
  const old = run.old;
  const s = openSession(view, isNew ? '' : pick.name, null);
  session = s;
  saveQueue = null;
  run.session = s;
  sessions.finish(old);
  // What the page knew of the old lease is the old lease's.
  state.leaseTrouble = false;
  state.leaseClosing = null;
  showClosingNotice(null);
  savesPaused = false;
  lastQueuedSeq = null;
  cardLook = null;
  if (state.newHorse && state.newHorse.held && seatInput) seatInput.unholdWhenIdle('new-horse');
  state.newHorse = null;
  newCard = false;
  state.hasCard = false;
  s.lease.start();
  return s;
}
// Step 5: the new lease's card, and its own save queue (seq from its checkout's last_seq + 1).
async function checkoutSession(s) {
  const r = await s.lease.checkout({ canRetry: () => !state.roomEnd });
  if (!r.ok) return { ok: false, why: 'checkout refused' };
  const c = readCheckout(r.body, s.view);
  if (!c.ok) return { ok: false, why: c.why };
  await stashOpen;
  if (state.roomEnd || s !== session) return { ok: false, why: 'ended' };
  // The name a save of this horse carries: the stable's own (the checkout's) when it has one, else the lobby's list's.
  const own = typeof r.body.horse_name === 'string' ? r.body.horse_name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) : '';
  if (!c.newHorse && own) s.view.horse_name = own;
  saveQueue = makeQueue(s, c);
  s.card = c.card ? c.card.slice() : null;
  return { ok: true, card: c.card, newHorse: c.newHorse, lastSeq: c.lastSeq };
}
// Step 6: the new card into the reader (or an empty reader for a new horse; adopt: the card the game wrote stays and
// is saved as the new horse's), under a new card generation that is the new lease's from before the board answers.
async function readerSwap(s, co, pick) {
  const gen = ++cardGen;
  sessions.bind(gen, s);
  const bytes = co.card ? co.card.buffer.slice(co.card.byteOffset, co.card.byteOffset + co.card.byteLength) : null;
  const a = await boardCardSwap({ gen, bytes, adopt: co.newHorse === true && pick.adopt === true });
  if (!a || a.ok !== true) {
    sessions.bind(gen, null);
    notePageError(`card not changed (${reportText(String(a && a.why ? a.why : 'no answer'), 60)})`);
    return { ok: false, why: 'reader' };
  }
  newCard = co.newHorse === true;
  state.hasCard = !newCard;
  state.checkedOut = { lastSeq: co.lastSeq, ...(newCard ? { newHorse: true } : {}), gen };
  state.newHorse = newCard ? { created: false, writes: 0, held: false, refused: null, name: null } : null;
  // The new card is in the member's hand, not in the game, until Insert is pressed (or, for a new horse, the game
  // writes it).
  reader.in = false;
  reader.empty = false;
  // A card the game wrote on an empty reader that no lease owned (it made a new horse there by itself) is the new
  // horse's first write.
  const loose = newCard ? sessions.takeLoose() : null;
  if (loose) roomCardWrite(gen, loose.bytes);
  return { ok: true };
}
// Is the card in the game right now? The reader's own events say so (in since the insert button, or since the game
// wrote a card; out at the game's eject). A card that went in and that the game never took up (its STATE is still
// the attract screen's, 0, after CARD_IDLE_MS) does not count: the game is not using it.
function cardInPlay() {
  if (!reader.in) return false;
  const st = state.board.counts.state;
  return !(st === 0 && Date.now() - reader.inAt > CARD_IDLE_MS);
}
// The page takes the card out of the reader (an empty reader that no lease owns), and puts a lease's card back.
async function emptyReader() {
  const gen = ++cardGen;
  sessions.bind(gen, null);
  const a = await boardCardSwap({ gen, bytes: null });
  if (!a || a.ok !== true) return false;
  // (reader.in is left as it is: the card was out when this was asked, and an insert press the board saw just
  // before it took the card out has said so meanwhile; cardCameOut then puts the card straight back.)
  reader.empty = true;
  return true;
}
// stillIn: the card is in the game after all (that late insert press): the file goes back under it and nothing is said.
// quiet: nothing is said of the card (the panel's Leave seat: the seat's own end has the words).
async function refillReader(s, { stillIn = false, quiet = false } = {}) {
  const gen = ++cardGen;
  sessions.bind(gen, s);
  const bytes = s.card ? s.card.buffer.slice(s.card.byteOffset, s.card.byteOffset + s.card.byteLength) : null;
  const a = await boardCardSwap({ gen, bytes });
  if (state.roomEnd) return false;
  if (!a || a.ok !== true) {
    sessions.bind(gen, null);
    notePageError(`card not put back (${reportText(String(a && a.why ? a.why : 'no answer'), 60)})`);
    msg.textContent = READER_STUCK_TEXT;
    return false;
  }
  reader.empty = false;
  if (stillIn) return true;
  reader.in = false;
  if (s === session && !quiet) msg.textContent = s.card ? SWAP_TEXT.done(horseNow()) : SWAP_TEXT.doneNew;
  return true;
}
// THE GAME'S OWN EJECT (the board's card-out, for the card of the lease held now): the game is done with this card.
// Once its last save has landed, and where the lobby has another horse (or a new one) to offer, the page takes the
// card out of the reader and asks "Which horse next?" by itself. The game's input is held from the eject until the
// member has chosen (or until this gives up), so no button can put the card back in underneath it. Nothing is asked
// of the room server until a horse is chosen. Where there is nothing to choose, nothing happens: the card stays in
// the reader and the member plays on (or leaves) as before.
async function cardCameOut(gen) {
  if (!chooser || !seatCalls || cardOutBusy || state.roomEnd || swapRun || chooserAsking || chooser.isOpen() || state.otherHorse) return;
  // Rev C only: the lab run that established the eject was Rev C's, and the lobby changes horses in Rev C rooms only.
  if (handoff.release !== 'revc') return;
  const s = session;
  if (!s || sessions.owner(gen) !== s || !s.queue || !board || boardDead || state.phase !== 'seated' || newHorseWaiting()) return;
  cardOutBusy = true;
  if (seatInput) seatInput.hold('card-out', true);
  const off = () => !!state.roomEnd || swapRun !== null || session !== s || state.otherHorse || chooser.isOpen() || state.phase !== 'seated';
  let opened = false;
  try {
    // Its last save: landed, or this is not the moment (the queue's own notices say what is owed).
    await s.queue.drain(SWAP_DRAIN_MS);
    const q = s.queue.state();
    if (off() || reader.in || q.pending + q.held > 0 || q.stopped) return;
    const r = await askHorses('change');
    if (off() || reader.in) return;
    if (!r.view || !r.view.ok || !r.view.canSwap || !r.view.rows.some((x) => !x.disabled)) return; // nothing to choose
    if (!(await emptyReader())) return;
    // The card went back in under it (a press in the same frame): the card goes back in the reader, and nothing is asked.
    if (off() || reader.in) { if (!state.roomEnd && session === s) await refillReader(s, { stillIn: reader.in }); return; }
    msg.textContent = CARD_OUT_LEAD(horseNow());
    chooser.open(r.view, CARD_OUT_LEAD(horseNow()), { focusKeep: true });
    opened = true;
  } catch (err) {
    notePageError(`card out (${reportText(String(err && err.message ? err.message : err), 60)})`);
  } finally {
    cardOutBusy = false;
    // The chooser holds the input itself while it is open.
    if (seatInput) { if (opened) seatInput.hold('card-out', false); else seatInput.unholdWhenIdle('card-out'); }
  }
}
// The calls of one change (room-seat-swap.js runHorseSwap).
function swapDeps(run, pick) {
  const old = run.old;
  return {
    onStep: (name) => { run.step = name; if (state.swap) state.swap.step = name; },
    // The seat's own end, or a leave under way (the room's eject ask, the unload): the change stops at its next step.
    ended: () => !!state.roomEnd || state.phase === 'leaving' || state.phase === 'ejecting' || state.phase === 'left' || state.phase === 'dropped',
    wait: (ms) => new Promise((res) => setTimeout(res, ms)),
    cardOut: () => oldCardOut(old),
    hold: () => seatCalls.room('hold'),
    releaseHold: () => seatCalls.room('release-hold'),
    // THE SAME REQUEST every time (the lobby's retry rule): the OLD lease id, and the horse or new_horse asked for.
    lobbySwap: () => seatCalls.lobby({ action: 'swap', lease_id: old.view.lease_id, ...(pick.newHorse ? { new_horse: true } : { horse_id: pick.horseId }) }),
    // Is the old lease still live? Its own beat's end says no; else the lobby's horses answer for it does.
    oldLeaseLive: async () => {
      if (run.oldEnd) return false;
      const a = await seatCalls.lobby({ action: 'horses', lease_id: old.view.lease_id });
      if (a && !a.network && a.status >= 200 && a.status < 300) return true;
      if (a && !a.network && (a.status === 410 || a.status === 404)) return false;
      return run.oldEnd ? false : null;
    },
    adopt: (reply) => adoptLease(run, reply, pick),
    checkout: (s) => checkoutSession(s),
    cardSwap: (s, co) => readerSwap(s, co, pick),
    rebind: (ticket) => seatCalls.room('rebind', { ticket }),
    // The ticket's exp is the servers' clock, in seconds.
    ticketLive: (expS) => Number.isFinite(expS) && serverNow(handoff, Date.now()) < expS * 1000 - TICKET_MARGIN_MS,
    abandon: (s) => abandonLease(s),
  };
}
// A lease the lobby opened for a change that this seat cannot finish (its card could not be had, the room server
// would not bind it, or the page is going away mid change): closed at once (seat-lease.js close, kept alive past an
// unload), so the horse is free. It never has a race: the station is on hold until the rebind.
function abandonLease(s) {
  return s.lease.close().then((r) => { state.swapClose = r; return r; }, () => null);
}
// A horse was chosen: the change runs (the panel stays up, its choices off, saying so), and then exactly one of:
//   done     the panel closes: "[B] is in your hand. Press Insert card to put it in." (or the new horse's line)
//   kept     nothing changed: the sender's words in the panel, the choices back (another horse, or Keep)
//   leave    the seat has no usable lease: it ends, with words that say so and the link back
//   aborted  the seat ended meanwhile: its own end path has it
async function changeTo(pick) {
  if (swapRun || state.roomEnd || !chooser || !seatCalls || !pick) return;
  // The card's file is changed only while the card is OUT of the game (the one exception changes no file: the
  // other horse's "New horse", which keeps the card the game wrote).
  if (!pick.adopt && cardInPlay()) { chooser.fail(SWAP_TEXT.cardIn(horseNow())); return; }
  const run = { old: session, session: null, step: null, oldEnd: null, newEnd: null };
  const other = state.otherHorse && state.otherHorse.offer === 'open' ? state.otherHorse : null;
  swapRun = run;
  state.swap = { to: pick.newHorse ? 'new' : 'horse', step: null, outcome: null, code: null, steps: [] };
  chooser.busy(SWAP_TEXT.working(pick.name));
  leaveBtn.disabled = true; // a Leave waits for the change (it is over in seconds; the room's own eject still ends the seat)
  let r = null;
  try { r = await runHorseSwap(pick, swapDeps(run, pick)); } catch (err) {
    notePageError(`horse change threw (${reportText(String(err && err.message ? err.message : err), 60)})`);
    r = run.session ? { outcome: 'leave', code: 'threw', words: SWAP_TEXT.failed(pick.name), steps: [] } : { outcome: 'kept', code: 'threw', words: SWAP_FALLBACK_TEXT, steps: [] };
  }
  swapRun = null;
  state.swap = { ...state.swap, outcome: r.outcome, code: r.code || null, steps: r.steps };
  const ending = !!state.roomEnd || state.phase === 'leaving' || state.phase === 'ejecting' || state.phase === 'left' || state.phase === 'dropped';
  if (!ending) leaveBtn.disabled = false;
  if (r.outcome === 'aborted' || state.roomEnd) { chooser.close(); return; }
  if (r.outcome === 'kept') {
    // The old lease really ended while the lobby was asked (its beat said so, and the change did not happen).
    if (run.oldEnd) { chooser.close(); leaseEnded(run.oldEnd, run.old); return; }
    chooser.fail(r.words || SWAP_FALLBACK_TEXT);
    return;
  }
  if (r.outcome === 'leave') {
    chooser.close();
    notePageError(`horse change not finished (${reportText(String(r.code || 'refused'), 40)})`);
    endRoomSeat('swap', BACK.say(r.words || SWAP_TEXT.lost), 0);
    return;
  }
  // Done: the station is bound to the new lease and its card is in the reader.
  state.changes = (state.changes || 0) + 1;
  if (other && state.otherHorse === other) { state.otherHorse = null; if (seatInput) seatInput.unholdWhenIdle('other-horse'); }
  chooser.close();
  if (run.newEnd) { leaseEnded(run.newEnd, session); return; }
  // (A new horse whose card the game already wrote: its save is on its way, and its own line may be up already.)
  if (!(r.newHorse && state.newHorse && state.newHorse.writes > 0)) msg.textContent = r.newHorse ? (pick.adopt ? SWAP_TEXT.doneAdopt : SWAP_TEXT.doneNew) : SWAP_TEXT.done(pick.name);
  sendReport(true);
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
  if (!wayBack) { wayBack = document.createElement('a'); wayBack.textContent = BACK.link; }
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
function leaseEnded(info, s) {
  // The end of a lease the seat no longer holds is the horse change's own doing (the lobby ended it 'replaced').
  if (s && s !== session) return;
  // During a horse change (changeTo): the old lease's end while the lobby is being asked may BE the change (the lobby
  // ended it and the reply is still on its way), and the new lease's end is the change's to handle (it closes what is
  // left and ends the seat with its own words). Kept for the change; it applies them when it is over.
  if (swapRun && s) {
    if (s === swapRun.old && swapRun.step === 'lobby') { swapRun.oldEnd = info; return; }
    if (s === swapRun.session) { swapRun.newEnd = info; return; }
  }
  state.leaseEnd = info;
  // 402, 403 and the rest: the route's own message, for a moment. A bare
  // code (an answer with no message of its own) is not shown as words.
  const own = info.message && !/^[a-z_]{1,32}$/.test(info.message) ? info.message : null;
  if (info.kind === 'refused') endRoomSeat('refused', own || `The rooms refused this seat. ${BACK.going}`, RETURN_NOTICE_MS);
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
  if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
  // The touch layout puts its bar and its menu outside the stage's own picture: there the whole page goes full screen.
  const el = touchLayout && document.documentElement && document.documentElement.requestFullscreen ? document.documentElement : stage;
  if (el && el.requestFullscreen) el.requestFullscreen().catch(() => {});
}
if (roomSeat && fullBtn && stage && typeof stage.requestFullscreen === 'function') {
  fullBtn.hidden = false;
  fullBtn.addEventListener('click', toggleFullscreen);
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyF' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if ((controlsPanel && controlsPanel.isOpen()) || (leaveAsk && !leaveAsk.hidden) || (chooser && chooser.isOpen())) return;
    // Not while a report is being written: an "f" of the note typed a moment late must not turn the page full screen.
    if (reportSheet && reportSheet.isOpen()) return;
    // Nor in the page's first seconds: a member who was still typing on the lobby when it moved here (a report's note)
    // must not find the seat full screen for it.
    if (performance.now() < TYPED_AHEAD_MS) return;
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
// CHANGE HORSE, the room seat only: the panel (mp-seat.html #horse-ask, room-seat-chooser.js) and the calls a change
// makes (room-seat-net.js). While the panel is open every game input is held, as for the menu and the Controls panel.
// A page without the panel, or one where it cannot start, has no Change horse button and plays exactly as before.
if (roomSeat && handoff && changeBtn) {
  try {
    seatCalls = createSeatCalls({ handoff });
    chooser = createHorseChooser({
      doc: document, root: document.getElementById('horse-ask'), onPick: (p) => { changeTo(p); }, onKeep: chooserKeep, onLeave: chooserLeave, onLeaveSeat: () => { chooserLeaveSeat(); },
      onOpen: () => { if (seatInput) seatInput.hold('chooser', true); }, onClose: () => { if (seatInput) seatInput.unholdWhenIdle('chooser'); },
    });
  } catch (err) {
    chooser = null;
    notePageError(`horse chooser not started (${String(err && err.message ? err.message : err).slice(0, 60)})`);
  }
  if (!chooser) seatCalls = null;
  else if (typeof changeBtn.addEventListener === 'function') changeBtn.addEventListener('click', () => { askChangeHorse(); if (typeof changeBtn.blur === 'function') changeBtn.blur(); });
  // The page is going away in the middle of a change (a reload, a closed tab): the lease the lobby has just opened
  // is closed on the way out (it has no race: the station is on hold), so the horse is free at once instead of
  // waiting out its lease. The room takes the station back when the seat's link drops, hold and all.
  if (chooser && typeof window.addEventListener === 'function') window.addEventListener('pagehide', () => { if (swapRun && swapRun.session && !state.roomEnd) abandonLease(swapRun.session); });
}
// Option A step 2, the room seat only: the room's main screen (both halves of the race screen, published once per room
// by the room, room-main-view.js) on top, the player's own board below, as the cabinet seat lays out its mains and its
// satellite. Read only, from the room host this seat signals to. A view that cannot start never stops the seat.
const mainVideo = document.getElementById('main');
// The sound path, now: before the main view asks for its stream, and a minute or three before the board starts. Not on
// a room seat page with no hand-off (it is on its way back to the rooms).
if (!roomSeat || handoff) startSeatAudio();
function fitMain() {
  if (touchLayout) return; // the touch layout places both pictures itself
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
      // The main cabinet's sound comes with the picture and is played by the page's sound (room-seat-audio.js: its own
      // level and mute beside the seat's, from the moment it arrives, board or no board); the video element itself stays muted.
      mainView = createMainView({ video: mainVideo, whepUrl: whep, iceServers: () => mainViewIceServers(handoff, Date.now()), onAudio: (s) => { mainSound = s; if (seatAudio) seatAudio.setMain(s); } });
      mainVideo.hidden = false;
      if (document.body && document.body.classList) document.body.classList.add('main-on');
      fitMain();
      window.addEventListener('resize', fitMain);
      document.addEventListener('fullscreenchange', () => setTimeout(fitMain, 50));
      mainView.start();
      window.seat.mainView = () => (mainView ? mainView.state() : null); // counts only: attempts, what each offer carried, the last error
    } catch (err) {
      mainView = null;
      mainVideo.hidden = true;
      if (document.body && document.body.classList) document.body.classList.remove('main-on');
      notePageError(`main view not started (${String(err && err.message ? err.message : err).slice(0, 60)})`);
    }
  }
}
// The phone and tablet layout (docs/seat-phone-layout.md), the room seat only, on a device whose main pointer is a
// finger; a desktop is laid out exactly as before. room-seat-layout.js works the rectangles out (the bar, the main
// screen, the player's own screen, the nine buttons, all inside the safe area); this writes them to the stage as CSS
// variables, ONCE per resize, turn of the device, full screen change or change of what is shown (never per frame),
// and tells the pad. The header becomes a menu (the Menu button), which holds every game input while it is open.
const menuBtn = document.getElementById('menu-btn');
const menuClose = document.getElementById('menu-close');
const barMsg = document.getElementById('bar-msg');
const barLeave = document.getElementById('bar-leave');
const hapticBtn = document.getElementById('haptic');
const touchPage = roomSeat && !!handoff && !!stage && !!stage.style && typeof stage.style.setProperty === 'function' && !!document.body && !!document.body.classList;
const haptics = touchPage ? createHaptics({ win: window }) : null;
let layoutKey = '';
let varNames = [];
// Sideways, which picture is the large one: the player's own screen (the one with text to read) unless the player
// tapped the main screen to swap them (room-seat-layout.js large). For this visit only; nothing is stored.
let bigPicture = 'screen';
function menuOpen() { return touchPage && document.body.classList.contains('menu-open'); }
function setMenu(open) {
  if (!touchPage || menuOpen() === !!open) return;
  document.body.classList.toggle('menu-open', !!open);
  if (menuBtn && typeof menuBtn.setAttribute === 'function') menuBtn.setAttribute('aria-expanded', String(!!open));
  // A touch on the menu never reaches the game; a button resting when it closes does not either.
  if (seatInput) { if (open) seatInput.hold('menu', true); else seatInput.unholdWhenIdle('menu'); }
  const to = open ? menuClose : menuBtn;
  if (to && typeof to.focus === 'function') to.focus();
}
function applyTouchLayout() {
  if (!touchPage) return;
  const root = document.documentElement;
  const want = touchLayoutWanted({ roomSeat: true, coarse: coarsePointer(window), vw: window.innerWidth, vh: window.innerHeight });
  if (!want) {
    if (!touchLayout) return;
    touchLayout = null; layoutKey = '';
    setMenu(false);
    for (const c of ['touch', 'land', 'port']) { document.body.classList.remove(c); if (root && root.classList) root.classList.remove(c); }
    for (const n of varNames) stage.style.removeProperty(n);
    varNames = [];
    paintHaptic();
    fitMain();
    if (seatPad) seatPad.relayout();
    return;
  }
  const L = seatLayout({
    vw: window.innerWidth, vh: window.innerHeight, insets: readInsets(document.getElementById('safe-probe'), window.getComputedStyle),
    main: !!(mainVideo && !mainVideo.hidden), pad: !!(seatPad && seatPad.shown()), large: bigPicture,
  });
  const vars = layoutVars(L);
  const key = `${L.mode}|${JSON.stringify(vars)}|${L.small}|${L.arrangement}`;
  if (key === layoutKey) return;
  layoutKey = key;
  touchLayout = L;
  for (const el of [document.body, root]) {
    if (!el || !el.classList) continue;
    el.classList.add('touch');
    el.classList.toggle('land', L.mode === 'landscape');
    el.classList.toggle('port', L.mode === 'portrait');
  }
  for (const n of varNames) if (!(n in vars)) stage.style.removeProperty(n);
  for (const [n, v] of Object.entries(vars)) stage.style.setProperty(n, v);
  varNames = Object.keys(vars);
  paintHaptic();
  if (seatPad) seatPad.relayout();
}
function paintHaptic() {
  if (!hapticBtn || !haptics) return;
  // Only where there are on-screen buttons to feel: the touch layout, on a device that can buzz.
  hapticBtn.hidden = !(haptics.supported && touchLayout);
  hapticBtn.textContent = haptics.on() ? 'Buzz on Whip and Hold: on' : 'Buzz on Whip and Hold: off';
  if (typeof hapticBtn.setAttribute === 'function') hapticBtn.setAttribute('aria-pressed', String(haptics.on()));
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
  applyTouchLayout(); // the buttons shown or hidden: the pictures take or give their room
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
      // On a phone or a tablet the buttons sit where the page's layout made room for them, and Whip and Hold buzz.
      preset: () => (touchLayout && touchLayout.pads ? { slots: padPreset(touchLayout), headerBottom: touchLayout.bar ? touchLayout.bar.b : 0 } : null),
      haptic: (a) => { if (haptics) haptics.pulse(a); },
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

// The touch layout, started (its functions are above the pad, which calls them).
if (touchPage) {
  try {
    // The screen stays awake for the whole seat, the wait included (a phone sleeps in half a minute otherwise).
    wakeLock = createWakeLock({ nav: window.navigator, doc: document });
    wakeLock.start();
    window.seat.wakeLock = () => (wakeLock ? wakeLock.state() : null);
    window.seat.layout = () => touchLayout;
    window.seat.haptics = () => (haptics ? haptics.state() : null);
    applyTouchLayout();
    window.addEventListener('resize', applyTouchLayout);
    window.addEventListener('orientationchange', () => setTimeout(applyTouchLayout, 50));
    document.addEventListener('fullscreenchange', () => setTimeout(applyTouchLayout, 50));
    if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') window.visualViewport.addEventListener('resize', applyTouchLayout);
    try { const mq = window.matchMedia('(pointer: coarse)'); if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', applyTouchLayout); } catch { /* no media queries: no touch layout */ }
    // The browser's own gestures stay off the play area (scroll, pull to refresh, the long press menu, zoom, text
    // selection); the bar, the menu, the prompt and every panel keep them, so a player who needs to zoom still can.
    guardPlayArea({ root: stage, isPlay: (t) => !!touchLayout && !(t && typeof t.closest === 'function' && t.closest('#menu-btn, #bar-leave, #bar-msg, #sound-ask, #files-ask, .padarrange')) });
    if (menuBtn) menuBtn.addEventListener('click', () => setMenu(!menuOpen()));
    if (menuClose) menuClose.addEventListener('click', () => setMenu(false));
    if (barLeave) barLeave.addEventListener('click', () => askLeave());
    // Sideways, one tap on the main screen swaps which picture is the large one (upright both are at the full width).
    if (mainVideo && typeof mainVideo.addEventListener === 'function') mainVideo.addEventListener('click', () => {
      if (!touchLayout || touchLayout.mode !== 'landscape') return;
      bigPicture = bigPicture === 'screen' ? 'main' : 'screen';
      applyTouchLayout();
    });
    // Whatever the menu starts (the leave check, the Controls panel, arranging the buttons) shows over the play area.
    for (const b of [leaveBtn, controlsBtn, arrangeBtn, padBtn, fullBtn, changeBtn]) if (b && typeof b.addEventListener === 'function') b.addEventListener('click', () => setMenu(false));
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuOpen()) { e.preventDefault(); setMenu(false); } });
    if (hapticBtn && haptics) { hapticBtn.addEventListener('click', () => { haptics.set(!haptics.on()); if (haptics.on()) haptics.pulse('whip'); paintHaptic(); }); paintHaptic(); }
    // The status line, where the touch layout shows it (the bar upright, a strip over the main screen sideways).
    if (barMsg && typeof MutationObserver === 'function') {
      const copy = () => { if (barMsg.textContent !== msg.textContent) barMsg.textContent = msg.textContent; };
      new MutationObserver(copy).observe(msg, { childList: true, characterData: true, subtree: true });
      copy();
    }
  } catch (err) {
    notePageError(`touch layout not started (${String(err && err.message ? err.message : err).slice(0, 60)})`);
  }
}

// REPORT A PROBLEM (room-seat-report.js; docs/problem-reports.md), the room seat only: a button in the header (the
// menu on a phone) opens a small panel with an optional one line note, Send and Cancel. The snapshot is taken when
// the button is pressed: a small JPEG of the player's own picture, the figures of the status panel, the page's own
// state and its last log lines. It goes to the lobby (POST /api/room/report, the hand-off's room token) only on Send.
// No card bytes, no token, no ticket and no address are in it. While the panel is open every game input is held, as
// under the page's other panels. The lab seat has no hand-off and no button.
const linkRate = createRateMeter();
const boardRate = createRateMeter();
let reportSheet = null;
function reportSnapshot() {
  const id = newReportId();
  const at = Date.now();
  const guard = (f, d = null) => { try { return f(); } catch { return d; } };
  const stats = guard(() => seatStats({ state, rates: { link: linkRate.rate(), board: boardRate.rate() } }), {});
  const seatNow = guard(() => seatState({ state, extra: {
    link_open: linkOpen, started, board_dead: boardDead, card_gen: cardGen, board_gen: boardGen, new_card: newCard, eject_out: ejectOut,
    input_held: seatInput ? seatInput.held() : null, reader: { in: reader.in, outs: reader.outs, empty: reader.empty },
    saves_hold: savesHold, saves_paused: savesPaused, saves_owed: guard(() => allOwed()),
    lease: lease ? { state: guard(() => lease.state()), trouble: guard(() => lease.trouble()), time_left_ms: guard(() => Math.round(lease.timeLeft())), ...guard(() => reportFacts(lease.stats, { depth: 0 }), {}) } : null,
    swap_running: !!swapRun, chooser_asking: chooserAsking,
    touch: touchLayout ? touchLayout.mode : null, pad_shown: seatPad ? seatPad.shown() : null, menu_open: menuOpen(), main_on: !!(mainVideo && !mainVideo.hidden),
    status_line: msg.textContent, notice: noticeEl && !noticeEl.hidden ? noticeEl.textContent : null, end_why: endWhy,
    page_errors: pageErrors.count, last_error: pageErrors.last, file_source: fileSource,
  } }), {});
  const device = guard(() => deviceFacts({ win: window, nav: navigator, doc: document }), {});
  const lines = [...seatLog.lines(), ...boardLog.lines()].sort((a, b) => a.t - b.t);
  const view = session ? session.view : handoff;
  const races = guard(() => state.board.counts.races);
  const picture = capturePicture({ canvas: document.getElementById('screen'), doc: document });
  return {
    picture,
    build: ({ note, picture: pic, pictureNote }) => buildSeatReport({
      id, now: at, note, handoff, view, stats, state: seatNow, device, log: lines, logDropped: seatLog.dropped() + boardLog.dropped(),
      raceNo: races, cardGen, pageBuild: metas.build, picture: pic, pictureNote,
    }),
  };
}
if (roomSeat && handoff) {
  try {
    const reportBtn = document.getElementById('report');
    const reportAsk = document.getElementById('report-ask');
    const sender = createReportSender({ handoff });
    if (reportBtn && reportAsk && sender.ready && typeof reportBtn.addEventListener === 'function') {
      const el = (id) => document.getElementById(id);
      // The menu closes first (a phone), then the panel opens over the play area.
      reportBtn.addEventListener('click', () => setMenu(false));
      reportSheet = createReportSheet({
        els: { button: reportBtn, dialog: reportAsk, title: el('report-q'), lead: el('report-lead'), label: el('report-note-label'), note: el('report-note'), status: el('report-status'), send: el('report-send'), cancel: el('report-cancel') },
        copy: reportCopy('en'),
        snapshot: reportSnapshot,
        send: (r) => sender.send(r),
        hold: (on) => { if (!seatInput) return; if (on) seatInput.hold('report', true); else seatInput.unholdWhenIdle('report'); },
        // The outcome's words also go in the status strip for a few seconds (the sheet closes by itself soon after a
        // send, and is no veil: a member looking at the game must still see that the report went through, or did not).
        onDone: (r, words) => {
          seatLog.add('report', `${r.outcome}${r.status ? ` (${r.status})` : ''}`);
          if (!words || state.roomEnd) return;
          const before = msg.textContent;
          msg.textContent = words;
          setTimeout(() => { if (msg.textContent === words && !state.roomEnd) msg.textContent = before; }, REPORT_SAID_MS);
        },
      });
      reportBtn.hidden = false;
      window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && reportSheet && reportSheet.isOpen() && !reportSheet.busy()) { e.preventDefault(); reportSheet.close(); } });
      // For the page's own tests and the lab: the report as it would be sent now, without its picture. Sends nothing.
      window.seat.reportPreview = () => reportSnapshot().build({ note: '', picture: null, pictureNote: 'preview' });
    }
  } catch (err) {
    notePageError(`report not started (${String(err && err.message ? err.message : err).slice(0, 60)})`);
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
  cardNowIn();
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
      const filesBox = filesUiOk && filesUi.box.hidden === false && filesUi.box.style ? filesUi.box : null;
      if (filesBox && !touchLayout) { filesBox.style.left = `${screenEl.offsetLeft}px`; filesBox.style.top = `${screenEl.offsetTop}px`; filesBox.style.width = `${screenEl.offsetWidth}px`; filesBox.style.height = `${screenEl.offsetHeight}px`; } else if (filesBox) { for (const p of ['left', 'top', 'width', 'height']) if (filesBox.style[p]) filesBox.style[p] = ''; }
      const c = ended() || filesBox ? null : seatWaitCard({ phase: state.phase, linkOpen, warm: state.warm === true, waitedS: (performance.now() - stepAt) / 1000, mainOn: !!(mainVideo && !mainVideo.hidden) });
      // Racing: the station is the player's and nothing is over their screen (the touch layout hides its status strip then).
      if (document.body && document.body.classList) { const racing = !c && state.phase === 'seated'; if (document.body.classList.contains('racing') !== racing) document.body.classList.toggle('racing', racing); }
      if (!c) { if (!waitEl.hidden) waitEl.hidden = true; return; }
      if (c.step !== step) { step = c.step; stepAt = performance.now(); }
      // Over the picture exactly, wherever the layout has put it (the touch layout says where: its own variables).
      if (touchLayout) { for (const p of ['left', 'top', 'width', 'height']) if (waitEl.style[p]) waitEl.style[p] = ''; } else {
      waitEl.style.left = `${screenEl.offsetLeft}px`; waitEl.style.top = `${screenEl.offsetTop}px`;
      waitEl.style.width = `${screenEl.offsetWidth}px`; waitEl.style.height = `${screenEl.offsetHeight}px`;
      }
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

// What the page's own log keeps of the seat (room-seat-report.js): a line whenever one of these changes. The two
// rates behind the report's frame rate are read here too (the link's releases and the board's frames, a second).
const logSeen = {};
function logChanges(smp) {
  const now = performance.now();
  if (state.link && Number.isFinite(state.link.released)) linkRate.note(now, state.link.released);
  if (smp && Number.isFinite(smp.f)) boardRate.note(now, smp.f);
  const b = state.board;
  const c = b.counts || {};
  const seen = {
    phase: `${state.phase}${state.refused ? ` (${state.refused})` : ''}`,
    link: `${linkOpen ? 'open' : 'closed'}${state.gone ? ` gone (${state.goneReason || ''})` : ''}`,
    lease: state.leaseTrouble ? 'trouble' : 'ok',
    reconnects: String(state.reconnects || 0),
    races: String(c.races ?? 0),
    entered: String(c.entered === true),
    swap: state.swap ? `${state.swap.to || ''} ${state.swap.step || ''} ${state.swap.outcome || ''} ${state.swap.code || ''}` : '',
    saves: state.saves ? `pending ${state.saves.pending} held ${state.saves.held} stopped ${state.saves.stopped}` : '',
    boarderr: b.errors.length ? `${b.errors.length}: ${b.errors[b.errors.length - 1]}` : '',
    msg: msg.textContent || '',
    notice: noticeEl && !noticeEl.hidden ? noticeEl.textContent || '' : '',
  };
  for (const [k, v] of Object.entries(seen)) { if (logSeen[k] === v) continue; const first = !(k in logSeen); logSeen[k] = v; if (v || !first) seatLog.add(k, v || '(none)'); }
}
setInterval(() => {
  const st = state.board;
  const smp = st.samples.length ? st.samples[st.samples.length - 1] : null;
  const l = state.link;
  try { logChanges(smp); } catch { /* the log never stops the page */ }
  statusEl.textContent = [`phase ${state.phase}${state.refused ? ` (${state.refused})` : ''}`,
    smp ? `board f ${smp.f} comm2 ${smp.status.comm2}` : 'board -',
    l ? `link up ${l.upSent} down ${l.downDelivered} released ${l.released} not at barrier ${l.notAtBarrier}` : 'link -',
    `card writes ${state.cardWrites} acks ${state.cardAcks.map((a) => a.verdict).join(',')}`].join('\n');
}, 500);
