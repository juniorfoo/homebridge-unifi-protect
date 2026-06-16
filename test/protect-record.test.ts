import { afterEach, describe, expect, it, vi } from "vitest";
import { HDSProtocolSpecificErrorReason } from "homebridge";
import { ProtectRecordingDelegate } from "../src/protect-record.js";
import { createMockAccessory, createMockNvr, createMockPlatform, createMockService } from "./helpers/mocks.js";

function createRecordingCamera(overrides: Record<string, unknown> = {}) {

  const platform = createMockPlatform();
  const nvr = createMockNvr({ platform });
  const accessory = createMockAccessory();
  const motionService = createMockService("motion");
  const recordingCharacteristic = { value: 1 };

  accessory.getService = vi.fn(() => motionService as any);
  platform.api.hap.Service.MotionSensor = { UUID: "motion" } as any;
  platform.api.hap.Characteristic.RecordingAudioActive = "RecordingAudioActive" as any;

  return {

    camera: {

      accessory,
      api: platform.api,
      findRecordingRtsp: vi.fn(() => ({ channel: { fps: 20, id: 1 }, lens: undefined, name: "Medium", url: "rtsps://example/record" })),
      getAudioFilters: vi.fn(() => []),
      hasFeature: vi.fn((feature: string) => feature === "Audio"),
      hints: {

        hardwareTranscoding: false,
        hksvRecordingIndicator: true,
        logHksv: true
      },
      isOnline: true,
      livestream: {

        acquire: vi.fn(() => ({ initSegment: Buffer.from("init"), on: vi.fn(), off: vi.fn(), getInitSegment: vi.fn(async () => Buffer.from("init")) })),
        isRestarting: vi.fn(() => false),
        restart: vi.fn(),
        start: vi.fn(async () => true),
        stop: vi.fn()
      },
      log: platform.log,
      nvr,
      platform,
      setStatusLed: vi.fn(async () => undefined),
      stream: {

        controller: {

          recordingManagement: {

            recordingManagementService: {

              getCharacteristic: vi.fn(() => recordingCharacteristic)
            }
          }
        },
        ffmpegOptions: { audioDecoder: "aac" },
        hksv: { timeshift: { configuredDuration: 0, time: 10000 } }
      },
      ufp: {

        featureFlags: { hasMic: true },
        ledSettings: { isEnabled: false },
        videoCodec: "h264"
      },
      videoCodecName: "H.264",
      ...overrides
    } as any,
    motionService,
    recordingCharacteristic
  };
}

describe("protect-record", () => {

  afterEach(() => {

    vi.clearAllMocks();
  });

  it("updates recording configuration and stops timeshift on undefined config", () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    const stopSpy = vi.spyOn(delegate.timeshift, "stop").mockReturnValue(true);

    delegate.updateRecordingConfiguration(undefined);
    expect(stopSpy).toHaveBeenCalledOnce();
  });

  it("logs disabling message when recording state changes", async () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    (delegate as any)._isRecording = true;

    await delegate.updateRecordingActive(false);
    expect(camera.log.info).toHaveBeenCalledWith("Disabling HomeKit Secure Video event recording.");
  });

  it("applies recording configuration and triggers active update", () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    const activeSpy = vi.spyOn(delegate, "updateRecordingActive").mockResolvedValue(undefined);

    delegate.updateRecordingConfiguration({

      mediaContainerConfiguration: { fragmentLength: 4000 },
      prebufferLength: 4000,
      videoCodec: { parameters: { bitRate: 1200 }, resolution: [ 1920, 1080 ] }
    } as any);

    expect(delegate.timeshift.configuredDuration).toBeGreaterThan(0);
    expect(activeSpy).toHaveBeenCalled();
  });

  it("disables recording and clears motion state", async () => {

    const { camera, motionService } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    const stopSpy = vi.spyOn(delegate.timeshift, "stop").mockReturnValue(true);

    await delegate.updateRecordingActive(false);

    expect(stopSpy).toHaveBeenCalledOnce();
    expect(motionService.updateCharacteristic).toHaveBeenCalled();
    expect(delegate.isRecording).toBe(false);
  });

  it("handles configureTimeshifting branches for offline and missing rtsp", async () => {

    const { camera } = createRecordingCamera({ isOnline: false });
    const delegate = new ProtectRecordingDelegate(camera);

    (delegate as any).recordingConfig = { videoCodec: { resolution: [ 1920, 1080 ] } };
    expect(await delegate.configureTimeshifting()).toBe(false);

    camera.isOnline = true;
    camera.findRecordingRtsp = vi.fn(() => null);
    expect(await delegate.configureTimeshifting()).toBe(false);
  });

  it("skips restart when existing timeshift profile is unchanged", async () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    const startSpy = vi.spyOn(delegate.timeshift, "start").mockResolvedValue(true);

    (delegate as any).recordingConfig = { videoCodec: { resolution: [ 1920, 1080 ] } };
    (delegate as any)._isRecording = true;
    (delegate as any).rtspEntry = { channel: { id: 1 }, lens: undefined };
    Object.defineProperty(delegate.timeshift, "isStarted", { get: () => true });

    expect(await delegate.configureTimeshifting()).toBe(true);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("acknowledges and closes recording streams", () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    const stopSpy = vi.spyOn(delegate as any, "stopTransmitting").mockImplementation(() => undefined);

    delegate.acknowledgeStream();
    delegate.closeRecordingStream(12, HDSProtocolSpecificErrorReason.CANCELLED);

    expect(stopSpy).toHaveBeenCalledTimes(2);
    expect((delegate as any).lastStreamId).toBe(12);
  });

  it("returns isAudioActive from recording characteristic", () => {

    const { camera, recordingCharacteristic } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);

    recordingCharacteristic.value = 1;
    expect(delegate.isAudioActive).toBe(true);

    recordingCharacteristic.value = 0;
    expect(delegate.isAudioActive).toBe(false);
  });

  it("enables recording and initializes hksv telemetry once", async () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    const configureSpy = vi.spyOn(delegate, "configureTimeshifting").mockResolvedValue(true);
    (delegate as any).recordingConfig = {
      mediaContainerConfiguration: { fragmentLength: 4000 },
      prebufferLength: 4000,
      videoCodec: { parameters: { bitRate: 512 }, resolution: [ 1920, 1080 ] }
    };
    (delegate as any).rtspEntry = { name: "High" };

    await delegate.updateRecordingActive(true);
    await delegate.updateRecordingActive(true);

    expect(configureSpy).toHaveBeenCalledTimes(2);
    expect(delegate.isRecording).toBe(true);
    expect(camera.log.info).toHaveBeenCalledTimes(1);
  });

  it("covers hardware-transcoding startup log prefix variants", async () => {

    const { camera } = createRecordingCamera({
      hints: { hardwareTranscoding: true, hksvRecordingIndicator: true, logHksv: true },
      platform: { codecSupport: { hostSystem: "linux" } }
    });
    const delegate = new ProtectRecordingDelegate(camera);
    vi.spyOn(delegate, "configureTimeshifting").mockResolvedValue(true);
    (delegate as any).recordingConfig = {
      mediaContainerConfiguration: { fragmentLength: 4000 },
      prebufferLength: 4000,
      videoCodec: { parameters: { bitRate: 768 }, resolution: [ 1920, 1080 ] }
    };
    (delegate as any).rtspEntry = { name: "Medium" };

    await delegate.updateRecordingActive(true);
    expect(camera.log.info).toHaveBeenCalledWith("HKSV: %s%s [%s], %s.", "⚡️ ", "Medium", "H.264", "768000 bps");

    camera.platform.codecSupport.hostSystem = "raspbian";
    (delegate as any).isInitialized = false;
    await delegate.updateRecordingActive(true);
    expect(camera.log.info).toHaveBeenCalledWith("HKSV: %s%s [%s], %s.", "", "Medium", "H.264", "768000 bps");
  });

  it("returns false when startTransmitting preconditions fail", async () => {

    const { camera } = createRecordingCamera({ stream: null });
    const delegate = new ProtectRecordingDelegate(camera);
    await expect((delegate as any).startTransmitting()).resolves.toBe(false);
  });

  it("starts transmitting and wires timeshift segment forwarding", async () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    (delegate as any).recordingConfig = {
      mediaContainerConfiguration: { fragmentLength: 4000 },
      prebufferLength: 4000,
      videoCodec: { parameters: { bitRate: 512 }, resolution: [ 1920, 1080 ] }
    };
    (delegate as any).rtspEntry = { channel: { fps: 20, id: 1 }, name: "Medium", url: "rtsps://example" };
    delegate.timeshift.getKeyframeAlignedStart = vi.fn(() => ({ seekOffsetMs: 25, startIndex: 2 })) as any;
    delegate.timeshift.transmitStart = vi.fn(async () => true) as any;

    await expect((delegate as any).startTransmitting()).resolves.toBe(true);
    expect(delegate.isTransmitting).toBe(true);
    expect(delegate.timeshift.transmitStart).toHaveBeenCalledWith(2);
    expect(camera.log.debug).toHaveBeenCalledWith("Beginning a HomeKit Secure Video recording event.");

    (delegate as any).timeshift.emit("segment", Buffer.from("segment-forward"));
    expect((delegate as any).segmentWriter.write).toHaveBeenCalledWith(Buffer.from("segment-forward"));
  });

  it("stops transmitting on failed transmitStart and cleans up state", async () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    (delegate as any).recordingConfig = {
      mediaContainerConfiguration: { fragmentLength: 4000 },
      prebufferLength: 4000,
      videoCodec: { parameters: { bitRate: 512 }, resolution: [ 1920, 1080 ] }
    };
    (delegate as any).rtspEntry = { channel: { fps: 20, id: 1 }, name: "Medium", url: "rtsps://example" };
    delegate.timeshift.transmitStart = vi.fn(async () => false) as any;
    const stopSpy = vi.spyOn(delegate.timeshift, "stop").mockReturnValue(true);

    await expect((delegate as any).startTransmitting()).resolves.toBe(false);
    expect(stopSpy).toHaveBeenCalled();
    expect(delegate.isTransmitting).toBe(false);
  });

  it("yields terminal packet when recording cannot start", async () => {

    const { camera } = createRecordingCamera();
    camera.accessory.context.hksvRecordingDisabled = true;
    const delegate = new ProtectRecordingDelegate(camera);
    const packets: any[] = [];

    for await (const packet of delegate.handleRecordingStreamRequest(9, new AbortController().signal)) {
      packets.push(packet);
    }

    expect(packets).toHaveLength(1);
    expect(packets[0].isLast).toBe(true);
  });

  it("attempts initialization and stops early transmission on startup failure", async () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    camera.accessory.context.hksvRecordingDisabled = false;
    (delegate as any)._isRecording = true;
    (delegate as any).isInitialized = false;
    (delegate as any)._isTransmitting = true;
    vi.spyOn(delegate, "updateRecordingActive").mockResolvedValue(undefined);
    vi.spyOn(delegate as any, "startTransmitting").mockResolvedValue(false);
    const stopSpy = vi.spyOn(delegate as any, "stopTransmitting").mockImplementation(() => undefined);

    const packets: any[] = [];
    for await (const packet of delegate.handleRecordingStreamRequest(13, new AbortController().signal)) {
      packets.push(packet);
      break;
    }

    expect(delegate.updateRecordingActive).toHaveBeenCalledWith(true);
    expect(stopSpy).toHaveBeenCalled();
    expect(packets[0].isLast).toBe(true);
  });

  it("streams ffmpeg segments and triggers timeout restart packet", async () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    (delegate as any).isInitialized = true;
    (delegate as any)._isRecording = true;
    Object.defineProperty(delegate.timeshift, "time", { get: () => 8000 });
    Object.defineProperty(delegate.timeshift, "configuredDuration", { get: () => 8000 });
    const restartSpy = vi.spyOn(delegate.timeshift, "restart").mockImplementation(() => undefined);
    const ffmpegStream = {
      isTimedOut: true,
      segmentGenerator: async function*() {
        yield Buffer.from("segment-a");
      }
    };

    vi.spyOn(delegate as any, "startTransmitting").mockImplementation(async () => {
      (delegate as any)._isTransmitting = true;
      (delegate as any).ffmpegStream = ffmpegStream;
      return true;
    });

    const packets: any[] = [];
    const abort = new AbortController();
    for await (const packet of delegate.handleRecordingStreamRequest(1, abort.signal)) {
      packets.push(packet);
      if(packet.isLast) {
        break;
      }
      (delegate as any)._isTransmitting = false;
    }

    expect(packets.some(packet => packet.isLast)).toBe(true);
    expect(restartSpy).toHaveBeenCalled();
  });

  it("streams ffmpeg segments without timeout restart packet", async () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    (delegate as any).isInitialized = true;
    (delegate as any)._isRecording = true;
    Object.defineProperty(delegate.timeshift, "time", { get: () => 8000 });
    Object.defineProperty(delegate.timeshift, "configuredDuration", { get: () => 8000 });
    const ffmpegStream = {
      isTimedOut: false,
      segmentGenerator: async function*() {
        yield Buffer.from("segment-a");
      }
    };

    vi.spyOn(delegate as any, "startTransmitting").mockImplementation(async () => {
      (delegate as any)._isTransmitting = true;
      (delegate as any).ffmpegStream = ffmpegStream;
      return true;
    });

    const packets: any[] = [];
    const abort = new AbortController();
    for await (const packet of delegate.handleRecordingStreamRequest(5, abort.signal)) {
      packets.push(packet);
      (delegate as any)._isTransmitting = false;
    }

    expect(packets.some(packet => packet.isLast)).toBe(false);
  });

  it("stopTransmitting logs early termination telemetry and ffmpeg stderr", () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    camera.hasFeature = vi.fn((name: string) => name === "Debug.Video.HKSV.Telemetry");
    camera.stream.hksv.timeshift.time = 6000;
    (delegate as any).recordingConfig = { prebufferLength: 4000 };
    (delegate as any)._isTransmitting = true;
    (delegate as any).pacingStartTime = Date.now() - 500;
    (delegate as any).eventId = 7;
    (delegate as any).lastStreamId = 11;
    (delegate as any).rtspEntry = { channel: { id: 1 } };
    (delegate as any).timeshiftedSegments = 5;
    (delegate as any).transmittedSegments = 4;
    (delegate as any).ffmpegStream = {
      isEnded: false,
      isTimedOut: true,
      stderrLog: [ "line-1", "line-2" ],
      stop: vi.fn()
    };

    (delegate as any).stopTransmitting(HDSProtocolSpecificErrorReason.TIMEOUT);

    expect(camera.log.error).toHaveBeenCalledWith("HKSV recording event ended early: %s%s", expect.any(String), expect.any(String));
    expect(camera.log.error).toHaveBeenCalledWith("FFmpeg: %s", "line-1");
    expect(camera.log.error).toHaveBeenCalledWith("FFmpeg: %s", "line-2");
  });

  it("configureTimeshifting succeeds when not actively recording", async () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    (delegate as any).recordingConfig = { videoCodec: { resolution: [ 1920, 1080 ] } };
    (delegate as any)._isRecording = false;

    await expect(delegate.configureTimeshifting()).resolves.toBe(true);
    expect((delegate as any).rtspEntry).toBeTruthy();
  });

  it("configureTimeshifting returns false when recording config is missing", async () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);

    (delegate as any).recordingConfig = undefined;
    await expect(delegate.configureTimeshifting()).resolves.toBe(false);
  });

  it("configureTimeshifting starts timeshift and propagates start failures", async () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    (delegate as any).recordingConfig = { videoCodec: { resolution: [ 1920, 1080 ] } };
    (delegate as any)._isRecording = true;
    const startSpy = vi.spyOn(delegate.timeshift, "start").mockResolvedValue(true);

    await expect(delegate.configureTimeshifting()).resolves.toBe(true);
    expect(startSpy).toHaveBeenCalled();

    startSpy.mockResolvedValueOnce(false);
    await expect(delegate.configureTimeshifting()).resolves.toBe(false);
  });

  it("stopTransmitting is a no-op when already idle", () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    const transmitStopSpy = vi.spyOn(delegate.timeshift, "transmitStop").mockReturnValue(true);

    (delegate as any).stopTransmitting();
    expect(transmitStopSpy).not.toHaveBeenCalled();
    expect(camera.setStatusLed).not.toHaveBeenCalled();
  });

  it("startTransmitting cleans up stale ffmpeg and listener state", async () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    (delegate as any).recordingConfig = {
      mediaContainerConfiguration: { fragmentLength: 4000 },
      prebufferLength: 4000,
      videoCodec: { parameters: { bitRate: 512 }, resolution: [ 1920, 1080 ] }
    };
    (delegate as any).rtspEntry = { channel: { fps: 20, id: 1 }, name: "Medium", url: "rtsps://example" };
    const oldStop = vi.fn();
    (delegate as any).ffmpegStream = { stop: oldStop };
    (delegate as any).segmentWriter = { close: vi.fn() };
    (delegate as any).transmitListener = vi.fn();
    const offSpy = vi.spyOn(delegate.timeshift, "off");
    delegate.timeshift.transmitStart = vi.fn(async () => true) as any;

    await expect((delegate as any).startTransmitting()).resolves.toBe(true);
    expect(oldStop).toHaveBeenCalledWith(false);
    expect(offSpy).toHaveBeenCalledWith("segment", expect.any(Function));
  });

  it("startTransmitting validates timeshift restart and fallback seek offset branches", async () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    (delegate as any).recordingConfig = {
      mediaContainerConfiguration: { fragmentLength: 4000 },
      prebufferLength: 4000,
      videoCodec: { parameters: { bitRate: 512 }, resolution: [ 1920, 1080 ] }
    };
    (delegate as any).rtspEntry = { channel: { fps: 20, id: 1 }, name: "Medium", url: "rtsps://example" };

    Object.defineProperty(delegate.timeshift, "isRestarting", { configurable: true, get: () => true });
    await expect((delegate as any).startTransmitting()).resolves.toBe(false);

    Object.defineProperty(delegate.timeshift, "isRestarting", { configurable: true, get: () => false });
    delegate.timeshift.getKeyframeAlignedStart = vi.fn(() => undefined) as any;
    camera.stream.hksv.timeshift.time = 9000;
    camera.stream.hksv.timeshift.configuredDuration = 8000;
    delegate.timeshift.transmitStart = vi.fn(async () => true) as any;

    await expect((delegate as any).startTransmitting()).resolves.toBe(true);
    expect(delegate.timeshift.getKeyframeAlignedStart).toHaveBeenCalled();
  });

  it("stopTransmitting clears listener and exits for intentionally skipped events", () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    (delegate as any)._isTransmitting = true;
    (delegate as any).transmitListener = vi.fn();
    (delegate as any).ffmpegStream = { stop: vi.fn(), isEnded: true, isTimedOut: false, stderrLog: [] };
    (delegate as any).segmentWriter = { close: vi.fn() };
    (delegate as any).transmittedSegments = -1;
    const offSpy = vi.spyOn(delegate.timeshift, "off");

    (delegate as any).stopTransmitting();
    expect(offSpy).toHaveBeenCalledWith("segment", expect.any(Function));
  });

  it("stopTransmitting handles missing ffmpeg stream defaults", () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    (delegate as any)._isTransmitting = true;
    (delegate as any).ffmpegStream = undefined;
    (delegate as any).segmentWriter = { close: vi.fn() };
    (delegate as any).recordingConfig = { prebufferLength: 4000 };
    (delegate as any).rtspEntry = { channel: { id: 1 } };
    (delegate as any).timeshiftedSegments = 4;
    (delegate as any).transmittedSegments = 4;
    camera.stream.hksv.timeshift.time = 5000;

    (delegate as any).stopTransmitting(HDSProtocolSpecificErrorReason.CANCELLED);
    expect((delegate as any)._isTransmitting).toBe(false);
  });

  it("stopTransmitting logs successful HKSV duration for normal completion", () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    (delegate as any)._isTransmitting = true;
    (delegate as any).rtspEntry = { channel: { id: 1 } };
    (delegate as any).timeshiftedSegments = 121;
    (delegate as any).transmittedSegments = 121;
    (delegate as any).ffmpegStream = { stop: vi.fn(), isEnded: true, isTimedOut: false, stderrLog: [] };
    camera.hints.logHksv = true;
    camera.accessory.context.hksvRecordingDisabled = false;

    (delegate as any).stopTransmitting(HDSProtocolSpecificErrorReason.NORMAL);

    expect(camera.log.info).toHaveBeenCalledWith("HKSV: %s %s event.", expect.any(String), expect.any(String));
  });

  it("updateRecordingActive exits early when timeshifting cannot configure", async () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    vi.spyOn(delegate, "configureTimeshifting").mockResolvedValue(false);

    await delegate.updateRecordingActive(true);
    expect(delegate.isRecording).toBe(true);
    expect(camera.log.info).not.toHaveBeenCalledWith(expect.stringContaining("HKSV:"));
  });

  it("handles discontinuity restart failures with telemetry warnings", async () => {

    const { camera } = createRecordingCamera();
    camera.hasFeature = vi.fn((name: string) => name === "Debug.Video.HKSV.Telemetry");
    const delegate = new ProtectRecordingDelegate(camera);
    (delegate as any).isInitialized = true;
    (delegate as any)._isRecording = true;
    Object.defineProperty(delegate.timeshift, "time", { get: () => 8000 });
    Object.defineProperty(delegate.timeshift, "configuredDuration", { get: () => 8000 });

    const ffmpegStream = {
      isTimedOut: false,
      stop: vi.fn(),
      segmentGenerator: async function*() {
        yield Buffer.from("segment-a");
        yield Buffer.from("segment-b");
      }
    };
    const startSpy = vi.spyOn(delegate as any, "startTransmitting")
      .mockImplementationOnce(async () => {
        (delegate as any)._isTransmitting = true;
        (delegate as any).ffmpegStream = ffmpegStream;
        return true;
      })
      .mockResolvedValueOnce(false);

    const packets: any[] = [];
    const abort = new AbortController();
    for await (const packet of delegate.handleRecordingStreamRequest(2, abort.signal)) {
      packets.push(packet);
      (delegate as any).timeshift.emit("discontinuity");
      if(packets.length > 1) {
        break;
      }
    }

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(packets[0]?.isLast).toBe(false);
    expect(camera.log.warn).toHaveBeenCalledWith(expect.stringContaining("Discontinuity recovery failed"), expect.any(String));
  });

  it("stopTransmitting covers reason mapping and elapsed-time guards", () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    camera.hasFeature = vi.fn(() => false);
    camera.accessory.context.hksvRecordingDisabled = false;
    camera.hints.logHksv = true;
    camera.stream.hksv.timeshift.time = 8000;
    (delegate as any).recordingConfig = { prebufferLength: 4000 };
    (delegate as any).rtspEntry = { channel: { id: 1 } };
    (delegate as any).timeshiftedSegments = 800;
    (delegate as any).transmittedSegments = 800;
    (delegate as any).pacingStartTime = Date.now() - 1200;
    (delegate as any).ffmpegStream = { stop: vi.fn(), isEnded: true, isTimedOut: false, stderrLog: [] };
    (delegate as any)._isTransmitting = true;

    (delegate as any).stopTransmitting(HDSProtocolSpecificErrorReason.CANCELLED);
    expect(camera.log.error).toHaveBeenCalledWith("HKSV recording event ended early: %s%s", expect.any(String), "");

    (delegate as any)._isTransmitting = true;
    (delegate as any).ffmpegStream = { stop: vi.fn(), isEnded: true, isTimedOut: false, stderrLog: [] };
    (delegate as any).pacingStartTime = Date.now() - 1200;
    (delegate as any).stopTransmitting(HDSProtocolSpecificErrorReason.UNEXPECTED_FAILURE);
    expect(camera.log.error).toHaveBeenCalledWith("HKSV recording event ended early: %s%s", expect.any(String), "");
  });

  it("formats hour-duration HKSV logs and returns null recording config by default", () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    expect(delegate.recordingConfiguration).toBeNull();

    (delegate as any)._isTransmitting = true;
    (delegate as any).rtspEntry = { channel: { id: 1 } };
    (delegate as any).timeshiftedSegments = 3601;
    (delegate as any).transmittedSegments = 3601;
    (delegate as any).ffmpegStream = { stop: vi.fn(), isEnded: true, isTimedOut: false, stderrLog: [] };
    camera.hints.logHksv = true;
    camera.accessory.context.hksvRecordingDisabled = false;
    (delegate as any).timeshift._segmentLength = 1000;

    (delegate as any).stopTransmitting(HDSProtocolSpecificErrorReason.NORMAL);

    const hourLikeCall = (camera.log.info as ReturnType<typeof vi.fn>).mock.calls.find(call => call[0] === "HKSV: %s %s event.");

    expect(hourLikeCall).toBeDefined();
    expect(hourLikeCall?.[1]).toMatch(/^\d{2}:\d{2}(:\d{2})?$/);
    expect([ "hour", "minute" ]).toContain(hourLikeCall?.[2]);
  });

  it("warns when discontinuity recovery succeeds", async () => {

    const { camera } = createRecordingCamera();
    camera.hasFeature = vi.fn((name: string) => name === "Debug.Video.HKSV.Telemetry");
    const delegate = new ProtectRecordingDelegate(camera);
    (delegate as any).isInitialized = true;
    (delegate as any)._isRecording = true;
    Object.defineProperty(delegate.timeshift, "time", { get: () => 8000 });
    Object.defineProperty(delegate.timeshift, "configuredDuration", { get: () => 8000 });

    const ffmpegStream = {
      isTimedOut: false,
      stop: vi.fn(),
      segmentGenerator: async function*() {
        yield Buffer.from("segment-a");
      }
    };
    vi.spyOn(delegate as any, "startTransmitting")
      .mockImplementationOnce(async () => {
        (delegate as any)._isTransmitting = true;
        (delegate as any).ffmpegStream = ffmpegStream;
        return true;
      })
      .mockImplementationOnce(async () => {
        (delegate as any)._isTransmitting = true;
        (delegate as any).ffmpegStream = ffmpegStream;
        return true;
      });

    const abort = new AbortController();
    const iterator = delegate.handleRecordingStreamRequest(3, abort.signal);
    await iterator.next();
    (delegate as any).timeshift.emit("discontinuity");
    abort.abort();
    await iterator.next().catch(() => undefined);

    expect(camera.log.warn).toHaveBeenCalledWith(expect.stringContaining("Discontinuity recovery succeeded"), expect.any(String));
  });

  it("skips timeshift restart when lens matches previous entry", async () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    const startSpy = vi.spyOn(delegate.timeshift, "start").mockResolvedValue(true);

    (delegate as any).recordingConfig = { videoCodec: { resolution: [ 1920, 1080 ] } };
    (delegate as any)._isRecording = true;
    (delegate as any).rtspEntry = { channel: { id: 1 }, lens: "tele" };
    camera.findRecordingRtsp = vi.fn(() => ({ channel: { id: 1 }, lens: "tele" }));
    Object.defineProperty(delegate.timeshift, "isStarted", { get: () => true });

    expect(await delegate.configureTimeshifting()).toBe(true);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("turns off status led when stopping an active transmission", () => {

    const { camera } = createRecordingCamera({
      ufp: { featureFlags: { hasMic: true }, ledSettings: { isEnabled: true }, videoCodec: "h264" }
    });
    const delegate = new ProtectRecordingDelegate(camera);
    (delegate as any)._isTransmitting = true;
    (delegate as any).ffmpegStream = { stop: vi.fn(), isEnded: true, isTimedOut: false, stderrLog: [] };

    (delegate as any).stopTransmitting(HDSProtocolSpecificErrorReason.NORMAL);

    expect(camera.setStatusLed).toHaveBeenCalledWith(false);
  });

  it("uses keyframe seek offset when starting transmission after discontinuity", async () => {

    const { camera } = createRecordingCamera();
    const delegate = new ProtectRecordingDelegate(camera);
    (delegate as any).recordingConfig = {
      mediaContainerConfiguration: { fragmentLength: 4000 },
      prebufferLength: 4000,
      videoCodec: { parameters: { bitRate: 512 }, resolution: [ 1920, 1080 ] }
    };
    (delegate as any).rtspEntry = { channel: { fps: 20, id: 1 }, name: "Medium", url: "rtsps://example" };
    delegate.timeshift.getKeyframeAlignedStart = vi.fn(() => ({ seekOffsetMs: 1500, startIndex: 1 })) as any;
    delegate.timeshift.transmitStart = vi.fn(async () => true) as any;

    await expect((delegate as any).startTransmitting(true)).resolves.toBe(true);
    expect(delegate.timeshift.getKeyframeAlignedStart).toHaveBeenCalled();
  });
});
