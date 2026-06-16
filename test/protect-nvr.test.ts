import { APIEvent } from "homebridge";
import { createMockAccessory, createMockHap, createMockPlatform, createMockService, nvrBootstrap, setNvrBootstrap } from "./helpers/mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => {

  class MockDevice {

    public accessory: any;
    public accessoryName = "Mock Device";
    public cleanup = vi.fn();
    public configureInfo = vi.fn();
    public hints = { enabled: true, logMotion: false, smartOccupancy: [], standalone: false, syncName: false };
    public id: string;
    public isOnline = true;
    public log = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    public packageCamera = null;
    public stream = null;
    public ufp: Record<string, unknown>;
    public updateDevice = vi.fn();

    constructor(_nvr: unknown, ufp: Record<string, unknown>, accessory: any) {

      this.accessory = accessory;
      this.id = String(ufp.id ?? "mock-id");
      this.ufp = ufp;
    }
  }

  class ProtectCameraMock extends MockDevice {}
  class ProtectDoorbellMock extends ProtectCameraMock {}

  class ProtectApiMock {

    public __log: Record<string, (...parameters: unknown[]) => void>;
    public bootstrap: Record<string, unknown> | null = null;
    public getBootstrap = vi.fn(async () => undefined);
    public getDeviceName = vi.fn((device: { name?: string; marketName?: string }) => device.name ?? device.marketName ?? "Mock Device");
    public isThrottled = false;
    public login = vi.fn(async () => true);
    public logout = vi.fn();
    public name = "Mock NVR";
    public on = vi.fn((event: string, handler: (...parameters: unknown[]) => void) => {

      const handlers = this._handlers[event] ?? [];

      handlers.push(handler);
      this._handlers[event] = handlers;
    });
    public reset = vi.fn();
    public retrieve = vi.fn(async () => undefined);
    private _handlers: Record<string, ((...parameters: unknown[]) => void)[]> = {};

    constructor(log: Record<string, (...parameters: unknown[]) => void>) {

      this.__log = log;
    }

    public emit(event: string, ...parameters: unknown[]): void {

      for(const handler of this._handlers[event] ?? []) {

        handler(...parameters);
      }
    }
  }

  class ProtectEventsMock {

    public emit = vi.fn();
    public off = vi.fn();
    public on = vi.fn();

    constructor(_nvr: unknown) {}
  }

  class ProtectLiveviewsMock {

    public configureLiveviews = vi.fn();

    constructor(_nvr: unknown) {}
  }

  class ProtectNvrSystemInfoMock {

    public cleanup = vi.fn();

    constructor(_nvr: unknown) {}
  }

  return {
    ProtectApiMock,
    ProtectCameraMock,
    ProtectDoorbellMock,
    ProtectEventsMock,
    ProtectLiveviewsMock,
    ProtectNvrSystemInfoMock
  };
});

vi.mock("unifi-protect", () => ({
  ProtectApi: testState.ProtectApiMock
}));

vi.mock("../src/protect-events.js", () => ({
  ProtectEvents: testState.ProtectEventsMock
}));

vi.mock("../src/devices/index.js", () => ({
  ProtectCamera: testState.ProtectCameraMock,
  ProtectChime: testState.ProtectCameraMock,
  ProtectDoorbell: testState.ProtectDoorbellMock,
  ProtectLight: testState.ProtectCameraMock,
  ProtectLiveviews: testState.ProtectLiveviewsMock,
  ProtectNvrSystemInfo: testState.ProtectNvrSystemInfoMock,
  ProtectSensor: testState.ProtectCameraMock,
  ProtectViewer: testState.ProtectCameraMock
}));

const serverState = vi.hoisted(() => ({
  close: vi.fn(),
  listen: vi.fn(),
  on: vi.fn(),
  requestHandler: null as null | ((request: unknown, response: { end: () => void; write: (value: string) => void; writeHead: (code: number, headers: object) => void }) => void)
}));

vi.mock("node:http", () => ({
  default: {
    createServer: vi.fn(() => ({
      close: serverState.close,
      listen: serverState.listen,
      on: vi.fn((event: string, handler: (...parameters: unknown[]) => void) => {

        if(event === "request") {

          serverState.requestHandler = handler as typeof serverState.requestHandler;
        }

        return serverState.on(event, handler);
      })
    }))
  }
}));

function createPlatformWithEmitter() {

  const emitterHandlers = new Map<string, ((...parameters: unknown[]) => void)[]>();
  const api = {} as {
    hap: ReturnType<typeof createMockHap>;
    on: ReturnType<typeof vi.fn>;
    emit: (event: string, ...parameters: unknown[]) => void;
    platformAccessory: ReturnType<typeof vi.fn>;
    publishExternalAccessories: ReturnType<typeof vi.fn>;
    registerPlatformAccessories: ReturnType<typeof vi.fn>;
    unregisterPlatformAccessories: ReturnType<typeof vi.fn>;
    updatePlatformAccessories: ReturnType<typeof vi.fn>;
  };
  const hap = createMockHap();

  api.hap = hap;
  api.on = vi.fn((event: string, handler: (...parameters: unknown[]) => void) => {

    const handlers = emitterHandlers.get(event) ?? [];

    handlers.push(handler);
    emitterHandlers.set(event, handlers);
  });
  api.emit = (event: string, ...parameters: unknown[]) => {

    for(const handler of emitterHandlers.get(event) ?? []) {

      handler(...parameters);
    }
  };
  api.publishExternalAccessories = vi.fn();
  api.registerPlatformAccessories = vi.fn();
  api.unregisterPlatformAccessories = vi.fn();
  api.updatePlatformAccessories = vi.fn();
  api.platformAccessory = vi.fn((name: string, uuid: string) => createMockAccessory({ UUID: uuid, context: { nvr: "AA:BB:CC:DD:EE:01" }, displayName: name }));

  return createMockPlatform({
    api: api,
    featureOptions: {
      getFloat: vi.fn(() => undefined),
      getInteger: vi.fn(() => undefined),
      scope: vi.fn(() => "controller"),
      test: vi.fn(() => true)
    } as never
  } as never);
}

let ProtectNvrClass: any;
let PROTECT_CONTROLLER_REFRESH_INTERVAL_VALUE = 0;
let PROTECT_M3U_PLAYLIST_PORT_VALUE = 0;
let PROTECT_NVR_REBOOT_MIN_INTERVAL_VALUE = 0;
let ProtectReservedNamesValue: { SWITCH_MOTION_TRIGGER: string };

function createNvr(overrides: Record<string, unknown> = {}) {

  const platform = createPlatformWithEmitter();
  const nvr = new ProtectNvrClass(platform as never, {
    address: "10.0.0.5",
    mqttTopic: "test/topic",
    password: "password",
    username: "username",
    ...overrides
  });

  return { nvr, platform };
}

function createBootstrap() {

  return {
    cameras: [
      {
        channels: [
          { isRtspEnabled: true, rtspAlias: "rtsp-main" },
          { isRtspEnabled: true, name: "Package Camera", rtspAlias: "rtsp-package" }
        ],
        featureFlags: { hasPackageCamera: true, isDoorbell: false },
        id: "camera-1",
        isAdopted: true,
        isAdoptedByOther: false,
        mac: "AA:BB:CC:DD:EE:11",
        marketName: "G5 Pro",
        modelKey: "camera",
        name: "Front Door",
        videoCodec: "h264"
      }
    ],
    chimes: [ { id: "chime-1", isAdopted: true, isAdoptedByOther: false, mac: "AA:BB:CC:DD:EE:21", marketName: "Chime", modelKey: "chime", name: "Chime" } ],
    lights: [ { id: "light-1", isAdopted: true, isAdoptedByOther: false, mac: "AA:BB:CC:DD:EE:31", marketName: "Light", modelKey: "light", name: "Light" } ],
    nvr: {
      firmwareVersion: "4.0.0",
      host: "10.0.0.5",
      id: "nvr-id",
      mac: "AA:BB:CC:DD:EE:01",
      modelKey: "nvr",
      name: "Main NVR",
      ports: { rtsp: 7447 },
      upSince: Date.now() - 5_000,
      version: "7.0.1"
    },
    sensors: [ { id: "sensor-1", isAdopted: true, isAdoptedByOther: false, mac: "AA:BB:CC:DD:EE:41", marketName: "Sensor", modelKey: "sensor", name: "Sensor" } ],
    viewers: [ { id: "viewer-1", isAdopted: true, isAdoptedByOther: false, mac: "AA:BB:CC:DD:EE:51", marketName: "Viewer", modelKey: "viewer", name: "Viewer" } ]
  };
}

describe("ProtectNvr", () => {

  beforeEach(async () => {

    vi.clearAllMocks();
    vi.useRealTimers();
    serverState.requestHandler = null;
    ({ ProtectNvr: ProtectNvrClass } = await import("../src/protect-nvr.js"));
    ({ PROTECT_CONTROLLER_REFRESH_INTERVAL: PROTECT_CONTROLLER_REFRESH_INTERVAL_VALUE, PROTECT_M3U_PLAYLIST_PORT: PROTECT_M3U_PLAYLIST_PORT_VALUE,
      PROTECT_NVR_REBOOT_MIN_INTERVAL: PROTECT_NVR_REBOOT_MIN_INTERVAL_VALUE } = await import("../src/settings.js"));
    ({ ProtectReservedNames: ProtectReservedNamesValue } = await import("../src/protect-types.js"));
  });

  it("initializes config and logging prefix from configured name", () => {

    const { nvr, platform } = createNvr({ name: "Main NVR" });

    nvr.log.info("Connected.");

    expect((nvr as unknown as { name: string }).name).toBe("Main NVR");
    expect(platform.log.info).toHaveBeenCalledWith("Main NVR: Connected.");
  });

  it("suppresses API logger errors when disabled", () => {

    const { nvr, platform } = createNvr();
    const ufpApi = nvr.ufpApi as unknown as { __log: { error: (message: string, ...parameters: unknown[]) => void } };

    ufpApi.__log.error("api error %s", "one");
    nvr.logApiErrors = false;
    ufpApi.__log.error("api error %s", "two");

    expect(platform.log.error).toHaveBeenCalledTimes(1);
    expect(platform.log.error).toHaveBeenCalledWith("api error one");
  });

  it("disconnect tears down camera resources and API session", () => {

    const { nvr } = createNvr();
    const streamShutdown = vi.fn();
    const timeshiftStop = vi.fn();
    const packageStreamShutdown = vi.fn();
    const packageTimeshiftStop = vi.fn();
    const systemCleanup = vi.fn();

    nvr.configuredDevices.set("camera-1", {
      packageCamera: {
        stream: {
          hksv: { timeshift: { stop: packageTimeshiftStop } },
          shutdown: packageStreamShutdown
        }
      },
      stream: {
        hksv: { timeshift: { stop: timeshiftStop } },
        shutdown: streamShutdown
      },
      ufp: { modelKey: "camera" }
    } as never);
    (nvr as unknown as { bootstrapRefreshTimer: NodeJS.Timeout | null }).bootstrapRefreshTimer = setTimeout(() => undefined, 60_000);
    nvr.systemInfo = { cleanup: systemCleanup } as never;

    (nvr as unknown as { disconnect: () => void }).disconnect();

    expect(streamShutdown).toHaveBeenCalledTimes(1);
    expect(timeshiftStop).toHaveBeenCalledTimes(1);
    expect(packageStreamShutdown).toHaveBeenCalledTimes(1);
    expect(packageTimeshiftStop).toHaveBeenCalledTimes(1);
    expect(systemCleanup).toHaveBeenCalledTimes(1);
    expect(nvr.ufpApi.reset).toHaveBeenCalledTimes(1);
  });

  it("registers shutdown handler and disconnects on API shutdown", () => {

    const { nvr, platform } = createNvr();
    const disconnectSpy = vi.spyOn(nvr as unknown as { disconnect: () => void }, "disconnect");

    (platform.api as unknown as { emit: (event: string, ...parameters: unknown[]) => void }).emit(APIEvent.SHUTDOWN);

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });

  it("login exits immediately when NVR feature is disabled", async () => {

    const { nvr, platform } = createNvr();

    platform.featureOptions.test = vi.fn(() => false);
    await nvr.login();

    expect(platform.log.info).toHaveBeenCalledWith("10.0.0.5: Disabling this UniFi Protect controller.");
    expect(nvr.ufpApi.login).not.toHaveBeenCalled();
  });

  it("login exits when connect cannot bootstrap", async () => {

    const { nvr, platform } = createNvr();

    platform.featureOptions.test = vi.fn(() => true);
    setNvrBootstrap(nvr, null);
    nvr.ufpApi.getBootstrap = vi.fn(async () => undefined);

    await nvr.login();

    expect(platform.log.error).toHaveBeenCalledWith("10.0.0.5: Unable to connect to the Protect controller. This may be due to the controller rebooting or becoming unavailable.");
  });

  it("login fully initializes services and bootstrap refresh listener", async () => {

    vi.useFakeTimers();
    const { nvr, platform } = createNvr({ mqttUrl: "mqtt://localhost", overrideAddress: "nvr.example" });
    const bootstrap = createBootstrap();

    setNvrBootstrap(nvr, bootstrap);
    nvr.ufpApi.getBootstrap = vi.fn(async () => undefined);
    platform.featureOptions.test = vi.fn((option: string) => option !== "Device.Standalone");

    const syncSpy = vi.spyOn(nvr as unknown as { syncDevices: () => void }, "syncDevices");
    const playlistSpy = vi.spyOn(nvr as unknown as { servePlaylist: () => void }, "servePlaylist");

    await nvr.login();

    expect(nvr.ufp.version).toBe("7.0.1");
    expect(nvr.mqtt).not.toBeNull();
    expect(playlistSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(platform.log.info).toHaveBeenCalledWith("Mock NVR: Connected to 10.0.0.5 (UniFi Protect 7.0.1 running on UniFi OS 4.0.0).");
    expect(nvr.ufpApi.on).toHaveBeenCalledWith("bootstrap", expect.any(Function));

    const bootstrapHandler = (nvr.ufpApi.on as ReturnType<typeof vi.fn>).mock.calls.find(([event]) => event === "bootstrap")?.[1] as (() => void);

    bootstrapHandler();
    vi.advanceTimersByTime((PROTECT_CONTROLLER_REFRESH_INTERVAL_VALUE * 1000) + 1);

    expect(syncSpy).toHaveBeenCalledTimes(2);
    expect(nvr.ufpApi.getBootstrap).toHaveBeenCalled();
  });

  it("disables and unregisters cached accessories when device gets disabled post-connect", async () => {

    const { nvr, platform } = createNvr();
    const bootstrap = createBootstrap();
    const accessory = createMockAccessory({
      UUID: "old-accessory",
      context: { nvr: bootstrap.nvr.mac }
    });

    platform.accessories.push(accessory);
    setNvrBootstrap(nvr, bootstrap);
    platform.featureOptions.test = vi.fn((option: string, _deviceMac?: string, nvrMac?: string) => !(option === "Device" && !!nvrMac));
    const removeSpy = vi.spyOn(nvr, "removeHomeKitDevice");

    await nvr.login();

    expect(nvr.ufpApi.logout).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith(accessory, true);
  });

  it("adds and updates homekit devices across feature branches", () => {

    const { nvr, platform } = createNvr();
    const cameraDevice = {
      featureFlags: { isDoorbell: false },
      id: "camera-1",
      isAdopted: true,
      isAdoptedByOther: false,
      mac: "AA:BB:CC:DD:EE:11",
      marketName: "Camera",
      modelKey: "camera",
      name: "Camera"
    };

    nvr.ufp = { mac: "AA:BB:CC:DD:EE:01" } as never;
    platform.featureOptions.test = vi.fn((option: string) => option !== "Device.Standalone");

    expect(nvr.addHomeKitDevice({ ...cameraDevice, modelKey: "bridgeDisplay" } as never)).toBe(false);
    expect(nvr.addHomeKitDevice({ ...cameraDevice, isAdoptedByOther: true } as never)).toBe(false);

    expect(nvr.addHomeKitDevice(cameraDevice as never)).toBe(true);
    expect(platform.api.registerPlatformAccessories).toHaveBeenCalledTimes(1);

    const standaloneDevice = { ...cameraDevice, id: "camera-2", mac: "AA:BB:CC:DD:EE:12" };

    platform.featureOptions.test = vi.fn((option: string) => option === "Device.Standalone" || option === "Device");
    expect(nvr.addHomeKitDevice(standaloneDevice as never)).toBe(true);
    expect(platform.api.publishExternalAccessories).toHaveBeenCalledTimes(1);

    const existingUuid = nvr.platform.api.hap.uuid.generate(cameraDevice.mac);
    const existingAccessory = nvr.platform.accessories.find((x: { UUID: string }) => x.UUID === existingUuid)!;

    nvr.configuredDevices.set(existingAccessory.UUID, {
      accessory: existingAccessory,
      hints: { enabled: true, standalone: false },
      ufp: cameraDevice
    } as never);
    expect(nvr.addHomeKitDevice(cameraDevice as never)).toBe(true);
    expect((nvr.events as unknown as { emit: ReturnType<typeof vi.fn> }).emit).toHaveBeenCalledWith("updateEvent", expect.objectContaining({
      header: expect.objectContaining({ action: "update", hbupBootstrap: true })
    }));
  });

  it("removes homekit devices and handles delayed removals", () => {

    vi.useFakeTimers();
    const { nvr, platform } = createNvr();
    const hap = platform.api.hap;
    const infoService = createMockService(hap.Service.AccessoryInformation.UUID);
    const cameraAccessory = createMockAccessory({
      UUID: "camera-accessory",
      _associatedHAPAccessory: { bridged: true },
      context: { mac: "AA:BB:CC:DD:EE:11", nvr: "AA:BB:CC:DD:EE:01" },
      displayName: "Front Door",
      getService: vi.fn((service: { UUID: string }) => {

        if(service.UUID === hap.Service.AccessoryInformation.UUID) {

          return infoService;
        }

        return undefined;
      })
    });
    const packageAccessory = createMockAccessory({
      UUID: "package-accessory",
      _associatedHAPAccessory: { bridged: true },
      context: { packageCamera: "AA:BB:CC:DD:EE:11" }
    });

    platform.accessories.push(cameraAccessory, packageAccessory);
    nvr.ufp = { mac: "AA:BB:CC:DD:EE:01" } as never;
    setNvrBootstrap(nvr, {
      cameras: [ { id: "camera-1", isAdopted: true, isAdoptedByOther: false, mac: "AA:BB:CC:DD:EE:11", modelKey: "camera", name: "Front Door" } ]
    });
    nvr.configuredDevices.set("camera-accessory", {
      accessory: cameraAccessory,
      accessoryName: "Front Door",
      cleanup: vi.fn(),
      hints: { enabled: true, standalone: false },
      ufp: { id: "camera-1", mac: "AA:BB:CC:DD:EE:11", modelKey: "camera", name: "Front Door" }
    } as never);
    (nvr as unknown as { getFeatureNumber: (option: string) => number | undefined }).getFeatureNumber = vi.fn((option: string) => {

      if(option === "Nvr.DelayDeviceRemoval") {

        return 10;
      }

      return undefined;
    });

    nvr.removeHomeKitDevice(cameraAccessory);
    expect(platform.log.info).toHaveBeenCalledWith("10.0.0.5: Front Door: Delaying device removal for at least 10 seconds.");

    vi.advanceTimersByTime(11_000);
    nvr.removeHomeKitDevice(cameraAccessory);

    expect(platform.api.unregisterPlatformAccessories).toHaveBeenCalledWith(expect.any(String), expect.any(String), [cameraAccessory]);
    expect(platform.api.unregisterPlatformAccessories).toHaveBeenCalledWith(expect.any(String), expect.any(String), [packageAccessory]);
    expect(platform.api.updatePlatformAccessories).toHaveBeenCalled();
  });

  it("serves M3U playlists and handles server events", () => {

    vi.useFakeTimers();
    const { nvr, platform } = createNvr();

    setNvrBootstrap(nvr, createBootstrap());
    (nvr as unknown as { getFeatureNumber: (option: string) => number | undefined }).getFeatureNumber = vi.fn(() => undefined);
    (nvr as unknown as { servePlaylist: () => void }).servePlaylist();

    expect(serverState.listen).toHaveBeenCalledWith(PROTECT_M3U_PLAYLIST_PORT_VALUE);

    const response = {
      end: vi.fn(),
      write: vi.fn(),
      writeHead: vi.fn()
    };

    serverState.requestHandler?.({}, response);

    expect(response.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/x-mpegURL" });
    expect(response.write).toHaveBeenCalledWith("#EXTM3U\n");
    expect(response.write).toHaveBeenCalledWith(expect.stringContaining("rtsp://10.0.0.5:7447/rtsp-main\n"));
    expect(response.write).toHaveBeenCalledWith(expect.stringContaining("package camera"));
    expect(response.end).toHaveBeenCalledTimes(1);

    const errorHandler = serverState.on.mock.calls.find(([event]) => event === "error")?.[1] as (error: Error & { code?: string }) => void;
    const listeningHandler = serverState.on.mock.calls.find(([event]) => event === "listening")?.[1] as () => void;

    errorHandler({ code: "EADDRINUSE" } as Error & { code?: string });
    vi.advanceTimersByTime(5_000);
    expect(serverState.close).toHaveBeenCalled();
    expect(serverState.listen).toHaveBeenCalledWith(PROTECT_M3U_PLAYLIST_PORT_VALUE);

    errorHandler(new Error("boom"));
    expect(platform.log.error).toHaveBeenCalledWith(expect.stringContaining("10.0.0.5: M3U playlist publisher error: Error: boom"));

    listeningHandler();
    expect(platform.log.info).toHaveBeenCalledWith(expect.stringContaining("10.0.0.5: Publishing an M3U playlist of Protect camera livestream URLs on port "));
  });

  it("configures reboot scheduling and executes reconnect flow", async () => {

    vi.useFakeTimers();
    const { nvr, platform } = createNvr({ overrideAddress: "nvr.example" });

    nvr.ufp = {
      mac: "AA:BB:CC:DD:EE:01",
      upSince: Date.now(),
      version: "7.0.1"
    } as never;
    platform.featureOptions.getFloat = vi.fn(() => 1);
    setNvrBootstrap(nvr, createBootstrap());
    (nvr as unknown as { connect: () => Promise<boolean> }).connect = vi.fn(async () => true);

    (nvr as unknown as { configureScheduledReboot: () => void }).configureScheduledReboot();
    expect(platform.log.info).toHaveBeenCalledWith("10.0.0.5: Scheduled controller reboot enabled every 1 hour.");

    nvr.configuredDevices.set("camera-1", {
      id: "camera-1",
      stream: { hksv: { isTransmitting: true } },
      ufp: { modelKey: "camera" }
    } as never);

    await (nvr as unknown as { executeScheduledReboot: (intervalHours: number) => Promise<void> }).executeScheduledReboot(1);
    expect(platform.log.info).toHaveBeenCalledWith("10.0.0.5: Deferring scheduled controller reboot: 1 camera is actively recording HKSV events.");

    nvr.configuredDevices.clear();
    nvr.ufpApi.retrieve = vi.fn(async () => undefined);
    const disconnectSpy = vi.spyOn(nvr as unknown as { disconnect: () => void }, "disconnect");

    await (nvr as unknown as { executeScheduledReboot: (intervalHours: number) => Promise<void> }).executeScheduledReboot(1);

    expect(nvr.ufpApi.retrieve).toHaveBeenCalledWith("https://nvr.example/api/system/reboot", { method: "POST" });
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect((nvr as unknown as { connect: ReturnType<typeof vi.fn> }).connect).toHaveBeenCalled();
  });

  it("handles reboot API command failures and keeps logging enabled", async () => {

    const { nvr, platform } = createNvr();

    nvr.ufp = { mac: "AA:BB:CC:DD:EE:01" } as never;
    nvr.ufpApi.retrieve = vi.fn(async () => {

      throw new Error("reboot failed");
    });

    await (nvr as unknown as { executeScheduledReboot: (intervalHours: number) => Promise<void> }).executeScheduledReboot(2);

    expect(nvr.logApiErrors).toBe(true);
    expect(platform.log.error).toHaveBeenCalledWith(expect.stringContaining("10.0.0.5: Unable to send reboot command to the Protect controller: Error: reboot failed"));
  });

  it("logs feature availability once and exposes helper methods", () => {

    const { nvr, platform } = createNvr();

    nvr.ufp = { mac: "AA:BB:CC:DD:EE:01" } as never;
    platform.featureOptions.getFloat = vi.fn(() => 2.5);
    platform.featureOptions.getInteger = vi.fn(() => 42);
    platform.featureOptions.scope = vi.fn(() => "controller") as never;
    platform.featureOptions.test = vi.fn(() => true);

    expect(nvr.getFeatureFloat("Nvr.Reboot")).toBe(2.5);
    expect(nvr.getFeatureNumber("Nvr.DelayDeviceRemoval")).toBe(42);
    expect(nvr.isNvrFeature("Nvr.Reboot")).toBe(true);
    expect(nvr.hasFeature("Device")).toBe(true);

    nvr.logFeature("Nvr.Service.Playlist", "Playlist enabled.");
    nvr.logFeature("Nvr.Service.Playlist", "Playlist enabled.");

    expect(platform.log.info).toHaveBeenCalledWith("10.0.0.5: Playlist enabled.");
    expect(platform.log.info).toHaveBeenCalledTimes(1);
  });

  it("can reconfigure camera as doorbell", () => {

    const { nvr } = createNvr();
    const accessory = createMockAccessory({
      UUID: "camera-uuid",
      context: { nvr: "AA:BB:CC:DD:EE:01" }
    });
    const protectDevice = {
      accessory: accessory,
      cleanup: vi.fn(),
      ufp: {
        featureFlags: { isDoorbell: true },
        id: "camera-1",
        mac: "AA:BB:CC:DD:EE:11",
        marketName: "Doorbell",
        modelKey: "camera",
        name: "Doorbell"
      }
    };

    nvr.configuredDevices.set(accessory.UUID, protectDevice as never);

    nvr.reconfigureAsDoorbell(protectDevice as never);

    expect(protectDevice.cleanup).toHaveBeenCalledTimes(1);
    expect(nvr.configuredDevices.has(accessory.UUID)).toBe(true);
    expect((nvr.configuredDevices.get(accessory.UUID) as unknown as { ufp: { featureFlags: { isDoorbell: boolean } } }).ufp.featureFlags.isDoorbell).toBe(true);
  });

  it("returns device by id and null for missing id", () => {

    const { nvr } = createNvr();
    const device = {
      id: "camera-1",
      ufp: { id: "camera-1", modelKey: "camera" }
    };

    nvr.configuredDevices.set("camera-1", device as never);

    expect(nvr.getDeviceById("camera-1")).toBe(device);
    expect(nvr.getDeviceById("missing")).toBeNull();
    expect(ProtectReservedNamesValue.SWITCH_MOTION_TRIGGER).toBe("MotionSensorTrigger");
    expect(PROTECT_NVR_REBOOT_MIN_INTERVAL_VALUE).toBeGreaterThan(0);
  });

  it("skips shutdown registration when required credentials are missing", () => {

    const { platform } = createNvr({ password: "", username: "" });

    expect(platform.api.on).not.toHaveBeenCalledWith(APIEvent.SHUTDOWN, expect.any(Function));
  });

  it("clears scheduled reboot timer on platform shutdown", () => {

    const { nvr, platform } = createNvr();
    const timer = setTimeout(() => undefined, 60_000);

    (nvr as unknown as { nvrRebootTimer: NodeJS.Timeout | null }).nvrRebootTimer = timer;
    (platform.api as unknown as { emit: (event: string, ...parameters: unknown[]) => void }).emit(APIEvent.SHUTDOWN);

    expect((nvr as unknown as { nvrRebootTimer: NodeJS.Timeout | null }).nvrRebootTimer).toBeNull();
  });

  it("returns early when login succeeds but bootstrap is unavailable", async () => {

    const { nvr, platform } = createNvr();
    platform.featureOptions.test = vi.fn(() => true);
    (nvr as unknown as { connect: () => Promise<boolean> }).connect = vi.fn(async () => true);
    setNvrBootstrap(nvr, null);
    const syncSpy = vi.spyOn(nvr as unknown as { syncDevices: () => void }, "syncDevices");

    await nvr.login();

    expect(syncSpy).not.toHaveBeenCalled();
  });

  it("returns false for unsupported Protect major versions", async () => {

    const { nvr, platform } = createNvr({ name: undefined });

    setNvrBootstrap(nvr, {
      nvr: {
        firmwareVersion: "4.0.0",
        mac: "AA:BB:CC:DD:EE:01",
        version: "5.1.0"
      }
    });
    nvr.ufpApi.login = vi.fn(async () => true);

    await expect((nvr as unknown as { connect: () => Promise<boolean> }).connect()).resolves.toBe(false);
    expect(platform.log.error).toHaveBeenCalledWith(
      expect.stringContaining("This version of HBUP requires running UniFi Protect v6.0 or above using the official Protect release channel only.")
    );
    expect(nvr.ufpApi.logout).toHaveBeenCalledTimes(1);
  });

  it("skips logging adopted-device discovery for onboarding states", async () => {

    const { nvr, platform } = createNvr();

    setNvrBootstrap(nvr, {
      cameras: [ {
        featureFlags: { isDoorbell: false },
        isAdopted: false,
        isAdoptedByOther: false,
        isAdopting: true,
        mac: "AA:BB:CC:DD:EE:61",
        marketName: "Cam",
        modelKey: "camera",
        name: "Onboarding Cam"
      } ],
      chimes: [],
      lights: [],
      nvr: { firmwareVersion: "4.0.0", mac: "AA:BB:CC:DD:EE:01", version: "7.0.1" },
      sensors: [],
      viewers: []
    });
    platform.featureOptions.test = vi.fn(() => true);

    await nvr.login();

    expect(platform.log.info).not.toHaveBeenCalledWith(expect.stringContaining("Discovered camera"));
  });

  it("logs unsupported device class only once per MAC", () => {

    const { nvr, platform } = createNvr();
    const unsupportedDevice = {
      id: "unknown-1",
      isAdopted: true,
      isAdoptedByOther: false,
      mac: "AA:BB:CC:DD:EE:99",
      modelKey: "bridgeDisplay",
      name: "Unknown Device"
    };

    nvr.ufp = { mac: "AA:BB:CC:DD:EE:01" } as never;

    expect(nvr.addHomeKitDevice(unsupportedDevice as never)).toBe(false);
    expect(nvr.addHomeKitDevice(unsupportedDevice as never)).toBe(false);
    expect(platform.log.info).toHaveBeenCalledTimes(1);
  });

  it("removes cached accessory when feature is disabled for known device", () => {

    const { nvr, platform } = createNvr();
    const device = {
      featureFlags: { isDoorbell: false },
      id: "camera-1",
      isAdopted: true,
      isAdoptedByOther: false,
      mac: "AA:BB:CC:DD:EE:11",
      modelKey: "camera",
      name: "Cam"
    };
    const uuid = platform.api.hap.uuid.generate(device.mac);
    const accessory = createMockAccessory({ UUID: uuid, context: { nvr: "AA:BB:CC:DD:EE:01" } });

    platform.accessories.push(accessory);
    nvr.ufp = { mac: "AA:BB:CC:DD:EE:01" } as never;
    platform.featureOptions.test = vi.fn((option: string) => option !== "Device");
    const removeSpy = vi.spyOn(nvr, "removeHomeKitDevice");

    expect(nvr.addHomeKitDevice(device as never)).toBe(false);
    expect(removeSpy).toHaveBeenCalledWith(accessory, true);
  });

  it("clears removal queue when bootstrap is unavailable or throttled", () => {

    const { nvr, platform } = createNvr();

    setNvrBootstrap(nvr, null);
    nvr.ufpApi.isThrottled = true;
    (nvr as unknown as { deviceRemovalQueue: Map<string, number> }).deviceRemovalQueue.set("stale-1", Date.now());

    expect((nvr as unknown as { discoverAndSyncAccessories: () => boolean }).discoverAndSyncAccessories()).toBe(false);
    expect((nvr as unknown as { deviceRemovalQueue: Map<string, number> }).deviceRemovalQueue.size).toBe(0);
    expect(platform.log.info).toHaveBeenCalledWith(
      "10.0.0.5: Communication with the controller has been lost. Clearing out the device removal queue as a precaution until connectivity returns."
    );
  });

  it("returns early for removeHomeKitDevice guard branches", () => {

    const { nvr, platform } = createNvr();
    const wrongNvrAccessory = createMockAccessory({
      UUID: "wrong-nvr",
      context: { mac: "AA:BB:CC:DD:EE:02", nvr: "AA:BB:CC:DD:EE:02" }
    });
    const systemInfoAccessory = createMockAccessory({
      UUID: "system-info",
      context: { mac: "AA:BB:CC:DD:EE:03", nvr: "AA:BB:CC:DD:EE:01", systemInfo: true }
    });
    const liveviewAccessory = createMockAccessory({
      UUID: "liveview",
      context: { liveview: true, mac: "AA:BB:CC:DD:EE:04", nvr: "AA:BB:CC:DD:EE:01" }
    });
    const packageAccessory = createMockAccessory({
      UUID: "package-only",
      context: { nvr: "AA:BB:CC:DD:EE:01", packageCamera: "AA:BB:CC:DD:EE:11" }
    });
    const parentAccessory = createMockAccessory({
      UUID: "parent",
      context: { mac: "AA:BB:CC:DD:EE:11", nvr: "AA:BB:CC:DD:EE:01" }
    });

    nvr.ufp = { mac: "AA:BB:CC:DD:EE:01" } as never;
    platform.accessories.push(wrongNvrAccessory, systemInfoAccessory, liveviewAccessory, packageAccessory, parentAccessory);

    nvr.removeHomeKitDevice(createMockAccessory({ UUID: "missing", context: { nvr: "AA:BB:CC:DD:EE:01" } }));
    nvr.removeHomeKitDevice(wrongNvrAccessory);
    nvr.removeHomeKitDevice(systemInfoAccessory);
    nvr.removeHomeKitDevice(liveviewAccessory);
    nvr.removeHomeKitDevice(packageAccessory);

    expect(platform.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
  });

  it("covers removeHomeKitDevice unknown-device and model fallback branches", () => {

    const { nvr, platform } = createNvr();
    const accessory = createMockAccessory({
      UUID: "unknown-device",
      _associatedHAPAccessory: { bridged: false },
      context: { mac: "AA:BB:CC:DD:EE:88", nvr: "AA:BB:CC:DD:EE:01" },
      displayName: "Unknown"
    });

    nvr.ufp = { mac: "AA:BB:CC:DD:EE:01" } as never;
    platform.accessories.push(accessory);
    setNvrBootstrap(nvr, { cameras: [], chimes: [], lights: [], sensors: [], viewers: [] });

    nvr.removeHomeKitDevice(accessory, true);

    expect(platform.log.info).toHaveBeenCalledWith(expect.stringContaining("Unknown: Removing device from HomeKit."));
  });

  it("returns null for unsupported addProtectDevice model keys", () => {

    const { nvr } = createNvr();
    const accessory = createMockAccessory({ UUID: "unsupported-uuid", context: { nvr: "AA:BB:CC:DD:EE:01" } });
    const device = { featureFlags: { isDoorbell: false }, marketName: "Unknown", modelKey: "unsupported" };

    expect((nvr as unknown as { addProtectDevice: (a: unknown, d: unknown) => unknown }).addProtectDevice(accessory, device)).toBeNull();
  });

  it("skips package camera playlist entry when package channel is absent", () => {

    const { nvr } = createNvr();

    setNvrBootstrap(nvr, {
      cameras: [ {
        channels: [ { isRtspEnabled: true, rtspAlias: "main" } ],
        featureFlags: { hasPackageCamera: true },
        marketName: "G4",
        name: "Garage",
        videoCodec: "h264"
      } ],
      nvr: { host: "10.0.0.5", ports: { rtsp: 7447 } }
    });
    (nvr as unknown as { getFeatureNumber: () => number | undefined }).getFeatureNumber = vi.fn(() => undefined);

    (nvr as unknown as { servePlaylist: () => void }).servePlaylist();
    const response = { end: vi.fn(), write: vi.fn(), writeHead: vi.fn() };
    serverState.requestHandler?.({}, response);

    const rtspLines = (response.write as ReturnType<typeof vi.fn>).mock.calls
      .map(call => String(call[0]))
      .filter(line => line.startsWith("rtsp://"));

    expect(rtspLines).toHaveLength(1);
  });

  it("logs discovered devices using marketName fallback and skips disabled reboot scheduling", async () => {

    const { nvr, platform } = createNvr();

    setNvrBootstrap(nvr, {
      cameras: [ {
        featureFlags: { isDoorbell: false },
        isAdopted: true,
        isAdoptedByOther: false,
        mac: "AA:BB:CC:DD:EE:70",
        marketName: "Market Only Cam",
        modelKey: "camera"
      } ],
      chimes: [],
      lights: [],
      nvr: { firmwareVersion: "4.0.0", mac: "AA:BB:CC:DD:EE:01", version: "7.0.1" },
      sensors: [],
      viewers: []
    });
    platform.featureOptions.test = vi.fn(() => true);
    platform.featureOptions.getFloat = vi.fn(() => null);
    (nvr as unknown as { connect: () => Promise<boolean> }).connect = vi.fn(async () => true);

    await nvr.login();

    expect(platform.log.info).toHaveBeenCalledWith("10.0.0.5: Discovered camera: Market Only Cam.");
    (nvr as unknown as { configureScheduledReboot: () => void }).configureScheduledReboot();
    expect((nvr as unknown as { nvrRebootTimer: NodeJS.Timeout | null }).nvrRebootTimer).toBeNull();
  });

  it("uses default reboot interval, singular hour label, and defers for multiple recordings", async () => {

    vi.useFakeTimers();
    const { nvr, platform } = createNvr();

    nvr.ufp = { mac: "AA:BB:CC:DD:EE:01", upSince: undefined, version: "7.0.1" } as never;
    platform.featureOptions.getFloat = vi.fn(() => 1);
    (nvr as unknown as { configureScheduledReboot: () => void }).configureScheduledReboot();
    expect(platform.log.info).toHaveBeenCalledWith("10.0.0.5: Scheduled controller reboot enabled every 1 hour.");

    nvr.configuredDevices.set("cam-a", { stream: { hksv: { isTransmitting: true } }, ufp: { modelKey: "camera" } } as never);
    nvr.configuredDevices.set("cam-b", { stream: { hksv: { isTransmitting: true } }, ufp: { modelKey: "camera" } } as never);

    await (nvr as unknown as { executeScheduledReboot: (intervalHours: number) => Promise<void> }).executeScheduledReboot(1);
    expect(platform.log.info).toHaveBeenCalledWith("10.0.0.5: Deferring scheduled controller reboot: 2 cameras are actively recording HKSV events.");
  });

  it("logs reconnect failures when controller does not return after reboot", async () => {

    vi.useFakeTimers();
    const { nvr, platform } = createNvr();

    nvr.ufp = { mac: "AA:BB:CC:DD:EE:01" } as never;
    nvr.ufpApi.retrieve = vi.fn(async () => undefined);
    (nvr as unknown as { connect: ReturnType<typeof vi.fn> }).connect = vi.fn(async () => false);
    vi.spyOn(nvr as unknown as { disconnect: () => void }, "disconnect").mockImplementation(() => undefined);

    await (nvr as unknown as { executeScheduledReboot: (intervalHours: number) => Promise<void> }).executeScheduledReboot(2);

    expect(platform.log.error).toHaveBeenCalledWith("10.0.0.5: Reconnection attempt 1 of 5 failed. Retrying.");
    expect(platform.log.error).toHaveBeenCalledWith(
      "10.0.0.5: Unable to reconnect to the Protect controller after the scheduled reboot. Will attempt to reconnect on the next reboot cycle."
    );
  });

  it("adds homekit devices using marketName and handles missing bootstrap categories", () => {

    const { nvr, platform } = createNvr();

    nvr.ufp = { mac: "AA:BB:CC:DD:EE:01" } as never;
    platform.featureOptions.test = vi.fn(() => true);
    setNvrBootstrap(nvr, {
      cameras: [ {
        featureFlags: { isDoorbell: false },
        id: "camera-market",
        isAdopted: true,
        isAdoptedByOther: false,
        mac: "AA:BB:CC:DD:EE:72",
        marketName: "Market Doorbell",
        modelKey: "camera"
      } ],
      chimes: [],
      nvr: { mac: "AA:BB:CC:DD:EE:01" }
    });

    expect(nvr.addHomeKitDevice({
      featureFlags: { isDoorbell: false },
      id: "camera-market",
      isAdopted: true,
      isAdoptedByOther: false,
      mac: "AA:BB:CC:DD:EE:72",
      marketName: "Market Doorbell",
      modelKey: "camera"
    } as never)).toBe(true);

    expect((nvr as unknown as { discoverAndSyncAccessories: () => boolean }).discoverAndSyncAccessories()).toBe(true);
  });

  it("returns null from addProtectDevice when configured device lookup fails", () => {

    const { nvr } = createNvr();
    const accessory = createMockAccessory({ UUID: "lookup-fail", context: { nvr: "AA:BB:CC:DD:EE:01" } });
    const device = {
      featureFlags: { isDoorbell: false },
      id: "camera-1",
      mac: "AA:BB:CC:DD:EE:73",
      marketName: "Cam",
      modelKey: "camera",
      name: "Cam"
    };

    vi.spyOn(nvr.configuredDevices, "get").mockReturnValue(undefined);

    expect((nvr as unknown as { addProtectDevice: (a: unknown, d: unknown) => unknown }).addProtectDevice(accessory, device)).toBeNull();
  });

  it("covers cleanupDevices orphan, keep, transition, and queued removal branches", () => {

    vi.useFakeTimers();
    const { nvr, platform } = createNvr();
    const hap = platform.api.hap;

    nvr.ufp = { mac: "AA:BB:CC:DD:EE:01" } as never;
    setNvrBootstrap(nvr, {
      cameras: [ {
        featureFlags: { isDoorbell: false },
        id: "keep-cam",
        isAdopted: true,
        isAdoptedByOther: false,
        mac: "AA:BB:CC:DD:EE:74",
        modelKey: "camera",
        name: "Keep Cam"
      } ],
      chimes: [],
      lights: [],
      sensors: [],
      viewers: []
    });

    const orphanAccessory = createMockAccessory({
      UUID: "orphan-accessory",
      _associatedHAPAccessory: { bridged: true },
      context: { mac: "AA:BB:CC:DD:EE:75", nvr: "AA:BB:CC:DD:EE:01" },
      displayName: "Orphan"
    });
    const keepAccessory = createMockAccessory({
      UUID: "keep-accessory",
      _associatedHAPAccessory: { bridged: true },
      context: { mac: "AA:BB:CC:DD:EE:74", nvr: "AA:BB:CC:DD:EE:01" },
      displayName: "Keep Cam"
    });
    const standaloneTransition = createMockAccessory({
      UUID: "standalone-transition",
      _associatedHAPAccessory: { bridged: true },
      context: { mac: "AA:BB:CC:DD:EE:76", nvr: "AA:BB:CC:DD:EE:01" },
      displayName: "Standalone Transition"
    });
    const bridgedTransition = createMockAccessory({
      UUID: "bridged-transition",
      _associatedHAPAccessory: { bridged: false },
      context: { mac: "AA:BB:CC:DD:EE:77", nvr: "AA:BB:CC:DD:EE:01" },
      displayName: "Bridged Transition"
    });
    const queuedAccessory = createMockAccessory({
      UUID: "queued-accessory",
      _associatedHAPAccessory: { bridged: true },
      context: { mac: "AA:BB:CC:DD:EE:78", nvr: "AA:BB:CC:DD:EE:01" },
      displayName: "Queued"
    });
    const bootstrapMissingAccessory = createMockAccessory({
      UUID: "bootstrap-missing",
      _associatedHAPAccessory: { bridged: true },
      context: { mac: "AA:BB:CC:DD:EE:79", nvr: "AA:BB:CC:DD:EE:01" },
      displayName: "Bootstrap Missing"
    });

    platform.accessories.push(orphanAccessory, keepAccessory, standaloneTransition, bridgedTransition, queuedAccessory, bootstrapMissingAccessory);
    (nvr as unknown as { deviceRemovalQueue: Map<string, number> }).deviceRemovalQueue.set("queued-accessory", Date.now());

    nvr.configuredDevices.set("keep-accessory", {
      accessory: keepAccessory,
      cleanup: vi.fn(),
      configureInfo: vi.fn(),
      hints: { enabled: true, standalone: false },
      ufp: { id: "keep-cam", mac: "AA:BB:CC:DD:EE:74", modelKey: "camera", name: "Keep Cam" }
    } as never);
    nvr.configuredDevices.set("standalone-transition", {
      accessory: standaloneTransition,
      cleanup: vi.fn(),
      hints: { enabled: true, standalone: true },
      ufp: { featureFlags: { isDoorbell: false }, id: "standalone-cam", isAdopted: true, isAdoptedByOther: false, mac: "AA:BB:CC:DD:EE:76", modelKey: "camera", name: "Standalone Transition" }
    } as never);
    nvr.configuredDevices.set("bridged-transition", {
      accessory: bridgedTransition,
      cleanup: vi.fn(),
      hints: { enabled: true, standalone: false },
      ufp: { featureFlags: { isDoorbell: false }, id: "bridged-cam", isAdopted: true, isAdoptedByOther: false, mac: "AA:BB:CC:DD:EE:77", modelKey: "camera", name: "Bridged Transition" }
    } as never);
    nvr.configuredDevices.set("bootstrap-missing", {
      accessory: bootstrapMissingAccessory,
      cleanup: vi.fn(),
      hints: { enabled: true, standalone: false },
      ufp: { id: "missing-bootstrap", mac: "AA:BB:CC:DD:EE:79", modelKey: "camera", name: "Bootstrap Missing" }
    } as never);

    nvrBootstrap(nvr).cameras.push(
      { featureFlags: { isDoorbell: false }, id: "standalone-cam", isAdopted: true, isAdoptedByOther: false, mac: "AA:BB:CC:DD:EE:76", modelKey: "camera", name: "Standalone Transition" } as never,
      { featureFlags: { isDoorbell: false }, id: "bridged-cam", isAdopted: true, isAdoptedByOther: false, mac: "AA:BB:CC:DD:EE:77", modelKey: "camera", name: "Bridged Transition" } as never
    );

    platform.featureOptions.test = vi.fn(() => true);
    const removeSpy = vi.spyOn(nvr, "removeHomeKitDevice");
    const addSpy = vi.spyOn(nvr, "addHomeKitDevice");

    (nvr as unknown as { cleanupDevices: () => void }).cleanupDevices();

    expect(removeSpy).toHaveBeenCalledWith(orphanAccessory, expect.any(Boolean));
    expect(removeSpy).toHaveBeenCalledWith(standaloneTransition, true);
    expect(removeSpy).toHaveBeenCalledWith(bridgedTransition, true);
    expect(addSpy).toHaveBeenCalled();
    expect((nvr as unknown as { deviceRemovalQueue: Map<string, number> }).deviceRemovalQueue.has("keep-accessory")).toBe(false);

    setNvrBootstrap(nvr, null);
    (nvr as unknown as { cleanupDevices: () => void }).cleanupDevices();
  });

  it("handles delayed removal singular label, pending queue, and bootstrap device lookup", () => {

    vi.useFakeTimers();
    const { nvr, platform } = createNvr();
    const hap = platform.api.hap;
    const infoService = createMockService(hap.Service.AccessoryInformation.UUID);
    const delayedAccessory = createMockAccessory({
      UUID: "delayed-accessory",
      _associatedHAPAccessory: { bridged: true },
      context: { mac: "AA:BB:CC:DD:EE:80", nvr: "AA:BB:CC:DD:EE:01" },
      displayName: "Delayed",
      getService: vi.fn((service: { UUID: string }) => service.UUID === hap.Service.AccessoryInformation.UUID ? infoService : undefined)
    });
    const lookupAccessory = createMockAccessory({
      UUID: "lookup-accessory",
      _associatedHAPAccessory: { bridged: true },
      context: { mac: "AA:BB:CC:DD:EE:81", nvr: "AA:BB:CC:DD:EE:01" },
      displayName: "Lookup Name",
      getService: vi.fn((service: { UUID: string }) => service.UUID === hap.Service.AccessoryInformation.UUID ? infoService : undefined)
    });

    nvr.ufp = { mac: "AA:BB:CC:DD:EE:01" } as never;
    platform.accessories.push(delayedAccessory, lookupAccessory);
    setNvrBootstrap(nvr, {
      cameras: [ { id: "lookup-cam", isAdopted: true, isAdoptedByOther: false, mac: "AA:BB:CC:DD:EE:81", modelKey: "camera", name: "Lookup Cam" } ],
      chimes: [],
      lights: [],
      sensors: [],
      viewers: []
    });
    nvr.configuredDevices.set("lookup-accessory", {
      accessory: lookupAccessory,
      accessoryName: "Lookup Fallback",
      cleanup: vi.fn(),
      hints: { enabled: true, standalone: false },
      ufp: { id: "lookup-cam", mac: "AA:BB:CC:DD:EE:81", modelKey: "camera", name: "Lookup Cam" }
    } as never);
    (nvr as unknown as { getFeatureNumber: (option: string) => number | undefined }).getFeatureNumber = vi.fn((option: string) =>
      (option === "Nvr.DelayDeviceRemoval") ? 1 : undefined);

    nvr.removeHomeKitDevice(delayedAccessory);
    expect(platform.log.info).toHaveBeenCalledWith("10.0.0.5: Delayed: Delaying device removal for at least 1 second.");

    nvr.removeHomeKitDevice(delayedAccessory);
    expect(platform.api.unregisterPlatformAccessories).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1100);
    nvr.removeHomeKitDevice(delayedAccessory);
    expect(platform.api.unregisterPlatformAccessories).toHaveBeenCalled();

    nvr.configuredDevices.delete("lookup-accessory");
    nvr.removeHomeKitDevice(lookupAccessory, true);
    expect(platform.log.info).toHaveBeenCalledWith(expect.stringContaining("Lookup Cam: Removing camera from HomeKit."));
  });

  it("publishes package camera playlist entries when camera name is missing", () => {

    const { nvr } = createNvr();

    setNvrBootstrap(nvr, {
      cameras: [ {
        channels: [
          { isRtspEnabled: true, name: "High", rtspAlias: "main" },
          { isRtspEnabled: true, name: "Package Camera", rtspAlias: "package-main" }
        ],
        featureFlags: { hasPackageCamera: true },
        marketName: "G4 Doorbell",
        videoCodec: "h264"
      } ],
      nvr: { host: "10.0.0.5", ports: { rtsp: 7447 } }
    });
    (nvr as unknown as { getFeatureNumber: () => number | undefined }).getFeatureNumber = vi.fn(() => undefined);
    (nvr as unknown as { servePlaylist: () => void }).servePlaylist();

    const response = { end: vi.fn(), write: vi.fn(), writeHead: vi.fn() };
    serverState.requestHandler?.({}, response);

    expect(response.write).toHaveBeenCalledWith(expect.stringContaining(" Package Camera"));
    expect(response.write).toHaveBeenCalledWith(expect.stringContaining("rtsp://10.0.0.5:7447/package-main"));
  });

  it("returns false for non-global NVR feature scopes", () => {

    const { nvr, platform } = createNvr();

    nvr.ufp = { mac: "AA:BB:CC:DD:EE:01" } as never;
    platform.featureOptions.scope = vi.fn(() => "device") as never;

    expect(nvr.isNvrFeature("Nvr.Reboot")).toBe(false);
    expect(nvr.isNvrFeature("Nvr.Reboot", { mac: "AA:BB:CC:DD:EE:11" } as never)).toBe(false);

    nvr.logFeature("Nvr.Reboot", "Should not log.");
    expect(platform.log.info).not.toHaveBeenCalledWith("10.0.0.5: Should not log.");
  });

  it("covers final protect-nvr branch gaps for removal queue and device lookup", () => {

    vi.useFakeTimers();
    const { nvr, platform } = createNvr();
    const hap = platform.api.hap;

    nvr.ufp = { mac: "AA:BB:CC:DD:EE:01" } as never;

    const queuedInfoService = createMockService(hap.Service.AccessoryInformation.UUID);

    queuedInfoService.getCharacteristic = vi.fn((name: string) => {

      if(name === "SerialNumber") {

        return { value: undefined };
      }

      return { value: "test" };
    }) as never;

    const queuedAccessory = createMockAccessory({
      UUID: "queued-feature-false",
      context: { nvr: "AA:BB:CC:DD:EE:01" },
      displayName: "Queued Feature False",
      getService: vi.fn((service: { UUID: string }) => service.UUID === hap.Service.AccessoryInformation.UUID ? queuedInfoService : undefined)
    });

    platform.accessories = [ queuedAccessory ];
    (nvr as unknown as { deviceRemovalQueue: Map<string, number> }).deviceRemovalQueue.set("queued-feature-false", Date.now());
    platform.featureOptions.test = vi.fn(() => false);

    const removeSpy = vi.spyOn(nvr, "removeHomeKitDevice").mockImplementation(() => undefined);

    (nvr as unknown as { cleanupDevices: () => void }).cleanupDevices();
    expect(removeSpy).toHaveBeenCalledWith(queuedAccessory, true);

    removeSpy.mockClear();
    platform.featureOptions.test = vi.fn(() => true);
    (nvr as unknown as { cleanupDevices: () => void }).cleanupDevices();
    expect(removeSpy).toHaveBeenCalledWith(queuedAccessory, false);

    removeSpy.mockClear();
    platform.accessories = [];

    const infoService = createMockService(hap.Service.AccessoryInformation.UUID);

    infoService.getCharacteristic = vi.fn((name: string) => {

      if(name === "SerialNumber") {

        return { value: undefined };
      }

      return { value: "test" };
    }) as never;

    const orphanAccessory = createMockAccessory({
      UUID: "orphan-no-serial",
      _associatedHAPAccessory: { bridged: true },
      context: { mac: "AA:BB:CC:DD:EE:82", nvr: "AA:BB:CC:DD:EE:01" },
      displayName: "Orphan No Serial",
      getService: vi.fn((service: { UUID: string }) => service.UUID === hap.Service.AccessoryInformation.UUID ? infoService : undefined)
    });

    platform.accessories = [ orphanAccessory ];
    setNvrBootstrap(nvr, { cameras: [], chimes: [], lights: [], sensors: [], viewers: [] });
    platform.featureOptions.test = vi.fn(() => true);
    (nvr as unknown as { cleanupDevices: () => void }).cleanupDevices();
    expect(removeSpy).toHaveBeenCalledWith(orphanAccessory, false);

    removeSpy.mockRestore();
    platform.accessories = [];

    const delayedAccessory = createMockAccessory({
      UUID: "delayed-undefined-ts",
      _associatedHAPAccessory: { bridged: true },
      context: { mac: "AA:BB:CC:DD:EE:83", nvr: "AA:BB:CC:DD:EE:01" },
      displayName: "Delayed Undefined"
    });

    platform.accessories = [ delayedAccessory ];
    (nvr as unknown as { getFeatureNumber: (option: string) => number | undefined }).getFeatureNumber = vi.fn((option: string) =>
      (option === "Nvr.DelayDeviceRemoval") ? 1 : undefined);

    const fakeQueue = new Map<string, number>();

    fakeQueue.set("delayed-undefined-ts", Date.now() - 5000);
    (nvr as unknown as { deviceRemovalQueue: Map<string, number> }).deviceRemovalQueue = {
      delete: vi.fn((key: string) => { fakeQueue.delete(key); }),
      get: vi.fn((key: string) => (key === "delayed-undefined-ts") ? undefined : fakeQueue.get(key)),
      has: vi.fn((key: string) => (key === "delayed-undefined-ts") || fakeQueue.has(key)),
      set: vi.fn((key: string, value: number) => { fakeQueue.set(key, value); })
    } as never;

    nvr.removeHomeKitDevice(delayedAccessory);
    expect(platform.api.unregisterPlatformAccessories).toHaveBeenCalled();

    const unknownAccessory = createMockAccessory({
      UUID: "unknown-display-name",
      _associatedHAPAccessory: { bridged: false },
      context: { mac: "AA:BB:CC:DD:EE:99", nvr: "AA:BB:CC:DD:EE:01" },
      displayName: "Only Display Name"
    });

    platform.accessories = [ unknownAccessory ];
    setNvrBootstrap(nvr, { cameras: [] });
    nvr.configuredDevices.clear();
    nvr.removeHomeKitDevice(unknownAccessory, true);
    expect(platform.log.info).toHaveBeenCalledWith(
      "10.0.0.5: Only Display Name: Removing device from HomeKit. You will need to manually delete the device in the Home app to complete the removal."
    );

    const accessoryNameFallback = createMockAccessory({
      UUID: "accessory-name-fallback",
      _associatedHAPAccessory: { bridged: true },
      context: { mac: "AA:BB:CC:DD:EE:82", nvr: "AA:BB:CC:DD:EE:01" },
      displayName: "Display Should Not Win"
    });

    platform.accessories = [ accessoryNameFallback ];
    nvr.configuredDevices.set("accessory-name-fallback", {
      accessory: accessoryNameFallback,
      accessoryName: "Configured Accessory Name",
      cleanup: vi.fn(),
      ufp: undefined
    } as never);
    nvr.removeHomeKitDevice(accessoryNameFallback, true);
    expect(platform.log.info).toHaveBeenCalledWith(expect.stringContaining("Configured Accessory Name: Removing device from HomeKit."));
  });
});
