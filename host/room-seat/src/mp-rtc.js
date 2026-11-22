// mp-rtc.js: LAB ONLY (multiplayer room M2, doc-ops MULTIPLAYER_SERVER.md
// 3.2, 3.4). The transport between a room page and one seat page: a WebRTC
// peer connection with two DataChannels,
//   'frm'  unordered, unreliable (maxRetransmits 0): slot frames up and
//          assembled frames down, newest wins, never blocks behind a loss;
//   'ctl'  ordered, reliable: ticket hand-over, welcome, card, card writes and
//          acks, the shadow log, close.
// It runs on the page (DataChannels are not available in workers here) and
// bridges both channels to the link worker through a MessagePort, so the
// worker keeps its own clock and never touches the network itself.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// LAN only: iceServers is always empty (no STUN, no TURN), every local and
// remote ICE candidate must pass the LAN allowlist (mp-lan.js; IPv4
// literals only, no .local names), every remote description is rebuilt by
// the strict sanitizer (allow.sdp: CRLF only, unknown candidate forms
// refused), and once the channels open the selected candidate pair is read
// back from getStats and the link closed if either end is not allowlisted.
// The signalling socket goes only to an allowlisted ws: address.
// Flood limits (room side): per-seat token buckets on each channel and a
// size cap per message; a seat that keeps overrunning them is closed.
//
// Port protocol (page <-> link worker):
//   page -> worker: { type: 'open' } | { type: 'closed', reason } | { ch: 'frm' | 'ctl', data: ArrayBuffer }
//   worker -> page: { ch, data } (send) | { type: 'close' }

const FRM_HIGH_WATER = 64 * 1024; // above this the newest-wins channel drops instead of queueing
// Per-seat receive limits on the room side: frames at about 2x 60 Hz, the
// control channel at 40 a second (shadow log batches are 10 a second), and
// a size cap per message. Over the limit a message is dropped; more than
// MAX_DROPS_PER_S drops within any sliding one-second window closes the
// seat.
export const RX_LIMITS = Object.freeze({ frm: { rate: 120, burst: 60, maxBytes: 2048 }, ctl: { rate: 40, burst: 40, maxBytes: 16384 } });
const MAX_DROPS_PER_S = 60;
const PAIR_RECHECK_MS = 2000;
const PAIR_RETRY_MS = 500;
const PAIR_MISSES_MAX = 2;
// Control messages that arrive after the far side has verified its pair but
// before this side has (the far side's first message, such as the seat's
// hello, can beat this side's own getStats check over a real network) are
// held, at most EARLY_CTL_MAX of them, and handed on in order once this side
// has verified; they are dropped if it never does. Nothing reaches the worker
// before the pair is verified. Frames that arrive early are dropped.
const EARLY_CTL_MAX = 8;
// Remote ICE candidates taken per link (trickled); more are dropped, so a
// peer cannot make this end send checks to a long list of addresses.
const REMOTE_CANDS_MAX = 32;

// A sliding-window counter: hit() records one event and returns true once
// more than max events fall within the last windowMs.
export function createDropWindow(max = MAX_DROPS_PER_S, windowMs = 1000, now = () => performance.now()) {
  const times = [];
  return {
    hit() {
      const t = now();
      while (times.length && t - times[0] >= windowMs) times.shift();
      times.push(t);
      return times.length > max;
    },
    get count() { return times.length; },
  };
}

export function createBucket({ rate, burst }, now = () => performance.now()) {
  let tokens = burst;
  let last = now();
  return {
    take() {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - last) * rate) / 1000);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

// The signalling socket to the room supervisor (tools/mp-supervisor.mjs).
// Returns { send(obj), close(), onmessage, onclose } or throws if the URL is
// not an allowlisted ws: address.
export function openSignal(url, allow) {
  const u = allow.signalUrl(url);
  if (!u) throw new Error('signalling only to an allowlisted LAN address (ws://<ip>:<port>/mp)');
  const ws = new WebSocket(u.href);
  const s = { onmessage: () => {}, onclose: () => {}, onopen: () => {}, open: false };
  const queue = [];
  ws.onopen = () => { s.open = true; for (const m of queue.splice(0)) ws.send(m); s.onopen(); };
  ws.onmessage = (ev) => { if (typeof ev.data === 'string') { try { s.onmessage(JSON.parse(ev.data)); } catch { /* not JSON */ } } };
  ws.onclose = () => { s.open = false; s.onclose(); };
  s.send = (obj) => { const t = JSON.stringify(obj); if (s.open) ws.send(t); else queue.push(t); };
  s.close = () => ws.close();
  return s;
}

// The selected candidate pair's two ends (address, blank when the browser
// hides it, and candidate type), once connected; null when not found.
async function selectedPair(pc) {
  const st = await pc.getStats();
  let pairId = null;
  st.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId; });
  if (!pairId) st.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pairId = r.id; });
  const pair = pairId && st.get(pairId);
  if (!pair) return null;
  const l = st.get(pair.localCandidateId);
  const r = st.get(pair.remoteCandidateId);
  if (!l || !r) return null;
  return { local: l.address || l.ip || '', remote: r.address || r.ip || '', localType: l.candidateType || '', remoteType: r.candidateType || '' };
}

// createPeerLink({ role, allow, signal, port, slot, log }): role 'seat'
// offers and creates the channels; role 'room' answers. signal(obj) sends a
// signalling message. Returns { offer(ticket), onSignal(msg), close(), stats }.
// netem (lab only, mp-netem.js): when given, every verified message in and
// every message out waits on it first.
export function createPeerLink({ role, allow, signal, port, slot, log = () => {}, netem = null }) {
  // LAN policy: no ICE servers ever. Public policy (mp-public.js, M3 W2):
  // the seat's short-lived STUN and TURN from its ticket, the room's STUN.
  const pc = new RTCPeerConnection({ iceServers: Array.isArray(allow.iceServers) ? allow.iceServers : [], iceCandidatePoolSize: 0 });
  // What this end sends may be held to a stricter rule than what it takes.
  // localLine (public policy) may also rewrite the line it lets through.
  const localLine = (line) => (allow.localLine ? allow.localLine(line) : (allow.localCandidate ? allow.localCandidate(line) : allow.candidate(line)) ? line : null);
  const localSdp = (text) => (allow.localSdp ? allow.localSdp(text) : allow.sdp(text));
  const ch = { frm: null, ctl: null };
  const stats = { localCands: 0, localFiltered: 0, remoteCands: 0, remoteFiltered: 0, frmDropped: 0, frmSent: 0, ctlSent: 0, rx: 0, rxLimited: 0, rxOversize: 0, sdpRefused: 0, pair: null, state: 'new' };
  let opened = false;
  let closed = false;
  let discarded = false;
  // verified: the selected pair has been checked; only then do messages
  // flow. Separate from stats.state, which follows every connection change.
  let verified = false;
  let recheck = null;
  const early = [];
  const limit = role === 'room' ? { frm: createBucket(RX_LIMITS.frm), ctl: createBucket(RX_LIMITS.ctl) } : null;
  // Sliding window over the drops of the last second.
  const drops = createDropWindow();
  const dropped = () => { if (drops.hit()) close('flood'); };
  // A selected pair briefly missing from getStats is tolerated once: the
  // link closes when it is missing on PAIR_MISSES_MAX checks in a row, or at
  // once when the pair is off the allowlist.
  let pairMisses = 0;
  // Check the pair the browser has selected; close unless both ends are
  // allowlisted (LAN), or unless the policy's pairOk takes it (public: the
  // far end only, see mp-public.js). Run when the channels open, on every change of the
  // selected pair, and every PAIR_RECHECK_MS.
  // Returns 'ok', 'missing' (tolerated, try again) or 'bad' (closed).
  const checkPair = () => selectedPair(pc).catch(() => null).then((p) => {
    if (closed) return 'bad';
    if (!p || (!allow.pairOk && (!p.local || !p.remote))) {
      stats.pairMissing = (stats.pairMissing || 0) + 1;
      if (++pairMisses >= PAIR_MISSES_MAX) { log(`[rtc] slot ${slot} ${role} selected pair missing, closing`); close('pair unknown'); return 'bad'; }
      return 'missing';
    }
    pairMisses = 0;
    stats.pair = p;
    const good = allow.pairOk ? allow.pairOk({ address: p.local, type: p.localType }, { address: p.remote, type: p.remoteType }) : allow.hasIp(p.local) && allow.hasIp(p.remote);
    if (!good) { log(`[rtc] slot ${slot} ${role} selected pair not allowlisted, closing`); close('pair not allowlisted'); return 'bad'; }
    return 'ok';
  });
  const close = (reason) => {
    if (closed) return;
    closed = true;
    verified = false;
    early.length = 0;
    clearInterval(recheck);
    try { pc.close(); } catch { /* closed */ }
    port.postMessage({ type: 'closed', reason });
  };
  // One channel per label, with the agreed options: frm unordered with no
  // retransmits, ctl ordered and reliable. Anything else closes the link.
  const shapeOk = (c) => (c.label === 'frm' ? c.ordered === false && c.maxRetransmits === 0 : c.label === 'ctl' && c.ordered === true && c.maxRetransmits === null && c.maxPacketLifeTime === null);
  const wire = (c) => {
    if (ch[c.label] || !shapeOk(c)) { stats.badChannels = (stats.badChannels || 0) + 1; try { c.close(); } catch { /* gone */ } close('bad channel'); return; }
    c.binaryType = 'arraybuffer';
    ch[c.label] = c;
    c.onopen = () => {
      if (!opened && ch.frm && ch.ctl && ch.frm.readyState === 'open' && ch.ctl.readyState === 'open') {
        opened = true;
        // Check the pair the browser actually chose before anything flows
        // (a missing pair is asked again after PAIR_RETRY_MS).
        const first = () => checkPair().then((r) => {
          if (r === 'missing' && !closed) { setTimeout(first, PAIR_RETRY_MS); return; }
          if (r !== 'ok' || closed) return;
          verified = true;
          stats.verified = true;
          port.postMessage({ type: 'open' });
          for (const d of early.splice(0)) { if (netem) netem.schedule('in', 'ctl', () => deliver('ctl', d)); else deliver('ctl', d); }
          log(`[rtc] slot ${slot} ${role} channels open`);
          recheck = setInterval(checkPair, PAIR_RECHECK_MS);
          const ice = pc.sctp && pc.sctp.transport && pc.sctp.transport.iceTransport;
          if (ice && 'onselectedcandidatepairchange' in ice) ice.onselectedcandidatepairchange = () => { checkPair(); };
        });
        first();
      }
    };
    c.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer) || closed) return;
      if (!verified) { holdEarly(c.label, ev.data); return; }
      if (netem) { const d = ev.data; netem.schedule('in', c.label, () => deliver(c.label, d)); return; }
      deliver(c.label, ev.data);
    };
    c.onclose = () => close(`${c.label} closed`);
  };
  // Held, not delivered: see EARLY_CTL_MAX.
  const holdEarly = (label, data) => {
    if (label === 'ctl' && early.length < EARLY_CTL_MAX && data.byteLength <= RX_LIMITS.ctl.maxBytes) { early.push(data); stats.rxEarly = (stats.rxEarly || 0) + 1; return; }
    stats.rxEarlyDropped = (stats.rxEarlyDropped || 0) + 1;
    dropped(); // a flood before verification counts like one after it
  };
  const deliver = (label, data) => {
    if (!verified || closed) return;
    if (limit) {
      const lim = RX_LIMITS[label];
      if (data.byteLength > lim.maxBytes) { stats.rxOversize++; dropped(); return; }
      if (!limit[label].take()) { stats.rxLimited++; dropped(); return; }
    }
    stats.rx++;
    port.postMessage({ ch: label, data }, [data]);
  };
  if (role === 'seat') {
    wire(pc.createDataChannel('ctl', { ordered: true }));
    wire(pc.createDataChannel('frm', { ordered: false, maxRetransmits: 0 }));
  } else {
    pc.ondatachannel = (ev) => wire(ev.channel);
  }
  pc.onicecandidate = (ev) => {
    if (closed || !ev.candidate || !ev.candidate.candidate) return;
    const line = localLine(ev.candidate.candidate);
    if (line === null) { stats.localFiltered++; return; }
    stats.localCands++;
    signal({ t: 'ice', slot, cand: { candidate: line, sdpMid: ev.candidate.sdpMid, sdpMLineIndex: ev.candidate.sdpMLineIndex } });
  };
  pc.onconnectionstatechange = () => {
    stats.state = pc.connectionState;
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') close(`peer ${pc.connectionState}`);
  };
  port.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'close') { close('worker'); return; }
    const out = () => {
      const c = ch[m.ch];
      if (closed || !c || c.readyState !== 'open') return;
      if (m.ch === 'frm' && c.bufferedAmount > FRM_HIGH_WATER) { stats.frmDropped++; return; }
      c.send(m.data);
      if (m.ch === 'frm') stats.frmSent++; else stats.ctlSent++;
    };
    if (netem && (m.ch === 'frm' || m.ch === 'ctl')) netem.schedule('out', m.ch, out); else out();
  };
  // A remote description must pass the strict sanitizer whole; one that
  // does not ends the link.
  const remoteSdp = (text) => {
    try { return allow.sdp(text); } catch (err) { stats.sdpRefused++; close(`sdp refused: ${err.message}`); throw err; }
  };
  return {
    async offer(ticket) {
      const o = await pc.createOffer();
      if (closed) return; // discarded or closed meanwhile: nothing to send
      await pc.setLocalDescription(o);
      if (closed) return;
      // The createOffer/createAnswer text, taken before gathering (c= is
      // 0.0.0.0, no candidates); pc.localDescription is never sent.
      signal({ t: 'offer', slot, sdp: localSdp(o.sdp), ticket });
    },
    async onSignal(m) {
      if (closed) return;
      if (m.t === 'offer' && role === 'room') {
        await pc.setRemoteDescription({ type: 'offer', sdp: remoteSdp(m.sdp) });
        const a = await pc.createAnswer();
        await pc.setLocalDescription(a);
        signal({ t: 'answer', slot, sdp: localSdp(a.sdp) });
      } else if (m.t === 'answer' && role === 'seat') {
        await pc.setRemoteDescription({ type: 'answer', sdp: remoteSdp(m.sdp) });
      } else if (m.t === 'ice' && m.cand && m.cand.candidate) {
        if (stats.remoteCands >= REMOTE_CANDS_MAX || !allow.candidate(m.cand.candidate)) { stats.remoteFiltered++; return; }
        stats.remoteCands++;
        const c = m.cand;
        try { await pc.addIceCandidate({ candidate: String(c.candidate), sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid : null, sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null }); } catch { stats.remoteFiltered++; }
      }
    },
    close,
    // End a link that never opened without telling the worker (the seat
    // retries with a fresh link on the same port).
    discard() { if (closed) return; closed = true; discarded = true; verified = false; early.length = 0; clearInterval(recheck); try { pc.close(); } catch { /* closed */ } },
    // closedLink: the link has ended (closed or discarded); discarded: it
    // was ended by discard() for a retry, not by a failure.
    get closedLink() { return closed; },
    get discarded() { return discarded; },
    stats,
  };
}
