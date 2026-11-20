/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-start-integration.test.ts: drives production ProtectStreamingDelegate.startStream (prepare + START) with a fake timeshift, spawn hook, and livestream double.
 */
/* eslint-disable camelcase, sort-imports */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { PrepareStreamRequest, StartStreamRequest } from "homebridge";
import { H264Level, H264Profile, HOMEKIT_IDR_INTERVAL, RtpPortAllocator, StreamRequestTypes, formatBps } from "homebridge-plugin-utils";
import type { TestLogEntry } from "homebridge-plugin-utils/testing";
import { formatLogEntry, settle } from "homebridge-plugin-utils/testing";
import type { TestTimeshiftSupervisor } from "../testing.helpers.ts";
import { makeTimeshiftSupervisorDouble } from "../testing.helpers.ts";
import type { ControllableLivestreamDouble, TestCameraHost } from "./testing.helpers.ts";
import { makeControllableLivestreamDouble, makeKeyframeFragment, makeLivestreamSubscriptionDouble, makeNonKeyframeFragment, makeTestCameraHost,
  makeUntimedNonKeyframeFragment } from "./testing.helpers.ts";
import { makeChannel } from "../camera.fixtures.ts";
import { ProtectTimeshiftBuffer } from "./timeshift.ts";
import { parseH264AvcCFromFmp4Init } from "./h264-fmp4-avcc.ts";
import { TEST_H264_MAIN_PPS, testH264SpsForProfileLevel } from "./h264-test-bytes.ts";
import { ProtectStreamingDelegate } from "./stream.ts";
import type { ProtectStreamingDelegateTestOptions } from "./stream.ts";
import type { BackpressureWriter } from "homebridge-plugin-utils";
import type { ChannelProfile, SelectChannelOptions } from "./resolution.ts";
import { setLiveVideoFfmpegSpawnerForTests } from "./stream-live-ffmpeg-spawn.ts";
import { TestLiveStreamingFfmpegProcess } from "./test-live-ffmpeg-process.ts";
import type { ProtectStreamingFfmpegProcess } from "./stream-ffmpeg-process.ts";
import { VIDEO_COPY_FAILURE_PATTERNS } from "./stream-transcode-policy.ts";
import { shouldSubstituteSelectChannelForSession } from "./stream-live-wiring.ts";

const SESSION_ID = "sess-start-integration";

const stubChannel: ChannelProfile = {

  channel: { bitrate: 4000000, fps: 15, height: 720, id: 1, name: "medium", width: 1280 },
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

const MATCHING_INIT = buildFmp4Init(77, 31);
const MATCHING_INIT_LIVESTREAM = { codec: "h264", data: MATCHING_INIT, description: { tracks: [] } };

function makeStartRequest(overrides?: { packetTime?: number }): StartStreamRequest {

  return {

    audio: { channel: 1, max_bit_rate: 64, packet_time: overrides?.packetTime ?? 20, pt: 110, sample_rate: 16, type: 0 },
    sessionID: SESSION_ID,
    video: { fps: 15, height: 720, level: H264Level.LEVEL3_1, max_bit_rate: 800, profile: H264Profile.MAIN, pt: 96, type: 0, width: 1280 }
  } as unknown as StartStreamRequest;
}

function makePrepareRequest(): PrepareStreamRequest {

  return {

    addressVersion: "ipv4",
    audio: { port: 12345, srtpCryptoSuite: 0, srtp_key: Buffer.alloc(16), srtp_salt: Buffer.alloc(14) },
    sessionID: SESSION_ID,
    targetAddress: "127.0.0.1",
    video: { port: 12347, srtpCryptoSuite: 0, srtp_key: Buffer.alloc(16), srtp_salt: Buffer.alloc(14) }
  } as unknown as PrepareStreamRequest;
}

function installProtectStreamingHarness(host: TestCameraHost): void {

  class MockCameraController {

    public static generateSynchronisationSource(): number {

      return 12345;
    }

    public forceStopStreamingSession(): void {

      // No-op in harness tests.
    }
  }

  const api = host.api;

  host.api = new Proxy(api, {

    get(target, property, receiver): unknown {

      if(property === "hap") {

        return new Proxy(target.hap, {

          get(hapTarget, hapProperty, hapReceiver): unknown {

            if(hapProperty === "CameraController") {

              return MockCameraController;
            }

            return Reflect.get(hapTarget, hapProperty, hapReceiver);
          }
        });
      }

      return Reflect.get(target, property, receiver);
    }
  });

  (host.platform as { rtpPorts: RtpPortAllocator }).rtpPorts = new RtpPortAllocator();
}

function argsUseVideoCopy(args: string[]): boolean {

  const idx = args.indexOf("-codec:v");

  return (idx >= 0) && (args[idx + 1] === "copy");
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8000): Promise<void> {

  const started = Date.now();

  while(!predicate()) {

    if((Date.now() - started) > timeoutMs) {

      throw new Error("Timed out waiting for " + label);
    }

    // eslint-disable-next-line no-await-in-loop -- intentional poll loop for async harness timing
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

type FragmentTriple = ReturnType<typeof makeNonKeyframeFragment>;

interface PooledSharedFeedCouple {

  bufferSub: ControllableLivestreamDouble;
  pushInitToBuffer: () => void;
  pushMediaToBoth: (fragment: FragmentTriple) => void;
  pushMediaToBuffer: (fragment: FragmentTriple) => void;
  pushMediaToStream: (fragment: FragmentTriple) => void;
  streamSub: ControllableLivestreamDouble;
}

// Two distinct subscription objects (production never shares ids) fed from one shared push surface.
function makePooledSharedFeedCouple(): PooledSharedFeedCouple {

  const bufferSub = makeControllableLivestreamDouble({ id: "pooled-buffer-encoder", initSegment: MATCHING_INIT_LIVESTREAM });
  const streamSub = makeControllableLivestreamDouble({ id: "pooled-session-encoder", initSegment: MATCHING_INIT_LIVESTREAM });

  assert.notEqual(bufferSub.id, streamSub.id, "pooled buffer and session subscriptions must be distinct objects");

  const asMedia = (fragment: FragmentTriple): { data: Buffer; mdat: Buffer; moof: Buffer; type: "media" } => ({

    data: fragment.data,
    mdat: fragment.mdat,
    moof: fragment.moof,
    type: "media"
  });

  return {

    bufferSub,
    pushInitToBuffer: (): void => {

      bufferSub.push({ ...MATCHING_INIT_LIVESTREAM, type: "init" });
    },
    pushMediaToBoth: (fragment): void => {

      bufferSub.push(asMedia(fragment));
      streamSub.push(asMedia(fragment));
    },
    pushMediaToBuffer: (fragment): void => {

      bufferSub.push(asMedia(fragment));
    },
    pushMediaToStream: (fragment): void => {

      streamSub.push(asMedia(fragment));
    },
    streamSub
  };
}

function logLineIncludes(entries: readonly TestLogEntry[], fragment: string): boolean {

  return entries.some((entry) => formatLogEntry(entry).includes(fragment));
}

interface HarnessContext {

  delegate: ProtectStreamingDelegate;
  host: TestCameraHost;
  logEntries: readonly TestLogEntry[];
  spawnedArgs: string[][];
  spawnedProcesses: TestLiveStreamingFfmpegProcess[];
  timeshift: TestTimeshiftSupervisor;
}

function syncLiveUfpChannelsForStubBuffer(host: TestCameraHost): void {

  const stub = stubChannel.channel;
  const live = makeChannel({ fps: stub.fps, height: stub.height, id: stub.id, name: stub.name, width: stub.width });

  live.bitrate = stub.bitrate;
  const channels = host.ufp.channels.some((channel) => channel.id === stub.id) ?
    host.ufp.channels.map((channel) => (channel.id === stub.id) ? { ...channel, ...live } : channel) :
    [ ...host.ufp.channels, live ];

  host.ufp = { ...host.ufp, channels };
}

function createHarness(options?: { delegateTestOptions?: ProtectStreamingDelegateTestOptions; enableHardwareTranscodeFeature?: boolean;
  hardwareTranscodingHint?: boolean; livestreamSegments?: number; transcodeBitrateKbps?: number; videoCodec?: string; }): HarnessContext {

  const { host, logEntries } = makeTestCameraHost();

  installProtectStreamingHarness(host);
  syncLiveUfpChannelsForStubBuffer(host);
  host.isReachable = true;
  host.usesTimeshiftLivestream = true;
  host.selectChannel = (): ChannelProfile => stubChannel;
  host.selectSubstrateChannel = (): ChannelProfile => stubChannel;
  host.livestreamSubscriptions = [makeLivestreamSubscriptionDouble({ mediaSegments: options?.livestreamSegments ?? 1 })];

  if(options?.hardwareTranscodingHint) {

    host.hints = { ...host.hints, hardwareTranscoding: true, transcodeBitrate: options.transcodeBitrateKbps ?? 900 };
  }

  if(options?.enableHardwareTranscodeFeature) {

    const defaultHasFeature = host.hasFeature.bind(host);

    host.hasFeature = (option: string): boolean => (option === "Video.Transcode.Hardware") ? true : defaultHasFeature(option);
  }

  if(options?.videoCodec) {

    host.ufp = { ...host.ufp, videoCodec: options.videoCodec };
  }

  const timeshift = makeTimeshiftSupervisorDouble();
  const delegate = new ProtectStreamingDelegate(host, [[ 1280, 720, 15 ]], options?.delegateTestOptions);

  delegate.timeshift = timeshift as unknown as ProtectStreamingDelegate["timeshift"];
  host.stream = delegate;

  const spawnedArgs: string[][] = [];
  const spawnedProcesses: TestLiveStreamingFfmpegProcess[] = [];

  setLiveVideoFfmpegSpawnerForTests((_ffmpegOptions, init) => {

    const proc = new TestLiveStreamingFfmpegProcess("live-" + String(spawnedProcesses.length), { signal: init.signal });

    spawnedArgs.push(init.args ?? []);
    spawnedProcesses.push(proc);

    return proc as unknown as ProtectStreamingFfmpegProcess;
  });

  return { delegate, host, logEntries, spawnedArgs, spawnedProcesses, timeshift };
}

async function wireRealTimeshiftBuffer(ctx: HarnessContext, _bufferSub: ControllableLivestreamDouble,
  channelProfile: ChannelProfile = stubChannel): Promise<ProtectTimeshiftBuffer> {

  const buffer = new ProtectTimeshiftBuffer(ctx.host);

  const supervisor = {

    buffer,
    reconcile: async (): Promise<boolean> => true,
    shutdown: (): void => {

      buffer.stop();
    }
  };

  ctx.delegate.timeshift = supervisor as unknown as ProtectStreamingDelegate["timeshift"];
  ctx.timeshift = supervisor as unknown as TestTimeshiftSupervisor;

  buffer.configuredDuration = 10000;
  await buffer.start(channelProfile);

  return buffer;
}

async function prepareAndStart(ctx: HarnessContext, startRequest: StartStreamRequest = makeStartRequest()): Promise<void> {

  await new Promise<void>((resolve, reject) => {

    ctx.delegate.prepareStream(makePrepareRequest(), (error) => ((error instanceof Error) ? reject(error) : resolve()));
  });

  await new Promise<void>((resolve, reject) => {

    ctx.delegate.handleStreamRequest({ ...startRequest, type: StreamRequestTypes.START },
      (error) => ((error instanceof Error) ? reject(error) : resolve()));
  });

  await waitFor(() => ctx.spawnedArgs.length > 0, "spawn");
}

describe("startStream integration harness", { concurrency: 1 }, () => {

  before(() => {

    setLiveVideoFfmpegSpawnerForTests(undefined);
  });

  after(() => {

    setLiveVideoFfmpegSpawnerForTests(undefined);
  });

  test("buffer with matching init prefix chooses copy (ffmpeg args and decision log)", async () => {

    const ctx = createHarness();
    const prefix = Buffer.concat([ MATCHING_INIT, Buffer.from("recent-media") ]);

    ctx.timeshift.buffer.isStarted = true;
    ctx.timeshift.buffer.channelProfile = stubChannel;
    ctx.timeshift.buffer.getLast = (): Buffer => prefix;

    await prepareAndStart(ctx);

    assert.ok(parseH264AvcCFromFmp4Init(MATCHING_INIT).known);
    assert.equal(argsUseVideoCopy(ctx.spawnedArgs[0] ?? []), true);
    assert.ok((ctx.spawnedArgs[0] ?? []).includes("h264_mp4toannexb"));
    assert.ok(logLineIncludes(ctx.logEntries, "H.264 source profile rank 1, level rank 0 -> copy"));
    assert.ok(logLineIncludes(ctx.logEntries, "Streaming live video with H.264 copy"));
    const expectedSourceEgress = formatBps(stubChannel.channel.bitrate);

    assert.ok(logLineIncludes(ctx.logEntries, expectedSourceEgress), "egress log must show source channel bitrate on copy");
    assert.ok(!logLineIncludes(ctx.logEntries, formatBps(800000)), "copy must not log HomeKit target as egress");

    await waitFor(() => (ctx.spawnedProcesses[0]?.stdinWrites.length ?? 0) > 0, "first stdin write on copy");

    const firstWrite = ctx.spawnedProcesses[0]?.stdinWrites[0];

    assert.ok(firstWrite);
    assert.equal(firstWrite.length, prefix.length,
      "copy-path stdin assertion must compare the full getLast() prefix length, not a truncated prefix");
    assert.ok(prefix.equals(firstWrite), "first FFmpeg stdin write must match the full timeshift getLast() prefix bytes");
  });

  test("packet_time 60 transcodes by default (high latency)", async () => {

    const ctx = createHarness();

    ctx.host.hasFeature = (option: string): boolean => option === "Video.Transcode.HighLatency";
    ctx.timeshift.buffer.isStarted = true;
    ctx.timeshift.buffer.channelProfile = stubChannel;
    ctx.timeshift.buffer.getLast = (): Buffer => Buffer.concat([ MATCHING_INIT, Buffer.from("recent-media") ]);

    await prepareAndStart(ctx, makeStartRequest({ packetTime: 60 }));

    assert.equal(argsUseVideoCopy(ctx.spawnedArgs[0] ?? []), false);
    assert.ok(logLineIncludes(ctx.logEntries, "high-latency") || logLineIncludes(ctx.logEntries, "High latency") ||
      logLineIncludes(ctx.logEntries, "-> transcode"));
  });

  test("packet_time 60 with HighLatency off and matching avcC copies", async () => {

    const ctx = createHarness();
    const defaultHasFeature = ctx.host.hasFeature.bind(ctx.host);

    ctx.host.hasFeature = (option: string): boolean => (option === "Video.Transcode.HighLatency") ? false : defaultHasFeature(option);
    ctx.timeshift.buffer.isStarted = true;
    ctx.timeshift.buffer.channelProfile = stubChannel;
    ctx.timeshift.buffer.getLast = (): Buffer => Buffer.concat([ MATCHING_INIT, Buffer.from("recent-media") ]);

    await prepareAndStart(ctx, makeStartRequest({ packetTime: 60 }));

    assert.equal(argsUseVideoCopy(ctx.spawnedArgs[0] ?? []), true);
  });

  test("Video.Transcode forces transcode through startStream", async () => {

    const ctx = createHarness();

    ctx.host.hasFeature = (option: string): boolean => option === "Video.Transcode";
    ctx.timeshift.buffer.isStarted = true;
    ctx.timeshift.buffer.channelProfile = stubChannel;
    ctx.timeshift.buffer.getLast = (): Buffer => Buffer.concat([ MATCHING_INIT, Buffer.from("recent-media") ]);

    await prepareAndStart(ctx);

    assert.equal(argsUseVideoCopy(ctx.spawnedArgs[0] ?? []), false);
    assert.ok(logLineIncludes(ctx.logEntries, "-> transcode"));
    assert.ok(logLineIncludes(ctx.logEntries, formatBps(800000)));
  });

  test("null timeshift prefix forces transcode", async () => {

    const ctx = createHarness();

    ctx.timeshift.buffer.isStarted = true;
    ctx.timeshift.buffer.channelProfile = stubChannel;
    ctx.timeshift.buffer.getLast = (): null => null;

    await prepareAndStart(ctx);

    assert.equal(argsUseVideoCopy(ctx.spawnedArgs[0] ?? []), false);
    assert.ok(logLineIncludes(ctx.logEntries, "declared"));
  });

  test("missing live ufp channel: subscription stays on buffer channel and transcodes", async () => {

    const ctx = createHarness();
    const wrongChannel = makeChannel({ fps: stubChannel.channel.fps, height: 1080, id: 99, name: "wrong", width: 1920 });

    wrongChannel.bitrate = stubChannel.channel.bitrate;
    ctx.host.ufp = { ...ctx.host.ufp, channels: [wrongChannel] };
    ctx.host.selectChannel = (): ChannelProfile => ({ ...stubChannel, channel: wrongChannel, name: "wrong" });
    ctx.timeshift.buffer.isStarted = true;
    ctx.timeshift.buffer.channelProfile = stubChannel;
    ctx.timeshift.buffer.getLast = (): Buffer => Buffer.concat([ MATCHING_INIT, Buffer.from("recent-media") ]);

    await prepareAndStart(ctx);

    assert.equal(ctx.host.livestreamCalls[0]?.channelProfile.channel.id, stubChannel.channel.id);
    assert.equal(argsUseVideoCopy(ctx.spawnedArgs[0] ?? []), false);
    assert.ok(logLineIncludes(ctx.logEntries, "missing buffer channel id") || logLineIncludes(ctx.logEntries, "-> transcode"));
  });

  test("bufferDegraded stale substrate uses resolveTimeshiftBufferLiveChannel (R5_callsite)", async () => {

    const buffer30: ChannelProfile = { ...stubChannel, channel: { ...stubChannel.channel, fps: 30 } };
    const ctx = createHarness();

    ctx.host.ufp = { ...ctx.host.ufp, videoCodec: "av1" };
    const live15 = makeChannel({ fps: 15, height: stubChannel.channel.height, id: stubChannel.channel.id, name: stubChannel.channel.name,
      width: stubChannel.channel.width });

    live15.bitrate = stubChannel.channel.bitrate;
    ctx.host.ufp = { ...ctx.host.ufp, channels: [live15] };
    ctx.timeshift.buffer.isStarted = false;
    ctx.timeshift.buffer.channelProfile = null;
    ctx.host.selectSubstrateChannel = (): ChannelProfile => buffer30;
    ctx.timeshift.buffer.getLast = (): null => null;

    const request = makeStartRequest();

    request.video.fps = 15;

    await prepareAndStart(ctx, request);

    const args = ctx.spawnedArgs[0] ?? [];
    const gopIdx = args.indexOf("-g:v");

    assert.equal(argsUseVideoCopy(args), false);
    assert.ok(gopIdx >= 0);
    assert.equal(args[gopIdx + 1], String(15 * HOMEKIT_IDR_INTERVAL));
    assert.ok(logLineIncludes(ctx.logEntries, "geometry differs"));
    assert.ok(logLineIncludes(ctx.logEntries, "Using 1280x720@15fps"));
    assert.ok(!logLineIncludes(ctx.logEntries, "input codec is not H.264"));
  });

  test("stale buffer 30fps transcodes when live channel is 15fps and HomeKit requests 15fps", async () => {

    const buffer30: ChannelProfile = { ...stubChannel, channel: { ...stubChannel.channel, fps: 30 } };
    const ctx = createHarness();
    const live15 = makeChannel({ fps: 15, height: stubChannel.channel.height, id: stubChannel.channel.id, name: stubChannel.channel.name,
      width: stubChannel.channel.width });

    live15.bitrate = stubChannel.channel.bitrate;
    ctx.host.ufp = { ...ctx.host.ufp, channels: [live15] };
    ctx.timeshift.buffer.isStarted = true;
    ctx.timeshift.buffer.channelProfile = buffer30;
    ctx.timeshift.buffer.getLast = (): Buffer => Buffer.concat([ MATCHING_INIT, Buffer.from("recent-media") ]);

    await prepareAndStart(ctx);

    assert.equal(ctx.host.livestreamCalls[0]?.channelProfile.channel.fps, 30);
    assert.equal(argsUseVideoCopy(ctx.spawnedArgs[0] ?? []), false);
    assert.ok(logLineIncludes(ctx.logEntries, "stale prefix") || logLineIncludes(ctx.logEntries, "geometry differs"));
  });

  test("stale buffer width transcodes when live channel width differs (R5_callsite)", async () => {

    const bufferWide: ChannelProfile = { ...stubChannel, channel: { ...stubChannel.channel, width: 1920 } };
    const ctx = createHarness();
    const liveChannel = makeChannel({ fps: stubChannel.channel.fps, height: stubChannel.channel.height, id: stubChannel.channel.id,
      name: stubChannel.channel.name, width: 1280 });

    liveChannel.bitrate = stubChannel.channel.bitrate;
    ctx.host.ufp = { ...ctx.host.ufp, channels: [liveChannel] };
    ctx.timeshift.buffer.isStarted = true;
    ctx.timeshift.buffer.channelProfile = bufferWide;
    ctx.timeshift.buffer.getLast = (): Buffer => Buffer.concat([ MATCHING_INIT, Buffer.from("recent-media") ]);

    await prepareAndStart(ctx);

    assert.equal(ctx.host.livestreamCalls[0]?.channelProfile.channel.width, 1920);
    assert.equal(argsUseVideoCopy(ctx.spawnedArgs[0] ?? []), false);
    assert.ok(logLineIncludes(ctx.logEntries, "geometry differs"));
  });

  test("stale 15fps buffer transcodes when live ufp channel is 30fps (same id)", async () => {

    const ctx = createHarness();
    const liveChannel = makeChannel({ fps: 30, height: stubChannel.channel.height, id: stubChannel.channel.id, name: stubChannel.channel.name,
      width: stubChannel.channel.width });

    liveChannel.bitrate = stubChannel.channel.bitrate;
    ctx.host.ufp = { ...ctx.host.ufp, channels: [liveChannel] };
    ctx.timeshift.buffer.isStarted = true;
    ctx.timeshift.buffer.channelProfile = stubChannel;
    ctx.timeshift.buffer.getLast = (): Buffer => Buffer.concat([ MATCHING_INIT, Buffer.from("recent-media") ]);

    await prepareAndStart(ctx);

    assert.equal(argsUseVideoCopy(ctx.spawnedArgs[0] ?? []), false);
    assert.ok(logLineIncludes(ctx.logEntries, "stale prefix") || logLineIncludes(ctx.logEntries, "geometry differs"));
  });

  test("bufferDegraded without buffer profile falls back to transcode-biased selectChannel", async () => {

    const ctx = createHarness();
    let selectCall: { bias?: string; maxPixels?: number; height: number; width: number } | undefined;

    ctx.host.ufp = { ...ctx.host.ufp, videoCodec: "av1" };
    ctx.timeshift.buffer.isStarted = false;
    ctx.timeshift.buffer.channelProfile = null;
    ctx.timeshift.buffer.getLast = (): null => null;
    ctx.host.selectSubstrateChannel = (): null => null;
    ctx.host.selectChannel = (width: number, height: number, options: SelectChannelOptions): ChannelProfile => {

      selectCall = { bias: options.bias, height: height, maxPixels: options.maxPixels, width: width };

      return stubChannel;
    };

    await prepareAndStart(ctx);

    assert.equal(ctx.spawnedProcesses.length, 1);
    assert.ok(selectCall);
    assert.equal(selectCall.bias, "higher");
    assert.ok((selectCall.maxPixels ?? 0) > 0);
  });

  test("standing timeshift prefix blocks selectChannel at startStream (BD4/BD5)", async () => {

    const ctx = createHarness();
    let selectChannelCalls = 0;

    ctx.host.ufp = { ...ctx.host.ufp, videoCodec: "av1" };
    ctx.timeshift.buffer.isStarted = false;
    ctx.timeshift.buffer.channelProfile = null;
    ctx.timeshift.buffer.getLast = (): Buffer => Buffer.concat([ MATCHING_INIT, Buffer.from("standing-prefix") ]);
    ctx.host.selectSubstrateChannel = (): null => null;
    ctx.host.selectChannel = (): ChannelProfile => {

      selectChannelCalls += 1;

      return stubChannel;
    };

    await assert.rejects(() => prepareAndStart(ctx), /no valid RTSP stream profile/);
    assert.equal(selectChannelCalls, 0, "standing prefix must block selectChannel substitute at stream.ts callsite");
  });

  test("direct RTSP session source always transcodes", async () => {

    const ctx = createHarness();

    ctx.host.usesTimeshiftLivestream = false;
    ctx.timeshift.buffer.isStarted = false;

    await prepareAndStart(ctx);

    assert.equal(argsUseVideoCopy(ctx.spawnedArgs[0] ?? []), false);
    assert.ok(logLineIncludes(ctx.logEntries, "RTSP"));
  });

  test("copy failure escalates: replacement ffmpeg is transcode and receives init then media on a new writer", async () => {

    const rotationEvents: { poisoned: BackpressureWriter; replacement: BackpressureWriter }[] = [];
    let createTsbResumeCalls = 0;
    const ctx = createHarness({

      delegateTestOptions: {

        onRotateSegmentWriter: (event) => rotationEvents.push(event),
        recordCreateTsbResumeInvocation: () => {

          createTsbResumeCalls += 1;
        }
      }
    });
    const bufferSub = makeControllableLivestreamDouble({ initSegment: MATCHING_INIT_LIVESTREAM });
    const streamSub = makeControllableLivestreamDouble({ initSegment: MATCHING_INIT_LIVESTREAM });
    const liveSub = streamSub;
    const bufferedKeyframe = makeKeyframeFragment();
    const bufferedTail = makeNonKeyframeFragment();

    ctx.host.livestreamSubscriptions = [bufferSub];

    const buffer = await wireRealTimeshiftBuffer(ctx, bufferSub);

    bufferSub.push({ ...MATCHING_INIT_LIVESTREAM, type: "init" });
    await settle();
    bufferSub.push({ data: bufferedKeyframe.data, mdat: bufferedKeyframe.mdat, moof: bufferedKeyframe.moof, type: "media" });
    await settle();
    bufferSub.push({ data: bufferedTail.data, mdat: bufferedTail.mdat, moof: bufferedTail.moof, type: "media" });
    await settle();

    const expectedPrime = buffer.getInitPlusTrailingFromLastKeyframe();

    assert.ok(expectedPrime, "timeshift buffer retains a keyframe for priming");

    assert.ok(expectedPrime);

    ctx.host.livestreamSubscriptions = [streamSub];

    const copyFailureLine = VIDEO_COPY_FAILURE_PATTERNS[1] ?? "Error initializing output stream";
    let spawnIndex = 0;

    setLiveVideoFfmpegSpawnerForTests((_ffmpegOptions, init) => {

      spawnIndex += 1;

      if(spawnIndex === 1) {

        const copy = new TestLiveStreamingFfmpegProcess("copy-fail", {

          blockStdin: true,
          pipeBreakOnTeardown: true,
          signal: init.signal,
          stderrLog: [copyFailureLine]
        });

        setTimeout(() => {

          copy.abort();
        }, 500);
        ctx.spawnedArgs.push(init.args ?? []);
        ctx.spawnedProcesses.push(copy);

        return copy as unknown as ProtectStreamingFfmpegProcess;
      }

      const replacement = new TestLiveStreamingFfmpegProcess("transcode-replacement", { signal: init.signal });

      ctx.spawnedArgs.push(init.args ?? []);
      ctx.spawnedProcesses.push(replacement);

      return replacement as unknown as ProtectStreamingFfmpegProcess;
    });

    const liveLead = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 3500, sequenceNumber: 10 });

    const startPromise = prepareAndStart(ctx);

    liveSub.push({ data: liveLead.data, mdat: liveLead.mdat, moof: liveLead.moof, type: "media" });
    await startPromise;

    await waitFor(() => ctx.spawnedProcesses.length >= 2, "copy escalation replacement spawn", 25000);

    await waitFor(() => createTsbResumeCalls >= 1, "createTsbResume on copy escalation", 25000);
    await waitFor(() => rotationEvents.length >= 1, "TSB writer rotation on escalation", 25000);

    assert.equal(createTsbResumeCalls, 1, "copy escalation must invoke createTsbResume exactly once");

    const copyProcess = ctx.spawnedProcesses[0];
    const replacement = ctx.spawnedProcesses[1];
    const copyWritesBeforeFollowup = copyProcess?.stdinWrites.length ?? 0;
    const { poisoned, replacement: rotatedWriter } = rotationEvents[0] ?? {};

    assert.ok(poisoned);
    assert.ok(rotatedWriter);
    assert.notEqual(poisoned, rotatedWriter);
    assert.ok(poisoned.signal.aborted, "copy-phase BackpressureWriter must be aborted on rotation");

    assert.ok(replacement);
    assert.equal(argsUseVideoCopy(ctx.spawnedArgs[0] ?? []), true);
    assert.equal(argsUseVideoCopy(ctx.spawnedArgs[1] ?? []), false);

    await waitFor(() => (replacement.stdinWrites.length >= 1), "replacement receives primed stdin", 15000);

    const primed = replacement.stdinWrites[0] ?? Buffer.alloc(0);

    assert.ok(expectedPrime.equals(primed), "primed stdin must match init plus keyframe tail from the real buffer");
    assert.ok(primed.length > MATCHING_INIT.length, "primed buffer must include media after init");
    assert.equal(replacement.stdinWrites.length, 1, "primed buffer must be a single stdin write before live media continues");

    const followUp = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 4000, sequenceNumber: 11 });

    liveSub.push({ data: followUp.data, mdat: followUp.mdat, moof: followUp.moof, type: "media" });

    await waitFor(() => ((replacement.stdinWrites.length >= 2) && ((copyProcess?.stdinWrites.length ?? 0) === copyWritesBeforeFollowup)),
      "post-escalation media routes to replacement only");

    const followWrite = replacement.stdinWrites[1] ?? Buffer.alloc(0);

    assert.ok(followWrite.equals(followUp.data));
    assert.ok(!expectedPrime.equals(followWrite), "live media must not repeat the primed init-plus-keyframe-tail blob");

    const fragmentTwo = makeNonKeyframeFragment(undefined, { baseMediaDecodeTime: 5000, sequenceNumber: 12 });

    liveSub.push({ data: fragmentTwo.data, mdat: fragmentTwo.mdat, moof: fragmentTwo.moof, type: "media" });

    await waitFor(() => replacement.stdinWrites.length >= 3, "third live fragment after prime");

    const thirdWrite = replacement.stdinWrites[2] ?? Buffer.alloc(0);

    assert.ok(thirdWrite.equals(fragmentTwo.data), "each live fragment must reach replacement ffmpeg once, in order");

    liveSub.push({ data: followUp.data, discontinuity: true, mdat: followUp.mdat, moof: followUp.moof, type: "media" });

    await waitFor(() => replacement.stdin.writableEnded, "discontinuity ends the active replacement stdin");
  });

  test("copy failure pooled livestream shared feed: buffer absorbs esc fragment and full stdin is prime then esc once", async () => {

    const ESC_WINDOW_TAG = 0xE7A1;
    const TAIL_TAG = 0xE7B2;

    const tagMarker = (tag: number): Buffer => Buffer.from([ tag & 0xFF, (tag >> 8) & 0xFF ]);

    const countTagOccurrences = (bytes: Buffer, tag: number): number => {

      const marker = tagMarker(tag);
      let count = 0;
      let from = 0;

      while(from <= bytes.length - marker.length) {

        const at = bytes.indexOf(marker, from);

        if(at < 0) {

          break;
        }

        count += 1;
        from = at + marker.length;
      }

      return count;
    };

    const pooled = makePooledSharedFeedCouple();
    const rotationEvents: { poisoned: BackpressureWriter; replacement: BackpressureWriter }[] = [];
    const ctx = createHarness({

      delegateTestOptions: {

        onRotateSegmentWriter: (event) => rotationEvents.push(event)
      }
    });

    ctx.host.livestreamSubscriptions = [pooled.bufferSub];

    const buffer = await wireRealTimeshiftBuffer(ctx, pooled.bufferSub);
    const bufferedKeyframe = makeKeyframeFragment();
    const bufferedTail = makeNonKeyframeFragment(0xE700);

    pooled.pushInitToBuffer();
    await settle();
    pooled.pushMediaToBuffer(bufferedKeyframe);
    await settle();
    pooled.pushMediaToBuffer(bufferedTail);
    await settle();

    const expectedPrime = buffer.getInitPlusTrailingFromLastKeyframe();

    assert.ok(expectedPrime);
    assert.ok(!expectedPrime.includes(tagMarker(ESC_WINDOW_TAG)));

    ctx.host.livestreamSubscriptions = [pooled.streamSub];

    const copyFailureLine = VIDEO_COPY_FAILURE_PATTERNS[1] ?? "Error initializing output stream";
    const escWindowFragment = makeNonKeyframeFragment(ESC_WINDOW_TAG, { baseMediaDecodeTime: 8000, sequenceNumber: 20 });
    let spawnIndex = 0;

    setLiveVideoFfmpegSpawnerForTests((_ffmpegOptions, init) => {

      spawnIndex += 1;

      if(spawnIndex === 1) {

        const copy = new TestLiveStreamingFfmpegProcess("copy-fail-pooled", {

          blockStdin: true,
          pipeBreakOnTeardown: false,
          signal: init.signal,
          stderrLog: [copyFailureLine]
        });

        setTimeout(() => {

          copy.abort();
          pooled.pushMediaToBoth(escWindowFragment);
        }, 500);
        ctx.spawnedArgs.push(init.args ?? []);
        ctx.spawnedProcesses.push(copy);

        return copy as unknown as ProtectStreamingFfmpegProcess;
      }

      const replacement = new TestLiveStreamingFfmpegProcess("transcode-replacement-pooled", { signal: init.signal });

      ctx.spawnedArgs.push(init.args ?? []);
      ctx.spawnedProcesses.push(replacement);

      return replacement as unknown as ProtectStreamingFfmpegProcess;
    });

    await prepareAndStart(ctx);

    await waitFor(() => ctx.spawnedProcesses.length >= 2, "pooled copy escalation replacement spawn", 25000);
    await waitFor(() => rotationEvents.length >= 1, "pooled TSB writer rotation on escalation", 25000);

    const replacement = ctx.spawnedProcesses[1];

    assert.ok(replacement);

    await waitFor(() => {

      const trailing = buffer.getInitPlusTrailingFromLastKeyframe() ?? Buffer.alloc(0);

      return trailing.includes(tagMarker(ESC_WINDOW_TAG));
    }, "timeshift buffer absorbed escalation-window fragment from shared pooled feed", 8000);

    await waitFor(() => replacement.stdinWrites.length >= 2, "replacement receives prime and live writes", 8000);

    const tailFragment = makeNonKeyframeFragment(TAIL_TAG, { baseMediaDecodeTime: 9000, sequenceNumber: 21 });

    pooled.pushMediaToBoth(tailFragment);

    await waitFor(() => replacement.stdin.writableEnded || (replacement.stdinWrites.length >= 3), "tail fragment after esc", 8000);

    const allStdin = Buffer.concat(replacement.stdinWrites);
    const expectedStdin = Buffer.concat([ expectedPrime, escWindowFragment.data, tailFragment.data ]);

    assert.ok(allStdin.equals(expectedStdin), "pooled copy escalation stdin must equal prime then esc then tail with no duplication");

    assert.equal(countTagOccurrences(allStdin, ESC_WINDOW_TAG), 1, "esc tag must appear exactly once in the full stdin byte stream");
    assert.equal(countTagOccurrences(allStdin, TAIL_TAG), 1, "tail tag must appear exactly once in the full stdin byte stream");
    assert.ok(allStdin.indexOf(tagMarker(ESC_WINDOW_TAG)) >= expectedPrime.length,
      "esc fragment must follow the primed snapshot in stdin order");
  });

  test("copy failure pooled livestream: esc already in buffer before prime snapshot appears once in full stdin", async () => {

    const ESC_WINDOW_TAG = 0xC0DE;
    const TAIL_TAG = 0xC1DE;

    const tagMarker = (tag: number): Buffer => Buffer.from([ tag & 0xFF, (tag >> 8) & 0xFF ]);

    const countTagInBuffer = (bytes: Buffer, tag: number): number => {

      const marker = tagMarker(tag);
      let count = 0;
      let from = 0;

      while(from <= bytes.length - marker.length) {

        const at = bytes.indexOf(marker, from);

        if(at < 0) {

          break;
        }

        count += 1;
        from = at + marker.length;
      }

      return count;
    };

    const pooled = makePooledSharedFeedCouple();
    const ctx = createHarness();

    ctx.host.livestreamSubscriptions = [pooled.bufferSub];

    const buffer = await wireRealTimeshiftBuffer(ctx, pooled.bufferSub);
    const bufferedKeyframe = makeKeyframeFragment();
    const escPrePrime = makeNonKeyframeFragment(ESC_WINDOW_TAG, { baseMediaDecodeTime: 6000, sequenceNumber: 15 });

    pooled.pushInitToBuffer();
    await settle();
    pooled.pushMediaToBuffer(bufferedKeyframe);
    await settle();
    pooled.pushMediaToBoth(escPrePrime);
    await settle();

    const primeBeforeLive = buffer.getInitPlusTrailingFromLastKeyframe();

    assert.ok(primeBeforeLive?.includes(tagMarker(ESC_WINDOW_TAG)), "esc must be in buffer trailing before live session starts");

    ctx.host.livestreamSubscriptions = [pooled.streamSub];

    const copyFailureLine = VIDEO_COPY_FAILURE_PATTERNS[1] ?? "Error initializing output stream";
    let spawnIndex = 0;

    setLiveVideoFfmpegSpawnerForTests((_ffmpegOptions, init) => {

      spawnIndex += 1;

      if(spawnIndex === 1) {

        const copy = new TestLiveStreamingFfmpegProcess("copy-fail-pooled-pre-absorbed", {

          blockStdin: true,
          pipeBreakOnTeardown: false,
          signal: init.signal,
          stderrLog: [copyFailureLine]
        });

        setTimeout(() => {

          copy.abort();
        }, 500);
        ctx.spawnedArgs.push(init.args ?? []);
        ctx.spawnedProcesses.push(copy);

        return copy as unknown as ProtectStreamingFfmpegProcess;
      }

      const replacement = new TestLiveStreamingFfmpegProcess("transcode-replacement-pooled-pre-absorbed", { signal: init.signal });

      ctx.spawnedArgs.push(init.args ?? []);
      ctx.spawnedProcesses.push(replacement);

      return replacement as unknown as ProtectStreamingFfmpegProcess;
    });

    await prepareAndStart(ctx);

    await waitFor(() => ctx.spawnedProcesses.length >= 2, "pooled pre-absorbed esc replacement spawn", 25000);

    const replacement = ctx.spawnedProcesses[1];

    assert.ok(replacement);

    await waitFor(() => replacement.stdinWrites.length >= 1, "replacement stdin after pre-absorbed esc", 8000);

    const tailFragment = makeNonKeyframeFragment(TAIL_TAG, { baseMediaDecodeTime: 7000, sequenceNumber: 16 });

    pooled.pushMediaToBoth(tailFragment);
    await waitFor(() => replacement.stdinWrites.length >= 2, "tail after pre-absorbed esc", 8000);

    const allStdin = Buffer.concat(replacement.stdinWrites);
    const escInBuffer = countTagInBuffer(primeBeforeLive ?? Buffer.alloc(0), ESC_WINDOW_TAG);

    assert.equal(countTagInBuffer(allStdin, ESC_WINDOW_TAG), escInBuffer,
      "esc must not be duplicated when it was already in the buffer before escalation");

    const expectedStdin = Buffer.concat([ primeBeforeLive ?? Buffer.alloc(0), tailFragment.data ]);

    assert.ok(allStdin.equals(expectedStdin), "stdin must be the buffer prime including pre-absorbed esc then tail only");
  });

  test("copy failure pooled livestream: lagging session drops duplicate esc (full stdin)", async () => {

    const ESC_TAG = 0xD1A1;
    const TAIL_TAG = 0xD1B2;
    const tagMarker = (tag: number): Buffer => Buffer.from([ tag & 0xFF, (tag >> 8) & 0xFF ]);
    const escTiming = { baseMediaDecodeTime: 50000, sequenceNumber: 42 };

    const pooled = makePooledSharedFeedCouple();
    const ctx = createHarness();

    ctx.host.livestreamSubscriptions = [pooled.bufferSub];

    const buffer = await wireRealTimeshiftBuffer(ctx, pooled.bufferSub);
    const bufferedKeyframe = makeKeyframeFragment();
    const bufferedTail = makeNonKeyframeFragment(0xD100, { baseMediaDecodeTime: 40000, sequenceNumber: 41 });

    pooled.pushInitToBuffer();
    await settle();
    pooled.pushMediaToBuffer(bufferedKeyframe);
    await settle();
    pooled.pushMediaToBuffer(bufferedTail);
    await settle();

    const escWindowFragment = makeNonKeyframeFragment(ESC_TAG, escTiming);

    pooled.pushMediaToBuffer(escWindowFragment);
    await settle();

    const expectedPrime = buffer.getInitPlusTrailingFromLastKeyframe();

    assert.ok(expectedPrime?.includes(tagMarker(ESC_TAG)));

    ctx.host.livestreamSubscriptions = [pooled.streamSub];

    const copyFailureLine = VIDEO_COPY_FAILURE_PATTERNS[1] ?? "Error initializing output stream";
    let spawnIndex = 0;

    setLiveVideoFfmpegSpawnerForTests((_ffmpegOptions, init) => {

      spawnIndex += 1;

      if(spawnIndex === 1) {

        const copy = new TestLiveStreamingFfmpegProcess("copy-fail-pooled-lag", {

          blockStdin: true,
          pipeBreakOnTeardown: false,
          signal: init.signal,
          stderrLog: [copyFailureLine]
        });

        setTimeout(() => {

          copy.abort();
          pooled.pushMediaToStream(escWindowFragment);
        }, 500);
        ctx.spawnedArgs.push(init.args ?? []);
        ctx.spawnedProcesses.push(copy);

        return copy as unknown as ProtectStreamingFfmpegProcess;
      }

      const replacement = new TestLiveStreamingFfmpegProcess("transcode-replacement-pooled-lag", { signal: init.signal });

      ctx.spawnedArgs.push(init.args ?? []);
      ctx.spawnedProcesses.push(replacement);

      return replacement as unknown as ProtectStreamingFfmpegProcess;
    });

    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });

    await prepareAndStart(ctx);

    await waitFor(() => ctx.spawnedProcesses.length >= 2, "lagging-session replacement spawn", 25000);

    const replacement = ctx.spawnedProcesses[1];

    assert.ok(replacement);

    const tailFragment = makeNonKeyframeFragment(TAIL_TAG, { baseMediaDecodeTime: 51000, sequenceNumber: 43 });

    pooled.pushMediaToBoth(tailFragment);

    await waitFor(() => replacement.stdinWrites.length >= 2, "lagging-session tail stdin", 8000);

    const allStdin = Buffer.concat(replacement.stdinWrites);
    const expectedStdin = Buffer.concat([ expectedPrime ?? Buffer.alloc(0), tailFragment.data ]);

    assert.ok(allStdin.equals(expectedStdin), "lagging pooled reader must not duplicate primed esc fragment on replacement stdin");
  });

  test("copy failure pooled livestream: session-ahead media after prime is not dropped", async () => {

    const AHEAD_TAG = 0xA1A1;
    const pooled = makePooledSharedFeedCouple();
    const ctx = createHarness();

    ctx.host.livestreamSubscriptions = [pooled.bufferSub];

    const buffer = await wireRealTimeshiftBuffer(ctx, pooled.bufferSub);

    pooled.pushInitToBuffer();
    await settle();
    pooled.pushMediaToBuffer(makeKeyframeFragment());
    await settle();

    const expectedPrime = buffer.getInitPlusTrailingFromLastKeyframe();

    assert.ok(expectedPrime);

    ctx.host.livestreamSubscriptions = [pooled.streamSub];

    const aheadFragment = makeNonKeyframeFragment(AHEAD_TAG, { baseMediaDecodeTime: 90000, sequenceNumber: 99 });

    const copyFailureLine = VIDEO_COPY_FAILURE_PATTERNS[1] ?? "Error initializing output stream";
    let spawnIndex = 0;

    setLiveVideoFfmpegSpawnerForTests((_ffmpegOptions, init) => {

      spawnIndex += 1;

      if(spawnIndex === 1) {

        const copy = new TestLiveStreamingFfmpegProcess("copy-fail-ahead", { blockStdin: true, pipeBreakOnTeardown: false, signal: init.signal,
          stderrLog: [copyFailureLine] });

        setTimeout(() => {

          copy.abort();
        }, 500);
        ctx.spawnedArgs.push(init.args ?? []);
        ctx.spawnedProcesses.push(copy);

        return copy as unknown as ProtectStreamingFfmpegProcess;
      }

      const replacement = new TestLiveStreamingFfmpegProcess("transcode-replacement-ahead", { signal: init.signal });

      ctx.spawnedArgs.push(init.args ?? []);
      ctx.spawnedProcesses.push(replacement);

      return replacement as unknown as ProtectStreamingFfmpegProcess;
    });

    await prepareAndStart(ctx);

    await waitFor(() => ctx.spawnedProcesses.length >= 2, "ahead replacement spawn", 25000);

    const replacement = ctx.spawnedProcesses[1];

    assert.ok(replacement);

    pooled.pushMediaToStream(aheadFragment);
    await settle();

    await waitFor(() => replacement.stdinWrites.length >= 2, "ahead fragment on stdin", 8000);

    const allStdin = Buffer.concat(replacement.stdinWrites);
    const tagMarker = Buffer.from([ AHEAD_TAG & 0xFF, (AHEAD_TAG >> 8) & 0xFF ]);

    assert.ok(allStdin.includes(tagMarker), "session-ahead fragment must still be written after prime");
    assert.ok(allStdin.equals(Buffer.concat([ expectedPrime, aheadFragment.data ])));
  });

  test("copy failure pooled livestream: alternate track at prime decode time is not dropped", async () => {

    const ALT_TRACK_TAG = 0xA2C3;
    const pooled = makePooledSharedFeedCouple();
    const ctx = createHarness();

    ctx.host.livestreamSubscriptions = [pooled.bufferSub];

    const buffer = await wireRealTimeshiftBuffer(ctx, pooled.bufferSub);

    pooled.pushInitToBuffer();
    await settle();
    pooled.pushMediaToBuffer(makeKeyframeFragment());
    await settle();
    pooled.pushMediaToBuffer(makeNonKeyframeFragment(0xA200, { baseMediaDecodeTime: 3000, sequenceNumber: 2, trackId: 1 }));
    await settle();

    const expectedPrime = buffer.getInitPlusTrailingFromLastKeyframe();

    assert.ok(expectedPrime);

    ctx.host.livestreamSubscriptions = [pooled.streamSub];

    const copyFailureLine = VIDEO_COPY_FAILURE_PATTERNS[1] ?? "Error initializing output stream";
    let spawnIndex = 0;

    setLiveVideoFfmpegSpawnerForTests((_ffmpegOptions, init) => {

      spawnIndex += 1;

      if(spawnIndex === 1) {

        const copy = new TestLiveStreamingFfmpegProcess("copy-fail-alt-track", { blockStdin: true, pipeBreakOnTeardown: false, signal: init.signal,
          stderrLog: [copyFailureLine] });

        setTimeout(() => {

          copy.abort();
        }, 500);
        ctx.spawnedArgs.push(init.args ?? []);
        ctx.spawnedProcesses.push(copy);

        return copy as unknown as ProtectStreamingFfmpegProcess;
      }

      const replacement = new TestLiveStreamingFfmpegProcess("transcode-replacement-alt-track", { signal: init.signal });

      ctx.spawnedArgs.push(init.args ?? []);
      ctx.spawnedProcesses.push(replacement);

      return replacement as unknown as ProtectStreamingFfmpegProcess;
    });

    await prepareAndStart(ctx);

    await waitFor(() => ctx.spawnedProcesses.length >= 2, "alternate-track replacement spawn", 25000);

    const replacement = ctx.spawnedProcesses[1];

    assert.ok(replacement);

    const altTrackFragment = makeNonKeyframeFragment(ALT_TRACK_TAG, { baseMediaDecodeTime: 3000, sequenceNumber: 3, trackId: 2 });

    pooled.pushMediaToStream(altTrackFragment);
    await settle();

    await waitFor(() => replacement.stdinWrites.length >= 2, "alternate track live stdin", 8000);

    const allStdin = Buffer.concat(replacement.stdinWrites);

    assert.ok(allStdin.equals(Buffer.concat([ expectedPrime, altTrackFragment.data ])),
      "a live fragment on another track with the same decode time as the prime floor must still be forwarded");
  });

  test("copy failure pooled livestream: unreadable fragment identity keeps duplicate esc on lagging session", async () => {

    const ESC_TAG = 0xB1B1;
    const tagMarker = (tag: number): Buffer => Buffer.from([ tag & 0xFF, (tag >> 8) & 0xFF ]);

    const pooled = makePooledSharedFeedCouple();
    const ctx = createHarness();

    ctx.host.livestreamSubscriptions = [pooled.bufferSub];

    const buffer = await wireRealTimeshiftBuffer(ctx, pooled.bufferSub);

    pooled.pushInitToBuffer();
    await settle();
    pooled.pushMediaToBuffer(makeKeyframeFragment());
    await settle();

    const escUntimed = makeUntimedNonKeyframeFragment(ESC_TAG);

    pooled.pushMediaToBuffer(escUntimed);
    await settle();

    const expectedPrime = buffer.getInitPlusTrailingFromLastKeyframe();

    assert.ok(expectedPrime?.includes(tagMarker(ESC_TAG)));

    ctx.host.livestreamSubscriptions = [pooled.streamSub];

    const copyFailureLine = VIDEO_COPY_FAILURE_PATTERNS[1] ?? "Error initializing output stream";
    let spawnIndex = 0;

    setLiveVideoFfmpegSpawnerForTests((_ffmpegOptions, init) => {

      spawnIndex += 1;

      if(spawnIndex === 1) {

        const copy = new TestLiveStreamingFfmpegProcess("copy-fail-unreadable-id", { blockStdin: true, pipeBreakOnTeardown: false, signal: init.signal,
          stderrLog: [copyFailureLine] });

        queueMicrotask(() => {

          copy.abort();
        });
        ctx.spawnedArgs.push(init.args ?? []);
        ctx.spawnedProcesses.push(copy);

        return copy as unknown as ProtectStreamingFfmpegProcess;
      }

      const replacement = new TestLiveStreamingFfmpegProcess("transcode-replacement-unreadable-id", { signal: init.signal });

      ctx.spawnedArgs.push(init.args ?? []);
      ctx.spawnedProcesses.push(replacement);
      queueMicrotask(() => {

        pooled.pushMediaToStream(escUntimed);
      });

      return replacement as unknown as ProtectStreamingFfmpegProcess;
    });

    await prepareAndStart(ctx);

    await waitFor(() => ctx.spawnedProcesses.length >= 2, "unreadable-id replacement spawn", 25000);

    const replacement = ctx.spawnedProcesses[1];

    assert.ok(replacement);

    await waitFor(() => replacement.stdinWrites.length >= 2, "unreadable-id duplicate esc on live path", 8000);

    const allStdin = Buffer.concat(replacement.stdinWrites);

    assert.ok(allStdin.equals(Buffer.concat([ expectedPrime ?? Buffer.alloc(0), escUntimed.data ])),
      "without tfdt/mfhd on the floor fragment, dedup must not drop the lagging live copy");
  });

  test("copy escalation init-only prime when buffer channel id differs from live subscription (PM3)", async () => {

    const ctx = createHarness();
    const bufferSub = makeControllableLivestreamDouble({ initSegment: MATCHING_INIT_LIVESTREAM });
    const streamSub = makeControllableLivestreamDouble({ initSegment: MATCHING_INIT_LIVESTREAM });

    ctx.host.livestreamSubscriptions = [bufferSub];
    const buffer = await wireRealTimeshiftBuffer(ctx, bufferSub);

    bufferSub.push({ ...MATCHING_INIT_LIVESTREAM, type: "init" });
    await settle();
    const bufferedKeyframe = makeKeyframeFragment();

    bufferSub.push({ data: bufferedKeyframe.data, mdat: bufferedKeyframe.mdat, moof: bufferedKeyframe.moof, type: "media" });
    await settle();

    const expectedPrime = buffer.getInitPlusTrailingFromLastKeyframe();

    assert.ok(expectedPrime);

    ctx.host.livestreamSubscriptions = [streamSub];

    const copyFailureLine = VIDEO_COPY_FAILURE_PATTERNS[1] ?? "Error initializing output stream";
    let spawnIndex = 0;

    setLiveVideoFfmpegSpawnerForTests((_ffmpegOptions, init) => {

      spawnIndex += 1;

      if(spawnIndex === 1) {

        const copy = new TestLiveStreamingFfmpegProcess("copy-fail", { blockStdin: true, pipeBreakOnTeardown: false, signal: init.signal,
          stderrLog: [copyFailureLine] });

        setTimeout(() => {

          (buffer as unknown as { _channelProfile: ChannelProfile })._channelProfile = { ...stubChannel,
            channel: { ...stubChannel.channel, id: 99, name: "mismatch" } };
          copy.abort();
        }, 500);
        ctx.spawnedArgs.push(init.args ?? []);
        ctx.spawnedProcesses.push(copy);

        return copy as unknown as ProtectStreamingFfmpegProcess;
      }

      const replacement = new TestLiveStreamingFfmpegProcess("transcode-replacement", { signal: init.signal });

      ctx.spawnedArgs.push(init.args ?? []);
      ctx.spawnedProcesses.push(replacement);

      return replacement as unknown as ProtectStreamingFfmpegProcess;
    });

    const liveLead = makeNonKeyframeFragment();
    const startPromise = prepareAndStart(ctx);

    streamSub.push({ data: liveLead.data, mdat: liveLead.mdat, moof: liveLead.moof, type: "media" });
    await startPromise;
    await waitFor(() => ctx.spawnedProcesses.length >= 2, "copy escalation replacement spawn", 25000);

    const replacement = ctx.spawnedProcesses[1];

    assert.ok(replacement);

    await waitFor(() => (replacement.stdinWrites.length >= 1), "replacement receives primed stdin", 15000);

    const primed = replacement.stdinWrites[0] ?? Buffer.alloc(0);

    assert.ok(MATCHING_INIT.equals(primed), "channel id mismatch must prime init segment only");
    assert.ok(!expectedPrime.equals(primed));
  });

  test("copy escalation init-only prime when buffer lens differs from live subscription (PM3 lens)", async () => {

    const ctx = createHarness();
    const bufferSub = makeControllableLivestreamDouble({ initSegment: MATCHING_INIT_LIVESTREAM });
    const streamSub = makeControllableLivestreamDouble({ initSegment: MATCHING_INIT_LIVESTREAM });
    const bufferProfile: ChannelProfile = { ...stubChannel, lens: 0 };

    ctx.host.livestreamSubscriptions = [bufferSub];
    const buffer = await wireRealTimeshiftBuffer(ctx, bufferSub, bufferProfile);

    bufferSub.push({ ...MATCHING_INIT_LIVESTREAM, type: "init" });
    await settle();
    const bufferedKeyframe = makeKeyframeFragment();

    bufferSub.push({ data: bufferedKeyframe.data, mdat: bufferedKeyframe.mdat, moof: bufferedKeyframe.moof, type: "media" });
    await settle();

    const expectedPrime = buffer.getInitPlusTrailingFromLastKeyframe();

    assert.ok(expectedPrime);

    ctx.host.livestreamSubscriptions = [streamSub];

    const copyFailureLine = VIDEO_COPY_FAILURE_PATTERNS[1] ?? "Error initializing output stream";
    let spawnIndex = 0;

    setLiveVideoFfmpegSpawnerForTests((_ffmpegOptions, init) => {

      spawnIndex += 1;

      if(spawnIndex === 1) {

        const copy = new TestLiveStreamingFfmpegProcess("copy-fail", { blockStdin: true, pipeBreakOnTeardown: false, signal: init.signal,
          stderrLog: [copyFailureLine] });

        setTimeout(() => {

          (buffer as unknown as { _channelProfile: ChannelProfile })._channelProfile = { ...bufferProfile, lens: 1 };
          copy.abort();
        }, 500);
        ctx.spawnedArgs.push(init.args ?? []);
        ctx.spawnedProcesses.push(copy);

        return copy as unknown as ProtectStreamingFfmpegProcess;
      }

      const replacement = new TestLiveStreamingFfmpegProcess("transcode-replacement", { signal: init.signal });

      ctx.spawnedArgs.push(init.args ?? []);
      ctx.spawnedProcesses.push(replacement);

      return replacement as unknown as ProtectStreamingFfmpegProcess;
    });

    const liveLead = makeNonKeyframeFragment();
    const startPromise = prepareAndStart(ctx);

    streamSub.push({ data: liveLead.data, mdat: liveLead.mdat, moof: liveLead.moof, type: "media" });
    await startPromise;
    await waitFor(() => ctx.spawnedProcesses.length >= 2, "copy escalation replacement spawn", 25000);

    const replacement = ctx.spawnedProcesses[1];

    assert.ok(replacement);

    await waitFor(() => (replacement.stdinWrites.length >= 1), "replacement receives primed stdin", 15000);

    const primed = replacement.stdinWrites[0] ?? Buffer.alloc(0);

    assert.ok(MATCHING_INIT.equals(primed), "lens mismatch must prime init segment only");
    assert.ok(!expectedPrime.equals(primed));
  });

  test("RTSP debug livestream uses init-only copy-escalation prime (separate pooled encoders)", async () => {

    const ctx = createHarness();
    const defaultHasFeature = ctx.host.hasFeature.bind(ctx.host);

    const bufferSub = makeControllableLivestreamDouble({ initSegment: MATCHING_INIT_LIVESTREAM });
    const streamSub = makeControllableLivestreamDouble({ initSegment: MATCHING_INIT_LIVESTREAM });

    ctx.host.livestreamSubscriptions = [bufferSub];
    const buffer = await wireRealTimeshiftBuffer(ctx, bufferSub);

    bufferSub.push({ ...MATCHING_INIT_LIVESTREAM, type: "init" });
    await settle();
    const bufferedKeyframe = makeKeyframeFragment();

    bufferSub.push({ data: bufferedKeyframe.data, mdat: bufferedKeyframe.mdat, moof: bufferedKeyframe.moof, type: "media" });
    await settle();
    const bufferedTail = makeNonKeyframeFragment();

    bufferSub.push({ data: bufferedTail.data, mdat: bufferedTail.mdat, moof: bufferedTail.moof, type: "media" });
    await settle();

    await waitFor(() => buffer.getInitPlusTrailingFromLastKeyframe() !== null, "buffer keyframe before RTSP session");

    const expectedPrime = buffer.getInitPlusTrailingFromLastKeyframe();

    assert.ok(expectedPrime, "buffer retains keyframe for RTSP-debug case");

    ctx.host.hasFeature = (option: string): boolean => (option === "Debug.Video.Timeshift.UseRtsp") ? true : defaultHasFeature(option);
    ctx.host.livestreamSubscriptions = [streamSub];

    const copyFailureLine = VIDEO_COPY_FAILURE_PATTERNS[1] ?? "Error initializing output stream";
    let spawnIndex = 0;

    setLiveVideoFfmpegSpawnerForTests((_ffmpegOptions, init) => {

      spawnIndex += 1;

      if(spawnIndex === 1) {

        const copy = new TestLiveStreamingFfmpegProcess("copy-fail", { blockStdin: true, pipeBreakOnTeardown: false, signal: init.signal,
          stderrLog: [copyFailureLine] });

        setTimeout(() => copy.abort(), 500);
        ctx.spawnedArgs.push(init.args ?? []);
        ctx.spawnedProcesses.push(copy);

        return copy as unknown as ProtectStreamingFfmpegProcess;
      }

      const replacement = new TestLiveStreamingFfmpegProcess("transcode-replacement", { signal: init.signal });

      ctx.spawnedArgs.push(init.args ?? []);
      ctx.spawnedProcesses.push(replacement);

      return replacement as unknown as ProtectStreamingFfmpegProcess;
    });

    const liveLead = makeNonKeyframeFragment();
    const startPromise = prepareAndStart(ctx);

    streamSub.push({ data: liveLead.data, mdat: liveLead.mdat, moof: liveLead.moof, type: "media" });
    await startPromise;
    await waitFor(() => ctx.spawnedProcesses.length >= 2, "RTSP-debug copy escalation", 25000);

    const replacement = ctx.spawnedProcesses[1];

    assert.ok(replacement);

    await waitFor(() => (replacement.stdinWrites.length >= 1), "replacement stdin", 15000);

    const primed = replacement.stdinWrites[0] ?? Buffer.alloc(0);

    assert.ok(MATCHING_INIT.equals(primed), "RTSP debug must not mix buffer keyframe tail across separate livestream encoders");
    assert.ok(!expectedPrime.equals(primed));
  });

  test("RTSP H.264 hardware transcode reselect biases 4K channel at startStream (BD7w)", async () => {

    const ctx = createHarness();
    const baseOptions = ctx.delegate.ffmpegOptions;
    const hardwareFfmpegOptions: ProtectStreamingDelegate["ffmpegOptions"] = new Proxy(baseOptions, {

      get(target, property, receiver): unknown {

        if(property === "hardwareEncodes") {

          return (role: string): boolean => role === "stream";
        }

        const value: unknown = Reflect.get(target, property, receiver);

        return typeof value === "function" ? value.bind(target) : value;
      }
    });

    Object.defineProperty(ctx.delegate, "ffmpegOptions", { value: hardwareFfmpegOptions });
    ctx.host.usesTimeshiftLivestream = false;
    ctx.timeshift.buffer.isStarted = false;

    let selectCall: { bias?: string; height: number; maxPixels?: number; width: number } | undefined;

    ctx.host.selectChannel = (width: number, height: number, options: SelectChannelOptions): ChannelProfile => {

      selectCall = { bias: options.bias, height: height, maxPixels: options.maxPixels, width: width };

      return stubChannel;
    };

    await prepareAndStart(ctx);

    assert.ok(selectCall, "copy-first RTSP transcode must reselect a source channel");
    assert.equal(selectCall.width, 3840);
    assert.equal(selectCall.height, 2160);
    assert.equal(selectCall.bias, "higher");
    assert.ok((selectCall.maxPixels ?? 0) > 0);
    assert.equal(argsUseVideoCopy(ctx.spawnedArgs[0] ?? []), false);
  });

  test("bufferDegraded AV1 hardware path selects 4K-biased channel at startStream (BD7)", async () => {

    const ctx = createHarness({ transcodeBitrateKbps: 900, videoCodec: "av1" });
    const baseOptions = ctx.delegate.ffmpegOptions;
    const hardwareFfmpegOptions: ProtectStreamingDelegate["ffmpegOptions"] = new Proxy(baseOptions, {

      get(target, property, receiver): unknown {

        if(property === "hardwareEncodes") {

          return (role: string): boolean => role === "stream";
        }

        const value: unknown = Reflect.get(target, property, receiver);

        return typeof value === "function" ? value.bind(target) : value;
      }
    });

    Object.defineProperty(ctx.delegate, "ffmpegOptions", { value: hardwareFfmpegOptions });
    let selectCall: { bias?: string; height: number; maxPixels?: number; width: number } | undefined;

    ctx.timeshift.buffer.isStarted = false;
    ctx.timeshift.buffer.channelProfile = null;
    ctx.timeshift.buffer.getLast = (): null => null;
    ctx.host.selectSubstrateChannel = (): null => null;
    ctx.host.selectChannel = (width: number, height: number, options: SelectChannelOptions): ChannelProfile => {

      selectCall = { bias: options.bias, height: height, maxPixels: options.maxPixels, width: width };

      return stubChannel;
    };

    await prepareAndStart(ctx);

    assert.ok(selectCall);
    assert.equal(selectCall.width, 3840);
    assert.equal(selectCall.height, 2160);
    assert.equal(selectCall.bias, "higher");
    assert.ok((selectCall.maxPixels ?? 0) > 0);
    assert.equal(argsUseVideoCopy(ctx.spawnedArgs[0] ?? []), false);
  });

  test("shouldSubstituteSelectChannelForSession helper: prefix bytes without isStarted (BD4 unit)", () => {

    assert.equal(shouldSubstituteSelectChannelForSession(true, "bufferDegraded", null, true), false,
      "standing prefix blocks selectChannel even when buffer isStarted is false");
  });

});
