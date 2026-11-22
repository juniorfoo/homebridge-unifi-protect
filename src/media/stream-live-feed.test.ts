/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-live-feed.test.ts: Production TSB writer rotation used by copy-to-transcode escalation (mutation-sensitive).
 */
/* eslint-disable sort-imports, sort-keys */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Writable } from "node:stream";
import type { HomebridgePluginLogging, Mp4FrameFeed } from "homebridge-plugin-utils";
import { BackpressureWriter, HDLR_TYPE_VIDE } from "homebridge-plugin-utils";
import { TestClock, makeBox, makeContainer, makeFragment, makeInitSegment, settle } from "homebridge-plugin-utils/testing";
import { makeNonKeyframeFragment, makeUntimedNonKeyframeFragment } from "./testing.helpers.ts";
import { COPY_ESCALATION_PRIME_FLOOR_MAX_WRITTEN_LIVE_MOOF_CHECKS, livePrimeMediaFloorFromIdentity,
  parsePrimeMediaFloorFromPrimingBuffer } from "./fmp4-fragment-identity.ts";
import type { LivestreamSubscription } from "./livestream.ts";
import type { LiveTsbFeedState } from "./stream-live-feed.ts";
import { consumeLiveStreamSegments, createLiveFrameFeed, primeLiveFfmpegStdinAfterRespawn, rotateBackpressureWriterForCopyEscalation } from "./stream-live-feed.ts";
import { TestLiveStreamingFfmpegProcess } from "./test-live-ffmpeg-process.ts";

const makeStreamMultiTrafFragment = (sequenceNumber: number, trafs: { baseMediaDecodeTime?: number; trackId: number }[], tag?: number): Buffer => {

  const trun = makeBox("trun", Buffer.alloc(16));
  const trafBoxes = trafs.map((traf) => {

    const tfhdPayload = Buffer.alloc(8);

    tfhdPayload.writeUInt32BE(0, 0);
    tfhdPayload.writeUInt32BE(traf.trackId, 4);
    const children: Buffer[] = [ makeBox("tfhd", tfhdPayload), trun ];

    if(traf.baseMediaDecodeTime !== undefined) {

      const tfdtPayload = Buffer.alloc(8);

      tfdtPayload.writeUInt32BE(0, 0);
      tfdtPayload.writeUInt32BE(traf.baseMediaDecodeTime, 4);
      children.splice(1, 0, makeBox("tfdt", tfdtPayload));
    }

    return makeContainer("traf", children);
  });
  const mfhdPayload = Buffer.alloc(8);

  mfhdPayload.writeUInt32BE(0, 0);
  mfhdPayload.writeUInt32BE(sequenceNumber, 4);
  const moof = makeContainer("moof", [ makeBox("mfhd", mfhdPayload), ...trafBoxes ]);
  const tagPayload = tag === undefined ? Buffer.alloc(0) : Buffer.from([ tag & 0xFF, (tag >> 8) & 0xFF ]);

  return Buffer.concat([ moof, makeBox("mdat", tagPayload) ]);
};

describe("rotateBackpressureWriterForCopyEscalation", () => {

  test("returns a fresh writer and aborts the poisoned writer", () => {

    const signal = new AbortController().signal;
    let stdin: Writable = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    const poisoned = new BackpressureWriter(() => stdin, { signal: signal });

    stdin = new Writable({ write: (_chunk, _encoding, callback): void => callback() });

    const replacement = rotateBackpressureWriterForCopyEscalation({

      getStdin: () => stdin,
      poisoned: poisoned,
      signal: signal
    });

    assert.notEqual(replacement, poisoned);
    assert.ok(poisoned.signal.aborted);
    assert.ok(!replacement.signal.aborted);
  });
});

const testClock = new TestClock(0);

const stubLog: HomebridgePluginLogging = {

  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined
};

const INIT_WITH_VIDEO = makeInitSegment([{ handler: HDLR_TYPE_VIDE, id: 1, timescale: 90000 }]);
const FRAME_TICKS = 3600;

function framesOf(sizes: number[]): Buffer {

  return makeFragment({ samples: sizes.map((size) => ({ duration: FRAME_TICKS, size })), trackId: 1 });
}

function frameFeedFor(proc: TestLiveStreamingFfmpegProcess): Mp4FrameFeed {

  const writer = new BackpressureWriter(() => proc.stdin, { clock: testClock, signal: new AbortController().signal });

  return createLiveFrameFeed(writer, testClock, stubLog);
}

describe("primeLiveFfmpegStdinAfterRespawn", () => {

  test("prefers keyframe priming buffer over init alone", async () => {

    const proc = new TestLiveStreamingFfmpegProcess("prime");
    const init = Buffer.from("init-segment");
    const priming = Buffer.concat([ init, Buffer.from("keyframe-bytes") ]);

    primeLiveFfmpegStdinAfterRespawn({ allowTimeshiftPrefix: true, headerWritten: true, primeMediaFloor: null }, { initSegment: { data: init } } as never,
      frameFeedFor(proc), priming);
    await settle();

    assert.equal(proc.stdinWrites.length, 1);
    assert.deepEqual(proc.stdinWrites[0], priming);
  });

  test("uses init only when keyframe priming buffer is null (mismatched buffer channel)", async () => {

    const proc = new TestLiveStreamingFfmpegProcess("prime-init-only");
    const init = Buffer.from("init-segment");

    primeLiveFfmpegStdinAfterRespawn({ allowTimeshiftPrefix: true, headerWritten: true, primeMediaFloor: null }, { initSegment: { data: init } } as never,
      frameFeedFor(proc), null);
    await settle();

    assert.equal(proc.stdinWrites.length, 1);
    assert.deepEqual(proc.stdinWrites[0], init);
  });

  test("records primeMediaFloor from the last moof in a keyframe priming buffer", () => {

    const proc = new TestLiveStreamingFfmpegProcess("prime-floor");
    const init = Buffer.from("init-segment");
    const lagging = makeNonKeyframeFragment(0xAB, { baseMediaDecodeTime: 77777, sequenceNumber: 7 });
    const priming = Buffer.concat([lagging.data]);
    const feedState: LiveTsbFeedState = { allowTimeshiftPrefix: true, headerWritten: false, primeMediaFloor: null };

    primeLiveFfmpegStdinAfterRespawn(feedState, { initSegment: { data: init } } as never, frameFeedFor(proc), priming);

    assert.ok(feedState.primeMediaFloor);
    assert.equal(feedState.primeMediaFloor.trackDecodeTimes[1], 77777);
    assert.equal(feedState.primeMediaFloor.sequenceNumber, 7);
  });

  test("records per-track floors from every moof in a keyframe priming buffer", () => {

    const proc = new TestLiveStreamingFfmpegProcess("prime-floor-multitrack");
    const init = Buffer.from("init-segment");
    const video = makeNonKeyframeFragment(0x01, { baseMediaDecodeTime: 100, sequenceNumber: 6, trackId: 1 });
    const audio = makeNonKeyframeFragment(0x02, { baseMediaDecodeTime: 200, sequenceNumber: 6, trackId: 2 });
    const priming = Buffer.concat([ video.data, audio.data ]);
    const feedState: LiveTsbFeedState = { allowTimeshiftPrefix: true, headerWritten: false, primeMediaFloor: null };

    primeLiveFfmpegStdinAfterRespawn(feedState, { initSegment: { data: init } } as never, frameFeedFor(proc), priming);

    assert.ok(feedState.primeMediaFloor);
    assert.equal(feedState.primeMediaFloor.trackDecodeTimes[1], 100);
    assert.equal(feedState.primeMediaFloor.trackDecodeTimes[2], 200);
    assert.equal(feedState.primeMediaFloor.sequenceNumber, 6);
  });

  test("copy-escalation respawn primes the rotated Mp4FrameFeed via writeHeader so media fragments stay paced (R1)", async () => {

    const proc = new TestLiveStreamingFfmpegProcess("respawn-prime-writeHeader");
    const feed = frameFeedFor(proc);
    const feedState: LiveTsbFeedState = { allowTimeshiftPrefix: true, headerWritten: true, primeMediaFloor: null };
    const multiFrame = framesOf([ 100, 100 ]);

    primeLiveFfmpegStdinAfterRespawn(feedState, { initSegment: { data: INIT_WITH_VIDEO } } as never, feed, null, stubLog);
    await settle();

    const writesBeforeFragment = proc.stdinWrites.length;

    void feed.writeFragment(multiFrame);
    await settle();
    testClock.advance(FRAME_TICKS);
    await settle();
    testClock.advance(FRAME_TICKS);
    await settle();

    const fragmentStdinWrites = proc.stdinWrites.length - writesBeforeFragment;

    assert.ok(fragmentStdinWrites > 1,
      "priming must call writeHeader on the feed; otherwise writeFragment issues one blunt stdin write for the whole moof");
  });
});

function makeMediaSubscription(segments: { data: Buffer; type: "init" | "media" }[]): LivestreamSubscription {

  let index = 0;

  return {

    initSegment: { data: Buffer.from("init") },
    [Symbol.asyncIterator](): AsyncIterator<(typeof segments)[number]> {

      return {

        async next(): Promise<IteratorResult<(typeof segments)[number]>> {

          if(index >= segments.length) {

            return { done: true, value: undefined };
          }

          const value = segments[index];

          index += 1;

          assert.ok(value);

          return { done: false, value };
        }
      };
    }
  } as unknown as LivestreamSubscription;
}

describe("consumeLiveStreamSegments prime dedup", () => {

  test("writes untimed live media when a timed prime floor is set", async () => {

    const proc = new TestLiveStreamingFfmpegProcess("dedup-unreadable");
    const untimed = makeUntimedNonKeyframeFragment(0xAB);
    const feedState: LiveTsbFeedState = {

      allowTimeshiftPrefix: false,
      headerWritten: true,
      primeMediaFloor: livePrimeMediaFloorFromIdentity({ baseMediaDecodeTime: 77777, sequenceNumber: 7, trackId: 1 })
    };
    const writer = new BackpressureWriter(() => proc.stdin, { signal: new AbortController().signal });
    const lagging = makeNonKeyframeFragment(0xAC, { baseMediaDecodeTime: 77777, sequenceNumber: 7, trackId: 1 });

    await consumeLiveStreamSegments(() => proc as never, feedState,
      makeMediaSubscription([
        { data: untimed.data, type: "media" },
        { data: lagging.data, type: "media" }
      ]), () => createLiveFrameFeed(writer, testClock, stubLog), null, stubLog);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.ok(proc.stdinWrites.some((buf) => buf.equals(untimed.data)));
    assert.equal(feedState.primeMediaFloor?.trackDecodeTimes[1], 77777);
    assert.equal(proc.stdinWrites.some((buf) => buf.equals(lagging.data)), false);
  });

  test("keeps prime floor when a non-comparable track is written, then skips lagging on the floor track", async () => {

    const proc = new TestLiveStreamingFfmpegProcess("dedup-floor-other-track");
    const otherTrack = makeNonKeyframeFragment(0x0A, { baseMediaDecodeTime: 200, sequenceNumber: 8, trackId: 2 });
    const lagging = makeNonKeyframeFragment(0x0B, { baseMediaDecodeTime: 100, sequenceNumber: 5, trackId: 1 });
    const feedState: LiveTsbFeedState = {

      allowTimeshiftPrefix: false,
      headerWritten: true,
      primeMediaFloor: livePrimeMediaFloorFromIdentity({ baseMediaDecodeTime: 100, sequenceNumber: 5, trackId: 1 })
    };
    const writer = new BackpressureWriter(() => proc.stdin, { signal: new AbortController().signal });

    await consumeLiveStreamSegments(() => proc as never, feedState,
      makeMediaSubscription([
        { data: otherTrack.data, type: "media" },
        { data: lagging.data, type: "media" }
      ]), () => createLiveFrameFeed(writer, testClock, stubLog), null, stubLog);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(feedState.primeMediaFloor?.trackDecodeTimes[1], 100);
    assert.ok(proc.stdinWrites.some((buf) => buf.equals(otherTrack.data)));
    assert.equal(proc.stdinWrites.some((buf) => buf.equals(lagging.data)), false);
  });

  test("clears prime floor after a comparable strictly-ahead segment, then writes lower tfdt", async () => {

    const proc = new TestLiveStreamingFfmpegProcess("dedup-floor-clear");
    const lagging = makeNonKeyframeFragment(0x01, { baseMediaDecodeTime: 100, sequenceNumber: 5 });
    const ahead = makeNonKeyframeFragment(0x02, { baseMediaDecodeTime: 200, sequenceNumber: 6 });
    const replayLow = makeNonKeyframeFragment(0x03, { baseMediaDecodeTime: 50, sequenceNumber: 4 });
    const feedState: LiveTsbFeedState = {

      allowTimeshiftPrefix: false,
      headerWritten: true,
      primeMediaFloor: livePrimeMediaFloorFromIdentity({ baseMediaDecodeTime: 100, sequenceNumber: 5, trackId: 1 })
    };
    const writer = new BackpressureWriter(() => proc.stdin, { signal: new AbortController().signal });

    await consumeLiveStreamSegments(() => proc as never, feedState,
      makeMediaSubscription([
        { data: lagging.data, type: "media" },
        { data: ahead.data, type: "media" },
        { data: replayLow.data, type: "media" }
      ]), () => createLiveFrameFeed(writer, testClock, stubLog), null, stubLog);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(feedState.primeMediaFloor, null);
    assert.ok(proc.stdinWrites.some((buf) => buf.equals(ahead.data)));
    assert.ok(proc.stdinWrites.some((buf) => buf.equals(replayLow.data)));
    assert.equal(proc.stdinWrites.some((buf) => buf.equals(lagging.data)), false);
  });

  test("mfhd-only floor skips lagging pooled duplicate by sequence", async () => {

    const proc = new TestLiveStreamingFfmpegProcess("dedup-mfhd");
    const lagging = makeStreamMultiTrafFragment(9, [{ trackId: 1 }], 0x11);
    const equal = makeStreamMultiTrafFragment(10, [{ trackId: 1 }], 0x12);
    const ahead = makeStreamMultiTrafFragment(11, [{ trackId: 1 }], 0x13);
    const feedState: LiveTsbFeedState = {

      allowTimeshiftPrefix: false,
      headerWritten: true,
      primeMediaFloor: parsePrimeMediaFloorFromPrimingBuffer(makeStreamMultiTrafFragment(10, [{ trackId: 1 }]))
    };
    const writer = new BackpressureWriter(() => proc.stdin, { signal: new AbortController().signal });
    const replayLow = makeStreamMultiTrafFragment(8, [{ trackId: 1 }], 0x14);

    feedState.primeMediaFloorWrittenLiveMoofs = 0;

    await consumeLiveStreamSegments(() => proc as never, feedState,
      makeMediaSubscription([
        { data: lagging, type: "media" },
        { data: equal, type: "media" },
        { data: ahead, type: "media" },
        { data: replayLow, type: "media" }
      ]), () => createLiveFrameFeed(writer, testClock, stubLog), null, stubLog);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(proc.stdinWrites.some((buf) => buf.equals(lagging)), false);
    assert.equal(proc.stdinWrites.some((buf) => buf.equals(equal)), false);
    assert.ok(proc.stdinWrites.some((buf) => buf.equals(ahead)));
    assert.equal(feedState.primeMediaFloor, null);
    assert.ok(proc.stdinWrites.some((buf) => buf.equals(replayLow)));
  });

  test("per-track floors dedup video and audio moofs independently", async () => {

    const proc = new TestLiveStreamingFfmpegProcess("dedup-per-track");
    const videoLagging = makeNonKeyframeFragment(0x21, { baseMediaDecodeTime: 100, sequenceNumber: 8, trackId: 1 });
    const audioLagging = makeNonKeyframeFragment(0x22, { baseMediaDecodeTime: 200, sequenceNumber: 8, trackId: 2 });
    const videoAhead = makeNonKeyframeFragment(0x23, { baseMediaDecodeTime: 150, sequenceNumber: 9, trackId: 1 });
    const audioAhead = makeNonKeyframeFragment(0x24, { baseMediaDecodeTime: 250, sequenceNumber: 9, trackId: 2 });
    const feedState: LiveTsbFeedState = {

      allowTimeshiftPrefix: false,
      headerWritten: true,
      primeMediaFloor: {

        sequenceNumber: 8,
        trackDecodeTimes: { 1: 100, 2: 200 },
        trackMfhdOnly: {}
      }
    };
    const writer = new BackpressureWriter(() => proc.stdin, { signal: new AbortController().signal });

    await consumeLiveStreamSegments(() => proc as never, feedState,
      makeMediaSubscription([
        { data: videoLagging.data, type: "media" },
        { data: audioLagging.data, type: "media" },
        { data: videoAhead.data, type: "media" },
        { data: audioAhead.data, type: "media" }
      ]), () => createLiveFrameFeed(writer, testClock, stubLog), null, stubLog);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(proc.stdinWrites.some((buf) => buf.equals(videoLagging.data)), false);
    assert.equal(proc.stdinWrites.some((buf) => buf.equals(audioLagging.data)), false);
    assert.ok(proc.stdinWrites.some((buf) => buf.equals(videoAhead.data)));
    assert.ok(proc.stdinWrites.some((buf) => buf.equals(audioAhead.data)));
  });

  test("clears one track floor while the other track still dedups lagging fragments", async () => {

    const proc = new TestLiveStreamingFfmpegProcess("dedup-partial-clear");
    const videoAhead = makeNonKeyframeFragment(0x31, { baseMediaDecodeTime: 150, sequenceNumber: 9, trackId: 1 });
    const audioLagging = makeNonKeyframeFragment(0x32, { baseMediaDecodeTime: 200, sequenceNumber: 8, trackId: 2 });
    const feedState: LiveTsbFeedState = {

      allowTimeshiftPrefix: false,
      headerWritten: true,
      primeMediaFloor: {

        sequenceNumber: 8,
        trackDecodeTimes: { 1: 100, 2: 200 },
        trackMfhdOnly: {}
      }
    };
    const writer = new BackpressureWriter(() => proc.stdin, { signal: new AbortController().signal });

    await consumeLiveStreamSegments(() => proc as never, feedState,
      makeMediaSubscription([
        { data: videoAhead.data, type: "media" },
        { data: audioLagging.data, type: "media" }
      ]), () => createLiveFrameFeed(writer, testClock, stubLog), null, stubLog);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(feedState.primeMediaFloor?.trackDecodeTimes[1], undefined);
    assert.equal(feedState.primeMediaFloor?.trackDecodeTimes[2], 200);
    assert.ok(proc.stdinWrites.some((buf) => buf.equals(videoAhead.data)));
    assert.equal(proc.stdinWrites.some((buf) => buf.equals(audioLagging.data)), false);
  });

  test("writes fragments for tracks that were not present in the prime buffer", async () => {

    const proc = new TestLiveStreamingFfmpegProcess("dedup-unknown-track");
    const track3 = makeNonKeyframeFragment(0x41, { baseMediaDecodeTime: 50, sequenceNumber: 8, trackId: 3 });
    const feedState: LiveTsbFeedState = {

      allowTimeshiftPrefix: false,
      headerWritten: true,
      primeMediaFloor: {

        sequenceNumber: 8,
        trackDecodeTimes: { 1: 100, 2: 200 },
        trackMfhdOnly: {}
      }
    };
    const writer = new BackpressureWriter(() => proc.stdin, { signal: new AbortController().signal });

    await consumeLiveStreamSegments(() => proc as never, feedState,
      makeMediaSubscription([{ data: track3.data, type: "media" }]), () => createLiveFrameFeed(writer, testClock, stubLog), null, stubLog);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.ok(proc.stdinWrites.some((buf) => buf.equals(track3.data)));
    assert.equal(feedState.primeMediaFloor?.trackDecodeTimes[3], undefined);
  });

  test("records per-traf prime floor from dual-traf moofs in the priming buffer", () => {

    const proc = new TestLiveStreamingFfmpegProcess("prime-dual-traf");
    const init = Buffer.from("init-segment");
    const dual = makeStreamMultiTrafFragment(101, [ { trackId: 1, baseMediaDecodeTime: 900000 }, { trackId: 2 } ]);
    const priming = Buffer.concat([dual]);
    const feedState: LiveTsbFeedState = { allowTimeshiftPrefix: true, headerWritten: false, primeMediaFloor: null };

    primeLiveFfmpegStdinAfterRespawn(feedState, { initSegment: { data: init } } as never, frameFeedFor(proc), priming);

    assert.ok(feedState.primeMediaFloor);
    assert.equal(feedState.primeMediaFloor.trackDecodeTimes[1], 900000);
    assert.equal(feedState.primeMediaFloor.trackMfhdOnly[2], true);
    assert.equal(feedState.primeMediaFloor.trackDecodeTimes[2], undefined);
  });

  test("does not skip audio with tfdt when that track was not primed (dual-traf pairing repro)", async () => {

    const proc = new TestLiveStreamingFfmpegProcess("dedup-dual-traf-repro");
    const feedState: LiveTsbFeedState = {

      allowTimeshiftPrefix: false,
      headerWritten: true,
      primeMediaFloor: {

        sequenceNumber: 101,
        trackDecodeTimes: { 1: 900000 },
        trackMfhdOnly: {}
      }
    };
    const liveAudio = makeStreamMultiTrafFragment(102, [{ trackId: 2, baseMediaDecodeTime: 480000 }], 0x52);
    const writer = new BackpressureWriter(() => proc.stdin, { signal: new AbortController().signal });

    await consumeLiveStreamSegments(() => proc as never, feedState,
      makeMediaSubscription([{ data: liveAudio, type: "media" }]), () => createLiveFrameFeed(writer, testClock, stubLog), null, stubLog);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.ok(proc.stdinWrites.some((buf) => buf.equals(liveAudio)));
  });

  test("still skips mfhd-only lagging after a partial tfdt-ahead clear leaves another track floor", async () => {

    const proc = new TestLiveStreamingFfmpegProcess("dedup-partial-mfhd");
    const aheadVideo = makeNonKeyframeFragment(0x61, { baseMediaDecodeTime: 150, sequenceNumber: 12, trackId: 1 });
    const laggingAudio = makeNonKeyframeFragment(0x62, { baseMediaDecodeTime: 200, sequenceNumber: 10, trackId: 2 });
    const feedState: LiveTsbFeedState = {

      allowTimeshiftPrefix: false,
      headerWritten: true,
      primeMediaFloor: {

        sequenceNumber: 10,
        trackDecodeTimes: { 1: 100, 2: 200 },
        trackMfhdOnly: {}
      }
    };
    const writer = new BackpressureWriter(() => proc.stdin, { signal: new AbortController().signal });

    await consumeLiveStreamSegments(() => proc as never, feedState,
      makeMediaSubscription([
        { data: aheadVideo.data, type: "media" },
        { data: laggingAudio.data, type: "media" }
      ]), () => createLiveFrameFeed(writer, testClock, stubLog), null, stubLog);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(feedState.primeMediaFloor?.trackDecodeTimes[1], undefined);
    assert.equal(feedState.primeMediaFloor?.trackDecodeTimes[2], 200);
    assert.equal(proc.stdinWrites.some((buf) => buf.equals(laggingAudio.data)), false);
  });

  test("P4 does not count skipped moofs toward expiry (r4594912323)", async () => {

    const proc = new TestLiveStreamingFfmpegProcess("dedup-p4-skip-only");
    const floorSeq = 50;
    const feedState: LiveTsbFeedState = {

      allowTimeshiftPrefix: false,
      headerWritten: true,
      primeMediaFloor: livePrimeMediaFloorFromIdentity({ baseMediaDecodeTime: 100, sequenceNumber: floorSeq, trackId: 1 }),
      primeMediaFloorWrittenLiveMoofs: 0
    };
    const writer = new BackpressureWriter(() => proc.stdin, { signal: new AbortController().signal });
    const laggingReplay = makeNonKeyframeFragment(0, {

      baseMediaDecodeTime: 50,
      sequenceNumber: floorSeq,
      trackId: 1
    });
    const skipped = Array.from({ length: 50 }, () => laggingReplay);

    await consumeLiveStreamSegments(() => proc as never, feedState,
      makeMediaSubscription(skipped.map((frag) => ({ data: frag.data, type: "media" as const }))), () => createLiveFrameFeed(writer, testClock, stubLog), null, stubLog);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.ok(feedState.primeMediaFloor);
    assert.equal(proc.stdinWrites.length, 0);
    assert.equal(feedState.primeMediaFloorWrittenLiveMoofs, 0);
  });

  test("prime replay 50 skipped then 5 written keeps dedup until expiry bound (P4)", async () => {

    const proc = new TestLiveStreamingFfmpegProcess("dedup-p4-50plus5");
    const floorSeq = 11;
    const feedState: LiveTsbFeedState = {

      allowTimeshiftPrefix: false,
      headerWritten: true,
      primeMediaFloor: livePrimeMediaFloorFromIdentity({ baseMediaDecodeTime: 1000, sequenceNumber: floorSeq, trackId: 1 }),
      primeMediaFloorWrittenLiveMoofs: 0
    };
    const writer = new BackpressureWriter(() => proc.stdin, { signal: new AbortController().signal });
    const lagging = makeNonKeyframeFragment(0, { baseMediaDecodeTime: 900, sequenceNumber: floorSeq, trackId: 1 });
    const ahead = Array.from({ length: 5 }, (_, idx) => {

      return makeNonKeyframeFragment(idx, {

        baseMediaDecodeTime: 2000 + idx,
        sequenceNumber: floorSeq + 1 + idx,
        trackId: 1
      });
    });
    const segments = [ ...Array.from({ length: 50 }, () => lagging), ...ahead ];

    await consumeLiveStreamSegments(() => proc as never, feedState,
      makeMediaSubscription(segments.map((frag) => ({ data: frag.data, type: "media" as const }))), () => createLiveFrameFeed(writer, testClock, stubLog), null, stubLog);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(proc.stdinWrites.length, 5);
    assert.equal(proc.stdinWrites.some((buf) => buf.equals(lagging.data)), false);
  });

  test("P4 pins literal 100 written moofs before expiry (M14b/M14c)", async () => {

    const P4_WRITTEN_CAP_LITERAL = 100;
    const proc = new TestLiveStreamingFfmpegProcess("dedup-p4-literal-100");
    const feedState: LiveTsbFeedState = {

      allowTimeshiftPrefix: false,
      headerWritten: true,
      primeMediaFloor: { sequenceNumber: 10, trackDecodeTimes: {}, trackMfhdOnly: { 2: true } },
      primeMediaFloorWrittenLiveMoofs: 0
    };
    const writer = new BackpressureWriter(() => proc.stdin, { signal: new AbortController().signal });
    const liveOtherTrack = Array.from({ length: P4_WRITTEN_CAP_LITERAL }, (_, idx) => makeNonKeyframeFragment(idx, {

      baseMediaDecodeTime: 500 + idx,
      sequenceNumber: 20 + idx,
      trackId: 1
    }));

    const liveMedia = liveOtherTrack.map((frag) => ({ data: frag.data, type: "media" as const }));
    const frameFeed = (): Mp4FrameFeed => createLiveFrameFeed(writer, testClock, stubLog);

    await consumeLiveStreamSegments(() => proc as never, feedState, makeMediaSubscription(liveMedia), frameFeed, null, stubLog);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.ok(feedState.primeMediaFloor);
    assert.equal(feedState.primeMediaFloorWrittenLiveMoofs, P4_WRITTEN_CAP_LITERAL);

    const oneMore = makeNonKeyframeFragment(99, { baseMediaDecodeTime: 9999, sequenceNumber: 99, trackId: 1 });

    await consumeLiveStreamSegments(() => proc as never, feedState,
      makeMediaSubscription([{ data: oneMore.data, type: "media" }]), () => createLiveFrameFeed(writer, testClock, stubLog), null, stubLog);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(feedState.primeMediaFloor, null);
  });

  test("P4b fifty lagging video moofs interleaved with fifty unprimed writes keeps zero duplicate video", async () => {

    const proc = new TestLiveStreamingFfmpegProcess("dedup-p4b-interleave");
    const floorSeq = 8;
    const feedState: LiveTsbFeedState = {

      allowTimeshiftPrefix: false,
      headerWritten: true,
      primeMediaFloor: livePrimeMediaFloorFromIdentity({ baseMediaDecodeTime: 1000, sequenceNumber: floorSeq, trackId: 1 }),
      primeMediaFloorWrittenLiveMoofs: 0
    };
    const writer = new BackpressureWriter(() => proc.stdin, { signal: new AbortController().signal });
    const laggingVideo = makeNonKeyframeFragment(0, { baseMediaDecodeTime: 900, sequenceNumber: floorSeq, trackId: 1 });
    const segments: { data: Buffer; type: "media" }[] = [];

    for(let idx = 0; idx < 50; idx++) {

      segments.push({ data: laggingVideo.data, type: "media" });
      segments.push({

        data: makeNonKeyframeFragment(idx, {

          baseMediaDecodeTime: 5000 + idx,
          sequenceNumber: 30 + idx,
          trackId: 2
        }).data,
        type: "media" as const
      });
    }

    await consumeLiveStreamSegments(() => proc as never, feedState,
      makeMediaSubscription(segments), () => createLiveFrameFeed(writer, testClock, stubLog), null, stubLog);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(proc.stdinWrites.some((buf) => buf.equals(laggingVideo.data)), false);
    assert.equal(proc.stdinWrites.length, 50);
    assert.ok(feedState.primeMediaFloor);
  });

  test("drops stale floor when a primed track never appears live (P4 written cap)", async () => {

    const proc = new TestLiveStreamingFfmpegProcess("dedup-p4-never-seen");
    const feedState: LiveTsbFeedState = {

      allowTimeshiftPrefix: false,
      headerWritten: true,
      primeMediaFloor: { sequenceNumber: 10, trackDecodeTimes: {}, trackMfhdOnly: { 2: true } },
      primeMediaFloorWrittenLiveMoofs: 0
    };
    const writer = new BackpressureWriter(() => proc.stdin, { signal: new AbortController().signal });
    const liveOtherTrack = Array.from({ length: 101 }, (_, idx) => makeNonKeyframeFragment(idx, {

      baseMediaDecodeTime: 500 + idx,
      sequenceNumber: 20 + idx,
      trackId: 1
    }));

    const liveMedia = liveOtherTrack.map((frag) => ({ data: frag.data, type: "media" as const }));
    const frameFeed = (): Mp4FrameFeed => createLiveFrameFeed(writer, testClock, stubLog);

    await consumeLiveStreamSegments(() => proc as never, feedState, makeMediaSubscription(liveMedia), frameFeed, null, stubLog);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(feedState.primeMediaFloor, null);
  });

  test("P4 written bound expires after more than max written moofs without clear (M13)", async () => {

    const proc = new TestLiveStreamingFfmpegProcess("dedup-p4-written-cap");
    const feedState: LiveTsbFeedState = {

      allowTimeshiftPrefix: false,
      headerWritten: true,
      primeMediaFloor: { sequenceNumber: 10, trackDecodeTimes: {}, trackMfhdOnly: { 2: true } },
      primeMediaFloorWrittenLiveMoofs: 0
    };
    const writer = new BackpressureWriter(() => proc.stdin, { signal: new AbortController().signal });
    const liveOtherTrack = Array.from({ length: COPY_ESCALATION_PRIME_FLOOR_MAX_WRITTEN_LIVE_MOOF_CHECKS }, (_, idx) => makeNonKeyframeFragment(idx, {

      baseMediaDecodeTime: 500 + idx,
      sequenceNumber: 20 + idx,
      trackId: 1
    }));

    const liveMedia = liveOtherTrack.map((frag) => ({ data: frag.data, type: "media" as const }));
    const frameFeed = (): Mp4FrameFeed => createLiveFrameFeed(writer, testClock, stubLog);

    await consumeLiveStreamSegments(() => proc as never, feedState, makeMediaSubscription(liveMedia), frameFeed, null, stubLog);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.ok(feedState.primeMediaFloor);

    const oneMore = makeNonKeyframeFragment(99, { baseMediaDecodeTime: 9999, sequenceNumber: 99, trackId: 1 });

    await consumeLiveStreamSegments(() => proc as never, feedState, makeMediaSubscription([{ data: oneMore.data, type: "media" }]), frameFeed, null, stubLog);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(feedState.primeMediaFloor, null);
  });

  test("resets written-moof counter when the prime floor empties on clear (M16)", async () => {

    const proc = new TestLiveStreamingFfmpegProcess("dedup-p4-counter-reset");
    const floor = parsePrimeMediaFloorFromPrimingBuffer(makeStreamMultiTrafFragment(10, [{ trackId: 1 }]));

    assert.ok(floor);
    const feedState: LiveTsbFeedState = {

      allowTimeshiftPrefix: false,
      headerWritten: true,
      primeMediaFloor: floor,
      primeMediaFloorWrittenLiveMoofs: 50
    };
    const writer = new BackpressureWriter(() => proc.stdin, { signal: new AbortController().signal });
    const ahead = makeStreamMultiTrafFragment(11, [{ trackId: 1 }]);

    await consumeLiveStreamSegments(() => proc as never, feedState,
      makeMediaSubscription([{ data: ahead, type: "media" }]), () => createLiveFrameFeed(writer, testClock, stubLog), null, stubLog);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(feedState.primeMediaFloor, null);
    assert.equal(feedState.primeMediaFloorWrittenLiveMoofs, undefined);
  });
});
