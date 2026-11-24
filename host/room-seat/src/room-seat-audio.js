// room-seat-audio.js: the seat page's sound: the player's own satellite board, and the room's main cabinet.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The seat's board runs in a worker (lb-board-worker.js). Given a ring
// (msg.audio), its libretro audio callback pushes every batch into it; this
// module makes that ring, and plays it in the page through the adaptive
// resampling worklet the single page game uses for its seat board
// (audio-worklet.js ResamplingAudioProcessor, the numbers of cabinet-game.js
// AUDIO_SOURCES for the player's board).
//
// Rules:
// - The game's timing is never touched. The ring is made at once, with no
//   waiting, so the board starts as before; the board only ever pushes, and a
//   full ring drops the batch (audio-ring.js). A context that is not running
//   (the browser's autoplay rule, the sound card gone) just lets the ring
//   fill and drop. A burst or a pause of the board (the lockstep catching up,
//   a join) is the worklet's to smooth: it skips a backlog with a crossfade
//   and fades a gap out and back in.
// - THE SOUND PATH IS MADE WHEN THE PAGE OPENS, not when the board starts
//   (the page calls start() at once): the player waits a minute or three for
//   the station, and the main cabinet's sound plays through that wait. The
//   board's ring is this module's from the first moment, so when the board
//   starts it only begins to push: no new context, no new node, nothing that
//   could click or pause the main sound.
// - Sound is on by default, and never starts without the browser having seen
//   the player touch the page: this module only ever ASKS (resume, play), and
//   the browser decides. Until it says yes the page shows a large "Tap for
//   sound" prompt (soundPromptView) and the sound buttons say "Turn sound
//   on". Every key, click and touch end asks again, inside the event handler
//   itself (iPhone Safari takes the request only there), and the first one
//   also plays one silent sample (the iPhone unlock). A controller button
//   does not count for the browser.
// - The browser can take the sound away again: the tab hidden, the screen
//   locked, a phone call (iPhone Safari's 'interrupted' state). Then the
//   prompt comes back, and the page asks again when it is shown again.
// - Mute is a gain of zero, not a suspended context, so the worklet keeps
//   reading and nothing piles up behind the mute.
// - Nothing here can stop the seat: a failure is kept (state().fault, and a
//   note to the page unless the browser simply has no Web Audio) and the seat
//   plays on, silent.
// - The player's choice (muted, level) is kept on this device.
// - What the sound is doing can always be read (state(), window.seat.audio()
//   in the seat page): fed is what the board has put in the ring since the
//   seat started (frames, frames that were not silence, frames dropped, push
//   calls: audio-ring.js counters()), flow the same over the last look of a
//   second or more (frames a second, the share that was not silence), stats
//   the worklet's last report (its buffer, gaps, skips, and peak: the loudest
//   sample it gave the sound card), changes how often the context changed
//   state. Silence with flow.nonZeroPct at 0 is the game's own; frames
//   flowing with sound in them and a peak of 0, or a context not running, is
//   this page's. history is the last things that happened to the sound, in
//   order (context states, gestures that asked, the main sound arriving,
//   playing, being held or paused), lastGesture the last touch that asked and
//   what the context was before it, needsTap whether the prompt is showing.
// - THE SECOND CHANNEL, as in the arcade: the main cabinet's sound (the
//   commentary, the music, the crowd) comes from the room with the main
//   screen's picture (room-main-view.js onAudio), with a mute and a level of
//   its own (setMain, pressMain, setMainLevel; kept on this device under its
//   own key). The page's video element stays muted. It plays one of two ways
//   (state().main.path):
//     'element'  through the page's own audio element for it (mainEl), the
//                browser's ordinary way to play a call's sound: the level is
//                the element's volume and the mute its muted flag. This is
//                the way when the page gives an element. It needs no
//                context, no shared memory and no worklet, so the two
//                channels are independent: either plays without the other.
//                Why not the context: Chrome hands a remote track to Web
//                Audio only as a workaround (while a media element holds it
//                too), and iPhone Safari is known to lose a remote track
//                fed to Web Audio when the app is switched or the stream is
//                replaced, with the context still saying 'running'. On an
//                iPhone the element's volume cannot be set by a page
//                (state().main.levelFixed): the mute works, the level is the
//                phone's own volume buttons.
//     'graph'    through this module's context (a stream source, a gain, the
//                speakers), as before: the way when there is no element, or
//                when the element cannot play the stream at all. peak (the
//                loudest sample just now, before the level) is read here only.
//   A room that sends no sound never calls setMain, and nothing is shown for it.

import { AudioRing, allocateRingBuffer } from './audio-ring.js';
import { RESAMPLER_NAME } from './audio-worklet.js';

export const SEAT_SOUND_KEY = 'doc_room_seat_sound_v1';
export const DEFAULT_SOUND = Object.freeze({ muted: false, level: 1 });
// The main cabinet's sound: its own choice, a little under the seat's own sounds to start with (as audio-mix.js).
export const MAIN_SOUND_KEY = 'doc_room_main_sound_v1';
export const DEFAULT_MAIN_SOUND = Object.freeze({ muted: false, level: 0.8 });
// About 186 ms at the core's 44100 Hz: room for a catch-up burst.
export const SEAT_RING_FRAMES = 8192;
// The seat board hands over one retro_run of audio at a time (about 735
// frames); the worklet keeps the buffer's low point near 768 frames (17 ms).
export const SEAT_AUDIO = Object.freeze({ inRate: 44100, handoverFrames: 735, targetFrames: 768, maxTargetFrames: 2048, boostFrames: 256, boostDecaySeconds: 30, reportEveryFrames: 8820 });
// A click on the sound button this soon after the same gesture woke the
// context is that wake, not a mute.
export const WAKE_PRESS_MS = 800;
// How many lines of history are kept (the newest).
export const SOUND_HISTORY = 32;
// The events a browser counts as the player touching the page (pointerdown and mousedown are asked too: a desktop
// browser counts them; on a touch screen the touch end, the pointer up and the click are the ones that count).
const GESTURES = ['pointerdown', 'pointerup', 'mousedown', 'keydown', 'touchend', 'click'];
const EL_EVENTS = ['playing', 'pause'];

const clamp01 = (v, d) => { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d; };

// The saved choice, or the defaults for anything missing or unreadable (key and defaults: the seat's own sound
// unless the main cabinet's are given).
export function loadSound(storage, key = SEAT_SOUND_KEY, defaults = DEFAULT_SOUND) {
  let saved = null;
  try { const raw = storage ? storage.getItem(key) : null; saved = raw ? JSON.parse(raw) : null; } catch { saved = null; }
  if (!saved || typeof saved !== 'object') return { ...defaults };
  return { muted: saved.muted === true, level: clamp01(saved.level, defaults.level) };
}

// Returns true when the choice was stored.
export function saveSound(storage, s, key = SEAT_SOUND_KEY, defaults = DEFAULT_SOUND) {
  try {
    if (!storage) return false;
    storage.setItem(key, JSON.stringify({ muted: !!(s && s.muted), level: clamp01(s && s.level, defaults.level) }));
    return true;
  } catch { return false; }
}

// What the page's sound button says for a state() (plain words, no codes).
export function soundButtonView(s) {
  if (!s || !s.supported || s.fault) return { text: 'No sound', title: 'Sound is not available in this browser', pressed: false, attn: false, disabled: true };
  if (s.muted) return { text: 'Sound: off', title: 'Sound is off: press to turn it on', pressed: false, attn: false, disabled: false };
  if (s.blocked) return { text: 'Turn sound on', title: 'Your browser is holding the sound: press here, or any key', pressed: false, attn: true, disabled: false };
  return { text: 'Sound: on', title: 'Sound is on: press to mute', pressed: true, attn: false, disabled: false };
}

// What the page's main sound button says for a state(). shown: the button and its level are on the page only once
// the room's sound has arrived (a room that sends none shows nothing). levelFixed: this browser does not let a page
// set the level (an iPhone): the slider is shown switched off, and its title says where the level is.
export function mainButtonView(s) {
  const m = s && s.main;
  const own = !!m && m.path === 'element'; // played by its own element: the seat's own sound path does not matter
  const none = { text: 'Main: none', title: 'The main screen has no sound yet', pressed: false, attn: false, disabled: true, shown: false, levelFixed: false };
  if (!s || !m || !m.attached || (!own && (!s.supported || s.fault))) return none;
  const levelFixed = m.levelFixed === true;
  if (m.muted) return { text: 'Main: off', title: 'The main screen sound is off: press to turn it on', pressed: false, attn: false, disabled: false, shown: true, levelFixed };
  if (own ? m.blocked : s.blocked) return { text: 'Turn sound on', title: 'Your browser is holding the sound: press here, or any key', pressed: false, attn: true, disabled: false, shown: true, levelFixed };
  return { text: 'Main: on', title: 'The main screen sound is on: press to mute', pressed: true, attn: false, disabled: false, shown: true, levelFixed };
}

// The large prompt over the main screen: shown whenever the browser is holding sound the player has not muted.
export function soundPromptView(s) {
  const shown = !!s && s.needsTap === true;
  return { shown, text: 'Tap for sound', title: 'Your browser plays sound only after you touch the page: tap here' };
}

// createSeatAudio({ win, storage, AudioContextImpl, NodeImpl, moduleUrl, onNote, onState, now, mainEl, MediaStreamImpl })
//   source   { buffer, capacityFrames } for the board worker's msg.audio, or null (no shared memory: no sound)
//   start()  make the context and the worklet (once; never throws, resolves true when the sound path is built). The
//            page calls it as soon as it opens; the board's ring is played from then on, whenever the board starts.
//   wake()   ask the browser to run the sound (called by every key, click and touch by itself)
//   unlock() the same, for the page's own "Tap for sound" prompt (call it inside the click handler)
//   press()  the sound button: wakes a held context, else mutes or unmutes
//   setMuted(b), setLevel(0..1), state(), close()
//   setMain(stream or null)  the room's main cabinet sound (a MediaStream with a sound track), or gone
//   pressMain()  the main sound button: wakes held sound, else mutes or unmutes the main sound
//   setMainMuted(b), setMainLevel(0..1)
//   setMainPath('element' | 'graph' | 'auto')  which way the main sound plays (auto: the element when there is one)
//   mark(text)  a line for the history from the page (the board started, the seat ended)
// mainEl: the page's audio element for the main cabinet's sound (none: the main sound plays through the context).
export function createSeatAudio({
  win = globalThis.window, storage, AudioContextImpl, NodeImpl, moduleUrl, onNote = () => {}, onState = () => {}, now = () => Date.now(),
  mainEl = null, MediaStreamImpl = globalThis.MediaStream,
} = {}) {
  if (storage === undefined) { try { storage = win ? win.localStorage : null; } catch { storage = null; } }
  const choice = loadSound(storage);
  const mainChoice = loadSound(storage, MAIN_SOUND_KEY, DEFAULT_MAIN_SOUND);
  const doc = win && win.document && typeof win.document.addEventListener === 'function' ? win.document : null;
  const elOk = !!mainEl && typeof mainEl.play === 'function';
  let mainStream = null;
  let mainSrc = null;
  let mainGain = null;
  let mainTap = null;
  let mainBuf = null;
  let mainFault = null;
  // The element way: on (the element holds the stream), held (the browser has not let it play, or has paused it),
  // refused (the element could not play this stream at all: the context way is used instead).
  let forcedPath = null;
  let elOn = false;
  let elHeld = false;
  let elRefused = false;
  let elPlays = 0;
  let elAsking = false; // a play() the browser has not answered yet
  let levelFixed = false;
  let buffer = null;
  let ring = null;
  try {
    if (typeof SharedArrayBuffer === 'function') { buffer = allocateRingBuffer(SEAT_RING_FRAMES); ring = new AudioRing(buffer, SEAT_RING_FRAMES); }
  } catch { buffer = null; ring = null; }
  const source = buffer ? { buffer, capacityFrames: SEAT_RING_FRAMES } : null;
  let ctx = null;
  let gain = null;
  let node = null;
  let built = false;
  let started = null;
  let closed = false;
  let fault = buffer ? null : 'no shared memory';
  let stats = null;
  let wakeAsked = false;
  let wokeAt = -Infinity;
  let listening = false;
  let changes = 0;
  let seen = null;
  let flow = null;
  let primed = 0;
  let session = null;
  let gestures = 0;
  let lastGesture = null;
  const history = [];

  // One line of history: what happened, and when (this page's clock). The same thing twice in a row is counted, not repeated.
  function log(ev) {
    const last = history[history.length - 1];
    if (last && last.ev === ev) { last.n = (last.n || 1) + 1; last.t = now(); return; }
    history.push({ t: now(), ev });
    if (history.length > SOUND_HISTORY) history.shift();
  }

  // The board's feed over the time since the last look (at least a second apart; no timer of its own).
  function look() {
    if (!ring) return;
    const c = ring.counters();
    const t = now();
    if (!seen) { seen = { t, c }; return; }
    const ms = t - seen.t;
    if (!(ms >= 1000)) return;
    const d = (c.pushed - seen.c.pushed) >>> 0;
    const nz = (c.nonZero - seen.c.nonZero) >>> 0;
    const dr = (c.dropped - seen.c.dropped) >>> 0;
    flow = { perSec: Math.round((d * 1000) / ms), nonZeroPct: d ? Math.round((100 * nz) / d) : 0, droppedPerSec: Math.round((dr * 1000) / ms), ms: Math.round(ms) };
    seen = { t, c };
  }

  const emit = () => { try { onState(state()); } catch { /* the page's own view */ } };
  const note = (t) => { try { onNote(t); } catch { /* the page's own log */ } };
  const running = () => !!ctx && ctx.state === 'running';
  const ctxHeld = () => !!ctx && !closed && ctx.state !== 'running';
  // Which way the main sound plays now.
  const mainPath = () => {
    if (forcedPath === 'graph') return 'graph';
    if (forcedPath === 'element') return elOk ? 'element' : 'graph';
    return elOk && !elRefused ? 'element' : 'graph';
  };
  // The browser is holding sound the player has not muted: the page's prompt shows.
  function needsTap() {
    if (closed) return false;
    const graphMain = !!mainSrc && !mainChoice.muted;
    if (ctxHeld() && ((!choice.muted && (built || !fault)) || graphMain)) return true;
    return elOn && elHeld && !mainChoice.muted;
  }

  function elView() {
    if (!elOk || !elOn) return null;
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
    try { return { paused: !!mainEl.paused, readyState: Number(mainEl.readyState) || 0, time: n(mainEl.currentTime), muted: !!mainEl.muted, volume: n(mainEl.volume) }; } catch { return null; }
  }
  function trackView() {
    try {
      const t = mainStream && typeof mainStream.getAudioTracks === 'function' ? mainStream.getAudioTracks()[0] : null;
      return t ? { muted: !!t.muted, readyState: String(t.readyState), enabled: t.enabled !== false } : null;
    } catch { return null; }
  }

  function state() {
    look();
    const path = !mainStream ? 'none' : elOn ? 'element' : mainSrc ? 'graph' : mainPath();
    const attached = elOn || !!mainSrc;
    return {
      supported: !!source, built, context: ctx ? ctx.state : 'none', blocked: ctxHeld(),
      muted: choice.muted, level: choice.level, fault, rate: ctx ? Number(ctx.sampleRate) || 0 : 0,
      buffered: ring ? ring.available() : 0, stats: stats ? { ...stats } : null,
      fed: ring ? ring.counters() : null, flow: flow ? { ...flow } : null, changes,
      needsTap: needsTap(), gestures, lastGesture: lastGesture ? { ...lastGesture } : null, primed, session,
      history: history.map((h) => ({ ...h })),
      main: {
        attached, waiting: !!mainStream && !attached, muted: mainChoice.muted, level: mainChoice.level, peak: mainPeak(), fault: mainFault,
        path, blocked: elOn ? elHeld : ctxHeld(), levelFixed: elOn && levelFixed, plays: elPlays, element: elView(), track: trackView(),
      },
    };
  }

  // The loudest sample of the main sound just now (the analyser's last block, before the level), or 0.
  function mainPeak() {
    if (!mainTap || !mainSrc || !mainBuf) return 0;
    try {
      mainTap.getFloatTimeDomainData(mainBuf);
      let m = 0;
      for (let i = 0; i < mainBuf.length; i++) { const a = mainBuf[i] < 0 ? -mainBuf[i] : mainBuf[i]; if (a > m) m = a; }
      return Math.round(m * 10000) / 10000;
    } catch { return 0; }
  }
  function applyMainGain() {
    if (elOn) {
      try { mainEl.muted = mainChoice.muted; } catch { /* gone */ }
      try { mainEl.volume = mainChoice.level; } catch { /* not settable here */ }
    }
    if (!mainGain) return;
    const v = mainChoice.muted ? 0 : mainChoice.level;
    try { mainGain.gain.setTargetAtTime(v, ctx.currentTime, 0.02); } catch { try { mainGain.gain.value = v; } catch { /* closed */ } }
  }

  // ---- The element way --------------------------------------------------------------------------------------------
  // Ask the element to play. The browser answers: yes (playing), not yet (NotAllowedError: it wants a touch first, the
  // prompt shows), or never (anything else but a replaced stream: the context way takes over).
  function playEl(gesture = false) {
    if (!elOn || closed) return;
    // One question at a time, unless this one comes from inside a touch (the only one an iPhone hears).
    if (elAsking && !gesture) return;
    let p = null;
    elPlays++;
    try { p = mainEl.play(); } catch (err) { p = Promise.reject(err); }
    if (!p || typeof p.then !== 'function') { if (elHeld) { elHeld = false; log('main playing'); } return; }
    const mine = mainEl.srcObject;
    elAsking = true;
    p.then(() => {
      if (mainEl.srcObject === mine) elAsking = false;
      if (!elOn || mainEl.srcObject !== mine) return;
      if (gesture) wokeAt = now(); // the touch that started it is not also a mute
      if (elHeld) { elHeld = false; log('main playing'); }
      emit();
    }, (err) => {
      if (mainEl.srcObject === mine) elAsking = false;
      if (!elOn || closed || mainEl.srcObject !== mine) return;
      const name = String(err && err.name ? err.name : '');
      if (name === 'AbortError') return; // a newer stream or a newer play() took over
      if (name === 'NotAllowedError') { elHeld = true; log('main held by the browser'); emit(); return; }
      mainFault = String(err && err.message ? err.message : err).slice(0, 80) || 'failed';
      log(`main element refused (${name || 'error'})`);
      elRefused = true;
      connectMain();
      emit();
    });
  }
  const onElEvent = (e) => {
    if (!elOn || closed) return;
    if (e && e.type === 'playing') { if (elHeld) { elHeld = false; log('main playing'); emit(); } return; }
    // Paused by the browser (the screen locked, a phone call, another app's sound): held until it plays again.
    if (!elHeld) { elHeld = true; log('main paused by the browser'); emit(); }
  };
  function elListen(on) {
    if (!elOk || typeof mainEl.addEventListener !== 'function') return;
    for (const t of EL_EVENTS) { if (on) mainEl.addEventListener(t, onElEvent); else mainEl.removeEventListener(t, onElEvent); }
  }
  function attachEl() {
    // The sound alone: the element never holds the picture.
    let s = mainStream;
    try {
      const tracks = typeof mainStream.getAudioTracks === 'function' ? mainStream.getAudioTracks() : null;
      if (tracks && tracks.length && typeof MediaStreamImpl === 'function') s = new MediaStreamImpl(tracks);
    } catch { s = mainStream; }
    elListen(false);
    mainEl.srcObject = s;
    elAsking = false;
    elOn = true;
    elHeld = true; // until the browser says it plays
    applyMainGain();
    // A browser that does not let a page set the level (an iPhone) reads back something else.
    try { levelFixed = Math.abs(Number(mainEl.volume) - mainChoice.level) > 0.01; } catch { levelFixed = false; }
    elListen(true);
    mainFault = null;
    log('main attached (element)');
    playEl();
  }
  function detachEl() {
    if (!elOn) return;
    elOn = false;
    elHeld = false;
    elListen(false);
    try { if (typeof mainEl.pause === 'function') mainEl.pause(); } catch { /* gone */ }
    try { mainEl.srcObject = null; } catch { /* gone */ }
  }

  // ---- The context way -------------------------------------------------------------------------------------------
  function attachGraph() {
    if (!ctx) return; // made with the context (build)
    try {
      if (typeof ctx.createMediaStreamSource !== 'function') throw new Error('no stream source');
      if (!mainGain) {
        mainGain = ctx.createGain();
        try { mainGain.gain.value = mainChoice.muted ? 0 : mainChoice.level; } catch { /* a stub */ }
        mainGain.connect(ctx.destination);
        if (typeof ctx.createAnalyser === 'function') {
          mainTap = ctx.createAnalyser();
          try { mainTap.fftSize = 256; } catch { /* a stub */ }
          mainBuf = new Float32Array(256);
        }
      }
      const s = ctx.createMediaStreamSource(mainStream);
      s.connect(mainGain);
      if (mainTap) s.connect(mainTap);
      mainSrc = s;
      mainFault = null;
      log('main attached (graph)');
    } catch (err) {
      mainSrc = null;
      mainFault = String(err && err.message ? err.message : err).slice(0, 80) || 'failed';
    }
  }
  // Connects the main sound whichever way it plays; a new stream (the view came back) replaces the old one. Never
  // throws: a browser that cannot do it leaves the main sound out (state().main.fault).
  function connectMain() {
    try { if (mainSrc) mainSrc.disconnect(); } catch { /* gone */ }
    mainSrc = null;
    detachEl();
    if (closed || !mainStream) return;
    if (mainPath() === 'element') { try { attachEl(); } catch (err) { detachEl(); elRefused = true; mainFault = String(err && err.message ? err.message : err).slice(0, 80) || 'failed'; attachGraph(); } } else attachGraph();
  }
  function setMain(stream) {
    const had = !!mainStream;
    mainStream = stream || null;
    if (!mainStream && had) log('main gone');
    connectMain();
    if (mainSrc) wake();
    emit();
  }
  function setMainPath(p) {
    forcedPath = p === 'element' || p === 'graph' ? p : null;
    if (forcedPath !== 'graph') elRefused = false;
    connectMain();
    if (mainSrc) wake();
    emit();
  }

  // ---- Asking the browser ------------------------------------------------------------------------------------------
  // The iPhone unlock: one silent sample played inside the touch that asks. Once the context has run it is not needed.
  function prime() {
    if (!ctx || typeof ctx.createBuffer !== 'function' || typeof ctx.createBufferSource !== 'function') return;
    try {
      const s = ctx.createBufferSource();
      s.buffer = ctx.createBuffer(1, 1, 22050);
      s.connect(ctx.destination);
      s.start(0);
      primed++;
    } catch { /* not needed here */ }
  }
  // iPhone Safari (16.4 and later): the page's sound is a game's, so it plays with the ringer switch off, as the main
  // cabinet's own element already does. Asked for once, inside a touch.
  function playbackSession() {
    if (session !== null) return;
    try {
      const s = win && win.navigator ? win.navigator.audioSession : null;
      if (!s) { session = 'none'; return; }
      s.type = 'playback';
      session = String(s.type);
    } catch { session = 'refused'; }
  }
  // gesture: this call is inside the browser's own event for a key, a click or a touch.
  function wake(gesture = false) {
    if (closed) return;
    if (ctx && !running()) {
      const never = changes === 0; // the context has not run yet
      wakeAsked = true;
      try { const p = ctx.resume(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch { /* not allowed yet: the next gesture */ }
      if (gesture && never && primed < 3) prime();
    }
    if (gesture) playbackSession();
    if (elOn && elHeld) playEl(gesture);
  }
  const onGesture = (e) => {
    // Nothing held: nothing to do (this runs on every key and touch of a race).
    if (closed || !(ctxHeld() || (elOn && elHeld))) return;
    gestures++;
    lastGesture = { type: String(e && e.type ? e.type : ''), at: now(), context: ctx ? ctx.state : 'none', main: elOn ? (elHeld ? 'held' : 'playing') : 'none' };
    log(`gesture ${lastGesture.type}`);
    wake(true);
  };
  const onVisible = () => {
    if (closed || !doc) return;
    if (doc.visibilityState === 'hidden') { log('page hidden'); return; }
    log('page shown');
    wake(false); // the browser may give the sound back by itself; if not, the prompt is showing
    emit();
  };
  function listen(on) {
    if (!win || typeof win.addEventListener !== 'function' || typeof win.removeEventListener !== 'function' || listening === on) return;
    listening = on;
    for (const t of GESTURES) {
      if (on) win.addEventListener(t, onGesture, { capture: true, passive: true });
      else win.removeEventListener(t, onGesture, { capture: true });
    }
    if (doc) { if (on) doc.addEventListener('visibilitychange', onVisible); else doc.removeEventListener('visibilitychange', onVisible); }
  }
  function applyGain() {
    if (!gain) return;
    const v = choice.muted ? 0 : choice.level;
    try { gain.gain.setTargetAtTime(v, ctx.currentTime, 0.02); } catch { try { gain.gain.value = v; } catch { /* closed */ } }
  }

  async function build() {
    const Ctx = AudioContextImpl || (win && (win.AudioContext || win.webkitAudioContext)) || globalThis.AudioContext;
    const Node = NodeImpl || (win && win.AudioWorkletNode) || globalThis.AudioWorkletNode;
    // The touches are listened for whatever comes next: the main cabinet's own element needs them too.
    listen(true);
    if (!source) return false;
    if (typeof Ctx !== 'function' || typeof Node !== 'function') { fault = 'no Web Audio'; emit(); return false; }
    // The sound card's own rate: the worklet converts from the core's 44100 Hz itself.
    ctx = new Ctx({ latencyHint: 'interactive' });
    log(`context ${ctx.state}`);
    if (typeof ctx.addEventListener === 'function') {
      ctx.addEventListener('statechange', () => {
        changes++;
        log(`context ${ctx.state}`);
        if (running() && wakeAsked) { wakeAsked = false; wokeAt = now(); }
        emit();
      });
    }
    wake();
    // The main sound, when it plays through the context, needs only the context: it does not wait for the worklet.
    if (mainStream && !elOn && !mainSrc) connectMain();
    emit();
    await ctx.audioWorklet.addModule(moduleUrl || new URL('./audio-worklet.js', import.meta.url));
    if (closed) return false;
    node = new Node(ctx, RESAMPLER_NAME, {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { buffer, capacityFrames: SEAT_RING_FRAMES, outRate: ctx.sampleRate, ...SEAT_AUDIO },
    });
    if (node.port) node.port.onmessage = (e) => { if (e && e.data) stats = { ...e.data }; };
    gain = ctx.createGain();
    try { gain.gain.value = choice.muted ? 0 : choice.level; } catch { /* a stub */ }
    node.connect(gain);
    gain.connect(ctx.destination);
    built = true;
    log('seat sound path built');
    wake();
    emit();
    return true;
  }

  function start() {
    if (started) return started;
    started = closed ? Promise.resolve(false) : build().catch((err) => {
      fault = String(err && err.message ? err.message : err).slice(0, 80) || 'failed';
      note(`sound not started (${fault})`);
      emit();
      return false;
    });
    return started;
  }

  function setMuted(m) { choice.muted = !!m; saveSound(storage, choice); applyGain(); emit(); }
  function setLevel(v) { choice.level = clamp01(v, choice.level); saveSound(storage, choice); applyGain(); emit(); }
  function press() {
    if (closed || !ctx) return;
    if (!running()) { wake(true); return; }
    if (now() - wokeAt < WAKE_PRESS_MS) return;
    setMuted(!choice.muted);
  }
  function setMainMuted(m) { mainChoice.muted = !!m; saveSound(storage, mainChoice, MAIN_SOUND_KEY, DEFAULT_MAIN_SOUND); applyMainGain(); emit(); }
  function setMainLevel(v) { mainChoice.level = clamp01(v, mainChoice.level); saveSound(storage, mainChoice, MAIN_SOUND_KEY, DEFAULT_MAIN_SOUND); applyMainGain(); emit(); }
  function pressMain() {
    if (closed) return;
    if (elOn) {
      // Unmuting is a touch too: a held element is asked again inside it.
      if (elHeld) { wake(true); if (!mainChoice.muted) return; }
    } else {
      if (!ctx) return;
      if (!running()) { wake(true); return; }
    }
    if (now() - wokeAt < WAKE_PRESS_MS) return;
    setMainMuted(!mainChoice.muted);
  }
  function unlock() { if (closed) return; log('prompt pressed'); wake(true); emit(); }
  function mark(text) { log(String(text).slice(0, 60)); }
  function close() {
    if (closed) return;
    log('closed');
    closed = true;
    listen(false);
    try { if (node) node.disconnect(); } catch { /* gone */ }
    try { if (mainSrc) mainSrc.disconnect(); } catch { /* gone */ }
    mainSrc = null;
    detachEl();
    try { const p = ctx && ctx.close(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch { /* closed */ }
    emit();
  }

  return { source, start, wake, unlock, press, setMuted, setLevel, state, close, setMain, pressMain, setMainMuted, setMainLevel, setMainPath, mark };
}
