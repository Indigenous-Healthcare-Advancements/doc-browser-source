// lab-game-set.js: which game set and link tag the lab cabinet page
// (multiboard.html) runs for an edition. Lab only; the player pages keep
// their own setup checks (rom-setup.js). Everything comes from the edition
// registry (editions.js), never from a lab list: the game file is the
// edition's release set (`<release>.zip`) and the link tag is its linkTag.
// Flycast picks the ROM table entry from the zip's file name, so the page
// must load the game under its own set name (a Rev D zip renamed to
// drbyocwc.zip would be looked up as Rev C and fail).
// The lab page runs every registered edition, buildable or not, so a core
// and link lane can probe an edition before the player game offers it.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later

import { EDITION_REGISTRY, editionDef } from './editions.js';

/** The registry row's lab game set: { edition, game, release, linkTag, build }, or null. */
export function labGameSet(edition) {
  const d = editionDef(edition);
  if (!d) return null;
  return Object.freeze({ edition: d.id, game: `${d.release}.zip`, release: d.release, linkTag: d.linkTag, build: d.build });
}

/**
 * names: the picked file names. Returns the edition's set when its game file
 * is among them, or { error } with a plain message. Extra game files are
 * ignored; the edition decides which one runs.
 */
export function pickLabGameSet(names, edition = 'A') {
  const set = labGameSet(edition);
  if (!set) return { error: `Unknown edition ${edition}. Editions: ${EDITION_REGISTRY.map((e) => e.id).join(', ')}.` };
  const have = new Set(names.map((n) => String(n).toLowerCase()));
  if (!have.has(set.game)) return { error: `Need ${set.game} and naomi.zip for edition ${set.edition}.` };
  return set;
}

/**
 * The edition a lab runner uses for a game file when none is named: the
 * registry's stock edition of that release (drbyocwc.zip is A, never B).
 * null when no registered release has that file name.
 */
export function stockEditionForGame(fileName) {
  const n = String(fileName).toLowerCase();
  const d = EDITION_REGISTRY.find((e) => e.build === 'stock' && `${e.release}.zip` === n);
  return d ? d.id : null;
}

/**
 * The game set a room or seat page runs (mp-room.js, mp-seat.js), never a
 * silent 'A'. edition: the registry id the page was told (the room server's
 * release, the seat ticket's link tag), or null. Told: that edition's game
 * file must be among the picked names, or { error } names the mismatch.
 * Not told: the edition comes from the picked game files (the registry's
 * stock edition of each, so derbyoc.zip is J99 and drbyocwc.zip is A);
 * none, or two different editions, is { error }.
 */
export function pageGameSet(names, edition = null) {
  const picked = names.map((n) => String(n).toLowerCase());
  const found = [...new Set(picked.map((n) => stockEditionForGame(n)).filter(Boolean))];
  if (edition !== null && edition !== undefined && edition !== '') {
    const set = labGameSet(edition);
    if (!set) return { error: `Unknown edition ${String(edition).slice(0, 16)}.` };
    if (!picked.includes(set.game)) return { error: `Edition ${set.edition} runs ${set.game}, but the picked game files are ${found.map((e) => labGameSet(e).game).join(', ') || 'none'}.` };
    return set;
  }
  if (found.length === 0) return { error: 'No known game file picked (with naomi.zip).' };
  if (found.length > 1) return { error: `More than one game picked (${found.map((e) => labGameSet(e).game).join(', ')}): pick one.` };
  return labGameSet(found[0]);
}

/** The registry id of a link tag (the seat ticket's edition), or null. */
export function editionForLinkTag(tag) {
  const d = Number.isInteger(tag) ? EDITION_REGISTRY.find((e) => e.linkTag === tag) : null;
  return d ? d.id : null;
}

/**
 * Lab only: `?mixtag=<board label>:<tag>` gives one board a different link
 * edition tag, to check that the link refuses mixed editions. Returns
 * { [label]: tag } or {} (absent or malformed: no mixing).
 */
export function parseMixTag(v) {
  const m = /^(board[0-9]|partner):([0-9]{1,3})$/.exec(String(v || ''));
  if (!m) return {};
  const tag = Number(m[2]);
  return tag > 255 ? {} : { [m[1]]: tag };
}
