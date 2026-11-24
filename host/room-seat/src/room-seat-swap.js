// room-seat-swap.js: the order of work of a HORSE CHANGE in the room seat, and what happens at each point it can
// break (doc-arcade docs/rooms/seat-horse-switch.md, the lobby's contract; docs/seat-contract.md here). Pure: the
// page (mp-seat.js) gives it the calls, so the order and every crash point are tested without a browser.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// One seat visit holds the station; horses come and go. A change runs in this order, and never in another:
//   card      the old card's last look, and the old horse's save queue drained (nothing of it is owed)
//   hold      POST <room server>/hold { reservation }: 200 only with no race entry or result in flight; from then
//             the room server enters no race for the station
//   lobby     POST /api/room/lease { action: "swap", lease_id: <old>, horse_id | new_horse }: the lobby ends the old
//             lease and opens the new one in one step, and answers with a seat ticket for the new lease
//   lease     the page takes the new lease: the old beat stops, the new lease is beaten at once (adopt)
//   checkout  the new lease's card (none for a new horse)
//   reader    the board's card-swap: the new card in the reader (or an empty reader), a new card generation
//   rebind    POST <room server>/rebind { reservation, ticket }: the room server binds the station to the new lease
//   done
//
// What each failure does (the outcome's `outcome`):
//   kept     NOTHING CHANGED: the old lease is live, the hold (if it was given) is released, the member plays on.
//            `words` is what to show: the lobby's own for a lobby refusal, the room server's for a refused hold.
//   leave    the seat has no usable lease (the old one ended, or the change could not be finished after the lobby
//            made it): the page ends the seat with `words`. Where a new lease was taken it is closed first.
//   done     the new horse's card is in the reader and the station is bound to the new lease.
//   aborted  the seat ended while the change ran (the page's own end path owns everything from there).
// The points, one by one:
//   hold refused (409)            kept, with the room server's words (mid race: "You can change horses after this race.")
//   hold with no answer           two more tries, then kept
//   lobby refusal                 kept, the hold released, the lobby's words; 410 or lease_ended: leave
//   lobby with no answer          the SAME request again (the lobby answers a repeat of a change that happened with
//                                 resumed: true); after SWAP_LOBBY_TRIES sends the old lease is asked after: live means
//                                 kept, ended means the change happened and the request goes on being sent
//   swapped: true (ticket refused) the change stands: the new lease is taken and beaten, the station stays on hold,
//                                 and the same request is sent again for the ticket
//   checkout or reader failure    the new lease is closed, leave
//   rebind failure                the same ticket once more (a lost reply answers already: true), then a fresh
//                                 ticket through the lobby's retry rule, at most SWAP_TICKET_TRIES tickets; a rebind
//                                 told to wait (a race in flight) waits and asks again; for good: the new lease is
//                                 closed, leave
// A page reload cannot be handled here (the page is gone): docs/seat-contract.md says how it recovers.

export const SWAP_STEPS = Object.freeze(['card', 'hold', 'lobby', 'lease', 'checkout', 'reader', 'rebind', 'done']);
/** Sends of the same swap request that get no answer before the old lease is asked after. */
export const SWAP_LOBBY_TRIES = 3;
/** Sends of the swap request that ask for a seat ticket of the new lease, at most (the change's own send is the first). */
export const SWAP_TICKET_TRIES = 4;
/** Rebind calls for one change at most. */
export const SWAP_REBIND_TRIES = 10;
export const SWAP_RETRY_MS = 3000;
/** A rebind the room server told to wait (a race still in flight for the station). */
export const SWAP_REBIND_WAIT_MS = 5000;

/** The lobby's own sentence for an answer it has no words for (seat-horse-switch.md section 4). */
export const SWAP_FALLBACK_TEXT = 'You cannot change horses right now. Try again in a minute.';
/** The line a card held out of the reader gets ("[name] is in your hand. ..."): true only until the card goes in. */
const HAND_LINE_END = ' is in your hand. Press Insert card to put it in.';
export const isHandLine = (text) => typeof text === 'string' && text.endsWith(HAND_LINE_END);
/** The seat's own lines (things the lobby never sees): plain words, no codes. */
export const SWAP_TEXT = Object.freeze({
  cardBusy: (name) => `${name}'s card is still being saved. Try again in a moment.`,
  cardIn: (name) => `${name} is still in the game. Finish this game first: when the game gives the card back you can change horses.`,
  roomUnreachable: 'The room did not answer, so nothing was changed. You can keep playing, or try again in a moment.',
  lobbyUnreachable: 'The rooms did not answer, so nothing was changed. You can keep playing, or try again in a moment.',
  roomRefused: 'This room cannot change horses right now. Nothing was changed.',
  failed: (name) => `The change to ${name} could not be finished, so this seat has to close. Nothing was lost. Go back to the rooms and sit down again.`,
  lost: 'The rooms did not answer the change, so this seat has to close. Nothing was lost. Go back to the rooms and sit down again.',
  working: (name) => `Changing to ${name}. One moment.`,
  done: (name) => `${name}${HAND_LINE_END}`,
  // The card went in (the insert button, or the game wrote it): the "in your hand" line is no longer true.
  cardNowIn: (name) => `${name}'s card is in the game.`,
  doneNew: 'The reader is empty. Make your new horse in the game. It can race once it is saved.',
  doneAdopt: 'Saving the new horse you made. Your buttons are off until it is saved.',
});

/**
 * THE SEAT'S OWN LINE ONCE THE CARD IS IN THE GAME (the seat test of 2026-11-24: it read "Seat 1. You can enter the
 * next race." through a whole race). What is true at each stage, from what the seat's own board says:
 *   the card in, no race on                    "[name]'s card is in the game."
 *   a race on that this seat entered           "[name]'s card is in the game. Your race is running."
 *   a race on that it did not enter            "[name]'s card is in the game. This race started without you. You can enter the next one."
 *   for RACE_OVER_MS after its own race ended  "[name]'s card is in the game. The race is over."
 * null while the card is not in the game (the page's other lines say what to do then). cardIn: the reader has the
 * card; raceOn: the board's race flag; entered: this seat was entered when it went up; overMs: ms since a race this
 * seat ran ended, or null.
 */
export const RACE_OVER_MS = 45000;
export function stationLine({ name, cardIn = false, raceOn = false, entered = false, overMs = null } = {}) {
  if (!cardIn) return null;
  const base = SWAP_TEXT.cardNowIn(name);
  if (raceOn) return entered ? `${base} Your race is running.` : `${base} This race started without you. You can enter the next one.`;
  if (typeof overMs === 'number' && overMs >= 0 && overMs < RACE_OVER_MS) return `${base} The race is over.`;
  return base;
}
/** The lines the page puts up when the station is the seat's ("Seat 1 in room r1.", "Seat 1. You can enter the next race."): stationLine may replace them, and nothing else that is not its own. */
export const isSeatStartLine = (text) => typeof text === 'string' && /^Seat [0-9]{1,2}(?: in room [\w-]{1,64})?\.(?: You can enter the next race\.)?$/.test(text);

const isWords = (s) => typeof s === 'string' && s.trim().length > 0 && !/^[a-z0-9_]+$/.test(s.trim());
const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 300);
/**
 * What to show for a refusal: the sender's own words (`error`, or `message` in a horses answer), as they are. A body
 * with no words (a bare code, or nothing), and a 400 or 401 (whose text is for a programmer), get the lobby's own
 * fallback sentence. Never an invented reason.
 */
export function refusalWords(body, status = 0) {
  const b = body && typeof body === 'object' ? body : {};
  const own = isWords(b.error) ? b.error : isWords(b.message) ? b.message : null;
  if (!own) return SWAP_FALLBACK_TEXT;
  if ((status === 400 || status === 401) && typeof b.code !== 'string') return SWAP_FALLBACK_TEXT;
  return clean(own);
}
const codeOf = (body) => (body && typeof body.code === 'string' && /^[a-z0-9_]{1,40}$/.test(body.code) ? body.code : null);
const okReply = (r) => !!r && !r.network && r.status >= 200 && r.status < 300 && !!r.body && r.body.ok !== false;
const noAnswer = (r) => !r || r.network === true || r.status >= 500 || r.status === 0;

/**
 * runHorseSwap(choice, deps) -> { outcome, code, words, session, steps, ... }
 *   choice  { horseId, name } for one of the member's horses, or { newHorse: true, name } (adopt: true when the card
 *           the game already wrote is the new horse's)
 *   deps    cardOut()            -> { ok } | { ok: false, words }   the old card's last look and its queue's drain
 *           hold()               -> { status, body } | { network: true }
 *           releaseHold()        -> anything (best effort; never throws)
 *           lobbySwap(choice)    -> { status, body } | { network: true }   the SAME request every time
 *           oldLeaseLive()       -> true | false | null (not known)
 *           adopt(reply)         -> the new lease's session (the old beat stopped, the new one started), or null
 *           checkout(session)    -> { ok: true, card, newHorse } | { ok: false, why }
 *           cardSwap(session, co)-> { ok: true } | { ok: false, why }
 *           rebind(ticket)       -> { status, body } | { network: true }
 *           ticketLive(expS)     -> the ticket can still be used (its exp, unix seconds, against the servers' clock)
 *           abandon(session)     -> closes the new lease (best effort)
 *           ended()              -> the seat has ended (the change stops at its next step)
 *           wait(ms), onStep(name)
 */
export async function runHorseSwap(choice, deps) {
  const d = deps;
  const steps = [];
  const step = (s) => { steps.push(s); try { if (d.onStep) d.onStep(s); } catch { /* the page's */ } };
  const out = (o) => ({ code: null, words: null, session: null, ...o, steps });
  const quiet = async (fn) => { try { return await fn(); } catch { return null; } };
  const ended = () => { try { return !!d.ended(); } catch { return false; } };
  const name = choice && choice.name ? choice.name : 'your horse';

  // 1. The old card.
  step('card');
  const c = await quiet(() => d.cardOut());
  if (ended()) return out({ outcome: 'aborted' });
  if (!c || c.ok !== true) return out({ outcome: 'kept', code: 'card', words: (c && c.words) || SWAP_FALLBACK_TEXT });

  // 2. The hold.
  step('hold');
  let h = null;
  for (let i = 0; i < 3; i++) {
    h = await quiet(() => d.hold());
    if (ended()) return out({ outcome: 'aborted' });
    if (!(noAnswer(h) || h.status === 429)) break;
    if (i < 2) await d.wait(SWAP_RETRY_MS);
  }
  if (!okReply(h)) {
    if (noAnswer(h) || h.status === 429) return out({ outcome: 'kept', code: 'room_unreachable', words: SWAP_TEXT.roomUnreachable });
    // A refusal with the room server's own words (409: a race in flight, or a cap of the visit); any other answer
    // (an older room server: 404) means this room cannot change horses.
    if (h.status === 409) return out({ outcome: 'kept', code: codeOf(h.body) || 'hold_refused', words: refusalWords(h.body, 409), status: 409 });
    return out({ outcome: 'kept', code: 'no_hold', words: SWAP_TEXT.roomRefused, status: h.status });
  }
  const kept = async (o) => { await quiet(() => d.releaseHold()); return out({ outcome: 'kept', ...o }); };

  // 3. The lobby's swap. One request, sent again as it is whenever it got no answer.
  step('lobby');
  let session = null;
  let tickets = 0;
  // One send. Returns { reply } (a 200 with a ticket, or a swapped: true body), { refused } or { none }.
  const send = async () => {
    const r = await quiet(() => d.lobbySwap(choice));
    if (noAnswer(r)) return { none: true };
    if (okReply(r) && typeof r.body.ticket === 'string' && r.body.ticket) return { reply: r.body, ticket: true };
    // The change stands and only the ticket was refused (swapped: true); a 2xx that names a new lease and no ticket
    // is read the same way (never as "nothing changed").
    if (r.body && (r.body.swapped === true || (okReply(r) && typeof r.body.lease_id === 'string'))) return { reply: r.body, ticket: false, wait: Number(r.body.retry_after_s) > 0 ? Math.min(60000, Number(r.body.retry_after_s) * 1000) : SWAP_RETRY_MS };
    return { refused: r };
  };
  let first = null;
  let sends = 0;
  let asked = false;
  for (;;) {
    const a = await send();
    sends++;
    if (ended()) return out({ outcome: 'aborted' });
    if (a.reply) { first = a; break; }
    if (a.refused) {
      const r = a.refused;
      const words = refusalWords(r.body, r.status);
      const code = codeOf(r.body);
      // The old lease is gone (410, or the step refused after it ended it): the seat has no lease.
      if (r.status === 410 || (r.body && r.body.lease_ended === true)) { await quiet(() => d.releaseHold()); return out({ outcome: 'leave', code: code || 'lease_ended', words, status: r.status }); }
      if (r.status === 401) { await quiet(() => d.releaseHold()); return out({ outcome: 'leave', code: 'token', words, status: 401 }); }
      // Any other refusal: nothing has changed.
      return kept({ code, words, status: r.status, body: r.body });
    }
    // No answer. After SWAP_LOBBY_TRIES sends the old lease says whether the change happened.
    if (sends >= SWAP_LOBBY_TRIES && !asked) {
      asked = true;
      const live = await quiet(() => d.oldLeaseLive());
      if (ended()) return out({ outcome: 'aborted' });
      if (live !== false) return kept({ code: 'unreachable', words: SWAP_TEXT.lobbyUnreachable });
      // The old lease has ended: the change happened. The same request is the only way to its ticket.
    }
    if (sends >= SWAP_LOBBY_TRIES * 2) { await quiet(() => d.releaseHold()); return out({ outcome: 'leave', code: 'swap_lost', words: SWAP_TEXT.lost }); }
    await d.wait(SWAP_RETRY_MS);
    if (ended()) return out({ outcome: 'aborted' });
  }

  // 4. The new lease: taken at once (its beat starts), with or without a ticket yet.
  step('lease');
  session = d.adopt(first.reply);
  if (!session) { await quiet(() => d.releaseHold()); return out({ outcome: 'leave', code: 'bad_reply', words: SWAP_TEXT.lost }); }
  const forGood = async (code) => {
    await quiet(() => d.abandon(session));
    await quiet(() => d.releaseHold());
    return out({ outcome: 'leave', code, words: SWAP_TEXT.failed(name), session });
  };
  let ticket = first.ticket ? { t: first.reply.ticket, exp: first.reply.exp } : null;
  tickets = 1; // the change's own send asked for one, given or not
  let ticketWait = first.ticket ? 0 : first.wait;
  // A ticket for the new lease through the lobby's retry rule (the same request again). null: none to be had.
  const freshTicket = async () => {
    while (tickets < SWAP_TICKET_TRIES) {
      if (ticketWait > 0) { await d.wait(ticketWait); if (ended()) return null; }
      tickets++;
      const a = await send();
      if (ended()) return null;
      if (a.reply && a.ticket) { ticketWait = 0; return { t: a.reply.ticket, exp: a.reply.exp }; }
      if (a.refused && !noAnswer(a.refused) && a.refused.status !== 429) return null; // the lobby says no for good (410: not this change)
      ticketWait = a.reply && a.wait ? a.wait : SWAP_RETRY_MS;
    }
    return null;
  };

  // 5. The new lease's card.
  step('checkout');
  const co = await quiet(() => d.checkout(session));
  if (ended()) return out({ outcome: 'aborted', session });
  if (!co || co.ok !== true) return forGood('checkout');

  // 6. The reader.
  step('reader');
  const sw = await quiet(() => d.cardSwap(session, co));
  if (ended()) return out({ outcome: 'aborted', session });
  if (!sw || sw.ok !== true) return forGood('reader');

  // 7. The rebind.
  step('rebind');
  let sameAgain = false;
  for (let tries = 0; tries < SWAP_REBIND_TRIES; tries++) {
    if (!ticket || !d.ticketLive(ticket.exp)) {
      ticket = await freshTicket();
      sameAgain = false;
      if (ended()) return out({ outcome: 'aborted', session });
      if (!ticket) return forGood('ticket');
    }
    const r = await quiet(() => d.rebind(ticket.t));
    if (ended()) return out({ outcome: 'aborted', session });
    if (okReply(r)) { step('done'); return out({ outcome: 'done', session, newHorse: co.newHorse === true, repeat: r.body.already === true }); }
    if (noAnswer(r) || r.status === 429) {
      // The reply may be lost: the same ticket once more (the room server answers a repeat as done), then a fresh one.
      if (sameAgain) ticket = null;
      sameAgain = true;
      await d.wait(SWAP_RETRY_MS);
      if (ended()) return out({ outcome: 'aborted', session });
      continue;
    }
    const code = codeOf(r.body);
    if (r.status === 409 && (code === 'race_owed' || code === 'settling')) { await d.wait(SWAP_REBIND_WAIT_MS); if (ended()) return out({ outcome: 'aborted', session }); continue; }
    // A ticket the room server would not take (used, run out, its clock): a fresh one. Anything else is for good.
    if (r.status === 403 && code === null) { ticket = null; sameAgain = false; continue; }
    return forGood(code || 'rebind');
  }
  return forGood('rebind');
}
