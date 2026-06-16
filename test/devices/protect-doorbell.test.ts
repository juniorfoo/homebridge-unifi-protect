import { acquireService, validService } from "homebridge-plugin-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProtectDoorbell } from "../../src/devices/protect-doorbell.js";
import { ProtectReservedNames } from "../../src/protect-types.js";
import { PROTECT_DOORBELL_AUTHSENSOR_DURATION } from "../../src/settings.js";
import {
  createMockAccessory,
  createMockCameraConfig,
  createMockNvr,
  createMockService,
  getServiceCharacteristicHandlers,
  setNvrBootstrap,
  type MockService
} from "../helpers/mocks.js";

vi.mock("../../src/protect-livestream.js", () => ({

  LivestreamManager: vi.fn().mockImplementation(() => ({
    acquire: vi.fn(),
    shutdown: vi.fn(),
    start: vi.fn(),
    stop: vi.fn()
  }))
}));

vi.mock("../../src/protect-stream.js", () => ({

  ProtectStreamingDelegate: vi.fn().mockImplementation(() => ({
    controller: { id: "controller" },
    ffmpegOptions: { hostSystemMaxPixels: 2073600 },
    hksv: { isRecording: false, timeshift: { isStarted: true }, updateRecordingActive: vi.fn() }
  }))
}));

describe("ProtectDoorbell", () => {

  const allFeatures = new Set([
    "Device",
    "Doorbell.AuthSensor",
    "Doorbell.Messages",
    "Doorbell.Messages.FromDoorbell",
    "Doorbell.PhysicalChime",
    "Doorbell.Trigger",
    "Doorbell.Volume.Dimmer"
  ]);

  const setupAccessoryServiceMocks = (): void => {

    vi.mocked(validService).mockImplementation((accessory, serviceType, validate, subtype) => {

      if(!validate) {

        const existing = subtype ? accessory.getServiceById(serviceType, subtype) : accessory.getService(serviceType);

        if(existing) {

          accessory.removeService(existing);
        }

        return false;
      }

      return true;
    });

    vi.mocked(acquireService).mockImplementation((accessory, serviceType, name, subtype, onServiceCreate) => {

      let service = subtype ? accessory.getServiceById(serviceType, subtype) : accessory.getService(serviceType);

      if(service) {

        return service;
      }

      service = createMockService(serviceType.UUID);
      (service as MockService).displayName = name ?? "Mock Service";
      (service as MockService).subtype = subtype;
      accessory.addService(service);
      onServiceCreate?.(service);

      return service;
    });
  };

  const createDoorbell = (overrides: {
    featureFlags?: Record<string, unknown>;
    features?: Set<string>;
    camera?: Record<string, unknown>;
  } = {}): { doorbell: ProtectDoorbell; nvr: ReturnType<typeof createMockNvr> } => {

    const enabledFeatures = overrides.features ?? allFeatures;
    const nvr = createMockNvr({
      config: {
        ...createMockNvr().config,
        doorbellMessages: [ { duration: 15, message: "Please Leave Package" }, { duration: -1, message: "Default Duration Message" } ]
      },
      featureTest: (name: string): boolean => enabledFeatures.has(name),
      ufp: {
        ...createMockNvr().ufp,
        doorbellSettings: {
          allMessages: [ { text: "Welcome", type: "LEAVE_PACKAGE_AT_DOOR" }, { text: "Reserved", type: "DoorbellChime" } ],
          customMessages: [ "Please knock" ],
          defaultMessageResetTimeoutMs: 5000
        }
      }
    });

    (nvr.platform.featureOptions.getInteger as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      (name === "Doorbell.PhysicalChime.Duration.Digital") ? 15000 : undefined);

    const packageChannel = createMockCameraConfig().channels.find(channel => channel.name === "Package Camera");
    const cameraConfig = createMockCameraConfig({
      channels: packageChannel ? [ packageChannel ] : [],
      featureFlags: {
        ...createMockCameraConfig().featureFlags,
        hasChime: true,
        hasFingerprintSensor: true,
        hasLcdScreen: true,
        hasPackageCamera: true,
        isDoorbell: true,
        ...overrides.featureFlags
      },
      ...overrides.camera
    });

    const doorbell = new ProtectDoorbell(nvr, cameraConfig as never, createMockAccessory());

    return { doorbell, nvr };
  };

  beforeEach(() => {

    vi.useFakeTimers();
    vi.clearAllMocks();
    setupAccessoryServiceMocks();
  });

  afterEach(() => {

    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("rejects non-doorbell devices in configureDevice", async () => {

    const cameraConfig = createMockCameraConfig({ featureFlags: { ...createMockCameraConfig().featureFlags, isDoorbell: false } });
    const doorbell = new ProtectDoorbell(createMockNvr(), cameraConfig as never, createMockAccessory());

    expect((doorbell as unknown as { configureDevice: () => boolean }).configureDevice()).toBe(false);
    await vi.runOnlyPendingTimersAsync();
  });

  it("configures doorbell-specific services and message switches", async () => {

    const { doorbell, nvr } = createDoorbell();

    expect(doorbell.messageSwitches.size).toBeGreaterThan(0);
    expect(doorbell.accessory.getService(doorbell.nvr.platform.api.hap.Service.Doorbell)).toBeDefined();
    expect(doorbell.accessory.getServiceById(doorbell.nvr.platform.api.hap.Service.ContactSensor, ProtectReservedNames.CONTACT_AUTHSENSOR)).toBeDefined();
    expect(doorbell.accessory.getServiceById(doorbell.nvr.platform.api.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME)).toBeDefined();
    expect(doorbell.accessory.getServiceById(doorbell.nvr.platform.api.hap.Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL)).toBeDefined();
    expect((doorbell as unknown as { chimeDigitalDuration: number }).chimeDigitalDuration).toBe(1000);

    const firstMessage = [ ...doorbell.messageSwitches.values() ][0];
    const messageHandler = getServiceCharacteristicHandlers(firstMessage.service as MockService, doorbell.nvr.platform.api.hap.Characteristic.On);
    await messageHandler.onSet?.(true);

    const updateCalls = (nvr.ufpApi.updateDevice as ReturnType<typeof vi.fn>).mock.calls;
    expect(updateCalls.length).toBeGreaterThan(0);
    expect(updateCalls.at(-1)?.[1]).toEqual(expect.objectContaining({ lcdMessage: expect.any(Object) }));
  });

  it("handles LCD switch updates, NVR message refresh, and stale switch cleanup", () => {

    const { doorbell, nvr } = createDoorbell({
      camera: { lcdMessage: { text: "Welcome", type: "LEAVE_PACKAGE_AT_DOOR", resetAt: Date.now() + 2000 } }
    });
    const staleService = createMockService(doorbell.nvr.platform.api.hap.Service.Switch.UUID);
    staleService.subtype = "CUSTOM_MESSAGE.Stale";
    doorbell.accessory.addService(staleService);

    (doorbell as unknown as { updateLcdSwitch: (payload: object) => void }).updateLcdSwitch({
      resetAt: Date.now() + 4000,
      text: "Welcome",
      type: "LEAVE_PACKAGE_AT_DOOR"
    });
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith(doorbell.ufp.mac, "message", expect.stringContaining("\"message\":\"Welcome\""));

    (doorbell as unknown as { updateLcdSwitch: (payload: object) => void }).updateLcdSwitch({});
    for(const entry of doorbell.messageSwitches.values()) {
      expect(entry.state).toBe(false);
    }

    nvr.ufp.doorbellSettings = {
      ...nvr.ufp.doorbellSettings,
      allMessages: [ { text: "Controller Refresh", type: "LEAVE_PACKAGE_AT_DOOR" } ]
    } as never;
    (doorbell as unknown as { nvrEventHandler: (payload: object) => void }).nvrEventHandler({
      payload: { doorbellSettings: { customMessages: [ "Controller Refresh" ] } }
    });

    expect(doorbell.accessory.removeService).toHaveBeenCalled();
  });

  it("processes MQTT handlers for chime and messages", async () => {

    const { doorbell, nvr } = createDoorbell();
    const mqttGetHandlers = new Map<string, () => string>();
    const mqttSetHandlers = new Map<string, (value: string, rawValue: string) => Promise<void> | void>();

    (nvr.mqtt?.subscribeGet as ReturnType<typeof vi.fn>).mockImplementation((_mac, topic, _desc, handler) => {
      mqttGetHandlers.set(topic, handler);
    });
    (nvr.mqtt?.subscribeSet as ReturnType<typeof vi.fn>).mockImplementation((_mac, topic, _desc, handler) => {
      mqttSetHandlers.set(topic, handler);
    });

    (doorbell as unknown as { configureMqtt: () => boolean }).configureMqtt();

    const chimeService = doorbell.accessory.getServiceById(doorbell.nvr.platform.api.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME) as MockService;
    await mqttSetHandlers.get("chime")?.("38", "38");
    expect(chimeService.setCharacteristic).toHaveBeenCalledWith(doorbell.nvr.platform.api.hap.Characteristic.Brightness, 38);
    await mqttSetHandlers.get("chime")?.("bad", "bad");

    doorbell.ufp.lcdMessage = { resetAt: Date.now() + 5000, text: "Busy", type: "CUSTOM_MESSAGE" } as never;
    expect(mqttGetHandlers.get("message")?.()).toContain("\"message\"");
    await mqttSetHandlers.get("message")?.("", JSON.stringify({ duration: 5, message: "At the door" }));
    await mqttSetHandlers.get("message")?.("", JSON.stringify({ message: "", duration: 0 }));
    await mqttSetHandlers.get("message")?.("", "{ broken");
    await mqttSetHandlers.get("message")?.("", JSON.stringify({ duration: Number.NaN }));

    expect(nvr.platform.log.error).toHaveBeenCalled();
    expect(nvr.ufpApi.updateDevice).toHaveBeenCalled();
  });

  it("handles ring, package camera, authentication, and chime events", async () => {

    const { doorbell, nvr } = createDoorbell({
      camera: { lcdMessage: { text: "Busy", type: "CUSTOM_MESSAGE" } }
    });

    setNvrBootstrap(nvr, {
      cameras: [],
      chimes: [ {
        cameraIds: [ doorbell.ufp.id ],
        id: "chime-1",
        mac: "AA:BB:CC",
        ringSettings: [ { cameraId: doorbell.ufp.id, volume: 44 } ]
      } ],
      lights: [],
      liveviews: [],
      ringtones: [],
      sensors: [],
      viewers: []
    });

    doorbell.packageCamera = {
      accessory: createMockAccessory({ getService: vi.fn(() => createMockService(doorbell.nvr.platform.api.hap.Service.MotionSensor.UUID)) }),
      cleanup: vi.fn(),
      stream: { hksv: { isRecording: true } },
      ufp: createMockCameraConfig()
    } as never;

    (doorbell as unknown as { eventHandler: (packet: object) => void }).eventHandler({
      payload: { lastMotion: Date.now(), lastRing: Date.now(), lcdMessage: { text: "Package", type: "CUSTOM_MESSAGE" } }
    });

    expect(nvr.events.motionEventHandler).toHaveBeenCalledWith(doorbell.packageCamera);
    expect(nvr.events.doorbellEventHandler).toHaveBeenCalled();

    (doorbell as unknown as { addEventHandler: (packet: object) => void }).addEventHandler({
      header: { modelKey: "event" },
      payload: { metadata: { nfc: { nfcId: "tag-1", ulpId: "user-1" } }, type: "nfcCardScanned" }
    });
    const authPayload = (nvr.mqtt?.publish as ReturnType<typeof vi.fn>).mock.calls.find(call => call[1] === "authenticate");
    expect(authPayload).toBeDefined();
    expect(JSON.parse(authPayload?.[2] as string)).toEqual({ id: "tag-1", type: "nfc" });
    await vi.advanceTimersByTimeAsync(PROTECT_DOORBELL_AUTHSENSOR_DURATION + 1);

    (doorbell as unknown as { addEventHandler: (packet: object) => void }).addEventHandler({
      header: { modelKey: "event" },
      payload: { metadata: { fingerprint: {} }, type: "fingerprintIdentified" }
    });

    const volumeService = doorbell.accessory.getServiceById(doorbell.nvr.platform.api.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);
    (doorbell as unknown as { chimeEventHandler: (packet: object) => void }).chimeEventHandler({
      header: { id: "chime-1" },
      payload: {
        cameraIds: [ doorbell.ufp.id ],
        id: "chime-1",
        nvrMac: nvr.ufp.mac,
        ringSettings: [ { cameraId: doorbell.ufp.id, volume: 66 } ]
      }
    });
    expect(volumeService?.updateCharacteristic).toHaveBeenCalledWith(doorbell.nvr.platform.api.hap.Characteristic.Brightness, 66);

    (doorbell as unknown as { chimeEventHandler: (packet: object) => void }).chimeEventHandler({
      header: { id: "chime-x" },
      payload: { cameraIds: [ "other" ], nvrMac: "different" }
    });
  });

  it("handles chime switch/lightbulb interactions, updateDevice, and cleanup", async () => {

    const { doorbell, nvr } = createDoorbell({
      featureFlags: { hasPackageCamera: false },
      camera: { chimeDuration: 300 }
    });
    const noneSwitch = doorbell.accessory.getServiceById(doorbell.nvr.platform.api.hap.Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE) as MockService;
    const mechanicalSwitch = doorbell.accessory.getServiceById(doorbell.nvr.platform.api.hap.Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL) as MockService;
    const digitalSwitch = doorbell.accessory.getServiceById(doorbell.nvr.platform.api.hap.Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL) as MockService;
    const volumeService = doorbell.accessory.getServiceById(doorbell.nvr.platform.api.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME) as MockService;

    expect(getServiceCharacteristicHandlers(mechanicalSwitch, doorbell.nvr.platform.api.hap.Characteristic.On).onGet?.()).toBe(true);
    await getServiceCharacteristicHandlers(digitalSwitch, doorbell.nvr.platform.api.hap.Characteristic.On).onSet?.(true);
    expect(nvr.platform.log.info).toHaveBeenCalledWith(expect.stringContaining("Physical chime type set to digital."));
    await getServiceCharacteristicHandlers(digitalSwitch, doorbell.nvr.platform.api.hap.Characteristic.On).onSet?.(false);
    await vi.advanceTimersByTimeAsync(60);

    await getServiceCharacteristicHandlers(volumeService, doorbell.nvr.platform.api.hap.Characteristic.Brightness).onSet?.(25);
    await getServiceCharacteristicHandlers(volumeService, doorbell.nvr.platform.api.hap.Characteristic.On).onSet?.(false);
    await getServiceCharacteristicHandlers(volumeService, doorbell.nvr.platform.api.hap.Characteristic.On).onSet?.(true);
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith(doorbell.ufp.mac, "chime", "0");

    setNvrBootstrap(nvr, {
      ...nvr.ufpApi.bootstrap,
      chimes: [ {
        cameraIds: [ doorbell.ufp.id ],
        id: "chime-1",
        mac: "AA:BB:CC",
        ringSettings: [ { cameraId: doorbell.ufp.id, volume: 15 } ]
      } ]
    });
    doorbell.packageCamera = {
      accessory: createMockAccessory({ getService: vi.fn(() => createMockService(doorbell.nvr.platform.api.hap.Service.MotionSensor.UUID)) }),
      cleanup: vi.fn(),
      stream: undefined,
      ufp: createMockCameraConfig()
    } as never;

    (doorbell as unknown as { updateDevice: () => boolean }).updateDevice();
    expect(noneSwitch.updateCharacteristic).toHaveBeenCalled();
    const packageCamera = (doorbell as unknown as { packageCamera: { accessory: { getService: ReturnType<typeof vi.fn> }; cleanup: ReturnType<typeof vi.fn> } }).packageCamera;
    expect(packageCamera.accessory.getService).toHaveBeenCalled();

    const packageCleanup = packageCamera.cleanup;
    (doorbell as unknown as { livestream: { shutdown: () => void } }).livestream = { shutdown: vi.fn() };
    doorbell.cleanup();
    expect(packageCleanup).toHaveBeenCalled();
  });

  it("registers package camera through standalone and non-standalone modes", () => {

    const standardFeatures = new Set(allFeatures);
    standardFeatures.delete("Device.Standalone");
    const { doorbell: standardDoorbell, nvr: standardNvr } = createDoorbell({ features: standardFeatures, featureFlags: { hasPackageCamera: true } });
    expect(standardNvr.platform.api.registerPlatformAccessories).toHaveBeenCalled();

    const standaloneFeatures = new Set(allFeatures);
    standaloneFeatures.add("Device.Standalone");
    const { doorbell: standaloneDoorbell, nvr: standaloneNvr } = createDoorbell({ features: standaloneFeatures, featureFlags: { hasPackageCamera: true } });
    expect(standaloneNvr.platform.api.publishExternalAccessories).toHaveBeenCalled();
  });

  it("handles message update failures and no-bootstrap chime volume operations", async () => {

    const { doorbell, nvr } = createDoorbell();
    (nvr.ufpApi.updateDevice as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const messageResult = await (doorbell as unknown as { setMessage: (payload?: object) => Promise<boolean> }).setMessage({
      duration: 1000,
      text: "Failure path",
      type: "CUSTOM_MESSAGE"
    });
    expect(messageResult).toBe(false);
    expect(nvr.platform.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to set doorbell message."));

    setNvrBootstrap(nvr, null);
    await (doorbell as unknown as { setChimeVolume: (value: number) => Promise<void> }).setChimeVolume(20);
    expect(nvr.mqtt?.publish).not.toHaveBeenCalledWith(doorbell.ufp.mac, "chime", "20");
  });

  it("covers LCD and auth/chime service failure branches", () => {

    const { doorbell } = createDoorbell({ featureFlags: { hasLcdScreen: false } });
    expect((doorbell as unknown as { configureDoorbellLcdSwitch: () => boolean }).configureDoorbellLcdSwitch()).toBe(false);

    doorbell.ufp.featureFlags.hasLcdScreen = true;
    const originalAcquire = vi.mocked(acquireService).getMockImplementation();
    vi.mocked(acquireService).mockImplementation((accessory, serviceType, name, subtype, onServiceCreate) => {
      if((serviceType.UUID === doorbell.nvr.platform.api.hap.Service.Switch.UUID) && !!subtype && subtype.includes(".")) {
        return null;
      }

      return originalAcquire?.(accessory, serviceType, name, subtype, onServiceCreate) ?? null;
    });
    doorbell.messageSwitches.clear();
    (doorbell as unknown as { configureDoorbellLcdSwitch: () => boolean }).configureDoorbellLcdSwitch();

    vi.mocked(validService).mockImplementation((_, __, validate) => typeof validate === "function" ? validate(false) : validate);
    vi.mocked(acquireService).mockImplementation(() => null);
    expect((doorbell as unknown as { configureProtectChimeLightbulb: () => boolean }).configureProtectChimeLightbulb()).toBe(false);
    expect((doorbell as unknown as { configureAuthSensor: () => boolean }).configureAuthSensor()).toBe(false);
  });

  it("covers package camera hook and chime volume calculations", async () => {

    const { doorbell, nvr } = createDoorbell();

    setNvrBootstrap(nvr, null);
    expect((doorbell as unknown as { chimeVolume: number }).chimeVolume).toBe(0);

    setNvrBootstrap(nvr, {
      cameras: [],
      chimes: [
        { cameraIds: [ doorbell.ufp.id ], id: "chime-a", mac: "AA", ringSettings: [ { cameraId: "other", volume: 60 } ] },
        { cameraIds: [ doorbell.ufp.id ], id: "chime-b", mac: "BB", ringSettings: [ { cameraId: doorbell.ufp.id, volume: 20 } ] }
      ],
      lights: [],
      liveviews: [],
      ringtones: [],
      sensors: [],
      viewers: []
    });
    expect((doorbell as unknown as { chimeVolume: number }).chimeVolume).toBe(20);

    doorbell.packageCamera = null;
    (doorbell as unknown as { eventHandler: (packet: object) => void }).eventHandler({ payload: { featureFlags: { hasPackageCamera: true } } });
    expect(doorbell.packageCamera).toBeTruthy();

    setNvrBootstrap(nvr, {
      ...nvr.ufpApi.bootstrap,
      chimes: [
        { cameraIds: [ doorbell.ufp.id ], id: "missing-ring", mac: "CC", ringSettings: [ { cameraId: "different", volume: 77 } ] },
        { cameraIds: [ doorbell.ufp.id ], id: "update-fail", mac: "DD", ringSettings: [ { cameraId: doorbell.ufp.id, volume: 30 } ] }
      ]
    });

    (nvr.ufpApi.updateDevice as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await (doorbell as unknown as { setChimeVolume: (value: number) => Promise<void> }).setChimeVolume(-5);
    expect(nvr.platform.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to turn the volume off."));

    (nvr.ufpApi.updateDevice as ReturnType<typeof vi.fn>).mockResolvedValue({
      cameraIds: [ doorbell.ufp.id ],
      id: "update-success",
      mac: "EE",
      ringSettings: [ { cameraId: doorbell.ufp.id, volume: 55 } ]
    });
    await (doorbell as unknown as { setChimeVolume: (value: number) => Promise<void> }).setChimeVolume(55);
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith(doorbell.ufp.mac, "chime", "55");
  });

  it("covers message-switch edge cases and physical chime failures", async () => {

    const { doorbell, nvr } = createDoorbell({
      camera: {
        lcdMessage: { text: "abcdefghijklmnopqrstuvwxyz1234567890", type: "CUSTOM_MESSAGE" }
      }
    });

    doorbell.messageSwitches.set("CUSTOM_MESSAGE.Dupe", {
      duration: 1000,
      service: createMockService(doorbell.nvr.platform.api.hap.Service.Switch.UUID),
      state: false,
      text: "Dupe",
      type: "CUSTOM_MESSAGE"
    } as never);
    (doorbell as any).configureDoorbellLcdSwitch();

    (doorbell as any).updateLcdSwitch({ duration: 1 });

    const originalAcquire = vi.mocked(acquireService).getMockImplementation();
    vi.mocked(acquireService).mockImplementation((accessory, serviceType, name, subtype, onServiceCreate) => {
      if(subtype === ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL) {
        return null;
      }
      return originalAcquire?.(accessory, serviceType, name, subtype, onServiceCreate) ?? null;
    });
    (doorbell as any).configurePhysicalChimes();
    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to add physical chime switch"));

    vi.mocked(acquireService).mockImplementation(originalAcquire ?? (() => null) as never);
    const stale = createMockService(doorbell.nvr.platform.api.hap.Service.Switch.UUID);
    stale.subtype = "CUSTOM_MESSAGE.StaleEntry";
    doorbell.accessory.addService(stale);
    (doorbell as any).validateMessageSwitches();
    expect(doorbell.accessory.removeService).toHaveBeenCalledWith(stale);

    (nvr.ufpApi.updateDevice as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...doorbell.ufp,
      lcdMessage: {}
    } as never);
    await (doorbell as any).setMessage({ duration: -1, message: "" });
  });

  it("covers low-duration clamps, duplicate messages, and mqtt fallback branches", async () => {

    const { doorbell, nvr } = createDoorbell({
      camera: { featureFlags: { ...createMockCameraConfig().featureFlags, hasFingerprintSensor: false }, enableNfc: false },
      features: new Set([ "Device", "Doorbell.Messages", "Doorbell.Messages.FromDoorbell", "Doorbell.Trigger" ])
    });
    (nvr.platform.featureOptions.getInteger as ReturnType<typeof vi.fn>).mockReturnValueOnce(500);
    nvr.config.doorbellMessages = [{ duration: -1, message: "This message is intentionally longer than thirty characters" }] as never;

    const existingMessageService = createMockService(doorbell.nvr.platform.api.hap.Service.Switch.UUID);
    existingMessageService.subtype = "CUSTOM_MESSAGE.Dupe";
    doorbell.messageSwitches.set("mismatch-key", {
      duration: 1000,
      service: existingMessageService,
      state: false,
      text: "Dupe",
      type: "CUSTOM_MESSAGE"
    } as never);

    doorbell.accessory.addService(existingMessageService);
    (doorbell as any).configureDoorbellLcdSwitch();
    expect(doorbell.accessory.removeService).toHaveBeenCalledWith(existingMessageService);

    expect((doorbell as any).configurePackageCamera()).toBe(true);
    expect((doorbell as any).configureAuthSensor()).toBe(false);
    expect((doorbell as any).configureProtectChimeLightbulb()).toBe(false);
    expect((doorbell as any).configurePhysicalChimes()).toBe(true);
    expect((doorbell as any).chimeDigitalDuration).toBe(1000);

    expect((doorbell as any).defaultMessageDuration).toBeGreaterThan(0);
  });

  it("covers remaining doorbell branch paths for messages, chimes, mqtt, and events", async () => {

    const { doorbell, nvr } = createDoorbell({
      camera: { marketName: "Market Doorbell", name: undefined }
    });

    delete (nvr.ufp as { doorbellSettings?: unknown }).doorbellSettings;
    nvr.config.doorbellMessages = [
      { duration: 12, message: "Timed Message" },
      { message: "No Duration Message" }
    ] as never;
    vi.mocked(nvr.platform.featureOptions.getInteger).mockImplementation((name: string) =>
      (name === "Doorbell.PhysicalChime.Duration.Digital") ? 15000 : undefined);

    (doorbell as unknown as { configureDevice: () => boolean }).configureDevice();
    expect((doorbell as any).chimeDigitalDuration).toBe(10000);
    expect((doorbell as any).defaultMessageDuration).toBe(60000);

    nvr.ufp.doorbellSettings = {
      allMessages: [
        { text: "digital", type: "DoorbellChime" },
        { text: "Welcome", type: "LEAVE_PACKAGE_AT_DOOR" }
      ],
      customMessages: [],
      defaultMessageResetTimeoutMs: 8000
    } as never;
    (doorbell as any).configureDoorbellLcdSwitch();

    const welcomeSwitch = [ ...doorbell.messageSwitches.values() ].find(entry => entry.text === "Welcome")!;
    const welcomeHandler = getServiceCharacteristicHandlers(welcomeSwitch.service as MockService, doorbell.nvr.platform.api.hap.Characteristic.On);
    welcomeSwitch.state = true;
    await welcomeHandler.onSet?.(true);
    await welcomeHandler.onSet?.(false);

    expect((doorbell as any).configurePackageCamera()).toBe(true);
    expect((doorbell as any).configurePackageCamera()).toBe(true);

    const digitalSwitch = doorbell.accessory.getServiceById(doorbell.nvr.platform.api.hap.Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL) as MockService;
    (nvr.ufpApi.updateDevice as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await getServiceCharacteristicHandlers(digitalSwitch, doorbell.nvr.platform.api.hap.Characteristic.On).onSet?.(true);
    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to set the physical chime mode to digital."));

    const mqttGetHandlers = new Map<string, () => string>();
    const mqttSetHandlers = new Map<string, (value: string, rawValue: string) => void>();
    (nvr.mqtt?.subscribeGet as ReturnType<typeof vi.fn>).mockImplementation((_mac, topic, _desc, handler) => {
      mqttGetHandlers.set(topic, handler);
    });
    (nvr.mqtt?.subscribeSet as ReturnType<typeof vi.fn>).mockImplementation((_mac, topic, _desc, handler) => {
      mqttSetHandlers.set(topic, handler);
    });
    (doorbell as any).configureMqtt();

    doorbell.ufp.lcdMessage = undefined;
    expect(mqttGetHandlers.get("message")?.()).toBe("");
    doorbell.ufp.lcdMessage = { resetAt: "not-a-number", text: undefined, type: "CUSTOM_MESSAGE" } as never;
    expect(JSON.parse(mqttGetHandlers.get("message")?.() ?? "{}")).toEqual({ duration: 0, message: "" });

    await mqttSetHandlers.get("message")?.("", JSON.stringify({ message: "Hello MQTT", duration: 5 }));
    await mqttSetHandlers.get("message")?.("", JSON.stringify({ message: "Default Duration Only" }));
    await mqttSetHandlers.get("message")?.("", JSON.stringify({ message: "" }));

    (doorbell as any).updateLcdSwitch({
      resetAt: Date.now() + 5000,
      text: undefined,
      type: undefined
    });
    (doorbell as any).updateLcdSwitch({
      resetAt: null,
      text: "Welcome",
      type: "LEAVE_PACKAGE_AT_DOOR"
    });

    await (doorbell as any).setMessage({ duration: 0, text: "Zero Duration", type: "CUSTOM_MESSAGE" });

    doorbell.packageCamera = {
      accessory: createMockAccessory(),
      cleanup: vi.fn(),
      stream: { hksv: { isRecording: true } },
      ufp: createMockCameraConfig()
    } as never;
    (doorbell as any).eventHandler({ payload: { lastMotion: Date.now() } });

    setNvrBootstrap(nvr, {
      cameras: [],
      chimes: [ {
        cameraIds: [ doorbell.ufp.id ],
        id: "chime-volume",
        mac: "AA:BB:CC",
        ringSettings: [ { cameraId: doorbell.ufp.id } ]
      } ],
      lights: [],
      liveviews: [],
      ringtones: [],
      sensors: [],
      viewers: []
    });
    (doorbell as any).chimeEventHandler({
      header: { id: "chime-volume" },
      payload: {
        cameraIds: [ doorbell.ufp.id ],
        id: "chime-volume",
        nvrMac: nvr.ufp.mac,
        ringSettings: [ { cameraId: doorbell.ufp.id, volume: undefined } ]
      }
    });

    const volumeService = doorbell.accessory.getServiceById(doorbell.nvr.platform.api.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);
    expect(volumeService?.updateCharacteristic).toHaveBeenCalledWith(doorbell.nvr.platform.api.hap.Characteristic.Brightness, 0);
    expect(volumeService?.updateCharacteristic).toHaveBeenCalledWith(doorbell.nvr.platform.api.hap.Characteristic.On, false);

    (doorbell as any).addEventHandler({
      header: { modelKey: "event" },
      payload: { metadata: { nfc: { ulpId: "user-1" } }, type: "nfcCardScanned" }
    });
    const authPayload = (nvr.mqtt?.publish as ReturnType<typeof vi.fn>).mock.calls.find(call => call[1] === "authenticate");
    expect(JSON.parse(authPayload?.[2] as string)).toEqual({ id: "", type: "nfc" });
  });

  it("covers final doorbell branch gaps for duration clamps, messages, mqtt, and lcd updates", async () => {

    const { doorbell: lowDurationDoorbell, nvr: lowDurationNvr } = createDoorbell();

    vi.mocked(lowDurationNvr.platform.featureOptions.getInteger).mockImplementation((name: string) =>
      (name === "Doorbell.PhysicalChime.Duration.Digital") ? 250 : undefined);
    expect((lowDurationDoorbell as unknown as { configureDevice: () => boolean }).configureDevice()).toBe(true);
    expect((lowDurationDoorbell as unknown as { chimeDigitalDuration: number }).chimeDigitalDuration).toBe(1000);

    const longMessage = "abcdefghijklmnopqrstuvwxyz1234567890extra";
    const truncatedMessage = longMessage.slice(0, 30);
    const messageFeatures = new Set([
      "Device",
      "Doorbell.AuthSensor",
      "Doorbell.Messages",
      "Doorbell.PhysicalChime",
      "Doorbell.Trigger",
      "Doorbell.Volume.Dimmer"
    ]);
    const { doorbell, nvr } = createDoorbell({ features: messageFeatures });

    nvr.config.doorbellMessages = [ { message: longMessage } ] as never;
    nvr.ufp.doorbellSettings = { allMessages: [], customMessages: [], defaultMessageResetTimeoutMs: 5000 } as never;
    expect((doorbell as unknown as { configureDevice: () => boolean }).configureDevice()).toBe(true);
    expect([ ...doorbell.messageSwitches.values() ].some(entry => entry.text === truncatedMessage)).toBe(true);

    doorbell.messageSwitches.set(`CUSTOM_MESSAGE.${truncatedMessage}`, {
      duration: 1000,
      service: createMockService(doorbell.nvr.platform.api.hap.Service.Switch.UUID),
      state: false,
      text: truncatedMessage,
      type: "CUSTOM_MESSAGE"
    } as never);

    const switchCountBeforeDuplicate = doorbell.messageSwitches.size;

    expect((doorbell as unknown as { configureDoorbellLcdSwitch: () => boolean }).configureDoorbellLcdSwitch()).toBe(true);
    expect(doorbell.messageSwitches.size).toBe(switchCountBeforeDuplicate);

    nvr.config.doorbellMessages = [ { message: "Brand New Fail Message" } ] as never;
    doorbell.messageSwitches.clear();
    vi.spyOn(doorbell as unknown as { acquireService: (...args: unknown[]) => unknown }, "acquireService").mockReturnValue(null);
    expect((doorbell as unknown as { configureDoorbellLcdSwitch: () => boolean }).configureDoorbellLcdSwitch()).toBe(false);
    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to add doorbell message switch"));

    vi.restoreAllMocks();
    setupAccessoryServiceMocks();

    const mqttSetHandlers = new Map<string, (value: string, rawValue: string) => void>();

    (nvr.mqtt?.subscribeSet as ReturnType<typeof vi.fn>).mockImplementation((_mac, topic, _desc, handler) => {
      mqttSetHandlers.set(topic, handler);
    });
    (doorbell as unknown as { configureMqtt: () => boolean }).configureMqtt();
    vi.mocked(nvr.log.info).mockClear();
    await mqttSetHandlers.get("message")?.("", JSON.stringify({ duration: 0, message: "Zero Duration MQTT" }));
    expect(nvr.log.info).toHaveBeenCalledWith(expect.stringContaining("Received MQTT doorbell message: Zero Duration MQTT."));

    const mqttGetHandlers = new Map<string, () => string>();

    (nvr.mqtt?.subscribeGet as ReturnType<typeof vi.fn>).mockImplementation((_mac, topic, _desc, handler) => {
      mqttGetHandlers.set(topic, handler);
    });
    (doorbell as unknown as { configureMqtt: () => boolean }).configureMqtt();
    expect(mqttGetHandlers.get("chime")?.()).toBe(String((doorbell as unknown as { chimeVolume: number }).chimeVolume));

    const { doorbell: lcdDoorbell, nvr: lcdNvr } = createDoorbell();
    const welcomeEntry = [ ...lcdDoorbell.messageSwitches.values() ].find(entry => entry.text === "Welcome")!;

    welcomeEntry.state = false;
    vi.mocked(lcdNvr.log.info).mockClear();
    (lcdDoorbell as unknown as { updateLcdSwitch: (payload: object) => void }).updateLcdSwitch({
      resetAt: null,
      text: "Welcome",
      type: "LEAVE_PACKAGE_AT_DOOR"
    });
    expect(lcdNvr.log.info).toHaveBeenCalledWith(expect.stringContaining("Doorbell message set: Welcome."));

    welcomeEntry.state = false;
    vi.mocked(lcdNvr.log.info).mockClear();
    (lcdDoorbell as unknown as { updateLcdSwitch: (payload: object) => void }).updateLcdSwitch({
      resetAt: Date.now() + 8000,
      text: "Welcome",
      type: "LEAVE_PACKAGE_AT_DOOR"
    });
    expect(lcdNvr.log.info).toHaveBeenCalledWith(expect.stringContaining("Doorbell message set ("));

    welcomeEntry.state = false;
    vi.mocked(lcdNvr.log.info).mockClear();
    (lcdDoorbell as unknown as { updateLcdSwitch: (payload: object) => void }).updateLcdSwitch({
      text: "Welcome",
      type: "LEAVE_PACKAGE_AT_DOOR"
    });
    expect(lcdNvr.log.info).toHaveBeenCalledWith(expect.stringContaining("Doorbell message set ("));
  });
});
