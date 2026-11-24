// room-seat-report.js: "Report a problem" on the room seat (docs/problem-reports.md under host/; doc-arcade
// docs/rooms/problem-reports.md is the lobby's side). One press takes a snapshot of THIS PAGE and one more sends it:
//   a small JPEG of the player's own game picture (the page's own canvas, scaled down);
//   the figures the page already shows and keeps (frame rate, the link's counters, the board's link words), the
//   page's own phase and seat state, the room tag, the slot, the release, the lease and horse ids, the race count;
//   the last lines of the page's own log (kept here, bounded), each with its time, and the clock skew to the servers;
//   what the browser says about the device (user agent, sizes, pointer, orientation, visibility, connection type);
//   the browser's time and a report id made here, so the same report sent twice is stored once.
// WHAT IS NEVER IN IT: game files, memory, card bytes, the room token, the seat ticket, the reservation, any address
// (the link's selected pair is reported by its two TYPES only, and every text is passed through scrub, which takes
// out addresses, long token-like runs and the query and fragment of any URL). Nothing outside the page is read.
// ONE DESTINATION and no other: POST /api/room/report on the page's own origin, with the hand-off's room token in
// X-Cabinet-Token, as the lease calls go. Nothing is sent until the player presses Send.
// Everything but capturePicture and the sheet is pure; the browser's parts are handed in, so the tests run in node.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later

export const REPORT_API = '/api/room/report';
export const REPORT_V = 1;
export const NOTE_MAX = 200;
export const LOG_MAX = 100;
export const LINE_MAX = 200;
export const SEND_TIMEOUT_MS = 20000;
export const CAPTURE_TIMEOUT_MS = 3000;
// The picture: under PICTURE_TARGET_BYTES, tried from the largest and clearest down (width, height, JPEG quality).
export const PICTURE_TARGET_BYTES = 150000;
export const PICTURE_TRIES = Object.freeze([[640, 480, 0.72], [640, 480, 0.5], [480, 360, 0.6], [320, 240, 0.6], [320, 240, 0.4]]);
// The whole request, as JSON text. The lobby refuses a larger one, so the page cuts to fit before it sends (fitReport).
export const REPORT_MAX_BYTES = 400000;
// One group of facts: at most this many names, one level of groups inside it, short texts.
export const FACT_KEYS_MAX = 60;
export const FACT_TEXT_MAX = 120;
// One group as JSON text: the lobby refuses a larger one, so a group over this is thinned before it is sent (boundGroup).
export const GROUP_MAX_BYTES = 20000;
export const SUCCESS_CLOSE_MS = 2500;

// THE WORDS, by language (English now; a Japanese table goes beside it and reportCopy picks it).
export const REPORT_COPY = Object.freeze({
  en: Object.freeze({
    button: 'Report a problem',
    buttonTitle: 'Send a snapshot of this seat to the staff',
    title: 'Report a problem',
    lead: 'This sends the staff a picture of your game screen, this seat\'s connection figures and its recent log.',
    leadNoPicture: 'This sends the staff this seat\'s connection figures and its recent log. A picture of your game screen could not be taken.',
    noteLabel: 'What went wrong? (optional)',
    send: 'Send',
    cancel: 'Cancel',
    close: 'Close',
    sending: 'Sending your report.',
    sent: 'Thanks. Your report was sent.',
    failed: 'Could not send the report. Please try again.',
    rateHour: 'You have sent several reports in the last hour. Please try again later.',
    rateDay: 'You have sent many reports today. Please try again tomorrow.',
    unavailable: 'Problem reports are not available right now.',
  }),
});
export function reportCopy(lang) { return REPORT_COPY[lang] || REPORT_COPY.en; }

// Control characters and the two Unicode line breaks (written by code point, so no such character is in this file).
const CONTROL = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f\\u{2028}\\u{2029}]+`, 'gu');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[a-z][A-Za-z0-9_]{0,31}$/;
// Names that carry an address, a credential or card bytes wherever they turn up: never copied.
const NEVER = /^(?:local|remote|address|ip|candidate|pair|token|room_token|ticket|room_ticket|reservation|nonce|secret|key|bytes|card|card_b64|member_hash|memberHash|ice_servers|signal_url|room_server_url)$/i;

// An IPv6 address, written out or shortened with "::" (no lookbehind: the page must load on every browser).
const V6 = /(^|[^0-9A-Za-z:.])(?:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?|(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{0,4})(?![0-9A-Za-z])/gi;

/**
 * A text made safe to send: control characters out, a URL cut to its origin and path, addresses and long token-like
 * runs replaced, cut to `max`. Never throws; anything that is not a text becomes one.
 */
export function scrub(text, max = LINE_MAX) {
  let s;
  try { s = String(text === undefined || text === null ? '' : text); } catch { s = ''; }
  s = s.replace(CONTROL, ' ');
  // A URL keeps its scheme, host and path; its query and fragment (where a ticket would be) go.
  s = s.replace(/\b((?:https?|wss?):\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, '$1');
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, '[address]');
  s = s.replace(V6, '$1[address]');
  s = s.replace(/[A-Za-z0-9._~+=-]{32,}/g, (run) => (/[0-9]/.test(run) ? '[redacted]' : run));
  s = s.trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** The player's note: one line, at most NOTE_MAX characters. Their own words, so only control characters go. */
export function cleanNote(text) {
  let s;
  try { s = String(text === undefined || text === null ? '' : text); } catch { s = ''; }
  return [...s.replace(CONTROL, ' ').trim()].slice(0, NOTE_MAX).join('');
}

/**
 * The page's own log: the last `max` lines, each { t (the browser's clock, ms), k (a short kind), m (the text) }, and
 * n when the same line came again straight after. Bounded: a line past the limit drops the oldest.
 */
export function createSeatLog({ max = LOG_MAX, now = () => Date.now() } = {}) {
  const lines = [];
  let dropped = 0;
  return {
    add(kind, text) {
      try {
        const k = scrub(kind, 12).replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'note';
        const m = scrub(text);
        if (!m) return;
        const last = lines[lines.length - 1];
        if (last && last.k === k && last.m === m) { last.n = (last.n || 1) + 1; last.t2 = Math.round(now()); return; }
        lines.push({ t: Math.round(now()), k, m });
        if (lines.length > max) { lines.shift(); dropped++; }
      } catch { /* a log line never stops the seat */ }
    },
    /** A copy, oldest first. */
    lines() { return lines.map((l) => ({ ...l })); },
    dropped() { return dropped; },
    size() { return lines.length; },
  };
}

/** A rate from a counter read now and then: note(now ms, count), rate() per second over the last `keep` readings. */
export function createRateMeter({ keep = 6 } = {}) {
  const obs = [];
  return {
    note(nowMs, count) {
      if (!Number.isFinite(nowMs) || !Number.isFinite(count)) return;
      const last = obs[obs.length - 1];
      if (last && (count < last.c || nowMs <= last.t)) obs.length = 0; // the counter started again
      obs.push({ t: nowMs, c: count });
      if (obs.length > keep) obs.shift();
    },
    rate() {
      if (obs.length < 2) return null;
      const a = obs[0], b = obs[obs.length - 1];
      return b.t > a.t ? Math.round(((b.c - a.c) * 1000 / (b.t - a.t)) * 10) / 10 : null;
    },
  };
}

/** A report id made in the page (a version 4 UUID), so a second send of the same report is not a second report. */
export function newReportId(cryptoImpl = globalThis.crypto) {
  try { if (cryptoImpl && typeof cryptoImpl.randomUUID === 'function') { const u = cryptoImpl.randomUUID(); if (UUID.test(u)) return u; } } catch { /* below */ }
  const b = new Uint8Array(16);
  try { cryptoImpl.getRandomValues(b); } catch { for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const prim = (v, textMax) => {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return scrub(v, textMax);
  return undefined;
};

/**
 * A group of facts from one of the page's own objects: its numbers, yes or no values and short texts, and one level
 * of groups inside it (a list becomes its last few plain values). Names that could carry an address, a credential or
 * card bytes are never copied, whatever they hold; neither is anything that is not plain (typed arrays, functions).
 */
export function facts(obj, { skip = [], maxKeys = FACT_KEYS_MAX, textMax = FACT_TEXT_MAX, depth = 1 } = {}) {
  const out = {};
  if (!obj || typeof obj !== 'object' || ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return out;
  let n = 0;
  let names;
  try { names = Object.keys(obj); } catch { return out; }
  for (const k of names) {
    if (n >= maxKeys) break;
    if (!KEY.test(k) || NEVER.test(k) || skip.includes(k)) continue;
    let v;
    try { v = obj[k]; } catch { continue; }
    const p = prim(v, textMax);
    if (p !== undefined) { out[k] = p; n++; continue; }
    if (!v || typeof v !== 'object' || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) continue;
    if (Array.isArray(v)) {
      const list = v.slice(-8).map((x) => prim(x, 40)).filter((x) => x !== undefined);
      if (list.length || !v.length) { out[k] = list; n++; }
      continue;
    }
    if (depth > 0) { out[k] = facts(v, { maxKeys: 24, textMax, depth: depth - 1 }); n++; }
  }
  return out;
}

const int = (v, lo, hi) => (Number.isSafeInteger(v) && v >= lo && v <= hi ? v : null);

/**
 * A group of facts kept under `max` characters of JSON: as it is when it fits; else without its inner groups and
 * lists (the plain values stay); else empty. A report is never refused for one fat group.
 */
export function boundGroup(group, max = GROUP_MAX_BYTES) {
  const g = group && typeof group === 'object' && !Array.isArray(group) ? group : {};
  let text;
  try { text = JSON.stringify(g); } catch { return {}; }
  if (text.length * 3 <= max || byteLen(text) <= max) return g;
  const thin = {};
  for (const [k, v] of Object.entries(g)) if (v === null || typeof v !== 'object') thin[k] = v;
  return byteLen(JSON.stringify(thin)) <= max ? thin : {};
}

/** What the browser says about the device. Every read is guarded; a browser that does not say gives null. */
export function deviceFacts({ win = globalThis.window, nav = globalThis.navigator, doc = globalThis.document } = {}) {
  const get = (f) => { try { const v = f(); return v === undefined ? null : v; } catch { return null; } };
  const media = (q) => get(() => (win && typeof win.matchMedia === 'function' ? !!win.matchMedia(q).matches : null));
  const conn = get(() => nav.connection || null);
  return {
    ua: scrub(get(() => nav.userAgent) || '', 300),
    lang: scrub(get(() => nav.language) || '', 20),
    vw: int(get(() => win.innerWidth), 0, 100000), vh: int(get(() => win.innerHeight), 0, 100000),
    sw: int(get(() => win.screen.width), 0, 100000), sh: int(get(() => win.screen.height), 0, 100000),
    dpr: get(() => (Number.isFinite(win.devicePixelRatio) ? Math.round(win.devicePixelRatio * 100) / 100 : null)),
    coarse: media('(pointer: coarse)'),
    orientation: scrub(get(() => win.screen.orientation.type) || (media('(orientation: portrait)') === true ? 'portrait' : media('(orientation: landscape)') === true ? 'landscape' : ''), 24) || null,
    visibility: scrub(get(() => doc.visibilityState) || '', 12) || null,
    fullscreen: get(() => !!doc.fullscreenElement),
    online: get(() => (typeof nav.onLine === 'boolean' ? nav.onLine : null)),
    cores: int(get(() => nav.hardwareConcurrency), 0, 4096),
    memory_gb: get(() => (Number.isFinite(nav.deviceMemory) ? nav.deviceMemory : null)),
    conn_type: conn ? scrub(get(() => conn.effectiveType) || get(() => conn.type) || '', 16) || null : null,
    conn_downlink: conn ? get(() => (Number.isFinite(conn.downlink) ? conn.downlink : null)) : null,
    conn_rtt: conn ? int(get(() => conn.rtt), 0, 600000) : null,
    conn_save: conn ? get(() => (typeof conn.saveData === 'boolean' ? conn.saveData : null)) : null,
    isolated: get(() => !!globalThis.crossOriginIsolated),
  };
}

/**
 * The figures of the page's own status panel and the ones behind it: the frame rate (the link's releases a second
 * and the board's frames a second), the link worker's counters, the peer link's counters with its selected pair as
 * two types and never an address, and the board's own link words (the lockstep and ring state).
 */
export function seatStats({ state, rates = {} } = {}) {
  const st = state || {};
  const b = st.board || {};
  const smp = Array.isArray(b.samples) && b.samples.length ? b.samples[b.samples.length - 1] : null;
  const rtc = st.rtc && typeof st.rtc === 'object' ? st.rtc : null;
  const pair = rtc && rtc.pair && typeof rtc.pair === 'object' ? rtc.pair : null;
  return {
    fps: rates.link ?? null,
    fps_board: rates.board ?? null,
    link: facts(st.link),
    rtc: rtc ? { ...facts(rtc, { depth: 0 }), pair_local: pair ? scrub(pair.localType, 16) || null : null, pair_remote: pair ? scrub(pair.remoteType, 16) || null : null, pair_protocol: pair ? scrub(pair.protocol, 8) || null : null } : {},
    board: { ready: b.ready === true, loaded: b.loaded === true, frame: smp && Number.isFinite(smp.f) ? smp.f : null, errors: Array.isArray(b.errors) ? b.errors.length : 0, ...(smp && smp.status ? facts(smp.status, { depth: 0 }) : {}) },
    counts: facts(b.counts, { depth: 0 }),
  };
}

/** The page's own phase and seat state (its state object, less the groups seatStats carries and the settings). */
export function seatState({ state, extra = {} } = {}) {
  const st = state || {};
  const set = st.settings && typeof st.settings === 'object' ? st.settings : null;
  return {
    ...facts(st, { skip: ['board', 'link', 'rtc', 'settings', 'netem'] }),
    ...(set ? { settings: facts(set, { depth: 0, maxKeys: 16 }) } : {}),
    ...facts(extra),
  };
}

/**
 * THE REPORT, as it is sent. `handoff` gives only its room tag, slot, release, lease id, horse id and clock skew;
 * `view` is the lease held now (after a horse change it names the new lease and horse). Nothing else of either is
 * read. picture: { b64, w, h, bytes, flat } or null, with pictureNote saying why there is none.
 */
export function buildSeatReport({ id, now = Date.now(), note = '', handoff = null, view = null, stats = {}, state = {}, device = {}, log = [], logDropped = 0, raceNo = null, cardGen = null, pageBuild = null, picture = null, pictureNote = null } = {}) {
  const h = handoff || {};
  const v = view || h;
  const uuid = (x) => (typeof x === 'string' && UUID.test(x) ? x : null);
  return {
    v: REPORT_V,
    source: 'seat',
    report_id: uuid(id) || newReportId(),
    client_time: new Date(now).toISOString(),
    clock_skew_ms: Number.isFinite(h.clock_skew_ms) ? Math.round(h.clock_skew_ms) : null,
    note: cleanNote(note),
    release: h.release === 'revc' || h.release === 'doc99' ? h.release : null,
    room_tag: typeof h.room_tag === 'string' && /^[0-9a-f]{8}$/i.test(h.room_tag) ? h.room_tag.toLowerCase() : null,
    slot: int(h.slot, 1, 64),
    lease_id: uuid(v.lease_id),
    horse_id: uuid(v.horse_id),
    race_no: int(raceNo, 0, 1000000),
    card_gen: int(cardGen, 0, 1000000),
    page_build: pageBuild ? scrub(pageBuild, 40) : null,
    stats: boundGroup(stats), state: boundGroup(state), device: boundGroup(device),
    log: (Array.isArray(log) ? log : []).slice(-LOG_MAX).map((l) => ({ t: l.t, k: l.k, m: scrub(l.m), ...(l.n > 1 ? { n: l.n, t2: l.t2 } : {}) })),
    log_dropped: int(logDropped, 0, 1000000000) || 0,
    picture: picture && typeof picture.b64 === 'string' ? { mime: 'image/jpeg', w: picture.w, h: picture.h, b64: picture.b64, ...(picture.flat ? { flat: true } : {}) } : null,
    picture_note: picture ? null : scrub(pictureNote || 'no picture', 80),
  };
}

function byteLen(s) { let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3; } return n; }

/**
 * The report cut to fit `max` bytes of JSON: first the picture goes (and the report says so), then the oldest log
 * lines, then the state and stats groups. What is left always fits. Returns { body (the JSON text), report }.
 */
export function fitReport(report, max = REPORT_MAX_BYTES) {
  let r = report;
  let body = JSON.stringify(r);
  if (byteLen(body) <= max) return { body, report: r };
  if (r.picture) { r = { ...r, picture: null, picture_note: 'picture left out: the report was too large' }; body = JSON.stringify(r); }
  while (byteLen(body) > max && r.log.length) { const cut = Math.max(1, Math.ceil(r.log.length / 4)); r = { ...r, log: r.log.slice(cut), log_dropped: r.log_dropped + cut }; body = JSON.stringify(r); }
  if (byteLen(body) > max) { r = { ...r, state: {}, stats: {} }; body = JSON.stringify(r); }
  if (byteLen(body) > max) { r = { ...r, device: { ua: r.device && typeof r.device.ua === 'string' ? r.device.ua.slice(0, 120) : '' } }; body = JSON.stringify(r); }
  return { body, report: r };
}

const b64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x6000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x6000));
  return btoa(s);
};
const isJpeg = (u8) => u8.length > 4 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff && u8[u8.length - 2] === 0xff && u8[u8.length - 1] === 0xd9;

/**
 * A JPEG of the player's own game picture: the page's canvas drawn onto a small one and compressed, the first of
 * PICTURE_TRIES that comes out under the target. Resolves to { picture: { b64, w, h, bytes, flat }, why: null } or
 * { picture: null, why } (never rejects): a browser that will not draw or compress the canvas gives no picture, and
 * the report goes without it and says so. flat: the picture is one single colour (a browser that hands the page a
 * blank frame looks the same as a black screen, so the report says what was seen). Only the canvas handed in is read.
 */
export async function capturePicture({ canvas, doc = globalThis.document, tries = PICTURE_TRIES, target = PICTURE_TARGET_BYTES, timeoutMs = CAPTURE_TIMEOUT_MS, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t) } = {}) {
  if (!canvas || !doc || typeof doc.createElement !== 'function') return { picture: null, why: 'no screen on this page' };
  let timer = null;
  const late = new Promise((res) => { timer = setTimer(() => res({ picture: null, why: 'the picture took too long' }), timeoutMs); });
  const work = (async () => {
    let why = 'the browser gave no picture';
    let small = null, sw = 0, sh = 0, flat = false;
    for (const [w, h, q] of tries) {
      try {
        if (!small || sw !== w || sh !== h) {
          small = doc.createElement('canvas');
          small.width = w; small.height = h; sw = w; sh = h;
          const ctx = small.getContext('2d');
          if (!ctx) { why = 'no drawing surface'; small = null; continue; }
          ctx.drawImage(canvas, 0, 0, w, h);
          flat = isFlat(ctx, w, h);
        }
        const blob = await new Promise((res, rej) => { try { small.toBlob((b) => res(b), 'image/jpeg', q); } catch (e) { rej(e); } });
        if (!blob || blob.type !== 'image/jpeg') { why = 'the browser gave no JPEG'; continue; }
        if (blob.size > target) { why = 'the picture was too large'; continue; }
        const u8 = new Uint8Array(await blob.arrayBuffer());
        if (!isJpeg(u8)) { why = 'the browser gave no JPEG'; continue; }
        return { picture: { b64: b64(u8), w, h, bytes: u8.length, flat }, why: null };
      } catch (err) {
        why = `the browser refused the picture (${scrub(err && err.name ? err.name : 'error', 30)})`;
        small = null;
      }
    }
    return { picture: null, why };
  })();
  const r = await Promise.race([work, late]);
  clearTimer(timer);
  return r;
}

// One single colour? A few points of the small picture are read; a browser that refuses the read answers "no".
function isFlat(ctx, w, h) {
  try {
    let first = null;
    for (let y = 1; y < 6; y++) for (let x = 1; x < 8; x++) {
      const d = ctx.getImageData(Math.floor((x * w) / 8), Math.floor((y * h) / 6), 1, 1).data;
      const v = (d[0] << 16) | (d[1] << 8) | d[2];
      if (first === null) first = v; else if (v !== first) return false;
    }
    return true;
  } catch { return false; }
}

/**
 * The sender: one POST of the report to the lobby with the hand-off's room token. Resolves (never rejects) to
 * { outcome: 'sent' | 'rate_hour' | 'rate_day' | 'unavailable' | 'failed', status, id, duplicate }.
 */
export function createReportSender({ handoff, fetchImpl = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null, timeoutMs = SEND_TIMEOUT_MS, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t), max = REPORT_MAX_BYTES } = {}) {
  const token = handoff && typeof handoff.room_token === 'string' ? handoff.room_token : '';
  return {
    ready: !!token && typeof fetchImpl === 'function',
    async send(report) {
      if (!token || typeof fetchImpl !== 'function') return { outcome: 'failed', status: 0 };
      const { body } = fitReport(report, max);
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      let t = null;
      const late = new Promise((res) => { t = setTimer(() => { try { if (ctl) ctl.abort(); } catch { /* gone */ } res({ outcome: 'failed', status: 0, timeout: true }); }, timeoutMs); });
      const call = (async () => {
        let res;
        try {
          res = await fetchImpl(REPORT_API, { method: 'POST', body, cache: 'no-store', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-cabinet-token': token }, ...(ctl ? { signal: ctl.signal } : {}) });
        } catch { return { outcome: 'failed', status: 0 }; }
        let j = {};
        try { j = await res.json(); } catch { j = {}; }
        return sendOutcome(res.status, j);
      })();
      const r = await Promise.race([call, late]);
      clearTimer(t);
      return r;
    },
  };
}

/** The lobby's answer, as the page reads it (docs/problem-reports.md has the table). */
export function sendOutcome(status, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (status === 200 && b.ok === true) return { outcome: 'sent', status, id: Number.isFinite(Number(b.id)) ? Number(b.id) : null, duplicate: b.duplicate === true };
  if (status === 429) return { outcome: b.window === 'day' ? 'rate_day' : 'rate_hour', status };
  if (status === 404 || (status === 503 && b.error === 'not_available')) return { outcome: 'unavailable', status };
  return { outcome: 'failed', status };
}

/** The words for an outcome. */
export function outcomeText(outcome, copy = REPORT_COPY.en) {
  return outcome === 'sent' ? copy.sent : outcome === 'rate_hour' ? copy.rateHour : outcome === 'rate_day' ? copy.rateDay : outcome === 'unavailable' ? copy.unavailable : copy.failed;
}

/**
 * THE SHEET: the button, and the small panel it opens (an optional one line note, Send, Cancel).
 *   els       { button, dialog, title, lead, label, note, status, send, cancel }: the page's own elements
 *   snapshot  () => { picture: Promise<{ picture, why }>, build: ({ note, picture, pictureNote }) => report }. Called
 *             ONCE when the sheet opens, so the report is of the moment the player pressed the button, not of the
 *             moment they finished typing. Send again after a failure sends the SAME report (the same id).
 *   send      (report) => Promise<{ outcome }>
 *   hold      (on) => void: the page holds every game input ONLY WHILE THE NOTE FIELD HAS THE FOCUS (the seat test
 *             of 2026-11-24: with the sheet open a player could not whip or hold, mid race). The sheet takes no
 *             focus when it opens, so the game's keys and buttons go on working under it; a player who taps into
 *             the note types there and nowhere else (the page's key reader already passes over a text field), and
 *             the hold ends when the field loses the focus or the sheet closes.
 * Nothing is sent before Send. Returns { open, close, isOpen, busy }.
 */
export function createReportSheet({ els, copy = REPORT_COPY.en, snapshot, send, hold = () => {}, onDone = () => {}, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t), closeMs = SUCCESS_CLOSE_MS } = {}) {
  const e = els || {};
  let snap = null;
  let report = null;
  let busy = false;
  let done = false;
  let closeTimer = null;
  let held = false; // the game's inputs are held: the note field has the focus
  const setHold = (on) => { if (held === !!on) return; held = !!on; try { hold(held); } catch { /* the page's */ } };
  const text = (el, s) => { if (el && el.textContent !== s) el.textContent = s; };
  const say = (s) => { if (!e.status) return; text(e.status, s || ''); e.status.hidden = !s; };
  const isOpen = () => !!e.dialog && e.dialog.hidden === false;

  text(e.button, copy.button);
  if (e.button && 'title' in e.button) e.button.title = copy.buttonTitle;
  text(e.title, copy.title); text(e.label, copy.noteLabel); text(e.send, copy.send); text(e.cancel, copy.cancel);
  if (e.note) { try { e.note.maxLength = NOTE_MAX; } catch { /* a fixed attribute */ } }

  function close() {
    if (closeTimer !== null) { clearTimer(closeTimer); closeTimer = null; }
    if (!isOpen()) return;
    e.dialog.hidden = true;
    snap = null; report = null; done = false;
    // The note field must not keep the focus under a closed sheet: a key meant for the game would go on typing there.
    if (e.note && typeof e.note.blur === 'function') { try { e.note.blur(); } catch { /* not shown */ } }
    setHold(false);
  }
  function open() {
    if (!e.dialog || isOpen() || busy) return false;
    try { snap = snapshot(); } catch { snap = null; }
    if (!snap) return false;
    report = null; done = false;
    if (e.note) e.note.value = '';
    text(e.lead, copy.lead);
    // The lead says so when there is no picture to send (the capture is quick; the words follow it).
    Promise.resolve(snap.picture).then((p) => { if (snap && isOpen() && !(p && p.picture)) text(e.lead, copy.leadNoPicture); }, () => {});
    say('');
    if (e.send) { e.send.hidden = false; e.send.disabled = false; }
    text(e.cancel, copy.cancel);
    e.dialog.hidden = false;
    // No focus is taken: the game's keys go on working (a focused Send would also be pressed by the game's own keys).
    // The button that opened the sheet does not keep it either after a pointer press (room-seat-input.js gives the
    // focus back to the page), and the note field never has it until the member puts it there.
    return true;
  }
  async function submit() {
    if (!isOpen() || busy || done || !snap) return null;
    busy = true;
    if (e.send) e.send.disabled = true;
    say(copy.sending);
    let r;
    try {
      if (!report) {
        let p = null;
        try { p = await snap.picture; } catch { p = null; }
        report = snap.build({ note: e.note ? e.note.value : '', picture: p ? p.picture : null, pictureNote: p ? p.why : 'the picture failed' });
      } else if (e.note) report = { ...report, note: cleanNote(e.note.value) };
      r = await send(report);
    } catch { r = { outcome: 'failed', status: 0 }; }
    busy = false;
    // The page is told first, with the words (2026-11-24: a sheet that had closed meanwhile said nothing at all, so
    // a member could not tell the report went through; the page shows the line in its own status strip).
    try { onDone(r, outcomeText(r.outcome, copy)); } catch { /* the page's */ }
    if (!isOpen()) return r;
    say(outcomeText(r.outcome, copy));
    if (r.outcome === 'sent') {
      done = true;
      if (e.send) e.send.hidden = true;
      text(e.cancel, copy.close);
      closeTimer = setTimer(() => { closeTimer = null; close(); }, closeMs);
    } else if (e.send) e.send.disabled = r.outcome === 'rate_hour' || r.outcome === 'rate_day' || r.outcome === 'unavailable';
    return r;
  }

  const on = (el, type, fn) => { if (el && typeof el.addEventListener === 'function') el.addEventListener(type, fn); };
  on(e.button, 'click', () => { open(); });
  on(e.send, 'click', () => { submit(); });
  on(e.cancel, 'click', () => { if (!busy) close(); });
  on(e.note, 'focus', () => { if (isOpen()) setHold(true); });
  on(e.note, 'blur', () => { setHold(false); });
  on(e.note, 'keydown', (ev) => { if (ev && ev.key === 'Enter') { if (typeof ev.preventDefault === 'function') ev.preventDefault(); submit(); } });
  return { open, close, submit, isOpen, busy: () => busy };
}
