/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 */
/* eslint-disable sort-imports */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { h264LevelIdcToRank, h264ProfileIdcToRank, parseH264AvcCFromFmp4Init } from "./h264-fmp4-avcc.ts";
import { resolveDeclaredH264FromFmp4Init } from "./stream-transcode-policy.ts";
import { TEST_H264_MAIN31_SPS, TEST_H264_MAIN_PPS, testH264SpsForProfileLevel } from "./h264-test-bytes.ts";

type KnownAvcCParse = Extract<ReturnType<typeof parseH264AvcCFromFmp4Init>, { known: true }>;

function requireKnownAvcC(parsed: ReturnType<typeof parseH264AvcCFromFmp4Init>): KnownAvcCParse {

  if(!parsed.known) {

    assert.fail("expected known parse");
  }

  return parsed;
}

function writeBox(type: string, payload: Buffer): Buffer {

  const header = Buffer.alloc(8);

  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4);

  return Buffer.concat([ header, payload ]);
}

function buildAvcCBox(profileIdc: number, levelIdc: number, options?: { truncateAfterLevel?: boolean; truncatedCopilot?: boolean; version?: number }): Buffer {

  if(options?.truncatedCopilot) {

    return writeBox("avcC", Buffer.from([ 1, 77, 0, 31, 255, 225, 0 ]));
  }

  const sps = testH264SpsForProfileLevel(profileIdc, levelIdc);
  const pps = TEST_H264_MAIN_PPS;
  const body = Buffer.alloc(11 + sps.length + pps.length);
  let offset = 0;

  body[offset++] = options?.version ?? 1;
  body[offset++] = profileIdc;
  body[offset++] = 0;
  body[offset++] = levelIdc;
  body[offset++] = 0xFF;
  body[offset++] = 0xE1;
  body.writeUInt16BE(sps.length, offset);
  offset += 2;
  sps.copy(body, offset);
  offset += sps.length;
  body[offset++] = 1;
  body.writeUInt16BE(pps.length, offset);
  offset += 2;
  pps.copy(body, offset);

  const payload = options?.truncateAfterLevel ? body.subarray(0, 4) : body;

  return writeBox("avcC", payload);
}

function buildAvc1SampleEntry(avcC: Buffer, type: "avc1" | "avc3" = "avc1"): Buffer {

  const visualPrefix = Buffer.alloc(78, 0);

  return writeBox(type, Buffer.concat([ visualPrefix, avcC ]));
}

function buildStsd(avc1: Buffer): Buffer {

  return buildStsdWithEntries([avc1]);
}

function buildStsdWithEntries(entries: Buffer[]): Buffer {

  const version = Buffer.alloc(8, 0);

  version.writeUInt32BE(entries.length, 4);

  return writeBox("stsd", Buffer.concat([ version, ...entries ]));
}

function buildTkhd(trackId = 1, version: 0 | 1 = 0): Buffer {

  const payload = Buffer.alloc(84, 0);

  payload[0] = version;

  if(version === 0) {

    payload.writeUInt32BE(trackId, 12);
  } else {

    payload.writeUInt32BE(trackId, 20);
  }

  return writeBox("tkhd", payload);
}

function buildTkhdUnknownVersion(trackId: number, versionByte: number): Buffer {

  const payload = Buffer.alloc(84, 0);

  payload[0] = versionByte;
  payload.writeUInt32BE(trackId, 12);

  return writeBox("tkhd", payload);
}

function buildTruncatedTkhdV0(): Buffer {

  return writeBox("tkhd", Buffer.alloc(10, 0));
}

function buildTrex(trackId: number, defaultSampleDescriptionIndex: number): Buffer {

  const payload = Buffer.alloc(24, 0);

  payload.writeUInt32BE(trackId, 4);
  payload.writeUInt32BE(defaultSampleDescriptionIndex, 8);

  return writeBox("trex", payload);
}

function buildMoovWithMvexTrex(stsd: Buffer, options: { defaultSampleDescriptionIndex?: number; tkhdVersion?: 0 | 1; trackId?: number } = {}): Buffer {

  const trackId = options.trackId ?? 1;
  const trexIndex = options.defaultSampleDescriptionIndex ?? 1;
  const tkhdVersion = options.tkhdVersion ?? 0;
  const stbl = writeBox("stbl", stsd);
  const minf = writeBox("minf", stbl);
  const mdia = writeBox("mdia", Buffer.concat([ buildHdlr("vide"), minf ]));
  const trak = writeBox("trak", Buffer.concat([ buildTkhd(trackId, tkhdVersion), mdia ]));
  const mvex = writeBox("mvex", buildTrex(trackId, trexIndex));

  return writeBox("moov", Buffer.concat([ trak, mvex ]));
}

function buildTfhdWithSampleDescriptionIndex(trackId: number, sampleDescriptionIndex: number): Buffer {

  const flags = 0x000002;
  const payload = Buffer.alloc(12, 0);

  payload.writeUInt32BE(flags, 0);
  payload.writeUInt32BE(trackId, 4);
  payload.writeUInt32BE(sampleDescriptionIndex, 8);

  return writeBox("tfhd", payload);
}

function buildHdlr(handlerType: string, options?: { payloadLength?: number }): Buffer {

  const len = options?.payloadLength ?? 20;
  const payload = Buffer.alloc(len, 0);

  if(len >= 12) {

    payload.write(handlerType.slice(0, 4), 8, 4, "ascii");
  }

  return writeBox("hdlr", payload);
}

/** 16-byte hdlr (8-byte payload) + `soun` glue before `minf`; overread past declared box must not map High on later trak (H6 e2e). */
function buildH6Hvc1TrakWithHdlrOverread16(): Buffer {

  const header = Buffer.alloc(8);

  header.writeUInt32BE(16, 0);
  header.write("hdlr", 4);
  const hdlr = Buffer.concat([ header, Buffer.alloc(8, 0) ]);
  const sounGlue = Buffer.from("soun", "ascii");
  const minf = writeBox("minf", writeBox("stbl", buildStsd(buildHvc1SampleEntry())));

  return writeBox("trak", Buffer.concat([ buildTkhd(1), writeBox("mdia", Buffer.concat([ hdlr, sounGlue, minf ])) ]));
}

/** 19-byte hdlr (11-byte payload ending `sou`) + `n` glue; completes `soun` on overread (H6 e2e). */
function buildH6Hvc1TrakWithHdlrOverread11(): Buffer {

  const header = Buffer.alloc(8);

  header.writeUInt32BE(19, 0);
  header.write("hdlr", 4);
  const payload = Buffer.alloc(11, 0);

  payload.write("sou", 8, 3, "ascii");
  const hdlr = Buffer.concat([ header, payload ]);
  const nGlue = Buffer.from("n", "ascii");
  const minf = writeBox("minf", writeBox("stbl", buildStsd(buildHvc1SampleEntry())));

  return writeBox("trak", Buffer.concat([ buildTkhd(1), writeBox("mdia", Buffer.concat([ hdlr, nGlue, minf ])) ]));
}

function buildH6HighAvcSecondTrak(): Buffer {

  return writeBox("trak", Buffer.concat([ buildTkhd(2), writeBox("mdia", Buffer.concat([ buildHdlr("vide"),
    writeBox("minf", writeBox("stbl", buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 51))))) ])) ]));
}

function buildHvc1SampleEntry(): Buffer {

  return writeBox("hvc1", Buffer.alloc(78, 0));
}

function buildMoovTraks(traks: Buffer[]): Buffer {

  return writeBox("moov", Buffer.concat(traks));
}

function buildVideoTrak(stsd: Buffer, handlerType: string, hdlrOptions?: { payloadLength?: number }): Buffer {

  const mdiaParts = handlerType === "__omit__" ?
    [writeBox("minf", writeBox("stbl", stsd))] :
    [ buildHdlr(handlerType, hdlrOptions), writeBox("minf", writeBox("stbl", stsd)) ];

  return writeBox("trak", Buffer.concat([ buildTkhd(1), writeBox("mdia", Buffer.concat(mdiaParts)) ]));
}

function buildNestedMoov(stsd: Buffer, handlerType: "vide" | "soun" = "vide"): Buffer {

  const stbl = writeBox("stbl", stsd);
  const minf = writeBox("minf", stbl);
  const mdia = writeBox("mdia", Buffer.concat([ buildHdlr(handlerType), minf ]));
  const trak = writeBox("trak", Buffer.concat([ buildTkhd(1), mdia ]));
  const moov = writeBox("moov", trak);

  return moov;
}

function buildMoovWithTwoVideoTraks(firstStsd: Buffer, secondStsd: Buffer): Buffer {

  const trak1 = writeBox("trak", Buffer.concat([ buildTkhd(1), writeBox("mdia", Buffer.concat([ buildHdlr("vide"), writeBox("minf", writeBox("stbl", firstStsd)) ])) ]));
  const trak2 = writeBox("trak", Buffer.concat([ buildTkhd(2), writeBox("mdia", Buffer.concat([ buildHdlr("vide"), writeBox("minf", writeBox("stbl", secondStsd)) ])) ]));

  return writeBox("moov", Buffer.concat([ trak1, trak2 ]));
}

function assertA7MappedHandlerFirst(handlerType: "hint" | "sbtl" | "text"): void {

  const mapped = buildVideoTrak(buildStsd(buildAvc1SampleEntry(buildAvcCBox(77, 31))), handlerType);
  const laterVide = buildVideoTrak(buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 40))), "vide");
  const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildMoovTraks([ mapped, laterVide ]) ]);

  assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: true, levelIdc: 31, profileIdc: 77 });
}

function buildFmp4WithAvcC(profileIdc: number, levelIdc: number, options?: { sampleEntryType?: "avc1" | "avc3"; strayAvcCInMdat?: boolean; wrongVersion?: boolean;
  truncateAfterLevel?: boolean; truncatedCopilot?: boolean; omitMoov?: boolean; }): Buffer {

  const avcC = buildAvcCBox(profileIdc, levelIdc, { truncateAfterLevel: options?.truncateAfterLevel, truncatedCopilot: options?.truncatedCopilot,
    version: options?.wrongVersion ? 2 : 1 });
  const avc1 = buildAvc1SampleEntry(avcC, options?.sampleEntryType ?? "avc1");
  const stsd = buildStsd(avc1);
  const parts: Buffer[] = [writeBox("ftyp", Buffer.from("isom00000008", "ascii"))];

  if(!options?.omitMoov) {

    parts.push(buildNestedMoov(stsd));
  }

  if(options?.strayAvcCInMdat) {

    const junk = Buffer.concat([ Buffer.from("xxxxavcC", "ascii"), buildAvcCBox(100, 51) ]);

    parts.push(writeBox("mdat", junk));
  }

  return Buffer.concat(parts);
}

describe("parseH264AvcCFromFmp4Init", () => {

  test("Main 3.1 via nested box tree", () => {

    const parsed = requireKnownAvcC(parseH264AvcCFromFmp4Init(buildFmp4WithAvcC(77, 31)));

    assert.equal(parsed.profileIdc, 77);
    assert.equal(parsed.levelIdc, 31);
  });

  test("Main 4.0", () => {

    const parsed = requireKnownAvcC(parseH264AvcCFromFmp4Init(buildFmp4WithAvcC(77, 40)));

    assert.equal(parsed.levelIdc, 40);
  });

  test("Main 4.1", () => {

    const parsed = parseH264AvcCFromFmp4Init(buildFmp4WithAvcC(77, 41));

    assert.ok(parsed.known);
  });

  test("High 5.1", () => {

    const parsed = requireKnownAvcC(parseH264AvcCFromFmp4Init(buildFmp4WithAvcC(100, 51)));

    assert.equal(parsed.profileIdc, 100);
    assert.equal(parsed.levelIdc, 51);
  });

  test("truncated right after the level byte returns unknown", () => {

    assert.deepEqual(parseH264AvcCFromFmp4Init(buildFmp4WithAvcC(77, 31, { truncateAfterLevel: true })), { known: false });
  });

  test("stray avcC sequence in mdat does not satisfy the gate", () => {

    assert.deepEqual(parseH264AvcCFromFmp4Init(buildFmp4WithAvcC(77, 31, { omitMoov: true, strayAvcCInMdat: true })), { known: false });
  });

  test("wrong avcC configuration version returns unknown", () => {

    assert.deepEqual(parseH264AvcCFromFmp4Init(buildFmp4WithAvcC(77, 40, { wrongVersion: true })), { known: false });
  });

  test("Baseline profile idc 66 rejects all Baseline-family streams (including Constrained Baseline)", () => {

    assert.deepEqual(parseH264AvcCFromFmp4Init(buildFmp4WithAvcC(66, 31)), { known: false });
  });

  test("avc3 sample entry", () => {

    const parsed = requireKnownAvcC(parseH264AvcCFromFmp4Init(buildFmp4WithAvcC(77, 40, { sampleEntryType: "avc3" })));

    assert.equal(parsed.profileIdc, 77);
  });

  test("Main level 30 (level_idc <= 30) is unknown", () => {

    assert.deepEqual(parseH264AvcCFromFmp4Init(buildFmp4WithAvcC(77, 30)), { known: false });
  });

  test("truncated avcC after numSPS (Copilot r4580058506 fixture) is unknown", () => {

    assert.deepEqual(parseH264AvcCFromFmp4Init(buildFmp4WithAvcC(77, 31, { truncatedCopilot: true })), { known: false });
  });

  test("largesize moov box is bounded and parsed", () => {

    const avcC = buildAvcCBox(77, 40);
    const avc1 = buildAvc1SampleEntry(avcC);
    const stsd = buildStsd(avc1);
    const stbl = writeBox("stbl", stsd);
    const minf = writeBox("minf", stbl);
    const mdia = writeBox("mdia", Buffer.concat([ buildHdlr("vide"), minf ]));
    const trak = writeBox("trak", Buffer.concat([ buildTkhd(1), mdia ]));
    const moovPayload = trak;
    const moovHeader = Buffer.alloc(16);

    moovHeader.writeUInt32BE(1, 0);
    moovHeader.write("moov", 4);
    moovHeader.writeBigUInt64BE(BigInt(16 + moovPayload.length), 8);
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), moovHeader, moovPayload ]);

    const parsed = parseH264AvcCFromFmp4Init(fmp4);

    assert.ok(parsed.known);
  });

  test("size-0 child box extends to parent end", () => {

    const avcC = buildAvcCBox(77, 40);
    const visualPrefix = Buffer.alloc(78, 0);
    const avc1Payload = Buffer.concat([ visualPrefix, avcC ]);
    const avc1Header = Buffer.alloc(8);

    avc1Header.writeUInt32BE(0, 0);
    avc1Header.write("avc1", 4);
    const avc1 = Buffer.concat([ avc1Header, avc1Payload ]);
    const stsd = buildStsd(avc1);
    const stbl = writeBox("stbl", stsd);
    const minf = writeBox("minf", stbl);
    const mdia = writeBox("mdia", Buffer.concat([ buildHdlr("vide"), minf ]));
    const trak = writeBox("trak", Buffer.concat([ buildTkhd(1), mdia ]));
    const moov = writeBox("moov", trak);
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), moov ]);

    const parsed = requireKnownAvcC(parseH264AvcCFromFmp4Init(fmp4));

    assert.equal(parsed.levelIdc, 40);
  });

  test("avcC child size spills past avc1 parent while payload remains in buffer is unknown (Copilot r4580058541 / P8)", () => {

    const avcC = buildAvcCBox(77, 40);
    const visualPrefix = Buffer.alloc(78, 0);
    const spill = avcC.subarray(8);
    const oversizedAvcCHeader = Buffer.alloc(8);

    oversizedAvcCHeader.writeUInt32BE(8 + spill.length, 0);
    oversizedAvcCHeader.write("avcC", 4);
    const avc1 = writeBox("avc1", Buffer.concat([ visualPrefix, oversizedAvcCHeader ]));
    const stsdVersion = Buffer.alloc(8, 0);

    stsdVersion.writeUInt32BE(1, 4);
    const stsdPayload = Buffer.concat([ stsdVersion, avc1, spill ]);
    const stsd = writeBox("stsd", stsdPayload);
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildNestedMoov(stsd) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("child box claiming past parent end is ignored", () => {

    const avcC = buildAvcCBox(77, 40);
    const visualPrefix = Buffer.alloc(78, 0);
    const avc1Inner = Buffer.concat([ visualPrefix, avcC ]);
    const avc1Header = Buffer.alloc(8);

    avc1Header.writeUInt32BE(avc1Inner.length + 400, 0);
    avc1Header.write("avc1", 4);
    const stsdVersion = Buffer.alloc(8, 0);

    stsdVersion.writeUInt32BE(1, 4);
    const stsdPayload = Buffer.concat([ stsdVersion, avc1Header, avc1Inner.subarray(0, 32) ]);
    const stsd = writeBox("stsd", stsdPayload);
    const stbl = writeBox("stbl", stsd);
    const minf = writeBox("minf", stbl);
    const mdia = writeBox("mdia", minf);
    const trak = writeBox("trak", Buffer.concat([ buildTkhd(1), mdia ]));
    const moov = writeBox("moov", trak);
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), moov ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("UniFi-style 1080p Main 4.0 init fixture", () => {

    const protectStyle = buildFmp4WithAvcC(77, 40);
    const parsed = requireKnownAvcC(parseH264AvcCFromFmp4Init(protectStyle));

    assert.equal(parsed.profileIdc, 77);
    assert.equal(parsed.levelIdc, 40);
  });

  test("empty buffer returns unknown", () => {

    assert.deepEqual(parseH264AvcCFromFmp4Init(Buffer.alloc(0)), { known: false });
  });

  test("numSps=0 with valid PPS is unknown (P12)", () => {

    const pps = TEST_H264_MAIN_PPS;
    const body = Buffer.alloc(9 + pps.length);

    body[0] = 1;
    body[1] = 77;
    body[3] = 31;
    body[4] = 0xFF;
    body[5] = 0xE0;
    body[6] = 1;
    body.writeUInt16BE(pps.length, 7);
    pps.copy(body, 9);
    const avcC = writeBox("avcC", body);
    const avc1 = buildAvc1SampleEntry(avcC);
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildNestedMoov(buildStsd(avc1)) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("zero SPS and zero PPS counts in raw avcC payload is unknown (P12)", () => {

    const avcC = writeBox("avcC", Buffer.from([ 1, 77, 0, 31, 0xFF, 0xE0, 0x00 ]));
    const avc1 = buildAvc1SampleEntry(avcC);
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildNestedMoov(buildStsd(avc1)) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("zero-length SPS NAL is unknown", () => {

    const body = Buffer.from([ 1, 77, 0, 31, 0xFF, 0xE1, 0x00, 0x00, 1, 0x00, 0x00 ]);
    const avcC = writeBox("avcC", body);
    const avc1 = buildAvc1SampleEntry(avcC);
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildNestedMoov(buildStsd(avc1)) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("numPps=0 is unknown (r4580444943)", () => {

    const sps = TEST_H264_MAIN31_SPS;
    const body = Buffer.alloc(11 + sps.length);

    body[0] = 1;
    body[1] = 77;
    body[3] = 31;
    body[4] = 0xFF;
    body[5] = 0xE1;
    body.writeUInt16BE(sps.length, 6);
    sps.copy(body, 8);
    body[8 + sps.length] = 0;
    const avcC = writeBox("avcC", body);
    const avc1 = buildAvc1SampleEntry(avcC);
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildNestedMoov(buildStsd(avc1)) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("SPS profile-only mismatch is unknown (S1)", () => {

    const sps = testH264SpsForProfileLevel(100, 40);
    const pps = TEST_H264_MAIN_PPS;
    const body = Buffer.alloc(11 + sps.length + pps.length);
    let offset = 0;

    body[offset++] = 1;
    body[offset++] = 77;
    body[offset++] = 0;
    body[offset++] = 40;
    body[offset++] = 0xFF;
    body[offset++] = 0xE1;
    body.writeUInt16BE(sps.length, offset);
    offset += 2;
    sps.copy(body, offset);
    offset += sps.length;
    body[offset++] = 1;
    body.writeUInt16BE(pps.length, offset);
    offset += 2;
    pps.copy(body, offset);
    const avcC = writeBox("avcC", body);
    const avc1 = buildAvc1SampleEntry(avcC);
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildNestedMoov(buildStsd(avc1)) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("SPS level-only mismatch is unknown (S2)", () => {

    const sps = testH264SpsForProfileLevel(77, 31);
    const pps = TEST_H264_MAIN_PPS;
    const body = Buffer.alloc(11 + sps.length + pps.length);
    let offset = 0;

    body[offset++] = 1;
    body[offset++] = 77;
    body[offset++] = 0;
    body[offset++] = 40;
    body[offset++] = 0xFF;
    body[offset++] = 0xE1;
    body.writeUInt16BE(sps.length, offset);
    offset += 2;
    sps.copy(body, offset);
    offset += sps.length;
    body[offset++] = 1;
    body.writeUInt16BE(pps.length, offset);
    offset += 2;
    pps.copy(body, offset);
    const avcC = writeBox("avcC", body);
    const avc1 = buildAvc1SampleEntry(avcC);
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildNestedMoov(buildStsd(avc1)) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("SPS shorter than 4 bytes is unknown (S3)", () => {

    const spsLength = 2;
    const declaredLevel = 40;
    // PPS length high byte intentionally equals declaredLevel so an unguarded read at
    // SPS+3 would false-match profile/level (r4582125328); the <4 guard must reject first.
    const paddedPpsLength = (declaredLevel << 8) + TEST_H264_MAIN_PPS.length;
    const paddedPps = Buffer.alloc(paddedPpsLength);

    TEST_H264_MAIN_PPS.copy(paddedPps, 0);
    const body = Buffer.alloc(11 + spsLength + 1 + 2 + paddedPpsLength);
    let offset = 0;

    body[offset++] = 1;
    body[offset++] = 77;
    body[offset++] = 0;
    body[offset++] = declaredLevel;
    body[offset++] = 0xFF;
    body[offset++] = 0xE1;
    body.writeUInt16BE(spsLength, offset);
    offset += 2;
    const spsStart = offset;

    body[spsStart] = 0x67;
    body[spsStart + 1] = 77;
    offset = spsStart + spsLength;
    body[offset++] = 1;
    body.writeUInt16BE(paddedPpsLength, offset);
    offset += 2;
    paddedPps.copy(body, offset);
    const avcC = writeBox("avcC", body);
    const avc1 = buildAvc1SampleEntry(avcC);
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildNestedMoov(buildStsd(avc1)) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("SPS profile/level bytes must match avcC header (r4580408475)", () => {

    const mismatchSps = Buffer.from([ 0x67, 0x64, 0, 0x29, 0x96, 0x54, 0x05, 0x01, 0xED, 0x80 ]);
    const pps = TEST_H264_MAIN_PPS;
    const body = Buffer.alloc(11 + mismatchSps.length + pps.length);
    let offset = 0;

    body[offset++] = 1;
    body[offset++] = 77;
    body[offset++] = 0;
    body[offset++] = 31;
    body[offset++] = 0xFF;
    body[offset++] = 0xE1;
    body.writeUInt16BE(mismatchSps.length, offset);
    offset += 2;
    mismatchSps.copy(body, offset);
    offset += mismatchSps.length;
    body[offset++] = 1;
    body.writeUInt16BE(pps.length, offset);
    offset += 2;
    pps.copy(body, offset);
    const avcC = writeBox("avcC", body);
    const avc1 = buildAvc1SampleEntry(avcC);
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildNestedMoov(buildStsd(avc1)) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("zero-length PPS entry is unknown (P17)", () => {

    const sps = TEST_H264_MAIN31_SPS;
    const body = Buffer.alloc(11 + sps.length + 4);

    body[0] = 1;
    body[1] = 77;
    body[3] = 31;
    body[4] = 0xFF;
    body[5] = 0xE1;
    body.writeUInt16BE(sps.length, 6);
    sps.copy(body, 8);
    body[8 + sps.length] = 1;
    body.writeUInt16BE(0, 9 + sps.length);
    body[11 + sps.length] = 0x68;
    const avcC = writeBox("avcC", body);
    const avc1 = buildAvc1SampleEntry(avcC);
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildNestedMoov(buildStsd(avc1)) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("truncated PPS length with numPps=1 is unknown", () => {

    const sps = testH264SpsForProfileLevel(77, 40);
    const body = Buffer.alloc(11 + sps.length + 3);

    body[0] = 1;
    body[1] = 77;
    body[3] = 40;
    body[4] = 0xFF;
    body[5] = 0xE1;
    body.writeUInt16BE(sps.length, 6);
    sps.copy(body, 8);
    body[8 + sps.length] = 1;
    body.writeUInt16BE(50, 9 + sps.length);
    const avcC = writeBox("avcC", body);
    const avc1 = buildAvc1SampleEntry(avcC);
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildNestedMoov(buildStsd(avc1)) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("first mapped video trak wins when a later trak has High avcC (FFmpeg 0:v:0 parity)", () => {

    const badFirst = buildStsd(buildAvc1SampleEntry(buildAvcCBox(66, 40, { version: 2 })));
    const goodSecond = buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 40)));
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildMoovWithTwoVideoTraks(badFirst, goodSecond) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
    assert.deepEqual(resolveDeclaredH264FromFmp4Init(fmp4), { sourceDeclaredH264Known: false });
  });

  test("skips soun trak then validates first vide trak (5933946877)", () => {

    const audio = buildVideoTrak(buildStsd(buildAvc1SampleEntry(buildAvcCBox(77, 31))), "soun");
    const video = buildVideoTrak(buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 40))), "vide");
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildMoovTraks([ audio, video ]) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: true, levelIdc: 40, profileIdc: 100 });
  });

  test("first text trak with avc1 is mapped like FFmpeg 0:v:0 (A7)", () => {

    assertA7MappedHandlerFirst("text");
  });

  test("first sbtl trak with avc1 is mapped like FFmpeg 0:v:0 (A7)", () => {

    assertA7MappedHandlerFirst("sbtl");
  });

  test("first hint trak with avc1 is mapped like FFmpeg 0:v:0 (A7)", () => {

    assertA7MappedHandlerFirst("hint");
  });

  test("sample-description gate failure on first mapped trak is unknown without fallthrough (V2_gate_fail_continues)", () => {

    const stbl1 = writeBox("stbl", buildStsd(buildAvc1SampleEntry(buildAvcCBox(77, 31))));
    const trak1 = writeBox("trak", Buffer.concat([ buildTkhd(1), writeBox("mdia", Buffer.concat([ buildHdlr("vide"), writeBox("minf", stbl1) ])) ]));
    const trak2 = writeBox("trak", Buffer.concat([ buildTkhd(2), writeBox("mdia", Buffer.concat([ buildHdlr("vide"), writeBox("minf", writeBox("stbl",
      buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 40))))) ])) ]));
    const mvex = writeBox("mvex", buildTrex(1, 2));
    const moov = writeBox("moov", Buffer.concat([ trak1, trak2, mvex ]));
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), moov ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("trex default_sample_description_index 0 fails closed (I1)", () => {

    const stsd = buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 40)));
    const moov = buildMoovWithMvexTrex(stsd, { defaultSampleDescriptionIndex: 0 });
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), moov ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("other track trex index 2 does not block mapped track (I4)", () => {

    const trak1 = writeBox("trak", Buffer.concat([ buildTkhd(1), writeBox("mdia", Buffer.concat([ buildHdlr("vide"),
      writeBox("minf", writeBox("stbl", buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 40))))) ])) ]));
    const trak2 = writeBox("trak", Buffer.concat([ buildTkhd(2), writeBox("mdia", Buffer.concat([ buildHdlr("vide"),
      writeBox("minf", writeBox("stbl", buildStsd(buildAvc1SampleEntry(buildAvcCBox(77, 31))))) ])) ]));
    const mvex = writeBox("mvex", Buffer.concat([ buildTrex(1, 1), buildTrex(2, 2) ]));
    const moov = writeBox("moov", Buffer.concat([ trak1, trak2, mvex ]));
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), moov ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: true, levelIdc: 40, profileIdc: 100 });
  });

  test("other track tfhd sample_description_index 2 does not block mapped track (I4b)", () => {

    const moov = buildMoovWithMvexTrex(buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 40))), { defaultSampleDescriptionIndex: 1 });
    const moof = writeBox("moof", writeBox("traf", buildTfhdWithSampleDescriptionIndex(2, 2)));
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), moov, moof ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: true, levelIdc: 40, profileIdc: 100 });
  });

  test("trex entries with track 2 before track 1 still gates mapped track (I6)", () => {

    const trak1 = writeBox("trak", Buffer.concat([ buildTkhd(1), writeBox("mdia", Buffer.concat([ buildHdlr("vide"),
      writeBox("minf", writeBox("stbl", buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 40))))) ])) ]));
    const mvex = writeBox("mvex", Buffer.concat([ buildTrex(2, 2), buildTrex(1, 1) ]));
    const moov = writeBox("moov", Buffer.concat([ trak1, mvex ]));
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), moov ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: true, levelIdc: 40, profileIdc: 100 });
  });

  test("16-byte truncated hdlr overread glue cannot fall through to later High avcC (H6 pin e2e)", () => {

    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")),
      buildMoovTraks([ buildH6Hvc1TrakWithHdlrOverread16(), buildH6HighAvcSecondTrak() ]) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("11-byte hdlr payload with sou+n glue cannot fall through to later High avcC (H6 pin e2e 11-byte)", () => {

    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")),
      buildMoovTraks([ buildH6Hvc1TrakWithHdlrOverread11(), buildH6HighAvcSecondTrak() ]) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("inflated hdlr box cannot read handler type past trak bounds (H6)", () => {

    const stsd = buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 40)));
    const shortPayload = Buffer.alloc(8, 0);

    shortPayload.write("vide", 0, 4, "ascii");
    const hdlrHeader = Buffer.alloc(8);

    hdlrHeader.writeUInt32BE(64, 0);
    hdlrHeader.write("hdlr", 4);
    const hdlr = Buffer.concat([ hdlrHeader, shortPayload ]);
    const trak = writeBox("trak", Buffer.concat([ buildTkhd(1), writeBox("mdia", Buffer.concat([ hdlr, writeBox("minf", writeBox("stbl", stsd)) ])) ]));
    const later = buildVideoTrak(buildStsd(buildAvc1SampleEntry(buildAvcCBox(77, 31))), "vide");
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildMoovTraks([ trak, later ]) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("hdlr box size past trak end cannot fall through to later avcC (H6b)", () => {

    const stsd = buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 40)));
    const videPayload = Buffer.alloc(4);

    videPayload.write("vide", 0, 4, "ascii");
    const paddedPayload = Buffer.concat([ Buffer.alloc(8, 0), videPayload, Buffer.alloc(8, 0) ]);
    const hdlrHeader = Buffer.alloc(8);

    hdlrHeader.writeUInt32BE(paddedPayload.length + 64, 0);
    hdlrHeader.write("hdlr", 4);
    const oversizedHdlr = Buffer.concat([ hdlrHeader, paddedPayload ]);
    const trak = writeBox("trak", Buffer.concat([ buildTkhd(1), writeBox("mdia", Buffer.concat([ oversizedHdlr,
      writeBox("minf", writeBox("stbl", stsd)) ])) ]));
    const later = buildVideoTrak(buildStsd(buildAvc1SampleEntry(buildAvcCBox(77, 31))), "vide");
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildMoovTraks([ trak, later ]) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("hvc1 first trak is mapped and unknown without avcC (no fallthrough)", () => {

    const first = buildVideoTrak(buildStsd(buildHvc1SampleEntry()), "vide");
    const second = buildVideoTrak(buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 40))), "vide");
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildMoovTraks([ first, second ]) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("missing hdlr on first trak fails closed without reading later High avcC", () => {

    const first = buildVideoTrak(buildStsd(buildAvc1SampleEntry(buildAvcCBox(66, 40, { version: 2 }))), "__omit__");
    const second = buildVideoTrak(buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 40))), "vide");
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildMoovTraks([ first, second ]) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("truncated hdlr on mapped trak is unknown even when later trak parses", () => {

    const first = buildVideoTrak(buildStsd(buildAvc1SampleEntry(buildAvcCBox(66, 40, { version: 2 }))), "vide", { payloadLength: 10 });
    const second = buildVideoTrak(buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 40))), "vide");
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildMoovTraks([ first, second ]) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("meta handler trak is mapped first and unknown without avcC", () => {

    const meta = buildVideoTrak(buildStsd(buildHvc1SampleEntry()), "meta");
    const video = buildVideoTrak(buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 40))), "vide");
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildMoovTraks([ meta, video ]) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("stsd entry 1 only: unreadable first sample entry then valid avc1 is unknown (5943760565)", () => {

    const badFirst = buildAvc1SampleEntry(buildAvcCBox(66, 40, { version: 2 }));
    const goodSecond = buildAvc1SampleEntry(buildAvcCBox(100, 40));
    const stsd = buildStsdWithEntries([ badFirst, goodSecond ]);
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildNestedMoov(stsd) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("stsd entry_count 1 must not walk trailing sample entries (V2_STSD_SKIP_NEXT_ENTRY)", () => {

    const badFirst = buildAvc1SampleEntry(buildAvcCBox(66, 40, { version: 2 }));
    const goodSecond = buildAvc1SampleEntry(buildAvcCBox(100, 40));
    const version = Buffer.alloc(8, 0);

    version.writeUInt32BE(1, 4);
    const stsd = writeBox("stsd", Buffer.concat([ version, badFirst, goodSecond ]));
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildNestedMoov(stsd) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("stsd entry_count 0 with trailing valid avc1 is unknown (5947434705)", () => {

    const version = Buffer.alloc(8, 0);

    version.writeUInt32BE(0, 4);
    const avc1 = buildAvc1SampleEntry(buildAvcCBox(100, 40));
    const stsd = writeBox("stsd", Buffer.concat([ version, avc1 ]));
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildNestedMoov(stsd) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
    assert.deepEqual(resolveDeclaredH264FromFmp4Init(fmp4), { sourceDeclaredH264Known: false });
  });

  test("stsd entry 1 only: hvc1 then avc1 in stsd is unknown (5943760565)", () => {

    const stsd = buildStsdWithEntries([ buildHvc1SampleEntry(), buildAvc1SampleEntry(buildAvcCBox(100, 40)) ]);
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildNestedMoov(stsd) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("stsd entry_count 2 with both valid avc1 entries is unknown (5943760565)", () => {

    const stsd = buildStsdWithEntries([
      buildAvc1SampleEntry(buildAvcCBox(77, 31)),
      buildAvc1SampleEntry(buildAvcCBox(100, 40))
    ]);
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildNestedMoov(stsd) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("trex default_sample_description_index 2 fails closed (5943760565)", () => {

    const stsd = buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 40)));
    const moov = buildMoovWithMvexTrex(stsd, { defaultSampleDescriptionIndex: 2 });
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), moov ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("tfhd sample_description_index 2 on init fails closed (5943760565)", () => {

    const stsd = buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 40)));
    const moov = buildNestedMoov(stsd);
    const moof = writeBox("moof", writeBox("traf", buildTfhdWithSampleDescriptionIndex(1, 2)));
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), moov, moof ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("tkhd version 0 track_id offsets trex gate correctly (r4604893031)", () => {

    const stsd = buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 40)));
    const moov = buildMoovWithMvexTrex(stsd, { defaultSampleDescriptionIndex: 2, tkhdVersion: 0, trackId: 1 });
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), moov ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("tkhd version 1 track_id at payload+20 pairs with trex (r4604893031)", () => {

    const stsd = buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 40)));
    const moov = buildMoovWithMvexTrex(stsd, { defaultSampleDescriptionIndex: 2, tkhdVersion: 1, trackId: 1 });
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), moov ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("tkhd version 1 with trex index 1 allows known avcC (r4604893031)", () => {

    const stsd = buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 40)));
    const moov = buildMoovWithMvexTrex(stsd, { defaultSampleDescriptionIndex: 1, tkhdVersion: 1, trackId: 1 });
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), moov ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: true, levelIdc: 40, profileIdc: 100 });
  });

  test("tkhd unknown version fails closed (r4604893031)", () => {

    const stsd = buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 40)));
    const mdia = writeBox("mdia", Buffer.concat([ buildHdlr("vide"), writeBox("minf", writeBox("stbl", stsd)) ]));
    const trak = writeBox("trak", Buffer.concat([ buildTkhdUnknownVersion(1, 2), mdia ]));
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), writeBox("moov", trak) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("truncated tkhd fails closed (r4604893031)", () => {

    const stsd = buildStsd(buildAvc1SampleEntry(buildAvcCBox(100, 40)));
    const mdia = writeBox("mdia", Buffer.concat([ buildHdlr("vide"), writeBox("minf", writeBox("stbl", stsd)) ]));
    const trak = writeBox("trak", Buffer.concat([ buildTruncatedTkhdV0(), mdia ]));
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), writeBox("moov", trak) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("wrong SPS NAL type is unknown (P16)", () => {

    const wrongSps = Buffer.from([ 0x68, 0x4D, 0, 0x28, 0x96, 0x54, 0x05, 0x01, 0xED, 0x80 ]);
    const pps = TEST_H264_MAIN_PPS;
    const body = Buffer.alloc(11 + wrongSps.length + pps.length);
    let offset = 0;

    body[offset++] = 1;
    body[offset++] = 77;
    body[offset++] = 0;
    body[offset++] = 40;
    body[offset++] = 0xFF;
    body[offset++] = 0xE1;
    body.writeUInt16BE(wrongSps.length, offset);
    offset += 2;
    wrongSps.copy(body, offset);
    offset += wrongSps.length;
    body[offset++] = 1;
    body.writeUInt16BE(pps.length, offset);
    offset += 2;
    pps.copy(body, offset);
    const avcC = writeBox("avcC", body);
    const avc1 = buildAvc1SampleEntry(avcC);
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), buildNestedMoov(buildStsd(avc1)) ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("rejects fMP4 trees deeper than the walk cap inside mapped trak (I2_depth_cap)", () => {

    const avcC = buildAvcCBox(77, 31);
    const avc1 = buildAvc1SampleEntry(avcC);
    const stsd = buildStsd(avc1);
    const stbl = writeBox("stbl", stsd);
    let minfChild: Buffer = stbl;

    for(let depth = 0; depth < 12; depth++) {

      minfChild = writeBox("edts", minfChild);
    }

    const minf = writeBox("minf", minfChild);
    const mdia = writeBox("mdia", Buffer.concat([ buildHdlr("vide"), minf ]));
    const trak = writeBox("trak", Buffer.concat([ buildTkhd(1), mdia ]));
    const moov = writeBox("moov", trak);
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), moov ]);

    assert.deepEqual(parseH264AvcCFromFmp4Init(fmp4), { known: false });
  });

  test("resolveDeclaredH264FromFmp4Init contains thrown parse faults (DC4)", () => {

    assert.deepEqual(resolveDeclaredH264FromFmp4Init(Buffer.from("init"), () => {

      throw new TypeError("injected parse fault");
    }), { sourceDeclaredH264Known: false });
  });

  test("resolveDeclaredH264FromFmp4Init uses injected parser on valid avcC init (DC6)", () => {

    const avcC = buildAvcCBox(77, 31);
    const avc1 = writeBox("avc1", Buffer.concat([ Buffer.alloc(78, 0), avcC ]));
    const stsdVersion = Buffer.alloc(8, 0);

    stsdVersion.writeUInt32BE(1, 4);
    const stsd = writeBox("stsd", Buffer.concat([ stsdVersion, avc1 ]));
    const stbl = writeBox("stbl", stsd);
    const minf = writeBox("minf", stbl);
    const mdia = writeBox("mdia", Buffer.concat([ buildHdlr("vide"), minf ]));
    const trak = writeBox("trak", Buffer.concat([ buildTkhd(1), mdia ]));
    const moov = writeBox("moov", trak);
    const fmp4 = Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), moov ]);
    let injectCalls = 0;

    assert.deepEqual(resolveDeclaredH264FromFmp4Init(fmp4, () => {

      injectCalls += 1;

      throw new TypeError("injected parse fault");
    }), { sourceDeclaredH264Known: false });
    assert.equal(injectCalls, 1, "production must call the injected parser even when real avcC would parse as known");
  });
});

describe("h264LevelIdcToRank", () => {

  test("maps common levels", () => {

    assert.equal(h264LevelIdcToRank(31), 0);
    assert.equal(h264LevelIdcToRank(32), 1);
    assert.equal(h264LevelIdcToRank(40), 2);
    assert.equal(h264LevelIdcToRank(41), 3);
    assert.equal(h264LevelIdcToRank(51), 6);
  });
});

describe("h264ProfileIdcToRank", () => {

  test("maps baseline, main, high", () => {

    assert.equal(h264ProfileIdcToRank(66), 0);
    assert.equal(h264ProfileIdcToRank(77), 1);
    assert.equal(h264ProfileIdcToRank(100), 2);
    assert.equal(h264ProfileIdcToRank(88), undefined);
  });
});
