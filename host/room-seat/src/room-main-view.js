// room-main-view.js: the room seat shows its room's main screen (M3, option A step 2).
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Each room publishes its race screen once (room-main-publish.js) to its host's room media server as room-<tag>. The
// seat plays it, read only, over WHEP from the room host it already signals to: https://<signal host>/rooms/media/
// room-<tag>/whep. The player's own board stays in this page (no lag on the player's own screen and keys); only the
// shared main screen arrives as video, as the cabinet seat's mains do today, and with it the main cabinet's sound
// when the room publishes it (one more track on the same connection, handed to the page: see createMainView).
//
// - Non-trickle: the offer carries this browser's candidates (ICE gathered first), so the media server checks out to
//   us first and a firewall that drops unsolicited inbound UDP lets the answers in; no follow-up PATCH is needed
//   (through tailscale serve its path would lose the /rooms/media prefix).
// - Receive only: no track of this page is ever sent. Reaches only the seat's own signal host (validated by the hand-off
//   code), its own room's path. A view that fails retries with a back-off and never touches the seat.
// - A fast start, and a prompt retry (the seat test of 2026-11-24: the first attempt was hung up by the media server
//   after its 10 s, the page noticed only when the browser gave the connection up some 30 s later, and the picture was
//   black for 30 to 45 s). The page now keeps its own time: an offer goes as soon as a relay candidate is in it (it
//   does not wait for the whole gathering); an attempt that is not connected in time is ended by the page and made
//   again after 1 s, then 2, 4, 8 and at most 10 s; an attempt whose offer had no relay candidate, where a relay is
//   set up, is given 4 s only (a direct path connects in a second or not at all), and the next attempt waits longer
//   for its relay candidate. state() says what each offer carried (offer: host, srflx, relay, gatherMs).

import { isHostName } from './mp-public.js';

const TAG_RE = /^[0-9a-f]{8}$/;
export function mainWhepUrl(signalHost, tag) {
  const h = typeof signalHost === 'string' ? signalHost.toLowerCase() : '';
  if (!isHostName(h) || !TAG_RE.test(String(tag))) return null;
  return `https://${h}/rooms/media/room-${tag}/whep`;
}

// A browser that can play the view at all (a seat page without WebRTC simply has no main screen).
export const mainViewSupported = () => typeof globalThis.RTCPeerConnection === 'function';

// iceWaitMs: how long an offer waits for its candidates; relayWaitMs: the same once an attempt without a relay
// candidate has failed; relayGraceMs: what a relay candidate is given for the others to come; connectMs: an attempt
// must be connected this long after its answer (the media server hangs up at 10 s, so nothing connects after that);
// directMs: the same for an offer that had no relay candidate where a relay is set up.
export const VIEW_DEFAULTS = Object.freeze({ iceWaitMs: 3000, relayWaitMs: 8000, relayGraceMs: 200, connectMs: 11000, directMs: 4000, retryMinMs: 1000, retryMaxMs: 10000 });
const RELAY_RE = / typ relay(?: |$)/m;
const hasTurn = (ice) => (Array.isArray(ice) ? ice : []).some((s) => (Array.isArray(s && s.urls) ? s.urls : [s && s.urls]).some((u) => /^turns?:/i.test(String(u || ''))));
/** What kinds of candidates a session description carries: { host, srflx, relay }. */
export function candidateKinds(sdp) {
  const n = { host: 0, srflx: 0, relay: 0 };
  for (const m of String(sdp || '').matchAll(/^a=candidate:.* typ (host|srflx|relay)(?: |$)/gm)) n[m[1]]++;
  return n;
}

// The main cabinet's sound is stereo. Opus is sent and decoded in two channels only when the session description asks
// for it (stereo=1 on the Opus format line; sprop-stereo=1 says the sender will send it): this adds both where they
// are missing and changes nothing else. A description with no Opus comes back as it was.
export function opusStereo(sdp) {
  if (typeof sdp !== 'string') return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(eol);
  const pts = lines.map((l) => /^a=rtpmap:(\d+) opus\/48000\/2$/i.exec(l)).filter(Boolean).map((m) => m[1]);
  for (const pt of pts) {
    const want = (l) => l + (/[;= ]stereo=1/.test(l) ? '' : ';stereo=1') + (/sprop-stereo=1/.test(l) ? '' : ';sprop-stereo=1');
    const i = lines.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
    if (i >= 0) lines[i] = want(lines[i]);
    else lines.splice(lines.findIndex((l) => l.toLowerCase().startsWith(`a=rtpmap:${pt} opus/`)) + 1, 0, `a=fmtp:${pt} stereo=1;sprop-stereo=1`);
  }
  return lines.join(eol);
}

// createMainView({ video, whepUrl, audio, onAudio, RTC, fetchImpl, setTimer, clearTimer, now, log }): { start(), stop(), state() }.
// audio (default on): the room's main cabinet sound is asked for too. It is never played by the video element (the
// page keeps that muted): onAudio(stream) hands the page the stream that carries it, for its own sound path
// (room-seat-audio.js setMain), and onAudio(null) says it is gone. A room that publishes no sound simply never calls it.
export function createMainView({
  video, whepUrl, iceServers = [], RTC = globalThis.RTCPeerConnection, fetchImpl = (...a) => globalThis.fetch(...a), MediaStreamImpl = globalThis.MediaStream,
  setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t), log = () => {}, audio = true, onAudio = () => {}, now = () => Date.now(),
} = {}) {
  if (!video || !whepUrl || typeof RTC !== 'function') throw new Error('main view: missing video, WHEP url or WebRTC');
  const st = { state: 'idle', attempts: 0, connects: 0, lastError: null, audio: false, offer: null };
  let pc = null;
  let session = null;
  let retryTimer = null;
  let retryMs = VIEW_DEFAULTS.retryMinMs;
  let stopped = false;
  let connectTimer = null;
  // An attempt whose offer had no relay candidate was not connected in time: the next one waits longer for its own.
  let needRelay = false;

  const tellAudio = (s) => { st.audio = !!s; try { onAudio(s); } catch { /* the page's own sound path */ } };
  function closePc() { if (connectTimer !== null) { clearTimer(connectTimer); connectTimer = null; } if (pc) { try { pc.close(); } catch { /* closed */ } pc = null; if (st.audio) tellAudio(null); } }
  function retry(why) {
    st.lastError = String(why).slice(0, 120);
    st.state = 'retrying';
    closePc();
    session = null;
    if (stopped || retryTimer !== null) return;
    retryTimer = setTimer(() => { retryTimer = null; start(); }, retryMs);
    retryMs = Math.min(VIEW_DEFAULTS.retryMaxMs, retryMs * 2);
  }
  // The offer's candidates: all of them (gathering complete), or, where a relay is set up, as soon as a relay
  // candidate is there (the rest of the gathering can take many seconds when one STUN server does not answer), or
  // what there is when the wait runs out.
  const gathered = (p, turn) => new Promise((resolve) => {
    if (p.iceGatheringState === 'complete') { resolve(); return; }
    let done = false;
    let grace = null;
    const t = setTimer(() => end(), turn && needRelay ? VIEW_DEFAULTS.relayWaitMs : VIEW_DEFAULTS.iceWaitMs);
    function end() { if (done) return; done = true; clearTimer(t); if (grace !== null) clearTimer(grace); resolve(); }
    p.addEventListener('icegatheringstatechange', () => { if (p.iceGatheringState === 'complete') end(); });
    if (turn) p.addEventListener('icecandidate', (e) => {
      const c = e && e.candidate;
      if (done || grace !== null || !c || !(c.type === 'relay' || RELAY_RE.test(String(c.candidate || '')))) return;
      grace = setTimer(() => end(), VIEW_DEFAULTS.relayGraceMs);
    });
  });

  async function start() {
    if (stopped || pc) return;
    st.attempts++;
    st.state = 'connecting';
    // iceServers (a list, or a function giving one for this attempt): STUN so the viewer names its public address in
    // the offer (non-trickle), which a media server behind a router or reached through a relay needs to answer it.
    const ice = typeof iceServers === 'function' ? iceServers() : iceServers;
    const p = new RTC({ iceServers: Array.isArray(ice) ? ice : [] });
    const turn = hasTurn(ice);
    pc = p;
    try {
      p.addTransceiver('video', { direction: 'recvonly' });
      if (audio) p.addTransceiver('audio', { direction: 'recvonly' });
      const tracks = [];
      p.addEventListener('track', (e) => {
        if (pc !== p) return;
        if (e.track && !tracks.includes(e.track)) tracks.push(e.track);
        // One stream with the picture and the sound on the (muted) video element: Chrome hands a remote sound track
        // to Web Audio only while a media element holds it too.
        const ms = e.streams && e.streams[0] ? e.streams[0] : (MediaStreamImpl ? new MediaStreamImpl(tracks) : null);
        if (video.srcObject !== ms) video.srcObject = ms;
        const play = video.play && video.play();
        if (play && typeof play.catch === 'function') play.catch(() => {});
        if (audio && ms && e.track && e.track.kind === 'audio') {
          // A room that publishes no sound still answers the request with a track, one that never carries anything
          // (measured). The browser keeps such a track muted until the first sound packet: the page is told then.
          const t = e.track;
          if (t.muted === true && typeof t.addEventListener === 'function') t.addEventListener('unmute', () => { if (pc === p) tellAudio(video.srcObject || ms); }, { once: true });
          else tellAudio(ms);
        }
      });
      p.addEventListener('connectionstatechange', () => {
        if (pc !== p) return;
        if (p.connectionState === 'connected') {
          st.state = 'live'; st.connects++; retryMs = VIEW_DEFAULTS.retryMinMs; needRelay = false; log('main view: live');
          if (connectTimer !== null) { clearTimer(connectTimer); connectTimer = null; }
        }
        else if (p.connectionState === 'failed' || p.connectionState === 'disconnected' || p.connectionState === 'closed') retry(`connection ${p.connectionState}`);
      });
      const made = await p.createOffer();
      let offer = made;
      if (audio && made && typeof made.sdp === 'string') { const s = opusStereo(made.sdp); if (s !== made.sdp) offer = { type: made.type, sdp: s }; }
      // A browser that will not take the stereo request plays the offer as it made it (the sound then arrives in one channel).
      try { await p.setLocalDescription(offer); } catch (err) { if (offer === made) throw err; await p.setLocalDescription(made); }
      const t0 = now();
      await gathered(p, turn);
      if (pc !== p) return;
      const kinds = candidateKinds(p.localDescription.sdp);
      st.offer = { ...kinds, gatherMs: Math.round(now() - t0) };
      const res = await fetchImpl(whepUrl, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: p.localDescription.sdp });
      if (pc !== p) return;
      // 404: the room has not published yet (it is still booting); the back-off tries again.
      if (res.status !== 201) { retry(`WHEP ${res.status}`); return; }
      const loc = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
      // The session id is the location's last part; it is addressed under our own WHEP url (the prefix-safe form).
      const id = loc ? String(loc).split('/').pop() : '';
      session = /^[A-Za-z0-9-]{1,64}$/.test(id) ? `${whepUrl}/${id}` : null;
      await p.setRemoteDescription({ type: 'answer', sdp: await res.text() });
      if (pc !== p || p.connectionState === 'connected') return;
      // The page's own time for the connection (the browser gives a connection up only after half a minute).
      const direct = turn && kinds.relay === 0;
      connectTimer = setTimer(() => {
        connectTimer = null;
        if (pc !== p || p.connectionState === 'connected') return;
        if (direct) needRelay = true;
        retry(direct ? 'not connected in time (no relay candidate in the offer)' : 'not connected in time');
      }, direct ? VIEW_DEFAULTS.directMs : VIEW_DEFAULTS.connectMs);
    } catch (err) {
      if (pc === p) retry(err && err.message ? err.message : err);
    }
  }

  function stop() {
    stopped = true;
    if (retryTimer !== null) { clearTimer(retryTimer); retryTimer = null; }
    const s = session;
    session = null;
    closePc();
    st.state = 'stopped';
    try { video.srcObject = null; } catch { /* gone */ }
    if (s) fetchImpl(s, { method: 'DELETE' }).catch(() => {});
  }

  return { start, stop, state: () => ({ ...st }) };
}
