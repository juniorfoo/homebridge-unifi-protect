import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProtectCameraPackage } from "../../src/devices/protect-camera-package.js";
import { createMockAccessory, createMockCameraConfig, createMockNvr, createMockService, getServiceCharacteristicHandlers } from "../helpers/mocks.js";

const mockState = vi.hoisted(() => ({
  streamCtor: vi.fn(function(this: Record<string, unknown>) {

    this.controller = { id: "controller" };
    this.ffmpegOptions = { hostSystemMaxPixels: 2073600 };
    this.hksv = { isRecording: false, timeshift: { isStarted: true }, updateRecordingActive: vi.fn() };
  })
}));

vi.mock("../../src/protect-livestream.js", () => ({

  LivestreamManager: vi.fn().mockImplementation(() => ({
    acquire: vi.fn(),
    shutdown: vi.fn(),
    start: vi.fn(),
    stop: vi.fn()
  }))
}));

vi.mock("../../src/protect-stream.js", () => ({

  ProtectStreamingDelegate: mockState.streamCtor
}));

describe("ProtectCameraPackage", () => {

  beforeEach(() => {

    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {

    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("configures package camera context and stream delegate", () => {

    const nvr = createMockNvr();
    const accessory = createMockAccessory({
      context: { detectMotion: false, hksvRecordingDisabled: true }
    });
    const cameraConfig = createMockCameraConfig({
      featureFlags: { ...(createMockCameraConfig().featureFlags as object), hasPackageCamera: true }
    });
    const parentHints = {
      hardwareDecoding: false,
      hardwareTranscoding: true,
      highResSnapshots: true,
      logHksv: true,
      transcode: true,
      transcodeBitrate: 2500,
      transcodeHighLatency: false,
      transcodeHighLatencyBitrate: 1800,
      tsbStreaming: true
    };

    (nvr.getDeviceById as ReturnType<typeof vi.fn>).mockReturnValue({ hints: parentHints });
    vi.spyOn(ProtectCameraPackage.prototype as never, "configureInfo" as never).mockReturnValue(true);
    vi.spyOn(ProtectCameraPackage.prototype as never, "configureMotionSensor" as never).mockReturnValue(true);
    vi.spyOn(ProtectCameraPackage.prototype as never, "configureFlashlight" as never).mockReturnValue(true);

    const packageCamera = new ProtectCameraPackage(nvr, cameraConfig as never, accessory);

    expect(packageCamera.hints.hardwareTranscoding).toBe(true);
    expect(packageCamera.hints.transcodeBitrate).toBe(2500);
    expect(packageCamera.accessory.context.detectMotion).toBe(false);
    expect(packageCamera.accessory.context.packageCamera).toBe(cameraConfig.mac);
    expect(mockState.streamCtor).toHaveBeenCalled();
    expect(accessory.configureController).toHaveBeenCalled();
  });

  it("finds package RTSP channels and recording stream", () => {

    vi.spyOn(ProtectCameraPackage.prototype as never, "configureDevice" as never).mockReturnValue(true);
    const nvr = createMockNvr();
    const camera = new ProtectCameraPackage(nvr, createMockCameraConfig() as never, createMockAccessory());

    const rtsp = camera.findRtsp();
    expect(rtsp?.lens).toBe(2);
    expect(rtsp?.resolution).toEqual([ 1600, 1200, 15 ]);
    expect(camera.findRecordingRtsp()).toEqual(rtsp);

    camera.ufp.channels = [];
    expect(camera.findRtsp()).toBeNull();
  });

  it("configures flashlight controls and heartbeat behavior", async () => {

    vi.spyOn(ProtectCameraPackage.prototype as never, "configureDevice" as never).mockReturnValue(true);
    const nvr = createMockNvr({
      featureTest: (name: string) => name === "Doorbell.PackageCamera.Flashlight"
    });
    const packageCamera = new ProtectCameraPackage(nvr, createMockCameraConfig({ isDark: false }) as never, createMockAccessory());
    const service = createMockService("lightbulb");

    vi.spyOn(packageCamera as never, "validService" as never).mockReturnValue(true);
    vi.spyOn(packageCamera as never, "acquireService" as never).mockReturnValue(service);

    expect((packageCamera as unknown as { configureFlashlight: () => boolean }).configureFlashlight()).toBe(true);

    const handlers = getServiceCharacteristicHandlers(service, "On");
    await (handlers.onSet as (value: unknown) => Promise<void>)(true);
    await vi.runAllTimersAsync();

    expect(service.updateCharacteristic).toHaveBeenCalledWith("On", false);

    packageCamera.ufp.isDark = true;
    await (handlers.onSet as (value: unknown) => Promise<void>)(true);
    expect(nvr.ufpApi.retrieve).toHaveBeenCalled();
    expect((packageCamera as unknown as { timers: Map<string, unknown> }).timers.has("flashlight")).toBe(true);

    await (handlers.onSet as (value: unknown) => Promise<void>)(false);
    expect((packageCamera as unknown as { timers: Map<string, unknown> }).timers.has("flashlight")).toBe(false);
  });

  it("covers flashlight setup failure and startup debug mapping", () => {

    vi.spyOn(ProtectCameraPackage.prototype as never, "configureDevice" as never).mockReturnValue(true);
    const nvr = createMockNvr({
      featureTest: (name: string) => name === "Doorbell.PackageCamera.Flashlight" || name === "Debug.Video.Startup"
    });
    const packageCamera = new ProtectCameraPackage(nvr, createMockCameraConfig({ isDark: true }) as never, createMockAccessory());

    vi.spyOn(packageCamera as never, "validService" as never).mockReturnValue(true);
    vi.spyOn(packageCamera as never, "acquireService" as never).mockReturnValue(null);

    expect((packageCamera as unknown as { configureFlashlight: () => boolean }).configureFlashlight()).toBe(false);
    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to add flashlight."));
  });

  it("preserves HKSV context and supports 16:9 fallback resolutions", () => {

    const nvr = createMockNvr({
      featureTest: (name: string) => name === "Video.HKSV.Recording.Switch"
    });
    const accessory = createMockAccessory({
      context: { detectMotion: true, hksvRecordingDisabled: true }
    });
    vi.spyOn(ProtectCameraPackage.prototype as never, "findRtsp" as never).mockReturnValue({
      channel: { fps: 15, height: 1080, width: 1920 },
      lens: 2,
      name: "HD",
      resolution: [ 1920, 1080, 15 ],
      url: "rtsps://example"
    });

    const packageCamera = new ProtectCameraPackage(nvr, createMockCameraConfig() as never, accessory);

    expect(packageCamera.accessory.context.hksvRecordingDisabled).toBe(true);
    expect(mockState.streamCtor).toHaveBeenCalled();
  });

  it("handles flashlight activation failures and package camera id", async () => {

    vi.spyOn(ProtectCameraPackage.prototype as never, "configureDevice" as never).mockReturnValue(true);
    const nvr = createMockNvr({
      featureTest: (name: string) => name === "Doorbell.PackageCamera.Flashlight"
    });
    const packageCamera = new ProtectCameraPackage(nvr, createMockCameraConfig({ isDark: true }) as never, createMockAccessory());
    const service = createMockService("lightbulb");

    vi.spyOn(packageCamera as never, "validService" as never).mockReturnValue(true);
    vi.spyOn(packageCamera as never, "acquireService" as never).mockReturnValue(service);
    expect((packageCamera as any).configureFlashlight()).toBe(true);

    const handlers = getServiceCharacteristicHandlers(service, "On");
    (packageCamera as any).ufp.isConnected = false;
    await (handlers.onSet as (value: unknown) => Promise<void>)(true);
    expect(service.updateCharacteristic).toHaveBeenCalledWith("On", false);

    (packageCamera as any).ufp.isConnected = true;
    vi.mocked(nvr.ufpApi.responseOk).mockReturnValue(false);
    await (handlers.onSet as (value: unknown) => Promise<void>)(true);
    await (handlers.onSet as (value: unknown) => Promise<void>)(false);
    expect((packageCamera as unknown as { timers: Map<string, unknown> }).timers.has("flashlight")).toBe(false);
    expect(packageCamera.id).toBe(`${packageCamera.ufp.mac}.PackageCamera`);
  });
});
