// mp-public.js: the PUBLIC network policy for browser rooms (M3 W2), the
// counterpart of mp-lan.js's LAN allowlist with the same interface
// (hasIp, signalUrl, candidate, sdp, list), plus iceServers.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// A public room runs on a cabinet host whose LAN and tailnet
// addresses must never reach a player, and a player's LAN address is of no
// use to the room. So both ends keep only GLOBAL unicast IPv4 candidates
// (no loopback, private, CGNAT and tailnet, link-local, documentation,
// benchmark, multicast or reserved ranges; no mDNS .local names; UDP only;
// host, srflx, prflx and relay types). The selected pair's far side is
// checked the same way (pairOk; mp-rtc.js reads it back from getStats).
//
// Signalling:
//   room: its own supervisor on loopback only (ws://127.0.0.1:<port>/mp).
//   seat: wss:// to one of the configured public signal hosts, path
//         /rooms/signal (Caddy on the room host proxies it to the
//         supervisor's public listener).
// iceServers: what the seat's ticket carried (our coturn STUN and TURN,
// short lived) or, for the room, a STUN list from the daemon's config.

import { parseIPv4, parseCandidate, sanitizeSdp } from './mp-lan.js';

// [network, prefix bits] of every non-global IPv4 range (RFC 6890 and kin).
const NOT_GLOBAL = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([n, b]) => ({ net: parseIPv4(n), mask: b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0 }));

// A plain dotted quad (no ::ffff: form, no leading zeros) that is global.
export const isPublicIPv4Literal = (x) => typeof x === 'string' && parseIPv4(x) !== null && isGlobalIPv4(x);

export function isGlobalIPv4(addr) {
  const ip = parseIPv4(String(addr || '').replace(/^::ffff:/, ''));
  return ip !== null && !NOT_GLOBAL.some((r) => ((ip & r.mask) >>> 0) === r.net);
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
// A DNS name, never an address literal.
export const isHostName = (h) => typeof h === 'string' && HOST_RE.test(h) && !/^[\d.]+$/.test(h) && !/^0x/i.test(h);

// LAB ONLY (the room server's network.mode "lab-tailnet", config.mjs): the
// tailnet range, 100.64.0.0/10 (Tailscale's CGNAT block). Global unicast
// never includes it, so nothing above changes; these are used only where a
// lab tailnet room or a seat whose signal host is a tailnet name asks.
const TAILNET = { net: parseIPv4('100.64.0.0'), mask: (0xffffffff << 22) >>> 0 };
export function isTailnetIPv4(addr) {
  const ip = parseIPv4(String(addr || '').replace(/^::ffff:/, ''));
  return ip !== null && ((ip & TAILNET.mask) >>> 0) === TAILNET.net;
}
// A plain dotted quad (no ::ffff: form, no leading zeros) in 100.64.0.0/10.
export const isTailnetIPv4Literal = (x) => typeof x === 'string' && parseIPv4(x) !== null && isTailnetIPv4(x);
// A MagicDNS machine name, <machine>.<tailnet>.ts.net: a host name (above)
// whose last two labels are exactly ts and net, with at least two labels
// before them. Not a substring test: "ts.net.example.com" and
// "x.examplets.net" are not tailnet names.
const TSNET_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+\.ts\.net$/;
export const isTsNetHostName = (h) => isHostName(h) && TSNET_RE.test(h);
const TYPES = new Set(['host', 'srflx', 'prflx', 'relay']);
const ICE_URL_RE = /^(stun|turn|turns):([a-z0-9.-]+)(?::(\d{1,5}))?(\?transport=(udp|tcp))?$/i;
const iceUrlOk = (u) => {
  const m = typeof u === 'string' ? ICE_URL_RE.exec(u) : null;
  if (!m || !isHostName(m[2].toLowerCase())) return false;
  return m[3] === undefined || (Number(m[3]) >= 1 && Number(m[3]) <= 65535);
};

// iceServers entries: stun:/turn:/turns: URLs on public hostnames only, with
// a port of 1 to 65535; credentials passed through for TURN. Anything else
// is dropped. A single object (the shape of Cloudflare's older TURN API) is
// taken as a list of one.
export function cleanIceServers(list) {
  const out = [];
  const src = Array.isArray(list) ? list : list && typeof list === 'object' ? [list] : [];
  for (const s of src.slice(0, 4)) {
    if (!s || typeof s !== 'object') continue;
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(iceUrlOk).slice(0, 8);
    if (!urls.length) continue;
    const e = { urls };
    if (typeof s.username === 'string' && s.username.length <= 512) e.username = s.username;
    if (typeof s.credential === 'string' && s.credential.length <= 512) e.credential = s.credential;
    out.push(e);
  }
  return out;
}

// The plain public rule for one candidate line (createPublicPolicy).
function publicCandidate(line) {
  const c = parseCandidate(line);
  return !!c && c.protocol === 'udp' && TYPES.has(c.type) && isGlobalIPv4(c.address);
}

// The address fields of a local session description that could name an
// interface of this machine: c=, a=rtcp and o=. Anything but 0.0.0.0 or
// 127.0.0.1 is rewritten to the placeholder (defence in depth: the SDP is
// taken before gathering, so today they already hold placeholders).
const PLACEHOLDER = new Set(['0.0.0.0', '127.0.0.1']);
function scrubSdpLine(l) {
  let m = /^c=IN IP4 (\S+)$/.exec(l);
  if (m) return PLACEHOLDER.has(m[1]) ? l : 'c=IN IP4 0.0.0.0';
  if (/^c=IN IP6 /.test(l)) return 'c=IN IP4 0.0.0.0';
  m = /^(a=rtcp:\d+) IN IP[46] (\S+)$/.exec(l);
  if (m) return PLACEHOLDER.has(m[2]) ? l : `${m[1]} IN IP4 0.0.0.0`;
  m = /^(o=\S+ \S+ \S+) IN IP[46] (\S+)$/.exec(l);
  if (m) return PLACEHOLDER.has(m[2]) ? l : `${m[1]} IN IP4 127.0.0.1`;
  return l;
}

// createPublicPolicy({ role: 'room' | 'seat', signalHosts, iceServers, publicIp, tailnetIp })
// publicIp (room, optional): the one global address the room may name; a
// local candidate on any other address is not sent (isGlobalIPv4 is a
// denylist, so this pins it to the cabinet's real public address).
// LAB ONLY, the tailnet variant (room server network.mode "lab-tailnet"):
//   tailnetIp (room only, optional): this machine's tailnet address. The
//   room then also names its HOST candidate on exactly that address (and
//   no other host candidate), may take tailnet addresses from a seat, and
//   publicIp (if given) is the only other address it names.
//   A seat whose signal hosts are all tailnet names (isTsNetHostName) may
//   take a tailnet candidate and pair from the room. Any other signal host:
//   exactly the public policy as before.
// Without tailnetIp, and for a seat on any other host, every rule below is
// the plain public one (tailnet is false, and the tailnet terms drop out).
export function createPublicPolicy({ role, signalHosts = [], iceServers = [], publicIp = null, tailnetIp = null } = {}) {
  if (role !== 'room' && role !== 'seat') throw new Error('public policy: role must be room or seat');
  if (publicIp !== null && !isPublicIPv4Literal(publicIp)) throw new Error('public policy: publicIp must be a global IPv4 address (a plain dotted quad)');
  if (tailnetIp !== null && (role !== 'room' || !isTailnetIPv4Literal(tailnetIp))) throw new Error('public policy: tailnetIp is a room\'s own tailnet address (100.64.0.0/10, a plain dotted quad)');
  const hosts = (Array.isArray(signalHosts) ? signalHosts : [signalHosts]).map((h) => String(h || '').toLowerCase()).filter(isHostName);
  if (role === 'seat' && !hosts.length) throw new Error('public policy: a seat needs its signal host');
  const tailnet = role === 'room' ? tailnetIp !== null : hosts.every(isTsNetHostName);
  const addrOk = tailnet ? (a) => isGlobalIPv4(a) || isTailnetIPv4(a) : isGlobalIPv4;
  const candidate = tailnet ? (line) => { const c = parseCandidate(line); return !!c && c.protocol === 'udp' && TYPES.has(c.type) && addrOk(c.address); } : publicCandidate;
  // The room's own addresses: what it may name, and never takes from a peer.
  const own = (a) => (publicIp !== null && a === publicIp) || (tailnetIp !== null && a === tailnetIp);
  // What this end filtered from what it sends, by reason (count only). In
  // public mode Chromium runs with adapter enumeration off, so it should
  // gather no host candidate at all: any 'host' here means the IP handling
  // flag is not in effect, and 'pinMiss' means the public address moved
  // away from publicIp. The daemon raises both as alarms (rooms.mjs).
  const filtered = { host: 0, pinMiss: 0, raddr: 0, other: 0 };
  // What this end sends, or null. The related address (raddr, on srflx,
  // prflx and relay lines) names this machine's LAN or tailnet side, so it
  // is always rewritten to 0.0.0.0 and rport to 0 (the line stays usable);
  // a line that still names another raddr is not sent.
  const localLine = (line) => {
    const c = parseCandidate(line);
    // The lab tailnet room names one host candidate, on tailnetIp; its other
    // host candidates (LAN, other adapters) are expected there, so they count
    // as other, not as the public mode's IP handling alarm.
    if (c && c.type === 'host' && !(tailnetIp !== null && c.address === tailnetIp)) { if (tailnetIp !== null) filtered.other++; else filtered.host++; return null; }
    if (!candidate(line)) { filtered.other++; return null; }
    if ((publicIp !== null || tailnetIp !== null) && !own(c.address)) { filtered.pinMiss++; return null; }
    const out = String(line).replace(/ raddr \S+/g, ' raddr 0.0.0.0').replace(/ rport \d+/g, ' rport 0');
    if (/ raddr (?!0\.0\.0\.0(?: |$))/.test(out)) { filtered.raddr++; return null; }
    return out;
  };
  // What this end takes: never a candidate naming its own public address
  // (a peer could aim the room's checks at its own or its router's ports).
  const remoteCandidate = (line) => candidate(line) && !own(parseCandidate(line).address);
  return {
    public: true,
    list: tailnet ? ['global unicast IPv4', 'tailnet 100.64.0.0/10'] : ['global unicast IPv4'],
    iceServers: cleanIceServers(iceServers),
    hasIp: addrOk,
    // The selected pair (mp-rtc.js, from getStats). This end's own side is
    // whatever libwebrtc reports (for a UDP pair that is the host candidate,
    // a LAN address or blank, even when the srflx one is in use), so only
    // the far side is checked: a global address of a known type, or a peer
    // reflexive candidate whose address Chromium leaves blank. LAN mode
    // keeps its check on both ends (no pairOk there).
    pairOk(local, remote) {
      if (!local || !remote || !TYPES.has(remote.type)) return false;
      if (remote.type === 'prflx' && !remote.address) return true;
      return addrOk(remote.address);
    },
    signalUrl(url) {
      let u;
      try { u = new URL(url); } catch { return null; }
      if (role === 'room') return u.protocol === 'ws:' && u.hostname === '127.0.0.1' && u.pathname === '/mp' ? u : null;
      return u.protocol === 'wss:' && hosts.includes(u.hostname) && !u.port && u.pathname === '/rooms/signal' ? u : null;
    },
    candidate: remoteCandidate,
    localLine,
    filtered,
    localCandidate: (line) => localLine(line) !== null,
    sdp(text) { return sanitizeSdp(text, { candidate: remoteCandidate }); },
    localSdp(text) {
      const clean = sanitizeSdp(text, { candidate: (l) => localLine(l) !== null });
      return clean.split('\r\n').map((l) => (l.startsWith('a=candidate:') ? localLine(l) : scrubSdpLine(l))).join('\r\n');
    },
  };
}
