import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as pluginUtils from "homebridge-plugin-utils";
import * as hostProfile from "../../src/host-profile.js";
import { ProtectReservedNames } from "../../src/protect-types.js";
import { ProtectCamera } from "../../src/devices/protect-camera.js";
import {
  createMockAccessory,
  createMockCameraConfig,
  createMockNvr,
  createMockService,
  getServiceCharacteristicHandlers
} from "../helpers/mocks.js";

const mockState = vi.hoisted(() => ({
  livestreamAcquire: vi.fn(),
  livestreamShutdown: vi.fn(),
  livestreamStart: vi.fn(),
  livestreamStop: vi.fn(),
  streamCtor: vi.fn(function(this: Record<string, unknown>) {

    this.controller = { id: "stream-controller" };
    this.ffmpegOptions = { hostSystemMaxPixels: 2073600 };
    this.hksv = {
      configureTimeshifting: vi.fn(),
      isRecording: false,
      timeshift: { isStarted: true },
      updateRecordingActive: vi.fn()
    };
  })
}));

vi.mock("../../src/protect-livestream.js", () => ({

  LivestreamManager: vi.fn().mockImplementation(() => ({
    acquire: mockState.livestreamAcquire,
    shutdown: mockState.livestreamShutdown,
    start: mockState.livestreamStart,
    stop: mockState.livestreamStop
  }))
}));

vi.mock("../../src/protect-stream.js", () => ({

  ProtectStreamingDelegate: mockState.streamCtor
}));

vi.mock("../../src/host-profile.js", async importOriginal => {

  const actual = await importOriginal<typeof import("../../src/host-profile.js")>();

  return {

    ...actual,
    detectHostProfile: vi.fn(() => "default"),
    formatHostProfileLog: vi.fn(() => "mock host profile"),
    resolveHksvRecordingDefault: vi.fn(() => "HIGH")
  };
});

async function flushCameraSetup(): Promise<void> {

  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
}

describe("ProtectCamera", () => {

  beforeEach(() => {

    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(pluginUtils.validService).mockImplementation((_, __, validate) => typeof validate === "function" ? validate(false) : validate);
    vi.mocked(pluginUtils.acquireService).mockImplementation((accessory, serviceType, name, subtype, onServiceCreate) => {
      const existing = subtype ? accessory.getServiceById(serviceType, subtype) : accessory.getService(serviceType);

      if(existing) {
        return existing;
      }

      const service = createMockService(serviceType.UUID);

      service.displayName = name ?? service.displayName;
      service.subtype = subtype;
      accessory.addService(service);
      onServiceCreate?.(service);

      return service;
    });
  });

  afterEach(() => {

    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("configures camera end-to-end through constructor", async () => {

    const enabledFeatures = new Set([
      "Audio",
      "Audio.TwoWay",
      "Audio.TwoWay.Direct",
      "Device",
      "Device.NightVision",
      "Device.NightVision.Dimmer",
      "Device.StatusLed",
      "Device.StatusLed.Switch",
      "Doorbell.Mute",
      "Doorbell.Trigger",
      "Motion.OccupancySensor",
      "Motion.SmartDetect",
      "Motion.SmartDetect.ObjectSensors",
      "Nvr.Recording.Switch",
      "UniFi.Access.Lock",
      "Video.Crop",
      "Video.HKSV.Recording.Switch",
      "Video.Stream.UseApi",
      "Video.Transcode",
      "Video.Transcode.Hardware"
    ]);
    const nvr = createMockNvr({
      featureTest: (name: string) => enabledFeatures.has(name)
    });
    const accessory = createMockAccessory({
      context: { detectMotion: false, doorbellMuted: true, hksvRecordingDisabled: true }
    });
    const cameraOperatingModeService = createMockService(nvr.platform.api.hap.Service.CameraOperatingMode.UUID);
    const doorbellService = createMockService(nvr.platform.api.hap.Service.Doorbell.UUID);

    accessory.addService(cameraOperatingModeService);
    accessory.addService(doorbellService);

    vi.mocked(nvr.platform.featureOptions.getInteger).mockImplementation((name: string) => {
      if(name.startsWith("Video.Crop")) {
        return 150;
      }

      return undefined;
    });
    (nvr.platform.featureOptions as { value: (name: string) => string | undefined }).value = vi.fn((name: string) =>
      name === "Motion.SmartDetect.ObjectSensors.LicensePlate" ? "abc-def" : undefined
    );

    const camera = new ProtectCamera(nvr, createMockCameraConfig({
      accessDeviceMetadata: { featureFlags: { supportUnlock: true } },
      featureFlags: {
        hasIcrSensitivity: true,
        hasInfrared: true,
        hasLedStatus: true,
        hasLuxCheck: true,
        hasSmartDetect: true,
        hasSmartDetection: true,
        hasSpeaker: true,
        hasTamperDetection: true,
        isDoorbell: false,
        smartDetectAudioTypes: [ "smoke" ],
        smartDetectTypes: [ "person", "vehicle", "licensePlate" ]
      },
      recordingSettings: { mode: "never" }
    }) as never, accessory);

    await flushCameraSetup();

    expect(camera.stream).toBeDefined();
    expect(camera.hints.tsbStreaming).toBe(true);
    expect(camera.hints.crop).toBe(true);
    expect(camera.hints.smartDetect).toBe(true);
    expect(camera.hints.smartDetectSensors).toBe(true);
    expect(camera.hints.cropOptions).toEqual({
      height: 1,
      width: 1,
      x: 0,
      y: 0
    });
    expect(accessory.context).toMatchObject({
      detectMotion: true,
      doorbellMuted: true,
      hksvRecordingDisabled: true
    });
    expect(accessory.configureController).toHaveBeenCalled();
    expect(nvr.events.on).toHaveBeenCalledWith("addEvent.camera-1", expect.any(Function));
    expect(nvr.events.on).toHaveBeenCalledWith("updateEvent.camera-1", expect.any(Function));
    expect(accessory.getServiceById(nvr.platform.api.hap.Service.LockMechanism, ProtectReservedNames.LOCK_ACCESS)).toBeDefined();
    expect(accessory.getServiceById(nvr.platform.api.hap.Service.Switch, ProtectReservedNames.SWITCH_HKSV_RECORDING)).toBeDefined();
    expect(accessory.getServiceById(nvr.platform.api.hap.Service.Switch, ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS)).toBeDefined();
    expect(accessory.getServiceById(nvr.platform.api.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION)).toBeDefined();
  });

  it("registers MQTT callbacks and executes handlers", async () => {

    const enabledFeatures = new Set([ "Doorbell.Trigger" ]);
    const nvr = createMockNvr({ featureTest: (name: string) => enabledFeatures.has(name) });
    const camera = new ProtectCamera(nvr, createMockCameraConfig() as never, createMockAccessory());

    await flushCameraSetup();

    const snapshotRequest = vi.fn();

    camera.stream = { handleSnapshotRequest: snapshotRequest } as never;

    const rtspGet = vi.mocked(nvr.mqtt!.subscribeGet).mock.calls.find(call => call[1] === "rtsp");
    const snapshotSet = vi.mocked(nvr.mqtt!.subscribeSet).mock.calls.find(call => call[1] === "snapshot");
    const doorbellSet = vi.mocked(nvr.mqtt!.subscribeSet).mock.calls.find(call => call[1] === "doorbell");

    expect(rtspGet?.[3]()).toContain("rtsps://192.168.1.1:7447/high?enableSrtp");

    snapshotSet?.[3]("false", "false");
    snapshotSet?.[3]("true", "true");

    expect(snapshotRequest).toHaveBeenCalledTimes(1);

    doorbellSet?.[3]("false", "false");
    doorbellSet?.[3]("true", "true");

    expect(nvr.events.doorbellEventHandler).toHaveBeenCalledWith(camera, expect.any(Number));
  });

  it("polls ambient light and publishes changes", async () => {

    const nvr = createMockNvr();
    let calls = 0;

    vi.mocked(nvr.ufpApi.retrieve).mockImplementation(async () => {
      calls++;

      if(calls === 1) {
        return {
          body: { json: async () => ({ illuminance: 0 }) },
          statusCode: 200
        } as never;
      }

      if(calls === 2) {
        return {
          body: { json: async () => ({ illuminance: 18 }) },
          statusCode: 200
        } as never;
      }

      return {
        body: { json: async () => { throw new Error("bad json"); } },
        statusCode: 500
      } as never;
    });

    const camera = new ProtectCamera(nvr, createMockCameraConfig() as never, createMockAccessory());

    await flushCameraSetup();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    const lightService = camera.accessory.getService(camera.nvr.platform.api.hap.Service.LightSensor)! as ReturnType<typeof createMockService>;
    const activeHandler = getServiceCharacteristicHandlers(lightService, camera.nvr.platform.api.hap.Characteristic.StatusActive);
    const ambientHandler = getServiceCharacteristicHandlers(lightService, camera.nvr.platform.api.hap.Characteristic.CurrentAmbientLightLevel);

    expect(activeHandler.onGet?.()).toBe(true);
    expect(ambientHandler.onGet?.()).toBe(18);
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith(camera.ufp.mac, "ambientlight", "18");

    (camera as unknown as { livestream: { shutdown: () => void } }).livestream = { shutdown: vi.fn() };
    camera.cleanup();

    expect((camera as unknown as { livestream: { shutdown: ReturnType<typeof vi.fn> } }).livestream.shutdown).toHaveBeenCalled();
    expect(camera.accessory.removeController).toHaveBeenCalledWith(expect.objectContaining({ id: "stream-controller" }));
  });

  it("handles access lock state changes and unlock failures", async () => {

    const enabledFeatures = new Set([ "UniFi.Access.Lock" ]);
    const nvr = createMockNvr({
      featureTest: (name: string) => enabledFeatures.has(name)
    });
    const camera = new ProtectCamera(nvr, createMockCameraConfig({
      accessDeviceMetadata: { featureFlags: { supportUnlock: true } }
    }) as never, createMockAccessory());

    await flushCameraSetup();

    const lockService = camera.accessory.getServiceById(camera.nvr.platform.api.hap.Service.LockMechanism, ProtectReservedNames.LOCK_ACCESS)!;
    const onHandler = getServiceCharacteristicHandlers(lockService as ReturnType<typeof createMockService>, camera.nvr.platform.api.hap.Characteristic.LockTargetState);

    await onHandler.onSet?.(camera.nvr.platform.api.hap.Characteristic.LockTargetState.UNSECURED);

    expect(vi.mocked(nvr.ufpApi.retrieve)).toHaveBeenCalledWith("/api/cameras/camera-1/unlock", { method: "POST" });

    await vi.advanceTimersByTimeAsync(2_000);

    expect((lockService.updateCharacteristic as ReturnType<typeof vi.fn>).mock.calls).toEqual(
      expect.arrayContaining([
        [ camera.nvr.platform.api.hap.Characteristic.LockTargetState, camera.nvr.platform.api.hap.Characteristic.LockTargetState.SECURED ],
        [ camera.nvr.platform.api.hap.Characteristic.LockCurrentState, camera.nvr.platform.api.hap.Characteristic.LockCurrentState.SECURED ]
      ])
    );

    vi.mocked(nvr.ufpApi.retrieve).mockResolvedValueOnce({ statusCode: 500 } as never);
    await onHandler.onSet?.(camera.nvr.platform.api.hap.Characteristic.LockTargetState.UNSECURED);
    await vi.advanceTimersByTimeAsync(50);

    expect((camera.nvr.platform.log.error as ReturnType<typeof vi.fn>).mock.calls.join(" ")).toContain("Unable to unlock");
  });

  it("processes add events for access, tamper, and smart detection", async () => {

    const enabledFeatures = new Set([ "Motion.SmartDetect" ]);
    const nvr = createMockNvr({
      featureTest: (name: string) => enabledFeatures.has(name)
    });
    const accessory = createMockAccessory();
    const lockService = createMockService(nvr.platform.api.hap.Service.LockMechanism.UUID);

    lockService.subtype = ProtectReservedNames.LOCK_ACCESS;
    accessory.addService(lockService);

    const camera = new ProtectCamera(nvr, createMockCameraConfig() as never, accessory);

    await flushCameraSetup();

    (camera as unknown as { addEventHandler: (packet: unknown) => void }).addEventHandler({
      header: { modelKey: "event" },
      payload: { metadata: { action: "open_door", openSuccess: true }, type: "smartDetectZone" }
    });

    await vi.advanceTimersByTimeAsync(2_000);

    (camera as unknown as { addEventHandler: (packet: unknown) => void }).addEventHandler({
      header: { modelKey: "event" },
      payload: { type: "smartDetectTamper" }
    });

    (camera as unknown as { addEventHandler: (packet: unknown) => void }).addEventHandler({
      header: { modelKey: "smartDetectObject" },
      payload: { metadata: { reason: "test" }, type: "person" }
    });

    expect(lockService.updateCharacteristic).toHaveBeenCalledWith(
      camera.nvr.platform.api.hap.Characteristic.LockTargetState,
      camera.nvr.platform.api.hap.Characteristic.LockTargetState.UNSECURED
    );
    expect(nvr.events.motionEventHandler).toHaveBeenCalledWith(camera, [ "person" ], { reason: "test" });
  });

  it("processes update events and smart-detect filtering", async () => {

    const enabledFeatures = new Set([ "Motion.SmartDetect", "Nvr.Recording.Switch", "Device.StatusLed.Switch", "Device.NightVision.Dimmer" ]);
    const nvr = createMockNvr({
      featureTest: (name: string) => enabledFeatures.has(name)
    });
    const camera = new ProtectCamera(nvr, createMockCameraConfig() as never, createMockAccessory());

    await flushCameraSetup();

    const configureVideoStreamSpy = vi.spyOn(camera as never, "configureVideoStream" as never).mockResolvedValue(true);
    const updateRecordingActive = vi.fn();
    const configureTimeshifting = vi.fn();

    camera.stream = {
      controller: { id: "stream-controller" },
      hksv: {
        configureTimeshifting,
        isRecording: true,
        timeshift: { isStarted: false },
        updateRecordingActive
      }
    } as never;

    const packet = {
      payload: {
        channels: [],
        isConnected: true,
        ispSettings: { irLedMode: "on" },
        lastMotion: 1,
        lastRing: 2,
        ledSettings: { isEnabled: false },
        metadata: { detectedThumbnails: [ { type: "motion" }, { type: "person" } ] },
        name: "Updated",
        recordingSettings: { mode: "always" },
        smartDetectSettings: { enableTamperDetection: true },
        smartDetectTypes: [ "person" ],
        videoCodec: "h265"
      }
    };

    (camera as unknown as { eventHandler: (event: typeof packet) => void }).eventHandler(packet);
    camera.updateDevice();

    expect(configureVideoStreamSpy).toHaveBeenCalled();
    expect(updateRecordingActive).toHaveBeenCalledWith(true);
    expect(configureTimeshifting).toHaveBeenCalled();
    expect(packet.payload.metadata.detectedThumbnails).toEqual([ { type: "person" } ]);
    expect(nvr.events.motionEventHandler).toHaveBeenCalledWith(camera, [ "person" ], packet.payload.metadata);
    expect(nvr.events.doorbellEventHandler).toHaveBeenCalledWith(camera, 2);
  });

  it("toggles HKSV and NVR recording switches", async () => {

    const enabledFeatures = new Set([ "Video.HKSV.Recording.Switch", "Nvr.Recording.Switch" ]);
    const nvr = createMockNvr({
      featureTest: (name: string) => enabledFeatures.has(name)
    });
    const camera = new ProtectCamera(nvr, createMockCameraConfig() as never, createMockAccessory({
      context: { hksvRecordingDisabled: false }
    }));

    await flushCameraSetup();

    const hksvService = camera.accessory.getServiceById(camera.nvr.platform.api.hap.Service.Switch, ProtectReservedNames.SWITCH_HKSV_RECORDING)!;
    const hksvHandler = getServiceCharacteristicHandlers(hksvService as ReturnType<typeof createMockService>, camera.nvr.platform.api.hap.Characteristic.On);

    hksvHandler.onSet?.(false);
    expect(camera.accessory.context.hksvRecordingDisabled).toBe(true);
    expect(hksvHandler.onGet?.()).toBe(false);

    const updateSpy = vi.spyOn(camera, "updateDevice");
    const alwaysService = camera.accessory.getServiceById(camera.nvr.platform.api.hap.Service.Switch, ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS)!;
    const alwaysHandler = getServiceCharacteristicHandlers(alwaysService as ReturnType<typeof createMockService>, camera.nvr.platform.api.hap.Characteristic.On);

    await alwaysHandler.onSet?.(false);
    await vi.advanceTimersByTimeAsync(50);

    expect(updateSpy).toHaveBeenCalled();

    await alwaysHandler.onSet?.(true);
    expect(camera.ufp.recordingSettings.mode).toBe("always");

    vi.mocked(nvr.ufpApi.updateDevice).mockResolvedValueOnce(null);
    const detectionsService = camera.accessory.getServiceById(camera.nvr.platform.api.hap.Service.Switch, ProtectReservedNames.SWITCH_UFP_RECORDING_DETECTIONS)!;
    const detectionsHandler = getServiceCharacteristicHandlers(detectionsService as ReturnType<typeof createMockService>, camera.nvr.platform.api.hap.Characteristic.On);

    await detectionsHandler.onSet?.(true);

    expect((camera.nvr.platform.log.error as ReturnType<typeof vi.fn>).mock.calls.join(" ")).toContain("Unable to set the UniFi Protect recording mode");
  });

  it("configures camera mode and night vision dimmer", async () => {

    const enabledFeatures = new Set([ "Device.NightVision", "Device.NightVision.Dimmer", "Device.StatusLed" ]);
    const nvr = createMockNvr({
      featureTest: (name: string) => enabledFeatures.has(name)
    });
    const accessory = createMockAccessory();
    const modeService = createMockService(nvr.platform.api.hap.Service.CameraOperatingMode.UUID);

    accessory.addService(modeService);

    const camera = new ProtectCamera(nvr, createMockCameraConfig({
      featureFlags: {
        hasIcrSensitivity: true,
        hasInfrared: true,
        hasLedStatus: true,
        hasLuxCheck: true,
        hasSmartDetect: true,
        hasSpeaker: true,
        hasTamperDetection: true,
        isDoorbell: false,
        smartDetectAudioTypes: [],
        smartDetectTypes: [ "person" ]
      }
    }) as never, accessory);

    await flushCameraSetup();

    const indicator = getServiceCharacteristicHandlers(modeService, camera.nvr.platform.api.hap.Characteristic.CameraOperatingModeIndicator);
    const nightVision = getServiceCharacteristicHandlers(modeService, camera.nvr.platform.api.hap.Characteristic.NightVision);

    await indicator.onSet?.(false);
    await nightVision.onSet?.(false);

    vi.mocked(nvr.ufpApi.updateDevice).mockResolvedValueOnce(null);
    await nightVision.onSet?.(true);
    await vi.advanceTimersByTimeAsync(50);

    const dimmer = camera.accessory.getServiceById(camera.nvr.platform.api.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION)!;
    const dimmerOn = getServiceCharacteristicHandlers(dimmer as ReturnType<typeof createMockService>, camera.nvr.platform.api.hap.Characteristic.On);
    const dimmerBrightness = getServiceCharacteristicHandlers(dimmer as ReturnType<typeof createMockService>, camera.nvr.platform.api.hap.Characteristic.Brightness);

    await dimmerOn.onSet?.(true);
    await dimmerBrightness.onSet?.(3);
    await dimmerBrightness.onSet?.(7);
    await dimmerBrightness.onSet?.(15);
    await dimmerBrightness.onSet?.(95);
    await dimmerBrightness.onSet?.(42);

    expect(vi.mocked(nvr.ufpApi.updateDevice).mock.calls).toEqual(expect.arrayContaining([
      [ expect.anything(), { ispSettings: { irLedMode: "off" } } ],
      [ expect.anything(), { ispSettings: { irLedMode: "autoFilterOnly" } } ],
      [ expect.anything(), { ispSettings: { irLedMode: "auto" } } ],
      [ expect.anything(), { ispSettings: { irLedMode: "on" } } ]
    ]));
  });

  it("finds RTSP entries and utility values", async () => {

    const camera = new ProtectCamera(createMockNvr(), createMockCameraConfig({
      isAdoptedByAccessApp: false,
      isConnected: true,
      isPairedWithAiPort: false,
      isThirdPartyCamera: false,
      videoCodec: "h265"
    }) as never, createMockAccessory());

    await flushCameraSetup();

    (camera as unknown as { rtspEntries: unknown[] }).rtspEntries = [
      { channel: { fps: 30, height: 1080, name: "HIGH", width: 1920 }, name: "high", resolution: [ 1920, 1080, 30 ], url: "high" },
      { channel: { fps: 24, height: 720, name: "MEDIUM", width: 1280 }, name: "medium", resolution: [ 1280, 720, 24 ], url: "medium" },
      { channel: { fps: 15, height: 360, name: "LOW", width: 640 }, name: "low", resolution: [ 640, 360, 15 ], url: "low" }
    ];

    camera.hints.streamingDefault = "MEDIUM";
    camera.hints.recordingDefault = "HIGH";

    expect(camera.findRtsp(640, 360)?.name).toBe("medium");
    expect(camera.findRtsp(1280, 720, { default: "", maxPixels: 921600 })?.name).toBe("medium");
    expect(camera.findRtsp(500, 500, { default: "", biasHigher: true })?.name).toBe("medium");
    expect(camera.findRtsp(100, 100, { default: "", maxPixels: 1 })).toBeNull();
    expect(camera.findRecordingRtsp(640, 360)?.name).toBe("high");
    expect((camera as unknown as { is4x3AspectRatio: (w: number, h: number) => boolean }).is4x3AspectRatio(960, 1280)).toBe(true);
    expect((camera as unknown as { getResolution: (resolution: [number, number, number]) => string }).getResolution([ 1920, 1080, 30 ]))
      .toBe("1920x1080@30fps");

    const entries = [
      { channel: { fps: 15, height: 360, name: "LOW", width: 640 }, name: "low", resolution: [ 640, 360, 15 ], url: "low" },
      { channel: { fps: 30, height: 1080, name: "HIGH", width: 1920 }, name: "high", resolution: [ 1920, 1080, 30 ], url: "high" }
    ];

    entries.sort((a, b) => (camera as unknown as { sortByResolutions: (x: typeof a, y: typeof b) => number }).sortByResolutions(a as never, b as never));

    expect(entries[0].name).toBe("high");
    expect(camera.videoCodecName).toBe("HEVC");
    expect(camera.isOnline).toBe(true);
    expect(camera.isHksvCapable).toBe(true);
  });

  it("builds audio noise filters with nyquist guards", () => {

    const nvr = createMockNvr({
      featureTest: (name: string) => name.startsWith("Audio.Filter.Noise")
    });

    vi.mocked(nvr.platform.featureOptions.getInteger).mockImplementation((name: string) => {
      if(name.endsWith("HighPass")) {
        return 400;
      }

      if(name.endsWith("LowPass")) {
        return 9000;
      }

      return undefined;
    });
    vi.mocked(nvr.platform.featureOptions.getFloat).mockReturnValue(500);

    const camera = new ProtectCamera(nvr, createMockCameraConfig() as never, createMockAccessory());

    expect(camera.getAudioFilters(16000)).toEqual([
      "highpass=p=2:f=400",
      "asendcmd=c='1.0 afftdn sn start ; 3.0 afftdn sn stop', afftdn=nt=c:tn=1:nr=97"
    ]);
    expect(camera.getAudioFilters()).toEqual([
      "highpass=p=2:f=400",
      "lowpass=p=2:f=9000",
      "asendcmd=c='1.0 afftdn sn start ; 3.0 afftdn sn stop', afftdn=nt=c:tn=1:nr=97"
    ]);
  });

  it("covers prefer RTSP and access setup edge branches", async () => {

    const nvr = createMockNvr({
      featureTest: (name: string) => name === "UniFi.Access.Lock"
    });
    const camera = new ProtectCamera(nvr, createMockCameraConfig({
      accessDeviceMetadata: { featureFlags: { supportUnlock: true } }
    }) as never, createMockAccessory());

    await flushCameraSetup();

    expect(camera.preferRtspLiveView).toBe(false);
    camera.activatePreferRtspLiveView();
    expect(camera.preferRtspLiveView).toBe(true);
    camera.preferRtspLiveViewUntil = Date.now() - 1;
    expect(camera.preferRtspLiveView).toBe(false);

    const lockService = camera.accessory.getServiceById(camera.nvr.platform.api.hap.Service.LockMechanism, ProtectReservedNames.LOCK_ACCESS)!;
    const lockHandlers = getServiceCharacteristicHandlers(lockService as ReturnType<typeof createMockService>, camera.nvr.platform.api.hap.Characteristic.LockTargetState);

    (camera as unknown as { timers: Map<string, NodeJS.Timeout> }).timers.set("accessUnlock", setTimeout(() => undefined, 1000));
    await lockHandlers.onSet?.(camera.nvr.platform.api.hap.Characteristic.LockTargetState.SECURED);
    await vi.advanceTimersByTimeAsync(50);

    expect(lockService.updateCharacteristic).toHaveBeenCalledWith(
      camera.nvr.platform.api.hap.Characteristic.LockTargetState,
      camera.nvr.platform.api.hap.Characteristic.LockTargetState.UNSECURED
    );

    const noUnlockCamera = new ProtectCamera(createMockNvr(), createMockCameraConfig({
      accessDeviceMetadata: { featureFlags: { supportUnlock: false } }
    }) as never, createMockAccessory());

    expect((noUnlockCamera as any).configureAccessFeatures()).toBe(false);
  });

  it("covers ambient light and smart sensor failure paths", async () => {

    const nvr = createMockNvr();
    const camera = new ProtectCamera(nvr, createMockCameraConfig() as never, createMockAccessory());

    await flushCameraSetup();

    camera.ufp.featureFlags.hasLuxCheck = false;
    await expect((camera as any).configureAmbientLightSensor()).resolves.toBe(false);
    camera.ufp.featureFlags.hasLuxCheck = true;

    vi.mocked(pluginUtils.acquireService).mockReturnValueOnce(null as never);
    await expect((camera as any).configureAmbientLightSensor()).resolves.toBe(false);

    camera.ufp.isConnected = false;
    await expect((camera as any).configureAmbientLightSensor()).resolves.toBe(true);
    (camera as any).isDeleted = true;
    await vi.advanceTimersByTimeAsync(60_000);

    const accessory = createMockAccessory();
    const staleLicense = createMockService(camera.nvr.platform.api.hap.Service.ContactSensor.UUID);
    const staleSmart = createMockService(camera.nvr.platform.api.hap.Service.ContactSensor.UUID);

    staleLicense.subtype = ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE + ".ABC";
    staleSmart.subtype = ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + ".person";
    accessory.addService(staleLicense);
    accessory.addService(staleSmart);

    const noSmart = new ProtectCamera(createMockNvr(), createMockCameraConfig({
      featureFlags: {
        hasInfrared: true,
        hasLedStatus: true,
        hasLuxCheck: true,
        hasSmartDetect: false,
        hasSpeaker: true,
        hasTamperDetection: true,
        isDoorbell: false,
        smartDetectAudioTypes: [],
        smartDetectTypes: []
      }
    }) as never, accessory);

    noSmart.hints.smartDetectSensors = false;
    expect((noSmart as any).configureMotionSmartSensor()).toBe(false);
  });

  it("covers doorbell switch and trigger failure branches", async () => {

    const nvr = createMockNvr({ featureTest: (name: string) => name === "Doorbell.Mute" });
    const accessory = createMockAccessory({ context: { doorbellMuted: true } });
    const camera = new ProtectCamera(nvr, createMockCameraConfig({
      featureFlags: { isDoorbell: false }
    }) as never, accessory);

    await flushCameraSetup();

    expect((camera as any).configureDoorbellMuteSwitch()).toBe(false);

    accessory.addService(createMockService(camera.nvr.platform.api.hap.Service.Doorbell.UUID));
    vi.mocked(pluginUtils.acquireService).mockReturnValueOnce(null as never);
    expect((camera as any).configureDoorbellMuteSwitch()).toBe(false);

    const triggerNvr = createMockNvr({ featureTest: (name: string) => name === "Doorbell.Trigger" });
    const triggerAccessory = createMockAccessory();
    const triggerCamera = new ProtectCamera(triggerNvr, createMockCameraConfig({
      featureFlags: { isDoorbell: false }
    }) as never, triggerAccessory);

    await flushCameraSetup();

    vi.mocked(pluginUtils.validService).mockReturnValueOnce(false);
    expect((triggerCamera as any).configureDoorbellTrigger()).toBe(false);

    vi.mocked(pluginUtils.acquireService).mockReturnValueOnce(null as never);
    expect((triggerCamera as any).configureVideoDoorbell()).toBe(false);

    const triggerService = createMockService(triggerCamera.nvr.platform.api.hap.Service.Switch.UUID);
    triggerService.subtype = ProtectReservedNames.SWITCH_DOORBELL_TRIGGER;
    triggerAccessory.addService(triggerService);
    (triggerCamera as any).isRinging = true;
    const triggerHandlers = getServiceCharacteristicHandlers(triggerService, triggerCamera.nvr.platform.api.hap.Characteristic.On);

    triggerHandlers.onSet?.(false);
    await vi.advanceTimersByTimeAsync(50);
  });

  it("covers video stream and camera detail fallbacks", async () => {

    const enabledFeatures = new Set([
      "Debug.Video.Startup",
      "Video.Stream.Only.HIGH",
      "Video.HKSV.Record.Only.MEDIUM",
      "Video.HKSV.Recording.Switch"
    ]);
    const nvr = createMockNvr({
      featureTest: (name: string) => enabledFeatures.has(name)
    });
    const accessory = createMockAccessory();
    const modeService = createMockService(nvr.platform.api.hap.Service.CameraOperatingMode.UUID);

    accessory.addService(modeService);

    const camera = new ProtectCamera(nvr, createMockCameraConfig({
      channels: [],
      featureFlags: {
        hasIcrSensitivity: true,
        hasInfrared: true,
        hasLedStatus: true,
        hasLuxCheck: true,
        hasSmartDetect: true,
        hasSpeaker: true,
        hasTamperDetection: true,
        isDoorbell: false,
        smartDetectAudioTypes: [],
        smartDetectTypes: [ "person" ]
      },
      isPairedWithAiPort: false,
      isThirdPartyCamera: true,
      videoCodec: "h264"
    }) as never, accessory);

    await flushCameraSetup();
    await expect((camera as any).configureVideoStream()).resolves.toBe(false);

    camera.ufp.channels = [ { fps: 20, height: 1080, isRtspEnabled: false, name: "Low", rtspAlias: "x", width: 1920 } ] as never;
    await expect((camera as any).configureVideoStream()).resolves.toBe(false);

    camera.ufp.channels = [
      { fps: 22, height: 1536, isRtspEnabled: true, name: "High", rtspAlias: "h", width: 2048 },
      { fps: 13, height: 768, isRtspEnabled: true, name: "Medium", rtspAlias: "m", width: 1024 },
      { fps: 11, height: 0, isRtspEnabled: true, name: "Broken", rtspAlias: "b", width: 1024 }
    ] as never;
    camera.stream = undefined;
    await expect((camera as any).configureVideoStream()).resolves.toBe(true);

    camera.stream = { controller: { id: "stream-controller" } } as never;
    await expect((camera as any).configureVideoStream()).resolves.toBe(true);

    expect(camera.isHksvCapable).toBe(false);
    expect((camera as any).configureCameraDetails()).toBe(true);
    expect((camera as any).configureHksv()).toBe(true);

    vi.mocked(pluginUtils.validService).mockReturnValueOnce(false);
    expect((camera as any).configureHksvRecordingSwitch()).toBe(false);
    vi.mocked(pluginUtils.acquireService).mockReturnValueOnce(null as never);
    expect((camera as any).configureHksvRecordingSwitch()).toBe(false);
    vi.mocked(pluginUtils.validService).mockReturnValueOnce(false);
    expect((camera as any).configureNightVisionDimmer()).toBe(false);
    vi.mocked(pluginUtils.acquireService).mockReturnValueOnce(null as never);
    expect((camera as any).configureNightVisionDimmer()).toBe(false);
  });

  it("covers access and addEvent edge branches", async () => {

    const nvr = createMockNvr({ featureTest: (name: string) => name === "UniFi.Access.Lock" });
    const camera = new ProtectCamera(nvr, createMockCameraConfig({
      accessDeviceMetadata: { featureFlags: { supportUnlock: true } }
    }) as never, createMockAccessory());

    await flushCameraSetup();

    (camera as any).addEventHandler({
      header: { modelKey: "event" },
      payload: { metadata: { action: "open_door", openSuccess: true } }
    });

    vi.mocked(pluginUtils.validService).mockReturnValueOnce(false);
    expect((camera as any).configureAccessFeatures()).toBe(false);

    vi.mocked(pluginUtils.acquireService).mockReturnValueOnce(null as never);
    expect((camera as any).configureAccessFeatures()).toBe(false);

    const lockService = camera.accessory.getServiceById(camera.nvr.platform.api.hap.Service.LockMechanism, ProtectReservedNames.LOCK_ACCESS)!;
    const lockHandlers = getServiceCharacteristicHandlers(lockService as ReturnType<typeof createMockService>, camera.nvr.platform.api.hap.Characteristic.LockTargetState);

    await lockHandlers.onSet?.(camera.nvr.platform.api.hap.Characteristic.LockTargetState.SECURED);
    await vi.advanceTimersByTimeAsync(50);
  });

  it("covers doorbell mute and trigger callback branches", async () => {

    const enabledFeatures = new Set([ "Doorbell.Mute", "Doorbell.Trigger" ]);
    const nvr = createMockNvr({ featureTest: (name: string) => enabledFeatures.has(name) });
    const accessory = createMockAccessory();

    accessory.addService(createMockService(nvr.platform.api.hap.Service.Doorbell.UUID));

    const camera = new ProtectCamera(nvr, createMockCameraConfig({
      featureFlags: { isDoorbell: true }
    }) as never, accessory);

    await flushCameraSetup();

    const muteService = camera.accessory.getServiceById(camera.nvr.platform.api.hap.Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_MUTE)!;
    const muteHandlers = getServiceCharacteristicHandlers(muteService as ReturnType<typeof createMockService>, camera.nvr.platform.api.hap.Characteristic.On);
    muteHandlers.onSet?.(true);
    muteHandlers.onSet?.(false);

    vi.mocked(pluginUtils.acquireService).mockReturnValueOnce(null as never);
    expect((camera as any).configureDoorbellTrigger()).toBe(false);

    const triggerService = camera.accessory.getServiceById(camera.nvr.platform.api.hap.Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_TRIGGER)!;
    const triggerHandlers = getServiceCharacteristicHandlers(triggerService as ReturnType<typeof createMockService>, camera.nvr.platform.api.hap.Characteristic.On);

    triggerHandlers.onSet?.(true);
    (camera as any).isRinging = true;
    triggerHandlers.onSet?.(false);
    await vi.advanceTimersByTimeAsync(60);
  });

  it("covers night vision and updateDevice branch paths", async () => {

    const enabledFeatures = new Set([ "Device.NightVision", "Device.NightVision.Dimmer", "Device.StatusLed", "Nvr.Recording.Switch" ]);
    const nvr = createMockNvr({
      featureTest: (name: string) => enabledFeatures.has(name)
    });
    const accessory = createMockAccessory();
    const modeService = createMockService(nvr.platform.api.hap.Service.CameraOperatingMode.UUID);

    accessory.addService(modeService);

    const camera = new ProtectCamera(nvr, createMockCameraConfig({
      featureFlags: {
        hasIcrSensitivity: true,
        hasInfrared: true,
        hasLedStatus: true,
        hasLuxCheck: true,
        hasSmartDetect: true,
        hasSpeaker: true,
        hasTamperDetection: true,
        isDoorbell: false,
        smartDetectAudioTypes: [],
        smartDetectTypes: [ "person" ]
      }
    }) as never, accessory);

    await flushCameraSetup();

    const dimmer = camera.accessory.getServiceById(camera.nvr.platform.api.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION)!;
    const dimmerOn = getServiceCharacteristicHandlers(dimmer as ReturnType<typeof createMockService>, camera.nvr.platform.api.hap.Characteristic.On);
    const dimmerBrightness = getServiceCharacteristicHandlers(dimmer as ReturnType<typeof createMockService>, camera.nvr.platform.api.hap.Characteristic.Brightness);

    dimmerBrightness.value = 5;
    await dimmerOn.onSet?.(true);
    camera.ufp.ispSettings.irLedMode = "customFilterOnly";
    dimmerBrightness.value = 33;
    await dimmerOn.onSet?.(true);

    vi.mocked(nvr.ufpApi.updateDevice).mockResolvedValueOnce(null);
    await dimmerOn.onSet?.(false);
    vi.mocked(nvr.ufpApi.updateDevice).mockResolvedValueOnce(null);
    await dimmerBrightness.onSet?.(42);

    camera.hints.ledStatus = true;
    camera.hints.nightVision = true;
    camera.updateDevice();

    camera.ufp.ispSettings.irLedMode = "off";
    expect((camera as any).nightVisionBrightness).toBe(0);
    camera.ufp.ispSettings.irLedMode = "autoFilterOnly";
    expect((camera as any).nightVisionBrightness).toBe(5);
    camera.ufp.ispSettings.irLedMode = "on";
    expect((camera as any).nightVisionBrightness).toBe(100);
    camera.ufp.ispSettings.irLedMode = "custom";
    expect((camera as any).nightVisionBrightness).toBe((camera.ufp.ispSettings.icrCustomValue * 7) + 20);
    camera.ufp.ispSettings.irLedMode = "unexpected" as never;
    expect((camera as any).nightVisionBrightness).toBe(0);
  });

  it("covers utility fallbacks and disabled audio filter", async () => {

    const camera = new ProtectCamera(createMockNvr(), createMockCameraConfig() as never, createMockAccessory());
    await flushCameraSetup();

    camera.hints.streamingDefault = "";
    (camera as any).rtspEntries = [
      { channel: { fps: 30, height: 1080, name: "HIGH", width: 1920 }, name: "high", resolution: [ 1920, 1080, 30 ], url: "high" },
      { channel: { fps: 24, height: 720, name: "MEDIUM", width: 1280 }, name: "medium", resolution: [ 1280, 720, 24 ], url: "medium" }
    ];

    expect(camera.findRtsp(6000, 6000, { default: "", biasHigher: true })?.name).toBe("high");
    expect(camera.getAudioFilters()).toEqual([]);

    const compare = (camera as any).sortByResolutions.bind(camera) as (a: any, b: any) => number;

    expect(compare(
      { resolution: [ 640, 360, 30 ] },
      { resolution: [ 640, 720, 30 ] }
    )).toBe(1);
    expect(compare(
      { resolution: [ 640, 720, 30 ] },
      { resolution: [ 640, 360, 30 ] }
    )).toBe(-1);
    expect(compare(
      { resolution: [ 640, 360, 15 ] },
      { resolution: [ 640, 360, 30 ] }
    )).toBe(1);
    expect(compare(
      { resolution: [ 640, 360, 30 ] },
      { resolution: [ 640, 360, 15 ] }
    )).toBe(-1);
    expect(compare(
      { resolution: [ 640, 360, 30 ] },
      { resolution: [ 640, 360, 30 ] }
    )).toBe(0);
  });

  it("cleans up HKSV recording state", async () => {

    const camera = new ProtectCamera(createMockNvr(), createMockCameraConfig() as never, createMockAccessory());
    const updateRecordingActive = vi.fn();

    await flushCameraSetup();

    camera.stream = {
      controller: { id: "stream-controller" },
      hksv: {
        isRecording: true,
        timeshift: { isStarted: true },
        updateRecordingActive
      }
    } as never;
    (camera as unknown as { livestream: { shutdown: () => void } }).livestream = { shutdown: vi.fn() };

    camera.cleanup();

    expect(updateRecordingActive).toHaveBeenCalledWith(false);
    expect((camera as unknown as { livestream: { shutdown: ReturnType<typeof vi.fn> } }).livestream.shutdown).toHaveBeenCalled();
  });

  it("covers hksv host profile branches and mqtt rtsp fallbacks", async () => {

    const enabledFeatures = new Set([
      "Debug.Video.Startup",
      "Motion.SmartDetect",
      "Nvr.Recording.Switch",
      "Video.HKSV.Recording.Switch"
    ]);
    const nvr = createMockNvr({
      config: { overrideAddress: "10.0.0.5" },
      featureTest: (name: string) => enabledFeatures.has(name)
    });
    const accessory = createMockAccessory();
    const camera = new ProtectCamera(nvr, createMockCameraConfig({
      channels: [ { fps: 20, height: 1080, isRtspEnabled: true, name: "Medium", rtspAlias: "m", width: 1920 } ],
      featureFlags: {
        hasSmartDetect: true,
        smartDetectAudioTypes: [],
        smartDetectTypes: []
      },
      recordingSettings: { mode: "never" }
    }) as never, accessory);

    await flushCameraSetup();

    camera.stream = undefined;
    camera.hints.recordingDefault = "";
    vi.mocked(hostProfile.detectHostProfile).mockReturnValueOnce("pi");
    vi.mocked(hostProfile.resolveHksvRecordingDefault).mockReturnValueOnce("High");
    await expect((camera as any).configureVideoStream()).resolves.toBe(true);
    expect(camera.hints.recordingDefault).toBe("Medium");

    camera.stream = undefined;
    camera.hints.recordingDefault = "high";
    await expect((camera as any).configureVideoStream()).resolves.toBe(true);
    expect(nvr.log.info).toHaveBeenCalledWith(expect.stringContaining("HomeKit Secure Video event recording configured to use only: high"));

    vi.mocked(pluginUtils.acquireService).mockReturnValueOnce(null as never);
    expect((camera as any).configureNvrRecordingSwitch()).toBe(true);

    const rtspGet = vi.mocked(nvr.mqtt!.subscribeGet).mock.calls.find(call => call[2] === "RTSP information")?.[3] as () => string;
    expect(rtspGet()).toContain("10.0.0.5");
  });

  it("covers smart detect logging and ring event null payload", async () => {

    const nvr = createMockNvr({ featureTest: (name: string) => name === "Motion.SmartDetect" });
    const camera = new ProtectCamera(nvr, createMockCameraConfig({
      featureFlags: {
        hasSmartDetect: true,
        smartDetectAudioTypes: [],
        smartDetectTypes: []
      }
    }) as never, createMockAccessory());

    await flushCameraSetup();

    (camera as any).eventHandler({
      header: { action: "update", id: camera.ufp.id, modelKey: "camera" },
      payload: { lastRing: null }
    });

    expect(nvr.log.info).toHaveBeenCalledWith(expect.stringContaining("Smart motion detection enabled"));
  });
});
