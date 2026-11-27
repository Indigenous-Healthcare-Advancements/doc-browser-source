// Tests for release-record.mjs (node --test scripts/release-record.test.mjs). No Git repository or deploy folder is
// needed: only the pure helpers are tested.
//
// Copyright (C) 2026 John R Reeves III, MHA
// SPDX-License-Identifier: GPL-2.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flycastVersion, parseLsTree, policyProblems, servedSource, sha256, sha256List, unadjustPilot } from './release-record.mjs';

test('sha256 of the empty input', () => {
  assert.equal(sha256(Buffer.alloc(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('parseLsTree reads mode, type, blob and paths with spaces', () => {
  const out = ['100644 blob aaaa\tREADME.md', '100755 blob bbbb\tscripts/a b.sh', ''].join('\u0000');
  assert.deepEqual(parseLsTree(out), [
    { mode: '100644', type: 'blob', blob: 'aaaa', path: 'README.md' },
    { mode: '100755', type: 'blob', blob: 'bbbb', path: 'scripts/a b.sh' },
  ]);
});

test('sha256List is in the sha256sum format', () => {
  assert.equal(sha256List([{ sha256: 'ab', path: 'x/y.js' }, { sha256: 'cd', path: 'z' }]), 'ab  x/y.js\ncd  z\n');
});

test('policyProblems refuses game and binary file types and large files', () => {
  const p = policyProblems([
    { path: 'host/src/main.js', bytes: 10 },
    { path: 'roms/game.zip', bytes: 10 },
    { path: 'core/flycast_libretro.wasm', bytes: 10 },
    { path: 'big.txt', bytes: 3 * 1024 * 1024 },
    { path: 'dir.zip/README', bytes: 10 },
  ]);
  assert.deepEqual(p, ['roms/game.zip: refused file type .zip', 'core/flycast_libretro.wasm: refused file type .wasm', 'big.txt: larger than 2 MB']);
});

test('unadjustPilot undoes the pilot sync import paths', () => {
  assert.equal(unadjustPilot("import { a } from '../core-bridge.js';\nimport { b } from './lb-lockstep.js';", true),
    "import { a } from './core-bridge.js';\nimport { b } from './lb-lockstep.js';");
  assert.equal(unadjustPilot("import { c } from './lb/lb-cabinet.js';\nconst m = import('./lb/lb-net-layout.js');", false),
    "import { c } from './lb-cabinet.js';\nconst m = import('./lb-net-layout.js');");
});

test('servedSource maps served files to their source and skips what is not served', () => {
  assert.deepEqual(servedSource('room-seat', 'mp-seat.html'), { what: 'page', source: 'host/room-seat/mp-seat.html' });
  assert.deepEqual(servedSource('room-seat', 'src/mp-wire.js'), { what: 'module', source: 'host/room-seat/src/mp-wire.js' });
  assert.deepEqual(servedSource('room-seat', 'src/core/flycast_libretro.wasm'), { what: 'core' });
  assert.equal(servedSource('room-seat', 'README.md'), null);
  assert.deepEqual(servedSource('pilot', 'src/lb/lb-cabinet.js'), { what: 'module', source: 'host/src/lb-cabinet.js', inLb: true });
  assert.deepEqual(servedSource('pilot', 'src/main.js'), { what: 'module', source: 'host/src/main.js', inLb: false });
  assert.deepEqual(servedSource('pilot', 'src/lb/core/flycast_libretro.js'), { what: 'core' });
  assert.deepEqual(servedSource('pilot', 'SOURCE.txt'), { what: 'deploy note' });
});

test('flycastVersion finds the describe string', () => {
  assert.equal(flycastVersion(Buffer.from('xx v2.6-328-gb3e207a43 yy', 'latin1')), 'v2.6-328-gb3e207a43');
  assert.equal(flycastVersion(Buffer.from('nothing', 'latin1')), null);
});
