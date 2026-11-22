// room-main-view.js: the room seat shows its room's main screen (M3, option A step 2).
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Each room publishes its race screen once (room-main-publish.js) to its host's room media server as room-<tag>. The
// seat plays it, read only, over WHEP from the room host it already signals to: https://<signal host>/rooms/media/
// room-<tag>/whep. The player's own board stays in this page (no lag on the player's own screen and keys); only the
// shared main screen arrives as video, as the cabinet seat's mains do today.
//
// - Non-trickle: the offer carries this browser's candidates (ICE gathered first), so the media server checks out to
//   us first and a firewall that drops unsolicited inbound UDP lets the answers in; no follow-up PATCH is needed
//   (through tailscale serve its path would lose the /rooms/media prefix).
// - Receive only: no track of this page is ever sent. Reaches only the seat's own signal host (validated by the hand-off
//   code), its own room's path. A view that fails retries with a back-off and never touches the seat.

import { isHostName } from './mp-public.js';

const TAG_RE = /^[0-9a-f]{8}$/;
export function mainWhepUrl(signalHost, tag) {
  const h = typeof signalHost === 'string' ? signalHost.toLowerCase() : '';
  if (!isHostName(h) || !TAG_RE.test(String(tag))) return null;
  return `https://${h}/rooms/media/room-${tag}/whep`;
}

// A browser that can play the view at all (a seat page without WebRTC simply has no main screen).
export const mainViewSupported = () => typeof globalThis.RTCPeerConnection === 'function';

export const VIEW_DEFAULTS = Object.freeze({ iceWaitMs: 3000, retryMinMs: 2000, retryMaxMs: 20000 });

// createMainView({ video, whepUrl, RTC, fetchImpl, setTimer, clearTimer, log }): { start(), stop(), state() }.
export function createMainView({
  video, whepUrl, iceServers = [], RTC = globalThis.RTCPeerConnection, fetchImpl = (...a) => globalThis.fetch(...a), MediaStreamImpl = globalThis.MediaStream,
  setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t), log = () => {},
} = {}) {
  if (!video || !whepUrl || typeof RTC !== 'function') throw new Error('main view: missing video, WHEP url or WebRTC');
  const st = { state: 'idle', attempts: 0, connects: 0, lastError: null };
  let pc = null;
  let session = null;
  let retryTimer = null;
  let retryMs = VIEW_DEFAULTS.retryMinMs;
  let stopped = false;

  function closePc() { if (pc) { try { pc.close(); } catch { /* closed */ } pc = null; } }
  function retry(why) {
    st.lastError = String(why).slice(0, 120);
    st.state = 'retrying';
    closePc();
    session = null;
    if (stopped || retryTimer !== null) return;
    retryTimer = setTimer(() => { retryTimer = null; start(); }, retryMs);
    retryMs = Math.min(VIEW_DEFAULTS.retryMaxMs, retryMs * 2);
  }
  const gathered = (p) => new Promise((resolve) => {
    if (p.iceGatheringState === 'complete') { resolve(); return; }
    const t = setTimer(resolve, VIEW_DEFAULTS.iceWaitMs);
    p.addEventListener('icegatheringstatechange', () => { if (p.iceGatheringState === 'complete') { clearTimer(t); resolve(); } });
  });

  async function start() {
    if (stopped || pc) return;
    st.attempts++;
    st.state = 'connecting';
    // iceServers (a list, or a function giving one for this attempt): STUN so the viewer names its public address in
    // the offer (non-trickle), which a media server behind a router or reached through a relay needs to answer it.
    const ice = typeof iceServers === 'function' ? iceServers() : iceServers;
    const p = new RTC({ iceServers: Array.isArray(ice) ? ice : [] });
    pc = p;
    try {
      p.addTransceiver('video', { direction: 'recvonly' });
      p.addEventListener('track', (e) => {
        if (pc !== p) return;
        video.srcObject = e.streams && e.streams[0] ? e.streams[0] : (MediaStreamImpl ? new MediaStreamImpl([e.track]) : null);
        const play = video.play && video.play();
        if (play && typeof play.catch === 'function') play.catch(() => {});
      });
      p.addEventListener('connectionstatechange', () => {
        if (pc !== p) return;
        if (p.connectionState === 'connected') { st.state = 'live'; st.connects++; retryMs = VIEW_DEFAULTS.retryMinMs; log('main view: live'); }
        else if (p.connectionState === 'failed' || p.connectionState === 'disconnected' || p.connectionState === 'closed') retry(`connection ${p.connectionState}`);
      });
      await p.setLocalDescription(await p.createOffer());
      await gathered(p);
      if (pc !== p) return;
      const res = await fetchImpl(whepUrl, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: p.localDescription.sdp });
      if (pc !== p) return;
      // 404: the room has not published yet (it is still booting); the back-off tries again.
      if (res.status !== 201) { retry(`WHEP ${res.status}`); return; }
      const loc = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
      // The session id is the location's last part; it is addressed under our own WHEP url (the prefix-safe form).
      const id = loc ? String(loc).split('/').pop() : '';
      session = /^[A-Za-z0-9-]{1,64}$/.test(id) ? `${whepUrl}/${id}` : null;
      await p.setRemoteDescription({ type: 'answer', sdp: await res.text() });
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
