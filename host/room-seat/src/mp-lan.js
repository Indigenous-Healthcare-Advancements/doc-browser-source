// mp-lan.js: LAB ONLY (multiplayer room M2, doc-ops MULTIPLAYER_SERVER.md
// 3, 11). The explicit LAN allowlist that replaces M1's loopback-only guard.
// Every network address the room, the seat pages and the supervisor touch
// (the signalling socket and every WebRTC ICE candidate, local and remote)
// must fall inside the allowlist, and the allowlist itself may only hold
// loopback and private ranges (plus single 100.64.0.0/10 tailnet addresses,
// only with tailnet: true): an entry outside them is refused, so no
// query string or flag can open a page to the internet. No STUN or TURN
// server is ever configured (iceServers is always empty).
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later

// IPv4 only in M2 (the lab LAN). Loopback, the RFC 1918 ranges and nothing else
// (plus the opt-in tailnet range below, off by default).
export const PRIVATE_RANGES = Object.freeze(['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']);
export const DEFAULT_ALLOW = Object.freeze(['127.0.0.0/8']);
// Opt-in tailnet mode (off by default): the Tailscale range, RFC 6598 shared
// address space. It is not globally routed, but ISPs also use it for
// carrier-grade NAT, so other subscribers can sit in it: a tailnet entry must
// be a single address (/32), never the range. It is allowed only when the
// caller passes { tailnet: true }: the runner's or the supervisor's --tailnet
// flag, or tailnet=1 on a page's query, which a page honours only when it was
// itself served from loopback or a tailnet address (see pageAllowlist).
export const TAILNET_RANGE = '100.64.0.0/10';

export function parseIPv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s || ''));
  if (!m) return null;
  // No leading zeros: some parsers read 010 as octal (8).
  if (m.slice(1).some((p) => /^0\d/.test(p))) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function parseCidr(s) {
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const ip = parseIPv4(m[1]);
  const bits = Number(m[2]);
  if (ip === null || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: (ip & mask) >>> 0, mask, bits, text: `${m[1]}/${bits}` };
}

const inCidr = (ip, c) => ((ip & c.mask) >>> 0) === c.net;
const PRIVATE = PRIVATE_RANGES.map(parseCidr);
const TAILNET = parseCidr(TAILNET_RANGE);
const within = (c, p) => c.bits >= p.bits && inCidr(c.net, p);
const insideAllowed = (c, tailnet) => PRIVATE.some((p) => within(c, p)) || (tailnet === true && c.bits === 32 && within(c, TAILNET));

// isLanAddress(addr, { tailnet }): an IPv4 literal inside loopback or the
// private ranges (and, with tailnet: true, the tailnet range).
export function isLanAddress(addr, { tailnet = false } = {}) {
  const ip = parseIPv4(String(addr || ''));
  return ip !== null && insideAllowed({ net: ip, mask: 0xffffffff, bits: 32 }, tailnet);
}

// createLanAllowlist(list, { tailnet }): list of CIDR strings (or a
// comma-separated string). Throws on an entry that is malformed or reaches
// outside loopback and the private ranges (plus single tailnet addresses,
// /32 only, when tailnet is exactly true).
export function createLanAllowlist(list = DEFAULT_ALLOW, { tailnet = false } = {}) {
  const items = (typeof list === 'string' ? list.split(',') : list).map((x) => String(x).trim()).filter(Boolean);
  if (!items.length) throw new Error('empty LAN allowlist');
  const cidrs = items.map((t) => {
    const c = parseCidr(t);
    if (!c) throw new Error(`bad LAN allowlist entry: ${t}`);
    if (!insideAllowed(c, tailnet)) throw new Error(`LAN allowlist entry outside loopback and private ranges${tailnet === true ? ' and single tailnet addresses (/32)' : ''}: ${t}`);
    return c;
  });
  const hasIp = (addr) => {
    const ip = parseIPv4(String(addr || '').replace(/^::ffff:/, ''));
    return ip !== null && cidrs.some((c) => inCidr(ip, c));
  };
  return {
    list: cidrs.map((c) => c.text),
    tailnet: tailnet === true,
    hasIp,
    // A signalling URL: ws: only, host an allowlisted IPv4 literal, path /mp.
    signalUrl(url) {
      let u;
      try { u = new URL(url); } catch { return null; }
      if (u.protocol !== 'ws:' || u.pathname !== '/mp' || !hasIp(u.hostname)) return null;
      return u;
    },
    // An ICE candidate line (a=candidate or candidate:...): UDP host
    // candidates whose address is an allowlisted IPv4 literal. No mDNS
    // .local names: a name can resolve to any address, so the seat browser
    // must run with mDNS hiding off (WebRtcHideLocalIpsWithMdns disabled).
    candidate(line) {
      const c = parseCandidate(line);
      return !!c && c.protocol === 'udp' && c.type === 'host' && hasIp(c.address);
    },
    // A remote session description, rebuilt from its parsed lines (see
    // sanitizeSdp). Throws on anything not strictly CRLF or on a candidate
    // form it does not accept.
    sdp(text) { return sanitizeSdp(text, this); },
  };
}

// pageAllowlist(search, hostname): the allowlist a room or seat page uses,
// from its own query (lan=, tailnet=) and the host it was served from.
// tailnet=1 (exactly one, exactly "1") is honoured only when the page itself
// came from loopback or a tailnet address, so a crafted link served from a
// LAN host cannot widen that page to the tailnet.
export function pageAllowlist(search, hostname) {
  const q = search instanceof URLSearchParams ? search : new URLSearchParams(String(search || ''));
  const asked = q.getAll('tailnet');
  const host = String(hostname || '');
  const servedOk = isLanAddress(host, { tailnet: true }) && (host.startsWith('127.') || !isLanAddress(host));
  const tailnet = asked.length === 1 && asked[0] === '1' && servedOk;
  return createLanAllowlist(q.get('lan') || undefined, { tailnet });
}

// candidate:<foundation> <component> <protocol> <priority> <address> <port> typ <type> [<name> <value>]...
// Strict: single spaces, the fixed fields well formed, attribute pairs
// complete. Anything else is null.
const CAND_RE = /^(?:a=)?candidate:([A-Za-z0-9+/]{1,32}) ([0-9]{1,3}) ([A-Za-z]{3}) ([0-9]{1,10}) (\S+) ([0-9]{1,5}) typ (host|srflx|prflx|relay)((?: [A-Za-z0-9_-]+ \S+)*)$/;
export function parseCandidate(line) {
  const m = CAND_RE.exec(String(line || ''));
  if (!m) return null;
  return { protocol: m[3].toLowerCase(), address: m[5], port: Number(m[6]), type: m[7] };
}

// sanitizeSdp(text, allow): the description strictly CRLF (a bare CR or LF
// is refused, so no line can hide from the filter), every line of the
// form <letter>=<value>, candidate lines kept only when allow.candidate()
// takes them, a=end-of-candidates kept only in its exact form, and any
// other line that mentions a candidate refused. Returns the rebuilt text;
// throws on refusal.
export function sanitizeSdp(text, allow) {
  const s = String(text || '');
  if (!s.length || s.length > 65536) throw new Error('sdp size');
  if (/\r(?!\n)|(?<!\r)\n/.test(s)) throw new Error('sdp line ending');
  const lines = s.split('\r\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const out = [];
  for (const l of lines) {
    if (!/^[a-z]=[\x20-\x7e]*$/.test(l)) throw new Error('sdp line form');
    if (l.startsWith('a=candidate:')) {
      if (allow.candidate(l)) out.push(l);
      else if (!parseCandidate(l)) throw new Error('sdp candidate form');
      continue;
    }
    if (l === 'a=end-of-candidates') { out.push(l); continue; }
    if (/candidate/i.test(l)) throw new Error('sdp candidate form');
    out.push(l);
  }
  return `${out.join('\r\n')}\r\n`;
}
