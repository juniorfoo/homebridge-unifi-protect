import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pluginUtils from "homebridge-plugin-utils";
import { ProtectLight } from "../../src/devices/protect-light.js";
import { ProtectReservedNames } from "../../src/protect-types.js";
import {
  createMockAccessory,
  createMockLightConfig,
  createMockNvr,
  createMockService,
  getServiceCharacteristicHandlers,
  type MockService
} from "../helpers/mocks.js";

function createConfiguredNvr(...args: Parameters<typeof createMockNvr>): ReturnType<typeof createMockNvr> {

  const nvr = createMockNvr(...args);
  (nvr.ufpApi as unknown as { getDeviceName: (device: { name?: string; marketName?: string }) => string }).getDeviceName =
    vi.fn((device) => device.name ?? device.marketName ?? "Device");
  (nvr as unknown as { logFeature: (feature: string, message: string) => void }).logFeature = vi.fn();
  return nvr;
}

function installAccessoryAwareAcquireService(): void {

  vi.mocked(pluginUtils.acquireService).mockImplementation((accessory, serviceType, name, subtype) => {

    const existing = subtype ? accessory.getServiceById(serviceType, subtype) : accessory.getService(serviceType);

    if(existing) {
      return existing;
    }

    const service = createMockService(serviceType.UUID) as MockService & { setCharacteristic: (name: string, value: unknown) => MockService };

    service.displayName = name ?? "Mock Service";
    service.subtype = subtype;
    service.setCharacteristic = vi.fn((characteristic: string, value: unknown) => {

      service.updateCharacteristic(characteristic as never, value as never);

      return service;
    });

    accessory.addService(service);

    return service;
  });
}

describe("ProtectLight", () => {

  beforeEach(() => {

    vi.clearAllMocks();
    vi.useRealTimers();
    installAccessoryAwareAcquireService();
    vi.mocked(pluginUtils.validService).mockReturnValue(true);
  });

  it("constructs and configures context, services, and listeners", () => {

    const nvr = createConfiguredNvr({
      featureTest: (name: string) => name === "Motion.OccupancySensor" || name === "Device.StatusLed.Switch"
    });
    const accessory = createMockAccessory();
    const light = new ProtectLight(nvr, createMockLightConfig(), accessory);

    expect(light.ufp.mac).toBe("AA:BB:CC:DD:EE:02");
    expect(accessory.context.mac).toBe("AA:BB:CC:DD:EE:02");
    expect(accessory.context.nvr).toBe(nvr.ufp.mac);
    expect(nvr.events.on).toHaveBeenCalledWith("updateEvent.light-1", expect.any(Function));
  });

  it("runs onGet/onSet for On and publishes state", async () => {

    const nvr = createConfiguredNvr();
    const accessory = createMockAccessory();
    const light = new ProtectLight(nvr, createMockLightConfig({ isLightOn: true }), accessory);
    const lightService = accessory.getService(light.api.hap.Service.Lightbulb) as MockService;
    const onHandlers = getServiceCharacteristicHandlers(lightService, light.api.hap.Characteristic.On);

    expect(onHandlers.onGet?.()).toBe(true);

    await onHandlers.onSet?.(false);
    expect(nvr.ufpApi.updateDevice).toHaveBeenCalledWith(expect.any(Object), { lightOnSettings: { isLedForceOn: false } });
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith(light.ufp.mac, "light", "false");
  });

  it("logs when On update fails", async () => {

    const nvr = createConfiguredNvr();
    vi.mocked(nvr.ufpApi.updateDevice).mockResolvedValueOnce(null as never);

    const accessory = createMockAccessory();
    new ProtectLight(nvr, createMockLightConfig(), accessory);
    const lightService = accessory.getService(nvr.platform.api.hap.Service.Lightbulb) as MockService;
    const onHandlers = getServiceCharacteristicHandlers(lightService, nvr.platform.api.hap.Characteristic.On);

    await onHandlers.onSet?.(true);
    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to turn the light on"));
  });

  it("logs off-state failure and publishes true-state updates", async () => {

    const nvr = createConfiguredNvr();
    const accessory = createMockAccessory();
    new ProtectLight(nvr, createMockLightConfig({ isLightOn: false }), accessory);

    const lightService = accessory.getService(nvr.platform.api.hap.Service.Lightbulb) as MockService;
    const onHandlers = getServiceCharacteristicHandlers(lightService, nvr.platform.api.hap.Characteristic.On);

    vi.mocked(nvr.ufpApi.updateDevice).mockResolvedValueOnce(null as never);
    await onHandlers.onSet?.(false);
    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to turn the light off"));

    vi.mocked(nvr.ufpApi.updateDevice).mockResolvedValueOnce(createMockLightConfig({ isLightOn: true }) as never);
    await onHandlers.onSet?.(true);
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith("AA:BB:CC:DD:EE:02", "light", "true");
  });

  it("runs Brightness onGet/onSet and updates characteristic with fake timers", async () => {

    vi.useFakeTimers();

    const nvr = createConfiguredNvr();
    const accessory = createMockAccessory();
    new ProtectLight(nvr, createMockLightConfig({ lightDeviceSettings: { ledLevel: 4, isIndicatorEnabled: true } }), accessory);

    const lightService = accessory.getService(nvr.platform.api.hap.Service.Lightbulb) as MockService;
    const brightnessHandlers = getServiceCharacteristicHandlers(lightService, nvr.platform.api.hap.Characteristic.Brightness);

    expect(brightnessHandlers.onGet?.()).toBe(60);

    await brightnessHandlers.onSet?.(40);
    vi.advanceTimersByTime(60);

    expect(lightService.updateCharacteristic).toHaveBeenCalledWith(nvr.platform.api.hap.Characteristic.Brightness, 40);
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith("AA:BB:CC:DD:EE:02", "light/brightness", "40");
  });

  it("logs when Brightness update fails", async () => {

    const nvr = createConfiguredNvr();
    vi.mocked(nvr.ufpApi.updateDevice).mockResolvedValueOnce(null as never);
    const accessory = createMockAccessory();
    new ProtectLight(nvr, createMockLightConfig(), accessory);

    const lightService = accessory.getService(nvr.platform.api.hap.Service.Lightbulb) as MockService;
    const brightnessHandlers = getServiceCharacteristicHandlers(lightService, nvr.platform.api.hap.Characteristic.Brightness);
    await brightnessHandlers.onSet?.(80);

    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to adjust the brightness to 80%"));
  });

  it("handles MQTT get/set callbacks for light and brightness", () => {

    const nvr = createConfiguredNvr();
    const accessory = createMockAccessory();
    new ProtectLight(nvr, createMockLightConfig({ isLightOn: false, lightDeviceSettings: { ledLevel: 6, isIndicatorEnabled: false } }), accessory);

    const mqttGetCalls = vi.mocked(nvr.mqtt!.subscribeGet).mock.calls;
    const mqttSetCalls = vi.mocked(nvr.mqtt!.subscribeSet).mock.calls;
    const lightService = accessory.getService(nvr.platform.api.hap.Service.Lightbulb) as MockService & { setCharacteristic: (name: string, value: unknown) => unknown };

    expect((mqttGetCalls.find(call => call[1] === "light")?.[3] as () => string)()).toBe("false");
    expect((mqttGetCalls.find(call => call[1] === "light/brightness")?.[3] as () => string)()).toBe("100");

    (mqttSetCalls.find(call => call[1] === "light")?.[3] as (value: string) => void)("true");
    expect(lightService.setCharacteristic).toHaveBeenCalledWith(nvr.platform.api.hap.Characteristic.On, true);

    (mqttSetCalls.find(call => call[1] === "light/brightness")?.[3] as (value: string) => void)("40");
    expect(lightService.setCharacteristic).toHaveBeenCalledWith(nvr.platform.api.hap.Characteristic.Brightness, 40);

    const callCount = vi.mocked(lightService.setCharacteristic).mock.calls.length;
    (mqttSetCalls.find(call => call[1] === "light/brightness")?.[3] as (value: string) => void)("bad-value");
    expect(vi.mocked(lightService.setCharacteristic).mock.calls).toHaveLength(callCount);
  });

  it("handles update events for motion, light state, brightness, and status led", () => {

    const nvr = createConfiguredNvr({
      featureTest: (name: string) => name === "Motion.OccupancySensor" || name === "Device.StatusLed.Switch"
    });
    const accessory = createMockAccessory();
    const light = new ProtectLight(nvr, createMockLightConfig(), accessory);

    nvr.events.emit("updateEvent.light-1", {
      payload: {
        isLightOn: true,
        lastMotion: "2024-01-01T00:00:00.000Z",
        lightDeviceSettings: { ledLevel: 5, isIndicatorEnabled: false }
      }
    });

    const lightService = accessory.getService(nvr.platform.api.hap.Service.Lightbulb) as MockService;
    const ledService = accessory.getServiceById(nvr.platform.api.hap.Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED) as MockService;

    expect(nvr.events.motionEventHandler).toHaveBeenCalledWith(light);
    expect(lightService.updateCharacteristic).toHaveBeenCalledWith(nvr.platform.api.hap.Characteristic.On, true);
    expect(lightService.updateCharacteristic).toHaveBeenCalledWith(nvr.platform.api.hap.Characteristic.Brightness, 80);
    expect(ledService.updateCharacteristic).toHaveBeenCalledWith(nvr.platform.api.hap.Characteristic.On, false);
  });

  it("handles nullish power and brightness payload updates", () => {

    const nvr = createConfiguredNvr({
      featureTest: (name: string) => name === "Motion.OccupancySensor" || name === "Device.StatusLed.Switch"
    });
    const accessory = createMockAccessory();
    new ProtectLight(nvr, createMockLightConfig(), accessory);

    nvr.events.emit("updateEvent.light-1", {
      payload: {
        isLightOn: undefined,
        lightDeviceSettings: { ledLevel: undefined }
      }
    });

    const lightService = accessory.getService(nvr.platform.api.hap.Service.Lightbulb) as MockService;

    expect(lightService.updateCharacteristic).toHaveBeenCalledWith(nvr.platform.api.hap.Characteristic.On, false);
    expect(lightService.updateCharacteristic).toHaveBeenCalledWith(nvr.platform.api.hap.Characteristic.Brightness, 0);
  });

  it("exposes statusLed getter and statusLedCommand override", () => {

    const nvr = createConfiguredNvr();
    const accessory = createMockAccessory();
    const light = new ProtectLight(nvr, createMockLightConfig({ lightDeviceSettings: { ledLevel: 3, isIndicatorEnabled: false } }), accessory);

    expect(light.statusLed).toBe(false);
    expect((light as unknown as { statusLedCommand: (value: boolean) => object }).statusLedCommand(true)).toEqual({
      lightDeviceSettings: { isIndicatorEnabled: true }
    });
  });

  it("handles acquireService failure path for lightbulb setup", () => {

    vi.mocked(pluginUtils.acquireService)
      .mockImplementationOnce(() => null)
      .mockImplementation((accessory, serviceType, name, subtype) => {
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

    const nvr = createConfiguredNvr();
    const accessory = createMockAccessory();
    new ProtectLight(nvr, createMockLightConfig(), accessory);

    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to add light."));
  });
});
