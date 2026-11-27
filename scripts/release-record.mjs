#!/usr/bin/env node
// release-record.mjs: the release record of one tag, the "release manifest minimum": every published source file of
// the tag with its SHA-256, the SHA-256 of the tag's source archive, the licences, the build steps, the versions
// inside the served cores and, when the deploy folders are given, the SHA-256 of every file the game pages serve
// with the source file each one comes from.
//
// Copyright (C) 2026 John R Reeves III, MHA
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Written by Claude (Claude Code), 2026-11-26.
//
// Usage (from a doc-browser-source checkout that has the tag):
//
//   node scripts/release-record.mjs --tag web-2026.11.26-1 --repo-url https://github.com/<owner>/<repo> \
//     [--room-seat <doc-arcade>/room-assets] [--pilot <doc-arcade>/pilot-assets] \
//     [--built "room-seat=<when and how>"] [--built "pilot=<when and how>"] [--reviewer "<name>"] [--out RELEASES]
//   node scripts/release-record.mjs --check RELEASES/web-2026.11.26-1.json [--room-seat <dir>] [--pilot <dir>]
//
// Write mode writes <out>/<tag>.sha256 (one "<sha256>  <path>" line per file in the tag, as stored in Git, so
// `sha256sum -c` checks an unpacked source archive) and <out>/<tag>.json (the record). Check mode recomputes both
// from the tag and, for each deploy folder given, the served files, and exits 1 on any difference.
//
// It reads only the tag's Git objects and, in a deploy folder, the files the routes serve (.js, .wasm, .txt and the
// seat page). It never reads a game file: the routes serve none, and the policy check keeps them out of the tag.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAG_RE = /^web-\d{4}\.\d{2}\.\d{2}-\d+$/;
// The same refusals as scripts/check_no_rom.py, applied to the tag itself.
const REFUSED_EXT = new Set(['.ic22', '.zip', '.bin', '.nvmem', '.card', '.chd', '.wasm', '.a', '.o']);
const MAX_BYTES = 2 * 1024 * 1024;
// Plain git archive output, independent of this machine's line ending settings, so the hash repeats anywhere.
const ARCHIVE_ARGS = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar'];

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// Flycast embeds `git describe --tags` of its source tree, for example "v2.6-328-gb3e207a43".
export function flycastVersion(buf) {
  const m = /v\d+\.\d+-\d+-g([0-9a-f]{7,40})/.exec(buf.toString('latin1'));
  return m ? m[0] : null;
}

function git(args, opts = {}) {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], { maxBuffer: 256 * 1024 * 1024, ...opts });
}
const gitText = (args) => git(args, { encoding: 'utf8' }).trim();

// Every file of the tree: [{ path, mode, blob }], in Git's path order.
export function parseLsTree(out) {
  return out.split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, blob] = line.slice(0, tab).split(' ');
    return { mode, type, blob, path: line.slice(tab + 1) };
  });
}

export function sha256List(files) {
  return files.map((f) => `${f.sha256}  ${f.path}\n`).join('');
}

export function policyProblems(files) {
  const out = [];
  for (const f of files) {
    const ext = f.path.slice(f.path.lastIndexOf('.')).toLowerCase();
    if (f.path.lastIndexOf('.') > f.path.lastIndexOf('/') && REFUSED_EXT.has(ext)) out.push(`${f.path}: refused file type ${ext}`);
    if (f.bytes > MAX_BYTES) out.push(`${f.path}: larger than 2 MB`);
  }
  return out;
}

export function tagFiles(commit) {
  const entries = parseLsTree(git(['ls-tree', '-r', '-z', '--full-tree', commit], { encoding: 'utf8' }));
  return entries.map((e) => {
    if (e.type !== 'blob') throw new Error(`unexpected ${e.type} at ${e.path}`);
    const buf = git(['cat-file', 'blob', e.blob]);
    return { path: e.path, bytes: buf.length, sha256: sha256(buf), git_blob: e.blob };
  });
}

// The pilot sync (doc-arcade scripts/sync-pilot-game.mjs) moves the lb modules one folder down and adjusts the
// relative imports to match (SOURCE.md section 1). These undo it, so a served file can be compared with its source.
export function unadjustPilot(text, inLb) {
  if (inLb) return text.replace(/from '\.\.\/([a-z0-9-]+\.js)'/g, "from './$1'");
  return text.replace(/(from |import\()'\.\/lb\/(lb-[a-z0-9-]+\.js)'/g, "$1'./$2'");
}

const lf = (buf) => Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');

// Where each served file comes from. Returns null for a deploy folder file the route does not serve.
export function servedSource(kind, rel) {
  const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase();
  if (kind === 'room-seat') {
    if (rel === 'SOURCE.txt') return { what: 'deploy note' };
    if (rel === 'mp-seat.html') return { what: 'page', source: 'host/room-seat/mp-seat.html' };
    if (!rel.startsWith('src/') || !['.js', '.wasm', '.txt'].includes(ext)) return null;
    if (rel.startsWith('src/core/')) return { what: 'core' };
    return { what: 'module', source: 'host/room-seat/' + rel };
  }
  if (kind === 'pilot') {
    if (rel === 'SOURCE.txt') return { what: 'deploy note' };
    if (!rel.startsWith('src/') || !['.js', '.wasm', '.txt'].includes(ext)) return null;
    if (rel.startsWith('src/core/') || rel.startsWith('src/lb/core/')) return { what: 'core' };
    const inLb = rel.startsWith('src/lb/');
    return { what: 'module', source: 'host/src/' + rel.slice(inLb ? 7 : 4), inLb };
  }
  throw new Error('unknown deploy kind ' + kind);
}

function walk(root) {
  const out = [];
  const go = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) go(full);
      else out.push(relative(root, full).split(sep).join('/'));
    }
  };
  go(root);
  return out;
}

export function servedFiles(kind, dir, blobOf) {
  const root = resolve(dir);
  const files = [];
  for (const rel of walk(root)) {
    const src = servedSource(kind, rel);
    if (!src) continue;
    const buf = readFileSync(join(root, ...rel.split('/')));
    const f = { path: rel, what: src.what, bytes: buf.length, sha256: sha256(buf) };
    if (src.what === 'core' && rel.endsWith('.wasm')) f.flycast_version = flycastVersion(buf);
    if (src.source) {
      f.source = src.source;
      const blob = blobOf(src.source);
      if (!blob) f.match = 'not in the tag';
      else {
        let served = lf(buf);
        if (kind === 'pilot') served = Buffer.from(unadjustPilot(served.toString('latin1'), src.inLb), 'latin1');
        const same = served.equals(lf(blob));
        f.match = !same ? 'DIFFERS' : buf.equals(blob) ? 'same bytes' : kind === 'pilot' && !lf(buf).equals(lf(blob))
          ? 'same after the import paths of SOURCE.md section 1' : 'same apart from line ends';
      }
    }
    files.push(f);
  }
  return files;
}

function parseArgs(argv) {
  const out = { built: {}, served: {}, out: 'RELEASES' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tag') out.tag = argv[++i];
    else if (a === '--repo-url') out.repoUrl = argv[++i];
    else if (a === '--check') out.check = argv[++i];
    else if (a === '--room-seat') out.served['room-seat'] = argv[++i];
    else if (a === '--pilot') out.served.pilot = argv[++i];
    else if (a === '--built') { const [k, ...v] = argv[++i].split('='); out.built[k] = v.join('='); }
    else if (a === '--reviewer') out.reviewer = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else throw new Error('unknown argument ' + a);
  }
  return out;
}

function buildRecord(opts, now = new Date()) {
  const { tag, repoUrl } = opts;
  const commit = gitText(['rev-parse', '--verify', `${tag}^{commit}`]);
  const tree = gitText(['rev-parse', '--verify', `${tag}^{tree}`]);
  const tagObject = gitText(['rev-parse', '--verify', `refs/tags/${tag}`]);
  const tagDate = gitText(['for-each-ref', '--format=%(taggerdate:iso-strict)%(committerdate:iso-strict)', `refs/tags/${tag}`]);
  const files = tagFiles(commit);
  const problems = policyProblems(files);
  if (problems.length) throw new Error('the tag breaks the repository policy: ' + problems.join('; '));
  const archive = git([...ARCHIVE_ARGS, commit]);
  const list = sha256List(files);
  const blobs = new Map(files.map((f) => [f.path, f.git_blob]));
  const blobOf = (p) => (blobs.has(p) ? git(['cat-file', 'blob', blobs.get(p)]) : null);
  const served = {};
  for (const [kind, dir] of Object.entries(opts.served)) {
    served[kind] = { route: kind === 'pilot' ? '/pilot' : '/room-seat', built: opts.built[kind] || null, files: servedFiles(kind, dir, blobOf) };
  }
  return {
    record: {
      schema: 1,
      release: tag,
      name: 'Derby Owners Club browser game: cores, game page and room seat page',
      source: {
        repository: repoUrl,
        tag,
        tag_object: tagObject,
        commit,
        tree,
        tagged: tagDate,
        browse: `${repoUrl}/tree/${tag}`,
        download: `${repoUrl}/archive/refs/tags/${tag}.zip`,
        files: files.length,
        file_list: `${tag}.sha256`,
        file_list_sha256: sha256(Buffer.from(list)),
        archive: {
          made_with: `git ${ARCHIVE_ARGS.join(' ')} ${commit}`,
          git_version: gitText(['--version']),
          bytes: archive.length,
          sha256: sha256(archive),
          note: 'The zip GitHub offers is made by GitHub and is not hashed here; check its files against the file list.',
        },
      },
      licences: {
        own_code: 'GPL-2.0-or-later (LICENSE, COPYRIGHT)',
        cores: 'GPL-2.0-only: each combined core carries picoTCP (GPL-2.0-only OR GPL-3.0-only); see COPYRIGHT and SOURCE.md section 8',
        third_party: 'THIRD_PARTY_NOTICES.md',
        each_file: 'Each source file keeps its own licence.',
      },
      build_steps: 'SOURCE.md at this tag: section 3 (toolchain), 4 (rebuild), 5 (getting the same bytes), 9 (the room seat core)',
      dependencies: 'Upstream Flycast 8412d3d8a and the submodule pins of SOURCE.md section 2; the version string inside each served core is listed below',
      game_data: 'None. The tag passes the policy check (no ROM, BIOS, card, save or binary file types, nothing over 2 MB); the player supplies the game files.',
      served,
      recorded_utc: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      reviewer: opts.reviewer || null,
      source_kept_until: 'Project policy: kept public indefinitely, and never less than three years after these files were last served.',
    },
    list,
    archive,
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.check) {
    const path = resolve(opts.check);
    const want = JSON.parse(readFileSync(path, 'utf8'));
    const got = buildRecord({ tag: want.release, repoUrl: want.source.repository, served: opts.served, built: {} });
    const bad = [];
    const g = got.record.source, w = want.source;
    for (const k of ['commit', 'tree', 'tag_object', 'files', 'file_list_sha256']) if (g[k] !== w[k]) bad.push(`source.${k}`);
    if (g.archive.sha256 !== w.archive.sha256) bad.push(`source archive (made with ${g.archive.git_version}; recorded with ${w.archive.git_version})`);
    const listPath = join(dirname(path), w.file_list);
    if (!existsSync(listPath) || readFileSync(listPath, 'utf8') !== got.list) bad.push(w.file_list);
    for (const [kind, s] of Object.entries(got.record.served)) {
      const old = new Map((want.served?.[kind]?.files || []).map((f) => [f.path, f.sha256]));
      if (!want.served?.[kind]) { bad.push(`no ${kind} files in the record`); continue; }
      for (const f of s.files) if (old.get(f.path) !== f.sha256) bad.push(`${kind} ${f.path}`);
      for (const p of old.keys()) if (!s.files.some((f) => f.path === p)) bad.push(`${kind} ${p} missing`);
    }
    if (bad.length) { for (const b of bad) console.error('DIFFERS ' + b); process.exit(1); }
    console.log(`record matches ${want.release}: ${g.files} source files${Object.keys(got.record.served).map((k) => `, ${k} ${got.record.served[k].files.length} served files`).join('')}`);
    return;
  }
  if (!TAG_RE.test(opts.tag || '')) throw new Error('--tag web-YYYY.MM.DD-N is required');
  if (!/^https:\/\/\S+[^/]$/.test(opts.repoUrl || '')) throw new Error('--repo-url https://<host>/<owner>/<repo> is required');
  const { record, list } = buildRecord(opts);
  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${opts.tag}.sha256`), list);
  writeFileSync(join(outDir, `${opts.tag}.json`), JSON.stringify(record, null, 2) + '\n');
  console.log(`wrote ${opts.tag}.json and ${opts.tag}.sha256 in ${outDir}: ${record.source.files} source files`);
  for (const [kind, s] of Object.entries(record.served)) {
    const differs = s.files.filter((f) => f.match === 'DIFFERS' || f.match === 'not in the tag');
    console.log(`  ${kind}: ${s.files.length} served files, ${differs.length} not matching the tag${differs.length ? ': ' + differs.map((f) => f.path).join(', ') : ''}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error('release-record: ' + e.message); process.exit(2); }
}
