import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pluginUtils from "homebridge-plugin-utils";
import { ProtectNvrSystemInfo } from "../../src/devices/protect-nvr-systeminfo.js";
import { createMockAccessory, createMockNvr, createMockService, mutablePlatformApi, type MockService } from "../helpers/mocks.js";

function installPlatformAccessoryCtor(nvr: ReturnType<typeof createMockNvr>): void {

  mutablePlatformApi(nvr.platform).platformAccessory = vi.fn((displayName: string, UUID: string) =>
    createMockAccessory({ UUID, displayName, _associatedHAPAccessory: { displayName } })) as never;
}

function installAccessoryAwareAcquireService(): void {

  vi.mocked(pluginUtils.acquireService).mockImplementation((accessory, serviceType, name, subtype) => {

    const existing = subtype ? accessory.getServiceById(serviceType, subtype) : accessory.getService(serviceType);
    if(existing) {
      return existing;
    }

    const service = createMockService(serviceType.UUID) as MockService;
    service.displayName = name ?? "Mock Service";
    service.subtype = subtype;
    accessory.addService(service);
    return service;
  });
}

describe("ProtectNvrSystemInfo", () => {

  beforeEach(() => {

    vi.clearAllMocks();
    installAccessoryAwareAcquireService();
    vi.mocked(pluginUtils.validService).mockReturnValue(true);
  });

  it("creates accessory, configures cpu temperature sensor, and mqtt getter", () => {

    const nvr = createMockNvr();
    installPlatformAccessoryCtor(nvr);
    (nvr as unknown as { hasFeature: (name: string) => boolean }).hasFeature = vi.fn((name: string) => name === "NVR.SystemInfo");
    nvr.ufp.marketName = "UNVR" as never;
    nvr.ufp.type = "nvr" as never;
    nvr.ufp.systemInfo = { cpu: { temperature: 62.5 } } as never;
    nvr.ufp.hardwareRevision = "A1";

    const info = new ProtectNvrSystemInfo(nvr);

    expect(nvr.platform.api.registerPlatformAccessories).toHaveBeenCalled();
    expect(nvr.platform.accessories).toHaveLength(1);

    const mqttGet = vi.mocked(nvr.mqtt!.subscribeGet).mock.calls.find(call => call[1] === "systeminfo")?.[3] as () => string;
    expect(mqttGet()).toBe(JSON.stringify(nvr.ufp.systemInfo));

    nvr.events.emit("updateEvent.nvr-id", { payload: { systemInfo: { cpu: { temperature: 65 } } } });
    expect(nvr.platform.accessories[0].getService(nvr.platform.api.hap.Service.TemperatureSensor)).toBeTruthy();

    info.cleanup();
    expect(nvr.events.off).toHaveBeenCalledWith("updateEvent.nvr-id", expect.any(Function));
  });

  it("removes existing accessory when feature disabled", () => {

    const nvr = createMockNvr();
    installPlatformAccessoryCtor(nvr);
    (nvr as unknown as { hasFeature: (name: string) => boolean }).hasFeature = vi.fn(() => false);

    const existing = createMockAccessory({ UUID: nvr.platform.api.hap.uuid.generate(`${nvr.ufp.mac}.NVRSystemInfo`) });
    nvr.platform.accessories.push(existing);

    new ProtectNvrSystemInfo(nvr);

    expect(nvr.platform.api.unregisterPlatformAccessories).toHaveBeenCalled();
    expect(nvr.platform.accessories).toHaveLength(0);
  });

  it("handles no accessory path in temperature configuration safely", () => {

    const nvr = createMockNvr();
    installPlatformAccessoryCtor(nvr);
    (nvr as unknown as { hasFeature: (name: string) => boolean }).hasFeature = vi.fn(() => false);

    const info = new ProtectNvrSystemInfo(nvr) as unknown as { configureTemperatureSensor: (configureHandler: boolean) => boolean };
    expect(info.configureTemperatureSensor(false)).toBe(false);
  });

  it("handles already configured accessory and temperature service failures", () => {

    const nvr = createMockNvr();
    installPlatformAccessoryCtor(nvr);
    (nvr as unknown as { hasFeature: (name: string) => boolean }).hasFeature = vi.fn((name: string) => name === "NVR.SystemInfo");
    nvr.ufp.marketName = "UNVR" as never;
    nvr.ufp.type = "nvr" as never;
    nvr.ufp.systemInfo = { cpu: { temperature: 62.5 } } as never;

    const info = new ProtectNvrSystemInfo(nvr) as any;
    info.isConfigured = false;
    info.accessory = createMockAccessory({ displayName: "System Info" });
    vi.spyOn(info, "updateDevice").mockReturnValue([]);
    info.configureAccessory();
    expect(nvr.log.info).toHaveBeenCalledWith(expect.stringContaining("No system information sensors enabled."));

    vi.mocked(pluginUtils.validService).mockReturnValue(false);
    expect(info.configureTemperatureSensor(false)).toBe(false);

    vi.mocked(pluginUtils.validService).mockReturnValue(true);
    vi.mocked(pluginUtils.acquireService).mockReturnValueOnce(null);
    expect(info.configureTemperatureSensor(false)).toBe(false);
    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to add CPU temperature sensor."));
  });
});
