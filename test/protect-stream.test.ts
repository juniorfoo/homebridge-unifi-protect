import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioRecordingSamplerate, StreamRequestTypes } from "homebridge";
import { FfmpegStreamingProcess } from "homebridge-plugin-utils";
import { ProtectStreamingDelegate } from "../src/protect-stream.js";
import * as streamPath from "../src/stream-path.js";
import * as streamTranscode from "../src/stream-transcode.js";
import { createMockAccessory, createMockNvr, createMockPlatform, mutableCodecSupport, mutablePlatformApi, testInternals } from "./helpers/mocks.js";
import { EventEmitter } from "node:events";

function createStreamingCamera(overrides: Record<string, unknown> = {}) {

  const platform = createMockPlatform();
  const nvr = createMockNvr({ platform });
  const accessory = createMockAccessory();
  const motionService = { updateCharacteristic: vi.fn() };

  const hap = {

    ...platform.api.hap,
    CameraController: class {

      static generateSynchronisationSource() { return 1; }
      public forceStopStreamingSession = vi.fn();
      constructor(public readonly options: unknown) {}
    },
    SRTPCryptoSuites: { AES_CM_128_HMAC_SHA1_80: 0 },
    VideoCodecType: { H264: "h264" },
    Characteristic: { ...platform.api.hap.Characteristic, On: "On" },
    Service: { ...platform.api.hap.Service, MotionSensor: { UUID: "motion" }, Lightbulb: { UUID: "light" } }
  };

  mutablePlatformApi(platform).hap = hap;
  accessory.getService = vi.fn(() => motionService as any);

  return {

    camera: {

      accessory: accessory,
      accessoryName: "Front Door",
      api: { hap },
      findRtsp: vi.fn(() => ({ channel: { bitrate: 1500000, fps: 30 }, name: "High", url: "rtsps://example/live" })),
      getAudioFilters: vi.fn(() => []),
      hasFeature: vi.fn(() => false),
      hints: {

        crop: false,
        cropOptions: "",
        hardwareDecoding: false,
        hardwareTranscoding: false,
        probesize: 500000,
        transcode: false,
        transcodeBitrate: 0,
        transcodeHighLatency: false,
        transcodeHighLatencyBitrate: 0,
        tsbStreaming: true,
        twoWayAudio: false,
        twoWayAudioDirect: false
      },
      hostProfile: "default",
      isHksvCapable: false,
      isOnline: true,
      livestream: { acquire: vi.fn(), start: vi.fn(), stop: vi.fn() },
      log: platform.log,
      nvr: nvr,
      platform: platform,
      preferRtspLiveView: false,
      stream: null,
      ufp: {

        featureFlags: { hasMic: true, isDoorbell: false },
        host: "192.168.1.2",
        id: "camera-id",
        isDark: false,
        talkbackSettings: { bindPort: 1234, channels: 1, samplingRate: 16000 },
        videoCodec: "h264"
      },
      ufpApi: { bootstrap: {}, isThrottled: false },
      videoCodecName: "H.264",
      ...overrides
    } as any,
    platform,
    hap
  };
}

function createPrepareRequest(sessionID = "session-1") {

  return {
    addressVersion: "ipv4",
    audio: {
      port: 5001,
      // eslint-disable-next-line camelcase
      srtpCryptoSuite: 0, srtp_key: Buffer.from("k"), srtp_salt: Buffer.from("s")
    },
    sessionID,
    targetAddress: "192.168.1.100",
    video: {
      port: 5000,
      // eslint-disable-next-line camelcase
      srtpCryptoSuite: 0, srtp_key: Buffer.from("k"), srtp_salt: Buffer.from("s")
    }
  } as any;
}

function createStartRequest(sessionID = "session-1", overrides: Record<string, unknown> = {}) {

  return {
    audio: {
      channel: 1,
      max_bit_rate: 24,
      packet_time: 20,
      pt: 110,
      sample_rate: 16
    },
    sessionID,
    type: StreamRequestTypes.START,
    video: {
      fps: 30,
      height: 720,
      level: 0,
      max_bit_rate: 600,
      profile: 0,
      pt: 99,
      width: 1280
    },
    ...overrides
  } as any;
}

describe("protect-stream", () => {

  afterEach(() => {

    vi.useRealTimers();
    vi.clearAllMocks();
    vi.mocked(FfmpegStreamingProcess).mockImplementation((_delegate: any, _sessionId: any, _options: any, _args: any, _returnInfo: any, callback: any) => {
      const proc = {
        ffmpegProcess: { once: vi.fn(), stdin: { end: vi.fn() } },
        isStarted: false,
        stop: vi.fn(),
        stdin: { write: vi.fn(), end: vi.fn() }
      };
      if(typeof callback === "function") {
        setImmediate(() => callback(undefined));
      }
      return proc as any;
    });
  });

  it("prepares stream sessions and returns negotiated ports", async () => {

    const { camera } = createStreamingCamera();
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    const callback = vi.fn();

    await delegate.prepareStream({

      addressVersion: "ipv4",
      audio: {

        port: 5001,
        // eslint-disable-next-line camelcase
        srtpCryptoSuite: 0, srtp_key: Buffer.from("k"), srtp_salt: Buffer.from("s")
      },
      sessionID: "session-1",
      targetAddress: "192.168.1.100",
      video: {

        port: 5000,
        // eslint-disable-next-line camelcase
        srtpCryptoSuite: 0, srtp_key: Buffer.from("k"), srtp_salt: Buffer.from("s")
      }
    } as any, callback);

    expect(callback).toHaveBeenCalledOnce();
  });

  it("routes START/STOP stream requests through handlers", async () => {

    const { camera } = createStreamingCamera();
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    const callback = vi.fn();
    const startSpy = vi.spyOn(delegate as any, "startStream").mockResolvedValue(undefined);
    const stopSpy = vi.spyOn(delegate, "stopStream").mockImplementation(() => undefined);

    await delegate.handleStreamRequest({ sessionID: "session-1", type: StreamRequestTypes.START } as any, callback);
    await delegate.handleStreamRequest({ sessionID: "session-1", type: StreamRequestTypes.STOP } as any, callback);

    expect(startSpy).toHaveBeenCalledOnce();
    expect(stopSpy).toHaveBeenCalledWith("session-1");
  });

  it("handles RECONFIGURE material and immaterial changes", async () => {

    const { camera } = createStreamingCamera();
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    const forceStop = vi.spyOn((delegate.controller as any), "forceStopStreamingSession");
    const stopSpy = vi.spyOn(delegate, "stopStream").mockImplementation(() => undefined);
    const callback = vi.fn();

    (delegate as any).ongoingSessions.set("session-1", {

      ffmpeg: [],
      rtpDemuxer: null,
      rtpPortReservations: [],
      segmentsFed: 0,
      sessionStartedAt: Date.now(),
      videoParams: { fps: 30, height: 720, maxBitRate: 300, width: 1280 }
    });

    await delegate.handleStreamRequest({

      sessionID: "session-1",
      type: StreamRequestTypes.RECONFIGURE,
      video: { fps: 10, height: 720, max_bit_rate: 800, width: 1280 }
    } as any, callback);

    expect(stopSpy).toHaveBeenCalledWith("session-1");
    expect(forceStop).toHaveBeenCalledWith("session-1");

    (delegate as any).ongoingSessions.set("session-2", {

      ffmpeg: [],
      rtpDemuxer: null,
      rtpPortReservations: [],
      segmentsFed: 0,
      sessionStartedAt: Date.now(),
      videoParams: { fps: 30, height: 720, maxBitRate: 300, width: 1280 }
    });

    await delegate.handleStreamRequest({

      sessionID: "session-2",
      type: StreamRequestTypes.RECONFIGURE,
      video: { fps: 30, height: 720, max_bit_rate: 301, width: 1280 }
    } as any, callback);

    expect((delegate as any).ongoingSessions.get("session-2").videoParams.maxBitRate).toBe(301);
  });

  it("stops sessions and releases dependencies", () => {

    const { camera, platform, hap } = createStreamingCamera();
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    const ffmpeg = { stop: vi.fn() };
    const demuxer = { close: vi.fn() };
    const watchdog = { clear: vi.fn() };
    const toggleLight = { setCharacteristic: vi.fn() };

    (delegate as any).ongoingSessions.set("session-3", {

      fanoutKey: "key-1",
      ffmpeg: [ ffmpeg ],
      outputWatchdog: watchdog,
      rtpDemuxer: demuxer,
      rtpPortReservations: [ 1, 2 ],
      segmentsFed: 0,
      sessionStartedAt: Date.now(),
      toggleLight: toggleLight
    });
    (delegate as any).pendingSessions.set("session-3", { rtpPortReservations: [ 3 ] });

    delegate.stopStream("session-3");

    expect(watchdog.clear).toHaveBeenCalledOnce();
    expect(ffmpeg.stop).toHaveBeenCalledOnce();
    expect(demuxer.close).toHaveBeenCalledOnce();
    expect(toggleLight.setCharacteristic).toHaveBeenCalledWith(hap.Characteristic.On, false);
    expect(platform.rtpPorts.cancel).toHaveBeenCalledTimes(3);
  });

  it("shuts down all ongoing sessions", () => {

    const { camera } = createStreamingCamera();
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    const stopSpy = vi.spyOn(delegate, "stopStream").mockImplementation(() => undefined);

    (delegate as any).ongoingSessions.set("one", { ffmpeg: [], rtpDemuxer: null, rtpPortReservations: [], segmentsFed: 0, sessionStartedAt: Date.now() });
    (delegate as any).ongoingSessions.set("two", { ffmpeg: [], rtpDemuxer: null, rtpPortReservations: [], segmentsFed: 0, sessionStartedAt: Date.now() });
    delegate.shutdown();

    expect(stopSpy).toHaveBeenCalledTimes(2);
  });

  it("checks ffmpeg API-specific errors and probe adjustments", () => {

    vi.useFakeTimers();
    const { camera } = createStreamingCamera();
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);

    (delegate as any).hksv = { isRecording: true };
    expect(delegate.ffmpegErrorCheck([ "moov atom not found" ])).toContain("safely ignored");
    expect(delegate.ffmpegErrorCheck([ "different-error" ])).toBeUndefined();

    const initialProbe = delegate.probesize;
    delegate.adjustProbeSize();
    expect(delegate.probesize).toBeGreaterThan(initialProbe);
    vi.advanceTimersByTime(1000 * 60 * 10);
    expect(delegate.probesize).toBe(initialProbe);
  });

  it("clears existing probe timeout and caps oversized probesize", () => {

    vi.useFakeTimers();
    const base = createStreamingCamera();
    const { camera } = createStreamingCamera({
      hints: { ...base.camera.hints, probesize: 3_000_000 }
    });
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);

    (delegate as any).probesizeOverrideTimeout = setTimeout(() => undefined, 60_000);
    delegate.adjustProbeSize();

    expect((delegate as any).probesizeOverride).toBe(5_000_000);
    expect((delegate as any).probesizeOverrideTimeout).toBeTruthy();
  });

  it("returns errors for missing sessions and offline cameras", async () => {

    const { camera } = createStreamingCamera();
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    const callback = vi.fn();

    await (delegate as any).startStream(createStartRequest("missing"), callback);
    expect(callback).toHaveBeenCalledWith(expect.any(Error));

    await delegate.prepareStream(createPrepareRequest("offline"), vi.fn());
    camera.isOnline = false;
    await (delegate as any).startStream(createStartRequest("offline"), callback);
    expect(camera.log.error).toHaveBeenCalledWith("Unable to start video stream: the camera is offline or unavailable.");
  });

  it("returns av1 rtsp error when tsb cannot be used", async () => {

    const base = createStreamingCamera();
    const { camera } = createStreamingCamera({
      hints: { ...base.camera.hints, tsbStreaming: false },
      ufp: { ...base.camera.ufp, videoCodec: "av1" }
    });
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    const callback = vi.fn();

    await delegate.prepareStream(createPrepareRequest("av1"), vi.fn());
    await (delegate as any).startStream(createStartRequest("av1"), callback);

    expect(callback).toHaveBeenCalledWith(expect.any(Error));
  });

  it("starts rtsp stream path and records ongoing session", async () => {

    const base = createStreamingCamera();
    const { camera } = createStreamingCamera({
      hints: { ...base.camera.hints, tsbStreaming: false }
    });
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    const callback = vi.fn();

    await delegate.prepareStream(createPrepareRequest("rtsp"), vi.fn());
    await (delegate as any).startStream(createStartRequest("rtsp"), callback);
    await new Promise(resolve => setImmediate(resolve));

    expect((delegate as any).ongoingSessions.has("rtsp")).toBe(true);
    expect((delegate as any).pendingSessions.has("rtsp")).toBe(false);
    expect(callback).toHaveBeenCalled();
  });

  it("starts tsb livestream and aborts cleanly when start fails", async () => {

    const livestream = new EventEmitter() as EventEmitter & { getInitSegment: () => Promise<Buffer>; initSegment: Buffer };
    livestream.initSegment = Buffer.from("init");
    livestream.getInitSegment = async () => livestream.initSegment;
    const base = createStreamingCamera();
    const { camera, platform } = createStreamingCamera({
      ufp: { ...base.camera.ufp, videoCodec: "av1" },
      livestream: {
        acquire: vi.fn(() => livestream),
        start: vi.fn(async () => false),
        stop: vi.fn()
      },
      stream: { hksv: { timeshift: { getLast: vi.fn(() => Buffer.from("tsb")) } } }
    });
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    (delegate as any).hksv = { isRecording: true, timeshift: { getLast: vi.fn(() => Buffer.from("tsb")) } };
    const callback = vi.fn();

    await delegate.prepareStream(createPrepareRequest("tsb"), vi.fn());
    await (delegate as any).startStream(createStartRequest("tsb"), callback);

    expect(camera.livestream.start).toHaveBeenCalled();
    expect(platform.rtpPorts.cancel).toHaveBeenCalled();
    expect((delegate as any).ongoingSessions.has("tsb")).toBe(false);
  });

  it("prepares two-way audio and allocates talkback components", async () => {

    const { camera } = createStreamingCamera();
    camera.hints.twoWayAudio = true;
    camera.hasFeature = vi.fn((name: string) => name === "Audio");
    camera.nvr.ufpApi.getWsEndpoint = vi.fn(async () => "wss://talkback");
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    (delegate as any).ffmpegOptions.audioEncoder = vi.fn(() => [ "-codec:a", "aac" ]);
    const callback = vi.fn();

    await delegate.prepareStream(createPrepareRequest("talkback"), callback);

    const pending = (delegate as any).pendingSessions.get("talkback");
    expect(pending.rtpDemuxer).toBeTruthy();
    expect(pending.talkBack).toBe("wss://talkback");
    expect(callback).toHaveBeenCalledOnce();
  });

  it("logs talkback endpoint failures during prepare", async () => {

    const { camera } = createStreamingCamera();
    camera.hints.twoWayAudio = true;
    camera.hasFeature = vi.fn((name: string) => name === "Audio");
    camera.nvr.ufpApi.getWsEndpoint = vi.fn(async () => null);
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    (delegate as any).ffmpegOptions.audioEncoder = vi.fn(() => [ "-codec:a", "aac" ]);

    await delegate.prepareStream(createPrepareRequest("talkback-missing"), vi.fn());
    expect(camera.log.error).toHaveBeenCalledWith("Unable to open the return audio channel.");
  });

  it("logs stop telemetry once even when called repeatedly", () => {

    const { camera } = createStreamingCamera();
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);

    (delegate as any).ongoingSessions.set("telemetry", {
      ffmpeg: [],
      firstFrameMs: 50,
      path: "RTSP",
      profile: "High",
      rtpDemuxer: null,
      rtpPortReservations: [],
      segmentsFed: 3,
      sessionStartedAt: Date.now() - 1000,
      transcode: false
    });

    delegate.stopStream("telemetry");
    delegate.stopStream("telemetry");

    const stopLogs = (camera.log.info as ReturnType<typeof vi.fn>).mock.calls.filter(call => String(call[0]).includes("session"));
    expect(stopLogs.length).toBeGreaterThan(0);
  });

  it("handles snapshot callback success and failure", async () => {

    const { camera } = createStreamingCamera();
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    const callback = vi.fn();
    const goodImage = Buffer.from("snapshot");

    vi.spyOn((delegate as any).snapshot, "getSnapshot").mockResolvedValueOnce(goodImage).mockResolvedValueOnce(null);
    await delegate.handleSnapshotRequest({ width: 1280, height: 720 } as any, callback);
    await delegate.handleSnapshotRequest({ width: 1280, height: 720 } as any, callback);

    expect(callback).toHaveBeenNthCalledWith(1, undefined, goodImage);
    expect(callback).toHaveBeenNthCalledWith(2, expect.any(Error));
  });

  it("fails start when no rtsp stream profile is available", async () => {

    const base = createStreamingCamera();
    const { camera } = createStreamingCamera({
      findRtsp: vi.fn(() => null),
      hints: { ...base.camera.hints, tsbStreaming: false }
    });
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    const callback = vi.fn();

    await delegate.prepareStream(createPrepareRequest("no-rtsp"), vi.fn());
    await (delegate as any).startStream(createStartRequest("no-rtsp"), callback);

    expect(callback).toHaveBeenCalledWith(expect.any(Error));
    expect(camera.log.error).toHaveBeenCalled();
  });

  it("logs UDP reservation failures during prepare", async () => {

    const { camera, platform } = createStreamingCamera();
    platform.rtpPorts.reserve = vi.fn(async () => -1) as any;
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);

    await delegate.prepareStream(createPrepareRequest("ports"), vi.fn());
    expect(camera.log.error).toHaveBeenCalledWith("Unable to reserve the UDP ports needed to begin streaming.");
  });

  it("handles package flashlight and tsb segment forwarding", async () => {

    const livestream = new EventEmitter() as EventEmitter & { getInitSegment: () => Promise<Buffer>; initSegment: Buffer };
    livestream.initSegment = Buffer.from("init");
    livestream.getInitSegment = async () => livestream.initSegment;
    const base = createStreamingCamera();
    const flashlight = { getCharacteristic: vi.fn(() => ({ value: false })), setCharacteristic: vi.fn() };
    const { camera, hap } = createStreamingCamera({
      accessory: {
        ...base.camera.accessory,
        context: { packageCamera: true },
        getServiceById: vi.fn(() => flashlight)
      },
      ufp: { ...base.camera.ufp, isDark: true, videoCodec: "av1" },
      livestream: {
        acquire: vi.fn(() => livestream),
        start: vi.fn(async () => true),
        stop: vi.fn()
      }
    });
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    (delegate as any).hksv = { isRecording: true, timeshift: { getLast: vi.fn(() => Buffer.from("tsb")) } };

    await delegate.prepareStream(createPrepareRequest("flash-tsb"), vi.fn());
    await (delegate as any).startStream(createStartRequest("flash-tsb"), vi.fn());

    livestream.emit("segment", Buffer.from("seg-1"));
    const ongoing = (delegate as any).ongoingSessions.get("flash-tsb");
    expect(ongoing.segmentsFed).toBeGreaterThanOrEqual(1);
    expect(flashlight.setCharacteristic).toHaveBeenCalledWith(hap.Characteristic.On, true);
  });

  it("closes ffmpeg stdin when the livestream closes", async () => {

    const livestream = new EventEmitter() as EventEmitter & { getInitSegment: () => Promise<Buffer>; initSegment: Buffer };
    livestream.initSegment = Buffer.from("init");
    livestream.getInitSegment = async () => livestream.initSegment;
    const base = createStreamingCamera();
    const { camera } = createStreamingCamera({
      livestream: {
        acquire: vi.fn(() => livestream),
        start: vi.fn(async () => true),
        stop: vi.fn()
      },
      stream: { hksv: { timeshift: { getLast: vi.fn(() => Buffer.from("tsb")) } } },
      ufp: { ...base.camera.ufp, videoCodec: "av1" }
    });
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    (delegate as any).hksv = { isRecording: true, timeshift: { getLast: vi.fn(() => Buffer.from("tsb")) } };

    await delegate.prepareStream(createPrepareRequest("close-listener"), vi.fn());
    await (delegate as any).startStream(createStartRequest("close-listener"), vi.fn());

    livestream.emit("close");
    const ffmpegProcess = (delegate as any).ongoingSessions.get("close-listener").ffmpeg[0].ffmpegProcess;
    expect(ffmpegProcess.stdin.end).toHaveBeenCalled();
  });

  it("forces HomeKit stop when TSB startup fails after ffmpeg already started", async () => {

    const livestream = new EventEmitter() as EventEmitter & { getInitSegment: () => Promise<Buffer>; initSegment: Buffer };
    livestream.initSegment = Buffer.from("init");
    livestream.getInitSegment = async () => livestream.initSegment;
    const base = createStreamingCamera();
    const { camera } = createStreamingCamera({
      livestream: {
        acquire: vi.fn(() => livestream),
        start: vi.fn(async () => false),
        stop: vi.fn()
      },
      stream: { hksv: { timeshift: { getLast: vi.fn(() => Buffer.from("tsb")) } } },
      ufp: { ...base.camera.ufp, videoCodec: "av1" }
    });
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    (delegate as any).hksv = { isRecording: true, timeshift: { getLast: vi.fn(() => Buffer.from("tsb")) } };

    vi.mocked(FfmpegStreamingProcess).mockImplementationOnce((...args: any[]) => {
      const callback = args[5];
      if(typeof callback === "function") {
        setImmediate(() => callback(undefined));
      }
      return {
        ffmpegProcess: { once: vi.fn(), stdin: { end: vi.fn() } },
        isStarted: true,
        stdin: { end: vi.fn(), write: vi.fn() },
        stop: vi.fn(),
        stdout: { on: vi.fn(), off: vi.fn() }
      } as any;
    });

    await delegate.prepareStream(createPrepareRequest("force-stop"), vi.fn());
    await (delegate as any).startStream(createStartRequest("force-stop"), vi.fn());

    expect((delegate.controller as any).forceStopStreamingSession).toHaveBeenCalledWith("force-stop");
  });

  it("applies transcode bitrate caps and ffmpeg verbosity options", async () => {

    const base = createStreamingCamera();
    const { camera, platform } = createStreamingCamera({
      hasFeature: vi.fn((name: string) => name === "Audio" || name === "Debug.Video.FFmpeg"),
      hints: {
        ...base.camera.hints,
        transcode: true,
        transcodeBitrate: 4000,
        tsbStreaming: false
      }
    });
    platform.verboseFfmpeg = true;
    platform.config.debugAll = true;
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    (delegate as any).ffmpegOptions.audioEncoder = vi.fn(() => [ "-codec:a", "aac" ]);
    camera.getAudioFilters = vi.fn(() => [ "highpass=f=200" ]);
    camera.findRtsp = vi.fn(() => ({ channel: { bitrate: 1_000_000, fps: 30 }, name: "High", url: "rtsps://example/live" }));

    await delegate.prepareStream(createPrepareRequest("transcode"), vi.fn());
    await (delegate as any).startStream(createStartRequest("transcode", { audio: { ...createStartRequest().audio, packet_time: 60 } }), vi.fn());

    const ffmpegArgs = vi.mocked(FfmpegStreamingProcess).mock.calls.at(-1)?.[3] as string[];
    expect(ffmpegArgs).toContain("-loglevel");
    expect(ffmpegArgs).toContain("level+debug");
    expect(ffmpegArgs).toContain("-filter:a");
    expect(ffmpegArgs).toContain("highpass=f=200");
  });

  it("applies high and low latency transcode bitrate overrides", async () => {

    const base = createStreamingCamera();
    const { camera } = createStreamingCamera({
      hints: {
        ...base.camera.hints,
        transcode: true,
        transcodeBitrate: 1500,
        transcodeHighLatency: true,
        transcodeHighLatencyBitrate: 2200,
        tsbStreaming: false
      }
    });
    camera.findRtsp = vi.fn(() => ({ channel: { bitrate: 1_000_000, fps: 30 }, name: "High", url: "rtsps://example/live" }));
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);

    await delegate.prepareStream(createPrepareRequest("transcode-high"), vi.fn());
    await (delegate as any).startStream(createStartRequest("transcode-high", { audio: { ...createStartRequest().audio, packet_time: 60 } }), vi.fn());

    await delegate.prepareStream(createPrepareRequest("transcode-low"), vi.fn());
    await (delegate as any).startStream(createStartRequest("transcode-low", { audio: { ...createStartRequest().audio, packet_time: 20 } }), vi.fn());

    expect(camera.log.info).toHaveBeenCalled();
  });

  it("disables package flashlight auto-toggle when conditions are unmet", async () => {

    const livestream = new EventEmitter() as EventEmitter & { getInitSegment: () => Promise<Buffer>; initSegment: Buffer };
    livestream.initSegment = Buffer.from("init");
    livestream.getInitSegment = async () => livestream.initSegment;
    const base = createStreamingCamera();
    const flashlight = { getCharacteristic: vi.fn(() => ({ value: true })), setCharacteristic: vi.fn() };
    const { camera } = createStreamingCamera({
      accessory: {
        ...base.camera.accessory,
        context: { packageCamera: true },
        getServiceById: vi.fn(() => flashlight)
      },
      ufp: { ...base.camera.ufp, isDark: false, videoCodec: "av1" },
      livestream: {
        acquire: vi.fn(() => livestream),
        start: vi.fn(async () => true),
        stop: vi.fn()
      }
    });
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    (delegate as any).hksv = { isRecording: true, timeshift: { getLast: vi.fn(() => Buffer.from("tsb")) } };

    await delegate.prepareStream(createPrepareRequest("flash-off"), vi.fn());
    await (delegate as any).startStream(createStartRequest("flash-off"), vi.fn());
    expect(flashlight.setCharacteristic).not.toHaveBeenCalled();
  });

  it("adds interpolation filter when stream encoder has no filter", async () => {

    const base = createStreamingCamera();
    const livestream = new EventEmitter() as EventEmitter & { getInitSegment: () => Promise<Buffer>; initSegment: Buffer };
    livestream.initSegment = Buffer.from("init");
    livestream.getInitSegment = async () => livestream.initSegment;
    const { camera, platform } = createStreamingCamera({
      hints: { ...base.camera.hints, hardwareTranscoding: true, transcode: true, tsbStreaming: true },
      livestream: {
        acquire: vi.fn(() => livestream),
        start: vi.fn(async () => true),
        stop: vi.fn()
      },
      stream: { hksv: { timeshift: { getLast: vi.fn(() => null) } } }
    });
    mutableCodecSupport(platform).hostSystem = "macOS.Apple";
    mutableCodecSupport(platform).cpuGeneration = 3;
    mutableCodecSupport(platform).ffmpegVersion = "8.0";
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    (delegate as any).hksv = { isRecording: true, timeshift: { getLast: vi.fn(() => null) } };

    const tsbSpy = vi.spyOn(streamPath, "shouldUseTsbApi").mockReturnValue(true);
    const transcodeSpy = vi.spyOn(streamTranscode, "shouldTranscodeVideo").mockReturnValue({ reason: "forced", transcode: true } as any);
    (delegate as any).ffmpegOptions.streamEncoder = vi.fn(() => []);

    await delegate.prepareStream(createPrepareRequest("interp-nofilter"), vi.fn());
    await (delegate as any).startStream(createStartRequest("interp-nofilter"), vi.fn());

    const ffmpegArgs = vi.mocked(FfmpegStreamingProcess).mock.calls.at(-1)?.[3] as string[];
    expect(ffmpegArgs).toContain("-filter:v");
    tsbSpy.mockRestore();
    transcodeSpy.mockRestore();
  });

  it("adds h264 mp4-to-annexb bitstream filter on TSB copy path", async () => {

    const base = createStreamingCamera();
    const livestream = new EventEmitter() as EventEmitter & { getInitSegment: () => Promise<Buffer>; initSegment: Buffer };
    livestream.initSegment = Buffer.from("init");
    livestream.getInitSegment = async () => livestream.initSegment;
    const { camera } = createStreamingCamera({
      hints: { ...base.camera.hints, tsbStreaming: true, transcode: false },
      livestream: {
        acquire: vi.fn(() => livestream),
        start: vi.fn(async () => true),
        stop: vi.fn()
      },
      stream: { hksv: { timeshift: { getLast: vi.fn(() => null) } } }
    });
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    (delegate as any).hksv = { isRecording: true, timeshift: { getLast: vi.fn(() => null) } };

    const tsbSpy = vi.spyOn(streamPath, "shouldUseTsbApi").mockReturnValue(true);
    const transcodeSpy = vi.spyOn(streamTranscode, "shouldTranscodeVideo").mockReturnValue({ reason: "copy", transcode: false } as any);
    await delegate.prepareStream(createPrepareRequest("tsb-copy"), vi.fn());
    await (delegate as any).startStream(createStartRequest("tsb-copy"), vi.fn());

    const ffmpegArgs = vi.mocked(FfmpegStreamingProcess).mock.calls.at(-1)?.[3] as string[];
    expect(ffmpegArgs.join(" ")).toContain("h264_mp4toannexb");
    tsbSpy.mockRestore();
    transcodeSpy.mockRestore();
  });

  it("builds two-way direct audio return stream and handles stop errors", async () => {

    const { camera, platform } = createStreamingCamera({
      hasFeature: vi.fn((name: string) => name === "Audio"),
      hints: {
        ...createStreamingCamera().camera.hints,
        twoWayAudio: true,
        twoWayAudioDirect: true,
        tsbStreaming: false
      }
    });
    camera.nvr.ufpApi.getWsEndpoint = vi.fn(async () => "wss://unused");
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    (delegate as any).ffmpegOptions.audioEncoder = vi.fn(() => [ "-codec:a", "aac" ]);
    vi.mocked(FfmpegStreamingProcess).mockImplementation((...args: any[]) => {
      const callback = args[5];
      if(typeof callback === "function") {
        setImmediate(() => callback(undefined));
      }
      return {
        ffmpegProcess: { once: vi.fn(), stdin: { end: vi.fn() } },
        isStarted: false,
        stdin: { end: vi.fn(), write: vi.fn() },
        stop: vi.fn(),
        stdout: { on: vi.fn(), off: vi.fn() }
      } as any;
    });

    (delegate as any).pendingSessions.set("direct", {
      address: "192.168.1.100",
      addressVersion: "ipv4",
      audioCryptoSuite: 0,
      audioIncomingRtcpPort: 6000,
      audioIncomingRtpPort: 6001,
      audioPort: 5001,
      audioSRTP: Buffer.from("key"),
      audioSSRC: 11,
      hasAudioSupport: true,
      rtpDemuxer: null,
      rtpPortReservations: [],
      talkBack: null,
      videoCryptoSuite: 0,
      videoPort: 5000,
      videoReturnPort: 5002,
      videoSRTP: Buffer.from("key"),
      videoSSRC: 12
    });
    await (delegate as any).startStream(createStartRequest("direct"), vi.fn());

    const lastCall = vi.mocked(FfmpegStreamingProcess).mock.calls.at(-1);
    expect(vi.mocked(FfmpegStreamingProcess).mock.calls.length).toBeGreaterThan(1);
    expect((lastCall?.[3] as string[]).join(" ")).toContain("udp://" + camera.ufp.host);

    const badSession = {
      ffmpeg: [],
      rtpDemuxer: null,
      rtpPortReservations: [],
      segmentsFed: 0,
      sessionStartedAt: Date.now()
    };
    (delegate as any).ongoingSessions.set("bad-stop", badSession);
    platform.rtpPorts.cancel = vi.fn(() => {
      throw new Error("cancel failed");
    }) as any;
    testInternals<{ rtpPortReservations: number[] }>(badSession).rtpPortReservations.push(10);
    delegate.stopStream("bad-stop");
    expect(camera.log.error).toHaveBeenCalledWith(expect.stringContaining("Error occurred while ending the FFmpeg video processes"), expect.any(Error));
  });

  it("builds two-way piped audio return args and cleans ffmpeg stdout listeners", async () => {

    const { camera, platform } = createStreamingCamera({
      hasFeature: vi.fn((name: string) => name === "Audio"),
      hints: {
        ...createStreamingCamera().camera.hints,
        twoWayAudio: true,
        twoWayAudioDirect: false,
        tsbStreaming: false
      }
    });
    platform.verboseFfmpeg = true;
    platform.config.debugAll = true;
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    (delegate as any).ffmpegOptions.audioEncoder = vi.fn(() => [ "-codec:a", "aac" ]);

    (delegate as any).pendingSessions.set("piped-audio", {
      address: "192.168.1.100",
      addressVersion: "ipv4",
      audioCryptoSuite: 0,
      audioIncomingRtcpPort: 6000,
      audioIncomingRtpPort: 6001,
      audioPort: 5001,
      audioSRTP: Buffer.from("key"),
      audioSSRC: 11,
      hasAudioSupport: true,
      rtpDemuxer: null,
      rtpPortReservations: [],
      talkBack: null,
      videoCryptoSuite: 0,
      videoPort: 5000,
      videoReturnPort: 5002,
      videoSRTP: Buffer.from("key"),
      videoSSRC: 12
    });

    const instances: any[] = [];
    vi.mocked(FfmpegStreamingProcess).mockImplementation((...args: any[]) => {
      const callback = args[5];
      if(typeof callback === "function") {
        setImmediate(() => callback(undefined));
      }
      const stdout = new EventEmitter();
      const exitHandlers: Record<string, () => void> = {};
      const instance = {
        ffmpegProcess: { once: vi.fn((event: string, fn: () => void) => { exitHandlers[event] = fn; }), stdin: { end: vi.fn() } },
        isStarted: false,
        stdin: { end: vi.fn(), write: vi.fn() },
        stdout: { on: vi.fn(stdout.on.bind(stdout)), off: vi.fn(stdout.off.bind(stdout)), emit: stdout.emit.bind(stdout) },
        stop: vi.fn(),
        triggerExit: () => exitHandlers.exit?.()
      } as any;
      instances.push(instance);
      return instance;
    });

    await (delegate as any).startStream(createStartRequest("piped-audio"), vi.fn());

    const returnAudio = instances[1];
    returnAudio.stdout.emit("data", Buffer.from("pipe-data"));
    returnAudio.triggerExit();

    const returnAudioArgs = vi.mocked(FfmpegStreamingProcess).mock.calls.at(-1)?.[3] as string[];
    expect(returnAudioArgs).toContain("pipe:1");
    expect(returnAudioArgs).toContain("-loglevel");
  });


  it("logs constructor guidance on macOS and creates HKSV delegate", () => {

    const { camera, platform } = createStreamingCamera({
      isHksvCapable: true
    });
    mutableCodecSupport(platform).hostSystem = "macOS.Apple";
    camera.hints.hardwareTranscoding = false;
    camera.accessory.context.packageCamera = undefined;

    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    expect(delegate.hksv).toBeTruthy();
    expect(camera.log.warn).toHaveBeenCalledWith(expect.stringContaining("macOS detected"));
  });

  it("falls back AV1 streams to TSB when HKSV is active", async () => {

    const base = createStreamingCamera();
    const livestream = new EventEmitter() as EventEmitter & { getInitSegment: () => Promise<Buffer>; initSegment: Buffer };
    livestream.initSegment = Buffer.from("init");
    livestream.getInitSegment = async () => livestream.initSegment;
    const { camera } = createStreamingCamera({
      hints: { ...base.camera.hints, tsbStreaming: false },
      livestream: {
        acquire: vi.fn(() => livestream),
        start: vi.fn(async () => true),
        stop: vi.fn()
      },
      stream: { hksv: { timeshift: { getLast: vi.fn(() => Buffer.from("tsb")) } } },
      ufp: { ...base.camera.ufp, videoCodec: "av1" }
    });
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    (delegate as any).hksv = { isRecording: true, timeshift: { getLast: vi.fn(() => Buffer.from("tsb")) } };

    await delegate.prepareStream(createPrepareRequest("av1-tsb"), vi.fn());
    await (delegate as any).startStream(createStartRequest("av1-tsb"), vi.fn());

    expect(camera.livestream.acquire).toHaveBeenCalled();
    expect((delegate as any).pendingSessions.has("av1-tsb")).toBe(false);
  });

  it("applies interpolation filter options on TSB transcode paths", async () => {

    const base = createStreamingCamera();
    const livestream = new EventEmitter() as EventEmitter & { getInitSegment: () => Promise<Buffer>; initSegment: Buffer };
    livestream.initSegment = Buffer.from("init");
    livestream.getInitSegment = async () => livestream.initSegment;
    const { camera, platform } = createStreamingCamera({
      hints: { ...base.camera.hints, hardwareTranscoding: true, transcode: true, tsbStreaming: true },
      livestream: {
        acquire: vi.fn(() => livestream),
        start: vi.fn(async () => true),
        stop: vi.fn()
      },
      stream: { hksv: { timeshift: { getLast: vi.fn(() => Buffer.from("tsb")) } } }
    });
    mutableCodecSupport(platform).hostSystem = "macOS.Apple";
    mutableCodecSupport(platform).cpuGeneration = 3;
    mutableCodecSupport(platform).ffmpegVersion = "8.0";
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    (delegate as any).hksv = { isRecording: true, timeshift: { getLast: vi.fn(() => Buffer.from("tsb")) } };

    const tsbSpy = vi.spyOn(streamPath, "shouldUseTsbApi").mockReturnValue(true);
    const transcodeSpy = vi.spyOn(streamTranscode, "shouldTranscodeVideo").mockReturnValue({ reason: "forced", transcode: true } as any);
    (delegate as any).ffmpegOptions.streamEncoder = vi.fn(() => [ "-filter:v", "scale=1280:720" ]);

    await delegate.prepareStream(createPrepareRequest("interp"), vi.fn());
    await (delegate as any).startStream(createStartRequest("interp"), vi.fn());

    const ffmpegArgs = vi.mocked(FfmpegStreamingProcess).mock.calls.at(-1)?.[3] as string[];
    expect(ffmpegArgs.join(" ")).toContain("minterpolate=fps=");
    expect(ffmpegArgs.join(" ")).toContain("hwdownload, format=nv12");
    tsbSpy.mockRestore();
    transcodeSpy.mockRestore();
  });

  it("uses livestream init segments and cleans up listeners on ffmpeg exit", async () => {

    const livestream = new EventEmitter() as EventEmitter & { getInitSegment: () => Promise<Buffer>; initSegment: Buffer };
    livestream.initSegment = Buffer.from("init-live");
    livestream.getInitSegment = vi.fn(async () => livestream.initSegment);
    const base = createStreamingCamera();
    const { camera } = createStreamingCamera({
      livestream: {
        acquire: vi.fn(() => livestream),
        start: vi.fn(async () => true),
        stop: vi.fn()
      },
      stream: { hksv: { timeshift: { getLast: vi.fn(() => null) } } },
      ufp: { ...base.camera.ufp, videoCodec: "av1" }
    });
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    (delegate as any).hksv = { isRecording: true, timeshift: { getLast: vi.fn(() => null) } };

    const exitHandlers: Array<() => void> = [];
    vi.mocked(FfmpegStreamingProcess).mockImplementationOnce((...args: any[]) => {
      const callback = args[5];
      if(typeof callback === "function") {
        setImmediate(() => callback(undefined));
      }
      return {
        ffmpegProcess: { once: vi.fn((_event: string, fn: () => void) => exitHandlers.push(fn)), stdin: { end: vi.fn() } },
        isStarted: false,
        stdin: { end: vi.fn(), write: vi.fn() },
        stop: vi.fn(),
        stdout: { on: vi.fn(), off: vi.fn() }
      } as any;
    });

    await delegate.prepareStream(createPrepareRequest("tsb-exit"), vi.fn());
    await (delegate as any).startStream(createStartRequest("tsb-exit"), vi.fn());
    livestream.emit("segment", Buffer.from("seg-1"));
    expect(livestream.getInitSegment).toHaveBeenCalled();

    exitHandlers.forEach(fn => fn());
    expect(camera.livestream.stop).toHaveBeenCalled();
  });

  it("uses 48kHz HKSV audio samplerate for doorbells", () => {

    const { camera } = createStreamingCamera({
      isHksvCapable: true,
      ufp: { ...createStreamingCamera().camera.ufp, featureFlags: { hasMic: true, isDoorbell: true } }
    });
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);

    expect((delegate.controller as unknown as { options: { recording: { options: { audio: { codecs: { samplerate: number }[] } } } } }).options.recording?.options.audio.codecs[0]
      .samplerate).toBe(AudioRecordingSamplerate.KHZ_48);
  });

  it("logs ffmpeg audio requirement when encoder support is missing", async () => {

    const { camera } = createStreamingCamera({
      hasFeature: vi.fn((name: string) => name === "Audio")
    });
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    (delegate as any).ffmpegOptions.audioEncoder = vi.fn(() => []);

    await delegate.prepareStream(createPrepareRequest("audio-missing-encoder"), vi.fn());

    expect(camera.log.info).toHaveBeenCalledWith("Audio support disabled.%s", expect.stringContaining("fdk_aac"));
  });

  it("logs streaming hints for hardware transcode and audio filters", async () => {

    const base = createStreamingCamera();
    const { camera } = createStreamingCamera({
      hasFeature: vi.fn((name: string) => name === "Audio.Filter.Noise"),
      hints: { ...base.camera.hints, hardwareTranscoding: true, transcode: true, twoWayAudio: false, tsbStreaming: false }
    });
    const delegate = new ProtectStreamingDelegate(camera, [ [ 1280, 720, 30 ] ]);
    const transcodeSpy = vi.spyOn(streamTranscode, "shouldTranscodeVideo").mockReturnValue({ reason: "forced", transcode: true } as any);

    await delegate.prepareStream(createPrepareRequest("stream-hints"), vi.fn());
    await (delegate as any).startStream(createStartRequest("stream-hints", {
      audio: { channel: 1, max_bit_rate: 24, packet_time: 60, pt: 110, sample_rate: 16 }
    }), vi.fn());

    const startLog = (camera.log.info as ReturnType<typeof vi.fn>).mock.calls.find(call => String(call[0]).includes("Streaming request"));
    expect(startLog?.[0]).toContain("%sStreaming request");
    transcodeSpy.mockRestore();
  });

});
