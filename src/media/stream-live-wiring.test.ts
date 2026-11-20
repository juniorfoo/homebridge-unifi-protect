/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 */
/* eslint-disable camelcase, sort-imports */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { H264Level, H264Profile } from "homebridge-plugin-utils";
import type { StartStreamRequest } from "homebridge";
import { makeTestCameraHost } from "./testing.helpers.ts";
import type { TestCameraHost } from "./testing.helpers.ts";
import { createTsbSegmentWriterRail } from "./stream-live-feed.ts";
import type { BackpressureWriter } from "homebridge-plugin-utils";
import type { ProtectStreamingFfmpegProcess } from "./stream-ffmpeg-process.ts";
import { TestLiveStreamingFfmpegProcess } from "./test-live-ffmpeg-process.ts";
import { FfmpegOptions as FfmpegOptionsImpl } from "homebridge-plugin-utils";
import type { FfmpegOptions } from "homebridge-plugin-utils";
import { resolveStreamOutputFps } from "./stream-transcode-policy.ts";
import { appendLiveVideoEncodeToFfmpegArgs, buildLiveVideoEncodeInput, createCopyEscalationTsbResume, createLiveFfmpegCopyExitBridge,
  refreshBufferBackedChannelProfileForEncode, resolveCopyEscalationKeyframePrimingBuffer, resolveFmp4InitForLiveDeclaredCheck, resolveStartStreamEncodePlan,
  resolveStartStreamForceTranscodeDueToUserOption, resolveStreamEgressBitrateBps, resolveTimeshiftBufferLiveChannel,
  shouldSubstituteSelectChannelForSession } from "./stream-live-wiring.ts";
import type { LiveVideoEncodeDecision } from "./stream-transcode-policy.ts";
import type { ChannelProfile } from "./resolution.ts";
import { parseH264AvcCFromFmp4Init } from "./h264-fmp4-avcc.ts";
import { TEST_H264_MAIN_PPS, testH264SpsForProfileLevel } from "./h264-test-bytes.ts";
import { makeChannel } from "../camera.fixtures.ts";
import { HOMEKIT_IDR_INTERVAL } from "homebridge-plugin-utils";
import { resolveVideoCopyExitBridgeAction } from "./stream-transcode-policy.ts";

const stubChannel: ChannelProfile = {

  channel: { bitrate: 4_000_000, fps: 15, height: 720, id: 1, name: "medium", width: 1280 },
  name: "medium"
} as ChannelProfile;

function writeBox(type: string, payload: Buffer): Buffer {

  const header = Buffer.alloc(8);

  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4);

  return Buffer.concat([ header, payload ]);
}

function buildFmp4Init(profileIdc: number, levelIdc: number): Buffer {

  const sps = testH264SpsForProfileLevel(profileIdc, levelIdc);
  const pps = TEST_H264_MAIN_PPS;
  const avcCBody = Buffer.alloc(11 + sps.length + pps.length);
  let avcOffset = 0;

  avcCBody[avcOffset++] = 1;
  avcCBody[avcOffset++] = profileIdc;
  avcCBody[avcOffset++] = 0;
  avcCBody[avcOffset++] = levelIdc;
  avcCBody[avcOffset++] = 0xFF;
  avcCBody[avcOffset++] = 0xE1;
  avcCBody.writeUInt16BE(sps.length, avcOffset);
  avcOffset += 2;
  sps.copy(avcCBody, avcOffset);
  avcOffset += sps.length;
  avcCBody[avcOffset++] = 1;
  avcCBody.writeUInt16BE(pps.length, avcOffset);
  avcOffset += 2;
  pps.copy(avcCBody, avcOffset);
  const avcC = writeBox("avcC", avcCBody);
  const avc1 = writeBox("avc1", Buffer.concat([ Buffer.alloc(78, 0), avcC ]));
  const stsdVersion = Buffer.alloc(8, 0);

  stsdVersion.writeUInt32BE(1, 4);
  const stsd = writeBox("stsd", Buffer.concat([ stsdVersion, avc1 ]));
  const tkhdPayload = Buffer.alloc(84, 0);

  tkhdPayload.writeUInt32BE(1, 12);
  const tkhd = writeBox("tkhd", tkhdPayload);
  const hdlrPayload = Buffer.alloc(20, 0);

  hdlrPayload.write("vide", 8, 4, "ascii");
  const hdlr = writeBox("hdlr", hdlrPayload);
  const stbl = writeBox("stbl", stsd);
  const minf = writeBox("minf", stbl);
  const mdia = writeBox("mdia", Buffer.concat([ hdlr, minf ]));
  const trak = writeBox("trak", Buffer.concat([ tkhd, mdia ]));
  const moov = writeBox("moov", trak);

  return Buffer.concat([ writeBox("ftyp", Buffer.from("isom00000008", "ascii")), moov ]);
}

function makeRequest(): StartStreamRequest {

  return {

    audio: { channel: 1, max_bit_rate: 64, packet_time: 20, pt: 110, sample_rate: 16, type: 0 },
    sessionID: "sess-wiring",
    video: { fps: 15, height: 720, level: H264Level.LEVEL3_1, max_bit_rate: 800, profile: H264Profile.MAIN, pt: 96, type: 0, width: 1280 }
  } as unknown as StartStreamRequest;
}

function testCameraHost(): TestCameraHost {

  return makeTestCameraHost().host;
}

const stubFfmpegOptions: FfmpegOptions = new FfmpegOptionsImpl({

  codecSupport: { cpuGeneration: 0, hostSystem: "test" } as never,
  crop: undefined,
  debug: false,
  hardwareDecoding: false,
  hardwareTranscoding: false,
  log: { debug: () => undefined, error: () => undefined, info: () => undefined, warn: () => undefined },
  name: (): string => "stub-camera"
});

function encodePlan(camera: TestCameraHost, init: Buffer | null, sessionSource: "buffer" | "rtsp", force = false): ReturnType<typeof resolveStartStreamEncodePlan> {

  return resolveStartStreamEncodePlan({ channelProfile: stubChannel, ffmpegOptions: stubFfmpegOptions, fmp4InitSegmentData: init,
    forceTranscodeDueToUserOption: force, isHighLatency: false, preferCopyChannel: !force, protectCamera: camera, request: makeRequest(),
    sessionSource: sessionSource, useTsb: sessionSource === "buffer" });
}

describe("stream-live-wiring", () => {

  test("resolveStartStreamForceTranscodeDueToUserOption follows feature options", () => {

    const camera = testCameraHost();

    camera.hasFeature = (option) => option === "Video.Transcode";

    assert.equal(resolveStartStreamForceTranscodeDueToUserOption(camera, false), true);

    camera.hasFeature = () => false;
    assert.equal(resolveStartStreamForceTranscodeDueToUserOption(camera, false), false);
  });

  test("buildLiveVideoEncodeInput: buffer init with level 4.1 transcodes against HomeKit 3.1", () => {

    const camera = testCameraHost();
    const init = buildFmp4Init(77, 41);

    assert.ok(parseH264AvcCFromFmp4Init(init).known);

    const input = buildLiveVideoEncodeInput(camera, makeRequest(), stubChannel, false, false, "buffer", init);

    assert.equal(input.sourceDeclaredH264Known, true);
    assert.equal(input.sourceDeclaredH264Level, 3);
  });

  test("buildLiveVideoEncodeInput: rtsp source leaves declared unknown", () => {

    const camera = testCameraHost();
    const input = buildLiveVideoEncodeInput(camera, makeRequest(), stubChannel, false, false, "rtsp", buildFmp4Init(77, 40));

    assert.equal(input.sourceDeclaredH264Known, false);
  });

  test("resolveFmp4InitForLiveDeclaredCheck: missing timeshift prefix forces unknown declared (transcode)", () => {

    assert.equal(resolveFmp4InitForLiveDeclaredCheck({ sessionSource: "buffer", timeshiftPrefixBuffer: null }), null);

    const plan = encodePlan(testCameraHost(), null, "buffer");

    assert.equal(plan.isTranscoding, true);
  });

  test("resolveFmp4InitForLiveDeclaredCheck: timeshift prefix supplies avcC gate", () => {

    const prefix = buildFmp4Init(77, 31);
    const init = resolveFmp4InitForLiveDeclaredCheck({ sessionSource: "buffer", timeshiftPrefixBuffer: prefix });

    assert.ok(init);

    const plan = encodePlan(testCameraHost(), init, "buffer");

    assert.equal(plan.isTranscoding, false);
  });

  test("resolveStreamEgressBitrateBps uses transcode target or source channel bitrate", () => {

    assert.equal(resolveStreamEgressBitrateBps(true, 2000, 4_000_000), 2_000_000);
    assert.equal(resolveStreamEgressBitrateBps(false, 2000, 4_000_000), 4_000_000);
  });

  test("createCopyEscalationTsbResume uses production writer rotation", () => {

    const copy = new TestLiveStreamingFfmpegProcess("copy");
    const replacement = new TestLiveStreamingFfmpegProcess("replacement");
    const signal = new AbortController().signal;
    const rotated: { poisoned?: BackpressureWriter; replacement?: BackpressureWriter } = {};
    const railWithHook = createTsbSegmentWriterRail({ getStdin: () => copy.stdin, onRotateSegmentWriter: (event) => {

      rotated.poisoned = event.poisoned;
      rotated.replacement = event.replacement;
    }, signal: signal });
    const resume = createCopyEscalationTsbResume({ feedState: { allowTimeshiftPrefix: false, headerWritten: true, primeMediaFloor: null }, rail: railWithHook,
      subscription: { id: "sub-1" } as never });

    const oldWriter = railWithHook.getSegmentWriter();

    const writer = resume.rotateSegmentWriter(replacement as never);

    assert.notEqual(oldWriter, writer);
    assert.ok(oldWriter.signal.aborted);
    assert.equal(rotated.poisoned, oldWriter);
    assert.equal(rotated.replacement, writer);
    assert.equal(writer, railWithHook.getSegmentWriter());
    assert.equal(writer.signal.aborted, false);
  });

  test("refreshBufferBackedChannelProfileForEncode picks up live channel fps", () => {

    const camera = testCameraHost();

    const liveChannel = makeChannel({ fps: 30, height: 720, id: 1, name: "medium", width: 1280 });

    liveChannel.bitrate = 4_000_000;
    camera.ufp = { ...camera.ufp, channels: [liveChannel] };

    const stale = stubChannel;
    const refreshed = refreshBufferBackedChannelProfileForEncode(camera, stale);

    assert.ok(refreshed);
    assert.equal(refreshed?.channel.fps, 30);
  });

  test("resolveTimeshiftBufferLiveChannel forces transcode on width-only geometry drift (X4)", () => {

    const camera = testCameraHost();
    const liveChannel = makeChannel({ fps: 15, height: 720, id: 1, name: "medium", width: 1280 });

    liveChannel.bitrate = 4_000_000;
    camera.ufp = { ...camera.ufp, channels: [liveChannel] };
    const bufferWide: ChannelProfile = { ...stubChannel, channel: { ...stubChannel.channel, width: 1920 } };
    const resolved = resolveTimeshiftBufferLiveChannel(bufferWide, camera);

    assert.match(resolved.forcedTranscodeReason ?? "", /geometry/);
    assert.equal(resolved.subscriptionProfile.channel.width, 1920);
  });

  test("resolveTimeshiftBufferLiveChannel forces transcode on height-only geometry drift (X5)", () => {

    const camera = testCameraHost();
    const liveChannel = makeChannel({ fps: 15, height: 720, id: 1, name: "medium", width: 1280 });

    liveChannel.bitrate = 4_000_000;
    camera.ufp = { ...camera.ufp, channels: [liveChannel] };
    const bufferTall: ChannelProfile = { ...stubChannel, channel: { ...stubChannel.channel, height: 1080 } };
    const resolved = resolveTimeshiftBufferLiveChannel(bufferTall, camera);

    assert.match(resolved.forcedTranscodeReason ?? "", /geometry/);
    assert.equal(resolved.subscriptionProfile.channel.height, 1080);
  });

  test("resolveTimeshiftBufferLiveChannel forces transcode when buffer geometry differs (bufferDegraded/R5)", () => {

    const camera = testCameraHost();
    const liveChannel = makeChannel({ fps: 15, height: 720, id: 1, name: "medium", width: 1280 });

    liveChannel.bitrate = 4_000_000;
    camera.ufp = { ...camera.ufp, channels: [liveChannel] };
    const buffer30: ChannelProfile = { ...stubChannel, channel: { ...stubChannel.channel, fps: 30 } };
    const resolved = resolveTimeshiftBufferLiveChannel(buffer30, camera);

    assert.equal(resolved.subscriptionProfile.channel.fps, 30);
    assert.equal(resolved.forcedTranscodeReason, "timeshift buffer geometry differs from live channel (stale prefix)");
    const plan = resolveStartStreamEncodePlan({ bufferForcedTranscodeReason: resolved.forcedTranscodeReason, channelProfile: resolved.encodeProfile,
      ffmpegOptions: stubFfmpegOptions, fmp4InitSegmentData: buildFmp4Init(77, 31), forceTranscodeDueToUserOption: false, isHighLatency: false,
      preferCopyChannel: true, protectCamera: camera, request: makeRequest(), sessionSource: "bufferDegraded", useTsb: true });

    assert.equal(plan.isTranscoding, true);
  });

  test("stale 15fps buffer profile transcodes when live channel is 30fps and HomeKit requests 15fps", () => {

    const camera = testCameraHost();

    const liveChannel = makeChannel({ fps: 30, height: 720, id: 1, name: "medium", width: 1280 });

    liveChannel.bitrate = 4_000_000;
    camera.ufp = { ...camera.ufp, channels: [liveChannel] };
    const refreshed = refreshBufferBackedChannelProfileForEncode(camera, stubChannel);
    const init = buildFmp4Init(77, 31);
    const request = makeRequest();

    request.video.fps = 15;

    assert.ok(refreshed);

    const plan = resolveStartStreamEncodePlan({ channelProfile: refreshed, ffmpegOptions: stubFfmpegOptions, fmp4InitSegmentData: init,
      forceTranscodeDueToUserOption: false, isHighLatency: false, preferCopyChannel: true, protectCamera: camera, request: request, sessionSource: "buffer",
      useTsb: true });

    assert.equal(plan.isTranscoding, true);
  });

  test("createLiveFfmpegCopyExitBridge escalates eligible copy failures", async () => {

    let createTsbResumeCalls = 0;

    const copyImpl = new TestLiveStreamingFfmpegProcess("copy", { stderrLog: ["Error initializing output stream"] });
    const copy = copyImpl as unknown as ProtectStreamingFfmpegProcess;
    let escalated = 0;

    const { wireFfmpegExitBridge } = createLiveFfmpegCopyExitBridge({

      copyEscalationInFlightRef: { current: false },
      createTsbResume: () => {

        createTsbResumeCalls += 1;

        return undefined;
      },
      endFfmpegBridge: () => undefined,
      escalateCopyFailure: () => {

        escalated += 1;

        return Promise.resolve(copy);
      },
      onRespawned: () => undefined,
      sessionDiagnostics: { escalatedFromCopy: false, segmentsFed: 1, videoCopy: true },
      sessionStartedAt: Date.now(),
      sessionStillOwned: () => true,
      useTsb: true
    });

    wireFfmpegExitBridge(copy);
    copyImpl.abort();
    await copyImpl.exited;

    assert.equal(escalated, 1);
    assert.equal(createTsbResumeCalls, 1);
    assert.equal(resolveVideoCopyExitBridgeAction({ copyEscalationInFlight: false, eligibleForEscalation: true, exitIsReplaced: false,
      sessionStillOwned: true }), "escalate");
  });
});

describe("shouldSubstituteSelectChannelForSession (BD2)", () => {

  test("blocks selectChannel fallback when bufferDegraded has no profile but a standing timeshift prefix exists", () => {

    assert.equal(shouldSubstituteSelectChannelForSession(true, "bufferDegraded", null, true), false);
  });

  test("allows transcode-biased selectChannel when bufferDegraded has no profile and no timeshift prefix", () => {

    assert.equal(shouldSubstituteSelectChannelForSession(true, "bufferDegraded", null, false), true);
  });
});

describe("resolveCopyEscalationKeyframePrimingBuffer", () => {

  const trailing = Buffer.from("init-plus-keyframe-tail");

  test("returns trailing buffer when buffer and live channel id and lens match on pooled livestream", () => {

    assert.deepEqual(resolveCopyEscalationKeyframePrimingBuffer(stubChannel, stubChannel, trailing, true), trailing);
  });

  test("returns null when either profile is missing (null/null never matches)", () => {

    assert.equal(resolveCopyEscalationKeyframePrimingBuffer(null, null, trailing, true), null);
    assert.equal(resolveCopyEscalationKeyframePrimingBuffer(stubChannel, null, trailing, true), null);
    assert.equal(resolveCopyEscalationKeyframePrimingBuffer(null, stubChannel, trailing, true), null);
  });

  test("returns null when live and buffer use separate pooled encoders (UseRtsp debug path)", () => {

    assert.equal(resolveCopyEscalationKeyframePrimingBuffer(stubChannel, stubChannel, trailing, false), null);
  });

  test("returns null when buffer channel id differs from live subscription channel", () => {

    const other: ChannelProfile = {

      channel: { ...stubChannel.channel, id: 99, name: "other" },
      name: "other"
    } as ChannelProfile;

    assert.equal(resolveCopyEscalationKeyframePrimingBuffer(other, stubChannel, trailing, true), null);
  });

  test("returns null when buffer lens differs from live subscription lens", () => {

    const lensZero: ChannelProfile = { ...stubChannel, lens: 0 };
    const lensOne: ChannelProfile = { ...stubChannel, lens: 1 };

    assert.equal(resolveCopyEscalationKeyframePrimingBuffer(lensZero, lensOne, trailing, true), null);
  });
});

describe("appendLiveVideoEncodeToFfmpegArgs output fps", () => {

  const transcodeDecision: LiveVideoEncodeDecision = { logReason: "test transcode", mode: "transcode" };

  type StreamEncoderOptions = Parameters<FfmpegOptions["streamEncoder"]>[0];

  function appendEncodeArgs(sourceFps: number, requestFps: number, useInterpolation: boolean,
    ffmpegOptions: FfmpegOptions = stubFfmpegOptions): { args: string[]; streamEncoderCalls: StreamEncoderOptions[] } {

    const channel: ChannelProfile = {

      channel: { ...stubChannel.channel, fps: sourceFps },
      name: stubChannel.name
    } as ChannelProfile;
    const request = makeRequest();

    request.video.fps = requestFps;
    const args: string[] = [];
    const streamEncoderCalls: StreamEncoderOptions[] = [];
    const spyingOptions: FfmpegOptions = new Proxy(ffmpegOptions, {

      get(target, property, receiver): unknown {

        if(property === "streamEncoder") {

          return (options: StreamEncoderOptions): string[] => {

            streamEncoderCalls.push(options);

            return Reflect.get(target, property, receiver).call(target, options);
          };
        }

        const value: unknown = Reflect.get(target, property, receiver);

        return typeof value === "function" ? value.bind(target) : value;
      }
    });

    appendLiveVideoEncodeToFfmpegArgs(spyingOptions, args, transcodeDecision, channel, request, 800, useInterpolation, true);

    return { args: args, streamEncoderCalls: streamEncoderCalls };
  }

  function makeAppleHardwareFfmpegOptions(): FfmpegOptions {

    const base = new FfmpegOptionsImpl({

      codecSupport: {

        cpuGeneration: 3,
        ffmpegAtLeast: (): boolean => true,
        gpuMem: 0,
        hasDecoder: (): boolean => true,
        hasEncoder: (): boolean => true,
        hasHwAccel: (): boolean => true,
        hostSystem: "macOS.Apple"
      } as never,
      crop: undefined,
      debug: false,
      hardwareDecoding: true,
      hardwareTranscoding: true,
      log: { debug: () => undefined, error: () => undefined, info: () => undefined, warn: () => undefined },
      name: (): string => "hardware-wiring-test"
    });

    return new Proxy(base, {

      get(target, property, receiver): unknown {

        if(property === "hardwareEncodes") {

          return (): boolean => true;
        }

        const value: unknown = Reflect.get(target, property, receiver);

        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  }

  const UPSTREAM_MINTERPOLATE_SUFFIX = ":mi_mode=mci:mc_mode=aobmc:me=fss:me_mode=bidir:vsbmc=1:scd=none";

  function filterArg(args: string[]): string {

    const filterIdx = args.indexOf("-filter:v");

    assert.ok(filterIdx >= 0, "expected -filter:v in encoder args");

    return args[filterIdx + 1] ?? "";
  }

  function callerFpsFilterChain(filter: string): string | null {

    const segments = filter.split(", ");

    for(let i = segments.length - 1; i >= 0; i -= 1) {

      const seg = segments[i] ?? "";

      if(seg.startsWith("minterpolate=")) {

        const fpsSeg = (i > 0) ? segments[i - 1] : undefined;

        if(fpsSeg?.startsWith("fps=")) {

          return fpsSeg + ", " + seg;
        }

        return seg;
      }
    }

    return null;
  }

  function fpsFilterSegmentCount(filter: string): number {

    return filter.split(", ").filter((seg) => seg.startsWith("fps=")).length;
  }

  function assertEncoderOutputFps(args: string[], encoderFps: number): void {

    const gop = (encoderFps * HOMEKIT_IDR_INTERVAL).toString();
    const gopIdx = args.indexOf("-g:v");

    assert.ok(gopIdx >= 0);
    assert.equal(args[gopIdx + 1], gop);
  }

  function assertUnknownSourcePluginFpsCap(args: string[], requestFps: number): void {

    const filter = filterArg(args);

    assert.equal(callerFpsFilterChain(filter), null);
    assert.equal(fpsFilterSegmentCount(filter), 1);
    assert.ok(filter.split(", ").some((seg) => seg === ("fps=" + requestFps.toString())),
      "plugin utils must emit exactly one fps=<request> filter for unknown source");
    assert.doesNotMatch(filter, /minterpolate=/);
  }

  function assertUnknownSourceStreamEncoderContract(calls: StreamEncoderOptions[], requestFps: number): void {

    assert.equal(calls.length, 1);
    const encoderOptions = calls[0];

    assert.ok(encoderOptions);
    assert.equal(encoderOptions.inputFps, 0);
    assert.equal(encoderOptions.videoFilters, undefined);
    assert.equal(encoderOptions.fps, requestFps);
  }

  test("source below request (interpolation off) caps output at source without caller fps filters (FP8)", () => {

    const { args } = appendEncodeArgs(15, 30, false);

    assertEncoderOutputFps(args, 15);
    const filter = filterArg(args);

    assert.equal(callerFpsFilterChain(filter), null);
    assert.equal(fpsFilterSegmentCount(filter), 0);
    assert.doesNotMatch(filter, /minterpolate=/);
  });

  test("source below request (interpolation on) never upsamples: no minterpolate (FPS6)", () => {

    const { args } = appendEncodeArgs(15, 30, true);
    const filter = filterArg(args);

    assertEncoderOutputFps(args, 15);
    assert.equal(callerFpsFilterChain(filter), null);
    assert.equal(fpsFilterSegmentCount(filter), 0);
    assert.doesNotMatch(filter, /minterpolate=/);
  });

  test("non-finite source fps treated as unknown through wiring (FP2b)", () => {

    for(const badFps of [ Number.POSITIVE_INFINITY, Number.NaN, -1, 0 ]) {

      const { args, streamEncoderCalls } = appendEncodeArgs(badFps, 30, true);

      assertEncoderOutputFps(args, 30);
      assertUnknownSourcePluginFpsCap(args, 30);
      assertUnknownSourceStreamEncoderContract(streamEncoderCalls, 30);
      assert.doesNotMatch(JSON.stringify(args), /Infinity|NaN/);
    }
  });

  test("unknown source uses HomeKit request without caller fps filters (FP9)", () => {

    const { args, streamEncoderCalls } = appendEncodeArgs(0, 24, true);

    assertEncoderOutputFps(args, 24);
    assertUnknownSourcePluginFpsCap(args, 24);
    assertUnknownSourceStreamEncoderContract(streamEncoderCalls, 24);
    assert.equal(resolveStreamOutputFps({ requestedFps: 24, sourceFps: 0 }), 24);
  });

  test("unknown source on Apple hardware uses -r request without hwdownload (FP9 hw)", () => {

    const requestFps = 24;
    const { args, streamEncoderCalls } = appendEncodeArgs(0, requestFps, false, makeAppleHardwareFfmpegOptions());

    assertUnknownSourceStreamEncoderContract(streamEncoderCalls, requestFps);
    const rateIdx = args.indexOf("-r");

    assert.ok(rateIdx >= 0, "hardware path must rate-limit unknown source via -r");
    assert.equal(args[rateIdx + 1], requestFps.toString());
    assert.doesNotMatch(args.join(" "), /hwdownload/);
  });

  test("source above request (interpolation off) caps at request without caller fps filters", () => {

    const { args } = appendEncodeArgs(30, 15, false);
    const filter = filterArg(args);

    assertEncoderOutputFps(args, 15);
    assert.doesNotMatch(filter, /minterpolate=/);
    assert.equal(fpsFilterSegmentCount(filter), 1);
    assert.doesNotMatch(filter, /, fps=15$/);
  });

  test("source above request (interpolation on) uses upstream fps + minterpolate at the request rate (FPS5)", () => {

    const { args } = appendEncodeArgs(30, 15, true);
    const filter = filterArg(args);
    const callerChain = callerFpsFilterChain(filter);

    assertEncoderOutputFps(args, 30);
    assert.equal(callerChain, "fps=15, minterpolate=fps=15" + UPSTREAM_MINTERPOLATE_SUFFIX);
    assert.doesNotMatch(filter, /fps=30/);
  });

  test("interpolation when source equals request uses upstream filter string", () => {

    const { args } = appendEncodeArgs(30, 30, true);
    const callerChain = callerFpsFilterChain(filterArg(args));

    assert.equal(callerChain, "fps=30, minterpolate=fps=30" + UPSTREAM_MINTERPOLATE_SUFFIX);
  });

  test("I1: source below request must not emit interpolation filters", () => {

    const { args } = appendEncodeArgs(15, 30, true);

    assert.equal(callerFpsFilterChain(filterArg(args)), null);
  });
});
