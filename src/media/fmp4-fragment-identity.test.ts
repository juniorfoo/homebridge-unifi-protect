/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved. */
/* eslint-disable sort-imports, sort-keys */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { makeBox, makeContainer } from "homebridge-plugin-utils/testing";
import { makeKeyframeFragment, makeNonKeyframeFragment, makeUntimedNonKeyframeFragment } from "./testing.helpers.ts";
import { applyPrimeMediaFloorClearAfterComparableAheadLiveWrite, isPrimeMediaFloorEmpty, isTrackMfhdOnlyInFloor, livePrimeMediaFloorFromIdentity,
  parseFmp4MediaFragmentIdentity, parseFmp4MoofTiming, parseLastMediaFragmentIdentityInPrimingBuffer, parsePrimeMediaFloorFromPrimingBuffer,
  shouldSkipLiveSegmentAfterCopyPrime } from "./fmp4-fragment-identity.ts";

const wrapLargesizeBox = (type: string, payload: Buffer): Buffer => {

  const inner = makeBox(type, payload);
  const body = inner.subarray(8);
  const largesize = Buffer.alloc(16 + body.length);

  largesize.writeUInt32BE(1, 0);
  largesize.write(type, 4, 4, "ascii");
  largesize.writeBigUInt64BE(BigInt(16 + body.length), 8);
  body.copy(largesize, 16);

  return largesize;
};

const makeTfdtVersion1Box = (baseMediaDecodeTime: number): Buffer => {

  const payload = Buffer.alloc(12);

  payload.writeUInt8(1, 0);
  payload.writeBigUInt64BE(BigInt(baseMediaDecodeTime), 4);

  return makeBox("tfdt", payload);
};

const makeTrunStub = (): Buffer => makeBox("trun", Buffer.alloc(16));

const makeTfhdBox = (trackId: number): Buffer => {

  const payload = Buffer.alloc(8);

  payload.writeUInt32BE(0, 0);
  payload.writeUInt32BE(trackId, 4);

  return makeBox("tfhd", payload);
};

const makeTfdtVersion0Box = (baseMediaDecodeTime: number): Buffer => {

  const payload = Buffer.alloc(8);

  payload.writeUInt32BE(0, 0);
  payload.writeUInt32BE(baseMediaDecodeTime, 4);

  return makeBox("tfdt", payload);
};

const makeMfhdBox = (sequenceNumber: number): Buffer => {

  const payload = Buffer.alloc(8);

  payload.writeUInt32BE(0, 0);
  payload.writeUInt32BE(sequenceNumber, 4);

  return makeBox("mfhd", payload);
};

const makeMultiTrafFragment = (sequenceNumber: number, trafs: { baseMediaDecodeTime?: number; trackId: number }[], tag?: number): Buffer => {

  const trafBoxes = trafs.map((traf) => {

    const children: Buffer[] = [ makeTfhdBox(traf.trackId), makeTrunStub() ];

    if(traf.baseMediaDecodeTime !== undefined) {

      children.splice(1, 0, makeTfdtVersion0Box(traf.baseMediaDecodeTime));
    }

    return makeContainer("traf", children);
  });
  const moof = makeContainer("moof", [ makeMfhdBox(sequenceNumber), ...trafBoxes ]);
  const tagPayload = tag === undefined ? Buffer.alloc(0) : Buffer.from([ tag & 0xFF, (tag >> 8) & 0xFF ]);

  return Buffer.concat([ moof, makeBox("mdat", tagPayload) ]);
};

const makeMoofWithTfdtVersion1 = (baseMediaDecodeTime: number, sequenceNumber: number): Buffer => {

  const mfhdPayload = Buffer.alloc(8);

  mfhdPayload.writeUInt32BE(0, 0);
  mfhdPayload.writeUInt32BE(sequenceNumber, 4);

  const trunPayload = Buffer.alloc(16);

  trunPayload.writeUInt32BE(0, 0);

  return makeContainer("moof", [ makeBox("mfhd", mfhdPayload), makeContainer("traf", [ makeTfhdBox(1), makeTfdtVersion1Box(baseMediaDecodeTime),
    makeBox("trun", trunPayload) ]) ]);
};

const findNestedBoxOffset = (data: Buffer, rangeStart: number, rangeEnd: number, childType: string): number => {

  let offset = rangeStart;

  while(offset + 8 <= rangeEnd) {

    const size = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString("ascii");

    if(type === childType) {

      return offset;
    }

    if(size < 8) {

      break;
    }

    const boxEnd = offset + size;
    const nested = findNestedBoxOffset(data, offset + 8, boxEnd, childType);

    if(nested >= 0) {

      return nested;
    }

    offset = boxEnd;
  }

  return -1;
};

describe("fmp4 fragment identity", () => {

  test("reads tfdt baseMediaDecodeTime from test harness fragments", () => {

    const fragment = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 12_345, sequenceNumber: 9 });
    const identity = parseFmp4MediaFragmentIdentity(fragment.data);

    assert.ok(identity);
    assert.equal(identity.baseMediaDecodeTime, 12_345);
    assert.equal(identity.sequenceNumber, 9);
  });

  test("shouldSkip does not drop another track at the same decode time when requireTrackMatch is true", () => {

    const floorFragment = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 5000, sequenceNumber: 3, trackId: 1 });
    const otherTrackSameTime = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 5000, sequenceNumber: 4, trackId: 2 });
    const floorIdentity = parseFmp4MediaFragmentIdentity(floorFragment.data);

    assert.ok(floorIdentity);
    const floor = livePrimeMediaFloorFromIdentity(floorIdentity);

    assert.equal(shouldSkipLiveSegmentAfterCopyPrime(floor, otherTrackSameTime.data, { atOrBefore: true }), false);
  });

  test("shouldSkip drops lagging duplicate at or before prime floor", () => {

    const floorFragment = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 5000, sequenceNumber: 3 });
    const floorIdentity = parseFmp4MediaFragmentIdentity(floorFragment.data);

    assert.ok(floorIdentity);
    const lagging = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 5000, sequenceNumber: 3 });
    const ahead = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 6000, sequenceNumber: 4 });
    const floor = livePrimeMediaFloorFromIdentity(floorIdentity);

    assert.equal(shouldSkipLiveSegmentAfterCopyPrime(floor, lagging.data, { atOrBefore: true }), true);
    assert.equal(shouldSkipLiveSegmentAfterCopyPrime(floor, ahead.data, { atOrBefore: true }), false);
  });

  test("per-traf moof skip requires every timed traf at or before its floor", () => {

    const floor = { sequenceNumber: 10, trackDecodeTimes: { 1: 100, 2: 200 }, trackMfhdOnly: {} };
    const laggingBoth = makeMultiTrafFragment(9, [ { trackId: 1, baseMediaDecodeTime: 100 }, { trackId: 2, baseMediaDecodeTime: 200 } ]);
    const mixed = makeMultiTrafFragment(11, [ { trackId: 1, baseMediaDecodeTime: 100 }, { trackId: 2, baseMediaDecodeTime: 250 } ]);
    const unknownTrack = makeMultiTrafFragment(11, [ { trackId: 3, baseMediaDecodeTime: 50 } ]);

    assert.equal(shouldSkipLiveSegmentAfterCopyPrime(floor, laggingBoth, { atOrBefore: true }), true);
    assert.equal(shouldSkipLiveSegmentAfterCopyPrime(floor, mixed, { atOrBefore: true }), false);
    assert.equal(shouldSkipLiveSegmentAfterCopyPrime(floor, unknownTrack, { atOrBefore: true }), false);
  });

  test("prime floor records each traf tfdt separately (video+audio without audio tfdt)", () => {

    const dual = makeMultiTrafFragment(101, [ { trackId: 1, baseMediaDecodeTime: 900_000 }, { trackId: 2 } ]);
    const floor = parsePrimeMediaFloorFromPrimingBuffer(dual);

    assert.ok(floor);
    assert.equal(floor.trackDecodeTimes[1], 900_000);
    assert.equal(floor.trackMfhdOnly[2], true);
    assert.equal(floor.trackDecodeTimes[2], undefined);
    assert.equal(floor.sequenceNumber, 101);
  });

  test("prime floor keeps both tracks when a moof carries timed video and audio trafs", () => {

    const moof = makeMultiTrafFragment(101, [ { trackId: 2, baseMediaDecodeTime: 903_000 }, { trackId: 1, baseMediaDecodeTime: 900_000 } ]);
    const floor = parsePrimeMediaFloorFromPrimingBuffer(moof);

    assert.ok(floor);
    assert.equal(floor.trackDecodeTimes[1], 900_000);
    assert.equal(floor.trackDecodeTimes[2], 903_000);
  });

  test("prime floor across dual-traf moofs never pairs orphan tfdt onto audio track 2", () => {

    const prime = Buffer.concat([
      makeMultiTrafFragment(101, [ { trackId: 1, baseMediaDecodeTime: 900_000 }, { trackId: 2 } ]),
      makeMultiTrafFragment(102, [ { trackId: 1, baseMediaDecodeTime: 903_000 }, { trackId: 2 } ])
    ]);
    const floor = parsePrimeMediaFloorFromPrimingBuffer(prime);

    assert.ok(floor);
    assert.equal(floor.trackDecodeTimes[1], 903_000);
    assert.equal(floor.trackMfhdOnly[2], true);
    assert.equal(floor.trackDecodeTimes[2], undefined);
  });

  test("mfhd-only primed tracks skip lagging mfhd duplicates", () => {

    const prime = makeMultiTrafFragment(11, [ { trackId: 1 }, { trackId: 2 } ]);
    const floor = parsePrimeMediaFloorFromPrimingBuffer(prime);

    assert.ok(floor);
    assert.equal(floor.sequenceNumber, 11);
    assert.equal(floor.trackMfhdOnly[1], true);
    const laggingDup = makeMultiTrafFragment(11, [ { trackId: 1 }, { trackId: 2 } ]);

    assert.equal(shouldSkipLiveSegmentAfterCopyPrime(floor, laggingDup, { atOrBefore: true }), true);
  });

  test("primed video tfdt plus mfhd-only audio skips a full replay moof", () => {

    const prime = makeMultiTrafFragment(101, [ { trackId: 1, baseMediaDecodeTime: 900_000 }, { trackId: 2 } ]);
    const floor = parsePrimeMediaFloorFromPrimingBuffer(prime);

    assert.ok(floor);
    const replay = makeMultiTrafFragment(101, [ { trackId: 1, baseMediaDecodeTime: 900_000 }, { trackId: 2 } ]);

    assert.equal(shouldSkipLiveSegmentAfterCopyPrime(floor, replay, { atOrBefore: true }), true);
  });

  test("unprimed tfhd-only live traf with lagging video traf is not skipped", () => {

    const floor = parsePrimeMediaFloorFromPrimingBuffer(makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 500, sequenceNumber: 5, trackId: 1 }).data);

    assert.ok(floor);
    const live = makeMultiTrafFragment(5, [ { trackId: 1, baseMediaDecodeTime: 500 }, { trackId: 2 } ]);

    assert.equal(shouldSkipLiveSegmentAfterCopyPrime(floor, live, { atOrBefore: true }), false);
  });

  test("tfdt-ahead live moof is not skipped when mfhd is still at or before floor", () => {

    const floor = { sequenceNumber: 20, trackDecodeTimes: { 1: 100 }, trackMfhdOnly: {} };
    const aheadTfdtLaggingMfhd = makeMultiTrafFragment(20, [ { trackId: 1, baseMediaDecodeTime: 200 } ]);

    assert.equal(shouldSkipLiveSegmentAfterCopyPrime(floor, aheadTfdtLaggingMfhd, { atOrBefore: true }), false);
  });

  test("applyPrime clears mfhd sequence when tracks are empty and live moof has no mfhd", () => {

    const floor = { sequenceNumber: 10, trackDecodeTimes: { 1: 100 }, trackMfhdOnly: {} };
    const moofNoMfhd = makeContainer("moof", [ makeContainer("traf", [ makeTfhdBox(1), makeTfdtVersion0Box(200), makeTrunStub() ]) ]);
    const fragment = Buffer.concat([ moofNoMfhd, makeBox("mdat", Buffer.alloc(0)) ]);

    assert.equal(applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor, fragment), true);
    assert.equal(isPrimeMediaFloorEmpty(floor), true);
  });

  test("applyPrime does not clear a tfdt track floor on equal decode time", () => {

    const floor = { sequenceNumber: 5, trackDecodeTimes: { 1: 100 }, trackMfhdOnly: {} };
    const equal = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 100, sequenceNumber: 5, trackId: 1 });

    assert.equal(applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor, equal.data), false);
    assert.equal(floor.trackDecodeTimes[1], 100);
  });

  test("applyPrime clears mfhd-only track on strictly-ahead sequence", () => {

    const floor = parsePrimeMediaFloorFromPrimingBuffer(makeMultiTrafFragment(10, [ { trackId: 2 } ]));

    assert.ok(floor);
    const ahead = makeMultiTrafFragment(11, [ { trackId: 2 } ]);

    assert.equal(applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor, ahead), true);
    assert.equal(floor.trackMfhdOnly[2], undefined);
  });

  test("applyPrime keeps mfhd sequence on equal live mfhd when track maps are empty", () => {

    const floor = { sequenceNumber: 10, trackDecodeTimes: {}, trackMfhdOnly: {} };
    const mfhdOnlyMoof = makeContainer("moof", [ makeMfhdBox(10) ]);
    const fragment = Buffer.concat([ mfhdOnlyMoof, makeBox("mdat", Buffer.alloc(0)) ]);

    assert.equal(applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor, fragment), false);
    assert.equal(floor.sequenceNumber, 10);
  });

  test("applyPrime keeps mfhd sequence on lagging live mfhd when track maps are empty", () => {

    const floor = { sequenceNumber: 10, trackDecodeTimes: {}, trackMfhdOnly: {} };
    const mfhdOnlyMoof = makeContainer("moof", [ makeMfhdBox(9) ]);
    const fragment = Buffer.concat([ mfhdOnlyMoof, makeBox("mdat", Buffer.alloc(0)) ]);

    assert.equal(applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor, fragment), false);
    assert.equal(floor.sequenceNumber, 10);
  });

  test("applyPrime clears every traf in a dual-traf ahead moof", () => {

    const floor = parsePrimeMediaFloorFromPrimingBuffer(makeMultiTrafFragment(10, [
      { trackId: 1, baseMediaDecodeTime: 100 },
      { trackId: 2 }
    ]));

    assert.ok(floor);
    const live = makeMultiTrafFragment(11, [ { trackId: 1, baseMediaDecodeTime: 150 }, { trackId: 2 } ]);

    assert.equal(applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor, live), true);
    assert.equal(isPrimeMediaFloorEmpty(floor), true);
  });

  test("isPrimeMediaFloorEmpty requires track maps and mfhd fallback cleared", () => {

    assert.equal(isPrimeMediaFloorEmpty({ sequenceNumber: 10, trackDecodeTimes: {}, trackMfhdOnly: {} }), false);
    assert.equal(isPrimeMediaFloorEmpty({ sequenceNumber: null, trackDecodeTimes: { 1: 100 }, trackMfhdOnly: {} }), false);
    assert.equal(isPrimeMediaFloorEmpty({ sequenceNumber: null, trackDecodeTimes: {}, trackMfhdOnly: { 2: true } }), false);
    assert.equal(isPrimeMediaFloorEmpty({ sequenceNumber: null, trackDecodeTimes: {}, trackMfhdOnly: {} }), true);
  });

  test("unreadable moof in the prime buffer disables dedup entirely", () => {

    const good = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 100, sequenceNumber: 5, trackId: 1 });
    const bad = makeUntimedNonKeyframeFragment();

    assert.equal(parsePrimeMediaFloorFromPrimingBuffer(Buffer.concat([ good.data, bad.data ])), null);
  });

  test("tfdt without tfhd is ignored and never deduped", () => {

    const moof = makeContainer("moof", [ makeMfhdBox(5), makeContainer("traf", [ makeTfdtVersion0Box(50), makeTrunStub() ]) ]);
    const fragment = Buffer.concat([ moof, makeBox("mdat", Buffer.alloc(0)) ]);

    assert.equal(parseFmp4MoofTiming(fragment), null);
    assert.equal(shouldSkipLiveSegmentAfterCopyPrime({ sequenceNumber: 5, trackDecodeTimes: { 1: 100 }, trackMfhdOnly: {} }, fragment, { atOrBefore: true }), false);
  });

  test("parsePrimeMediaFloorFromPrimingBuffer records every track moof in the prime", () => {

    const video = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 100, sequenceNumber: 9, trackId: 1 });
    const audio = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 200, sequenceNumber: 10, trackId: 2 });
    const floor = parsePrimeMediaFloorFromPrimingBuffer(Buffer.concat([ video.data, audio.data ]));

    assert.ok(floor);
    assert.equal(floor.trackDecodeTimes[1], 100);
    assert.equal(floor.trackDecodeTimes[2], 200);
    assert.equal(floor.sequenceNumber, 10);
  });

  test("parseLastMediaFragmentIdentityInPrimingBuffer reads trailing moof", () => {

    const init = Buffer.alloc(0);
    const first = makeKeyframeFragment();
    const last = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 777, sequenceNumber: 88 });
    const prime = Buffer.concat([ init, first.data, last.data ]);
    const identity = parseLastMediaFragmentIdentityInPrimingBuffer(prime);

    assert.equal(identity?.baseMediaDecodeTime, 777);
    assert.equal(identity?.sequenceNumber, 88);
  });

  test("parseLastMediaFragmentIdentityInPrimingBuffer returns null when only embedded moof bytes exist", () => {

    const embedded = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 55_555, sequenceNumber: 7 });
    const prime = Buffer.concat([ Buffer.alloc(0), makeBox("mdat", embedded.moof) ]);

    assert.equal(parseLastMediaFragmentIdentityInPrimingBuffer(prime), null);
  });

  test("parseLastMediaFragmentIdentityInPrimingBuffer ignores moof magic inside mdat payload", () => {

    const decoyTiming = { baseMediaDecodeTime: 9_999_999, sequenceNumber: 1 };
    const decoyBody = Buffer.concat([ Buffer.from("moof"), makeNonKeyframeFragment(undefined, decoyTiming).moof ]);
    const decoyMdat = makeBox("mdat", decoyBody);
    const realLast = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 12_345, sequenceNumber: 42 });
    const prime = Buffer.concat([ Buffer.alloc(0), decoyMdat, realLast.data ]);
    const identity = parseLastMediaFragmentIdentityInPrimingBuffer(prime);

    assert.equal(identity?.baseMediaDecodeTime, 12_345);
    assert.equal(identity?.sequenceNumber, 42);
  });

  test("parseLastMediaFragmentIdentityInPrimingBuffer returns null when trailing box is truncated", () => {

    const whole = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 100, sequenceNumber: 5 });
    const truncated = whole.moof.subarray(0, whole.moof.length - 4);
    const prime = Buffer.concat([ Buffer.alloc(0), truncated ]);

    assert.equal(parseLastMediaFragmentIdentityInPrimingBuffer(prime), null);
  });

  test("parseLastMediaFragmentIdentityInPrimingBuffer walks 64-bit largesize moof boxes", () => {

    const innerMoof = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 55_555, sequenceNumber: 7 }).moof;
    const moofPayload = innerMoof.subarray(8);
    const largesizeMoof = Buffer.alloc(16 + moofPayload.length);

    largesizeMoof.writeUInt32BE(1, 0);
    largesizeMoof.write("moof", 4, 4, "ascii");
    largesizeMoof.writeBigUInt64BE(BigInt(16 + moofPayload.length), 8);
    moofPayload.copy(largesizeMoof, 16);

    const innerMdat = makeBox("mdat", Buffer.alloc(0));
    const fragment = Buffer.concat([ largesizeMoof, innerMdat ]);
    const prime = Buffer.concat([ Buffer.alloc(0), fragment ]);
    const identity = parseLastMediaFragmentIdentityInPrimingBuffer(prime);

    assert.equal(identity?.baseMediaDecodeTime, 55_555);
    assert.equal(identity?.sequenceNumber, 7);
  });

  test("parse returns null when a child box claims more bytes than its parent", () => {

    const base = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 100, sequenceNumber: 5 });
    const decoy = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 99_999, sequenceNumber: 88 });
    const decoyTfdtAt = findNestedBoxOffset(decoy.moof, 0, decoy.moof.length, "tfdt");
    const decoyTfdtSize = decoy.moof.readUInt32BE(decoyTfdtAt);
    const decoyTfdt = decoy.moof.subarray(decoyTfdtAt, decoyTfdtAt + decoyTfdtSize);
    const moof = Buffer.from(base.moof);
    const trafAt = findNestedBoxOffset(moof, 0, moof.length, "traf");
    const trafSize = moof.readUInt32BE(trafAt);
    const trafEnd = trafAt + trafSize;
    const overhang = trafEnd - moof.length + decoyTfdt.length;

    moof.writeUInt32BE(trafSize + overhang, trafAt);
    const fragment = Buffer.concat([ moof, decoyTfdt, base.mdat ]);

    assert.equal(parseFmp4MediaFragmentIdentity(fragment), null);
  });

  test("parse returns null on short tfdt version 0 payload", () => {

    const trun = makeBox("trun", Buffer.alloc(16));
    const tfhd = makeBox("tfhd", Buffer.alloc(8));
    const tfdt = makeBox("tfdt", Buffer.from([ 0, 0, 0, 0 ]));
    const mfhdPayload = Buffer.alloc(8);

    mfhdPayload.writeUInt32BE(0, 0);
    mfhdPayload.writeUInt32BE(5, 4);
    const moof = makeContainer("moof", [ makeBox("mfhd", mfhdPayload), makeContainer("traf", [ tfhd, tfdt, trun ]) ]);
    const fragment = Buffer.concat([ moof, makeBox("mdat", Buffer.alloc(0)) ]);

    assert.equal(parseFmp4MediaFragmentIdentity(fragment), null);
  });

  test("parse returns null when a nested child box declares size zero", () => {

    const sizeZero = Buffer.alloc(8);

    sizeZero.writeUInt32BE(0, 0);
    sizeZero.write("free", 4);
    const tfhd = makeBox("tfhd", Buffer.alloc(8));
    const trun = makeBox("trun", Buffer.alloc(16));
    const tfdtPayload = Buffer.alloc(8);

    tfdtPayload.writeUInt32BE(0, 0);
    tfdtPayload.writeUInt32BE(100, 4);
    const tfdt = makeBox("tfdt", tfdtPayload);
    const mfhdPayload = Buffer.alloc(8);

    mfhdPayload.writeUInt32BE(0, 0);
    mfhdPayload.writeUInt32BE(5, 4);
    const moof = makeContainer("moof", [ makeBox("mfhd", mfhdPayload), makeContainer("traf", [ sizeZero, tfhd, trun, tfdt ]) ]);
    const fragment = Buffer.concat([ moof, makeBox("mdat", Buffer.alloc(0)) ]);

    assert.equal(parseFmp4MediaFragmentIdentity(fragment), null);
  });

  test("shouldSkip never drops unreadable live fragments", () => {

    const floor = livePrimeMediaFloorFromIdentity({ baseMediaDecodeTime: 5000, sequenceNumber: 3, trackId: 1 });
    const untimed = makeUntimedNonKeyframeFragment();

    assert.equal(shouldSkipLiveSegmentAfterCopyPrime(floor, untimed.data, { atOrBefore: true }), false);
    assert.equal(applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor, untimed.data), false);
    assert.equal(floor.trackDecodeTimes[1], 5000);
  });

  test("applyPrime clear rejects unreadable and strictly-ahead on the floor track only", () => {

    const floor = livePrimeMediaFloorFromIdentity({ baseMediaDecodeTime: 100, sequenceNumber: 5, trackId: 1 });
    const otherTrack = makeNonKeyframeFragment(0x0A, { baseMediaDecodeTime: 200, sequenceNumber: 8, trackId: 2 });
    const ahead = makeNonKeyframeFragment(0x0B, { baseMediaDecodeTime: 200, sequenceNumber: 6, trackId: 1 });
    const untimed = makeUntimedNonKeyframeFragment();

    assert.equal(parseFmp4MediaFragmentIdentity(otherTrack.data)?.trackId, 2);
    assert.equal(applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor, untimed.data), false);
    assert.equal(applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor, otherTrack.data), false);
    assert.equal(applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor, ahead.data), true);
    assert.equal(floor.trackDecodeTimes[1], undefined);
  });

  test("applyPrime clear drops mfhd fallback after a strictly-ahead mfhd-only fragment", () => {

    const floor = parsePrimeMediaFloorFromPrimingBuffer(makeMultiTrafFragment(10, [ { trackId: 1 } ]));

    assert.ok(floor);
    const ahead = makeMultiTrafFragment(11, [ { trackId: 1 } ]);

    assert.equal(applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor, ahead), true);
    assert.equal(isPrimeMediaFloorEmpty(floor), true);
  });

  test("mfhd-only clear does not fire on equal sequence (M1)", () => {

    const floor = parsePrimeMediaFloorFromPrimingBuffer(makeMultiTrafFragment(10, [ { trackId: 1 } ]));

    assert.ok(floor);
    const equal = makeMultiTrafFragment(10, [ { trackId: 1 } ]);

    assert.equal(applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor, equal), false);
    assert.equal(isPrimeMediaFloorEmpty(floor), false);
  });

  test("mfhd-only clear ignores live moof with null mfhd sequence (M2)", () => {

    const floor = parsePrimeMediaFloorFromPrimingBuffer(makeMultiTrafFragment(10, [ { trackId: 1 } ]));

    assert.ok(floor);
    const tfhd = makeTfhdBox(1);
    const trun = makeTrunStub();
    const traf = makeContainer("traf", [ tfhd, trun ]);
    const moof = makeContainer("moof", [ traf ]);
    const live = Buffer.concat([ moof, makeBox("mdat", Buffer.alloc(0)) ]);

    assert.equal(applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor, live), false);
    assert.equal(Object.keys(floor.trackMfhdOnly).length, 1);
    assert.equal(floor.trackMfhdOnly[1], true);
    assert.equal(floor.sequenceNumber, 10);
  });

  test("prime floor mfhd uses max across moofs not last only (M3)", () => {

    const early = makeMultiTrafFragment(15, [ { trackId: 1 } ]);
    const late = makeMultiTrafFragment(5, [ { trackId: 1 } ]);
    const floor = parsePrimeMediaFloorFromPrimingBuffer(Buffer.concat([ early, late ]));

    assert.ok(floor);
    assert.equal(floor.sequenceNumber, 15);
    const between = makeMultiTrafFragment(12, [ { trackId: 1 } ]);

    assert.equal(shouldSkipLiveSegmentAfterCopyPrime(floor, between, { atOrBefore: true }), true);
  });

  test("tfdt on primed track clears stale mfhd-only bookkeeping (M4 M5)", () => {

    const merged = parsePrimeMediaFloorFromPrimingBuffer(Buffer.concat([
      makeMultiTrafFragment(10, [ { trackId: 1 } ]),
      makeMultiTrafFragment(11, [ { trackId: 1, baseMediaDecodeTime: 200 } ])
    ]));

    assert.ok(merged);
    assert.equal(merged.trackMfhdOnly[1], undefined);
    assert.equal(merged.trackDecodeTimes[1], 200);
    assert.equal(merged.trackMfhdOnly[1], undefined, "stale mfhd-only bookkeeping must drop when tfdt arrives (M4)");
    assert.equal(isTrackMfhdOnlyInFloor(merged, 1), false);
  });

  test("mfhd-only clear drops only the matching track (M7)", () => {

    const floor = {

      sequenceNumber: 10,
      trackDecodeTimes: {},
      trackMfhdOnly: { 1: true as const, 2: true as const }
    };
    const ahead = makeMultiTrafFragment(11, [ { trackId: 1 } ]);

    assert.equal(applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor, ahead), true);
    assert.equal(floor.trackMfhdOnly[1], undefined);
    assert.equal(floor.trackMfhdOnly[2], true);
  });

  test("shouldSkip false when mfhd missing on tfdt traf with mfhd-only floor (M9)", () => {

    const floor = parsePrimeMediaFloorFromPrimingBuffer(makeMultiTrafFragment(10, [ { trackId: 1 } ]));

    assert.ok(floor);
    const tfhd = makeTfhdBox(1);
    const tfdt = makeTfdtVersion0Box(500);
    const trun = makeTrunStub();
    const traf = makeContainer("traf", [ tfhd, tfdt, trun ]);
    const live = Buffer.concat([ makeContainer("moof", [ traf ]), makeBox("mdat", Buffer.alloc(0)) ]);

    assert.equal(shouldSkipLiveSegmentAfterCopyPrime(floor, live, { atOrBefore: true }), false);
  });

  test("shouldSkip false when mfhd missing on tfdt-less traf (M10)", () => {

    const floor = parsePrimeMediaFloorFromPrimingBuffer(makeMultiTrafFragment(10, [ { trackId: 1 } ]));

    assert.ok(floor);
    const tfhd = makeTfhdBox(1);
    const trun = makeTrunStub();
    const live = Buffer.concat([ makeContainer("moof", [ makeContainer("traf", [ tfhd, trun ]) ]), makeBox("mdat", Buffer.alloc(0)) ]);

    assert.equal(shouldSkipLiveSegmentAfterCopyPrime(floor, live, { atOrBefore: true }), false);
  });

  test("does not skip ahead mfhd when floor track is mfhd-only but live traf has tfdt (M11)", () => {

    const floor = parsePrimeMediaFloorFromPrimingBuffer(makeMultiTrafFragment(10, [ { trackId: 1 } ]));

    assert.ok(floor);
    const ahead = makeMultiTrafFragment(11, [ { trackId: 1, baseMediaDecodeTime: 9_000 } ]);

    assert.equal(shouldSkipLiveSegmentAfterCopyPrime(floor, ahead, { atOrBefore: true }), false);
  });

  test("shouldSkip false for moof with zero traf boxes (M12)", () => {

    const floor = livePrimeMediaFloorFromIdentity({ baseMediaDecodeTime: 100, sequenceNumber: 5, trackId: 1 });
    const mfhdPayload = Buffer.alloc(8);

    mfhdPayload.writeUInt32BE(0, 0);
    mfhdPayload.writeUInt32BE(5, 4);
    const emptyMoof = Buffer.concat([ makeContainer("moof", [ makeBox("mfhd", mfhdPayload) ]), makeBox("mdat", Buffer.alloc(0)) ]);

    assert.equal(shouldSkipLiveSegmentAfterCopyPrime(floor, emptyMoof, { atOrBefore: true }), false);
  });

  test("G2 clears tfdt floor when live traf lacks tfdt but mfhd is ahead (M19)", () => {

    const floor = livePrimeMediaFloorFromIdentity({ baseMediaDecodeTime: 100, sequenceNumber: 10, trackId: 1 });
    const aheadMfhdOnlyTraf = makeMultiTrafFragment(12, [ { trackId: 1 } ]);

    assert.equal(applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor, aheadMfhdOnlyTraf), true);
    assert.equal(floor.trackDecodeTimes[1], undefined);
  });

  test("G2a does not clear tfdt floor on equal mfhd without tfdt", () => {

    const floor = livePrimeMediaFloorFromIdentity({ baseMediaDecodeTime: 100, sequenceNumber: 10, trackId: 1 });
    const equalMfhdOnly = makeMultiTrafFragment(10, [ { trackId: 1 } ]);

    assert.equal(applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor, equalMfhdOnly), false);
    assert.equal(floor.trackDecodeTimes[1], 100);
  });

  test("G2b null live mfhd does not clear tfdt floor (tfdt-less traf)", () => {

    const floor = livePrimeMediaFloorFromIdentity({ baseMediaDecodeTime: 100, sequenceNumber: 10, trackId: 1 });
    const moofNoMfhd = makeContainer("moof", [ makeContainer("traf", [ makeTfhdBox(1), makeTrunStub() ]) ]);
    const fragment = Buffer.concat([ moofNoMfhd, makeBox("mdat", Buffer.alloc(0)) ]);

    assert.equal(applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor, fragment), false);
    assert.equal(floor.trackDecodeTimes[1], 100);
  });

  test("G2c does not clear tfdt floor on lagging decode time", () => {

    const floor = livePrimeMediaFloorFromIdentity({ baseMediaDecodeTime: 200, sequenceNumber: 10, trackId: 1 });
    const lagging = makeMultiTrafFragment(11, [ { trackId: 1, baseMediaDecodeTime: 100 } ]);

    assert.equal(applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor, lagging), false);
    assert.equal(floor.trackDecodeTimes[1], 200);
  });

  test("G2d clears only the reconciled track", () => {

    const floor = parsePrimeMediaFloorFromPrimingBuffer(makeMultiTrafFragment(10, [
      { trackId: 1, baseMediaDecodeTime: 100 },
      { trackId: 2, baseMediaDecodeTime: 50 }
    ]));

    assert.ok(floor);
    const live = makeMultiTrafFragment(12, [ { trackId: 1 } ]);

    assert.equal(applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor, live), true);
    assert.equal(floor.trackDecodeTimes[1], undefined);
    assert.equal(floor.trackDecodeTimes[2], 50);
  });

  test("G2e null floor mfhd blocks mfhd-only clear until ahead seq (G2e)", () => {

    const floor = { sequenceNumber: null, trackDecodeTimes: {}, trackMfhdOnly: { 1: true as const } };
    const lagging = makeMultiTrafFragment(5, [ { trackId: 1 } ]);

    assert.equal(applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor, lagging), false);
    assert.equal(floor.trackMfhdOnly[1], true);
  });

  test("G2f tfdt live traf clears mfhd-only floor entry for that track", () => {

    const floor = parsePrimeMediaFloorFromPrimingBuffer(makeMultiTrafFragment(10, [ { trackId: 1 } ]));

    assert.ok(floor);
    const tfdtAhead = makeMultiTrafFragment(11, [ { trackId: 1, baseMediaDecodeTime: 9_000 } ]);

    assert.equal(applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor, tfdtAhead), true);
    assert.equal(floor.trackMfhdOnly[1], undefined);
  });

  test("shouldSkip mfhd-only floor: lagging and equal sequence skipped, ahead written", () => {

    const floor = parsePrimeMediaFloorFromPrimingBuffer(makeMultiTrafFragment(10, [ { trackId: 1 } ]));

    assert.ok(floor);
    const lagging = makeMultiTrafFragment(9, [ { trackId: 1 } ]);
    const equal = makeMultiTrafFragment(10, [ { trackId: 1 } ]);
    const ahead = makeMultiTrafFragment(11, [ { trackId: 1 } ]);

    assert.equal(shouldSkipLiveSegmentAfterCopyPrime(floor, lagging, { atOrBefore: true }), true);
    assert.equal(shouldSkipLiveSegmentAfterCopyPrime(floor, equal, { atOrBefore: true }), true);
    assert.equal(shouldSkipLiveSegmentAfterCopyPrime(floor, ahead, { atOrBefore: true }), false);
  });

  test("parseLastMediaFragmentIdentityInPrimingBuffer ignores moof inside last fragment mdat", () => {

    const real = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 12_345, sequenceNumber: 42 });
    const decoy = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 9_999_999, sequenceNumber: 1 });
    const mdatBody = Buffer.concat([ real.mdat.subarray(8), decoy.moof ]);
    const lastFragment = Buffer.concat([ real.moof, makeBox("mdat", mdatBody) ]);
    const prime = Buffer.concat([ Buffer.alloc(0), makeKeyframeFragment().data, lastFragment ]);
    const identity = parseLastMediaFragmentIdentityInPrimingBuffer(prime);

    assert.equal(identity?.baseMediaDecodeTime, 12_345);
    assert.equal(identity?.sequenceNumber, 42);
  });

  test("parse returns null on truncated mfhd and tfhd payloads", () => {

    const shrinkDeclaredBox = (moof: Buffer, childType: string): Buffer => {

      const copy = Buffer.from(moof);
      const at = findNestedBoxOffset(copy, 0, copy.length, childType);

      if(at < 0) {

        throw new Error("child type " + childType + " not found");
      }

      copy.writeUInt32BE(9, at);

      return copy;
    };

    for(const childType of [ "mfhd", "tfhd" ]) {

      const base = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 100, sequenceNumber: 5 });
      const moof = shrinkDeclaredBox(base.moof, childType);

      assert.equal(parseFmp4MediaFragmentIdentity(Buffer.concat([ moof, base.mdat ])), null);
    }
  });

  test("parse reads tfdt version 0 and version 1", () => {

    const v0 = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 42, sequenceNumber: 2 });
    const v0Identity = parseFmp4MediaFragmentIdentity(v0.data);

    assert.ok(v0Identity);
    assert.equal(v0Identity.baseMediaDecodeTime, 42);

    const v1Moof = makeMoofWithTfdtVersion1(9_876_543_210, 11);
    const v1Identity = parseFmp4MediaFragmentIdentity(Buffer.concat([ v1Moof, makeBox("mdat", Buffer.alloc(0)) ]));

    assert.ok(v1Identity);
    assert.equal(v1Identity.baseMediaDecodeTime, 9_876_543_210);
    assert.equal(v1Identity.sequenceNumber, 11);
  });

  test("parse reads largesize mfhd tfdt and tfhd leaf boxes", () => {

    const baseTime = 33_003;
    const mfhdPayload = Buffer.alloc(8);

    mfhdPayload.writeUInt32BE(0, 0);
    mfhdPayload.writeUInt32BE(9, 4);
    const tfdtPayload = Buffer.alloc(8);

    tfdtPayload.writeUInt32BE(0, 0);
    tfdtPayload.writeUInt32BE(baseTime, 4);
    const tfhdPayload = Buffer.alloc(8);

    tfhdPayload.writeUInt32BE(0, 0);
    tfhdPayload.writeUInt32BE(3, 4);

    const mfhd = wrapLargesizeBox("mfhd", mfhdPayload);
    const tfdt = wrapLargesizeBox("tfdt", tfdtPayload);
    const tfhd = wrapLargesizeBox("tfhd", tfhdPayload);
    const trun = makeBox("trun", Buffer.alloc(16));
    const moof = makeContainer("moof", [ mfhd, makeContainer("traf", [ tfhd, tfdt, trun ]) ]);
    const identity = parseFmp4MediaFragmentIdentity(Buffer.concat([ moof, makeBox("mdat", Buffer.alloc(0)) ]));

    assert.ok(identity);
    assert.equal(identity.baseMediaDecodeTime, baseTime);
    assert.equal(identity.sequenceNumber, 9);
    assert.equal(identity.trackId, 3);
  });

  test("parse returns null when a largesize header is truncated", () => {

    const innerMoof = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 1, sequenceNumber: 1 }).moof;

    innerMoof.writeUInt32BE(1, 0);
    const partial = innerMoof.subarray(0, 12);

    assert.equal(parseFmp4MediaFragmentIdentity(Buffer.concat([ partial, makeBox("mdat", Buffer.alloc(0)) ])), null);
    assert.equal(parseLastMediaFragmentIdentityInPrimingBuffer(Buffer.concat([ Buffer.alloc(0), partial ])), null);
  });

  test("parse and prime walk never throw on random truncation", () => {

    const whole = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 12_345, sequenceNumber: 42 }).data;

    for(let end = 0; end <= whole.length; end++) {

      const slice = whole.subarray(0, end);

      assert.doesNotThrow(() => {

        parseFmp4MediaFragmentIdentity(slice);
        parseLastMediaFragmentIdentityInPrimingBuffer(Buffer.concat([ Buffer.alloc(0), slice ]));
        shouldSkipLiveSegmentAfterCopyPrime(livePrimeMediaFloorFromIdentity({ baseMediaDecodeTime: 0, sequenceNumber: 1, trackId: 1 }), slice,
          { atOrBefore: true });
      });
    }
  });

  test("parseFmp4MediaFragmentIdentity swallows throw from hostile buffer reads", () => {

    const evil = Buffer.from(makeNonKeyframeFragment().data);

    Object.defineProperty(evil, "length", { value: evil.length });
    evil.readUInt32BE = () => {

      throw new Error("hostile read");
    };

    assert.equal(parseFmp4MediaFragmentIdentity(evil), null);
  });
});
