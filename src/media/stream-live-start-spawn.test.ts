/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-live-start-spawn.test.ts: startStream encode + spawn-hook coverage (mutation-sensitive wiring).
 */
/* eslint-disable sort-imports */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { StartStreamRequest } from "homebridge";
import type { FfmpegOptions } from "homebridge-plugin-utils";
import { FfmpegOptions as FfmpegOptionsImpl, H264Level, H264Profile } from "homebridge-plugin-utils";
/* eslint-disable camelcase -- HomeKit StartStreamRequest wire field names */
import { makeTestCameraHost } from "./testing.helpers.ts";
import type { TestCameraHost } from "./testing.helpers.ts";
import { appendLiveVideoEncodeToFfmpegArgs, resolveStartStreamEncodePlan, resolveStartStreamForceTranscodeDueToUserOption } from "./stream-live-wiring.ts";
import type { ChannelProfile } from "./resolution.ts";
import { setLiveVideoFfmpegSpawnerForTests, spawnLiveVideoFfmpegProcess } from "./stream-live-ffmpeg-spawn.ts";
import { TestLiveStreamingFfmpegProcess } from "./test-live-ffmpeg-process.ts";
import type { ProtectStreamingFfmpegProcess } from "./stream-ffmpeg-process.ts";
import { replaceFailedCopyWithTranscode } from "./stream-copy-escalation.ts";
import { createTsbSegmentWriterRail } from "./stream-live-feed.ts";
import { createCopyEscalationTsbResume } from "./stream-live-wiring.ts";
import type { HomebridgePluginLogging } from "homebridge-plugin-utils";

const stubChannel: ChannelProfile = {

  channel: { bitrate: 4_000_000, fps: 15, height: 720, id: 1, name: "medium", width: 1280 },
  name: "medium"
} as ChannelProfile;

const stubLog: HomebridgePluginLogging = {

  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined
};

function makeRequest(): StartStreamRequest {

  return {

    audio: { channel: 1, max_bit_rate: 64, packet_time: 20, pt: 110, sample_rate: 16, type: 0 },
    sessionID: "sess-start-spawn",
    video: { fps: 15, height: 720, level: H264Level.LEVEL3_1, max_bit_rate: 800, profile: H264Profile.MAIN, pt: 96, type: 0, width: 1280 }
  } as unknown as StartStreamRequest;
}

function testCameraHost(): TestCameraHost {

  return makeTestCameraHost().host;
}

function stubFfmpegOptions(): FfmpegOptions {

  return new FfmpegOptionsImpl({

    codecSupport: { cpuGeneration: 0, hostSystem: "test" } as never,
    crop: undefined,
    debug: false,
    hardwareDecoding: false,
    hardwareTranscoding: false,
    log: stubLog,
    name: (): string => "stub-camera"
  });
}

describe("startStream spawn hook", () => {

  before(() => {

    setLiveVideoFfmpegSpawnerForTests(undefined);
  });

  after(() => {

    setLiveVideoFfmpegSpawnerForTests(undefined);
  });

  test("Video.Transcode forces transcode args through the production spawn injector", () => {

    const camera = testCameraHost();

    camera.hasFeature = (option) => option === "Video.Transcode";

    const force = resolveStartStreamForceTranscodeDueToUserOption(camera, false);
    const plan = resolveStartStreamEncodePlan({ channelProfile: stubChannel, ffmpegOptions: stubFfmpegOptions(), fmp4InitSegmentData: null,
      forceTranscodeDueToUserOption: force, isHighLatency: false, preferCopyChannel: !force, protectCamera: camera, request: makeRequest(),
      sessionSource: "buffer", useTsb: true });

    assert.equal(plan.isTranscoding, true);

    const args = [ "-map", "0:v:0" ];

    appendLiveVideoEncodeToFfmpegArgs(stubFfmpegOptions(), args, plan.encodeDecision, stubChannel, makeRequest(), plan.encoderBitrate, false, true);

    assert.ok(!args.includes("copy"), "transcode path must not use -codec:v copy");
    assert.ok((args.some((part) => part.includes("libx264"))) || (args.includes("-c:v")), "transcode encoder args must be present");

    const spawnedArgs: string[][] = [];

    setLiveVideoFfmpegSpawnerForTests((_options, init) => {

      spawnedArgs.push(init.args ?? []);

      return new TestLiveStreamingFfmpegProcess("transcode-spawn") as unknown as ProtectStreamingFfmpegProcess;
    });

    spawnLiveVideoFfmpegProcess(stubFfmpegOptions(), {

      args: args,
      onProbesizeError: () => undefined,
      signal: new AbortController().signal,
      suppressLivestreamApiErrors: true
    });

    assert.equal(spawnedArgs.length, 1);
    assert.ok(spawnedArgs[0]);
    assert.ok(!spawnedArgs[0].includes("copy"));
  });

  test("direct RTSP (unknown declared level) forces transcode through startStream initial encode", () => {

    const camera = testCameraHost();
    const plan = resolveStartStreamEncodePlan({ channelProfile: stubChannel, ffmpegOptions: stubFfmpegOptions(), fmp4InitSegmentData: null,
      forceTranscodeDueToUserOption: false, isHighLatency: false, preferCopyChannel: true, protectCamera: camera, request: makeRequest(),
      sessionSource: "rtsp", useTsb: false });

    assert.equal(plan.isTranscoding, true);
    assert.match(plan.encodeDecision.logReason ?? "", /declared|unknown/i);
  });

  test("copy failure escalation via spawn hook delivers init on the replacement writer", async () => {

    const INIT = Buffer.from("fmp4-init");
    const MEDIA = Buffer.from("media-segment");
    const copy = new TestLiveStreamingFfmpegProcess("copy");
    const sessionInfo = { abortController: new AbortController(), addressVersion: "ipv4" as const, hasAudioSupport: false, videoReturnPort: 60_000 };
    const spawned: TestLiveStreamingFfmpegProcess[] = [];
    let active: TestLiveStreamingFfmpegProcess = copy;
    const rail = createTsbSegmentWriterRail({ getStdin: () => copy.stdin, signal: sessionInfo.abortController.signal });
    const subscription = {

      disposeCalls: 0,
      initSegment: { data: INIT },
      async *[Symbol.asyncIterator]() {

        yield { data: MEDIA, type: "media" as const };
      },
      async [Symbol.asyncDispose]() {

        (subscription as { disposeCalls: number }).disposeCalls += 1;
      },
      async whenEstablished() {

        return true;
      }
    };

    setLiveVideoFfmpegSpawnerForTests((_options, init) => {

      const proc = new TestLiveStreamingFfmpegProcess("replacement-via-hook", { signal: init.signal });

      spawned.push(proc);

      return proc as unknown as ProtectStreamingFfmpegProcess;
    });

    const owner = {

      escalatedFromCopy: false,
      hardwareTranscode: false,
      liveEncodeRebuild: {

        channelProfile: stubChannel,
        ffmpegArgsThroughVideoMap: [ "-f", "mp4", "-i", "pipe:0" ],
        isHighLatency: false,
        request: makeRequest(),
        sessionInfo: sessionInfo,
        transcodeTargetBitrate: 800,
        useInterpolationFilter: false,
        useTsb: true
      },
      profile: stubChannel.name,
      transcode: false,
      videoCopy: true
    };

    await replaceFailedCopyWithTranscode({

      hardwareTranscodes: false,
      log: stubLog,
      onRespawned: (proc) => {

        active = proc as unknown as TestLiveStreamingFfmpegProcess;
      },
      ongoingSessions: new Map([[ "sess-1", { abortController: sessionInfo.abortController, ffmpeg: [copy as never] } ]]),
      owner: owner,
      pendingSessions: new Map(),
      prior: copy as unknown as ProtectStreamingFfmpegProcess,
      sessionDiagnosticsById: new Map([[ "sess-1", owner ]]),
      sessionId: "sess-1",
      spawnLiveVideo: (ctx, ffmpegAbort) => spawnLiveVideoFfmpegProcess(stubFfmpegOptions(), {

        args: [ ...ctx.ffmpegArgsThroughVideoMap, "-codec:v", "libx264" ],
        onProbesizeError: () => undefined,
        signal: ffmpegAbort.signal,
        suppressLivestreamApiErrors: ctx.useTsb
      }),
      transcodeReason: "copy failed",
      transcodeTargetBitrate: 800,
      tsbResume: createCopyEscalationTsbResume({

        feedState: { allowTimeshiftPrefix: false, headerWritten: true, primeMediaFloor: null },
        rail: rail,
        subscription: subscription as never
      })
    });

    assert.equal(spawned.length, 1);
    const writer = rail.rotateSegmentWriter(active as never);

    await writer.write(INIT);
    await writer.write(MEDIA);

    assert.ok(active.stdinWrites[0]);
    assert.equal(active.stdinWrites[0].compare(INIT), 0);
  });
});
