// game-pin.js: the known-good game and BIOS files, by the CONTENTS of the
// members the core loads (docs/game-file-check.md). A table only: for each
// set of game files, each member's standard name, size, CRC32 and SHA-256.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// It carries no ROM bytes. Names, sizes and CRC32 values are the core's own
// ROM table (Flycast core/hw/naomi/naomi_roms.cpp at b3e207a43, the shipped
// core: public facts in published GPL source). The SHA-256 digests were
// computed on 2026-11-23 from the host's own files, member by member (each
// matched to the table by its CRC32, as the core itself finds members); a
// member with no "sha256" is checked by size and CRC32 only, which is weak
// (see the doc). "files" is the edition whose stored files a set is
// (editions.js filesFrom): Rev C Rebalanced is built from the "A" set, and
// its built program image is pinned by its recipe (edition-b-spec.js).
// "bios": the core's region is 1 (USA, the libretro default, never changed
// by the host), so it loads the first of "any_of" it finds, in this order.
//
// Do not edit by hand, and keep this shape exactly (one member a line, only
// these keys): the lobby's seat sync allows the digests here only in this
// shape (docs/game-file-check.md has the exception). game-check.js
// parseGamePin refuses any other key; test/game-check.test.mjs checks it.
export const GAME_PIN_JSON = `
{
 "format": "doc-game-pin/1",
 "sets": [
  {"files": "A", "zip": "drbyocwc.zip", "members": [
   {"name": "epr-22336c.ic22", "size": 4194304, "crc32": "50053F82", "sha256": "2d2e76d4f7bb498d90211410c38291e832ce7175647a5cebed1003b8d641995e"},
   {"name": "mpr-22328.ic1", "size": 16777216, "crc32": "179CEC02", "sha256": "be4fb917ad854f19db15c0e8293bd48ce2b36226b4d34bb9ba736d974254a52b"},
   {"name": "mpr-22329.ic2", "size": 16777216, "crc32": "E0D5B98C", "sha256": "2a97a20ed699fcdd9eed1d421bf7eb713842782e7fc02b1217ef73c18948d9fe"},
   {"name": "mpr-22330.ic3", "size": 16777216, "crc32": "6737CD62", "sha256": "38445642afb80b2ee03e0b99afe41ddc20e7d47ec55acb4ff4eda69077f73e63"},
   {"name": "mpr-22331.ic4", "size": 16777216, "crc32": "8FB5CBCF", "sha256": "159d63c8f7a3e2e14104b425646171001ca84826f5fd1b0fd047193e05e971b1"},
   {"name": "mpr-22332.ic5", "size": 16777216, "crc32": "C5E365A8", "sha256": "409e3819b59a2650960cc30f899bdb23c855269e587ba420a13834117e7c4111"},
   {"name": "mpr-22333.ic6", "size": 16777216, "crc32": "96F324AA", "sha256": "b09e70f2e751fb30c6029eba4c9cef62bb8fd02522d2f31b6c8b48a5e1249d31"},
   {"name": "mpr-22334.ic7", "size": 16777216, "crc32": "5389B05A", "sha256": "a3a0a7584b14328247bb396f85619d9b20ddd5e92fc9f7272437351467905b3a"}
  ]},
  {"files": "J99", "zip": "derbyoc.zip", "members": [
   {"name": "epr-22099b.ic22", "size": 4194304, "crc32": "5E708879", "sha256": "f096b811a30fa2a9b947dd08133a44ddc6a3318d2b3ad95457ab5104dc524863"},
   {"name": "mpr-22085.ic1", "size": 8388608, "crc32": "FFFE9CC5", "sha256": "7a98fea0da4f75ca40b9bb8110b7bb6cbd44929f6685f597abc3345144820233"},
   {"name": "mpr-22086.ic2", "size": 8388608, "crc32": "610FE214", "sha256": "02d4c45204fbcaa0fed9d94d51d9c2ca7c9863db1b6cadc603fd3351162f6e6d"},
   {"name": "mpr-22087.ic3", "size": 8388608, "crc32": "F0CD2A26", "sha256": "7665a78e5d380a41754b13f7250bb53c8a6b9ec9aa83738f5d37b394734e08d3"},
   {"name": "mpr-22088.ic4", "size": 8388608, "crc32": "62A7E6DB", "sha256": "fdd804eff37fbd6023ff06e6a23f63f958c90ba01ba4d8774691aa439cab12d4"},
   {"name": "mpr-22089.ic5", "size": 8388608, "crc32": "CB135EB6", "sha256": "f6a000b6e1e567de0f8d199a0fa33a85d9499fd3e331124a27b1bb106ad990d1"},
   {"name": "mpr-22090.ic6", "size": 8388608, "crc32": "13E44D57", "sha256": "5422adff85c758fe0dd876ec38388952dd4617fd7dea166be2e956696c5fb0fb"},
   {"name": "mpr-22091.ic7", "size": 8388608, "crc32": "EFA1E2FC", "sha256": "bdd1ea60438386cadf3a6f5a35c9ba9130fa5b9e59ae5f7cfa7c2362d4905500"},
   {"name": "mpr-22092.ic8", "size": 8388608, "crc32": "DE1EA163", "sha256": "0246fff80dd181a66154a6a81010906ff978dfe42539148d08ed546fe4fe89a2"},
   {"name": "mpr-22093.ic9", "size": 8388608, "crc32": "ECBC523B", "sha256": "3dd579f8cf75ef7a63583c7fc844160c20c4c17ed495e11a0e157ae1d391855d"},
   {"name": "mpr-22094.ic10", "size": 8388608, "crc32": "72AF7A70", "sha256": "af548814f7edff885fb72a8f5803dc282dd79edc0ace42d5f328e9074231408f"},
   {"name": "mpr-22095.ic11", "size": 8388608, "crc32": "AE74B61A", "sha256": "812a9f1e2da72608a93489e02c9579fa591fe3470449a8397138659b879c1554"},
   {"name": "mpr-22096.ic12s", "size": 8388608, "crc32": "D8C41648", "sha256": "1d1da9438c0ed21b4dd0fc1f847d318574c275f06d0fa04d24c89570bcd9fc07"},
   {"name": "mpr-22097.ic13s", "size": 8388608, "crc32": "F1DEDAC5", "sha256": "a4e560946a525797e371b8a5bd14f69a68d9c298bfcc3784a823e26cd914bf80"},
   {"name": "mpr-22098.ic14s", "size": 8388608, "crc32": "F9824D2E", "sha256": "b4e1fe7174de622d42272e6fcfba1c787a7322f85c8f6d222e555e72962f5bd4"}
  ]},
  {"files": "J2K", "zip": "derbyo2k.zip", "members": [
   {"name": "epr-22284a.ic22", "size": 4194304, "crc32": "1E8E067C", "sha256": "8b72eb39cd944896901af86e37fae0337f3b4f8e4e4f726c8f4137be0af1b4f1"},
   {"name": "mpr-22223.ic1", "size": 8388608, "crc32": "5159DF22", "sha256": "7f15034d6f59171e7f46fa64ea9576d1b70bb2eeaef1557e75e6b0cf5c0d6af1"},
   {"name": "mpr-22224.ic2", "size": 8388608, "crc32": "EF8BC5A0", "sha256": "5499cc527c065d01f0f8bf91827339cf034c1e16918bd5209184ec1b56b7e440"},
   {"name": "mpr-22225.ic3", "size": 8388608, "crc32": "80E0FDBD", "sha256": "24bf8c40a5de162a40e9fcf3be81e39144778a3b5eb017a0fd1fca12132af02a"},
   {"name": "mpr-22226.ic4", "size": 8388608, "crc32": "EA940BCF", "sha256": "dcc03188bf284c71ed9b5e04a4527686814620ed6acdfea89183634daf825d3a"},
   {"name": "mpr-22227.ic5", "size": 8388608, "crc32": "300ED93B", "sha256": "b15c0c88b28c2bf6b829161d381ed979280e3e5b2a07ecb26abaf78bf00c6e62"},
   {"name": "mpr-22228.ic6", "size": 8388608, "crc32": "3DD062C7", "sha256": "e1e60e50ab426ef8f2165a6d3aeabf2d4030d1df5edc0f183db70d051d796024"},
   {"name": "mpr-22229.ic7", "size": 8388608, "crc32": "DA624F37", "sha256": "124d4798957b5729c7e78ee886d8e7f32002ea5ff7ae453e99659ab2411e6757"},
   {"name": "mpr-22230.ic8", "size": 8388608, "crc32": "5A806BB6", "sha256": "0fe62d41b5d898ebfc648ddec37105c266a265f29615d21930e97468f17def75"},
   {"name": "mpr-22231.ic9", "size": 8388608, "crc32": "C633D57D", "sha256": "602f6070f53ee4df5d848d36a6a7e5313edf782b3a410a2609edc56cdceb220d"},
   {"name": "mpr-22232.ic10", "size": 8388608, "crc32": "6F25A6DD", "sha256": "5b3bffe21af8412db46f05a8478dc846199931ace1aa73f96ff7b75e27460336"},
   {"name": "mpr-22233.ic11", "size": 8388608, "crc32": "CF3AC2DF", "sha256": "2cde3853e2b295800d99d7030f1f2a28e0e5f07efc35836e14867e07f32ebff9"},
   {"name": "mpr-22234.ic12s", "size": 8388608, "crc32": "D8C41648", "sha256": "1d1da9438c0ed21b4dd0fc1f847d318574c275f06d0fa04d24c89570bcd9fc07"},
   {"name": "mpr-22235.ic13s", "size": 8388608, "crc32": "F1DEDAC5", "sha256": "a4e560946a525797e371b8a5bd14f69a68d9c298bfcc3784a823e26cd914bf80"},
   {"name": "mpr-22236.ic14s", "size": 8388608, "crc32": "85F54964", "sha256": "bdfb4d0bfe6fd2988d5b355813feefc3f0cf106f642ac89e26112800b14545b5"},
   {"name": "mpr-22237.ic15s", "size": 8388608, "crc32": "718DD6BF", "sha256": "45c493599295cd11c5dad2703885f92f316c3486c8ce6f1467d540482577ffe2"},
   {"name": "mpr-22238.ic16s", "size": 8388608, "crc32": "FB3E55DA", "sha256": "eb1ae43b70ff55f667c862e1755424baadeb94bae7600783f4bceb790f28058e"}
  ]},
  {"files": "RD", "zip": "derbyocw.zip", "members": [
   {"name": "epr-22336d.ic22", "size": 4194304, "crc32": "E6C0CB0C", "sha256": "d4ba71dcb4d3dd38ad4419053c618992fb3fd969537431e91c420811d949410e"},
   {"name": "mpr-22328.ic1", "size": 16777216, "crc32": "179CEC02", "sha256": "be4fb917ad854f19db15c0e8293bd48ce2b36226b4d34bb9ba736d974254a52b"},
   {"name": "mpr-22329.ic2", "size": 16777216, "crc32": "E0D5B98C", "sha256": "2a97a20ed699fcdd9eed1d421bf7eb713842782e7fc02b1217ef73c18948d9fe"},
   {"name": "mpr-22330.ic3", "size": 16777216, "crc32": "6737CD62", "sha256": "38445642afb80b2ee03e0b99afe41ddc20e7d47ec55acb4ff4eda69077f73e63"},
   {"name": "mpr-22331.ic4", "size": 16777216, "crc32": "8FB5CBCF", "sha256": "159d63c8f7a3e2e14104b425646171001ca84826f5fd1b0fd047193e05e971b1"},
   {"name": "mpr-22332.ic5", "size": 16777216, "crc32": "C5E365A8", "sha256": "409e3819b59a2650960cc30f899bdb23c855269e587ba420a13834117e7c4111"},
   {"name": "mpr-22337.ic6", "size": 16777216, "crc32": "87CA3A2F", "sha256": "bfc53345218d105b1d5b5ff7c9dd32cf2a40da5d549130a520399d828275fd6b"},
   {"name": "mpr-22338.ic7", "size": 16777216, "crc32": "4BDA7303", "sha256": "7fdf2c9207d51740f8b1860e2eb834fc55328caf8c13fee09588d0d83b559c80"}
  ]}
 ],
 "bios": {"zip": "naomi.zip", "region": 1, "any_of": [
   {"name": "epr-21577h.ic27", "size": 2097152, "crc32": "FDF17452"},
   {"name": "epr-21577g.ic27", "size": 2097152, "crc32": "25F64AF7", "sha256": "0277084f8c38857997877443908ceb625b27f07737f79e8f3bf7a8a64a29c0bc"}
 ]}
}
`;
