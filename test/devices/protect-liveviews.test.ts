import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pluginUtils from "homebridge-plugin-utils";
import { ProtectLiveviews } from "../../src/devices/protect-liveviews.js";
import { createMockAccessory, createMockNvr, createMockService, getServiceCharacteristicHandlers, mutablePlatformApi, nvrBootstrap, setNvrBootstrap } from "../helpers/mocks.js";

function installPlatformAccessoryCtor(nvr: ReturnType<typeof createMockNvr>): void {

  mutablePlatformApi(nvr.platform).platformAccessory = vi.fn((displayName: string, UUID: string) =>
    createMockAccessory({ UUID, displayName, _associatedHAPAccessory: { displayName } })) as never;
}

function installSwitchConstructor(nvr: ReturnType<typeof createMockNvr>): void {

  const Switch = function(this: unknown, name: string) {
    const service = createMockService("switch");
    service.displayName = name;
    return service;
  } as unknown as { new(name: string): ReturnType<typeof createMockService>; UUID: string };

  Switch.UUID = "switch";
  nvr.platform.api.hap.Service.Switch = Switch as never;
}

function createCameraDevice(nvr: ReturnType<typeof createMockNvr>, id: string, detectMotion: boolean) {

  const accessory = createMockAccessory({ displayName: id, context: { nvr: nvr.ufp.mac, detectMotion } });
  const switchService = createMockService(nvr.platform.api.hap.Service.Switch.UUID);
  accessory.addService(switchService);

  return {
    accessory,
    accessoryName: id,
    ufp: { id }
  };
}

describe("ProtectLiveviews", () => {

  beforeEach(() => {

    vi.clearAllMocks();
  });

  it("configures plugin liveview switches and toggles camera motion states", async () => {

    const nvr = createMockNvr();
    installPlatformAccessoryCtor(nvr);
    installSwitchConstructor(nvr);
    nvrBootstrap(nvr).nvr = { name: "NVR", marketName: "NVR" } as never;
    nvrBootstrap(nvr).liveviews = [
      { id: "a", name: "Protect-Backyard", slots: [{ cameras: ["cam-1"] }] },
      { id: "b", name: "Protect-Backyard", slots: [{ cameras: ["cam-2"] }] }
    ] as never;

    const cam1 = createCameraDevice(nvr, "cam-1", false);
    const cam2 = createCameraDevice(nvr, "cam-2", false);
    nvr.getDeviceById = vi.fn((id: string) => (id === "cam-1" ? cam1 : id === "cam-2" ? cam2 : null)) as never;

    const liveviews = new ProtectLiveviews(nvr);
    liveviews.configureLiveviews();

    const switchAccessory = nvr.platform.accessories.find(acc => acc.context.liveview === "Backyard");
    expect(switchAccessory).toBeTruthy();

    const switchService = switchAccessory!.getService(nvr.platform.api.hap.Service.Switch)!;
    const handlers = getServiceCharacteristicHandlers(switchService as any, nvr.platform.api.hap.Characteristic.On);
    expect(handlers.onGet?.()).toBe(true);

    await handlers.onSet?.(true);
    expect(cam1.accessory.context.detectMotion).toBe(true);
    expect(cam2.accessory.context.detectMotion).toBe(true);
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith(nvr.ufp.mac, "liveviews", JSON.stringify([{ name: "Backyard", state: true }]));
  });

  it("handles mqtt get/set callbacks, including invalid json", () => {

    const nvr = createMockNvr();
    installPlatformAccessoryCtor(nvr);
    installSwitchConstructor(nvr);
    nvrBootstrap(nvr).nvr = { name: "NVR", marketName: "NVR" } as never;
    nvrBootstrap(nvr).liveviews = [{ id: "a", name: "Protect-Entry", slots: [{ cameras: ["cam-1"] }] }] as never;
    nvr.getDeviceById = vi.fn(() => createCameraDevice(nvr, "cam-1", true)) as never;

    const liveviews = new ProtectLiveviews(nvr);
    liveviews.configureLiveviews();

    const mqttGet = vi.mocked(nvr.mqtt!.subscribeGet).mock.calls.find(call => call[1] === "liveviews")?.[3] as () => string;
    const mqttSet = vi.mocked(nvr.mqtt!.subscribeSet).mock.calls.find(call => call[1] === "liveviews")?.[3] as (value: string, raw: string) => void;
    const current = JSON.parse(mqttGet()) as Array<{ name: string; state: boolean }>;

    expect(current.some(entry => entry.name === "Entry")).toBe(true);
    mqttSet("", "not-json");
    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to process MQTT message: \"not-json\". Invalid JSON."));

    mqttSet("", JSON.stringify([{ name: "Entry", state: false }]));
    expect(nvr.log.info).toHaveBeenCalledWith(expect.stringContaining("Liveview scene updated via MQTT: Entry."));
  });

  it("removes orphan liveview switch accessories", () => {

    const nvr = createMockNvr();
    installPlatformAccessoryCtor(nvr);
    installSwitchConstructor(nvr);
    nvrBootstrap(nvr).nvr = { name: "NVR", marketName: "NVR" } as never;
    nvrBootstrap(nvr).liveviews = [] as never;

    const orphan = createMockAccessory({ context: { liveview: "Legacy", nvr: nvr.ufp.mac, liveviewState: true } });
    nvr.platform.accessories.push(orphan);

    const liveviews = new ProtectLiveviews(nvr);
    liveviews.configureLiveviews();

    expect(nvr.platform.api.unregisterPlatformAccessories).toHaveBeenCalledWith(expect.any(String), expect.any(String), [orphan]);
  });

  it("removes security accessory when security liveviews are gone", () => {

    const nvr = createMockNvr();
    installPlatformAccessoryCtor(nvr);
    installSwitchConstructor(nvr);
    nvrBootstrap(nvr).nvr = { name: "NVR", marketName: "NVR" } as never;
    nvrBootstrap(nvr).liveviews = [] as never;

    const liveviews = new ProtectLiveviews(nvr) as unknown as { securityAccessory: ReturnType<typeof createMockAccessory> | null };
    const securityAccessory = createMockAccessory({ context: { nvr: nvr.ufp.mac } });
    liveviews.securityAccessory = securityAccessory;
    nvr.platform.accessories.push(securityAccessory);

    (liveviews as unknown as ProtectLiveviews).configureLiveviews();
    expect(nvr.platform.api.unregisterPlatformAccessories).toHaveBeenCalled();
  });

  it("handles empty bootstrap and invalid mqtt payload branches", () => {

    const nvr = createMockNvr();
    nvrBootstrap(nvr).nvr = null as never;
    const liveviews = new ProtectLiveviews(nvr);
    liveviews.configureLiveviews();
    expect(nvr.platform.accessories).toHaveLength(0);

    installPlatformAccessoryCtor(nvr);
    installSwitchConstructor(nvr);
    nvrBootstrap(nvr).nvr = { name: "NVR", marketName: "NVR" } as never;
    nvrBootstrap(nvr).liveviews = [{ id: "a", name: "Protect-Entry", slots: [{ cameras: ["cam-1"] }] }] as never;
    nvr.getDeviceById = vi.fn(() => createCameraDevice(nvr, "cam-1", false)) as never;

    liveviews.configureLiveviews();
    const mqttSet = vi.mocked(nvr.mqtt!.subscribeSet).mock.calls.find(call => call[1] === "liveviews")?.[3] as (value: string, raw: string) => void;
    mqttSet("", "[]");

    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to process MQTT message"));
  });

  it("creates security accessory and handles mixed/empty liveview states", async () => {

    const nvr = createMockNvr();
    installPlatformAccessoryCtor(nvr);
    installSwitchConstructor(nvr);
    nvrBootstrap(nvr).nvr = { name: "NVR", marketName: "NVR" } as never;
    nvrBootstrap(nvr).liveviews = [
      { id: "security-home", name: "Protect-Home", slots: [{ cameras: ["cam-1"] }] },
      { id: "entry", name: "Protect-Entry", slots: [{ cameras: ["cam-1", "cam-2"] }] }
    ] as never;

    const cam1 = createCameraDevice(nvr, "cam-1", true);
    const cam2 = createCameraDevice(nvr, "cam-2", false);
    nvr.getDeviceById = vi.fn((id: string) => (id === "cam-1" ? cam1 : id === "cam-2" ? cam2 : null)) as never;
    (nvr as unknown as { hasFeature: (name: string) => boolean }).hasFeature = vi.fn(() => false);
    vi.mocked(pluginUtils.acquireService).mockImplementation((accessory, serviceType, name) => {
      const existing = accessory.getService(serviceType);
      if(existing) {
        return existing;
      }
      const service = createMockService(serviceType.UUID) as any;
      service.displayName = name ?? "Mock Service";
      service.updateCharacteristic = vi.fn(() => service);
      accessory.addService(service);
      return service;
    });

    const liveviews = new ProtectLiveviews(nvr);
    liveviews.configureLiveviews();

    const securityAccessory = nvr.platform.accessories.find(acc => !("liveview" in acc.context));
    expect(securityAccessory).toBeTruthy();
    expect(nvr.platform.api.registerPlatformAccessories).toHaveBeenCalled();

    const entryAccessory = nvr.platform.accessories.find(acc => acc.context.liveview === "Entry")!;
    const handlers = getServiceCharacteristicHandlers(entryAccessory.getService(nvr.platform.api.hap.Service.Switch) as any, nvr.platform.api.hap.Characteristic.On);
    expect(typeof handlers.onGet?.()).toBe("boolean");

    await handlers.onSet?.(true);
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith(nvr.ufp.mac, "liveviews", expect.stringContaining("\"Entry\""));
  });

  it("covers bootstrap-less and no-camera liveview branches", () => {

    const nvr = createMockNvr();
    const liveviews = new ProtectLiveviews(nvr) as any;

    setNvrBootstrap(nvr, null);
    liveviews.configureSwitches();
    liveviews.configureSecuritySystem();

    setNvrBootstrap(nvr, {
      cameras: [],
      chimes: [],
      lights: [],
      liveviews: [{ id: "a", name: "Protect-Entry", slots: [{ cameras: [] }] }],
      nvr: { marketName: "NVR", name: "NVR" },
      ringtones: [],
      sensors: [],
      viewers: []
    });
    liveviews.liveviews = nvrBootstrap(nvr).liveviews;

    const switchAccessory = createMockAccessory({ context: { liveview: "Entry", liveviewState: true, nvr: nvr.ufp.mac } });
    nvr.platform.accessories.push(switchAccessory);
    liveviews.setSwitchState(switchAccessory, false);

    expect(nvr.mqtt?.publish).not.toHaveBeenCalledWith(nvr.ufp.mac, "liveviews", expect.any(String));
  });

  it("covers configure skip paths and duplicate liveview handling", () => {

    const nvr = createMockNvr();
    installPlatformAccessoryCtor(nvr);
    installSwitchConstructor(nvr);
    nvrBootstrap(nvr).nvr = { name: "NVR", marketName: "NVR" } as never;
    nvrBootstrap(nvr).liveviews = [
      { id: "a", name: "Protect-Entry", slots: [{ cameras: ["cam-1"] }] },
      { id: "b", name: "Protect-Entry", slots: [{ cameras: ["cam-1"] }] }
    ] as never;

    const existing = createMockAccessory({
      UUID: nvr.platform.api.hap.uuid.generate(`${nvr.ufp.mac}.Liveview.ENTRY`),
      context: { liveview: "Entry", liveviewState: false, nvr: nvr.ufp.mac }
    });
    nvr.platform.accessories.push(existing);
    nvr.getDeviceById = vi.fn(() => createCameraDevice(nvr, "cam-1", true)) as never;

    const liveviews = new ProtectLiveviews(nvr) as any;
    liveviews.isConfigured.add("ENTRY");
    liveviews.configureSwitches();
    expect(existing.context.liveviewState).toBe(false);

    liveviews.configureMqtt();
    liveviews.configureMqtt();

    const mqttSet = vi.mocked(nvr.mqtt!.subscribeSet).mock.calls.find(call => call[1] === "liveviews")?.[3] as (value: string, raw: string) => void;
    mqttSet("", JSON.stringify([{ name: "Unknown", state: true }]));
    expect(nvr.log.info).not.toHaveBeenCalledWith(expect.stringContaining("Unknown"));
  });
});
