import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pluginUtils from "homebridge-plugin-utils";
import { ProtectSensor } from "../../src/devices/protect-sensor.js";
import { ProtectReservedNames } from "../../src/protect-types.js";
import {
  createMockAccessory,
  createMockNvr,
  createMockSensorConfig,
  createMockService,
  testInternals,
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

    const service = createMockService(serviceType.UUID) as MockService;
    service.displayName = name ?? "Mock Service";
    service.subtype = subtype;
    accessory.addService(service);
    return service;
  });
}

function createSensorConfig(overrides: object = {}) {

  return createMockSensorConfig(overrides);
}

describe("ProtectSensor", () => {

  beforeEach(() => {

    vi.clearAllMocks();
    installAccessoryAwareAcquireService();
    vi.mocked(pluginUtils.validService).mockReturnValue(true);
  });

  it("configures enabled sensor types and publishes mqtt values", () => {

    const nvr = createConfiguredNvr({
      featureTest: (name: string) => name === "Motion.OccupancySensor" || name === "Device.StatusLed.Switch"
    });
    (nvr.platform.api.hap.Service as unknown as Record<string, unknown>).Battery = { UUID: "battery" };
    (nvr.platform.api.hap.Characteristic as unknown as Record<string, unknown>).BatteryLevel = "BatteryLevel";

    const accessory = createMockAccessory();
    const sensor = new ProtectSensor(nvr, createSensorConfig(), accessory);

    expect(sensor.ufp.mac).toBe("AA:BB:CC:DD:EE:04");
    expect(accessory.getService(nvr.platform.api.hap.Service.MotionSensor)).toBeTruthy();
    expect(accessory.getService(nvr.platform.api.hap.Service.TemperatureSensor)).toBeTruthy();
    expect(accessory.getService(nvr.platform.api.hap.Service.HumiditySensor)).toBeTruthy();
    expect(accessory.getService(nvr.platform.api.hap.Service.LightSensor)).toBeTruthy();
    expect(accessory.getServiceById(nvr.platform.api.hap.Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR)).toBeTruthy();
    expect(accessory.getServiceById(nvr.platform.api.hap.Service.LeakSensor, ProtectReservedNames.LEAKSENSOR_INTERNAL)).toBeTruthy();
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith("AA:BB:CC:DD:EE:04", "temperature", "19.3");
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith("AA:BB:CC:DD:EE:04", "humidity", "41");
    expect(nvr.events.on).toHaveBeenCalledWith("updateEvent.sensor-1", expect.any(Function));
  });

  it("switches leak service type for moisture sensor feature", () => {

    const nvr = createConfiguredNvr({
      featureTest: (name: string) => name === "Sensor.MoistureSensor"
    });
    (nvr.platform.api.hap.Service as unknown as Record<string, unknown>).Battery = { UUID: "battery" };
    (nvr.platform.api.hap.Characteristic as unknown as Record<string, unknown>).BatteryLevel = "BatteryLevel";

    const accessory = createMockAccessory();
    new ProtectSensor(nvr, createSensorConfig(), accessory);

    expect(accessory.getServiceById(nvr.platform.api.hap.Service.ContactSensor, ProtectReservedNames.LEAKSENSOR_INTERNAL)).toBeTruthy();
    expect(accessory.getServiceById(nvr.platform.api.hap.Service.LeakSensor, ProtectReservedNames.LEAKSENSOR_INTERNAL)).toBeFalsy();
  });

  it("handles event updates and motion event callback", () => {

    const nvr = createConfiguredNvr();
    (nvr.platform.api.hap.Service as unknown as Record<string, unknown>).Battery = { UUID: "battery" };
    (nvr.platform.api.hap.Characteristic as unknown as Record<string, unknown>).BatteryLevel = "BatteryLevel";

    const accessory = createMockAccessory();
    const sensor = new ProtectSensor(nvr, createSensorConfig(), accessory);

    testInternals<{ motionDetectedAt: number | null }>(sensor.ufp).motionDetectedAt = null;
    nvr.events.emit("updateEvent.sensor-1", {
      payload: {
        motionDetectedAt: "2025-01-01T00:00:00Z",
        leakDetectedAt: "2025-01-01T00:00:00Z"
      }
    });

    expect(nvr.events.motionEventHandler).toHaveBeenCalledWith(sensor);
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith("AA:BB:CC:DD:EE:04", "leak", "false");
  });

  it("provides MQTT getters for all sensor topics", () => {

    const nvr = createConfiguredNvr();
    (nvr.platform.api.hap.Service as unknown as Record<string, unknown>).Battery = { UUID: "battery" };
    (nvr.platform.api.hap.Characteristic as unknown as Record<string, unknown>).BatteryLevel = "BatteryLevel";
    const accessory = createMockAccessory();
    new ProtectSensor(
      nvr,
      createSensorConfig({
        alarmTriggeredAt: "2025-01-01T00:00:00Z",
        externalLeakDetectedAt: "2025-01-01T00:00:00Z",
        leakDetectedAt: "2025-01-01T00:00:00Z"
      }),
      accessory
    );

    const calls = vi.mocked(nvr.mqtt!.subscribeGet).mock.calls;
    const getValue = (topic: string): string => (calls.find(call => call[1] === topic)?.[3] as () => string)();

    expect(getValue("alarm")).toBe("true");
    expect(getValue("ambientlight")).toBe("200");
    expect(getValue("contact")).toBe("true");
    expect(getValue("humidity")).toBe("41");
    expect(getValue("temperature")).toBe("19.3");
    expect(getValue("leak")).toBe("true");
    expect(getValue("leak-external")).toBe("true");
  });

  it("logs no enabled sensors and handles offline leak publishing", () => {

    vi.mocked(pluginUtils.validService).mockImplementation((_accessory, _service, validate) => typeof validate === "function" ? validate(false) : validate);

    const nvr = createConfiguredNvr({
      featureTest: () => false
    });
    (nvr.platform.api.hap.Service as unknown as Record<string, unknown>).Battery = { UUID: "battery" };
    (nvr.platform.api.hap.Characteristic as unknown as Record<string, unknown>).BatteryLevel = "BatteryLevel";
    const accessory = createMockAccessory();

    const sensor = new ProtectSensor(nvr, createSensorConfig({
      alarmSettings: { isEnabled: false },
      isConnected: false,
      leakSettings: { isExternalEnabled: false, isInternalEnabled: false },
      lightSettings: { isEnabled: false },
      motionSettings: { isEnabled: false },
      mountType: "none",
      humiditySettings: { isEnabled: false },
      temperatureSettings: { isEnabled: false }
    }), accessory);

    expect((sensor as any).leakDetected("externalLeakDetectedAt")).toBe(false);
    expect(nvr.mqtt?.publish).not.toHaveBeenCalledWith(sensor.ufp.mac, "leak-external", expect.any(String));
  });

  it("handles temperature service acquisition failure gracefully", () => {

    const nvr = createConfiguredNvr();
    (nvr.platform.api.hap.Service as unknown as Record<string, unknown>).Battery = { UUID: "battery" };
    (nvr.platform.api.hap.Characteristic as unknown as Record<string, unknown>).BatteryLevel = "BatteryLevel";
    const accessory = createMockAccessory();
    const sensor = new ProtectSensor(nvr, createSensorConfig(), accessory);

    vi.spyOn(sensor as never, "acquireService" as never).mockReturnValueOnce(null);
    expect((sensor as any).configureTemperatureSensor()).toBe(false);
    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to add temperature sensor."));
  });

  it("handles battery service acquisition failure gracefully", () => {

    const nvr = createConfiguredNvr();
    (nvr.platform.api.hap.Service as unknown as Record<string, unknown>).Battery = { UUID: "battery" };
    (nvr.platform.api.hap.Characteristic as unknown as Record<string, unknown>).BatteryLevel = "BatteryLevel";
    const accessory = createMockAccessory();
    const sensor = new ProtectSensor(nvr, createSensorConfig(), accessory);

    vi.spyOn(sensor as never, "acquireService" as never).mockReturnValueOnce(null);
    expect((sensor as any).configureBatteryService()).toBe(false);
    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to add the battery service."));
  });

  it("covers service acquisition failures and value clamping branches", () => {

    const nvr = createConfiguredNvr({
      featureTest: (name: string) => name === "Sensor.MoistureSensor"
    });
    (nvr.platform.api.hap.Service as unknown as Record<string, unknown>).Battery = { UUID: "battery" };
    (nvr.platform.api.hap.Characteristic as unknown as Record<string, unknown>).BatteryLevel = "BatteryLevel";
    const accessory = createMockAccessory();
    const sensor = new ProtectSensor(nvr, createSensorConfig({
      stats: {
        humidity: { value: -5 },
        light: { value: 0 },
        temperature: { value: 18.4 }
      }
    }), accessory);

    vi.spyOn(sensor as never, "acquireService" as never)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null);

    expect((sensor as any).configureAlarmSoundSensor()).toBe(false);
    expect((sensor as any).configureAmbientLightSensor()).toBe(false);
    expect((sensor as any).configureContactSensor()).toBe(false);
    expect((sensor as any).configureHumiditySensor()).toBe(false);

    const lightService = accessory.getService(nvr.platform.api.hap.Service.LightSensor) as MockService;
    const humidityService = accessory.getService(nvr.platform.api.hap.Service.HumiditySensor) as MockService;
    expect(lightService.updateCharacteristic).toHaveBeenCalledWith(nvr.platform.api.hap.Characteristic.CurrentAmbientLightLevel, 0.0001);
    expect(humidityService.updateCharacteristic).toHaveBeenCalledWith(nvr.platform.api.hap.Characteristic.CurrentRelativeHumidity, 0);
  });

  it("covers fallback sensor values and battery defaults", () => {

    const nvr = createConfiguredNvr({
      featureTest: (name: string) => name === "Device.StatusLed.Switch"
    });
    (nvr.platform.api.hap.Service as unknown as Record<string, unknown>).Battery = { UUID: "battery" };
    (nvr.platform.api.hap.Characteristic as unknown as Record<string, unknown>).BatteryLevel = "BatteryLevel";

    const accessory = createMockAccessory();
    const sensor = new ProtectSensor(nvr, createSensorConfig({
      batteryStatus: { isLow: true, percentage: undefined },
      isOpened: undefined,
      stats: undefined
    }), accessory);

    expect((sensor as any).ambientLight).toBe(-1);
    expect((sensor as any).humidity).toBe(-1);
    expect((sensor as any).temperature).toBe(-1);
    expect((sensor as any).contact).toBe(false);
  });

  it("covers leak logging branch transitions for moisture and leak modes", () => {

    const moistureNvr = createConfiguredNvr({ featureTest: (name: string) => name === "Sensor.MoistureSensor" });
    (moistureNvr.platform.api.hap.Service as unknown as Record<string, unknown>).Battery = { UUID: "battery" };
    (moistureNvr.platform.api.hap.Characteristic as unknown as Record<string, unknown>).BatteryLevel = "BatteryLevel";
    const moistureSensor = new ProtectSensor(moistureNvr, createSensorConfig({ leakDetectedAt: "2025-01-01T00:00:00Z" }), createMockAccessory());

    (moistureSensor as any).leakDetected();
    expect(moistureNvr.log.info).toHaveBeenCalledWith(expect.stringContaining("Moisture detected."));

    const leakNvr = createConfiguredNvr({ featureTest: () => false });
    (leakNvr.platform.api.hap.Service as unknown as Record<string, unknown>).Battery = { UUID: "battery" };
    (leakNvr.platform.api.hap.Characteristic as unknown as Record<string, unknown>).BatteryLevel = "BatteryLevel";
    const leakSensor = new ProtectSensor(leakNvr, createSensorConfig({ leakDetectedAt: "2025-01-01T00:00:00Z" }), createMockAccessory());

    (leakSensor as any).leakDetected();
    expect(leakNvr.log.info).toHaveBeenCalledWith(expect.stringContaining("Leak detected."));
  });
});
