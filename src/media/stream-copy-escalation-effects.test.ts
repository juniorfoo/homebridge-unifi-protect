/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-copy-escalation-effects.test.ts: Effect-level coverage of in-session copy-to-transcode replacement (spawn-free).
 */
/* eslint-disable camelcase, no-restricted-syntax, sort-imports, sort-keys, @stylistic/max-len -- effect harness mirrors HomeKit request shapes and dense spawn closures */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FfmpegOptions, FfmpegStreamingProcess, HomebridgePluginLogging } from "homebridge-plugin-utils";
import { BackpressureWriter, H264Level, H264Profile, HbpuAbortError, isHbpuAbortReason } from "homebridge-plugin-utils";
import type { CopyEscalationSessionDiagnostics, StreamLiveEncodeRebuild } from "./stream-copy-escalation.ts";
import { replaceFailedCopyWithTranscode } from "./stream-copy-escalation.ts";
import type { LiveTsbFeedState } from "./stream-live-feed.ts";
import { consumeLiveStreamSegments, createLiveFrameFeed, createTsbSegmentWriterRail } from "./stream-live-feed.ts";
import type { LiveVideoFfmpegSpawnContext, LiveVideoFfmpegSpawner } from "./stream-live-ffmpeg-spawn.ts";
import { setLiveVideoFfmpegSpawnerForTests } from "./stream-live-ffmpeg-spawn.ts";
import type { ProtectStreamingFfmpegProcess } from "./stream-ffmpeg-process.ts";
import type { ChannelProfile } from "./resolution.ts";
import { shouldRemoveOngoingSessionEntry, shouldRemovePendingSessionEntry } from "./stream-transcode-policy.ts";
import type { LivestreamSubscription } from "./livestream.ts";
import { TestClock } from "homebridge-plugin-utils/testing";
import { TestLiveStreamingFfmpegProcess } from "./test-live-ffmpeg-process.ts";

const testClock = new TestClock(0);

async function drainBackpressureWrites(): Promise<void> {

  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const INIT = Buffer.from("fmp4-init");
const MEDIA_A = Buffer.from("media-a");
const MEDIA_B = Buffer.from("media-b");
const MEDIA_C = Buffer.from("media-c");

const stubChannel = {

  channel: { bitrate: 4000000, fps: 15, height: 1080, id: 0, width: 1920 },
  name: "high",
  url: "rtsps://stub/high"
} as ChannelProfile;

const stubLog: HomebridgePluginLogging = {

  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined
};

function makeSubscription(segments: { data: Buffer; discontinuity?: boolean; type: "init" | "media" }[], signal?: AbortSignal): LivestreamSubscription &
  { disposeCalls: number } {

  let disposeCalls = 0;

  const sub = {

    disposeCalls: 0,
    initSegment: { data: INIT },
    async *[Symbol.asyncIterator](): AsyncGenerator<(typeof segments)[number], void, undefined> {

      for(const segment of segments) {

        yield segment;
      }
    },
    async [Symbol.asyncDispose](): Promise<void> {

      disposeCalls += 1;
      (sub as { disposeCalls: number }).disposeCalls = disposeCalls;
    },
    async whenEstablished(): Promise<boolean> {

      return true;
    }
  };

  if(signal) {

    signal.addEventListener("abort", () => void sub[Symbol.asyncDispose](), { once: true });
  }

  return sub as unknown as LivestreamSubscription & { disposeCalls: number };
}

function spawnedAt(spawned: TestLiveStreamingFfmpegProcess[], index: number): TestLiveStreamingFfmpegProcess {

  const proc = spawned[index];

  assert.ok(proc);

  return proc;
}

function castProtect(process: TestLiveStreamingFfmpegProcess): ProtectStreamingFfmpegProcess {

  return process as unknown as ProtectStreamingFfmpegProcess;
}

function makeDiagnostics(sessionInfo: SessionInfoStub): CopyEscalationSessionDiagnostics & { liveEncodeRebuild: StreamLiveEncodeRebuild } {

  return {

    escalatedFromCopy: false,
    hardwareTranscode: false,
    liveEncodeRebuild: {

      channelProfile: stubChannel,
      ffmpegArgsThroughVideoMap: [ "-f", "mp4", "-i", "pipe:0" ],
      isHighLatency: false,
      request: {

        audio: { channel: 1, max_bit_rate: 64, pt: 110, sample_rate: 16, type: 0 },
        sessionID: "sess-1",
        video: { fps: 15, height: 1080, level: H264Level.LEVEL3_1, max_bit_rate: 800, profile: H264Profile.MAIN, pt: 96, type: 0, width: 1920 }
      } as unknown as StreamLiveEncodeRebuild["request"],
      sessionInfo: sessionInfo,
      transcodeTargetBitrate: 800,
      useInterpolationFilter: false,
      useTsb: true
    },
    profile: stubChannel.name,
    transcode: false,
    videoCopy: true
  };
}

interface SessionInfoStub {

  abortController: AbortController;
  addressVersion: "ipv4";
  hasAudioSupport: boolean;
  videoReturnPort: number;
}

function makeWriterRail(sessionInfo: SessionInfoStub, getActive: () => TestLiveStreamingFfmpegProcess,
  init?: ConstructorParameters<typeof BackpressureWriter>[1]): {

  current: BackpressureWriter;
  getFrameFeed: () => ReturnType<typeof createTsbSegmentWriterRail>["getFrameFeed"] extends () => infer R ? R : never;
  getSegmentWriter: () => BackpressureWriter;
  rotateSegmentWriter: (replacement: FfmpegStreamingProcess) => BackpressureWriter;
} {

  const rail = createTsbSegmentWriterRail({

    clock: testClock,
    getStdin: () => castProtect(getActive()).stdin,
    log: stubLog,
    signal: sessionInfo.abortController.signal,
    writerInit: init
  });

  return {

    get current(): BackpressureWriter {

      return rail.getSegmentWriter();
    },

    getFrameFeed: () => rail.getFrameFeed(),

    getSegmentWriter: (): BackpressureWriter => rail.getSegmentWriter(),

    rotateSegmentWriter: (replacement: FfmpegStreamingProcess): BackpressureWriter => rail.rotateSegmentWriter(replacement)
  };
}

function makeHarness(spawned: TestLiveStreamingFfmpegProcess[]): LiveVideoFfmpegSpawner {

  const spawner: LiveVideoFfmpegSpawner = (_options: FfmpegOptions, init) => {

    const id = `ffmpeg-${String(spawned.length + 1)}`;
    const process = new TestLiveStreamingFfmpegProcess(id, { returnPort: init.returnPort, signal: init.signal });

    spawned.push(process);

    return castProtect(process);
  };

  return spawner;
}

describe("copy-to-transcode replacement effects", () => {

  before(() => {

    setLiveVideoFfmpegSpawnerForTests(undefined);
  });

  after(() => {

    setLiveVideoFfmpegSpawnerForTests(undefined);
  });

  test("queue rebinding: post-escalation segments reach only the replacement; copy aborts once", async () => {

    const spawned: TestLiveStreamingFfmpegProcess[] = [];
    const copy = new TestLiveStreamingFfmpegProcess("copy");
    const sessionInfo: SessionInfoStub = { abortController: new AbortController(), addressVersion: "ipv4", hasAudioSupport: false, videoReturnPort: 51000 };
    const owner = makeDiagnostics(sessionInfo);
    const sessionId = "sess-1";
    const ongoingSessions = new Map([[ sessionId, { abortController: sessionInfo.abortController, ffmpeg: [castProtect(copy)] } ]]);
    const pendingSessions = new Map<string, SessionInfoStub>();
    const diagnosticsById = new Map([[ sessionId, owner ]]);

    let active: TestLiveStreamingFfmpegProcess = copy;

    const feedState: LiveTsbFeedState = { allowTimeshiftPrefix: false, headerWritten: true, primeMediaFloor: null };
    const subscription = makeSubscription([ { data: MEDIA_A, type: "media" }, { data: MEDIA_B, type: "media" } ], sessionInfo.abortController.signal);
    const writerRail = makeWriterRail(sessionInfo, () => active);

    await replaceFailedCopyWithTranscode({

      hardwareTranscodes: false,
      log: stubLog,
      onRespawned: () => {

        active = spawnedAt(spawned, 0);
      },
      ongoingSessions: ongoingSessions,
      owner: owner,
      pendingSessions: pendingSessions,
      prior: castProtect(copy),
      sessionDiagnosticsById: diagnosticsById,
      sessionId: sessionId,
      spawnLiveVideo: (_ctx: LiveVideoFfmpegSpawnContext, ffmpegAbort) => makeHarness(spawned)({} as FfmpegOptions, {

        onProbesizeError: () => undefined,
        returnPort: { ipFamily: "ipv4", port: sessionInfo.videoReturnPort + spawned.length },
        signal: ffmpegAbort.signal,
        suppressLivestreamApiErrors: true
      }),
      transcodeTargetBitrate: 800,
      transcodeReason: "copy failed",
      tsbResume: { feedState: feedState, keyframePrimingBuffer: null, rotateSegmentWriter: writerRail.rotateSegmentWriter, subscription: subscription }
    });

    assert.ok(active !== copy);

    await consumeLiveStreamSegments(() => castProtect(active), feedState, subscription, writerRail.getFrameFeed(), null, stubLog);
    await drainBackpressureWrites();

    assert.equal(copy.abortCalls.length, 1);
    const replacement = spawnedAt(spawned, 0);

    assert.equal(copy.stdinWrites.length, 0, "copy must not receive segments after rebinding");
    assert.ok(replacement.stdinWrites[0]);
    assert.equal(replacement.stdinWrites[0].compare(INIT), 0, "primed init on replacement");
    assert.ok(replacement.stdinWrites.some((buf) => buf.compare(MEDIA_A) === 0));
    assert.ok(replacement.stdinWrites.some((buf) => buf.compare(MEDIA_B) === 0));
  });

  test("fMP4 ordering: init is primed on respawn and again before media when segments arrive during replacement", async () => {

    const copy = new TestLiveStreamingFfmpegProcess("copy");
    const sessionInfo: SessionInfoStub = { abortController: new AbortController(), addressVersion: "ipv4", hasAudioSupport: false, videoReturnPort: 52000 };
    const owner = makeDiagnostics(sessionInfo);
    const feedState: LiveTsbFeedState = { allowTimeshiftPrefix: false, headerWritten: true, primeMediaFloor: null };
    const subscription = makeSubscription([{ data: MEDIA_C, type: "media" }]);
    let active: TestLiveStreamingFfmpegProcess = copy;
    const writerRail = makeWriterRail(sessionInfo, () => active);

    copy.stdinWrites.push(MEDIA_A);

    const spawned: TestLiveStreamingFfmpegProcess[] = [];

    await replaceFailedCopyWithTranscode({

      hardwareTranscodes: false,
      log: stubLog,
      onRespawned: () => {

        active = spawnedAt(spawned, 0);
      },
      ongoingSessions: new Map([[ "sess-1", { abortController: sessionInfo.abortController, ffmpeg: [castProtect(copy)] } ]]),
      owner: owner,
      pendingSessions: new Map(),
      prior: castProtect(copy),
      sessionDiagnosticsById: new Map([[ "sess-1", owner ]]),
      sessionId: "sess-1",
      spawnLiveVideo: (_ctx, ffmpegAbort) => makeHarness(spawned)({} as FfmpegOptions, {

        onProbesizeError: () => undefined,
        signal: ffmpegAbort.signal,
        suppressLivestreamApiErrors: true
      }),
      transcodeTargetBitrate: 800,
      transcodeReason: "copy failed",
      tsbResume: { feedState: feedState, keyframePrimingBuffer: null, rotateSegmentWriter: writerRail.rotateSegmentWriter, subscription: subscription }
    });

    await drainBackpressureWrites();

    feedState.headerWritten = false;
    const replacement = spawnedAt(spawned, 0);

    await consumeLiveStreamSegments(() => castProtect(replacement), feedState, subscription, writerRail.getFrameFeed(), null, stubLog);
    await drainBackpressureWrites();

    assert.ok(replacement.stdinWrites[0]);
    assert.equal(replacement.stdinWrites[0].compare(INIT), 0);
    const firstMediaIndex = replacement.stdinWrites.findIndex((buf) => buf.compare(MEDIA_C) === 0);

    assert.ok(firstMediaIndex > 0);
  });

  test("RTP cleanup: copy return-port socket is released; STOP tears down replacement and subscription once", async () => {

    const spawned: TestLiveStreamingFfmpegProcess[] = [];
    const copy = new TestLiveStreamingFfmpegProcess("copy", { returnPort: { ipFamily: "ipv4", port: 53000 } });
    const sessionInfo: SessionInfoStub = { abortController: new AbortController(), addressVersion: "ipv4", hasAudioSupport: false, videoReturnPort: 53001 };
    const owner = makeDiagnostics(sessionInfo);
    const sessionId = "sess-1";
    const subscription = makeSubscription([], sessionInfo.abortController.signal);
    const ongoing = { abortController: sessionInfo.abortController, ffmpeg: [castProtect(copy)] };
    const ongoingSessions = new Map([[ sessionId, ongoing ]]);

    const replacement = await replaceFailedCopyWithTranscode({

      hardwareTranscodes: false,
      log: stubLog,
      onRespawned: (proc) => {

        ongoing.ffmpeg[0] = proc as unknown as typeof ongoing.ffmpeg[number];
      },
      ongoingSessions: ongoingSessions,
      owner: owner,
      pendingSessions: new Map(),
      prior: castProtect(copy),
      sessionDiagnosticsById: new Map([[ sessionId, owner ]]),
      sessionId: sessionId,
      spawnLiveVideo: (_ctx, ffmpegAbort) => makeHarness(spawned)({} as FfmpegOptions, {

        onProbesizeError: () => undefined,
        returnPort: { ipFamily: "ipv4", port: sessionInfo.videoReturnPort },
        signal: ffmpegAbort.signal,
        suppressLivestreamApiErrors: true
      }),
      transcodeTargetBitrate: 800,
      transcodeReason: "copy failed"
    });

    assert.ok(copy.returnPortClosed);
    const spawnedReplacement = spawnedAt(spawned, 0);

    assert.equal(spawnedReplacement.returnPortClosed, false);

    const stopTarget = ongoingSessions.get(sessionId);

    assert.ok(stopTarget);
    stopTarget.abortController.abort(new HbpuAbortError("shutdown"));

    if(shouldRemoveOngoingSessionEntry(ongoingSessions.get(sessionId), stopTarget)) {

      ongoingSessions.delete(sessionId);
    }

    await drainBackpressureWrites();

    assert.equal(copy.abortCalls.filter((reason) => isHbpuAbortReason(reason, "replaced")).length, 1);
    assert.ok(replacement);
    assert.ok(spawnedReplacement.signal.aborted, "replacement FFmpeg aborts when the session controller shuts down");
    assert.equal(subscription.disposeCalls, 1);
    assert.equal(ongoingSessions.has(sessionId), false);
  });

  test("establishment escalation: synthesizes ongoing from pending without clobbering a replacement", async () => {

    const copy = new TestLiveStreamingFfmpegProcess("copy");
    const pendingController = new AbortController();
    const replacementController = new AbortController();
    const pendingSession: SessionInfoStub = { abortController: pendingController, addressVersion: "ipv4", hasAudioSupport: false, videoReturnPort: 54000 };
    const owner = makeDiagnostics(pendingSession);
    const sessionId = "homekit-1";
    const pendingSessions = new Map([[ sessionId, pendingSession ]]);
    const ongoingSessions = new Map([[ sessionId, { abortController: replacementController, ffmpeg: [castProtect(new TestLiveStreamingFfmpegProcess("replacement"))] } ]]);
    const spawned: TestLiveStreamingFfmpegProcess[] = [];

    const result = await replaceFailedCopyWithTranscode({

      hardwareTranscodes: false,
      log: stubLog,
      onRespawned: () => undefined,
      ongoingSessions: ongoingSessions,
      owner: owner,
      pendingSessions: pendingSessions,
      prior: castProtect(copy),
      sessionDiagnosticsById: new Map([[ sessionId, owner ]]),
      sessionId: sessionId,
      spawnLiveVideo: (_ctx, ffmpegAbort) => makeHarness(spawned)({} as FfmpegOptions, {

        onProbesizeError: () => undefined,
        signal: ffmpegAbort.signal,
        suppressLivestreamApiErrors: true
      }),
      transcodeTargetBitrate: 800,
      transcodeReason: "copy failed"
    });

    assert.equal(result, null);
    assert.equal(spawned.length, 0);
    assert.equal(ongoingSessions.get(sessionId)?.abortController, replacementController);
  });

  test("session id reuse: stale escalation does not delete replacement maps; STOP releases replacement", async () => {

    const staleCopy = new TestLiveStreamingFfmpegProcess("stale");
    const replacement = new TestLiveStreamingFfmpegProcess("replacement");
    const staleSession: SessionInfoStub = { abortController: new AbortController(), addressVersion: "ipv4", hasAudioSupport: false, videoReturnPort: 55000 };
    const replacementSession: SessionInfoStub = { abortController: new AbortController(), addressVersion: "ipv4", hasAudioSupport: false, videoReturnPort: 55001 };
    const staleOwner = makeDiagnostics(staleSession);
    const sessionId = "sess";
    const pending = new Map([[ sessionId, replacementSession ]]);
    const ongoing = new Map([[ sessionId, { abortController: replacementSession.abortController, ffmpeg: [castProtect(replacement)] } ]]);
    const spawned: TestLiveStreamingFfmpegProcess[] = [];

    const staleResult = await replaceFailedCopyWithTranscode({

      hardwareTranscodes: false,
      log: stubLog,
      onRespawned: () => undefined,
      ongoingSessions: ongoing,
      owner: staleOwner,
      pendingSessions: pending,
      prior: castProtect(staleCopy),
      sessionDiagnosticsById: new Map([[ sessionId, staleOwner ]]),
      sessionId: sessionId,
      spawnLiveVideo: (_ctx, ffmpegAbort) => makeHarness(spawned)({} as FfmpegOptions, {

        onProbesizeError: () => undefined,
        signal: ffmpegAbort.signal,
        suppressLivestreamApiErrors: true
      }),
      transcodeTargetBitrate: 800,
      transcodeReason: "stale"
    });

    assert.equal(staleResult, null);

    if(shouldRemovePendingSessionEntry(pending.get(sessionId), staleSession)) {

      pending.delete(sessionId);
    }

    if(shouldRemoveOngoingSessionEntry(ongoing.get(sessionId), { abortController: staleSession.abortController })) {

      ongoing.delete(sessionId);
    }

    assert.equal(pending.get(sessionId), replacementSession);
    assert.equal(ongoing.get(sessionId)?.ffmpeg[0], castProtect(replacement));

    const stopEntry = ongoing.get(sessionId);

    assert.ok(stopEntry);
    stopEntry.abortController.abort(new HbpuAbortError("shutdown"));
    replacement.abort(new HbpuAbortError("shutdown"));

    if(shouldRemoveOngoingSessionEntry(ongoing.get(sessionId), stopEntry)) {

      ongoing.delete(sessionId);
    }

    assert.equal(ongoing.has(sessionId), false);
    assert.equal(replacement.abortCalls.length, 1);
  });

  test("backpressure: dead copy stdin poisons the writer; rotation delivers init then live media to the replacement", async () => {

    const copy = new TestLiveStreamingFfmpegProcess("copy", { blockStdin: true });
    const sessionInfo: SessionInfoStub = { abortController: new AbortController(), addressVersion: "ipv4", hasAudioSupport: false, videoReturnPort: 56000 };
    const owner = makeDiagnostics(sessionInfo);
    const feedState: LiveTsbFeedState = { allowTimeshiftPrefix: false, headerWritten: true, primeMediaFloor: null };
    const subscription = makeSubscription([], sessionInfo.abortController.signal);
    const spawned: TestLiveStreamingFfmpegProcess[] = [];
    let active: TestLiveStreamingFfmpegProcess = copy;
    const writerRail = makeWriterRail(sessionInfo, () => active, { highWaterMark: 8 });

    const poisonedWriter = writerRail.current;
    const staleWrite = poisonedWriter.write(MEDIA_A);

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(copy.deferredStdinCallbacks.length, 1);

    void poisonedWriter.write(MEDIA_B).catch((error: unknown) => error);

    for(let spins = 0; (spins < 20) && (poisonedWriter.pending < 2); spins += 1) {

      // eslint-disable-next-line no-await-in-loop -- poll until the second write is queued behind the blocked drain
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    assert.equal(poisonedWriter.pending, 2);
    copy.terminateStdinLikeProcessExit();

    await assert.rejects(staleWrite);
    assert.ok(poisonedWriter.signal.aborted);

    let writerAfter: BackpressureWriter | undefined;

    await replaceFailedCopyWithTranscode({

      hardwareTranscodes: false,
      log: stubLog,
      onRespawned: () => {

        active = spawnedAt(spawned, 0);
      },
      ongoingSessions: new Map([[ "sess-1", { abortController: sessionInfo.abortController, ffmpeg: [castProtect(copy)] } ]]),
      owner: owner,
      pendingSessions: new Map(),
      prior: castProtect(copy),
      sessionDiagnosticsById: new Map([[ "sess-1", owner ]]),
      sessionId: "sess-1",
      spawnLiveVideo: (_ctx, ffmpegAbort) => makeHarness(spawned)({} as FfmpegOptions, {

        onProbesizeError: () => undefined,
        signal: ffmpegAbort.signal,
        suppressLivestreamApiErrors: true
      }),
      transcodeTargetBitrate: 800,
      transcodeReason: "copy failed",
      tsbResume: {

        feedState: feedState,
        keyframePrimingBuffer: null,
        rotateSegmentWriter: (replacement) => {

          writerAfter = writerRail.rotateSegmentWriter(replacement);

          return writerAfter;
        },
        subscription: subscription
      }
    });

    assert.ok(writerAfter);
    assert.ok(!writerAfter.signal.aborted);
    await drainBackpressureWrites();

    const replacement = spawnedAt(spawned, 0);
    const liveWriter = writerAfter;

    assert.ok(replacement.stdinWrites[0]);
    assert.equal(replacement.stdinWrites[0].compare(INIT), 0);
    assert.ok(!replacement.stdinWrites.some((buf) => buf.compare(MEDIA_B) === 0));

    await consumeLiveStreamSegments(() => castProtect(replacement), feedState, makeSubscription([{ data: MEDIA_C, type: "media" }]),
      createLiveFrameFeed(liveWriter, testClock, stubLog), null, stubLog);
    await drainBackpressureWrites();

    assert.ok(replacement.stdinWrites.some((buf) => buf.compare(MEDIA_C) === 0));
    assert.equal(poisonedWriter.pending, 0);
    assert.equal(copy.deferredStdinCallbacks.length, 0);
  });

  test("backpressure: STOP during blocked copy stdin write tears down writer and subscription once", async () => {

    const sessionInfo: SessionInfoStub = { abortController: new AbortController(), addressVersion: "ipv4", hasAudioSupport: false, videoReturnPort: 57000 };
    const copy = new TestLiveStreamingFfmpegProcess("copy", { blockStdin: true, pipeBreakOnTeardown: false, returnPort: { ipFamily: "ipv4", port: 57000 } });
    const subscription = makeSubscription([], sessionInfo.abortController.signal);
    const segmentWriter = new BackpressureWriter(() => castProtect(copy).stdin, { signal: sessionInfo.abortController.signal });

    const blockedWrite = segmentWriter.write(MEDIA_A);

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(copy.deferredStdinCallbacks.length, 1);

    sessionInfo.abortController.abort(new HbpuAbortError("shutdown"));

    await assert.rejects(blockedWrite, (e: unknown) => {

      assert.ok(isHbpuAbortReason(e, "shutdown"), "blocked write must reject with shutdown abort reason");

      return true;
    });
    await drainBackpressureWrites();

    copy.abort(sessionInfo.abortController.signal.reason);

    assert.ok(segmentWriter.signal.aborted);
    assert.equal(copy.deferredStdinCallbacks.length, 0);
    assert.equal(subscription.disposeCalls, 1);
    assert.equal(copy.stdin.listenerCount("drain"), 0);
  });

});
